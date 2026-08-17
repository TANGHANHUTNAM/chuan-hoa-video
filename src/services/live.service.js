'use strict';

const db = require('../db');
const config = require('../config');
const ssh = require('./ssh.service');
const ffmpeg = require('./ffmpeg.service');
const errorDecoder = require('./error-decoder');
const rtmpsParser = require('./rtmps-parser');
// Required lazily inside assertStartable to avoid a require cycle:
// project.service already requires live.service.
let projectService = null;
const { encrypt, decrypt } = require('./crypto.service');
const { shellEscape } = require('../utils/shell-escape');
const { maskSecrets, maskRtmpsUrl, keyLast4 } = require('../utils/mask');
const { cleanName, isPositiveInt } = require('../utils/validators');
const { formatDuration, parseTimestamp } = require('../utils/format-bytes');
const { AppError } = require('../middleware/error-handler');
const logger = require('../utils/logger');

/**
 * Start/stop/restart and status for Facebook Live destinations.
 *
 * The database is only ever a cache: real status always comes from
 * `systemctl is-active` on the VPS (spec section 29).
 */

const ACTIVE_STATES = new Set(['live', 'starting', 'refreshing']);

function findById(id) {
  return db.prepare('SELECT * FROM live_destinations WHERE id = ?').get(id);
}

function findByIdOrThrow(id) {
  const dest = findById(id);
  if (!dest) throw new AppError('Không tìm thấy điểm phát.', 404);
  return dest;
}

function listForProject(projectId) {
  return db
    .prepare('SELECT * FROM live_destinations WHERE project_id = ? ORDER BY id')
    .all(projectId);
}

/** Loads a destination together with its project, video and server. */
function loadContext(destinationId) {
  const row = db
    .prepare(
      `SELECT d.*, p.name AS project_name, p.server_id, p.video_id
         FROM live_destinations d
         JOIN projects p ON p.id = d.project_id
        WHERE d.id = ?`
    )
    .get(destinationId);

  if (!row) throw new AppError('Không tìm thấy điểm phát.', 404);

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(row.server_id);

  // The playlist is the source of truth for what plays; `video` is just its first
  // entry, kept for the single-video messages and unit form.
  const videos = db
    .prepare(
      `SELECT v.* FROM project_videos pv
         JOIN videos v ON v.id = pv.video_id
        WHERE pv.project_id = ?
        ORDER BY pv.position, pv.id`
    )
    .all(row.project_id);

  return { destination: row, server, videos, video: videos[0] || null };
}

function patch(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return findById(id);
  db.prepare(
    `UPDATE live_destinations SET ${keys.map((k) => `${k} = ?`).join(', ')},
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...keys.map((k) => fields[k]), id);
  return findById(id);
}

function logActivity(type, message, id) {
  db.prepare(
    `INSERT INTO activity_logs (type, message, entity_type, entity_id)
     VALUES (?, ?, 'live_destination', ?)`
  ).run(type, maskSecrets(message), id);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Creates a destination from whatever the user pasted (spec section 24). */
function create(
  projectId,
  { name, url, streamKey, serverUrl, autoRefresh = true, loopMode, loopCount, loopHours }
) {
  if (!isPositiveInt(projectId)) throw new AppError('Project không hợp lệ.', 400);

  const parsed = url && !streamKey
    ? rtmpsParser.parseStreamTarget(url)
    : rtmpsParser.parseStreamTarget(streamKey || url, serverUrl);

  const loop = normalizeLoop({ loopMode, loopCount, loopHours });

  const info = db
    .prepare(
      `INSERT INTO live_destinations
         (project_id, name, encrypted_rtmps_url, status, key_last4,
          auto_refresh_enabled, runtime_max_seconds, loop_mode, loop_count, loop_hours)
       VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      projectId,
      cleanName(name, 60) || 'Điểm phát Facebook',
      encrypt(parsed.url),
      keyLast4(parsed.url),
      autoRefresh ? 1 : 0,
      config.facebook.defaultRuntimeMaxSeconds,
      loop.loop_mode,
      loop.loop_count,
      loop.loop_hours
    );

  const destination = findById(info.lastInsertRowid);
  // systemd_unit is derived, but storing it makes cleanup possible even if the
  // naming scheme ever changes.
  patch(destination.id, { systemd_unit: `${ffmpeg.unitName(destination.id)}.service` });

  logActivity('destination_created', `Đã thêm điểm phát ${destination.name}`, destination.id);
  return { destination: findById(destination.id), warnings: parsed.warnings };
}

