'use strict';

const db = require('../db');
const config = require('../config');
const live = require('./live.service');
const ffmpeg = require('./ffmpeg.service');
const errorDecoder = require('./error-decoder');
const { parseTimestamp } = require('../utils/format-bytes');
const { maskSecrets } = require('../utils/mask');
const logger = require('../utils/logger');

/**
 * Background watcher: notices when a live stream dies or freezes, records why,
 * and restarts it.
 *
 * Before this existed, status was only refreshed when somebody opened a page, so
 * a stream that died overnight stayed dead until morning. There are no outbound
 * notifications by design, which means the value has to come from the app fixing
 * things itself; the incident history is on the Lịch sử page.
 *
 * Two failures are detected, and the second is the reason this is worth having:
 *
 *   1. The unit is gone or failed — `systemctl is-active` catches this.
 *   2. The unit is "active" but FFmpeg has stopped pushing video. A frozen or
 *      endlessly-reconnecting process still counts as active, so only its
 *      throughput reveals it.
 *
 * Only runs while this process is awake. The stream itself does not depend on us
 * (systemd on the VPS owns FFmpeg), but self-healing does.
 */

let timer = null;
// SSH round trips can outlast the interval; never let two sweeps overlap.
let sweeping = false;

/**
 * Dedupe state, in memory on purpose: it should reset on restart so a fresh boot
 * re-reports anything still broken.
 */
const reportedDestinationState = new Map(); // destinationId -> status already logged
const reportedUnreachableServers = new Set();

/**
 * Consecutive failed recovery attempts per destination, used to back off.
 *
 * Recovery must keep being retried while a stream is stuck — but hammering a VPS
 * that is refusing SSH every single sweep helps nobody, so the gap widens as
 * failures accumulate.
 */
const recoveryFailures = new Map();
const lastRecoveryAttempt = new Map();

/** Backoff schedule: 1st retry immediately, then 2, 4, 8… sweeps apart, capped. */
function shouldAttemptRecovery(destinationId) {
  const failures = recoveryFailures.get(destinationId) || 0;
  if (failures === 0) return true;

  const waitMs = Math.min(2 ** failures, 32) * config.watcher.intervalSeconds * 1000;
  const last = lastRecoveryAttempt.get(destinationId) || 0;
  if (Date.now() - last < waitMs) return false;

  lastRecoveryAttempt.set(destinationId, Date.now());
  return true;
}

function logActivity(type, message, entityType, entityId) {
  db.prepare(
    `INSERT INTO activity_logs (type, message, entity_type, entity_id)
     VALUES (?, ?, ?, ?)`
  ).run(type, maskSecrets(message).slice(0, 500), entityType, entityId);
}

function projectsToWatch() {
  return db
    .prepare(
      `SELECT p.id, p.name, p.server_id, s.name AS server_name
         FROM projects p
         JOIN servers s ON s.id = p.server_id
        WHERE EXISTS (SELECT 1 FROM live_destinations d WHERE d.project_id = p.id)
        ORDER BY p.id`
    )
    .all();
}

/**
 * Whether the user asked for this destination to be running.
 *
 * Derived from started_at/stopped_at rather than from a status transition. That
 * matters because it makes a deliberate Stop invisible to the watcher (stop()
 * writes stopped_at), while a stream that vanished on its own stays "intended
 * running" and keeps being reported even if we miss the exact moment it changed.
 */
function isIntendedRunning(dest) {
  if (!dest.started_at) return false;
  const started = parseTimestamp(dest.started_at);
  const stopped = parseTimestamp(dest.stopped_at);
  if (!started) return false;
  return !stopped || started.getTime() > stopped.getTime();
}

/** Pulls the decoded reason for a dead destination out of its journal. */
async function explainFailure(destinationId) {
  try {
    const logs = await live.readLogs(destinationId, 40);
    return logs.problem || null;
  } catch (err) {
    logger.warn(`Could not read logs for destination ${destinationId}: ${err.message}`);
    return null;
  }
}

/**
 * How early a finished unit is still treated as "finished on purpose".
 *
 * Covers the gap between FFmpeg exiting and this sweep noticing (up to one sweep
 * interval), plus the fraction of a second `-t` can land short. A genuine crash is
 * normally hours from the deadline, so it still falls through to the incident path.
 */
const PLANNED_END_GRACE_MS = 120_000;

/**
 * Ends a broadcast that has played for as long as the user asked.
 *
 * Has to run BEFORE the status is interpreted. Otherwise a finite broadcast that
 * simply ran out looks exactly like a stream that died: the unit is inactive, and
 * the watcher would file an incident and try to restart something the user
 * deliberately asked to end.
 *
 * @returns {Promise<boolean>} true when the destination was finished and needs no
 *   further handling this sweep.
 */
