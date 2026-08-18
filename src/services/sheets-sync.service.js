'use strict';

const db = require('../db');
const config = require('../config');
const sheets = require('./sheets.service');
const logger = require('../utils/logger');
const ffmpeg = require('./ffmpeg.service');
const { decrypt } = require('./crypto.service');
const { maskRtmpsUrl, keyLast4 } = require('../utils/mask');
const { formatBytes, formatDuration, parseTimestamp } = require('../utils/format-bytes');
const { AppError } = require('../middleware/error-handler');

/**
 * Maps between SQLite rows and Sheet rows, and applies changes in both
 * directions.
 *
 * Two rules govern everything here, and they are what make the Sheet usable as
 * the place the user manages data:
 *
 *   1. The app only ever WRITES the columns it owns. Columns a human owns (name,
 *      note, and playlist position) are pushed on creation and then left alone,
 *      so an edit made in the Sheet is never clobbered by the next sync.
 *   2. A change pulled from the Sheet is REFUSED if applying it would break a
 *      running stream. A hand-deleted row must not take a live broadcast down.
 *
 * Secrets travel as CIPHERTEXT, never as plaintext. The Sheet carries the same
 * `v1:<iv>:<ct>:<tag>` blobs SQLite holds — SSH password, SSH private key, RTMPS URL
 * — because that is what makes one .env enough to rebuild a machine. The Apps Script
 * webhook is an unauthenticated URL and Google keeps revision history forever, so
 * everything on the Sheet must stay unreadable without the key: APP_ENCRYPTION_KEY
 * lives only in .env and is never sent anywhere. The masked key column stays too,
 * because a human reading the Sheet still needs to tell two destinations apart.
 */

// ---------------------------------------------------------------------------
// Columns the app owns vs the human owns
// ---------------------------------------------------------------------------

/**
 * Columns the user may edit in the Sheet, and the only ones read back on a pull.
 *
 * They are not protected by omitting them from writes — that would also block a
 * rename done in the app. They are protected by only ever sending a column whose
 * value CHANGED on this side (see diffRow): the app cannot clobber a value it did
 * not touch, because it never sends one. Code.gs updates only the keys present in
 * a payload, which is what makes a partial write safe.
 */
const HUMAN_OWNED = {
  Servers: ['name', 'note'],
  Videos: ['name', 'note'],
  Projects: ['name', 'note'],
  Destinations: ['name', 'note'],
  Playlist: ['position'],
};

// ---------------------------------------------------------------------------
// SQLite -> Sheet
// ---------------------------------------------------------------------------

function serverRow(s) {
  return {
    uuid: s.uuid,
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    os: s.os_name || '',
    ffmpeg: s.ffmpeg_version || '',
    rtmps: s.ffmpeg_has_rtmps === 1 ? 'có' : s.ffmpeg_has_rtmps === 0 ? 'không' : '',
    disk_used: s.used_bytes ? formatBytes(s.used_bytes) : '',
    disk_total: s.total_bytes ? formatBytes(s.total_bytes) : '',
    setup_state: s.setup_state,
    note: s.note || '',
    updated_at: s.updated_at,

    /**
     * The credentials, exactly as SQLite holds them — still encrypted.
     *
     * These are what turn a restore from "here is a list of your VPS" into a machine
     * that can actually connect. Sent verbatim: this function never calls decrypt, so
     * a plaintext password cannot escape through here even by mistake. The host key
     * fingerprint rides along so the new machine inherits the TOFU pin instead of
     * trusting whatever answers on the first connection.
     */
    auth_type: s.auth_type,
    enc_password: s.encrypted_password || '',
    enc_private_key: s.encrypted_private_key || '',
    host_key_fp: s.host_key_fingerprint || '',
  };
}

function videoRow(v) {
  return {
    // videos.uuid predates this — it is what names the file on the VPS — and is
    // reused as the Sheet key rather than adding a second identifier.
    uuid: v.uuid,
    id: v.id,
    server_id: v.server_id,
    name: v.original_name,
    size: v.size_bytes ? formatBytes(v.size_bytes) : '',
    duration: v.duration_seconds ? formatDuration(v.duration_seconds) : '',
    resolution: v.width && v.height ? `${v.width}x${v.height}` : '',
    fps: v.fps || '',
    codec: v.codec_video || '',
    audio: v.codec_audio || (v.has_audio === 0 ? 'không có' : ''),
    keyframe_gap: v.max_keyframe_interval != null ? `${v.max_keyframe_interval}s` : '',
    status: v.status,
    source: v.source_type,
    remote_path: v.remote_path,
    note: v.note || '',
    updated_at: v.updated_at,
  };
}

function projectRow(p) {
  const videoCount = db
    .prepare('SELECT COUNT(*) AS n FROM project_videos WHERE project_id = ?')
    .get(p.id).n;
  const destCount = db
    .prepare('SELECT COUNT(*) AS n FROM live_destinations WHERE project_id = ?')
    .get(p.id).n;

  return {
    uuid: p.uuid,
    id: p.id,
    server_id: p.server_id,
    name: p.name,
    video_count: videoCount,
    destination_count: destCount,
    note: p.note || '',
    updated_at: p.updated_at,
  };
}

