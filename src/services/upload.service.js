'use strict';

const { pipeline } = require('node:stream/promises');
const busboy = require('busboy');

const db = require('../db');
const config = require('../config');
const ssh = require('./ssh.service');
const jobs = require('./job.service');
const storage = require('./storage.service');
const videoService = require('./video.service');
const { shellEscape } = require('../utils/shell-escape');
const { formatBytes, gbToBytes, parseTimestamp } = require('../utils/format-bytes');
const { AppError } = require('../middleware/error-handler');
const logger = require('../utils/logger');

/**
 * Streams a browser upload straight through to the VPS over SFTP.
 *
 * The hard requirement (spec sections 18, 44, 55.7): Node must never hold the
 * whole file. Nothing here buffers — busboy hands us a stream, pipeline() applies
 * backpressure, and the bytes land on the VPS as they arrive.
 *
 * ssh2's SFTP streams default to 32 KB chunks, which makes a 2 GB transfer
 * needlessly slow, so the write stream is opened with a 1 MB high-water mark.
 */

const SFTP_CHUNK_BYTES = 1024 * 1024;

/** Adds to this month's outbound total so the UI can warn before Render cuts us off. */
function recordEgress(bytes) {
  if (!bytes || bytes <= 0) return;
  const month = new Date().toISOString().slice(0, 7);
  db.prepare(
    `INSERT INTO app_counters (month, egress_bytes) VALUES (?, ?)
     ON CONFLICT(month) DO UPDATE
       SET egress_bytes = egress_bytes + excluded.egress_bytes,
           updated_at = CURRENT_TIMESTAMP`
  ).run(month, bytes);
}

function egressThisMonth() {
  const month = new Date().toISOString().slice(0, 7);
  const row = db.prepare('SELECT egress_bytes FROM app_counters WHERE month = ?').get(month);
  const used = row ? row.egress_bytes : 0;
  const budget = gbToBytes(config.bandwidthBudgetGb);
  return {
    usedBytes: used,
    budgetBytes: budget,
    percent: budget > 0 ? Math.round((used / budget) * 100) : 0,
    usedLabel: formatBytes(used),
    budgetLabel: `${config.bandwidthBudgetGb} GB`,
  };
}

/**
 * How long an upload job may go without a heartbeat before it is treated as dead.
 * An upload only advances while an HTTP request is in flight, so a silent job
 * means the request is gone — killed process, dropped connection, closed tab.
 */
const STALE_UPLOAD_MS = 90_000;

/**
 * Releases an upload job whose request no longer exists.
 *
 * Without this, one interrupted upload would refuse every future upload to that
 * VPS with "already in progress" until the app was restarted — a dead end the
 * user has no way out of from the UI.
 */
async function reclaimStaleUpload(server, job) {
  jobs.update(job.id, {
    status: 'failed',
    error_message:
      'Upload bị ngắt giữa đường (mất kết nối, đóng tab, hoặc app khởi động lại).',
  });

  const video = job.entity_id ? videoService.findById(job.entity_id) : null;
  if (video && video.status === videoService.STATUS.UPLOADING) {
    videoService.patch(video.id, {
      status: videoService.STATUS.ERROR,
      error_message: 'Upload bị ngắt giữa đường.',
    });
    // Drop the partial file so it stops occupying disk (spec section 18).
    await ssh
      .exec(server, `rm -f ${shellEscape(videoService.tempPathFor(video.uuid))}`, {
        timeout: 20_000,
      })
      .catch((err) => logger.warn(`Could not remove stale .part: ${err.message}`));
  }

  logger.warn(`Reclaimed stale upload job ${job.id} on server ${server.id}`);
}

/**
 * Only one ingest per VPS at a time, so two transfers cannot both fit the disk
 * (spec section 18). Stale upload jobs are reclaimed rather than trusted.
 */
async function assertServerFree(server) {
  const upload = jobs.findActive({ type: 'upload', serverId: server.id });
  if (upload) {
    const beat = parseTimestamp(upload.updated_at);
    const idleMs = beat ? Date.now() - beat.getTime() : Infinity;

    if (idleMs > STALE_UPLOAD_MS) {
      await reclaimStaleUpload(server, upload);
    } else {
      throw new AppError(
        `VPS này đang có một upload đang chạy (${upload.step || 'đang tải lên'}). ` +
          `Vui lòng đợi upload hiện tại xong.`,
        409
      );
    }
  }

  // Imports run in a systemd unit on the VPS and are re-attached after a restart,
  // so a quiet import job is genuinely still working.
  if (jobs.findActive({ type: 'import', serverId: server.id })) {
    throw new AppError('VPS này đang tải một video từ link. Vui lòng đợi xong.', 409);
  }
}