async function handlePlannedEnd(project, dest, entry) {
  if (!dest.planned_end_at) return false;
  const end = parseTimestamp(dest.planned_end_at);
  if (!end) return false;

  const overdueMs = Date.now() - end.getTime();
  const stillUp = ['live', 'starting', 'refreshing'].includes(entry.status);

  // Two ways to arrive here: FFmpeg placed the end itself with -t and has exited,
  // or the broadcast is too long for -t to survive the 8-hour recycle and the app
  // owns the deadline instead.
  const endedItself = !stillUp && overdueMs > -PLANNED_END_GRACE_MS;
  if (!endedItself && overdueMs < 0) return false;

  reportedDestinationState.delete(dest.id);
  try {
    await live.finishPlanned(
      dest.id,
      endedItself ? '' : 'App dừng theo thời lượng đã đặt.'
    );
    logger.info(`Destination ${dest.id} finished as planned (${dest.loop_mode})`);
  } catch (err) {
    logger.warn(`Could not finish destination ${dest.id} cleanly: ${err.message}`);
    return false;
  }
  return true;
}

async function handleDeadDestination(project, dest, status) {
  // Report each distinct bad state once, not every sweep.
  if (reportedDestinationState.get(dest.id) === status) return;
  reportedDestinationState.set(dest.id, status);

  const problem = await explainFailure(dest.id);
  const reason = problem ? `${problem.title}. ${problem.message}` : 'Không rõ nguyên nhân.';

  live.patch(dest.id, { last_error: problem ? problem.title : 'Điểm phát đã dừng ngoài ý muốn' });

  logActivity(
    'live_incident',
    `[${project.name}] ${dest.name} dừng ngoài ý muốn (${status}). ${reason}`,
    'live_destination',
    dest.id
  );
  logger.warn(`Incident: destination ${dest.id} (${dest.name}) is ${status} — ${reason}`);
}

/**
 * Decides whether a destination that systemd calls "active" is actually moving.
 *
 * Three cases have to be told apart, and getting this wrong would restart
 * healthy streams:
 *   - out_time grew           -> healthy, move the baseline forward
 *   - out_time shrank         -> FFmpeg restarted (auto-refresh resets it to 0),
 *                                so re-baseline silently
 *   - out_time stood still    -> stalled, but only past the threshold, and the
 *                                baseline timestamp is deliberately NOT touched
 *                                so elapsed time keeps accumulating
 * A missing sample (just started, file not written yet) is never a verdict.
 */
async function checkForStall(project, dest, progress) {
  const now = new Date();

  if (!progress || progress.outTimeUs == null) return;

  const previous = dest.last_out_time_us;
  const previousAt = parseTimestamp(dest.last_progress_at);

  const rebaseline = () =>
    live.patch(dest.id, {
      last_out_time_us: progress.outTimeUs,
      last_progress_at: now.toISOString(),
    });

  if (previous == null || previousAt == null) return rebaseline();
  if (progress.outTimeUs > previous) {
    // Proof it is moving again clears a previously reported stall.
    if (reportedDestinationState.get(dest.id) === 'stalled') {
      reportedDestinationState.delete(dest.id);
    }
    return rebaseline();
  }
  if (progress.outTimeUs < previous) return rebaseline();

  // Equal: stuck. Leave the baseline alone so the gap keeps growing.
  const stalledSeconds = Math.round((now.getTime() - previousAt.getTime()) / 1000);
  if (stalledSeconds < config.watcher.stallSeconds) return undefined;

  const canRecover = dest.auto_recover_enabled === 1;

  // Reporting the stall and attempting recovery are separate concerns.
  //
  // They used to share one flag, which meant a restart that threw left the flag
  // set and every later sweep returned early — so ONE transient SSH error
  // disabled recovery for that destination for the life of the process, exactly
  // when recovery mattered most. The stall is now logged once, while recovery is
  // retried for as long as the stream stays stuck.
  if (reportedDestinationState.get(dest.id) !== 'stalled') {
    reportedDestinationState.set(dest.id, 'stalled');
    logActivity(
      'live_stalled',
      `[${project.name}] ${dest.name} treo ${stalledSeconds}s (process còn sống nhưng không đẩy dữ liệu).` +
        (canRecover ? ' Đang tự khởi động lại.' : ' Tự khởi động lại đang tắt.'),
      'live_destination',
      dest.id
    );
    live.patch(dest.id, { last_error: `Treo ${stalledSeconds}s, không đẩy được dữ liệu` });
    logger.warn(`Destination ${dest.id} stalled for ${stalledSeconds}s`);
  }

  if (!canRecover) return undefined;
  if (!shouldAttemptRecovery(dest.id)) return undefined;

  try {
    // preserveDeadline: recovery must not extend the broadcast. Restarting a
    // 6-hour broadcast that stalled at hour 5 with a fresh 6-hour clock would run
    // it to hour 11 — the opposite of what the user configured.
    await live.restart(dest.id, { preserveDeadline: true });
    live.patch(dest.id, {
      recover_count: (dest.recover_count || 0) + 1,
      // Clear the baseline so the restarted process is judged fresh instead of
      // against the numbers from before it died.
      last_out_time_us: null,
      last_progress_at: null,
      last_error: null,
    });
    recoveryFailures.delete(dest.id);
    reportedDestinationState.delete(dest.id);
    logActivity(
      'live_recovered',
      `[${project.name}] ${dest.name} đã được tự khởi động lại sau khi treo.`,
      'live_destination',
      dest.id
    );
    logger.info(`Recovered destination ${dest.id} after stall`);
  } catch (err) {
    const failures = (recoveryFailures.get(dest.id) || 0) + 1;
    recoveryFailures.set(dest.id, failures);

    // Log the first failure, then sparsely: a stream that cannot be revived
    // would otherwise add a row every sweep and bury the history.
    if (failures === 1 || failures % 10 === 0) {
      logActivity(
        'live_recover_failed',
        `[${project.name}] ${dest.name} treo nhưng khởi động lại không thành công ` +
          `(lần ${failures}): ${err.message}`,
        'live_destination',
        dest.id
      );
    }
    logger.error(`Failed to recover destination ${dest.id} (attempt ${failures})`, err);
  }
  return undefined;
}