function playlistRow(pv) {
  const video = db.prepare('SELECT original_name FROM videos WHERE id = ?').get(pv.video_id);
  return {
    uuid: pv.uuid,
    id: pv.id,
    project_id: pv.project_id,
    position: pv.position,
    video_id: pv.video_id,
    video_name: video ? video.original_name : '(video đã xoá)',
    updated_at: pv.created_at,
  };
}

function destinationRow(d) {
  let uptime = '';
  if (['live', 'starting', 'refreshing'].includes(d.status) && d.started_at) {
    const started = parseTimestamp(d.started_at);
    if (started) {
      const seconds = (Date.now() - started.getTime()) / 1000;
      if (seconds > 0) uptime = formatDuration(seconds);
    }
  }

  const throughput =
    d.last_speed != null
      ? `${Number(d.last_speed).toFixed(2)}x` +
        (d.last_bitrate_kbps != null ? ` · ${Math.round(d.last_bitrate_kbps)} kbps` : '')
      : '';

  return {
    uuid: d.uuid,
    id: d.id,
    project_id: d.project_id,
    name: d.name,
    status: d.status,
    // Masked only. The ciphertext never leaves SQLite.
    key_masked: d.key_last4 ? `…${d.key_last4}` : '',
    uptime,
    throughput,
    auto_refresh: d.auto_refresh_enabled === 1 ? 'bật' : 'tắt',
    loop:
      d.loop_mode === 'count'
        ? `${d.loop_count} vòng`
        : d.loop_mode === 'hours'
          ? `${d.loop_hours} giờ`
          : 'lặp mãi',
    planned_end: d.planned_end_at || '',
    recover_count: d.recover_count || 0,
    note: d.note || '',
    updated_at: d.updated_at,

    /**
     * Everything needed to rebuild this destination on another machine.
     *
     * `loop` above is prose for a human ("3 vòng"); these are the numbers behind it,
     * because a restore has to write loop_mode/loop_count/loop_hours and cannot parse
     * Vietnamese back into them. systemd_unit travels too: the unit name on the VPS is
     * derived from the numeric id, so a machine that rebuilds with a different id would
     * be unable to stop a stream the first machine started.
     */
    enc_rtmps_url: d.encrypted_rtmps_url || '',
    auto_refresh_enabled: d.auto_refresh_enabled,
    auto_recover_enabled: d.auto_recover_enabled,
    runtime_max_seconds: d.runtime_max_seconds,
    loop_mode: d.loop_mode || 'infinite',
    loop_count: d.loop_count == null ? '' : d.loop_count,
    loop_hours: d.loop_hours == null ? '' : d.loop_hours,
    systemd_unit: d.systemd_unit || '',
  };
}

function historyRow(l) {
  return { uuid: l.uuid, id: l.id, time: l.created_at, type: l.type, message: l.message };
}

const MAPPERS = {
  Servers: { table: 'servers', map: serverRow },
  Videos: { table: 'videos', map: videoRow },
  Projects: { table: 'projects', map: projectRow },
  Playlist: { table: 'project_videos', map: playlistRow },
  Destinations: { table: 'live_destinations', map: destinationRow },
};

// ---------------------------------------------------------------------------
// Snapshot: what the Sheet holds, as far as this app knows
// ---------------------------------------------------------------------------

/*
 * Keyed by the row's uuid, not its id — the same key the Sheet uses. `entity_id` is
 * declared INTEGER but SQLite types are per-value, so the text key stores fine; 015
 * empties both tables so no integer-keyed leftovers can be read back as uuids.
 */
function snapshotGet(tab, key) {
  const row = db
    .prepare('SELECT payload FROM sheet_snapshot WHERE tab = ? AND entity_id = ?')
    .get(tab, String(key));
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null; // unreadable: treat the row as unsent and push it whole
  }
}

/**
 * Records a value the SHEET already holds because the user typed it there.
 *
 * Without this, applying a Sheet-side rename would immediately look like a local
 * change and get pushed straight back — a wasted call every cycle, forever.
 */
function snapshotMerge(tab, key, partial) {
  const current = snapshotGet(tab, key);
  if (!current) return;
  db.prepare(
    `UPDATE sheet_snapshot SET payload = ?, updated_at = CURRENT_TIMESTAMP
      WHERE tab = ? AND entity_id = ?`
  ).run(JSON.stringify({ ...current, ...partial }), tab, String(key));
}

/** Forgets a row so the next reconcile sends it again in full. */
function snapshotForget(tab, key) {
  db.prepare('DELETE FROM sheet_snapshot WHERE tab = ? AND entity_id = ?').run(tab, String(key));
}

// ---------------------------------------------------------------------------
// Reconcile: find what changed and queue only that
// ---------------------------------------------------------------------------

/**
 * Columns whose value moves on its own while a stream runs.
 *
 * A live destination's uptime is different every second, so if these took part in
 * change detection there would always be a change to send. They ride along free
 * whenever something real changes, and otherwise are refreshed on the summary
 * beat.
 */
const TELEMETRY_FIELDS = {
  Destinations: ['uptime', 'throughput'],
};

/**
 * `updated_at` is never a reason on its own.
 *
 * Every UPDATE in the app bumps it, including the watcher writing a throughput
 * sample every 60 seconds. Treating that as a change would push a row a minute
 * for each live destination while telling the user nothing they can see.
 */
const NEVER_ALONE = ['updated_at'];

