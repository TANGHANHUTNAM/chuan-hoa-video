'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');
const ssh = require('./ssh.service');
const jobs = require('./job.service');
const storage = require('./storage.service');
const importService = require('./import.service');
const ffmpegService = require('./ffmpeg.service');
const { encrypt } = require('./crypto.service');
const { shellEscape } = require('../utils/shell-escape');
const { cleanName, videoExtension } = require('../utils/validators');
const { formatBytes, formatDuration } = require('../utils/format-bytes');
const { AppError } = require('../middleware/error-handler');
const logger = require('../utils/logger');

/** Videos live on the user's VPS; this table only holds metadata (spec section 8). */

const STATUS = {
  UPLOADING: 'uploading',
  DOWNLOADING: 'downloading',
  ANALYZING: 'analyzing',
  READY: 'ready',
  NEEDS_OPTIMIZE: 'needs_optimize',
  OPTIMIZING: 'optimizing',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

// Filenames on disk are always our own UUID, never the user's, which removes
// both path-injection and name-collision problems (spec section 8).
const remotePathFor = (uuid) => `${config.remote.videos}/${uuid}.mp4`;
const tempPathFor = (uuid) => `${config.remote.temp}/${uuid}.mp4.part`;
const scriptPathFor = (uuid) => `${config.remote.temp}/${uuid}.sh`;
const progressPathFor = (uuid) => `${config.remote.logs}/${uuid}.progress`;

function findById(id) {
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
}

function findByIdOrThrow(id) {
  const video = findById(id);
  if (!video) throw new AppError('Không tìm thấy video.', 404);
  return video;
}

function listForServer(serverId) {
  return db
    .prepare('SELECT * FROM videos WHERE server_id = ? ORDER BY id DESC')
    .all(serverId);
}

function listAll() {
  return db.prepare('SELECT * FROM videos ORDER BY id DESC').all();
}

/**
 * Which projects and live destinations depend on this video (spec section 19).
 *
 * Must consider project_videos, not just the legacy projects.video_id column:
 * video_id only tracks position 0 of a playlist, so checking it alone would
 * report every later entry as unused — and the cleanup tool would then happily
 * delete a file out from under a running stream.
 */
const USED_BY_PROJECTS = `
  SELECT id FROM projects WHERE video_id = ?
  UNION
  SELECT project_id FROM project_videos WHERE video_id = ?
`;

function usageOf(videoId) {
  const projects = db
    .prepare(
      `SELECT id, name FROM projects
        WHERE id IN (${USED_BY_PROJECTS})
        ORDER BY id`
    )
    .all(videoId, videoId);

  const countDestinations = (extraWhere = '') =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM live_destinations
          WHERE project_id IN (${USED_BY_PROJECTS}) ${extraWhere}`
      )
      .get(videoId, videoId).n;

  return {
    projects,
    destinationCount: countDestinations(),
    activeCount: countDestinations(`AND status IN ('live','starting','refreshing')`),
  };
}

function create({ serverId, originalName, sizeBytes = 0, sourceType = 'upload', sourceUrl = null, status }) {
  const uuid = crypto.randomUUID();
  const info = db
    .prepare(
      `INSERT INTO videos (server_id, uuid, original_name, remote_path, size_bytes,
                           status, source_type, source_url_encrypted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      serverId,
      uuid,
      cleanName(originalName, 200) || `${uuid}.mp4`,
      remotePathFor(uuid),
      sizeBytes,
      status || STATUS.UPLOADING,
      sourceType,
      sourceUrl ? encrypt(sourceUrl) : null
    );
  return findById(info.lastInsertRowid);
}

function patch(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return findById(id);
  db.prepare(
    `UPDATE videos SET ${keys.map((k) => `${k} = ?`).join(', ')},
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...keys.map((k) => fields[k]), id);
  return findById(id);
}

function setError(id, message) {
  return patch(id, { status: STATUS.ERROR, error_message: String(message).slice(0, 500) });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function parseFrameRate(value) {
  if (!value) return null;
  const [num, den] = String(value).split('/').map(Number);
  if (!num) return null;
  const fps = den ? num / den : num;
  return Number.isFinite(fps) ? Math.round(fps * 100) / 100 : null;
}

/**
 * Largest gap between keyframes, from a list of keyframe timestamps.
 *
 * Facebook requires a keyframe at least every 2 seconds. Most videos exported
 * from an editor use 5-10 seconds, so this is the check that decides whether
 * `-c copy` is usable or the video must be re-encoded first (plan R4).
 */
function maxKeyframeGap(timestamps, windowSeconds, durationSeconds = null) {
  const times = timestamps
    .map(Number)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (times.length === 0) return null;

  /**
   * Where the sampled stretch actually ends.
   *
   * Clamping to the video's duration is not a detail — without it, every video
   * SHORTER than the window was condemned. A 10-second clip with perfect 2-second
   * keyframes has its last one at 8s, and `30 - 8` reported an 22-second gap, so it
   * failed the check, and re-encoding could not help because the result was still
   * 10 seconds long. That was a second infinite normalise loop, independent of the
   * frame-size one, hitting every short video.
   */
  const end =
    durationSeconds && durationSeconds > 0
      ? Math.min(windowSeconds, durationSeconds)
      : windowSeconds;

  // A single keyframe in the whole sampled stretch means the interval is at least
  // as long as that stretch.
  if (times.length === 1) return Math.round(Math.max(0, end - times[0]) * 100) / 100;

  let max = 0;
  for (let i = 1; i < times.length; i += 1) {
    max = Math.max(max, times[i] - times[i - 1]);
  }
  // Also account for the tail: the gap from the last keyframe to the end of the
  // sampled stretch is real, even though we did not see the next keyframe.
  max = Math.max(max, end - times[times.length - 1]);
  return Math.round(Math.max(0, max) * 100) / 100;
}

/**
 * Decides whether a video can be streamed with `-c copy` straight to Facebook.
 * Pure so the rule can be tested without a VPS.
 */
/**
 * Is this frame size within Facebook's budget, whichever way up it is?
 *
 * Vertical video is a normal Facebook format, so the limit belongs to the long and
 * short edges rather than to width and height (see config.facebook.maxLongEdge).
 */
function isFrameSizeAllowed(width, height, fb = config.facebook) {
  if (!width || !height) return true; // unknown size is not evidence of a problem
  return (
    Math.max(width, height) <= fb.maxLongEdge && Math.min(width, height) <= fb.maxShortEdge
  );
}

/**
 * The frame size to scale an oversized video down to.
 *
 * Returns null when the video already fits — never upscales, because inventing
 * pixels costs bitrate and adds nothing. Both dimensions come back even, which
 * yuv420p requires: an odd height makes libx264 fail outright.
 *
 * Orientation is preserved because a single ratio is applied to both edges.
 */
function targetFrameSize(width, height, fb = config.facebook) {
  if (!width || !height) return null;

  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const ratio = Math.min(1, fb.maxLongEdge / long, fb.maxShortEdge / short);
  if (ratio >= 1) return null;

  const even = (n) => {
    const rounded = Math.round(n);
    return rounded - (rounded % 2);
  };

  return { width: Math.max(2, even(width * ratio)), height: Math.max(2, even(height * ratio)) };
}

/**
 * Output frames the user can ask for, named by resolution because that is how OBS
 * states it and the user already reads it there.
 */
const FRAME_TARGETS = {
  '1920x1080': { width: 1920, height: 1080, ratio: '16:9', label: 'ngang' },
  '1080x1920': { width: 1080, height: 1920, ratio: '9:16', label: 'dọc' },
};

const FRAME_FITS = new Set([
  'keep',
  '1920x1080_pad',
  '1920x1080_blur',
  '1080x1920_pad',
  '1080x1920_blur',
]);

/** Splits a frame_fit value into its target frame and its bar style. */
function parseFrameFit(fit) {
  if (!FRAME_FITS.has(fit) || fit === 'keep') return null;
  const at = fit.lastIndexOf('_');
  const target = FRAME_TARGETS[fit.slice(0, at)];
  const style = fit.slice(at + 1);
  if (!target || !['pad', 'blur'].includes(style)) return null;
  return { target, style };
}

/**
 * Works out the geometry for delivering a picture inside a chosen output frame.
 *
 * Handles both directions — a vertical picture inside 16:9 and a horizontal picture
 * inside 9:16 — because Facebook has stretched this user's stream both ways
 * depending on how the broadcast was created.
 *
 * Returns null when there is nothing to do: 'keep', an unknown value, or a picture
 * that fills the requested frame with no bars needed. That last case is the point of
 * the whole feature — bars are the only reason to reframe. A 540x960 clip asked to
 * become 1080x1920 is ALREADY 9:16, so re-encoding it would add no detail, cost
 * bitrate and lose a generation; it is left alone and streams as it is.
 *
 * It does scale up when bars ARE needed, so the picture fills the frame in the
 * direction it can rather than sitting small in the middle. That differs from the
 * compliance downscale, which never upscales, because there the goal is to shrink an
 * oversized file rather than to deliver a frame the user named.
 */
function frameFitPlan(width, height, fit) {
  const parsed = parseFrameFit(fit);
  if (!parsed || !width || !height) return null;

  const frameWidth = parsed.target.width;
  const frameHeight = parsed.target.height;
  if (width === frameWidth && height === frameHeight) return null; // already exact

  // Dimensions must be even AND non-zero (libx264 rejects odd sizes under yuv420p).
  const evenSize = (n) => {
    const r = Math.round(n);
    return Math.max(2, r - (r % 2));
  };
  // Offsets must be even but ZERO IS CORRECT — a picture exactly as tall as the frame
  // sits at y=0. Reusing the size helper here forced a minimum of 2, which pushed the
  // image down two pixels and cut two rows off the bottom.
  const evenOffset = (n) => {
    const r = Math.max(0, Math.round(n));
    return r - (r % 2);
  };

  // Fit inside the frame, keeping the picture's own aspect ratio.
  const scale = Math.min(frameWidth / width, frameHeight / height);
  const contentWidth = Math.min(frameWidth, evenSize(width * scale));
  const contentHeight = Math.min(frameHeight, evenSize(height * scale));

  // Same shape and same size: no bars to add, so no re-encode to justify.
  if (contentWidth === frameWidth && contentHeight === frameHeight) return null;

  return {
    mode: parsed.style,
    target: fit,
    frame: { width: frameWidth, height: frameHeight },
    content: { width: contentWidth, height: contentHeight },
    offset: {
      x: evenOffset((frameWidth - contentWidth) / 2),
      y: evenOffset((frameHeight - contentHeight) / 2),
    },
  };
}

/**
 * The FFmpeg filter graph for a fit plan, ending in the label [vout].
 *
 * `setsar=1` is not cosmetic. Rounding the content width to an even number (607.5 ->
 * 608 for a 1080x1920 source) makes `scale` preserve the DISPLAY aspect by setting a
 * non-square sample aspect — measured output was SAR 1215:1216, DAR 135:76 instead
 * of 16:9. A frame built by hand out of square pixels must say so, otherwise a
 * player is invited to correct an aspect that needs no correcting, which is the exact
 * class of surprise this whole feature exists to remove. The sub-pixel rounding is
 * absorbed as geometry (a half-pixel) rather than signalled as pixel shape.
 *
 * Applied only here, never on the plain downscale path, where a genuinely anamorphic
 * source must keep its sample aspect.
 */
function frameFitFilter(plan) {
  const { frame, content, offset } = plan;
  const scaled = `scale=${content.width}:${content.height},setsar=1`;

  if (plan.mode === 'pad') {
    return (
      `[0:v]${scaled},` +
      `pad=${frame.width}:${frame.height}:${offset.x}:${offset.y}:black,setsar=1[vout]`
    );
  }

  // Blurred bars: a copy of the picture zoomed to cover the frame, blurred hard
  // enough that no detail reads, with the sharp picture laid on top. sigma=28 was
  // chosen by eye on the user's own footage.
  return (
    `[0:v]split=2[bg][fg];` +
    `[bg]scale=${frame.width}:${frame.height}:force_original_aspect_ratio=increase,` +
    `crop=${frame.width}:${frame.height},setsar=1,gblur=sigma=28[bgblur];` +
    `[fg]${scaled}[fgs];` +
    `[bgblur][fgs]overlay=${offset.x}:${offset.y},setsar=1[vout]`
  );
}

/**
 * Judges a probed video against what Facebook needs, and — as importantly — says
 * WHICH part is wrong.
 *
 * The split matters for how long the user waits. Re-encoding video on a 2-core VPS
 * runs at 1.5–3× realtime, so a 2-hour file costs 40–80 minutes. Re-encoding only
 * the audio track costs a minute or two and leaves the picture untouched. Before
 * this split, a video whose only fault was a missing AAC track paid the full
 * video-encode price for nothing.
 */
function evaluateCompliance(meta) {
  const notes = [];
  const fb = config.facebook;
  let needsVideoReencode = false;
  let needsAudioReencode = false;

  if (meta.codecVideo !== 'h264') {
    notes.push(`Video dùng codec ${meta.codecVideo || 'không rõ'}, Facebook cần H.264.`);
    needsVideoReencode = true;
  }
  if (meta.pixelFormat && meta.pixelFormat !== 'yuv420p') {
    notes.push(`Định dạng màu ${meta.pixelFormat} có thể không phát được, cần yuv420p.`);
    needsVideoReencode = true;
  }
  if (!isFrameSizeAllowed(meta.width, meta.height)) {
    const target = targetFrameSize(meta.width, meta.height);
    notes.push(
      `Khung hình ${meta.width}×${meta.height} vượt mức cho phép ` +
        `(cạnh dài tối đa ${fb.maxLongEdge}, cạnh ngắn tối đa ${fb.maxShortEdge} — ` +
        `dọc hay ngang đều được)` +
        (target ? `. Chuẩn hoá sẽ thu về ${target.width}×${target.height}.` : '.')
    );
    needsVideoReencode = true;
  }
  if (meta.fps && meta.fps > fb.maxFps + 0.5) {
    notes.push(`${meta.fps} FPS cao hơn mức ${fb.maxFps} FPS của bản cài đặt này.`);
    needsVideoReencode = true;
  }
  if (meta.maxKeyframeInterval == null) {
    notes.push('Không đo được khoảng cách khung hình chính.');
    // Cannot prove it is safe, and a too-long GOP breaks a broadcast mid-way, so
    // treat "unknown" as needing the fix rather than as passing.
    needsVideoReencode = true;
  } else if (meta.maxKeyframeInterval > fb.maxKeyframeIntervalSeconds + 0.05) {
    notes.push(
      `Khung hình chính cách nhau tới ${meta.maxKeyframeInterval}s, Facebook yêu cầu tối đa ` +
        `${fb.maxKeyframeIntervalSeconds}s. Đây là lý do phổ biến nhất khiến live bị chập chờn.`
    );
    needsVideoReencode = true;
  }
  if (!meta.hasAudio) {
    notes.push('Video không có tiếng. Facebook cần một luồng âm thanh.');
    needsAudioReencode = true;
  } else if (meta.codecAudio && meta.codecAudio !== 'aac') {
    notes.push(`Âm thanh dùng ${meta.codecAudio}, Facebook cần AAC.`);
    needsAudioReencode = true;
  }

  return {
    compliant: notes.length === 0,
    notes,
    needsVideoReencode,
    needsAudioReencode,
  };
}

const PROBE_ERRORS = {
  UNREADABLE:
    'Không đọc được video này. File có thể bị lỗi, tải về chưa xong, ' +
    'hoặc link tải trả về một trang web thay vì video.',
  NO_VIDEO_STREAM: 'File không có luồng video.',
};

/**
 * Reads a file on the VPS with ffprobe and returns what it found.
 *
 * Takes a PATH rather than a video row, and writes nothing to the database. That
 * separation is what lets the normalise job inspect its output file before deciding
 * whether to adopt it — previously the row was re-pointed at the new file first and
 * a failed check left the row aimed at a bad encode, with the original orphaned on
 * disk.
 *
 * @throws {AppError} with `code` UNREADABLE or NO_VIDEO_STREAM.
 */
async function probeRemoteVideo(server, remotePath, { fallbackSizeBytes = 0 } = {}) {
  const path = shellEscape(remotePath);
  const windowSeconds = 30;

  const result = await ssh.exec(
    server,
    // Metadata, then keyframe timestamps from only the first 30 seconds: reading
    // keyframes for a whole 2 GB file would take minutes.
    `ffprobe -v quiet -print_format json -show_format -show_streams ${path}; ` +
      `echo '---KEYFRAMES---'; ` +
      `ffprobe -v error -select_streams v:0 -skip_frame nokey ` +
      `-show_entries frame=pts_time -read_intervals '%+${windowSeconds}' ` +
      `-of csv=p=0 ${path} 2>/dev/null || true`,
    { timeout: 120_000 }
  );

  const [jsonPart = '', keyframePart = ''] = String(result.stdout).split('---KEYFRAMES---');

  let probe;
  try {
    probe = JSON.parse(jsonPart.trim());
  } catch {
    // ffprobe could not read it at all: usually the "file" is an HTML error page
    // saved by a failed link import (plan Phần 3, safety layer 3).
    const err = new AppError(
      'File trên VPS không phải video hợp lệ. Nếu bạn nhập từ link, ' +
        'hãy kiểm tra lại link có tải trực tiếp ra file video hay không.',
      400
    );
    err.code = 'UNREADABLE';
    throw err;
  }

  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    const err = new AppError('File này không có luồng video.', 400);
    err.code = 'NO_VIDEO_STREAM';
    throw err;
  }

  const keyframeTimes = keyframePart
    .split('\n')
    .map((line) => line.trim().replace(/,+$/, ''))
    .filter(Boolean);

  const durationSeconds = Number(probe.format?.duration) || null;

  return {
    sizeBytes: Number(probe.format?.size) || fallbackSizeBytes || 0,
    durationSeconds,
    bitrate: Number(probe.format?.bit_rate) || null,
    codecVideo: videoStream.codec_name || null,
    codecAudio: audioStream ? audioStream.codec_name : null,
    width: Number(videoStream.width) || null,
    height: Number(videoStream.height) || null,
    fps: parseFrameRate(videoStream.r_frame_rate || videoStream.avg_frame_rate),
    pixelFormat: videoStream.pix_fmt || null,
    hasAudio: Boolean(audioStream),
    // Duration matters here: without it a video shorter than the sample window is
    // judged against time that does not exist.
    maxKeyframeInterval: maxKeyframeGap(keyframeTimes, windowSeconds, durationSeconds),
  };
}

/** Runs ffprobe on the VPS and stores what it found (spec section 20). */
async function analyze(server, video) {
  patch(video.id, { status: STATUS.ANALYZING });

  let meta;
  try {
    meta = await probeRemoteVideo(server, video.remote_path, {
      fallbackSizeBytes: video.size_bytes,
    });
  } catch (err) {
    if (err.code === 'UNREADABLE') setError(video.id, PROBE_ERRORS.UNREADABLE);
    else if (err.code === 'NO_VIDEO_STREAM') setError(video.id, PROBE_ERRORS.NO_VIDEO_STREAM);
    throw err;
  }

  const compliance = evaluateCompliance(meta);

  patch(video.id, {
    size_bytes: meta.sizeBytes,
    duration_seconds: meta.durationSeconds,
    bitrate: meta.bitrate,
    codec_video: meta.codecVideo,
    codec_audio: meta.codecAudio,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    has_audio: meta.hasAudio ? 1 : 0,
    max_keyframe_interval: meta.maxKeyframeInterval,
    fb_compliant: compliance.compliant ? 1 : 0,
    compliance_notes: JSON.stringify(compliance.notes),
    status: compliance.compliant ? STATUS.READY : STATUS.NEEDS_OPTIMIZE,
    error_message: null,
  });

  logger.info(
    `Analyzed video ${video.id}: ${meta.codecVideo} ${meta.width}x${meta.height} ` +
      `${meta.fps}fps gop=${meta.maxKeyframeInterval}s audio=${meta.hasAudio} ` +
      `-> ${compliance.compliant ? 'ready' : 'needs_optimize'}`
  );

  // Best effort only: a video is perfectly usable without a preview image, so a
  // failure here must never fail the analysis.
  await captureThumbnail(server, findById(video.id)).catch((err) =>
    logger.warn(`Thumbnail for video ${video.id} failed: ${err.message}`)
  );

  return { meta, compliance, video: findById(video.id) };
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

const thumbnailPath = (uuid) => path.join(config.thumbsDir, `${uuid}.jpg`);

function hasThumbnail(video) {
  try {
    return fs.existsSync(thumbnailPath(video.uuid));
  } catch {
    return false;
  }
}

/**
 * Grabs one frame on the VPS and copies it here.
 *
 * Copied to local disk on purpose: serving it straight from the VPS would open an
 * SFTP channel per image, so a library page with twenty videos would make twenty
 * SSH connections every time it loaded.
 */
async function captureThumbnail(server, video) {
  const remoteJpg = `${config.remote.logs}/${video.uuid}.jpg`;

  // -ss before -i seeks cheaply. 3 seconds in avoids the black frame many videos
  // start with; -update tells FFmpeg a single-image output is intended.
  const result = await ssh.exec(
    server,
    `ffmpeg -nostdin -hide_banner -loglevel error -y -ss 3 -i ${shellEscape(video.remote_path)} ` +
      `-frames:v 1 -update 1 -vf scale=320:-2 ${shellEscape(remoteJpg)}`,
    { timeout: 60_000 }
  );

  if (result.code !== 0) {
    // Very short videos have no frame at 3s; retry from the very beginning.
    const retry = await ssh.exec(
      server,
      `ffmpeg -nostdin -hide_banner -loglevel error -y -i ${shellEscape(video.remote_path)} ` +
        `-frames:v 1 -update 1 -vf scale=320:-2 ${shellEscape(remoteJpg)}`,
      { timeout: 60_000 }
    );
    if (retry.code !== 0) throw new AppError('Không tạo được ảnh xem trước.', 400);
  }

  await ssh.downloadRemoteFile(server, remoteJpg, thumbnailPath(video.uuid));
  await ssh.exec(server, `rm -f ${shellEscape(remoteJpg)}`, { timeout: 20_000 }).catch(() => {});

  return thumbnailPath(video.uuid);
}

/** Removes the cached image when its video goes away. */
function removeThumbnail(uuid) {
  try {
    fs.rmSync(thumbnailPath(uuid), { force: true });
  } catch {
    /* nothing depends on this succeeding */
  }
}

// ---------------------------------------------------------------------------
// Import from link
// ---------------------------------------------------------------------------

function buildImportWorker(serverId, videoId) {
  return async function worker(ctx) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    const video = findByIdOrThrow(videoId);
    if (!server) throw new AppError('Không tìm thấy VPS.', 404);

    const unit = importService.importUnitName(videoId);
    const partPath = tempPathFor(video.uuid);
    const expectedBytes = video.size_bytes || null;

    ctx.progress({ percent: 2, step: 'Đang chuẩn bị tải về trên VPS…', unit });

    // Resume-safe: a leftover unit from a previous attempt would block a new one.
    await ssh.execPrivileged(server, `systemctl reset-failed ${shellEscape(unit)} 2>/dev/null || true`);

    const running = await ssh.exec(server, `systemctl is-active ${shellEscape(unit)} 2>/dev/null || true`);
    const alreadyRunning = running.stdout.trim() === 'active';

    if (!alreadyRunning) {
      const { decrypt } = require('./crypto.service');
      const url = decrypt(video.source_url_encrypted);
      const scriptPath = scriptPathFor(video.uuid);

      await ssh.writeRemoteFile(
        server,
        scriptPath,
        importService.buildDownloadScript({
          url,
          partPath,
          finalPath: video.remote_path,
        }),
        { mode: '700', privileged: false }
      );

      // systemd-run keeps the download alive independently of this process and of
      // the user's browser (spec section 39: Render restart must not interrupt).
      const start = await ssh.execPrivileged(
        server,
        `systemd-run --unit=${shellEscape(unit)} --collect ` +
          `--property=Type=simple --property=StandardOutput=journal ` +
          `/bin/bash ${shellEscape(scriptPath)}`,
        { timeout: 30_000 }
      );

      if (start.code !== 0) {
        throw new AppError(
          `Không khởi động được tiến trình tải trên VPS: ` +
            `${(start.stderr || '').trim().slice(0, 200) || `exit ${start.code}`}`,
          400
        );
      }
    }

    ctx.progress({ percent: 5, step: 'Đang tải video về VPS…' });

    // Poll the growing .part file. This is also our guard against a server that
    // never sent a content-length: if the download outgrows the safe capacity we
    // stop it rather than filling the disk.
    let lastSize = 0;
    for (;;) {
      ctx.throwIfCancelled();
      await ctx.sleep(3000);

      const [sizeResult, activeResult] = await Promise.all([
        ssh.exec(server, `stat -c %s ${shellEscape(partPath)} 2>/dev/null || echo -1`),
        ssh.exec(server, `systemctl is-active ${shellEscape(unit)} 2>/dev/null || true`),
      ]);

      const size = Number(sizeResult.stdout.trim());
      const active = activeResult.stdout.trim();

      if (Number.isFinite(size) && size > 0) {
        lastSize = size;
        if (expectedBytes) {
          ctx.progress({
            percent: 5 + Math.min(80, Math.round((size / expectedBytes) * 80)),
            step: `Đang tải: ${formatBytes(size)} / ${formatBytes(expectedBytes)}`,
          });
        } else {
          ctx.progress({ step: `Đang tải: ${formatBytes(size)}` });

          const safety = storage.computeSafety(server.total_bytes, server.available_bytes);
          if (safety.usableFreeBytes > 0 && size > safety.usableFreeBytes) {
            await ssh.execPrivileged(server, `systemctl stop ${shellEscape(unit)} || true`);
            await ssh.exec(server, `rm -f ${shellEscape(partPath)}`);
            throw new AppError(
              `File tải về đã vượt dung lượng an toàn của VPS ` +
                `(${formatBytes(safety.usableFreeBytes)}). Đã dừng để không làm đầy ổ đĩa.`,
              400
            );
          }
        }
      }

      if (active !== 'active' && active !== 'activating') break;
    }

    // The unit finished. Did it produce the file?
    const exists = await ssh.exec(
      server,
      `stat -c %s ${shellEscape(video.remote_path)} 2>/dev/null || echo -1`
    );
    const finalSize = Number(exists.stdout.trim());

    if (!Number.isFinite(finalSize) || finalSize <= 0) {
      const logTail = await ssh.execPrivileged(
        server,
        `journalctl -u ${shellEscape(unit)} -n 20 --no-pager 2>/dev/null || true`
      );
      await ssh.exec(server, `rm -f ${shellEscape(partPath)} ${shellEscape(scriptPathFor(video.uuid))}`);
      setError(videoId, 'Tải video từ link không thành công.');
      throw new AppError(
        `Tải video từ link không thành công. VPS đã tải được ${formatBytes(lastSize)} rồi dừng. ` +
          `Hãy kiểm tra lại link, hoặc thử tải lên từ máy tính.`,
        400,
        { log: (logTail.stdout || '').slice(-800) }
      );
    }

    await ssh.exec(server, `rm -f ${shellEscape(scriptPathFor(video.uuid))}`);
    patch(videoId, { size_bytes: finalSize });

    ctx.progress({ percent: 88, step: 'Đang phân tích video…' });
    const { compliance } = await analyze(server, findByIdOrThrow(videoId));

    await storage.refresh(server).catch(() => {});

    db.prepare(
      `INSERT INTO activity_logs (type, message, entity_type, entity_id)
       VALUES ('video_uploaded', ?, 'video', ?)`
    ).run(`Đã nhập video ${video.original_name} từ link (${formatBytes(finalSize)})`, videoId);

    ctx.progress({
      percent: 100,
      step: compliance.compliant
        ? 'Video đã sẵn sàng phát live.'
        : 'Đã tải xong. Video cần chuẩn hoá trước khi phát.',
    });
  };
}

/** Starts a link import. Enforces one ingest at a time per VPS (spec section 18). */
async function startImport(server, { url, name }) {
  const busy = jobs.findActive({ type: 'import', serverId: server.id });
  if (busy) {
    throw new AppError('VPS này đang tải một video khác. Vui lòng đợi tải xong.', 409);
  }

  // Shares the upload guard so an abandoned upload job cannot block imports
  // either. Required lazily: upload.service already requires this module.
  // eslint-disable-next-line global-require
  await require('./upload.service').assertServerFree(server);

  const probe = await importService.probeUrl(server, url);
  const check = await storage.preflight(server, probe.sizeBytes);
  if (!check.allowed) throw new AppError(check.message, 400, { preflight: check });

  const video = create({
    serverId: server.id,
    originalName: name || probe.filename || 'video-tu-link.mp4',
    sizeBytes: probe.sizeBytes || 0,
    sourceType: 'url',
    sourceUrl: probe.url,
    status: STATUS.DOWNLOADING,
  });

  const job = jobs.start(
    {
      serverId: server.id,
      type: 'import',
      entityType: 'video',
      entityId: video.id,
      step: 'Đang chuẩn bị…',
    },
    buildImportWorker(server.id, video.id)
  );

  return { video, job, probe };
}

// A download running in a systemd unit survives our restart, so pick the polling
// back up instead of failing the job (plan Phần 7).
jobs.registerResumer('import', (job, ctx) =>
  buildImportWorker(job.server_id, job.entity_id)(ctx)
);

// ---------------------------------------------------------------------------
// Normalise for Facebook
// ---------------------------------------------------------------------------

const normalizeUnitName = (videoId) => `lm-normalize-${videoId}`;

/**
 * Builds the command that makes a video Facebook-safe.
 *
 * `-g 60 -keyint_min 60` at 30 fps is the whole point of the video path: it forces
 * a keyframe every 2 seconds, which is Facebook's requirement and the thing most
 * source videos fail (plan R4). `-sc_threshold 0` keeps the interval predictable.
 *
 * @param {boolean} [opts.reencodeVideo]
 *   false copies the video stream untouched and only rewrites audio. Worth the
 *   extra branch: a 2-hour file whose only fault is an MP3 soundtrack takes about a
 *   minute this way instead of the 40–80 minutes a full 1080p encode costs on a
 *   2-core VPS — and the picture keeps its original quality instead of losing a
 *   generation for no reason.
 * @param {{width:number,height:number}|null} [opts.scaleTo]
 *   Target frame size for an oversized video. Only possible while re-encoding.
 */
function buildNormalizeArgs({
  inputPath,
  outputPath,
  progressPath,
  hasAudio,
  reencodeVideo = true,
  scaleTo = null,
  fitPlan = null,
  ffmpegPath = config.remote.ffmpegPath,
  videoEncoder = 'libx264',
}) {
  const args = [
    ffmpegPath,
    '-y',
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-progress', progressPath,
    '-i', inputPath,
  ];

  // Fitting into a 16:9 frame is only possible while re-encoding, and the blurred
  // variant needs split/overlay — which -vf cannot express. One filter_complex path
  // covers both fit modes and plain scaling, so there is a single place where the
  // video filter graph is decided.
  const filter = reencodeVideo && fitPlan
    ? frameFitFilter(fitPlan)
    : reencodeVideo && scaleTo
      ? `[0:v]scale=${scaleTo.width}:${scaleTo.height}[vout]`
      : null;

  // Facebook expects an audio track; a silent one is better than none, and the
  // user should not have to know this.
  if (!hasAudio) {
    args.push(
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=stereo:sample_rate=${config.facebook.audioSampleRate}`
    );
    if (filter) args.push('-filter_complex', filter, '-map', '[vout]', '-map', '1:a:0');
    else args.push('-map', '0:v:0', '-map', '1:a:0');
    args.push('-shortest');
  } else if (filter) {
    args.push('-filter_complex', filter, '-map', '[vout]', '-map', '0:a:0');
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0');
  }

  if (reencodeVideo) {
    // Shared across every axis that matters to Facebook, so a file normalised on the
    // user's PC is interchangeable with one normalised on the VPS.
    const common = [
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-b:v', '4500k',
      '-maxrate', '4500k',
      '-bufsize', '9000k',
    ];

    if (videoEncoder === 'libx264') {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', ...common,
        // x264's own scene-cut detection would insert extra keyframes and, worse,
        // stretch the gap past 2s around them.
        '-keyint_min', '60', '-sc_threshold', '0');
    } else {
      // Hardware encoders take the same targets but reject x264-only flags, and they
      // need their scene-cut behaviour disabled explicitly or the 2-second keyframe
      // guarantee does not hold.
      args.push('-c:v', videoEncoder, ...common);
      if (videoEncoder === 'h264_nvenc') {
        args.push('-preset', 'p4', '-rc', 'cbr', '-no-scenecut', '1');
      } else if (videoEncoder === 'h264_qsv') {
        args.push('-preset', 'medium');
      } else if (videoEncoder === 'h264_amf') {
        args.push('-quality', 'balanced', '-rc', 'cbr');
      }
    }
  } else {
    // No filters and no encoder settings here on purpose: with -c:v copy, FFmpeg
    // passes the original packets through, so -r/-g/-vf would either be ignored or
    // rejected.
    args.push('-c:v', 'copy');
  }

  args.push(
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', String(config.facebook.audioSampleRate),
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath
  );

  return args;
}

