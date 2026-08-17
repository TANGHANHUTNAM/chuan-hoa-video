'use strict';

const express = require('express');
const config = require('../config');
const servers = require('../services/server.service');
const videoService = require('../services/video.service');
const storage = require('../services/storage.service');
const uploadService = require('../services/upload.service');
const importService = require('../services/import.service');
const jobs = require('../services/job.service');
const { isPositiveInt } = require('../utils/validators');
const { AppError } = require('../middleware/error-handler');
const { formatBytes, formatDuration } = require('../utils/format-bytes');

const router = express.Router();

function requireId(value, label) {
  if (!isPositiveInt(value)) throw new AppError(`${label} không hợp lệ.`, 400);
  return Number(value);
}

function serverForVideo(video) {
  return servers.findByIdOrThrow(video.server_id);
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

router.get('/videos', (req, res) => {
  const all = servers.list();
  const selectedId = req.query.server && isPositiveInt(req.query.server)
    ? Number(req.query.server)
    : all.length === 1
      ? all[0].id
      : null;

  const rows = selectedId ? videoService.listForServer(selectedId) : videoService.listAll();
  const selected = selectedId ? servers.findById(selectedId) : null;

  const unused = videoService.listUnused(selectedId);

  /**
   * How long normalising this video would take, worked out here rather than in
   * toView because it needs the VPS's core count.
   *
   * Waiting 40 minutes with no idea why is its own problem, separate from the bug
   * that made the wait pointless.
   */
  const coresById = new Map(all.map((s) => [s.id, s.cpu_cores]));
  const withEstimate = rows.map(videoService.toView).map((v) => {
    const source = rows.find((r) => r.id === v.id);
    const audioOnly =
      source &&
      !videoService.evaluateCompliance({
        codecVideo: source.codec_video,
        codecAudio: source.codec_audio,
        width: source.width,
        height: source.height,
        fps: source.fps,
        pixelFormat: null,
        hasAudio: source.has_audio === 1,
        maxKeyframeInterval: source.max_keyframe_interval,
      }).needsVideoReencode;

    const estimate = videoService.estimateNormalizeSeconds({
      durationSeconds: source ? source.duration_seconds : null,
      cpuCores: coresById.get(v.serverId),
      reencodeVideo: !audioOnly,
    });

    return {
      ...v,
      normalizeEstimate: estimate
        ? `${formatDuration(estimate.min)}–${formatDuration(estimate.max)}` +
          (audioOnly ? ' (chỉ sửa âm thanh, giữ nguyên hình)' : '')
        : null,
    };
  });

  res.render('videos/index', {
    title: 'Video',
    nav: 'videos',
    servers: all.map(servers.toView),
    selectedServerId: selectedId,
    disk: selected ? storage.fromCache(selected) : null,
    videos: withEstimate,
    egress: uploadService.egressThisMonth(),
    unusedCount: unused.count,
    unusedLabel: formatBytes(unused.totalBytes),
    notice: req.query.notice || null,
    // Shown so the user can copy a working rsync command with their real IP.
    videosDir: config.remote.videos,
    rsyncTarget: selected ? `${selected.username}@${selected.host}` : null,
  });
});

/**
 * Serves a cached thumbnail from local disk. Never touches SSH: the cache is
 * filled once when the video is analysed.
 */
router.get('/videos/:id/thumb', (req, res) => {
  const video = videoService.findByIdOrThrow(requireId(req.params.id, 'Video'));
  const file = videoService.thumbnailPath(video.uuid);

  if (!videoService.hasThumbnail(video)) {
    // 404 rather than an error page: the <img> simply shows nothing, and a
    // missing preview is not a failure worth interrupting the page for.
    return res.status(404).end();
  }

  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.sendFile(file);
});

/**
 * Picks up videos copied onto the VPS directly (scp/rsync) — the Làm mới button.
 *
 * This is the reliable path for large files: one hop instead of two, and rsync
 * can resume, which an HTTP upload cannot.
 */
router.post('/videos/scan', async (req, res) => {
  const server = servers.findByIdOrThrow(requireId(req.body.server_id, 'VPS'));
  const result = await videoService.scanAndAdopt(server);

  const parts = [];
  if (result.adopted.length) {
    parts.push(`Đã thêm ${result.adopted.length} video: ${result.adopted.map((a) => a.name).join(', ')}.`);
    const needsWork = result.adopted.filter((a) => !a.compliant);
    if (needsWork.length) {
      parts.push(`${needsWork.length} video cần chuẩn hoá cho Facebook.`);
    }
  }
  if (result.pending.length) {
    // Reported rather than hidden, so a file being copied does not look lost.
    parts.push(
      `${result.pending.length} file đang được copy dở, chưa nhận: ` +
        `${result.pending.map((p) => p.name).join(', ')}. Bấm Làm mới lại sau khi copy xong.`
    );
  }
  if (result.rejected.length) {
    parts.push(
      `${result.rejected.length} file bị bỏ qua: ` +
        result.rejected.map((r) => `${r.name} (${r.reason})`).join('; ')
    );
  }
  if (result.missing.length) {
    parts.push(`${result.missing.length} video không còn trên VPS, đã đánh dấu lỗi.`);
  }
  if (result.failed.length) {
    parts.push(
      `${result.failed.length} file không phân tích được: ` +
        result.failed.map((f) => f.name).join(', ')
    );
  }
  if (!parts.length) parts.push('Không có video mới trong thư mục trên VPS.');

  res.redirect(
    `/videos?server=${server.id}&notice=${encodeURIComponent(parts.join(' '))}`
  );
});

/** Reclaims disk by deleting every video no project references. */
router.post('/videos/cleanup-unused', async (req, res) => {
  const server = servers.findByIdOrThrow(requireId(req.body.server_id, 'VPS'));
  const results = await videoService.removeUnused(server);

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const freed = ok.reduce((sum, r) => sum + (r.bytes || 0), 0);

  const notice = ok.length
    ? `Đã xoá ${ok.length} video không dùng, giải phóng ${formatBytes(freed)}.` +
      (failed.length ? ` ${failed.length} video không xoá được.` : '')
    : 'Không có video nào được xoá.';

  res.redirect(`/videos?server=${server.id}&notice=${encodeURIComponent(notice)}`);
});

// ---------------------------------------------------------------------------
// Preflight, import, upload
// ---------------------------------------------------------------------------

/**
 * Checked before the browser starts sending bytes, so an upload that cannot fit
 * is refused up front rather than after a long transfer (spec section 17B).
 */
router.post('/api/videos/preflight', async (req, res) => {
  const server = servers.findByIdOrThrow(requireId(req.body.server_id, 'VPS'));
  const check = await storage.preflight(server, Number(req.body.size));

  res.json({
    allowed: check.allowed,
    reason: check.reason,
    message: check.message,
    usableFreeLabel: formatBytes(check.usableFreeBytes),
    availableLabel: formatBytes(check.availableBytes),
    reserveLabel: formatBytes(check.reserveBytes),
    level: check.level,
  });
});

/** Reads a link's headers from the VPS so we know the size before committing. */
router.post('/api/videos/probe-url', async (req, res) => {
  const server = servers.findByIdOrThrow(requireId(req.body.server_id, 'VPS'));

  try {
    const probe = await importService.probeUrl(server, req.body.url);
    const check = await storage.preflight(server, probe.sizeBytes);

    res.json({
      ok: true,
      provider: probe.provider,
      providerLabel: probe.label,
      note: probe.note,
      reliability: probe.reliability,
      filename: probe.filename,
      sizeBytes: probe.sizeBytes,
      sizeLabel: probe.sizeBytes ? formatBytes(probe.sizeBytes) : 'không rõ',
      allowed: check.allowed,
      message: check.allowed ? null : check.message,
    });
  } catch (err) {
    if (!err.expected) throw err;
    res.status(400).json({ ok: false, message: err.message });
  }
});

router.post('/api/videos/import', async (req, res) => {
  const server = servers.findByIdOrThrow(requireId(req.body.server_id, 'VPS'));
  const { video, job } = await videoService.startImport(server, {
    url: req.body.url,
    name: req.body.name,
  });
  res.json({ ok: true, videoId: video.id, jobId: job.id });
});

/**
 * Streams the request body straight to the VPS. Mounted without any body parser
 * in front of it, so nothing buffers (spec section 44).
 */
router.post('/api/videos/upload', async (req, res) => {
  try {
    const { video, compliance } = await uploadService.handleUpload(req);
    res.json({
      ok: true,
      videoId: video.id,
      status: video.status,
      compliant: compliance.compliant,
      notes: compliance.notes,
    });
  } catch (err) {
    if (!err.expected) throw err;
    res.status(err.status === 499 ? 499 : err.status || 400).json({
      ok: false,
      message: err.message,
      details: err.details || null,
    });
  }
});

// ---------------------------------------------------------------------------
// Per-video actions
// ---------------------------------------------------------------------------

router.post('/api/videos/:id/analyze', async (req, res) => {
  const video = videoService.findByIdOrThrow(requireId(req.params.id, 'Video'));
  const { compliance } = await videoService.analyze(serverForVideo(video), video);
  res.json({ ok: true, compliant: compliance.compliant, notes: compliance.notes });
});

/**
 * "Kiểm tra lại" — re-probes the file and recomputes the verdict.
 *
 * The API route above has existed all along with nothing in the UI calling it, so
 * a video whose stored verdict was wrong had no way back. That mattered: the
 * frame-size rule used to reject every vertical video, and the cached
 * needs_optimize survived the fix until something re-ran the analysis. This is also
 * the way out of a normalise that ended in error.
 */
router.post('/videos/:id/analyze', async (req, res) => {
  const video = videoService.findByIdOrThrow(requireId(req.params.id, 'Video'));
  const { compliance } = await videoService.analyze(serverForVideo(video), video);
  const notice = compliance.compliant
    ? 'Video đạt chuẩn Facebook, đã sẵn sàng phát live.'
    : `Video vẫn cần chuẩn hoá: ${compliance.notes[0] || ''}`;

  // Test the URL actually being built, not just req.body.next: the default already
  // carries ?server=, so checking only the override produced `?server=16?notice=`.
  const base = req.body.next || `/videos?server=${video.server_id}`;
  res.redirect(`${base}${base.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}`);
});

/**
 * Normalising happens on the user's own machine, not here.
 *
 * The VPS is the worst hardware in the system — 2 shared cores measured at 0.32-0.51x
 * realtime, competing for CPU with the live streams it exists to serve, so a 26-minute
 * video cost about an hour. The same file on the user's laptop took ten minutes. The
 * VPS-side encoder is therefore no longer offered: see /local ("Chuẩn hoá tại máy").
 *
 * The worker itself (video.service.buildNormalizeWorker) is kept and still covered by
 * tests, so re-exposing it is one route away if a video ever needs fixing without
 * being copied down first — but nothing in the UI points at it.
 */
router.post('/videos/:id/normalize', (req, res) => {
  const video = videoService.findByIdOrThrow(requireId(req.params.id, 'Video'));
  throw new AppError(
    `Chuẩn hoá giờ chạy trên máy của bạn, không chạy trên VPS nữa.\n\n` +
      `VPS chỉ có 2 core dùng chung: video 26 phút mất khoảng 1 giờ, và CPU đó đang phải ` +
      `phục vụ các buổi live. Cùng file đó trên máy bạn mất khoảng 10 phút.\n\n` +
      `Cách làm: copy video vào thư mục "video-can-chuan-hoa", mở mục ` +
      `"Chuẩn hoá tại máy", chọn độ phân giải rồi bấm. Xong thì copy file kết quả lên ` +
      `VPS và bấm "Làm mới" ở trang này.`,
    400,
    { videoId: video.id }
  );
});

router.post('/videos/:id/delete', async (req, res) => {
  const video = videoService.findByIdOrThrow(requireId(req.params.id, 'Video'));
  const serverId = video.server_id;
  await videoService.remove(serverForVideo(video), video.id);
  res.redirect(`/videos?server=${serverId}`);
});

/** Progress for whichever job is currently working on this video. */
router.get('/api/videos/:id/job', (req, res) => {
  const id = requireId(req.params.id, 'Video');
  const job = jobs.latestForEntity('video', id);
  res.json(job ? jobs.toJson(job) : { status: 'none' });
});

module.exports = router;