function update(destinationId, { name, url, streamKey, serverUrl, autoRefresh, loopMode, loopCount, loopHours }) {
  const existing = findByIdOrThrow(destinationId);
  const fields = {};

  if (name != null) fields.name = cleanName(name, 60) || existing.name;
  if (autoRefresh != null) fields.auto_refresh_enabled = autoRefresh ? 1 : 0;
  if (loopMode != null) Object.assign(fields, normalizeLoop({ loopMode, loopCount, loopHours }));

  let warnings = [];
  if ((url && url.trim()) || (streamKey && streamKey.trim())) {
    const parsed = url && !streamKey
      ? rtmpsParser.parseStreamTarget(url)
      : rtmpsParser.parseStreamTarget(streamKey || url, serverUrl);
    fields.encrypted_rtmps_url = encrypt(parsed.url);
    fields.key_last4 = keyLast4(parsed.url);
    warnings = parsed.warnings;
  }

  patch(destinationId, fields);
  return { destination: findById(destinationId), warnings };
}

// ---------------------------------------------------------------------------
// How long to keep playing
// ---------------------------------------------------------------------------

const LOOP_MODES = new Set(['infinite', 'count', 'hours']);

/**
 * Validates the loop settings from a form into database columns.
 *
 * Stored as intent (3 loops) rather than as a computed length, because the length
 * depends on the playlist, and the playlist can change between broadcasts. Turning
 * intent into seconds happens at start time.
 */
function normalizeLoop({ loopMode, loopCount, loopHours } = {}) {
  const mode = LOOP_MODES.has(loopMode) ? loopMode : 'infinite';

  if (mode === 'count') {
    const n = Math.round(Number(loopCount));
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      throw new AppError('Số vòng lặp phải là số từ 1 đến 500.', 400);
    }
    return { loop_mode: 'count', loop_count: n, loop_hours: null };
  }

  if (mode === 'hours') {
    const h = Number(loopHours);
    if (!Number.isFinite(h) || h < 0.1 || h > 720) {
      throw new AppError('Số giờ phải từ 0,1 đến 720 (30 ngày).', 400);
    }
    return { loop_mode: 'hours', loop_count: null, loop_hours: Math.round(h * 100) / 100 };
  }

  return { loop_mode: 'infinite', loop_count: null, loop_hours: null };
}

/** Total seconds this broadcast should run, or null for "until I press Stop". */
function plannedTotalSeconds(destination, videos = []) {
  if (destination.loop_mode === 'hours' && destination.loop_hours > 0) {
    return Math.round(destination.loop_hours * 3600);
  }

  if (destination.loop_mode === 'count' && destination.loop_count > 0) {
    const one = videos.reduce((sum, v) => sum + (Number(v.duration_seconds) || 0), 0);
    if (!one) {
      // Without a duration there is no way to know when N loops have passed, and
      // guessing would either cut the broadcast short or overrun it.
      throw new AppError(
        'Chưa biết độ dài video nên không tính được số vòng lặp. Hãy đợi app phân tích ' +
          'xong video (hoặc bấm Phân tích lại), hoặc chọn "Tự dừng sau … giờ" thay vì số vòng.',
        400
      );
    }
    return Math.round(one * destination.loop_count);
  }

  return null;
}