/**
 * How long a normalise run will take, so the user is told what they are waiting for
 * instead of watching an unexplained progress bar.
 *
 * Calibrated against the 2-core VPS this app was built for, timing FFmpeg directly
 * on a 180-second 1080p clip:
 *
 *   re-encode video   125.0 s  =  1.44x realtime
 *   audio only         12.9 s  = 13.97x realtime   (9.7x faster)
 *
 * A first attempt measured on a 30-second clip suggested 0.45x, which was wrong: at
 * that length the ~40 s of fixed cost (SSH round trips, systemd-run, the 4-second
 * poll loop, the verification probe, the thumbnail) swamped the encoding. Hence the
 * separate FIXED_COST term rather than one blended ratio — the model is validated at
 * both 30 s and 180 s.
 *
 * Synthetic test patterns are near worst case for x264 and ordinary footage encodes
 * faster, so the band is set wide around the measurement.
 */
const NORMALIZE_FIXED_COST_SECONDS = 40;

function estimateNormalizeSeconds({ durationSeconds, cpuCores = 2, reencodeVideo = true }) {
  if (!durationSeconds) return null;
  const cores = Math.max(1, Number(cpuCores) || 2);
  const scale = cores / 2;

  // Audio-only barely touches the CPU: it is bounded by reading and rewriting the
  // container, so extra cores buy nothing.
  const [slow, fast] = reencodeVideo ? [0.9 * scale, 2.0 * scale] : [6, 18];

  return {
    min: durationSeconds / fast + NORMALIZE_FIXED_COST_SECONDS,
    max: durationSeconds / slow + NORMALIZE_FIXED_COST_SECONDS,
  };
}

