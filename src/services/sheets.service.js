'use strict';

const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/error-handler');
const { parseTimestamp } = require('../utils/format-bytes');

/**
 * Google Sheets sync over an Apps Script webhook.
 *
 * The user wants Sheets to be where they manage data. The binding constraint is
 * that a consumer Gmail account gets only 90 MINUTES of Apps Script runtime per
 * day, and each webhook call costs 400–1500 ms. That is a budget of roughly
 * 3,600 calls a day, about 2.5 per minute sustained — so the number of calls,
 * not the amount of data, is what has to be conserved.
 *
 * Three consequences shape everything here:
 *
 *   1. Reads never hit Sheets directly. They come from the SQLite cache, which a
 *      background pull refreshes. Doing otherwise would add a second of latency
 *      to every page and exhaust the daily budget by mid-morning.
 *   2. Writes are queued in sheet_outbox and flushed as ONE batched call
 *      covering every pending row across every tab.
 *   3. High-frequency machine state (the 2-second upload heartbeat, the
 *      per-destination throughput sample) is never pushed at its own cadence.
 *      It is summarised at most once per SUMMARY_INTERVAL.
 *
 * Every call is timed and recorded in sheet_calls, so actual consumption against
 * the 90-minute budget is measured rather than assumed, and the app throttles
 * itself before Google cuts it off.
 */

// ---------------------------------------------------------------------------
// Tuning. The arithmetic behind each number is in the comment.
// ---------------------------------------------------------------------------

/** Idle baseline refresh. 300s => 288 calls/day => ~7 min of the 90 min budget. */
const PULL_INTERVAL_MS = 300_000;

/**
 * When someone is actually using the app, refresh more eagerly so an edit made in
 * the Sheet shows up quickly — but never more than once per 30s, so a page that
 * polls every 12s cannot multiply into a flood of calls.
 */
const ACTIVITY_PULL_THROTTLE_MS = 30_000;

/** Coalescing window for writes. A burst of edits becomes one call. */
const FLUSH_MIN_INTERVAL_MS = 15_000;

/** Live status / history roll-up. 300s => 288 calls/day. */
const SUMMARY_INTERVAL_MS = 300_000;

/**
 * How stale the cache may be before a write is refused.
 *
 * Deliberately larger than PULL_INTERVAL_MS so one missed refresh does not lock
 * the user out, while still honouring their choice to stop rather than diverge
 * from the Sheet.
 */
const MAX_STALENESS_MS = 600_000;

/**
 * Self-throttle thresholds.
 *
 * The primary gate is MEASURED runtime, not a call count, because the cost per
 * call is not something we get to choose. Against this user's real Sheet a call
 * takes 1.8–2.3 s, so the 90-minute allowance is closer to 2,350 calls than the
 * 3,600 a 1.5 s estimate suggested — a call-count ceiling picked from an estimate
 * would sit above the real budget and never fire.
 *
 * The call ceiling stays as a secondary guard for the case where durations are
 * missing or wildly atypical.
 */
const RUNTIME_CEILING_PERCENT = 70;
const DAILY_CALL_CEILING = 1800;

/** Give up on a queued row after this many failures and surface it. */
const MAX_ATTEMPTS = 6;

const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

const enabled = () =>
  Boolean(config.sheets.enabled && config.sheets.webhookUrl && config.sheets.token);