/** Human summary of the loop setting, for the UI and the Sheet. */
function loopLabel(destination, videos = []) {
  if (destination.loop_mode === 'count') {
    const one = videos.reduce((sum, v) => sum + (Number(v.duration_seconds) || 0), 0);
    const hours = one ? Math.round(((one * destination.loop_count) / 3600) * 10) / 10 : null;
    return `${destination.loop_count} vòng` + (hours ? ` (~${hours} giờ)` : '');
  }
  if (destination.loop_mode === 'hours') {
    return `dừng sau ${destination.loop_hours} giờ`;
  }
  return 'lặp mãi';
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

/** Everything that must be true before a start can possibly work (spec section 25). */
async function assertStartable({ destination, server, video, videos = [] }) {
  if (!server) throw new AppError('Project này chưa gắn với VPS nào.', 400);
  if (server.setup_state !== 'ready') {
    throw new AppError(
      `VPS "${server.name}" chưa được chuẩn bị xong. Hãy mở trang VPS và bấm "Kiểm tra lại".`,
      400
    );
  }
  if (server.ffmpeg_has_rtmps === 0) {
    throw new AppError(
      `FFmpeg trên VPS "${server.name}" không hỗ trợ RTMPS nên không phát được lên Facebook. ` +
        `Hãy vào trang VPS và bấm "Cài lại FFmpeg".`,
      400
    );
  }
  const playlist = videos.length ? videos : video ? [video] : [];

  if (!playlist.length) {
    throw new AppError('Project chưa chọn video. Hãy chọn video trước khi phát.', 400);
  }

  const notReady = playlist.filter((v) => v.status !== 'ready');
  if (notReady.length) {
    const first = notReady[0];
    throw new AppError(
      first.status === 'needs_optimize'
        ? `Video "${first.original_name}" chưa được chuẩn hoá cho Facebook. ` +
          `Hãy chuẩn hoá nó ở mục "Chuẩn hoá tại máy" (trên máy bạn, nhanh hơn VPS ` +
          `khoảng 6 lần), rồi copy file kết quả lên VPS và bấm "Làm mới".`
        : `Video "${first.original_name}" đang ở trạng thái "${first.status}" nên chưa phát được.`,
      400
    );
  }

  if (!destination.encrypted_rtmps_url) {
    throw new AppError('Điểm phát này chưa có Stream key.', 400);
  }

  // Joining several files with -c copy only works if they share codec,
  // resolution and frame rate. Checked before starting, because otherwise the
  // stream plays the first video then breaks up at the join.
  if (playlist.length > 1) {
    if (!projectService) projectService = require('./project.service');
    projectService.assertPlaylistCompatible(destination.project_id);
  }

  // Every file must still be there: one may have been deleted on the VPS
  // directly. Checked in a single command rather than one round trip per video.
  const check = playlist
    .map((v) => `test -f ${shellEscape(v.remote_path)} && echo "${v.id}:yes" || echo "${v.id}:no"`)
    .join('; ');

  const exists = await ssh.exec(server, check, { timeout: 30_000 });
  const missing = playlist.filter(
    (v) => !new RegExp(`^${v.id}:yes$`, 'm').test(exists.stdout || '')
  );

  if (missing.length) {
    for (const v of missing) {
      db.prepare(
        `UPDATE videos SET status = 'error', error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run('Không còn tìm thấy file video trên VPS.', v.id);
    }
    throw new AppError(
      `Không còn tìm thấy file trên VPS: ${missing.map((v) => v.original_name).join(', ')}. ` +
        `Hãy chọn hoặc tải lên video khác.`,
      400
    );
  }
}

/**
 * Writes the concat list when needed and returns what buildUnitFile should use.
 * A single video skips the playlist file entirely.
 */
async function prepareInput(server, destination, videos) {
  if (videos.length <= 1) {
    return { videoPath: videos[0].remote_path, playlistPath: null };
  }

  const playlistPath = ffmpeg.playlistFilePath(destination.project_id);
  await ssh.writeRemoteFile(
    server,
    playlistPath,
    ffmpeg.buildPlaylistFile(videos.map((v) => v.remote_path)),
    { mode: '644', privileged: true }
  );
  return { videoPath: null, playlistPath };
}

// ---------------------------------------------------------------------------
// Start / stop / restart
// ---------------------------------------------------------------------------

/** Writes the env file and unit file, then enables and starts the unit. */
async function start(destinationId) {
  const ctx = loadContext(destinationId);
  const { destination, server, videos } = ctx;

  await assertStartable(ctx);

  const unit = ffmpeg.unitName(destination.id);
  const rtmpsUrl = decrypt(destination.encrypted_rtmps_url);
  const input = await prepareInput(server, destination, videos);

  // Computed from the playlist as it is right now, which is why it is not stored
  // as configuration: three loops of a playlist the user edited yesterday is a
  // different number of hours today.
  const totalSeconds = plannedTotalSeconds(destination, videos);

  const built = ffmpeg.buildUnitFile({
    destinationId: destination.id,
    ...input,
    projectName: destination.project_name,
    autoRefresh: destination.auto_refresh_enabled === 1,
    runtimeMaxSeconds: destination.runtime_max_seconds,
    totalSeconds,
  });

  // A fresh start must not inherit the previous session's numbers.
  patch(destination.id, {
    status: 'starting',
    last_error: null,
    last_speed: null,
    last_bitrate_kbps: null,
    last_out_time_us: null,
    last_progress_at: null,
    planned_end_at: null,
  });

  try {
    // Secret first, in a root-only file, so the unit never has to inline it.
    await ssh.writeRemoteFile(server, ffmpeg.envFilePath(destination.id), ffmpeg.buildEnvFile(rtmpsUrl), {
      mode: '600',
      privileged: true,
    });
    await ssh.writeRemoteFile(server, built.path, built.content, {
      mode: '644',
      privileged: true,
    });

    const result = await ssh.execPrivileged(
      server,
      `systemctl daemon-reload && ` +
        `systemctl reset-failed ${shellEscape(unit)} 2>/dev/null; ` +
        `systemctl enable --now ${shellEscape(unit)}`,
      { timeout: 60_000 }
    );

    if (result.code !== 0) {
      throw new AppError(
        `Không khởi động được điểm phát: ` +
          `${maskSecrets((result.stderr || '').trim()).slice(0, 200) || `exit ${result.code}`}`,
        400
      );
    }

    patch(destination.id, {
      status: 'live',
      started_at: new Date().toISOString(),
      stopped_at: null,
      last_error: null,
      // Recorded even when FFmpeg ends itself, so the app can tell a planned finish
      // from a crash — otherwise the watcher would report the completion as an
      // incident and try to "recover" a broadcast that simply finished.
      planned_end_at: totalSeconds
        ? new Date(Date.now() + totalSeconds * 1000).toISOString()
        : null,
    });
    logActivity(
      'live_started',
      `Bắt đầu live: ${destination.name} (${loopLabel(destination, videos)})`,
      destination.id
    );

    // FFmpeg fails a few seconds in when the stream key is wrong, which is long
    // after systemctl has already returned success. Look at the journal so the
    // user learns the real reason instead of seeing a green light that dies.
    const early = await inspectEarlyFailure(server, destination.id);
    if (early) {
      patch(destination.id, { status: 'error', last_error: early.title });
      logActivity('live_failed', `Live lỗi: ${destination.name} — ${early.title}`, destination.id);
      return { status: 'error', problem: early };
    }

    return { status: 'live', problem: null };
  } catch (err) {
    patch(destination.id, {
      status: 'error',
      last_error: maskSecrets(err.message).slice(0, 300),
    });
    logActivity('live_failed', `Không phát được: ${destination.name}`, destination.id);
    throw err;
  }
}

/**
 * Waits briefly and reports a decoded problem if the unit already died.
 * Deliberately short: this runs inside the Start request.
 */
async function inspectEarlyFailure(server, destinationId, waitMs = 4000) {
  const unit = ffmpeg.unitName(destinationId);
  await new Promise((r) => setTimeout(r, waitMs));

  const result = await ssh.execPrivileged(
    server,
    `systemctl is-active ${shellEscape(unit)} 2>/dev/null || true; ` +
      `echo '---LOG---'; ` +
      `journalctl -u ${shellEscape(unit)} -n 30 --no-pager 2>/dev/null || true`,
    { timeout: 30_000 }
  );

  const [stateRaw = '', logRaw = ''] = String(result.stdout).split('---LOG---');
  const state = ffmpeg.mapSystemdState(stateRaw.trim().split('\n').pop());

  if (state === 'live' || state === 'starting') return null;

  const decoded = errorDecoder.decode(logRaw);
  if (decoded) return decoded;

  return {
    title: 'Điểm phát dừng ngay sau khi bắt đầu',
    message: 'Xem log bên dưới để biết nguyên nhân.',
    action: 'logs',
    evidence: maskSecrets(logRaw).trim().split('\n').slice(-4).join('\n').slice(0, 300),
  };
}

async function stop(destinationId) {
  const { destination, server } = loadContext(destinationId);
  const unit = ffmpeg.unitName(destination.id);

  // `disable` as well as `stop`, otherwise the unit would come back on reboot.
  await ssh.execPrivileged(
    server,
    `systemctl disable --now ${shellEscape(unit)} 2>/dev/null || ` +
      `systemctl stop ${shellEscape(unit)} || true`,
    { timeout: 60_000 }
  );

  patch(destination.id, {
    status: 'stopped',
    stopped_at: new Date().toISOString(),
    last_error: null,
    // Clear the throughput sample here rather than leaving it to the watcher:
    // once stopped, the watcher skips this destination entirely, so stale numbers
    // would sit on the page looking like a live stream.
    last_speed: null,
    last_bitrate_kbps: null,
    last_out_time_us: null,
    last_progress_at: null,
    // Otherwise a stopped-then-restarted destination would inherit yesterday's
    // deadline and the watcher would end the new broadcast immediately.
    planned_end_at: null,
  });
  logActivity('live_stopped', `Dừng live: ${destination.name}`, destination.id);
  return { status: 'stopped' };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.preserveDeadline]
 *   Keep the finish time this broadcast already had, and give FFmpeg only the time
 *   REMAINING rather than the full length. The watcher passes this when recovering
 *   a stall: without it, one hiccup at hour 5 of a 6-hour broadcast would restart
 *   the 6-hour clock and run to hour 11. A restart the user asked for is a new
 *   broadcast, so it does reset.
 */
async function restart(destinationId, { preserveDeadline = false } = {}) {
  const ctx = loadContext(destinationId);
  const { destination, server } = ctx;

  // Rewrite the unit first: a restart is also how a changed video or a reordered
  // playlist takes effect (spec section 32).
  await assertStartable(ctx);

  const input = await prepareInput(server, destination, ctx.videos);

  let totalSeconds = null;
  let plannedEndAt = null;

  if (preserveDeadline && destination.planned_end_at) {
    const end = parseTimestamp(destination.planned_end_at);
    const remaining = end ? Math.round((end.getTime() - Date.now()) / 1000) : 0;
    if (remaining <= 0) {
      // Nothing left to play. Finishing is the correct outcome, not restarting.
      return finishPlanned(destinationId, 'Đã phát xong trước khi kịp khởi động lại.');
    }
    totalSeconds = remaining;
    plannedEndAt = destination.planned_end_at;
  } else {
    totalSeconds = plannedTotalSeconds(destination, ctx.videos);
    plannedEndAt = totalSeconds
      ? new Date(Date.now() + totalSeconds * 1000).toISOString()
      : null;
  }

  const built = ffmpeg.buildUnitFile({
    destinationId: destination.id,
    ...input,
    projectName: destination.project_name,
    autoRefresh: destination.auto_refresh_enabled === 1,
    runtimeMaxSeconds: destination.runtime_max_seconds,
    totalSeconds,
  });

  await ssh.writeRemoteFile(
    server,
    ffmpeg.envFilePath(destination.id),
    ffmpeg.buildEnvFile(decrypt(destination.encrypted_rtmps_url)),
    { mode: '600', privileged: true }
  );
  await ssh.writeRemoteFile(server, built.path, built.content, { mode: '644', privileged: true });

  patch(destination.id, {
    status: 'starting',
    restart_count: (destination.restart_count || 0) + 1,
  });

  const result = await ssh.execPrivileged(
    server,
    `systemctl daemon-reload && systemctl reset-failed ${shellEscape(ffmpeg.unitName(destination.id))} 2>/dev/null; ` +
      `systemctl restart ${shellEscape(ffmpeg.unitName(destination.id))}`,
    { timeout: 60_000 }
  );

  if (result.code !== 0) {
    patch(destination.id, {
      status: 'error',
      last_error: maskSecrets((result.stderr || '').trim()).slice(0, 300),
    });
    throw new AppError(
      `Không khởi động lại được: ${maskSecrets((result.stderr || '').trim()).slice(0, 200)}`,
      400
    );
  }

  patch(destination.id, {
    status: 'live',
    started_at: new Date().toISOString(),
    planned_end_at: plannedEndAt,
  });
  logActivity('live_restarted', `Khởi động lại live: ${destination.name}`, destination.id);
  return { status: 'live' };
}

/**
 * Ends a broadcast that reached the length the user asked for.
 *
 * Separate from stop() only in what it writes to the history: a planned finish is
 * not an incident, and must not read like one on the History page.
 */
async function finishPlanned(destinationId, reason) {
  const destination = findByIdOrThrow(destinationId);
  const label = loopLabel(destination);
  await stop(destinationId);
  logActivity(
    'live_finished',
    `Đã phát xong (${label}): ${destination.name}. ${reason || ''}`.trim(),
    destinationId
  );
  return { status: 'finished' };
}

/** Removes the unit and its secret file, then the row (spec section 28). */
async function remove(destinationId) {
  const { destination, server } = loadContext(destinationId);
  const unit = ffmpeg.unitName(destination.id);

  if (server) {
    await ssh
      .execPrivileged(
        server,
        `systemctl disable --now ${shellEscape(unit)} 2>/dev/null || true; ` +
          `rm -f ${shellEscape(ffmpeg.unitFilePath(destination.id))} ` +
          `${shellEscape(ffmpeg.envFilePath(destination.id))}; ` +
          `systemctl daemon-reload || true`,
        { timeout: 60_000 }
      )
      .catch((err) => logger.warn(`Cleanup for destination ${destinationId} failed: ${err.message}`));
  }

  db.prepare('DELETE FROM live_destinations WHERE id = ?').run(destinationId);
  logActivity('destination_deleted', `Đã xoá điểm phát ${destination.name}`, destinationId);
  return true;
}

// ---------------------------------------------------------------------------
// Status and logs
// ---------------------------------------------------------------------------

/**
 * Reads the true state of every destination in a project and reconciles the
 * database cache with it.
 *
 * Status and throughput are collected in ONE SSH round trip. Asking per
 * destination would open a fresh connection each time, which for a project with
 * ten fanpages polled every ten seconds would be a lot of handshakes for no
 * reason.
 *
 * Returns { serverReachable, destinations: [{ id, status, previous, changed,
 * progress }] }. Stall detection is deliberately NOT done here — that belongs to
 * the watcher, which owns the history needed to judge it.
 */
async function refreshProjectStatus(projectId) {
  const destinations = listForProject(projectId);
  if (!destinations.length) return { serverReachable: true, destinations: [] };

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const server = project ? db.prepare('SELECT * FROM servers WHERE id = ?').get(project.server_id) : null;

  const unchanged = (extra = {}) => ({
    serverReachable: true,
    ...extra,
    destinations: destinations.map((d) => ({
      id: d.id,
      status: d.status,
      previous: d.status,
      changed: false,
      progress: null,
    })),
  });

  if (!server) return unchanged();

  // Markers rather than one key=value per line, because the progress payload is
  // itself multi-line.
  const command = destinations
    .map((d) => {
      const unit = shellEscape(ffmpeg.unitName(d.id));
      const progress = shellEscape(ffmpeg.progressFilePath(d.id));
      return (
        `echo '---S:${d.id}---'; systemctl is-active ${unit} 2>/dev/null || true; ` +
        `echo '---P:${d.id}---'; tail -n 24 ${progress} 2>/dev/null || true`
      );
    })
    .join('; ');

  let output = '';
  try {
    const result = await ssh.exec(server, command, { timeout: 45_000 });
    output = result.stdout || '';
  } catch (err) {
    // One failure means the whole VPS is unreachable, not that ten destinations
    // each broke. The caller reports it once at server level.
    logger.warn(`Status refresh for project ${projectId} failed: ${err.message}`);
    return { ...unchanged({ serverReachable: false }), serverReachable: false };
  }

  const states = new Map();
  const progresses = new Map();

  // Split on the markers, keeping track of which section we are in.
  const sections = output.split(/---([SP]):(\d+)---/);
  for (let i = 1; i < sections.length; i += 3) {
    const kind = sections[i];
    const id = Number(sections[i + 1]);
    const body = sections[i + 2] || '';
    if (kind === 'S') states.set(id, ffmpeg.mapSystemdState(body.trim().split('\n').pop()));
    else progresses.set(id, ffmpeg.parseProgressFields(body));
  }

  const out = [];
  for (const dest of destinations) {
    const actual = states.get(dest.id) || 'unknown';
    const changed = actual !== dest.status;

    if (changed) {
      const fields = { status: actual, last_status_at: new Date().toISOString() };
      // Preserve started_at across an auto-refresh so the uptime shown to the
      // user reflects the whole session, not the latest recycle.
      if (actual === 'stopped' && ACTIVE_STATES.has(dest.status)) {
        fields.stopped_at = new Date().toISOString();
      }
      patch(dest.id, fields);
    }

    out.push({
      id: dest.id,
      status: actual,
      previous: dest.status,
      changed,
      progress: progresses.get(dest.id) || null,
    });
  }

  return { serverReachable: true, destinations: out };
}

/** Reads one destination's throughput sample on its own. */
async function readProgress(destinationId) {
  const { destination, server } = loadContext(destinationId);
  if (!server) return null;

  const result = await ssh.exec(
    server,
    `tail -n 24 ${shellEscape(ffmpeg.progressFilePath(destination.id))} 2>/dev/null || true`,
    { timeout: 20_000 }
  );
  return ffmpeg.parseProgressFields(result.stdout);
}

/**
 * Human-readable throughput for the UI, plus whether FFmpeg is keeping up with
 * real time. Falling behind means the VPS cannot sustain the stream.
 */
function describeProgress(progress) {
  if (!progress || progress.outTimeUs == null) return null;

  const parts = [];
  if (progress.speed != null) parts.push(`${progress.speed.toFixed(2)}x`);
  if (progress.bitrateKbps != null) parts.push(`${Math.round(progress.bitrateKbps)} kbps`);

  return {
    label: parts.join(' · '),
    speed: progress.speed,
    bitrateKbps: progress.bitrateKbps,
    outTimeUs: progress.outTimeUs,
    behind: progress.speed != null && progress.speed < config.watcher.minSpeed,
  };
}

/** Last 100 journal lines, with stream keys masked (spec section 30). */
async function readLogs(destinationId, lines = 100) {
  const { destination, server } = loadContext(destinationId);
  if (!server) throw new AppError('Không tìm thấy VPS của điểm phát này.', 404);

  const count = Math.min(300, Math.max(20, Number(lines) || 100));
  const unit = ffmpeg.unitName(destination.id);

  const result = await ssh.execPrivileged(
    server,
    `journalctl -u ${shellEscape(unit)} -n ${count} --no-pager 2>/dev/null || true`,
    { timeout: 45_000 }
  );

  const raw = result.stdout || '';
  return {
    // Masking happens here, not in the view: the raw text must never reach the
    // browser at all.
    text: maskSecrets(raw).trim() || 'Chưa có log nào cho điểm phát này.',
    problem: errorDecoder.decode(raw),
    lines: count,
  };
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/** Start All / Stop All (spec section 36). Reports per-destination outcomes. */
async function startAll(projectId) {
  const results = [];
  for (const dest of listForProject(projectId)) {
    if (ACTIVE_STATES.has(dest.status)) {
      results.push({ id: dest.id, name: dest.name, skipped: true });
      continue;
    }
    try {
      const outcome = await start(dest.id);
      results.push({ id: dest.id, name: dest.name, ok: outcome.status === 'live', problem: outcome.problem });
    } catch (err) {
      results.push({ id: dest.id, name: dest.name, ok: false, error: err.message });
    }
  }
  return results;
}

async function stopAll(projectId) {
  const results = [];
  for (const dest of listForProject(projectId)) {
    try {
      await stop(dest.id);
      results.push({ id: dest.id, name: dest.name, ok: true });
    } catch (err) {
      results.push({ id: dest.id, name: dest.name, ok: false, error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

function toView(destination) {
  const status = destination.status || 'stopped';
  let uptime = null;

  if (ACTIVE_STATES.has(status) && destination.started_at) {
    const startedAt = parseTimestamp(destination.started_at);
    const seconds = startedAt ? (Date.now() - startedAt.getTime()) / 1000 : 0;
    if (seconds > 0) uptime = formatDuration(seconds);
  }

  return {
    id: destination.id,
    projectId: destination.project_id,
    name: destination.name,
    status,
    statusLabel: ffmpeg.STATUS_LABELS[status] || status,
    tone: ffmpeg.STATUS_TONES[status] || 'idle',
    isActive: ACTIVE_STATES.has(status),
    maskedUrl: destination.encrypted_rtmps_url
      ? maskRtmpsUrl(decrypt(destination.encrypted_rtmps_url))
      : null,
    keyLast4: destination.key_last4,
    autoRefresh: destination.auto_refresh_enabled === 1,
    refreshHours: Math.round((destination.runtime_max_seconds / 3600) * 10) / 10,
    restartCount: destination.restart_count || 0,
    // Restarts the watcher performed after detecting a stall, kept separate from
    // restarts the user asked for.
    autoRecover: destination.auto_recover_enabled === 1,
    recoverCount: destination.recover_count || 0,
    // Last throughput the watcher saw. Present only while up, so its absence on
    // a live-looking row means the watcher has not sampled it yet.
    throughput: describeProgress({
      outTimeUs: destination.last_out_time_us,
      speed: destination.last_speed,
      bitrateKbps: destination.last_bitrate_kbps,
    })?.label || null,
    behind:
      destination.last_speed != null && destination.last_speed < config.watcher.minSpeed,
    uptime,
    lastError: destination.last_error,
    startedAt: destination.started_at,
    loopMode: destination.loop_mode || 'infinite',
    loopCount: destination.loop_count,
    loopHours: destination.loop_hours,
    loopLabel: loopLabel(destination),
    plannedEndAt: destination.planned_end_at,
    // Time left on a finite broadcast, so the page can say "còn 2 giờ 10 phút"
    // instead of only when it started.
    remaining: (() => {
      if (!ACTIVE_STATES.has(status) || !destination.planned_end_at) return null;
      const end = parseTimestamp(destination.planned_end_at);
      if (!end) return null;
      const seconds = (end.getTime() - Date.now()) / 1000;
      return seconds > 0 ? formatDuration(seconds) : 'đang kết thúc';
    })(),
  };
}

module.exports = {
  ACTIVE_STATES,
  findById,
  findByIdOrThrow,
  listForProject,
  loadContext,
  create,
  update,
  start,
  stop,
  restart,
  finishPlanned,
  normalizeLoop,
  plannedTotalSeconds,
  loopLabel,
  remove,
  startAll,
  stopAll,
  refreshProjectStatus,
  readProgress,
  describeProgress,
  readLogs,
  assertStartable,
  inspectEarlyFailure,
  toView,
  patch,
};