/**
 * Turns `-progress` output into a percentage for the normalise job.
 *
 * The key=value parsing itself lives in ffmpeg.service so the live watcher and
 * this job read the same format through one implementation.
 */
function parseFfmpegProgress(text, durationSeconds) {
  const fields = ffmpegService.parseProgressFields(text);
  const seconds = fields.outTimeUs != null ? fields.outTimeUs / 1_000_000 : null;

  const percent =
    seconds != null && durationSeconds > 0
      ? Math.max(0, Math.min(99, Math.round((seconds / durationSeconds) * 100)))
      : null;

  return { seconds, percent, done: fields.ended };
}

/**
 * Where a normalise run writes, and it is deliberately NOT the videos directory.
 *
 * Keyed by video id rather than a fresh uuid so a resumed worker watches the same
 * file the running encode is writing to. Living in temp/ also means
 * `scanRemoteVideos` — which lists only the videos directory — can never adopt a
 * half-finished encode as if the user had copied it in. Same filesystem as videos/,
 * so the final move is an atomic rename rather than a copy.
 */
const normalizeOutputPath = (videoId) => `${config.remote.temp}/normalize-${Number(videoId)}.mp4`;
const normalizeProgressPath = (videoId) =>
  `${config.remote.logs}/normalize-${Number(videoId)}.progress`;

