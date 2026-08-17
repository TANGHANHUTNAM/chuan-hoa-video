'use strict';

const express = require('express');
const projects = require('../services/project.service');
const servers = require('../services/server.service');
const videoService = require('../services/video.service');
const live = require('../services/live.service');
const storage = require('../services/storage.service');
const rtmpsParser = require('../services/rtmps-parser');
const uploadService = require('../services/upload.service');
const { isPositiveInt } = require('../utils/validators');
const { AppError } = require('../middleware/error-handler');

const router = express.Router();

function requireId(value, label) {
  if (!isPositiveInt(value)) throw new AppError(`${label} không hợp lệ.`, 400);
  return Number(value);
}

/** Data the create-project wizard needs to render. */
function wizardData(selectedServerId) {
  const readyServers = servers.listReady();
  const serverId = selectedServerId && readyServers.some((s) => s.id === selectedServerId)
    ? selectedServerId
    : readyServers.length
      ? readyServers[0].id
      : null;
  const server = serverId ? servers.findById(serverId) : null;

  return {
    servers: readyServers.map(servers.toView),
    // With a single VPS the picker is pointless, so the wizard hides it.
    autoSelected: readyServers.length === 1,
    serverId,
    disk: server ? storage.fromCache(server) : null,
    videos: serverId
      ? videoService.listForServer(serverId).map(videoService.toView).filter((v) => !v.isBusy)
      : [],
    egress: uploadService.egressThisMonth(),
  };
}

// ---------------------------------------------------------------------------
// List & create
// ---------------------------------------------------------------------------

router.get('/projects', (req, res) => {
  res.render('projects/index', {
    title: 'Project',
    nav: 'projects',
    projects: projects.list().map(projects.toCard),
    hasReadyServer: servers.listReady().length > 0,
  });
});

router.get('/projects/new', (req, res) => {
  const selected = req.query.server && isPositiveInt(req.query.server)
    ? Number(req.query.server)
    : null;
  const data = wizardData(selected);

  // Cannot create anything without a working VPS, so send the user there first.
  if (!data.servers.length) return res.redirect('/setup');

  res.render('projects/new', {
    title: 'Tạo project',
    nav: 'projects',
    ...data,
    form: {},
    error: null,
  });
});

/**
 * Creates the project, its video link and every destination in one submit.
 * This is the whole point of the wizard: name it, pick a video, paste the
 * Facebook keys, done.
 */
router.post('/projects', (req, res) => {
  const serverId = requireId(req.body.server_id, 'VPS');
  const videoId = req.body.video_id && isPositiveInt(req.body.video_id)
    ? Number(req.body.video_id)
    : null;

  let project;
  try {
    project = projects.create({ serverId, videoId, name: req.body.name });
  } catch (err) {
    if (!err.expected) throw err;
    const data = wizardData(serverId);
    return res.status(err.status || 400).render('projects/new', {
      title: 'Tạo project',
      nav: 'projects',
      ...data,
      form: req.body,
      error: err.message,
    });
  }

  // Destinations are optional here; the detail page can add more later.
  const warnings = [];
  const failures = [];

  if (req.body.destinations_bulk && req.body.destinations_bulk.trim()) {
    try {
      const { rows, errors } = rtmpsParser.parseBulk(req.body.destinations_bulk);
      for (const row of rows) {
        const created = live.create(project.id, { name: row.name, url: row.url });
        warnings.push(...created.warnings);
      }
      failures.push(...errors.map((e) => `Dòng ${e.line}: ${e.message}`));
    } catch (err) {
      failures.push(err.message);
    }
  }

  // Individual rows: name[] paired with key[].
  const names = [].concat(req.body['dest_name'] || []);
  const keys = [].concat(req.body['dest_key'] || []);
  keys.forEach((key, i) => {
    if (!String(key || '').trim()) return;
    try {
      const created = live.create(project.id, { name: names[i], url: key });
      warnings.push(...created.warnings);
    } catch (err) {
      failures.push(err.message);
    }
  });

  const query = new URLSearchParams();
  if (failures.length) query.set('problems', failures.join(' | ').slice(0, 500));
  if (warnings.length) query.set('warnings', [...new Set(warnings)].join(' | ').slice(0, 400));

  res.redirect(`/projects/${project.id}${query.toString() ? `?${query}` : ''}`);
});

