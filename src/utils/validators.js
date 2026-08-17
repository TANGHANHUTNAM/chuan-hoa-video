'use strict';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Accepts an IPv4 address, a bracket-free IPv6 address, or a DNS hostname. */
function isValidHost(host) {
  if (typeof host !== 'string') return false;
  const value = host.trim();
  if (!value || value.length > 253) return false;
  if (IPV4.test(value)) return true;
  // Leave IPv6 validation to Node rather than hand-rolling the grammar.
  if (value.includes(':')) return require('node:net').isIPv6(value);
  return HOSTNAME.test(value);
}

function isValidPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** SSH usernames: conservative, matches what useradd accepts. */
function isValidUsername(username) {
  return typeof username === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/i.test(username.trim());
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.flv', '.m4v', '.ts', '.webm']);

/**
 * We never reuse the uploaded filename on disk (spec section 8) but we still
 * validate the extension so obviously wrong files are rejected before a
 * multi-gigabyte transfer starts.
 */
function videoExtension(filename) {
  const match = /(\.[a-z0-9]+)$/i.exec(String(filename || '').trim());
  if (!match) return null;
  const ext = match[1].toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) ? ext : null;
}

/** Trims and length-caps free text used for display. */
function cleanName(value, maxLength = 100) {
  return String(value ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Only http(s) URLs are accepted for link imports. */
function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Guards every id we interpolate into a systemd unit name (spec section 25). */
function isPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

module.exports = {
  isValidHost,
  isValidPort,
  isValidUsername,
  videoExtension,
  VIDEO_EXTENSIONS,
  cleanName,
  isValidHttpUrl,
  isPositiveInt,
};
