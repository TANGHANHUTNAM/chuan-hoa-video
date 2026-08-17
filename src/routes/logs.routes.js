'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

const PAGE_SIZE = 60;

/**
 * Grouping for display. Incidents come first because this page is where the
 * watcher's findings surface — there are no outbound notifications, so anything
 * that broke overnight is read here.
 */
const TONES = {
  live_incident: 'error',
  live_stalled: 'error',
  live_recover_failed: 'error',
  server_unreachable: 'error',
  live_failed: 'error',
  video_deleted: 'warn',
  destination_deleted: 'warn',
  server_removed: 'warn',
  project_deleted: 'warn',
  live_stopped: 'warn',
  live_recovered: 'ok',
  server_reachable: 'ok',
  live_started: 'ok',
  // A planned finish is a success, not a warning like a manual Stop — the user
  // should be able to tell "it played the 3 loops I asked for" from "something
  // ended it" at a glance.
  live_finished: 'ok',
  sheet_restore: 'ok',
  sheet_restore_manual: 'warn',
  sheet_restore_skipped: 'warn',
  live_restarted: 'ok',
  server_setup: 'ok',
  server_key_installed: 'ok',
  video_uploaded: 'ok',
  video_optimized: 'ok',
  project_created: 'accent',
  destination_created: 'accent',
  server_connected: 'accent',
};

const LABELS = {
  live_incident: 'Live dừng ngoài ý muốn',
  live_stalled: 'Live bị treo',
  live_recovered: 'Live phục hồi',
  live_recover_failed: 'Tự cứu thất bại',
  server_unreachable: 'Mất kết nối VPS',
  server_reachable: 'VPS kết nối lại',
  live_started: 'Bắt đầu live',
  live_stopped: 'Dừng live',
  live_finished: 'Phát xong',
  sheet_conflict: 'Lệch với Google Sheet',
  sheet_restore: 'Lấy dữ liệu từ Sheet',
  sheet_restore_manual: 'Cần tự nhập lại',
  sheet_restore_skipped: 'Chưa lấy về được',
  live_restarted: 'Khởi động lại live',
  live_failed: 'Không phát được',
  video_uploaded: 'Thêm video',
  video_deleted: 'Xoá video',
  video_optimized: 'Chuẩn hoá video',
  project_created: 'Tạo project',
  project_deleted: 'Xoá project',
  destination_created: 'Thêm điểm phát',
  destination_deleted: 'Xoá điểm phát',
  server_connected: 'Thêm VPS',
  server_setup: 'Chuẩn bị VPS',
  server_key_installed: 'Cài SSH key',
  server_removed: 'Xoá VPS',
};

/** Only the problem categories, for the "chỉ xem sự cố" filter. */
const INCIDENT_TYPES = [
  'live_incident',
  'live_stalled',
  'live_recover_failed',
  'server_unreachable',
  'live_failed',
];

router.get('/logs', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const onlyIncidents = req.query.only === 'incidents';

  const where = onlyIncidents
    ? `WHERE type IN (${INCIDENT_TYPES.map(() => '?').join(',')})`
    : '';
  const params = onlyIncidents ? INCIDENT_TYPES : [];

  const total = db.prepare(`SELECT COUNT(*) AS c FROM activity_logs ${where}`).get(...params).c;
  const rows = db
    .prepare(
      `SELECT * FROM activity_logs ${where}
        ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

  const incidentCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM activity_logs
        WHERE type IN (${INCIDENT_TYPES.map(() => '?').join(',')})`
    )
    .get(...INCIDENT_TYPES).c;

  res.render('logs/index', {
    title: 'Lịch sử',
    nav: 'logs',
    entries: rows.map((row) => ({
      id: row.id,
      type: row.type,
      label: LABELS[row.type] || row.type,
      tone: TONES[row.type] || '',
      message: row.message,
      entityType: row.entity_type,
      entityId: row.entity_id,
      createdAt: row.created_at,
    })),
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total,
    incidentCount,
    onlyIncidents,
  });
});

module.exports = router;
