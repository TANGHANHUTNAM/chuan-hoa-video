'use strict';

const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');
const jobs = require('./job.service');
const sheets = require('./sheets.service');
const sync = require('./sheets-sync.service');
const provision = require('./provision.service');
const video = require('./video.service');
const live = require('./live.service');

/**
 * Rebuilds an empty install from the Sheet, without anybody pressing anything.
 *
 * This is what makes handing someone your .env enough. Everything needed already
 * existed — restoreFromSheet, the VPS health check, the video scan — but they were
 * five manual steps in a specific order, and getting the order wrong left a half
 * restored app (playlists silently empty, because they match on video name and the
 * videos had not been scanned yet). Here that order is the code.
 *
 * The sequence, and why each step is where it is:
 *
 *   1. restore  — VPS, projects and destinations, credentials included.
 *   2. check    — the VPS health check, which also proves the restored credential
 *                 actually opens an SSH connection. It refills os / ffmpeg / disk,
 *                 which the Sheet carries only as formatted text; without it the
 *                 next push would write this machine's empty values back and blank
 *                 those columns for everyone.
 *   3. scan     — adopt the video files that are on the VPS. The VPS is the
 *                 authority on which files exist, so videos are never restored from
 *                 the Sheet.
 *   4. restore  — again. Playlists match videos by NAME, so they can only be filled
 *                 in once step 3 has given this machine something to match against.
 *   5. status   — ask systemd what is actually running. Destinations restore as
 *                 'stopped' because only the VPS knows, and this is the asking.
 *
 * Guarded on the database being empty, so it can never touch an install in use.
 */

const LOG_TYPE = 'auto_restore';

function logActivity(message) {
  db.prepare(
    `INSERT INTO activity_logs (type, message, entity_type, entity_id)
     VALUES (?, ?, NULL, NULL)`
  ).run(LOG_TYPE, String(message).slice(0, 500));
}

/**
 * Empty means never used, not "the user deleted everything".
 *
 * A server deleted in the app is also deleted on the Sheet by the next reconcile, so
 * there would be nothing to bring back anyway — but the guard is what guarantees a
 * working install is never overwritten by whatever a spreadsheet happens to say.
 */
function shouldRun() {
  if (!config.sheets.enabled) return false;
  if (!config.sheets.autoRestore) return false;
  return db.prepare('SELECT COUNT(*) AS n FROM servers').get().n === 0;
}

/**
 * Scales a sub-worker's 0–100 into a slice of this job's bar.
 *
 * provision.buildWorker reports its own percentages, and letting them through would
 * send the bar back to 4% in the middle of the run.
 */
function band(ctx, from, to, label) {
  return {
    jobId: ctx.jobId,
    cancelled: () => ctx.cancelled(),
    throwIfCancelled: () => ctx.throwIfCancelled(),
    sleep: (ms) => ctx.sleep(ms),
    progress(info = {}) {
      ctx.progress({
        ...info,
        ...(info.percent == null ? {} : { percent: from + ((to - from) * info.percent) / 100 }),
        ...(info.step == null ? {} : { step: `${label}: ${info.step}` }),
      });
    },
  };
}

async function worker(ctx) {
  const notes = [];

  // --- 1. Catalogue -------------------------------------------------------
  ctx.progress({ percent: 4, step: 'Đang đọc dữ liệu từ Google Sheet…' });
  const data = await sheets.pull({ force: true });
  if (!data) throw new Error('Không đọc được dữ liệu từ Google Sheet.');

  ctx.progress({ percent: 12, step: 'Đang dựng lại VPS, project và điểm phát…' });
  const first = sync.restoreFromSheet(data);
  notes.push(`Dựng lại ${first.restored.length} dòng từ Sheet.`);

  const servers = db.prepare('SELECT * FROM servers ORDER BY id').all();
  if (!servers.length) {
    logActivity('Sheet chưa có VPS nào để dựng lại.');
    return;
  }

  // --- 2 & 3. Per VPS: prove the credential works, then adopt its videos ---
  const slice = 60 / servers.length;
  let cursor = 15;

  for (const server of servers) {
    ctx.throwIfCancelled();
    const label = server.name || server.host;

    if (!server.encrypted_password && !server.encrypted_private_key) {
      notes.push(`VPS "${label}": chưa có thông tin đăng nhập trên Sheet, bỏ qua.`);
      cursor += slice;
      continue;
    }

    try {
      await provision.buildWorker(server.id, { installKey: false })(
        band(ctx, cursor, cursor + slice * 0.7, `VPS ${label}`)
      );
    } catch (err) {
      // A VPS that will not answer must not stop the other one from coming back.
      notes.push(`VPS "${label}": kiểm tra thất bại — ${err.message}`);
      cursor += slice;
      continue;
    }

    ctx.progress({
      percent: cursor + slice * 0.7,
      step: `VPS ${label}: đang nhận lại danh sách video…`,
    });
    try {
      // Re-read: the health check above rewrote setup_state and the disk figures.
      const fresh = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
      const scan = await video.scanAndAdopt(fresh);
      notes.push(`VPS "${label}": nhận lại ${scan.adopted.length} video.`);
    } catch (err) {
      notes.push(`VPS "${label}": chưa quét được video — ${err.message}`);
    }
    cursor += slice;
  }

  // --- 4. Playlists, now that the videos exist ----------------------------
  ctx.progress({ percent: 80, step: 'Đang khớp lại danh sách phát…' });
  const second = sync.restoreFromSheet(await sheets.pull({ force: true }));
  notes.push(`Khớp lại danh sách phát: thêm ${second.restored.length} dòng.`);

  // --- 5. What is actually live right now ---------------------------------
  ctx.progress({ percent: 92, step: 'Đang hỏi VPS xem điểm phát nào đang chạy…' });
  for (const project of db.prepare('SELECT id, name FROM projects ORDER BY id').all()) {
    try {
      await live.refreshProjectStatus(project.id);
    } catch (err) {
      notes.push(`Project "${project.name}": chưa đọc được trạng thái live — ${err.message}`);
    }
  }

  ctx.progress({ percent: 100, step: 'Xong' });
  for (const note of notes) logActivity(note);
  logger.info(`Auto-restore finished: ${notes.join(' | ')}`);
}

/**
 * Fire and forget from server.js. Never rejects: a failed restore must not take the
 * app down with it, because the app is still perfectly usable empty.
 */
function start() {
  if (!shouldRun()) return null;

  logger.info('Empty database with a Sheet configured — restoring automatically');
  logActivity('Máy này chưa có dữ liệu nên app đang tự lấy toàn bộ từ Google Sheet về.');

  return jobs.start(
    {
      type: 'restore',
      entityType: null,
      entityId: null,
      step: 'Đang chuẩn bị…',
    },
    (ctx) =>
      worker(ctx).catch((err) => {
        logActivity(`Tự khôi phục thất bại: ${err.message}`);
        logger.warn(`Auto-restore failed: ${err.message}`);
        throw err;
      })
  );
}

module.exports = { start, shouldRun };