/** Live preview of what a pasted block would create, before saving. */
router.post('/api/destinations/parse', (req, res) => {
  try {
    const { rows, errors } = rtmpsParser.parseBulk(req.body.text || '');
    const { maskRtmpsUrl } = require('../utils/mask');
    res.json({
      ok: true,
      rows: rows.map((r) => ({
        name: r.name,
        masked: maskRtmpsUrl(r.url),
        host: r.host,
        warnings: r.warnings,
      })),
      errors,
    });
  } catch (err) {
    if (!err.expected) throw err;
    res.status(400).json({ ok: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

router.get('/projects/:id', (req, res) => {
  const project = projects.findByIdOrThrow(requireId(req.params.id, 'Project'));
  const view = projects.toView(project);

  res.render('projects/detail', {
    title: view.name,
    nav: 'projects',
    project: view,
    videos: videoService.listForServer(view.serverId).map(videoService.toView),
    problems: req.query.problems ? String(req.query.problems).split(' | ') : [],
    warnings: req.query.warnings ? String(req.query.warnings).split(' | ') : [],
    notice: req.query.notice || null,
  });
});

/** Polled by the detail page; reads real state from the VPS (spec section 29). */
router.get('/api/projects/:id/status', async (req, res) => {
  const id = requireId(req.params.id, 'Project');
  projects.findByIdOrThrow(id);

  // Throughput comes back from the same SSH round trip as the status, so it is
  // free to include. It is what distinguishes "FFmpeg is running" from "video is
  // actually reaching Facebook".
  const refreshed = await live.refreshProjectStatus(id);
  const throughput = new Map(
    refreshed.destinations.map((d) => [d.id, live.describeProgress(d.progress)])
  );

  const view = projects.toView(projects.findById(id));

  // Keyed by destination id, not an array: the client binds with paths like
  // "byId.8.tone", and an array would make "8" an index rather than an id.
  const byId = {};
  for (const d of view.destinations) {
    const flow = throughput.get(d.id) || null;
    byId[d.id] = {
      status: d.status,
      statusLabel: d.statusLabel,
      tone: d.tone,
      uptime: d.uptime || '',
      lastError: d.lastError || '',
      throughput: flow ? flow.label : '',
      behindLabel: flow && flow.behind ? 'không theo kịp thời gian thực' : '',
      // Counts down on a finite broadcast, so the page shows how much is left
      // rather than only how long it has been running.
      remaining: d.remaining ? `còn ${d.remaining}` : '',
    };
  }

  res.json({
    activeCount: view.activeCount,
    serverReachable: refreshed.serverReachable,
    byId,
  });
});

router.post('/projects/:id/delete', async (req, res) => {
  await projects.remove(requireId(req.params.id, 'Project'));
  res.redirect('/projects');
});

// ---------------------------------------------------------------------------
// Video selection
// ---------------------------------------------------------------------------

router.post('/projects/:id/change-video', async (req, res) => {
  const id = requireId(req.params.id, 'Project');
  const videoId = requireId(req.body.video_id, 'Video');
  // Default is to apply immediately, matching the spec's preferred option.
  const restartActive = req.body.apply !== 'later';

  const result = await projects.changeVideo(id, videoId, { restartActive });

  const failed = result.restarted.filter((r) => !r.ok);
  const notice = failed.length
    ? `Đã đổi video nhưng ${failed.length} điểm phát không khởi động lại được.`
    : result.pending
      ? `Đã lưu video mới. Sẽ áp dụng khi bạn khởi động lại ${result.pending} điểm phát.`
      : result.restarted.length
        ? `Đã đổi video và khởi động lại ${result.restarted.length} điểm phát.`
        : 'Đã đổi video cho project.';

  res.redirect(`/projects/${id}?notice=${encodeURIComponent(notice)}`);
});

// ---------------------------------------------------------------------------
// Playlist
// ---------------------------------------------------------------------------

/**
 * Applies a playlist change to whatever is already streaming.
 *
 * restart() rewrites the unit (and therefore the concat list) before restarting,
 * so this is the same mechanism as changing a single video — the user never edits
 * an FFmpeg command.
 */
async function applyPlaylistChange(projectId, applyNow) {
  const active = live
    .listForProject(projectId)
    .filter((d) => live.ACTIVE_STATES.has(d.status));

  if (!active.length) return '';
  if (!applyNow) {
    return ` Sẽ áp dụng khi bạn khởi động lại ${active.length} điểm phát.`;
  }

  const failures = [];
  for (const dest of active) {
    try {
      await live.restart(dest.id);
    } catch (err) {
      failures.push(`${dest.name}: ${err.message}`);
    }
  }

  return failures.length
    ? ` Nhưng ${failures.length} điểm phát không khởi động lại được: ${failures.join('; ')}`
    : ` Đã khởi động lại ${active.length} điểm phát.`;
}

router.post('/projects/:id/playlist/add', async (req, res) => {
  const id = requireId(req.params.id, 'Project');
  const videoId = requireId(req.body.video_id, 'Video');
  projects.addVideo(id, videoId);
  const extra = await applyPlaylistChange(id, req.body.apply === 'now');
  res.redirect(`/projects/${id}?notice=${encodeURIComponent('Đã thêm video vào danh sách phát.' + extra)}`);
});

router.post('/projects/:id/playlist/remove', async (req, res) => {
  const id = requireId(req.params.id, 'Project');
  const videoId = requireId(req.body.video_id, 'Video');

  const remaining = projects.listVideos(id).filter((v) => v.id !== videoId);
  // An empty playlist with units still running would leave FFmpeg pointing at a
  // file the project no longer claims, so stop everything first.
  if (!remaining.length) {
    const active = live.listForProject(id).filter((d) => live.ACTIVE_STATES.has(d.status));
    if (active.length) await live.stopAll(id);
    projects.removeVideo(id, videoId);
    return res.redirect(
      `/projects/${id}?notice=${encodeURIComponent(
        'Đã xoá video cuối khỏi danh sách phát, nên đã dừng toàn bộ live của project.'
      )}`
    );
  }

  projects.removeVideo(id, videoId);
  const extra = await applyPlaylistChange(id, req.body.apply === 'now');
  return res.redirect(
    `/projects/${id}?notice=${encodeURIComponent('Đã xoá video khỏi danh sách phát.' + extra)}`
  );
});

router.post('/projects/:id/playlist/move', async (req, res) => {
  const id = requireId(req.params.id, 'Project');
  const videoId = requireId(req.body.video_id, 'Video');
  const direction = req.body.direction === 'up' ? 'up' : 'down';

  projects.moveVideo(id, videoId, direction);
  const extra = await applyPlaylistChange(id, req.body.apply === 'now');
  res.redirect(`/projects/${id}?notice=${encodeURIComponent('Đã đổi thứ tự phát.' + extra)}`);
});

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

router.post('/projects/:id/lives', (req, res) => {
  const id = requireId(req.params.id, 'Project');
  projects.findByIdOrThrow(id);

  let notice = null;
  const problems = [];

  // Loop settings apply to every destination the form creates, including a bulk
  // paste: the user filled the form once and means it for all of them.
  const loop = {
    loopMode: req.body.loop_mode,
    loopCount: req.body.loop_count,
    loopHours: req.body.loop_hours,
  };

  if (req.body.bulk && req.body.bulk.trim()) {
    const { rows, errors } = rtmpsParser.parseBulk(req.body.bulk);
    for (const row of rows) {
      live.create(id, {
        name: row.name,
        url: row.url,
        autoRefresh: req.body.auto_refresh !== '0',
        ...loop,
      });
    }
    problems.push(...errors.map((e) => `Dòng ${e.line}: ${e.message}`));
    notice = `Đã thêm ${rows.length} điểm phát.`;
  } else {
    live.create(id, {
      name: req.body.name,
      url: req.body.key,
      autoRefresh: req.body.auto_refresh !== '0',
      ...loop,
    });
    notice = 'Đã thêm điểm phát.';
  }

  const query = new URLSearchParams();
  if (notice) query.set('notice', notice);
  if (problems.length) query.set('problems', problems.join(' | '));
  res.redirect(`/projects/${id}?${query}`);
});

router.post('/lives/:id/update', (req, res) => {
  const id = requireId(req.params.id, 'Điểm phát');
  const dest = live.findByIdOrThrow(id);
  live.update(id, {
    name: req.body.name,
    streamKey: req.body.key,
    autoRefresh: req.body.auto_refresh !== '0',
    loopMode: req.body.loop_mode,
    loopCount: req.body.loop_count,
    loopHours: req.body.loop_hours,
  });
  res.redirect(`/projects/${dest.project_id}?notice=${encodeURIComponent('Đã cập nhật điểm phát.')}`);
});

router.post('/lives/:id/delete', async (req, res) => {
  const id = requireId(req.params.id, 'Điểm phát');
  const dest = live.findByIdOrThrow(id);
  const projectId = dest.project_id;
  await live.remove(id);
  res.redirect(`/projects/${projectId}?notice=${encodeURIComponent('Đã xoá điểm phát.')}`);
});

// --- start / stop / restart -------------------------------------------------

function redirectBack(req, res, projectId, notice) {
  res.redirect(`/projects/${projectId}?notice=${encodeURIComponent(notice)}`);
}

router.post('/lives/:id/start', async (req, res) => {
  const id = requireId(req.params.id, 'Điểm phát');
  const dest = live.findByIdOrThrow(id);
  const result = await live.start(id);

  redirectBack(
    req,
    res,
    dest.project_id,
    result.problem
      ? `${result.problem.title}. ${result.problem.message}`
      : 'Đã bắt đầu live.'
  );
});

router.post('/lives/:id/stop', async (req, res) => {
  const id = requireId(req.params.id, 'Điểm phát');
  const dest = live.findByIdOrThrow(id);
  await live.stop(id);
  redirectBack(req, res, dest.project_id, 'Đã dừng live.');
});

router.post('/lives/:id/restart', async (req, res) => {
  const id = requireId(req.params.id, 'Điểm phát');
  const dest = live.findByIdOrThrow(id);
  await live.restart(id);
  redirectBack(req, res, dest.project_id, 'Đã khởi động lại live.');
});

router.post('/projects/:id/start-all', async (req, res) => {
  const id = requireId(req.params.id, 'Project');
  const results = await live.startAll(id);
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => r.ok === false);

  redirectBack(
    req,
    res,
    id,
    bad.length
      ? `Đã bắt đầu ${ok} điểm phát. ${bad.length} điểm phát lỗi: ` +
          bad.map((b) => b.name).join(', ')
      : `Đã bắt đầu ${ok} điểm phát.`
  );
});

router.post('/projects/:id/stop-all', async (req, res) => {
  const id = requireId(req.params.id, 'Project');
  const results = await live.stopAll(id);
  redirectBack(req, res, id, `Đã dừng ${results.filter((r) => r.ok).length} điểm phát.`);
});

// --- status & logs ---------------------------------------------------------

router.get('/api/lives/:id/status', async (req, res) => {
  const id = requireId(req.params.id, 'Điểm phát');
  const dest = live.findByIdOrThrow(id);
  await live.refreshProjectStatus(dest.project_id);
  res.json(live.toView(live.findById(id)));
});

router.get('/lives/:id/logs', async (req, res) => {
  const id = requireId(req.params.id, 'Điểm phát');
  const dest = live.findByIdOrThrow(id);
  const logs = await live.readLogs(id);
  const project = projects.toView(projects.findById(dest.project_id));

  res.render('projects/logs', {
    title: `Log · ${dest.name}`,
    nav: 'projects',
    project,
    destination: live.toView(dest),
    logs,
  });
});

module.exports = router;