function buildNormalizeWorker(serverId, videoId) {
  return async function worker(ctx) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) throw new AppError('Không tìm thấy VPS.', 404);

    const video = findByIdOrThrow(videoId);
    const unit = normalizeUnitName(videoId);
    const outputPath = normalizeOutputPath(videoId);
    const progressPath = normalizeProgressPath(videoId);
    const originalPath = video.remote_path;
    const originalUuid = video.uuid;
    const duration = video.duration_seconds || 0;

    // Only re-encode the stream that is actually wrong. A 2-hour file whose sole
    // fault is a non-AAC soundtrack takes about a minute this way; forcing it
    // through a full 1080p video encode on a 2-core VPS would take 40-80 minutes
    // and lose a generation of picture quality for nothing.
    const verdict = evaluateCompliance({
      codecVideo: video.codec_video,
      codecAudio: video.codec_audio,
      width: video.width,
      height: video.height,
      fps: video.fps,
      pixelFormat: null, // not stored; treated as acceptable, same as before
      hasAudio: video.has_audio === 1,
      maxKeyframeInterval: video.max_keyframe_interval,
    });
    // A video queued for normalise that somehow needs nothing is still re-encoded
    // on the video path: that is the conservative choice, and the caller only
    // reaches here when something was flagged.
    // Changing the frame shape is a picture operation, so it forces the video path
    // even for a file that already meets every Facebook requirement — which is the
    // normal case when the user is fixing the Facebook-stretches-vertical problem
    // rather than a compliance fault.
    const fitPlan = frameFitPlan(video.width, video.height, video.frame_fit || 'keep');
    // Re-encode the picture only when the picture is what is wrong.
    //
    // This used to read `|| !verdict.needsAudioReencode`, which meant a file with
    // NOTHING wrong re-encoded its video: both flags false, so the negation was
    // true. It happened for real — video 31 was normalised twice within ten minutes
    // and the second pass had no work to do, so it just spent a generation of
    // quality re-compressing an already-correct 4500 kbps file.
    const reencodeVideo = Boolean(fitPlan) || verdict.needsVideoReencode;
    const scaleTo = reencodeVideo && !fitPlan ? targetFrameSize(video.width, video.height) : null;

    patch(videoId, { status: STATUS.OPTIMIZING });
    ctx.progress({ percent: 2, step: 'Đang kiểm tra dung lượng…', unit });

    // The encode writes a second copy alongside the original, so there must be
    // room for both (spec section 21).
    const check = await storage.preflight(server, video.size_bytes || 0);
    if (!check.allowed) {
      patch(videoId, { status: STATUS.NEEDS_OPTIMIZE });
      throw new AppError(`Không đủ chỗ để chuẩn hoá video.\n\n${check.message}`, 400);
    }

    // Resume-safe, mirroring the import worker. Without this check a restart in the
    // middle of an encode re-ran systemd-run against a unit that was still active,
    // which fails — so the job reported an error while the real encode carried on
    // and produced a file nobody ever looked at. Wiping the progress file is inside
    // the same guard: FFmpeg holds that fd, so deleting it mid-encode leaves it
    // writing to an unlinked inode and the percentage never moves again.
    const activeNow = await ssh.exec(
      server,
      `systemctl is-active ${shellEscape(unit)} 2>/dev/null || true`
    );
    const resuming = ['active', 'activating'].includes(activeNow.stdout.trim());

    if (!resuming) {
      // Free the unit NAME, not only its failure flag.
      //
      // reset-failed clears a failed unit but does not unload one that is merely
      // loaded, and systemd-run refuses a name that still exists ("Unit ... was
      // already loaded or has a fragment file"). Normally --collect means this never
      // happens; `stop` covers the case where a previous run died in a way that left
      // the unit behind. On a name that does not exist it simply reports "not
      // loaded" and changes nothing, which is why the error is discarded.
      await ssh.execPrivileged(
        server,
        `systemctl stop ${shellEscape(unit)} 2>/dev/null || true; ` +
          `systemctl reset-failed ${shellEscape(unit)} 2>/dev/null || true`
      );
    }

    const args = buildNormalizeArgs({
      inputPath: originalPath,
      outputPath,
      progressPath,
      hasAudio: video.has_audio === 1,
      reencodeVideo,
      scaleTo,
      fitPlan,
    });

    const estimate = estimateNormalizeSeconds({
      durationSeconds: duration,
      cpuCores: server.cpu_cores,
      reencodeVideo,
    });
    const estimateLabel = estimate
      ? ` · dự kiến ${formatDuration(estimate.min)}–${formatDuration(estimate.max)}`
      : '';
    const whatLabel = !reencodeVideo
      ? 'Chỉ sửa âm thanh, giữ nguyên hình'
      : fitPlan
        ? `Đang đưa về khung ${fitPlan.frame.width}×${fitPlan.frame.height}` +
          ` (${fitPlan.mode === 'blur' ? 'nền mờ' : 'viền đen'})`
        : scaleTo
          ? `Đang encode lại hình và thu về ${scaleTo.width}×${scaleTo.height}`
          : 'Đang encode lại hình cho đúng chuẩn Facebook';

    ctx.progress({ percent: 4, step: `${whatLabel}${estimateLabel}` });

    const journalTail = async () => {
      const out = await ssh
        .execPrivileged(server, `journalctl -u ${shellEscape(unit)} -n 25 --no-pager 2>/dev/null || true`)
        .catch(() => ({ stdout: '' }));
      return (out.stdout || '').slice(-800);
    };

    try {
      if (!resuming) {
        await ssh.exec(server, `rm -f ${shellEscape(outputPath)} ${shellEscape(progressPath)}`);

        // Runs on the VPS under systemd so it survives our restart and the browser
        // closing (spec section 21: no HTTP request waits for the encode).
        const start = await ssh.execPrivileged(
          server,
          `systemd-run --unit=${shellEscape(unit)} --collect --property=Type=simple ` +
            args.map((a) => shellEscape(a)).join(' '),
          { timeout: 30_000 }
        );
        if (start.code !== 0) {
          throw new AppError(
            `Không khởi động được tiến trình chuẩn hoá: ` +
              `${(start.stderr || '').trim().slice(0, 200) || `exit ${start.code}`}`,
            400
          );
        }
      } else {
        ctx.progress({ step: `${whatLabel} (tiếp tục tiến trình đang chạy trên VPS)` });
      }

      for (;;) {
        ctx.throwIfCancelled();
        await ctx.sleep(4000);

        const [progressResult, activeResult] = await Promise.all([
          ssh.exec(server, `tail -n 24 ${shellEscape(progressPath)} 2>/dev/null || true`),
          ssh.exec(server, `systemctl is-active ${shellEscape(unit)} 2>/dev/null || true`),
        ]);

        const progress = parseFfmpegProgress(progressResult.stdout, duration);
        if (progress.percent != null) {
          const remaining =
            duration > 0 && progress.seconds > 0
              ? ` · còn khoảng ${formatDuration(Math.max(0, duration - progress.seconds))}`
              : '';
          ctx.progress({
            percent: Math.max(4, progress.percent),
            step: `${whatLabel}${remaining}`,
          });
        }

        const active = activeResult.stdout.trim();
        if (active !== 'active' && active !== 'activating') break;
      }

      // Did it actually produce a usable file?
      const sizeResult = await ssh.exec(
        server,
        `stat -c %s ${shellEscape(outputPath)} 2>/dev/null || echo -1`
      );
      const outputSize = Number(sizeResult.stdout.trim());

      if (!Number.isFinite(outputSize) || outputSize <= 0) {
        // The encode never finished. Genuinely retryable — an OOM kill or a full
        // disk can succeed next time — so leave it at NEEDS_OPTIMIZE.
        ctx.progress({ detail: await journalTail() });
        await ssh.exec(server, `rm -f ${shellEscape(outputPath)} ${shellEscape(progressPath)}`);
        patch(videoId, { status: STATUS.NEEDS_OPTIMIZE });
        throw new AppError('Chuẩn hoá video không thành công. Xem phần Chi tiết bên dưới.', 400);
      }

      ctx.progress({ percent: 94, step: 'Đang kiểm tra kết quả…' });

      // Inspect the OUTPUT before the row knows anything about it.
      //
      // The old order patched the row to the new file first and only then checked.
      // When the check failed, the row was left pointing at a bad encode while the
      // original became an unreferenced file on disk — so every failed attempt
      // leaked a copy, and the next attempt re-encoded the previous encode instead
      // of the source.
      const meta = await probeRemoteVideo(server, outputPath, { fallbackSizeBytes: outputSize });
      const compliance = evaluateCompliance(meta);

      if (!compliance.compliant) {
        // Every axis of the rule is something this encode controls, so repeating it
        // produces the same output. Saying "needs optimising" again would just
        // re-offer the button that got us here — that IS the loop the user hit.
        ctx.progress({ detail: await journalTail() });
        await ssh.exec(server, `rm -f ${shellEscape(outputPath)} ${shellEscape(progressPath)}`);
        patch(videoId, {
          status: STATUS.ERROR,
          error_message: 'Bản chuẩn hoá tạo ra vẫn không đạt chuẩn Facebook.',
          compliance_notes: JSON.stringify(compliance.notes),
        });
        throw new AppError(
          `Bản chuẩn hoá đã tạo xong nhưng vẫn không đạt chuẩn Facebook:\n` +
            compliance.notes.map((n) => `- ${n}`).join('\n') +
            `\n\nChuẩn hoá lại sẽ cho đúng kết quả này, nên app không mở lại nút đó. ` +
            `Đây là lỗi của app hoặc của FFmpeg trên VPS, không phải của video. ` +
            `Hãy bấm "Kiểm tra lại", hoặc tự xuất video ở 1920×1080 ` +
            `(1080×1920 nếu là video dọc), 30 FPS, H.264 + AAC.`,
          400
        );
      }

      // Files first, then the row, then the old file. A crash between any two steps
      // leaves the row pointing at a file that exists — never at a missing one.
      const newUuid = crypto.randomUUID();
      const finalPath = remotePathFor(newUuid);
      const moved = await ssh.exec(
        server,
        `mv -f ${shellEscape(outputPath)} ${shellEscape(finalPath)}`,
        { timeout: 60_000 }
      );
      if (moved.code !== 0) {
        throw new AppError(
          `Không chuyển được bản chuẩn hoá vào thư mục video: ` +
            `${(moved.stderr || '').trim().slice(0, 200) || `exit ${moved.code}`}`,
          400
        );
      }

      patch(videoId, {
        uuid: newUuid,
        remote_path: finalPath,
        size_bytes: meta.sizeBytes,
        duration_seconds: meta.durationSeconds,
        bitrate: meta.bitrate,
        codec_video: meta.codecVideo,
        codec_audio: meta.codecAudio,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        has_audio: meta.hasAudio ? 1 : 0,
        max_keyframe_interval: meta.maxKeyframeInterval,
        fb_compliant: 1,
        compliance_notes: JSON.stringify([]),
        status: STATUS.READY,
        error_message: null,
      });

      await ssh.exec(
        server,
        `rm -f ${shellEscape(originalPath)} ${shellEscape(progressPath)}`,
        { timeout: 30_000 }
      );

      // The preview belonged to the old file and its uuid is now unreachable, so it
      // would sit in the cache directory forever.
      removeThumbnail(originalUuid);
      await captureThumbnail(server, findById(videoId)).catch((err) =>
        logger.warn(`Thumbnail for video ${videoId} failed: ${err.message}`)
      );

      db.prepare(
        `INSERT INTO activity_logs (type, message, entity_type, entity_id)
         VALUES ('video_optimized', ?, 'video', ?)`
      ).run(`Đã chuẩn hoá video ${video.original_name} cho Facebook`, videoId);

      await storage.refresh(server).catch(() => {});
      ctx.progress({ percent: 100, step: 'Video đã sẵn sàng phát live.' });
    } catch (err) {
      // Covers Cancel as well as failure. Without this, pressing Huỷ threw straight
      // out of the worker and left status at 'optimizing' forever: that state hides
      // the normalise button (it needs needs_optimize) AND the delete button (it
      // needs !isBusy), so the video became a row with no possible action.
      await ssh
        .execPrivileged(server, `systemctl stop ${shellEscape(unit)} 2>/dev/null || true`)
        .catch(() => {});
      await ssh
        .exec(server, `rm -f ${shellEscape(outputPath)} ${shellEscape(progressPath)}`)
        .catch(() => {});

      // Do not overwrite a verdict the branches above already recorded.
      if (findById(videoId)?.status === STATUS.OPTIMIZING) {
        patch(videoId, { status: STATUS.NEEDS_OPTIMIZE });
      }
      throw err;
    }
  };
}

