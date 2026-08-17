'use strict';

const sheets = require('../services/sheets.service');

/**
 * Refuses catalogue changes while the Google Sheet is unreachable.
 *
 * The user chose "stop and wait for Sheets" over letting the app and the Sheet
 * drift apart. This is where that choice is enforced — in one table rather than
 * scattered across fourteen handlers, because the interesting part is not the
 * mechanism but WHICH routes are on the list, and that has to be reviewable at a
 * glance.
 *
 * Applies to POST only, and is a no-op unless a Sheet is actually connected.
 */

/**
 * Changes to data the Sheet is the record of. Blocked when Sheets is down.
 */
const GATED = [
  /^\/servers$/, //                                  add a VPS
  /^\/servers\/\d+\/delete$/,
  /^\/projects$/, //                                 create a project
  /^\/projects\/\d+\/delete$/,
  /^\/projects\/\d+\/change-video$/,
  /^\/projects\/\d+\/playlist\/(add|remove|move)$/,
  /^\/projects\/\d+\/lives$/, //                     add a destination
  /^\/lives\/\d+\/(update|delete)$/,
  /^\/videos\/scan$/, //                             adopt files found on the VPS
  /^\/videos\/\d+\/delete$/,
  /^\/api\/videos\/(import|upload)$/,
];

/**
 * Deliberately NOT gated, and this list is the important half.
 *
 * Every route here talks only to the user's own VPS over SSH. Google has no part
 * in whether they work, so making them depend on Google would invent an outage
 * that does not exist:
 *
 *   /lives/:id/start, /stop, /restart, /projects/:id/start-all, /stop-all
 *     Blocking Stop during a Google outage would mean the user cannot take a
 *     broadcast off their own fanpage — with a copyright strike running, that is
 *     the worst possible moment to be told to wait for a spreadsheet.
 *
 *   /videos/cleanup-unused
 *     Frees a full disk. A full disk stops streaming; a stale Sheet does not.
 *
 *   /videos/:id/normalize, /servers/:id/provision, /reinstall-ffmpeg,
 *   /storage/refresh, /api/jobs/:id/cancel
 *     Repair and preparation work needed to get on air.
 *
 * Their effects still reach the Sheet — the changes queue in sheet_outbox and go
 * up when Google answers again. Nothing is lost; it just arrives late.
 */
const UNGATED_BY_DESIGN = [
  '/lives/:id/start',
  '/lives/:id/stop',
  '/lives/:id/restart',
  '/projects/:id/start-all',
  '/projects/:id/stop-all',
  '/videos/cleanup-unused',
  '/videos/:id/normalize',
  '/servers/:id/provision',
  '/servers/:id/reinstall-ffmpeg',
  '/servers/:id/storage/refresh',
  '/api/jobs/:id/cancel',
];

function isGated(method, path) {
  if (method !== 'POST') return false;
  return GATED.some((pattern) => pattern.test(path));
}

async function sheetsGate(req, res, next) {
  if (!isGated(req.method, req.path)) return next();
  try {
    await sheets.assertFresh();
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { sheetsGate, isGated, GATED, UNGATED_BY_DESIGN };
