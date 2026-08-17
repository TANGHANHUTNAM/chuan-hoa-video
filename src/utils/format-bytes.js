'use strict';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 2170552320 -> "2.02 GB" */
function formatBytes(bytes, decimals = 2) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  let index = 0;
  let value = n;
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  // Whole bytes and KB read better without decimals.
  const places = index <= 1 ? 0 : decimals;
  return `${value.toFixed(places)} ${UNITS[index]}`;
}

/** 5025 -> "01:23:45" */
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, '0')).join(':');
}

const GB = 1024 ** 3;
const gbToBytes = (gb) => Math.round(Number(gb) * GB);

/**
 * Parses a timestamp that may be either an ISO string (what our code writes) or
 * SQLite's "YYYY-MM-DD HH:MM:SS" (what CURRENT_TIMESTAMP writes).
 *
 * The SQLite form has no timezone marker, and Node reads such a string as local
 * time while SQLite generates it in UTC. Left alone that skews every elapsed-time
 * calculation by the machine's offset — enough to make an uptime go negative and
 * silently vanish from the page.
 */
function parseTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value;

  const text = String(value).trim();
  const sqliteForm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text);
  const date = new Date(sqliteForm ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = { formatBytes, formatDuration, gbToBytes, parseTimestamp, GB };