/**
 * Starts the "Chuẩn hoá cho Facebook" job (spec section 21).
 *
 * @param {string} [opts.frameFit] 'keep' | 'pad' | 'blur' — recorded before the job
 *   starts so the worker and a later resume both see the same choice.
 */
function startNormalize(server, videoId, { frameFit } = {}) {
  let video = findByIdOrThrow(videoId);
  if (video.server_id !== server.id) {
    throw new AppError('Video không thuộc VPS này.', 400);
  }

  if (frameFit != null) {
    if (!FRAME_FITS.has(frameFit)) throw new AppError('Khung hình đầu ra không hợp lệ.', 400);
    if (frameFit !== 'keep' && !frameFitPlan(video.width, video.height, frameFit)) {
      const wanted = parseFrameFit(frameFit);
      throw new AppError(
        `Video này đã là ${video.width}×${video.height}, đúng bằng khung ` +
          `${wanted.target.width}×${wanted.target.height} bạn chọn, nên không cần đổi gì.`,
        400
      );
    }
    patch(videoId, { frame_fit: frameFit });
    video = findByIdOrThrow(videoId);
  }

  const busy = jobs.findActive({ type: 'normalize', entityType: 'video', entityId: videoId });
  if (busy) return { video, job: busy };

  // Refuse a run with nothing to do.
  //
  // Re-encoding a file that is already correct cannot improve it — it can only cost
  // a generation of quality, because the encoder spends its bitrate reproducing the
  // previous encode's artefacts. Without this guard a second click (or a second
  // click on a form left open after the first finished) visibly degraded a good
  // video, which is what happened to the user's 0816.mp4.
  const plan = frameFitPlan(video.width, video.height, video.frame_fit || 'keep');
  const verdict = evaluateCompliance({
    codecVideo: video.codec_video,
    codecAudio: video.codec_audio,
    width: video.width,
    height: video.height,
    fps: video.fps,
    pixelFormat: null,
    hasAudio: video.has_audio === 1,
    maxKeyframeInterval: video.max_keyframe_interval,
  });
  if (!plan && verdict.compliant) {
    throw new AppError(
      `Video này đã đạt chuẩn Facebook và đã ở khung ${video.width}×${video.height}, ` +
        `nên không có gì để chuẩn hoá.\n\n` +
        `Chuẩn hoá lại một file đã đúng KHÔNG làm nó nét hơn — ngược lại, mỗi lần encode ` +
        `lại là một lần mất chất lượng. Nếu muốn nét hơn, hãy chuẩn hoá từ bản gốc ` +
        `chất lượng cao, đừng chuẩn hoá lại bản đã encode.`,
      400
    );
  }

  const usage = usageOf(videoId);
  if (usage.activeCount > 0) {
    throw new AppError(
      `Video này đang được ${usage.activeCount} buổi live sử dụng. ` +
        `Hãy dừng live trước khi chuẩn hoá, vì file video sẽ bị thay thế.`,
      409
    );
  }

  const job = jobs.start(
    {
      serverId: server.id,
      type: 'normalize',
      entityType: 'video',
      entityId: videoId,
      step: 'Đang chuẩn bị…',
    },
    buildNormalizeWorker(server.id, videoId)
  );

  return { video, job };
}

