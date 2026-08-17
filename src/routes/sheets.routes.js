'use strict';

const express = require('express');
const sheets = require('../services/sheets.service');
const sheetsSync = require('../services/sheets-sync.service');

const router = express.Router();

/**
 * Manual controls for the Google Sheet link.
 *
 * Everything here is deliberately user-triggered. The automatic cycles are paced
 * against a 90-minute daily allowance, so the app never spends a call on the
 * chance that the user wants one — but when they ask, the call happens now.
 */

/** Polled by the sync card. Reads local bookkeeping only, so it costs nothing. */
router.get('/api/sheets/status', (req, res) => {
  res.json(sheets.status());
});

/** Reads the Sheet now and applies name / note / order edits. */
router.post('/sheets/pull', async (req, res) => {
  const result = await sheetsSync.pullAndApply({ force: true });
  const applied = result ? result.applied.length : 0;
  const refused = result ? result.refused.length : 0;
  res.redirect(`/dashboard?sync=pulled&applied=${applied}&refused=${refused}`);
});

/**
 * Rebuilds local rows FROM the Sheet — for a fresh install, a new machine, or a
 * rebuilt database.
 *
 * Separate from "Đọc lại từ Sheet" because that one only carries a human's edits onto
 * rows that already exist; it must never resurrect something deleted in the app. This
 * one is the explicit restore, and it is why copying .env alone left a clone empty.
 */
router.post('/sheets/restore', async (req, res) => {
  const data = await sheets.pull({ force: true });
  const result = sheetsSync.restoreFromSheet(data);
  res.redirect(
    `/dashboard?sync=restored&rows=${result.restored.length}` +
      `&skipped=${result.skipped.length}&manual=${result.manual.length}`
  );
});

/** Sends everything the app has, overwriting the Sheet. The drift repair tool. */
router.post('/sheets/push-all', async (req, res) => {
  const result = await sheetsSync.bootstrap();
  res.redirect(`/dashboard?sync=pushed&rows=${result.queued}`);
});

/**
 * Clears the tabs and rewrites them from scratch.
 *
 * Destructive on the Sheet side: any note or name typed there is gone, and
 * Google's revision history is the only way back. Hence the explicit confirm
 * field rather than a plain button.
 */
router.post('/sheets/rebuild', async (req, res) => {
  if (req.body.confirm !== 'XOA') {
    return res.redirect('/dashboard?sync=rebuild_needs_confirm');
  }
  const result = await sheetsSync.bootstrap({ reset: true });
  return res.redirect(`/dashboard?sync=rebuilt&rows=${result.queued}`);
});

/** Pushes whatever is queued right now instead of waiting for the next cycle. */
router.post('/sheets/flush', async (req, res) => {
  await sheets.flush({ force: true });
  res.redirect('/dashboard?sync=flushed');
});

module.exports = router;