function getState(key) {
  const row = db.prepare('SELECT value FROM sheet_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  db.prepare(
    `INSERT INTO sheet_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, value == null ? null : String(value));
}

// ---------------------------------------------------------------------------
// Quota accounting
// ---------------------------------------------------------------------------

/**
 * Google's quota day, not ours.
 *
 * The Apps Script allowance resets at midnight America/Los_Angeles, so a rolling
 * 24-hour window is wrong in both directions: it keeps throttling for hours after
 * Google has already reset, and frees headroom hours after the real budget was
 * spent. For a UTC+7 user that boundary lands mid-afternoon.
 */
function pacificDayKey(date = new Date()) {
  // en-CA formats as YYYY-MM-DD, which sorts and compares directly.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * The UTC timestamp of the current Pacific day's start, formatted the way SQLite
 * stores created_at ('YYYY-MM-DD HH:MM:SS'), so it can be compared directly.
 *
 * Derived by measuring the live Pacific offset rather than hardcoding -8, because
 * the offset changes with daylight saving.
 */
function pacificDayStartUtc(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);

  const get = (type) => Number(parts.find((p) => p.type === type).value);
  // How far into the Pacific day we currently are.
  const intoDayMs =
    ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000;

  const start = new Date(now.getTime() - intoDayMs);
  return start.toISOString().slice(0, 19).replace('T', ' ');
}

function recordCall(action, durationMs, ok, error) {
  db.prepare(
    `INSERT INTO sheet_calls (action, duration_ms, ok, error) VALUES (?, ?, ?, ?)`
  ).run(action, Math.round(durationMs), ok ? 1 : 0, error ? String(error).slice(0, 300) : null);

  // Keep the table small; 48h is enough for a rolling 24h view.
  if (Math.random() < 0.05) {
    db.prepare(`DELETE FROM sheet_calls WHERE created_at < datetime('now', '-48 hours')`).run();
  }
}

/**
 * Measured consumption over the last 24 hours.
 *
 * budgetMs is 90 minutes: the documented Apps Script runtime allowance for a
 * consumer Google account.
 */
function usage24h() {
  // Only calls inside Google's current quota day count. created_at is stored in
  // UTC by SQLite, so the Pacific day boundary is converted to a UTC instant.
  const dayStartUtc = pacificDayStartUtc();

  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(duration_ms), 0) AS total_ms,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failures
         FROM sheet_calls
        WHERE created_at >= ?`
    )
    .get(dayStartUtc);

  const budgetMs = 90 * 60 * 1000;
  const percent = Math.round((row.total_ms / budgetMs) * 100);
  const avgMs = row.calls ? Math.round(row.total_ms / row.calls) : null;

  return {
    calls: row.calls,
    failures: row.failures,
    totalMs: row.total_ms,
    budgetMs,
    percent,
    avgMs,
    // Remaining calls at the rate we are actually observing, which is far more
    // useful than a fixed number.
    callsLeft: avgMs ? Math.max(0, Math.floor((budgetMs - row.total_ms) / avgMs)) : null,
    runtimeCeilingPercent: RUNTIME_CEILING_PERCENT,
    callCeiling: DAILY_CALL_CEILING,
    nearCeiling: percent >= RUNTIME_CEILING_PERCENT || row.calls >= DAILY_CALL_CEILING,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * One webhook call. Uses global fetch, so no dependency is added.
 *
 * Apps Script cannot set an HTTP status on a web app response, so success is
 * carried in the body as `ok` and has to be checked explicitly — a 200 with
 * ok:false is a real failure.
 */
async function call(action, payload = {}) {
  if (!enabled()) throw new AppError('Chưa bật đồng bộ Google Sheets.', 400);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(config.sheets.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.sheets.token, action, ...payload }),
      signal: controller.signal,
      // Apps Script answers with a 302 to a googleusercontent URL; fetch follows
      // it by default, which is what we want.
      redirect: 'follow',
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // An HTML body means Google served a sign-in or error page instead of the
      // script — almost always a deployment set to the wrong access level.
      throw new AppError(
        'Google trả về nội dung không phải JSON. Kiểm tra lại: đã Deploy web app với ' +
          '"Who has access = Anyone" chưa, và URL có đúng dạng .../exec không.',
        502
      );
    }

    if (!body.ok) {
      // Still charged for the runtime even when the script rejects us.
      recordCall(action, body.ms || Date.now() - started, false, body.error);
      throw new AppError(`Google Sheets từ chối: ${body.error || 'lỗi không rõ'}`, 502, body);
    }

    // Prefer the script's own execution time: that is what Google charges against
    // the daily allowance. Our wall-clock also covers DNS, TLS, the redirect hop
    // and body transfer, which would over-report on a slow connection.
    recordCall(action, body.ms != null ? body.ms : Date.now() - started, true, null);
    setState('last_error', null);
    return body;
  } catch (err) {
    const message =
      err.name === 'AbortError'
        ? `Google Sheets không trả lời trong ${REQUEST_TIMEOUT_MS / 1000}s.`
        : err.message;
    recordCall(action, Date.now() - started, false, message);
    setState('last_error', message);
    throw err instanceof AppError ? err : new AppError(`Không gọi được Google Sheets: ${message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function ping() {
  const body = await call('ping');
  return { ok: true, now: body.now };
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

let pullInFlight = null;

/**
 * Refreshes the local cache from Sheets.
 *
 * Single-flight: concurrent callers share one request rather than each spending a
 * slice of the daily budget.
 */
async function pull({ force = false } = {}) {
  if (!enabled()) return null;
  if (pullInFlight) return pullInFlight;

  if (!force) {
    const age = cacheAgeMs();
    if (age != null && age < ACTIVITY_PULL_THROTTLE_MS) return null;
  }

  pullInFlight = (async () => {
    const body = await call('read');
    setState('last_pull_at', new Date().toISOString());
    setState('last_pull_ok', '1');
    return body.data;
  })()
    .catch((err) => {
      setState('last_pull_ok', '0');
      throw err;
    })
    .finally(() => {
      pullInFlight = null;
    });

  return pullInFlight;
}

function cacheAgeMs() {
  const at = parseTimestamp(getState('last_pull_at'));
  return at ? Date.now() - at.getTime() : null;
}

/**
 * Gate for write operations.
 *
 * The user chose "stop operations when Sheets is unreachable" over diverging from
 * the Sheet, so this refuses rather than proceeding against a stale view. It
 * tries a refresh first, so a single blip does not block anything.
 */
async function assertFresh() {
  if (!enabled()) return;

  const age = cacheAgeMs();
  if (age != null && age < MAX_STALENESS_MS) return;

  try {
    await pull({ force: true });
  } catch (err) {
    throw new AppError(
      `Không đọc được Google Sheet nên tạm thời không thể thay đổi dữ liệu.\n\n` +
        `${err.message}\n\n` +
        `Buổi live đang chạy KHÔNG bị ảnh hưởng. Hãy thử lại khi kết nối tới Google trở lại.`,
      503
    );
  }
}

// ---------------------------------------------------------------------------
// Queue and flush
// ---------------------------------------------------------------------------

/**
 * Queues a row. INSERT OR REPLACE collapses repeated edits of the same row into
 * one pending write, which is what keeps a burst of user activity from costing a
 * call per keystroke.
 */
/**
 * The key the Sheet identifies this row by — uuid everywhere except Meta, which is a
 * handful of script-owned settings with no table behind it. Must agree with KEY_COL in
 * deploy/apps-script/Code.gs, or a write would create a second row instead of
 * updating the one that is there.
 */
function rowKey(tab, row) {
  const value = tab === 'Meta' ? row.id : row.uuid;
  return value == null || value === '' ? null : String(value);
}

function queueUpsert(tab, row, snapshotRow = null) {
  if (!enabled() || !row) return;
  const key = rowKey(tab, row);
  if (key == null) return;
  db.prepare(
    `INSERT OR REPLACE INTO sheet_outbox
       (tab, entity_id, operation, payload, snapshot_payload, attempts, updated_at)
     VALUES (?, ?, 'upsert', ?, ?, 0, CURRENT_TIMESTAMP)`
  ).run(
    tab,
    key,
    JSON.stringify(row),
    snapshotRow ? JSON.stringify(snapshotRow) : null
  );
}

function queueDelete(tab, key) {
  if (!enabled() || key == null || key === '') return;
  db.prepare(
    `INSERT OR REPLACE INTO sheet_outbox
       (tab, entity_id, operation, payload, snapshot_payload, attempts, updated_at)
     VALUES (?, ?, 'delete', NULL, NULL, 0, CURRENT_TIMESTAMP)`
  ).run(tab, String(key));
}

function pendingCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM sheet_outbox').get().n;
}

let flushInFlight = null;
let lastFlushAt = 0;

/** Sends every queued row in one call. */
async function flush({ force = false } = {}) {
  if (!enabled()) return null;
  if (flushInFlight) return flushInFlight;
  if (!force && Date.now() - lastFlushAt < FLUSH_MIN_INTERVAL_MS) return null;

  const rows = db
    .prepare(`SELECT * FROM sheet_outbox WHERE attempts < ? ORDER BY id LIMIT 500`)
    .all(MAX_ATTEMPTS);
  if (!rows.length) return null;

  flushInFlight = (async () => {
    const upserts = {};
    const deletes = {};

    for (const row of rows) {
      if (row.operation === 'delete') {
        (deletes[row.tab] = deletes[row.tab] || []).push(row.entity_id);
      } else {
        try {
          (upserts[row.tab] = upserts[row.tab] || []).push(JSON.parse(row.payload));
        } catch {
          // Unparseable payload can never succeed; drop it rather than retry
          // forever.
          db.prepare('DELETE FROM sheet_outbox WHERE id = ?').run(row.id);
        }
      }
    }

    try {
      await call('write', { upserts, deletes });
      const ids = rows.map((r) => r.id);

      // Promote the snapshot in the SAME transaction that clears the queue, so the
      // app's record of "what the Sheet holds" can never disagree with what was
      // actually sent — not even if the process dies here.
      db.transaction(() => {
        for (const row of rows) {
          if (row.operation === 'delete') {
            db.prepare('DELETE FROM sheet_snapshot WHERE tab = ? AND entity_id = ?').run(
              row.tab,
              row.entity_id
            );
          } else if (row.snapshot_payload) {
            db.prepare(
              `INSERT INTO sheet_snapshot (tab, entity_id, payload, updated_at)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(tab, entity_id) DO UPDATE
                 SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP`
            ).run(row.tab, row.entity_id, row.snapshot_payload);
          }
        }
        db.prepare(
          `DELETE FROM sheet_outbox WHERE id IN (${ids.map(() => '?').join(',')})`
        ).run(...ids);
      })();

      setState('last_push_at', new Date().toISOString());
      lastFlushAt = Date.now();
      return { sent: rows.length };
    } catch (err) {
      // Count the attempt so a permanently bad row eventually stops burning quota.
      const ids = rows.map((r) => r.id);
      db.prepare(
        `UPDATE sheet_outbox SET attempts = attempts + 1, last_error = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${ids.map(() => '?').join(',')})`
      ).run(String(err.message).slice(0, 300), ...ids);
      lastFlushAt = Date.now();
      throw err;
    }
  })().finally(() => {
    flushInFlight = null;
  });

  return flushInFlight;
}

/** Rows that exhausted their retries and need the user to know. */
function stuckRows() {
  return db
    .prepare(`SELECT tab, entity_id, operation, last_error FROM sheet_outbox WHERE attempts >= ?`)
    .all(MAX_ATTEMPTS);
}

// ---------------------------------------------------------------------------
// Status for the UI
// ---------------------------------------------------------------------------

function status() {
  if (!enabled()) {
    return { enabled: false, healthy: true, message: 'Chưa bật đồng bộ Google Sheets.' };
  }

  const ageMs = cacheAgeMs();
  const usage = usage24h();
  const stuck = stuckRows();
  const lastError = getState('last_error');
  const pending = pendingCount();

  const healthy = ageMs != null && ageMs < MAX_STALENESS_MS && !stuck.length;

  return {
    enabled: true,
    healthy,
    ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
    staleAfterSeconds: MAX_STALENESS_MS / 1000,
    pending,
    stuck: stuck.length,
    lastError,
    usage,
    message: healthy
      ? `Đồng bộ bình thường · làm mới ${ageMs == null ? '—' : Math.round(ageMs / 1000) + 's'} trước`
      : lastError || 'Chưa đồng bộ được với Google Sheet.',
  };
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

let pullTimer = null;
let flushTimer = null;
let lastSummaryAt = 0;

/**
 * Required lazily.
 *
 * sheets-sync depends on this module for its transport, so importing it at the
 * top would be a require cycle. By the time any timer fires, both modules are
 * fully loaded, and the lookup is a cache hit.
 */
const sync = () => require('./sheets-sync.service');

/**
 * One outbound cycle: notice what changed locally, then send it.
 *
 * Reconcile is pure local SQLite and costs no quota, so it runs every cycle. The
 * call to Google only happens if reconcile actually found something, which is why
 * an idle app spends nothing.
 */
async function tick() {
  // Derived numbers that move constantly (a live stream's uptime, its throughput)
  // are refreshed on the slower summary beat. Including them every cycle would
  // turn one live destination into a write every 15 seconds — about 5,700 calls a
  // day, which alone would exhaust the allowance.
  const includeTelemetry = Date.now() - lastSummaryAt >= SUMMARY_INTERVAL_MS;
  if (includeTelemetry) lastSummaryAt = Date.now();

  try {
    sync().reconcile({ includeTelemetry });
    sync().pushHistory();
  } catch (err) {
    logger.warn(`Sheets reconcile failed: ${err.message}`);
  }

  if (!pendingCount()) return;
  if (usage24h().nearCeiling) {
    logger.warn('Sheets budget ceiling reached for today, holding writes in the queue');
    return;
  }
  await flush().catch((err) => logger.warn(`Sheets flush failed: ${err.message}`));
}

function start() {
  if (!enabled()) {
    logger.info('Google Sheets sync disabled');
    return;
  }

  pullTimer = setInterval(() => {
    // Self-throttle before Google does: past the ceiling, only user-triggered
    // refreshes continue.
    if (usage24h().nearCeiling) {
      logger.warn('Sheets call ceiling reached for today, pausing periodic pull');
      return;
    }
    sync()
      .pullAndApply({ force: true })
      .catch((err) => logger.warn(`Sheets pull failed: ${err.message}`));
  }, PULL_INTERVAL_MS);
  pullTimer.unref();

  flushTimer = setInterval(() => {
    tick().catch((err) => logger.warn(`Sheets tick failed: ${err.message}`));
  }, FLUSH_MIN_INTERVAL_MS);
  flushTimer.unref();

  logger.info(
    `Google Sheets sync started: pull every ${PULL_INTERVAL_MS / 1000}s, ` +
      `push every ${FLUSH_MIN_INTERVAL_MS / 1000}s, ` +
      `live telemetry every ${SUMMARY_INTERVAL_MS / 1000}s, ` +
      `throttle at ${RUNTIME_CEILING_PERCENT}% of the 90 min/day allowance`
  );

  // Prime the cache so the first page view is not the one that pays for it, then
  // send anything that changed while the app was closed. The one-time rebuild goes
  // first: until it has run, the Sheet has no uuid column and a partial write would
  // find no row to update and append duplicates instead.
  rebuildIfKeySchemeChanged()
    .catch((err) => logger.warn(`Sheet rebuild failed, will retry next start: ${err.message}`))
    .then(() => sync().pullAndApply({ force: true }))
    .then(() => tick())
    .catch((err) => logger.warn(`Initial Sheets sync failed: ${err.message}`));
}

/**
 * Rewrites the whole Sheet once, after the column that identifies a row changed.
 *
 * Set by 015_sync_uuid.sql. The existing Sheet is keyed by `id` and has no `uuid`
 * column at all, so there is no incremental path from one to the other: every row has
 * to be written again under the new key. bootstrap({reset:true}) clears the tabs,
 * writes the new headers and sends every row from SQLite.
 *
 * Safe to lose nothing by, because SQLite already holds everything the Sheet showed,
 * names and notes included — those are pulled back into it on every cycle. The one
 * exception is an edit typed into the Sheet after the app's last successful pull and
 * before this upgrade; that is why the release notes say to open the app once before
 * updating the Apps Script.
 *
 * Left set if it fails, so a Sheet that was unreachable today is rebuilt tomorrow
 * rather than quietly skipped.
 */
async function rebuildIfKeySchemeChanged() {
  if (!enabled()) return;
  if (!getState('key_scheme_pending')) return;

  logger.warn('Sheet row key changed to uuid — rebuilding the Sheet once');
  const result = await sync().bootstrap({ reset: true });
  setState('key_scheme_pending', '');
  logger.info(`Sheet rebuilt under the new key: ${result.queued} rows`);
}

/**
 * Called from page requests. Refreshes the cache while somebody is actually
 * looking, so an edit made in the Sheet appears without waiting for the slow
 * baseline. Throttled hard, because a page that polls every 12 seconds must not
 * turn into a call every 12 seconds.
 */
function activityPull() {
  if (!enabled()) return;
  const age = cacheAgeMs();
  if (age != null && age < ACTIVITY_PULL_THROTTLE_MS) return;
  if (usage24h().nearCeiling) return;
  sync()
    .pullAndApply({ force: true })
    .catch((err) => logger.warn(`Sheets activity pull failed: ${err.message}`));
}

function stop() {
  if (pullTimer) clearInterval(pullTimer);
  if (flushTimer) clearInterval(flushTimer);
  pullTimer = null;
  flushTimer = null;
}

module.exports = {
  enabled,
  call,
  ping,
  pull,
  flush,
  assertFresh,
  queueUpsert,
  queueDelete,
  pendingCount,
  stuckRows,
  cacheAgeMs,
  usage24h,
  status,
  start,
  stop,
  tick,
  activityPull,
  getState,
  setState,
  // Exported for tests and for the quota measurement step.
  recordCall,
  TUNING: {
    PULL_INTERVAL_MS,
    ACTIVITY_PULL_THROTTLE_MS,
    FLUSH_MIN_INTERVAL_MS,
    SUMMARY_INTERVAL_MS,
    MAX_STALENESS_MS,
    RUNTIME_CEILING_PERCENT,
    DAILY_CALL_CEILING,
    MAX_ATTEMPTS,
  },
};