// Like imports, the encode runs in a systemd unit on the VPS and keeps going
// without us, so resume the polling rather than failing the job.
jobs.registerResumer('normalize', (job, ctx) =>
  buildNormalizeWorker(job.server_id, job.entity_id)(ctx)
);

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/** Refuses to delete a video that a project or a running live still needs (spec section 33). */
function assertDeletable(videoId) {
  const usage = usageOf(videoId);

  if (usage.activeCount > 0) {
    throw new AppError(
      `Video này đang được ${usage.activeCount} buổi live sử dụng. Hãy dừng live trước khi xoá.`,
      409
    );
  }
  if (usage.projects.length > 0) {
    throw new AppError(
      `Video đang được sử dụng bởi:\n${usage.projects.map((p) => `- ${p.name}`).join('\n')}\n\n` +
        `Hãy đổi video cho các project này trước khi xoá.`,
      409,
      { projects: usage.projects }
    );
  }
  return usage;
}

async function remove(server, videoId) {
  const video = findByIdOrThrow(videoId);
  assertDeletable(videoId);

  await ssh.exec(server, `rm -f ${shellEscape(video.remote_path)}`, { timeout: 30_000 });

  db.prepare('DELETE FROM jobs WHERE entity_type = ? AND entity_id = ?').run('video', videoId);
  db.prepare('DELETE FROM project_videos WHERE video_id = ?').run(videoId);
  db.prepare('DELETE FROM videos WHERE id = ?').run(videoId);
  removeThumbnail(video.uuid);

  db.prepare(
    `INSERT INTO activity_logs (type, message, entity_type, entity_id)
     VALUES ('video_deleted', ?, 'video', ?)`
  ).run(`Đã xoá video ${video.original_name}`, videoId);

  await storage.refresh(server).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// Adopting videos copied straight onto the VPS
// ---------------------------------------------------------------------------

/**
 * A file must sit still before we believe it is complete.
 *
 * scp writes directly to the destination name, so a transfer in progress looks
 * exactly like a finished video that happens to be growing. Adopting one of those
 * would hand a half-written mp4 to ffprobe, or worse, to a live stream.
 */
const SETTLE_SECONDS = 20;
const SETTLE_RECHECK_MS = 3000;

/** Files the scanner must never treat as a video. */
function isIgnoredEntry(name) {
  // Dotfiles cover rsync's in-progress temporaries (.foo.mp4.XXXX).
  if (name.startsWith('.')) return true;
  if (/^playlist-\d+\.txt$/.test(name)) return true;
  return false;
}

/** Parses the `name<TAB>size<TAB>mtime` lines produced by the scan command. */
function parseListing(stdout) {
  const entries = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const size = Number(parts[parts.length - 2]);
    const mtime = Number(parts[parts.length - 1]);
    // Rejoin in case the filename itself contained a tab.
    const name = parts.slice(0, -2).join('\t');
    if (!name || !Number.isFinite(size) || !Number.isFinite(mtime)) continue;
    entries.push({ name, size, mtime });
  }
  return entries;
}