async function checkProject(project) {
  const result = await live.refreshProjectStatus(project.id);

  // A whole VPS being unreachable is one problem, not one per destination.
  if (!result.serverReachable) {
    if (!reportedUnreachableServers.has(project.server_id)) {
      reportedUnreachableServers.add(project.server_id);
      logActivity(
        'server_unreachable',
        `Không kết nối được tới VPS ${project.server_name}. Các buổi live vẫn có thể đang chạy — ` +
          `chỉ là app không kiểm tra được.`,
        'server',
        project.server_id
      );
      logger.warn(`Server ${project.server_id} unreachable`);
    }
    return;
  }

  if (reportedUnreachableServers.delete(project.server_id)) {
    logActivity(
      'server_reachable',
      `Đã kết nối lại được tới VPS ${project.server_name}.`,
      'server',
      project.server_id
    );
  }

  for (const entry of result.destinations) {
    const dest = live.findById(entry.id);
    if (!dest) continue;

    // Not supposed to be running: nothing to report, and clear any stale flag.
    if (!isIntendedRunning(dest)) {
      reportedDestinationState.delete(dest.id);
      continue;
    }

    // Played for as long as asked? That is a finish, and it must be decided before
    // anything below reads the status as a fault.
    if (await handlePlannedEnd(project, dest, entry)) continue;

    // Cache the telemetry so pages can show it without their own SSH call.
    // Cleared once a destination is no longer up, so a stopped stream never
    // displays stale numbers.
    if (entry.status === 'live' && entry.progress) {
      live.patch(dest.id, {
        last_speed: entry.progress.speed,
        last_bitrate_kbps: entry.progress.bitrateKbps,
      });
    } else if (entry.status !== 'live' && dest.last_speed != null) {
      live.patch(dest.id, { last_speed: null, last_bitrate_kbps: null });
    }

    // Transient states during start or an auto-refresh recycle are not faults.
    if (entry.status === 'starting' || entry.status === 'refreshing') continue;

    if (entry.status === 'live') {
      // Back up after having been reported dead. Clearing the flag here (not
      // only when throughput advances) is what lets a flapping destination be
      // reported on every failure instead of just the first one.
      const reported = reportedDestinationState.get(dest.id);
      if (reported && reported !== 'stalled') {
        reportedDestinationState.delete(dest.id);
        live.patch(dest.id, { last_error: null });
        logActivity(
          'live_recovered',
          `[${project.name}] ${dest.name} đã phát lại bình thường.`,
          'live_destination',
          dest.id
        );
      }
      await checkForStall(project, dest, entry.progress);
      continue;
    }

    if (entry.status === 'error' || entry.status === 'stopped' || entry.status === 'unknown') {
      await handleDeadDestination(project, dest, entry.status);
    }
  }
}

async function sweep() {
  if (sweeping) {
    logger.warn('Watcher sweep still running, skipping this tick');
    return;
  }
  sweeping = true;

  try {
    for (const project of projectsToWatch()) {
      try {
        await checkProject(project);
      } catch (err) {
        // One bad project must not stop the others being checked.
        logger.error(`Watcher failed on project ${project.id}`, err);
      }
    }
  } finally {
    sweeping = false;
  }
}

function start() {
  if (!config.watcher.enabled) {
    logger.info('Watcher disabled (WATCHER_ENABLED=0)');
    return null;
  }
  if (timer) return timer;

  const intervalMs = Math.max(10, config.watcher.intervalSeconds) * 1000;
  timer = setInterval(() => {
    sweep().catch((err) => logger.error('Watcher sweep failed', err));
  }, intervalMs);
  // Must not hold the process open during shutdown.
  timer.unref();

  logger.info(
    `Watcher started: every ${config.watcher.intervalSeconds}s, ` +
      `stall threshold ${config.watcher.stallSeconds}s`
  );
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  sweep,
  isIntendedRunning,
  checkForStall,
  handlePlannedEnd,
  // Exposed so tests can assert the dedupe behaviour.
  reportedDestinationState,
  reportedUnreachableServers,
};