const asText = (value) => (value == null ? '' : String(value));

/**
 * The columns that differ between the row we have and the row the Sheet has.
 *
 * Returns null when there is nothing worth a call. Human-owned columns are
 * included only when the value CHANGED locally: that is what lets a rename done
 * in the app reach the Sheet while a rename done in the Sheet survives.
 */
function diffRow(tab, current, previous, { includeTelemetry }) {
  const telemetry = TELEMETRY_FIELDS[tab] || [];
  const delta = {};
  let substantive = false;

  for (const [key, value] of Object.entries(current)) {
    // Identity, not data. `uuid` is the Sheet's key and `id` rides along beside it;
    // neither ever changes, and sending them as a "difference" would be noise.
    if (key === 'id' || key === 'uuid') continue;
    if (asText(value) === asText(previous[key])) continue;

    if (telemetry.includes(key)) {
      if (includeTelemetry) delta[key] = value;
      continue;
    }
    delta[key] = value;
    if (!NEVER_ALONE.includes(key)) substantive = true;
  }

  if (!Object.keys(delta).length) return null;
  if (!substantive && !includeTelemetry) return null;

  // Something real changed, so refresh the free-riding columns in the same call.
  if (substantive) {
    for (const key of telemetry) {
      if (key in current) delta[key] = current[key];
    }
  }
  return delta;
}

/**
 * Compares every mapped row against the copy the Sheet has and queues the
 * difference. Also queues a delete for rows the app no longer has.
 *
 * This replaces calling queueUpsert() from each of the twenty-odd places that
 * write a row. Those call sites would each be a chance to forget one, and a
 * forgotten one means a Sheet that is quietly wrong — see 011_sheet_snapshot.sql.
 */
function reconcile({ includeTelemetry = false } = {}) {
  if (!sheets.enabled()) return { queued: 0, removed: 0 };

  let queued = 0;
  let removed = 0;
  const present = new Set();

  for (const [tab, mapper] of Object.entries(MAPPERS)) {
    for (const record of db.prepare(`SELECT * FROM ${mapper.table} ORDER BY id`).all()) {
      present.add(`${tab}:${record.uuid}`);
      const current = mapper.map(record);
      const previous = snapshotGet(tab, record.uuid);

      if (!previous) {
        // First time this row is sent: the app seeds every column, human-owned
        // ones included, because the Sheet has nothing in them yet.
        sheets.queueUpsert(tab, current, current);
        queued += 1;
        continue;
      }

      const delta = diffRow(tab, current, previous, { includeTelemetry });
      if (!delta) continue;

      // uuid must travel with every partial write: it is how Code.gs finds the row
      // to update. id rides along so a machine restoring later gets the same one.
      sheets.queueUpsert(
        tab,
        { uuid: record.uuid, id: record.id, ...delta },
        { ...previous, ...delta }
      );
      queued += 1;
    }
  }

  for (const row of db.prepare('SELECT tab, entity_id FROM sheet_snapshot').all()) {
    if (!MAPPERS[row.tab]) continue; // History and Meta are append-only
    if (present.has(`${row.tab}:${row.entity_id}`)) continue;
    sheets.queueDelete(row.tab, row.entity_id);
    removed += 1;
  }

  return { queued, removed };
}

/**
 * How many rows this install would put on the Sheet.
 *
 * Zero means this database owns nothing yet — a fresh clone, or a rebuilt file. Such
 * an install is a restore TARGET and must never be allowed to overwrite the Sheet,
 * which at that moment is the only copy of the catalogue.
 */
function catalogueRowCount() {
  let total = 0;
  for (const mapper of Object.values(MAPPERS)) {
    total += db.prepare(`SELECT COUNT(*) AS n FROM ${mapper.table}`).get().n;
  }
  return total;
}

/** Queues one entity immediately, for the rare case that cannot wait a cycle. */
function push(tab, id, { isNew = false } = {}) {
  if (!sheets.enabled()) return;
  const mapper = MAPPERS[tab];
  if (!mapper) return;

  const record = db.prepare(`SELECT * FROM ${mapper.table} WHERE id = ?`).get(id);
  // A row that is already gone has no uuid left to key a delete by. reconcile removes
  // it from the snapshot side instead, which is the path that always has one.
  if (!record) return;

  const row = mapper.map(record);
  const previous = snapshotGet(tab, record.uuid);
  if (isNew || !previous) {
    sheets.queueUpsert(tab, row, row);
    return;
  }
  const delta = diffRow(tab, row, previous, { includeTelemetry: true });
  if (delta) {
    sheets.queueUpsert(
      tab,
      { uuid: record.uuid, id: record.id, ...delta },
      { ...previous, ...delta }
    );
  }
}

function pushDelete(tab, uuid) {
  sheets.queueDelete(tab, uuid);
}