/**
 * Reads the multipart request, forwarding the file part to SFTP.
 *
 * The client must send its text fields before the file part; FormData preserves
 * append order, so app.js appends server_id and size first.
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        // Busboy decodes filenames as latin1 by default, which turns a
        // Vietnamese name like "chợ Hậu.mp4" into "chá» Háº­u.mp4".
        defParamCharset: 'utf8',
        limits: {
          files: 1,
          fields: 12,
          fileSize: gbToBytes(config.storage.maxUploadGb),
        },
      });
    } catch (err) {
      return reject(new AppError('Yêu cầu upload không đúng định dạng.', 400));
    }

    const fields = {};
    let settled = false;
    let fileStream = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    /**
     * Ends the upload when the client goes away.
     *
     * Before the file part arrives, rejecting the promise is enough. Afterwards
     * the promise has already resolved, so the ONLY way to unblock the caller is
     * to destroy the stream its pipeline() is reading from. Without this, an
     * aborted request leaves pipeline() waiting for bytes that never arrive: the
     * upload job stays "running" forever, the SFTP handle leaks, and every later
     * upload to that VPS is refused as "already in progress".
     */
    const abort = (err) => {
      if (!settled) return fail(err);
      if (fileStream && !fileStream.destroyed) fileStream.destroy(err);
      return undefined;
    };

    bb.on('field', (name, value) => {
      if (Object.keys(fields).length < 12) fields[name] = value;
    });

    bb.on('file', (name, stream, info) => {
      if (settled) return stream.resume();
      settled = true;
      fileStream = stream;
      // Hand the still-flowing stream to the caller. It must be consumed or the
      // request will stall.
      return resolve({ fields, stream, info, busboy: bb });
    });

    bb.on('close', () => {
      if (!settled) fail(new AppError('Không tìm thấy file trong yêu cầu upload.', 400));
    });
    bb.on('error', (err) => fail(err));

    req.on('aborted', () => abort(new AppError('Upload đã bị huỷ.', 499)));
    // 'aborted' is deprecated in current Node; a close before req.complete is the
    // reliable signal that the client disconnected mid-request.
    req.on('close', () => {
      if (!req.complete) abort(new AppError('Upload đã bị huỷ.', 499));
    });

    req.pipe(bb);
  });
}

/**
 * Handles POST /api/videos/upload.
 * Returns the created video and its analysis result.
 */
