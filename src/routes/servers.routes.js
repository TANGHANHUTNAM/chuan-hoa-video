'use strict';

const express = require('express');
const servers = require('../services/server.service');
const provision = require('../services/provision.service');
const storage = require('../services/storage.service');
const ssh = require('../services/ssh.service');
const jobs = require('../services/job.service');
const sheets = require('../services/sheets.service');
const { isPositiveInt } = require('../utils/validators');
const { AppError } = require('../middleware/error-handler');
const { formatBytes } = require('../utils/format-bytes');

const router = express.Router();

function serverId(req) {
  if (!isPositiveInt(req.params.id)) throw new AppError('Mã VPS không hợp lệ.', 400);
  return Number(req.params.id);
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/**
 * The first-run path. Sends the user wherever the next real step is, so a
 * half-finished setup is never a dead end.
 */
router.get('/setup', (req, res) => {
  const all = servers.list();

  if (all.length === 0) {
    return res.render('servers/new', {
      title: 'Kết nối VPS',
      nav: 'servers',
      onboarding: true,
      form: { port: 22, username: 'root', auth_type: 'password', install_key: true },
      error: null,
      // Only this render passes it: an empty catalogue plus a connected Sheet means
      // this could be a reinstall, and the restore offer belongs here rather than on
      // the dashboard the user cannot reach yet.
      sync: sheets.status(),
    });
  }

  const pending = all.find((s) => s.setup_state !== 'ready');
  if (pending) return res.redirect(`/servers/${pending.id}`);

  return res.redirect('/projects/new');
});

// ---------------------------------------------------------------------------
// List / create
// ---------------------------------------------------------------------------

router.get('/servers', (req, res) => {
  res.render('servers/index', {
    title: 'VPS',
    nav: 'servers',
    servers: servers.list().map(servers.toView),
  });
});

router.get('/servers/new', (req, res) => {
  res.render('servers/new', {
    title: 'Thêm VPS',
    nav: 'servers',
    onboarding: false,
    form: { port: 22, username: 'root', auth_type: 'password', install_key: true },
    error: null,
  });
});

router.post('/servers', (req, res) => {
  const onboarding = req.body.onboarding === '1';

  let server;
  try {
    server = servers.create(req.body);
  } catch (err) {
    if (!err.expected) throw err;
    // Re-render with what the user typed, minus the secret fields.
    return res.status(err.status || 400).render('servers/new', {
      title: onboarding ? 'Kết nối VPS' : 'Thêm VPS',
      nav: 'servers',
      onboarding,
      form: {
        name: req.body.name,
        host: req.body.host,
        port: req.body.port || 22,
        username: req.body.username || 'root',
        auth_type: req.body.auth_type || 'password',
        install_key: req.body.install_key !== '0',
      },
      error: err.message,
    });
  }

  // Provisioning starts immediately: the user pressed one button and should not
  // have to press another to make the VPS usable.
  provision.startProvision(server.id, { installKey: req.body.install_key !== '0' });
  res.redirect(`/servers/${server.id}`);
});

/**
 * Test Connection (spec section 13). Runs against whatever is in the form, so it
 * works before the server has been saved.
 */
router.post('/api/servers/test', async (req, res) => {
  // Validation and connection failures must come back in the same shape, so the
  // form can show either one the same way.
  try {
    const existing =
      req.body.id && isPositiveInt(req.body.id) ? servers.findById(req.body.id) : null;
    const { target } = servers.targetFrom(req.body, existing);

    const info = await ssh.testConnection(target);
    res.json({
      ok: true,
      fingerprint: info.fingerprint,
      osName: info.osName,
      ffmpegInstalled: Boolean(info.ffmpegPath),
      latencyMs: info.latencyMs,
      message: `Kết nối thành công tới ${target.username}@${target.host}:${target.port}`,
    });
  } catch (err) {
    if (!err.expected) throw err;
    res.status(400).json({ ok: false, message: err.message, details: err.details || null });
  }
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

router.get('/servers/:id', (req, res) => {
  const server = servers.findByIdOrThrow(serverId(req));
  const view = servers.toView(server);
  const job = jobs.latestForEntity('server', server.id);

  res.render('servers/detail', {
    title: view.name,
    nav: 'servers',
    server: view,
    job: job && !jobs.TERMINAL.has(job.status) ? job : null,
    lastJob: job || null,
    checkDefs: provision.CHECK_DEFS,
  });
});

/** Checklist as JSON, so the page can refresh itself while provisioning runs. */
router.get('/api/servers/:id/health', (req, res) => {
  const server = servers.findByIdOrThrow(serverId(req));
  const view = servers.toView(server);
  res.json({
    id: view.id,
    setupState: view.setupState,
    isReady: view.isReady,
    problemCount: view.problemCount,
    checks: view.checks,
    disk: {
      usedPercent: view.disk.usedPercent,
      totalLabel: formatBytes(view.disk.totalBytes),
      availableLabel: formatBytes(view.disk.availableBytes),
      usableLabel: formatBytes(view.disk.usableFreeBytes),
      level: view.disk.level,
    },
  });
});

router.post('/servers/:id/provision', (req, res) => {
  const id = serverId(req);
  servers.findByIdOrThrow(id);
  provision.startProvision(id, { installKey: req.body.install_key !== '0' });
  res.redirect(`/servers/${id}`);
});

/**
 * Targeted remedy for the RTMPS check: reinstalling is the only fix we can apply
 * for a build without TLS support.
 */
router.post('/servers/:id/reinstall-ffmpeg', (req, res) => {
  const id = serverId(req);
  servers.findByIdOrThrow(id);
  provision.startProvision(id, { installKey: false, reinstallFfmpeg: true });
  res.redirect(`/servers/${id}`);
});

router.post('/servers/:id/storage/refresh', async (req, res) => {
  const server = servers.findByIdOrThrow(serverId(req));
  await storage.refresh(server);
  res.redirect(`/servers/${server.id}`);
});

router.post('/servers/:id/delete', (req, res) => {
  servers.remove(serverId(req));
  res.redirect('/servers');
});

module.exports = router;