const listCommand = () =>
  // -printf keeps parsing simple and survives spaces; maxdepth 1 avoids
  // descending into anything the user may have nested in there.
  `find ${shellEscape(config.remote.videos)} -maxdepth 1 -type f ` +
  `-printf '%f\\t%s\\t%T@\\n' 2>/dev/null || true`;

/**
 * Looks at the videos directory on the VPS and reports what is new, what is
 * still being copied, and which known videos have disappeared.
 */
async function scanRemoteVideos(server) {
  const first = parseListing((await ssh.exec(server, listCommand(), { timeout: 30_000 })).stdout);

  const known = new Map(
    listForServer(server.id).map((v) => [v.remote_path, v])
  );
  const nowSeconds = Date.now() / 1000;

  const candidates = [];
  const pending = [];
  const rejected = [];

  for (const entry of first) {
    const remotePath = `${config.remote.videos}/${entry.name}`;
    if (isIgnoredEntry(entry.name)) continue;
    if (known.has(remotePath)) continue;

    if (/[\r\n]/.test(entry.name)) {
      // Unescapable in the concat playlist format, which is one file per line.
      rejected.push({ name: entry.name, reason: 'Tên file có ký tự xuống dòng. Hãy đổi tên file.' });
      continue;
    }
    if (!videoExtension(entry.name)) {
      rejected.push({ name: entry.name, reason: 'Không phải định dạng video được hỗ trợ.' });
      continue;
    }
    if (entry.size <= 0) {
      pending.push({ name: entry.name, reason: 'File rỗng, có thể vừa mới bắt đầu copy.' });
      continue;
    }
    if (nowSeconds - entry.mtime < SETTLE_SECONDS) {
      pending.push({ name: entry.name, reason: 'File vừa được ghi, có thể đang copy dở.' });
      continue;
    }
    candidates.push({ ...entry, remotePath });
  }

  // Second look: a file whose size moved between the two samples is still being
  // written, whatever its mtime said.
  if (candidates.length) {
    await new Promise((r) => setTimeout(r, SETTLE_RECHECK_MS));
    const second = new Map(
      parseListing((await ssh.exec(server, listCommand(), { timeout: 30_000 })).stdout).map((e) => [
        e.name,
        e,
      ])
    );

    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const again = second.get(candidates[i].name);
      if (!again || again.size !== candidates[i].size) {
        pending.push({
          name: candidates[i].name,
          reason: 'Dung lượng còn đang tăng — đang copy dở.',
        });
        candidates.splice(i, 1);
      }
    }
  }

  // Reverse direction: a video we know about whose file is gone.
  const present = new Set(first.map((e) => `${config.remote.videos}/${e.name}`));
  const missing = [];
  for (const [remotePath, video] of known) {
    if (present.has(remotePath)) continue;
    if ([STATUS.UPLOADING, STATUS.DOWNLOADING].includes(video.status)) continue; // still arriving
    missing.push(video);
  }

  return { candidates, pending, rejected, missing };
}

/**
 * Registers a file already sitting on the VPS.
 *
 * Keeps the user's own filename — they need to recognise it and be able to scp
 * over it again — while still minting an internal uuid for the thumbnail and
 * progress paths, which must stay predictable.
 */