async function handleUpload(req) {
  const { fields, stream, info } = await parseMultipart(req);

  const serverId = Number(fields.server_id);
  const declaredSize = Number(fields.size);

  const abortWith = (err) => {
    stream.unpipe?.();
    stream.resume(); // drain so the connection closes cleanly
    throw err;
  };

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) abortWith(new AppError('Không tìm thấy VPS.', 404));
  if (server.setup_state !== 'ready') {
    abortWith(new AppError('VPS này chưa được chuẩn bị xong. Hãy chạy kiểm tra VPS trước.', 400));
  }

  const extension = videoService.videoExtension(info.filename);
  if (!extension) {
    abortWith(
      new AppError(
        `File "${info.filename}" không phải định dạng video được hỗ trợ ` +
          `(mp4, mov, mkv, flv, m4v, ts, webm).`,
        400
      )
    );
  }

  try {
    await assertServerFree(server);
  } catch (err) {
    abortWith(err);
  }

  // Re-check the disk now, not just at preflight time: the browser could have
  // sat on the confirmation dialog while another video filled the disk.
  let check;
  try {
    check = await storage.preflight(server, declaredSize);
  } catch (err) {
    abortWith(err);
  }
  if (!check.allowed) abortWith(new AppError(check.message, 400, { preflight: check }));

  const video = videoService.create({
    serverId,
    originalName: info.filename,
    sizeBytes: declaredSize || 0,
    sourceType: 'upload',
    status: videoService.STATUS.UPLOADING,
  });

  const job = jobs.create({
    serverId,
    type: 'upload',
    entityType: 'video',
    entityId: video.id,
    step: 'Đang tải lên VPS…',
  });
  jobs.update(job.id, { status: 'running' });

  const partPath = videoService.tempPathFor(video.uuid);
  let bytesWritten = 0;

  try {
    // The SFTP connection is held open for the whole transfer. This is the one
    // documented exception to "open, execute, close" (spec section 37).
    await ssh.withSftp(server, async (sftp) => {
      const remote = sftp.createWriteStream(partPath, {
        flags: 'w',
        mode: 0o644,
        highWaterMark: SFTP_CHUNK_BYTES,
      });

      // Heartbeat: moves the job's updated_at while bytes flow, which is how a
      // genuinely-running upload is told apart from an abandoned one. Throttled
      // so a 2 GB transfer does not write thousands of rows.
      let lastBeat = Date.now();

      stream.on('data', (chunk) => {
        bytesWritten += chunk.length;

        if (Date.now() - lastBeat >= 2000) {
          lastBeat = Date.now();
          jobs.update(job.id, {
            progress_percent: declaredSize
              ? Math.min(99, Math.round((bytesWritten / declaredSize) * 100))
              : 0,
            step: declaredSize
              ? `Đang tải lên: ${formatBytes(bytesWritten)} / ${formatBytes(declaredSize)}`
              : `Đang tải lên: ${formatBytes(bytesWritten)}`,
          });
        }
      });

      // busboy enforces fileSize; this fires if the client lied about `size`.
      stream.on('limit', () => {
        remote.destroy(
          new AppError(
            `File vượt giới hạn ${config.storage.maxUploadGb} GB mỗi video.`,
            400
          )
        );
      });

      // pipeline propagates errors in both directions and destroys both streams,
      // so a dropped connection cannot leave a dangling SFTP handle.
      await pipeline(stream, remote);
    });

    if (bytesWritten === 0) {
      throw new AppError('Không nhận được dữ liệu nào từ file.', 400);
    }

    recordEgress(bytesWritten);

    // Only now does the file get its real name, so a partial transfer can never
    // be mistaken for a usable video (spec section 8).
    const renamed = await ssh.exec(
      server,
      `mv -f ${shellEscape(partPath)} ${shellEscape(video.remote_path)}`,
      { timeout: 60_000 }
    );
    if (renamed.code !== 0) {
      throw new AppError(
        `Không lưu được video trên VPS: ${(renamed.stderr || '').trim() || `exit ${renamed.code}`}`,
        400
      );
    }

    videoService.patch(video.id, { size_bytes: bytesWritten });
    jobs.update(job.id, { progress_percent: 90, step: 'Đang phân tích video…' });

    const { compliance } = await videoService.analyze(server, videoService.findById(video.id));

    jobs.update(job.id, {
      status: 'success',
      progress_percent: 100,
      step: compliance.compliant ? 'Hoàn tất' : 'Đã tải lên, cần chuẩn hoá',
    });

    db.prepare(
      `INSERT INTO activity_logs (type, message, entity_type, entity_id)
       VALUES ('video_uploaded', ?, 'video', ?)`
    ).run(
      `Đã tải lên video ${video.original_name} (${formatBytes(bytesWritten)})`,
      video.id
    );

    await storage.refresh(server).catch(() => {});

    return { video: videoService.findById(video.id), compliance, bytesWritten };
  } catch (err) {
    // Clean up the partial file so it does not silently consume disk
    // (spec sections 18, 39).
    await ssh
      .exec(server, `rm -f ${shellEscape(partPath)}`, { timeout: 20_000 })
      .catch((cleanupErr) => logger.error('Failed to remove partial upload', cleanupErr));

    const cancelled = err.status === 499 || /aborted|ECONNRESET|premature close/i.test(err.message || '');

    videoService.patch(video.id, {
      status: cancelled ? videoService.STATUS.CANCELLED : videoService.STATUS.ERROR,
      error_message: cancelled ? 'Upload đã bị huỷ.' : String(err.message).slice(0, 500),
    });
    jobs.update(job.id, {
      status: cancelled ? 'cancelled' : 'failed',
      error_message: cancelled ? 'Upload đã bị huỷ.' : err.message,
    });

    // Partial transfers still cost Render bandwidth, so count them.
    recordEgress(bytesWritten);

    logger.warn(
      `Upload of video ${video.id} ended after ${formatBytes(bytesWritten)}: ${err.message}`
    );
    throw err;
  }
}

module.exports = {
  handleUpload,
  egressThisMonth,
  recordEgress,
  assertServerFree,
  SFTP_CHUNK_BYTES,
  // Exported so the streaming behaviour can be tested without a VPS.
  parseMultipart,
};