/** Appends recent history rows that have not been sent yet. */
function pushHistory(limit = 50) {
  if (!sheets.enabled()) return;
  const lastId = Number(sheets.getState('history_cursor') || 0);
  const rows = db
    .prepare('SELECT * FROM activity_logs WHERE id > ? ORDER BY id LIMIT ?')
    .all(lastId, limit);
  if (!rows.length) return;

  for (const row of rows) sheets.queueUpsert('History', historyRow(row));
  sheets.setState('history_cursor', rows[rows.length - 1].id);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Seeds the Sheet from SQLite.
 *
 * Run once when connecting a Sheet, and available afterwards as a repair action.
 * Everything is queued and flushed in a single call, so a full bootstrap costs
 * one unit of the daily allowance rather than one per row.
 */
async function bootstrap({ reset = false } = {}) {
  if (!sheets.enabled()) {
    throw new AppError('Chưa bật đồng bộ Google Sheets trong file .env.', 400);
  }

  if (reset) {
    /*
     * Never clear the Sheet when there is nothing to put back.
     *
     * `reset` wipes every tab, and the rows are only restored by the queue built
     * below. With an empty catalogue that queue is empty too, so the sequence reads
     * "delete everything, write nothing" — which is exactly what happened once: a
     * fresh clone with the same .env reset the Sheet it had come to read from.
     * Refusing costs nothing; there is no case where emptying the Sheet from an
     * empty database is the intent.
     */
    if (catalogueRowCount() === 0) {
      throw new AppError(
        'Máy này chưa có dữ liệu nào, nên xoá và dựng lại sẽ làm trống Sheet. ' +
          'Hãy dùng "Lấy dữ liệu từ Sheet về" để lấy dữ liệu xuống trước.',
        400
      );
    }
    // Clears the tabs and rewrites the header row.
    await sheets.call('reset');
    sheets.setState('history_cursor', 0);
    db.prepare('DELETE FROM sheet_outbox').run();
    db.prepare('DELETE FROM sheet_snapshot').run();
  }

  let queued = 0;
  for (const [tab, mapper] of Object.entries(MAPPERS)) {
    const rows = db.prepare(`SELECT * FROM ${mapper.table} ORDER BY id`).all();
    for (const record of rows) {
      // A bootstrap is the one time the app writes the human-owned columns for an
      // existing row: it is repairing a Sheet that has drifted, so the app's copy
      // is the one to trust.
      const row = mapper.map(record);
      sheets.queueUpsert(tab, row, row);
      queued += 1;
    }
  }

  const history = db.prepare('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 200').all();
  for (const row of history.reverse()) {
    sheets.queueUpsert('History', historyRow(row));
    queued += 1;
  }
  const newest = db.prepare('SELECT MAX(id) AS m FROM activity_logs').get().m;
  sheets.setState('history_cursor', newest || 0);

  sheets.queueUpsert('Meta', {
    id: 1,
    key: 'bootstrapped_at',
    value: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await sheets.flush({ force: true });
  logger.info(`Sheets bootstrap queued ${queued} rows`);
  return { queued };
}

// ---------------------------------------------------------------------------
// Sheet -> SQLite
// ---------------------------------------------------------------------------

/**
 * Columns of this row that are waiting to go up.
 *
 * Without this, a pull can silently undo work the user just did in the app. The
 * sequence: they rename something, the change sits in the outbox for up to a
 * cycle, and a pull in that window reads the Sheet's OLD name and writes it back
 * over the new one. Navigating to another page right after an edit is enough to
 * trigger it, because a page view refreshes the cache.
 *
 * A queued column means the Sheet has not seen the app's value yet, so the Sheet
 * is the stale side and must not win. Returns null when nothing is queued.
 */
function pendingColumns(tab, key) {
  const row = db
    .prepare('SELECT operation, payload FROM sheet_outbox WHERE tab = ? AND entity_id = ?')
    .get(tab, String(key));
  if (!row) return null;
  // A queued delete means the row is on its way out; nothing about it should be
  // read back from the Sheet.
  if (row.operation === 'delete') return 'all';
  if (!row.payload) return null;
  try {
    return new Set(Object.keys(JSON.parse(row.payload)));
  } catch {
    return null;
  }
}

const isPending = (pending, column) =>
  pending === 'all' || (pending instanceof Set && pending.has(column));

/** Destinations that must not be disturbed by a pulled change. */
function activeDestinationIds() {
  return new Set(
    db
      .prepare(
        `SELECT id FROM live_destinations WHERE status IN ('live','starting','refreshing')`
      )
      .all()
      .map((r) => r.id)
  );
}

function projectsWithActiveLive() {
  return new Set(
    db
      .prepare(
        `SELECT DISTINCT project_id FROM live_destinations
          WHERE status IN ('live','starting','refreshing')`
      )
      .all()
      .map((r) => r.project_id)
  );
}

/**
 * Applies human edits pulled from the Sheet.
 *
 * Only the columns a human owns are read back. Status, throughput and uptime are
 * app-owned and ignored even if edited, because trusting them could make the app
 * believe a stopped stream is live.
 */
function applyPull(data) {
  if (!data) return { applied: [], refused: [] };

  const applied = [];
  const refused = [];
  const activeDests = activeDestinationIds();
  const busyProjects = projectsWithActiveLive();

  // Matched by uuid, not by id: the Sheet may be shared with another machine whose
  // ids are numbered separately, and renaming whatever happens to share a number
  // there would rename the wrong thing here.
  const rename = (tab, table, column, row, label) => {
    if (!row.uuid) return;
    const current = db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(String(row.uuid));
    if (!current) return;

    // The app changed this column moments ago and the Sheet has not received it
    // yet, so what we just read is the old value. Leave it alone.
    const pending = pendingColumns(tab, current.uuid);

    const incoming = row.name == null ? '' : String(row.name).trim();
    if (!isPending(pending, 'name') && incoming && incoming !== current[column]) {
      const value = incoming.slice(0, 200);
      db.prepare(`UPDATE ${table} SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(value, current.id);
      // The Sheet already has this value, so record it as sent. Otherwise the very
      // next reconcile would see a local change and push it straight back.
      snapshotMerge(tab, current.uuid, { name: value });
      applied.push(`${label} #${current.id}: đổi tên thành "${incoming}"`);
    }

    const note = row.note == null ? '' : String(row.note).trim();
    if (!isPending(pending, 'note') && note !== (current.note || '')) {
      const value = note.slice(0, 500);
      db.prepare(`UPDATE ${table} SET note = ? WHERE id = ?`).run(value, current.id);
      snapshotMerge(tab, current.uuid, { note: value });
    }
  };

  for (const row of data.Videos?.rows || []) rename('Videos', 'videos', 'original_name', row, 'Video');
  for (const row of data.Projects?.rows || []) rename('Projects', 'projects', 'name', row, 'Project');
  for (const row of data.Servers?.rows || []) rename('Servers', 'servers', 'name', row, 'VPS');
  for (const row of data.Destinations?.rows || []) {
    rename('Destinations', 'live_destinations', 'name', row, 'Điểm phát');
  }

  // Playlist order. Reordering a project that is currently streaming is allowed
  // but is NOT applied silently — it needs a restart to take effect, and the
  // caller reports that.
  const playlistRows = data.Playlist?.rows || [];
  const byProject = new Map();
  for (const row of playlistRows) {
    if (row.project_id == null || row.position == null || !row.uuid) continue;
    const list = byProject.get(Number(row.project_id)) || [];
    list.push({ uuid: String(row.uuid), position: Number(row.position) });
    byProject.set(Number(row.project_id), list);
  }

  for (const [projectId, list] of byProject) {
    const current = db
      .prepare(
        'SELECT id, uuid, position FROM project_videos WHERE project_id = ? ORDER BY position, id'
      )
      .all(projectId);
    if (!current.length) continue;

    const wanted = list.slice().sort((a, b) => a.position - b.position).map((r) => r.uuid);
    const existing = current.map((r) => r.uuid);

    // Only accept a permutation of exactly the rows we already have. Anything
    // else (a deleted or invented row) is a Sheet edit we cannot safely honour.
    const same =
      wanted.length === existing.length && wanted.every((uuid) => existing.includes(uuid));
    if (!same) {
      refused.push(
        `Danh sách phát của project #${projectId} trên Sheet không khớp dữ liệu app ` +
          `(thiếu hoặc thừa dòng) nên chưa áp dụng. Hãy thêm/xoá video trong app.`
      );
      continue;
    }
    if (wanted.join(',') === existing.join(',')) continue;

    // A reorder done in the app is still on its way to the Sheet, so the order we
    // just read is the old one. Applying it would undo the user's own drag.
    if (current.some((r) => isPending(pendingColumns('Playlist', r.uuid), 'position'))) continue;

    const apply = db.transaction(() => {
      wanted.forEach((uuid, index) => {
        db.prepare('UPDATE project_videos SET position = ? WHERE uuid = ?').run(index, uuid);
      });
      // Deliberately NOT recorded as already-on-the-Sheet: positions are renumbered
      // 0..n-1, which is usually not what the user typed (people reorder with 1, 5,
      // 9). Leaving the snapshot stale makes the next reconcile write the tidy
      // numbers back, so the Sheet ends up showing the order the app really holds.
      const first = db
        .prepare(
          'SELECT video_id FROM project_videos WHERE project_id = ? ORDER BY position, id LIMIT 1'
        )
        .get(projectId);
      db.prepare('UPDATE projects SET video_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(first ? first.video_id : null, projectId);
    });
    apply();

    applied.push(
      `Project #${projectId}: đổi thứ tự phát theo Sheet` +
        (busyProjects.has(projectId) ? ' (cần khởi động lại điểm phát để áp dụng)' : '')
    );
  }

  // Rows the user deleted in the Sheet. Never acted on destructively: deleting an
  // entity is a real operation with SSH side effects, and a live stream must not
  // die because a spreadsheet row vanished.
  for (const [tab, mapper] of Object.entries(MAPPERS)) {
    const sheetKeys = new Set(
      (data[tab]?.rows || []).map((r) => String(r.uuid || '')).filter(Boolean)
    );
    if (!sheetKeys.size) continue; // empty tab: treat as "not synced yet", not "delete all"

    const localRows = db.prepare(`SELECT id, uuid FROM ${mapper.table}`).all();
    for (const local of localRows) {
      if (sheetKeys.has(local.uuid)) continue;
      const isLive =
        (tab === 'Destinations' && activeDests.has(local.id)) ||
        (tab === 'Projects' && busyProjects.has(local.id));
      refused.push(
        `${tab} #${local.id} đã bị xoá trên Sheet nhưng app KHÔNG tự xoá` +
          (isLive ? ' vì đang có live chạy' : '') +
          '. Hãy xoá trong app nếu thật sự muốn.'
      );
      // Put it back so the Sheet matches reality again. Forgetting the snapshot
      // first is what makes this work: the app's record still says the Sheet has
      // this row, so a plain diff would find nothing to send and the row would
      // stay missing.
      snapshotForget(tab, local.uuid);
      push(tab, local.id, { isNew: true });
    }
  }

  if (applied.length || refused.length) {
    logger.info(`Sheets pull: ${applied.length} applied, ${refused.length} refused`);
    for (const message of refused) {
      db.prepare(
        `INSERT INTO activity_logs (type, message, entity_type, entity_id)
         VALUES ('sheet_conflict', ?, NULL, NULL)`
      ).run(message.slice(0, 500));
    }
  }

  return { applied, refused };
}

/**
 * Rebuilds local rows from the Sheet — the missing half of "Sheets is where the data
 * lives".
 *
 * applyPull deliberately never inserts: it exists to carry a human's edits back and
 * must not resurrect something the user deleted in the app. But a fresh install (a
 * clone, a new machine, a rebuilt database) has nothing for those edits to land on,
 * and until now the Sheet could be read and still leave the app empty. This is the
 * explicit, user-triggered restore.
 *
 * Credentials come back with it, because the Sheet now carries them as ciphertext.
 * The SSH password, SSH private key and RTMPS URL are inserted exactly as they were
 * read — this function never re-encrypts, so the blobs stay byte-identical and only
 * APP_ENCRYPTION_KEY can open them. A blob this machine CANNOT decrypt is skipped
 * with a message instead of inserted: a wrong key is worth discovering here, not at
 * air time when a broadcast fails to start.
 *
 * Videos are also left alone: the VPS is the authority on which files exist, and
 * "Làm mới" already adopts them with real probed metadata. Restoring a video row from
 * the Sheet would happily point at a file somebody deleted months ago.
 *
 * Idempotent — a uuid already present is skipped, so it is safe to press twice, and
 * pressing it again after a scan is how the playlist finishes filling in.
 */
function restoreFromSheet(data) {
  if (!data) throw new AppError('Chưa đọc được dữ liệu từ Sheet.', 400);

  const restored = [];
  const skipped = [];
  const manual = [];

  const num = (v) => (v === '' || v == null ? null : Number(v));
  const str = (v) => (v == null ? '' : String(v).trim());

  const has = (table, column, value) =>
    Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value));

  /**
   * A row always keeps the id it has on the Sheet, and is skipped if that id is taken.
   *
   * Renumbering would be easy and wrong. The Sheet's cross-references are numeric —
   * Projects.server_id, Playlist.project_id, Destinations.project_id — so a row given a
   * fresh id here would quietly detach from everything pointing at it. And a
   * destination's id names the systemd unit and env file on the VPS
   * (`live-manager-<id>`, `dest-<id>.env`), so a different number means the app can no
   * longer stop the broadcast the other machine started.
   *
   * The clash only happens when two machines each created a row before either had seen
   * the other's, which the uuid key otherwise handles. Saying so and stopping beats
   * inventing a link that looks right and is not.
   */
  const idClash = (table, id, label) => {
    if (!id || !has(table, 'id', id)) return false;
    skipped.push(
      `${label}: số hiệu #${id} trên máy này đã thuộc về một dòng khác, nên chưa lấy về ` +
        `được. Đây là trường hợp hai máy cùng tạo dữ liệu mới trước khi kịp đồng bộ — ` +
        `hãy xoá một trong hai rồi lấy lại.`
    );
    return true;
  };

  // --- VPS, credentials included. The ciphertext is copied across untouched.
  for (const row of data.Servers?.rows || []) {
    const uuid = str(row.uuid);
    const id = num(row.id);
    if (!uuid || !id || !str(row.host) || !str(row.username)) continue;
    if (has('servers', 'uuid', uuid)) continue;
    if (idClash('servers', id, `VPS "${str(row.name)}"`)) continue;

    const encPassword = str(row.enc_password) || null;
    const encPrivateKey = str(row.enc_private_key) || null;
    const hasCredential = Boolean(encPassword || encPrivateKey);
    const authType = str(row.auth_type) === 'private_key' ? 'private_key' : 'password';

    /**
     * A server the source machine had finished provisioning is ready here too.
     *
     * setup_state gates almost everything — starting a live, uploading, creating a
     * project all check for 'ready' — so leaving it pending would restore a VPS the
     * app then refuses to use. The VPS itself is already set up: the directories,
     * ffmpeg and the installed SSH key are on the remote machine, not on this one.
     * Without a credential there is nothing to be ready with, so it stays pending and
     * the user is told what to type.
     */
    const setupState =
      hasCredential && str(row.setup_state) === 'ready' ? 'ready' : 'pending';

    const info = db
      .prepare(
        `INSERT INTO servers
           (uuid, id, name, host, port, username, auth_type, encrypted_password,
            encrypted_private_key, host_key_fingerprint, setup_state, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        uuid,
        id,
        str(row.name) || str(row.host),
        str(row.host),
        num(row.port) || 22,
        str(row.username),
        authType,
        encPassword,
        encPrivateKey,
        str(row.host_key_fp) || null,
        setupState,
        str(row.note) || null
      );
    restored.push(`VPS #${info.lastInsertRowid} "${str(row.name)}" (${str(row.host)})`);

    if (!hasCredential) {
      manual.push(
        `VPS "${str(row.name)}": trên Sheet chưa có thông tin đăng nhập đã mã hoá. ` +
          `Mở trang VPS, nhập lại mật khẩu root rồi bấm Kiểm tra lại.`
      );
    }
  }

  // --- Projects
  for (const row of data.Projects?.rows || []) {
    const uuid = str(row.uuid);
    const id = num(row.id);
    const serverId = num(row.server_id);
    if (!uuid || !id || !serverId || !str(row.name)) continue;
    if (has('projects', 'uuid', uuid)) continue;
    if (idClash('projects', id, `Project "${str(row.name)}"`)) continue;
    if (!has('servers', 'id', serverId)) {
      skipped.push(`Project #${id} "${str(row.name)}": chưa có VPS #${serverId}`);
      continue;
    }
    db.prepare('INSERT INTO projects (uuid, id, server_id, name, note) VALUES (?, ?, ?, ?, ?)')
      .run(uuid, id, serverId, str(row.name), str(row.note) || null);
    restored.push(`Project #${id} "${str(row.name)}"`);
  }

  /*
   * --- Videos: the VPS says which files EXIST, the Sheet says what they are CALLED.
   *
   * Video rows are still never created here — "Làm mới" adopts them from the VPS with
   * real probed metadata, and inventing one would point at a file somebody deleted
   * months ago. But the VPS only knows a video as `<uuid>.mp4`, because that is how
   * this app names what it uploads. A machine that scans the VPS therefore adopted a
   * video literally called "1e3129d3-3dd6-405a-813f-9a3b5a6342bf.mp4" under a brand
   * new uuid, the playlist below could not match it by name, and the user opened a
   * project the Sheet says has a video and the app showed as empty.
   *
   * adoptVideo now keeps the uuid that is already in the filename, so new scans line
   * up by themselves. This repairs the installs that scanned before that, matching on
   * remote_path — the absolute path on the VPS, identical on every machine and the
   * one thing neither side can rename. Deleting and re-scanning would NOT be a
   * substitute: removing a video here runs `rm -f` on the VPS and would destroy the
   * file itself.
   *
   * Only uuid and name are touched. Size, codec, compliance and the rest are measured
   * from the real file and must never be overwritten by a spreadsheet.
   */
  const looksLikeUuidFilename = (n) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]+$/i.test(n);

  /*
   * One Sheet row per file, preferring the one that carries a real name.
   *
   * A machine that scanned before the fix pushed its own row for the same file, named
   * after the uuid on disk. Two rows, same remote_path — and a name that merely
   * repeats the filename tells us nothing, so it never wins.
   */
  const videoBySheetPath = new Map();
  for (const row of data.Videos?.rows || []) {
    const path = str(row.remote_path);
    const name = str(row.name);
    if (!path || !name || !str(row.uuid)) continue;
    const current = videoBySheetPath.get(path);
    if (!current || (looksLikeUuidFilename(current.name) && !looksLikeUuidFilename(name))) {
      videoBySheetPath.set(path, { uuid: str(row.uuid), name });
    }
  }

  for (const [path, want] of videoBySheetPath) {
    const local = db
      .prepare('SELECT id, uuid, original_name FROM videos WHERE remote_path = ?')
      .get(path);
    if (!local) continue; // not scanned yet, or the file is gone from the VPS

    const fields = [];
    const values = [];

    // Taking the Sheet's uuid is what makes this row the same video everywhere. Only
    // when it is free: a clash means another local row already holds that identity.
    if (local.uuid !== want.uuid && !has('videos', 'uuid', want.uuid)) {
      fields.push('uuid = ?');
      values.push(want.uuid);
    }
    if (local.original_name !== want.name) {
      fields.push('original_name = ?');
      values.push(want.name.slice(0, 200));
    }
    if (!fields.length) continue;

    db.prepare(`UPDATE videos SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...values, local.id);
    restored.push(`Video #${local.id}: lấy lại tên "${want.name}"`);
  }

  // --- Playlist, matched by video NAME.
  //
  // Not by the Sheet's video_id: videos come back through "Làm mới", which mints new
  // ids from the files actually on the VPS. The name is what survives both sides.
  for (const row of data.Playlist?.rows || []) {
    const uuid = str(row.uuid);
    const projectId = num(row.project_id);
    const name = str(row.video_name);
    if (!uuid || !projectId || !name) continue;
    if (has('project_videos', 'uuid', uuid)) continue;
    if (!has('projects', 'id', projectId)) continue;

    const video = db
      .prepare('SELECT id FROM videos WHERE original_name = ? AND server_id = (SELECT server_id FROM projects WHERE id = ?)')
      .get(name, projectId);
    if (!video) {
      skipped.push(`Danh sách phát project #${projectId}: chưa có video "${name}" — bấm Làm mới ở trang Video rồi lấy lại lần nữa`);
      continue;
    }
    const already = db
      .prepare('SELECT 1 FROM project_videos WHERE project_id = ? AND video_id = ?')
      .get(projectId, video.id);
    if (already) continue;

    // The row id is left to SQLite: nothing on the Sheet or the VPS points at a
    // playlist entry by number, so it is the one id that does not have to match.
    db.prepare(
      'INSERT INTO project_videos (uuid, project_id, video_id, position) VALUES (?, ?, ?, ?)'
    ).run(uuid, projectId, video.id, num(row.position) || 0);
    // projects.video_id is the legacy "first video" pointer the unit form still reads.
    db.prepare(
      `UPDATE projects SET video_id = (
         SELECT video_id FROM project_videos WHERE project_id = ? ORDER BY position, id LIMIT 1
       ) WHERE id = ?`
    ).run(projectId, projectId);
    restored.push(`Danh sách phát project #${projectId}: thêm "${name}"`);
  }

  // --- Destinations, stream key included.
  for (const row of data.Destinations?.rows || []) {
    const uuid = str(row.uuid);
    const id = num(row.id);
    const projectId = num(row.project_id);
    const name = str(row.name) || 'Điểm phát Facebook';
    if (!uuid || !id || !projectId) continue;
    if (has('live_destinations', 'uuid', uuid)) continue;
    if (idClash('live_destinations', id, `Điểm phát "${name}"`)) continue;
    if (!has('projects', 'id', projectId)) {
      skipped.push(`Điểm phát #${id} "${name}": chưa có project #${projectId}`);
      continue;
    }

    const encUrl = str(row.enc_rtmps_url);
    if (!encUrl) {
      manual.push(
        `Điểm phát "${name}" (project #${projectId}, key …${str(row.key_masked).replace(/^…/, '')}` +
          `${str(row.loop) ? `, ${str(row.loop)}` : ''}): trên Sheet chưa có Stream key đã ` +
          `mã hoá, hãy tạo lại và dán key vào.`
      );
      continue;
    }

    /**
     * Decrypt before inserting, not to store the result but to prove this machine can
     * read it. `encrypted_rtmps_url` is NOT NULL, so an unreadable blob would insert
     * happily and then fail at air time with an error about the stream, when the real
     * cause is an APP_ENCRYPTION_KEY that does not match the machine that wrote it.
     */
    let url;
    try {
      url = decrypt(encUrl);
    } catch {
      skipped.push(
        `Điểm phát #${id} "${name}": không giải mã được Stream key. ` +
          `APP_ENCRYPTION_KEY trong .env của máy này khác với máy đã tạo điểm phát.`
      );
      continue;
    }

    db.prepare(
      `INSERT INTO live_destinations
         (uuid, id, project_id, name, encrypted_rtmps_url, key_last4, status, systemd_unit,
          auto_refresh_enabled, auto_recover_enabled, runtime_max_seconds,
          loop_mode, loop_count, loop_hours, note)
       VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid,
      id,
      projectId,
      name,
      encUrl,
      keyLast4(url),
      // Derived here rather than trusted from the Sheet so the naming scheme stays
      // owned by one function, and matches the unit the other machine really created.
      `${ffmpeg.unitName(id)}.service`,
      num(row.auto_refresh_enabled) === 0 ? 0 : 1,
      num(row.auto_recover_enabled) === 0 ? 0 : 1,
      num(row.runtime_max_seconds) || config.facebook.defaultRuntimeMaxSeconds,
      ['count', 'hours'].includes(str(row.loop_mode)) ? str(row.loop_mode) : 'infinite',
      num(row.loop_count),
      num(row.loop_hours),
      str(row.note) || null
    );

    /**
     * Deliberately restored as 'stopped' even when the Sheet says 'live'.
     *
     * Only the VPS knows whether FFmpeg is running, and this machine has not asked it
     * yet. Showing green on trust would let the watcher act on a stream it has never
     * seen. `live.refreshProjectStatus` runs `systemctl is-active` and corrects this
     * the moment the project page is opened — or right after this, when the restore
     * was started automatically at boot.
     */
    restored.push(`Điểm phát #${id} "${name}"`);
  }

  // Written to History, not only returned: the redirect can carry counts but not the
  // list, and "what you still have to type in yourself" is the part the user needs to
  // be able to read again later.
  for (const line of manual) {
    db.prepare(
      `INSERT INTO activity_logs (type, message, entity_type, entity_id)
       VALUES ('sheet_restore_manual', ?, NULL, NULL)`
    ).run(line.slice(0, 500));
  }
  for (const line of skipped) {
    db.prepare(
      `INSERT INTO activity_logs (type, message, entity_type, entity_id)
       VALUES ('sheet_restore_skipped', ?, NULL, NULL)`
    ).run(line.slice(0, 500));
  }
  if (restored.length) {
    db.prepare(
      `INSERT INTO activity_logs (type, message, entity_type, entity_id)
       VALUES ('sheet_restore', ?, NULL, NULL)`
    ).run(`Lấy dữ liệu từ Sheet: dựng lại ${restored.length} dòng`.slice(0, 500));
  }
  logger.info(
    `Sheet restore: ${restored.length} restored, ${skipped.length} skipped, ${manual.length} manual`
  );

  return { restored, skipped, manual };
}

/** Pull then apply. Used by the timer, the activity hook and the manual button. */
async function pullAndApply(options = {}) {
  const data = await sheets.pull(options);
  if (!data) return null;
  return applyPull(data);
}

module.exports = {
  MAPPERS,
  catalogueRowCount,
  HUMAN_OWNED,
  TELEMETRY_FIELDS,
  reconcile,
  push,
  pushDelete,
  pushHistory,
  bootstrap,
  applyPull,
  pullAndApply,
  restoreFromSheet,
  snapshotGet,
  snapshotForget,
  snapshotMerge,
  diffRow,
  // exported for tests
  videoRow,
  destinationRow,
  projectRow,
  playlistRow,
  serverRow,
};
