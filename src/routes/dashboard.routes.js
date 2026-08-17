'use strict';

const express = require('express');
const db = require('../db');
const servers = require('../services/server.service');
const projects = require('../services/project.service');
const live = require('../services/live.service');
const uploadService = require('../services/upload.service');
const sheets = require('../services/sheets.service');

/** Result of a manual sync action, carried through the redirect. */
function syncNotice(query) {
  const n = (key) => Number(query[key] || 0);
  switch (query.sync) {
    case 'pulled':
      return {
        tone: n('refused') ? 'warn' : 'ok',
        text:
          `Đã đọc Sheet: áp dụng ${n('applied')} thay đổi` +
          (n('refused') ? `, từ chối ${n('refused')} (xem trang Lịch sử).` : '.'),
      };
    case 'pushed':
      return { tone: 'ok', text: `Đã xếp ${n('rows')} dòng để ghi lên Sheet.` };
    case 'rebuilt':
      return { tone: 'ok', text: `Đã dựng lại Sheet từ đầu với ${n('rows')} dòng.` };
    case 'flushed':
      return { tone: 'ok', text: 'Đã đẩy hàng đợi lên Sheet.' };
    case 'rebuild_needs_confirm':
      return { tone: 'warn', text: 'Chưa dựng lại Sheet: cần gõ đúng XOA để xác nhận.' };
    default:
      return null;
  }
}

const router = express.Router();

function counts() {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    servers: one('SELECT COUNT(*) AS n FROM servers'),
    projects: one('SELECT COUNT(*) AS n FROM projects'),
    videos: one("SELECT COUNT(*) AS n FROM videos WHERE status NOT IN ('error','cancelled')"),
    liveNow: one("SELECT COUNT(*) AS n FROM live_destinations WHERE status IN ('live','starting','refreshing')"),
  };
}

/**
 * Every destination that is up, with the project and video it belongs to.
 *
 * `throughput` is filled from the watcher's last stored sample rather than by
 * opening SSH here — the dashboard should not spend a round trip per card on page
 * load. It refreshes on the next watcher sweep.
 */
function activeLives() {
  return db
    .prepare(
      `SELECT d.*, p.name AS project_name, v.original_name AS video_name
         FROM live_destinations d
         JOIN projects p ON p.id = d.project_id
         LEFT JOIN videos v ON v.id = p.video_id
        WHERE d.status IN ('live','starting','refreshing')
        ORDER BY d.started_at DESC`
    )
    .all()
    .map((row) => ({
      ...live.toView(row),
      projectName: row.project_name,
      videoName: row.video_name,
    }));
}

router.get('/', (req, res) => {
  res.redirect(req.user ? '/dashboard' : '/login');
});

router.get('/dashboard', (req, res) => {
  const stats = counts();

  // Nothing to show on a fresh install, so go straight to onboarding.
  if (stats.servers === 0) return res.redirect('/setup');

  const allServers = servers.list().map(servers.toView);

  res.render('dashboard', {
    title: 'Tổng quan',
    nav: 'dashboard',
    stats,
    servers: allServers,
    lives: activeLives(),
    projects: projects.list().map(projects.toCard),
    egress: uploadService.egressThisMonth(),
    sync: sheets.status(),
    syncNotice: syncNotice(req.query),
    // Surfaced as banners so a problem is visible without opening each page.
    alerts: [
      ...allServers
        .filter((s) => s.setupState === 'failed')
        .map((s) => ({
          tone: 'error',
          text: `VPS "${s.name}" có ${s.problemCount} hạng mục cần xử lý.`,
          href: `/servers/${s.id}`,
        })),
      ...allServers
        .filter((s) => s.disk.known && s.disk.level === 'critical')
        .map((s) => ({
          tone: 'error',
          text: `Ổ đĩa VPS "${s.name}" đã dùng ${s.disk.usedPercent}%. Không tải thêm video được.`,
          href: `/videos?server=${s.id}`,
        })),
      ...allServers
        .filter((s) => s.disk.known && s.disk.level === 'warning')
        .map((s) => ({
          tone: 'warn',
          text: `Ổ đĩa VPS "${s.name}" đã dùng ${s.disk.usedPercent}%.`,
          href: `/videos?server=${s.id}`,
        })),
    ],
  });
});

/** Polled by the dashboard every 15 seconds (spec section 12). */
router.get('/api/dashboard/status', async (req, res) => {
  // Reconcile against the VPS so the count reflects reality, not our cache.
  for (const project of db.prepare('SELECT id FROM projects').all()) {
    await live.refreshProjectStatus(project.id).catch(() => {});
  }
  res.json(counts());
});

module.exports = router;