/**
 * A file this app put on the VPS is already named with the uuid that identifies it.
 *
 * Matches the naming scheme used for uploads and imports, so anything named this way
 * came from an install of this app rather than from a human copying a file in.
 */
const UUID_FILENAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9]+$/i;

/**
 * The identity to adopt a scanned file under.
 *
 * Minting a fresh uuid for every scanned file is right when a human copied a video in
 * by hand, and wrong when the file is one this app already knows. On a machine
 * restoring from the Sheet, every video on the VPS is named `<uuid>.mp4` from the
 * install that uploaded it — so a fresh uuid threw away the only link back to that
 * video's real name and its place in a playlist. What the user saw: a project that
 * lists a video on the Sheet but shows an empty playlist in the app, and a video
 * called "1e3129d3-3dd6-405a-813f-9a3b5a6342bf.mp4". Worse, the invented uuid was
 * absent from the Sheet, so the next pull pushed it up as a NEW row and the Videos
 * tab ended up with two rows per file.
 *
 * Reused only when free: a collision means this database already holds that video,
 * and the file being adopted has to be something else.
 */
function adoptionUuid(name) {
  const match = UUID_FILENAME.exec(String(name || '').trim());
  if (!match) return crypto.randomUUID();
  const fromName = match[1].toLowerCase();
  const taken = db.prepare('SELECT 1 FROM videos WHERE uuid = ?').get(fromName);
  return taken ? crypto.randomUUID() : fromName;
}

async function adoptVideo(server, entry) {
  const uuid = adoptionUuid(entry.name);
  const info = db
    .prepare(
      `INSERT INTO videos (server_id, uuid, original_name, remote_path, size_bytes,
                           status, source_type)
       VALUES (?, ?, ?, ?, ?, ?, 'scanned')`
    )
    .run(server.id, uuid, cleanName(entry.name, 200), entry.remotePath, entry.size, STATUS.ANALYZING);

  const video = findById(info.lastInsertRowid);

  try {
    const { compliance } = await analyze(server, video);
    db.prepare(
      `INSERT INTO activity_logs (type, message, entity_type, entity_id)
       VALUES ('video_scanned', ?, 'video', ?)`
    ).run(
      `Đã nhận video ${entry.name} từ thư mục trên VPS (${formatBytes(entry.size)})`,
      video.id
    );
    return { video: findById(video.id), compliance };
  } catch (err) {
    // Drop the row rather than leaving it as an error.
    //
    // Once a path is in the table the scanner treats it as known and never looks
    // again, so a file that failed because it was still being copied could never
    // be picked up. Removing it means the next Làm mới simply retries. Genuinely
    // broken files get retried too, and are reported each time, which is the
    // cheaper mistake.
    db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
    removeThumbnail(uuid);
    throw err;
  }
}

/** Scan, then adopt everything that qualifies. Backs the Làm mới button. */
async function scanAndAdopt(server) {
  const scan = await scanRemoteVideos(server);
  const adopted = [];
  const failed = [];

  for (const entry of scan.candidates) {
    try {
      const { video, compliance } = await adoptVideo(server, entry);
      adopted.push({ id: video.id, name: video.original_name, compliant: compliance.compliant });
    } catch (err) {
      failed.push({ name: entry.name, error: err.message });
    }
  }

  for (const video of scan.missing) {
    patch(video.id, {
      status: STATUS.ERROR,
      error_message: 'File không còn trên VPS.',
    });
  }

  await storage.refresh(server).catch(() => {});

  return { adopted, failed, pending: scan.pending, rejected: scan.rejected, missing: scan.missing };
}

/**
 * Videos no project references, with the disk they are holding.
 *
 * Uses the same usageOf() the delete guard uses, so anything listed here is
 * genuinely safe to remove — a video still attached to a project can never
 * appear.
 */
function listUnused(serverId = null) {
  const rows = serverId ? listForServer(serverId) : listAll();
  const unused = rows.filter((video) => {
    const usage = usageOf(video.id);
    return usage.projects.length === 0 && usage.destinationCount === 0;
  });

  return {
    videos: unused,
    count: unused.length,
    totalBytes: unused.reduce((sum, v) => sum + (v.size_bytes || 0), 0),
  };
}

/** Deletes every unused video, reporting per-video outcomes. */
async function removeUnused(server) {
  const { videos } = listUnused(server.id);
  const results = [];

  for (const video of videos) {
    try {
      await remove(server, video.id);
      results.push({ id: video.id, name: video.original_name, ok: true, bytes: video.size_bytes });
    } catch (err) {
      results.push({ id: video.id, name: video.original_name, ok: false, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

function toView(video) {
  let notes = [];
  try {
    notes = video.compliance_notes ? JSON.parse(video.compliance_notes) : [];
  } catch {
    notes = [];
  }

  const usage = usageOf(video.id);
  const job = jobs.latestForEntity('video', video.id);

  return {
    id: video.id,
    uuid: video.uuid,
    serverId: video.server_id,
    name: video.original_name,
    remotePath: video.remote_path,
    sizeBytes: video.size_bytes,
    sizeLabel: formatBytes(video.size_bytes),
    durationLabel: video.duration_seconds ? formatDuration(video.duration_seconds) : null,
    // Raw seconds as well as the label: the loop settings need arithmetic
    // ("3 loops of this playlist is how many hours?"), not a formatted string.
    durationSeconds: video.duration_seconds || null,
    frameFit: video.frame_fit || 'keep',
    // Which output frames would actually change this video. Offered for both
    // orientations: Facebook has stretched this footage in both directions depending
    // on how the broadcast was created, so neither shape is automatically safe.
    frameOptions: Object.entries(FRAME_TARGETS)
      .filter(([key]) => frameFitPlan(video.width, video.height, `${key}_pad`))
      .map(([key, t]) => ({
        key,
        label: `${t.width}×${t.height}`,
        ratio: t.ratio,
        orientation: t.label,
      })),
    ratio:
      video.width && video.height
        ? video.width > video.height
          ? '16:9 (ngang)'
          : video.width < video.height
            ? '9:16 (dọc)'
            : '1:1 (vuông)'
        : null,
    resolution: video.width && video.height ? `${video.width} × ${video.height}` : null,
    fps: video.fps,
    codecVideo: video.codec_video,
    codecAudio: video.codec_audio,
    hasAudio: video.has_audio === 1,
    maxKeyframeInterval: video.max_keyframe_interval,
    status: video.status,
    isReady: video.status === STATUS.READY,
    needsOptimize: video.status === STATUS.NEEDS_OPTIMIZE,
    isBusy: [STATUS.UPLOADING, STATUS.DOWNLOADING, STATUS.ANALYZING, STATUS.OPTIMIZING].includes(
      video.status
    ),
    errorMessage: video.error_message,
    complianceNotes: notes,
    sourceType: video.source_type,
    usage,
    isUnused: usage.projects.length === 0 && usage.destinationCount === 0,
    hasThumbnail: hasThumbnail(video),
    job: job && !jobs.TERMINAL.has(job.status) ? job : null,
    createdAt: video.created_at,
  };
}

module.exports = {
  STATUS,
  remotePathFor,
  tempPathFor,
  scriptPathFor,
  progressPathFor,
  findById,
  findByIdOrThrow,
  listForServer,
  listAll,
  usageOf,
  create,
  patch,
  setError,
  analyze,
  probeRemoteVideo,
  evaluateCompliance,
  // Pure and exported so the frame-size rule can be checked without a VPS — it is
  // the rule that was silently rejecting every vertical video.
  isFrameSizeAllowed,
  targetFrameSize,
  frameFitPlan,
  frameFitFilter,
  parseFrameFit,
  FRAME_FITS,
  FRAME_TARGETS,
  estimateNormalizeSeconds,
  normalizeOutputPath,
  normalizeProgressPath,
  maxKeyframeGap,
  parseFrameRate,
  startImport,
  buildImportWorker,
  startNormalize,
  buildNormalizeWorker,
  buildNormalizeArgs,
  parseFfmpegProgress,
  normalizeUnitName,
  assertDeletable,
  remove,
  scanRemoteVideos,
  adoptVideo,
  scanAndAdopt,
  parseListing,
  isIgnoredEntry,
  listUnused,
  removeUnused,
  captureThumbnail,
  thumbnailPath,
  hasThumbnail,
  removeThumbnail,
  toView,
  videoExtension,
};
