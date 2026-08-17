'use strict';

const db = require('../db');
const config = require('../config');
const ssh = require('./ssh.service');
const { formatBytes, gbToBytes, GB } = require('../utils/format-bytes');
const { AppError } = require('../middleware/error-handler');

/**
 * Disk accounting for the user's VPS (spec sections 15, 16, 34).
 *
 * The rule that matters: never let an upload fill the disk, because a full disk
 * takes down every FFmpeg process already streaming from it.
 */

const DF_COMMAND =
  `df -Pk ${config.remote.base} 2>/dev/null || df -Pk /`;

/** Parses `df -Pk` output. Sizes come back in 1024-byte blocks. */
function parseDf(output) {
  const lines = String(output || '')
    .trim()
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length < 2) return null;

  // Take the last line: some filesystems wrap the device name onto its own line.
  const fields = lines[lines.length - 1].trim().split(/\s+/);
  if (fields.length < 5) return null;

  const blocks = Number(fields[fields.length - 5]);
  const used = Number(fields[fields.length - 4]);
  const available = Number(fields[fields.length - 3]);
  if (!Number.isFinite(blocks) || !Number.isFinite(available)) return null;

  return {
    totalBytes: blocks * 1024,
    usedBytes: used * 1024,
    availableBytes: available * 1024,
    mountedOn: fields[fields.length - 1],
  };
}

/**
 * Storage Safety Rule (spec section 16):
 *   reserve      = max(5 GB, total * 10%)
 *   usable free  = max(0, available - reserve)
 */
function computeSafety(totalBytes, availableBytes) {
  const total = Number(totalBytes) || 0;
  const available = Number(availableBytes) || 0;

  const reserveBytes = Math.max(
    gbToBytes(config.storage.reserveMinGb),
    Math.floor(total * (config.storage.reservePercent / 100))
  );
  const usableFreeBytes = Math.max(0, available - reserveBytes);

  const usedPercent = total > 0 ? Math.round(((total - available) / total) * 100) : 0;
  const level = usedPercent >= 90 ? 'critical' : usedPercent >= 80 ? 'warning' : 'normal';

  return { reserveBytes, usableFreeBytes, usedPercent, level, totalBytes: total, availableBytes: available };
}

/** Reads live disk numbers over SSH. Never trust the cached DB copy for this. */
async function queryStorage(server) {
  const result = await ssh.exec(server, DF_COMMAND, { timeout: 20_000 });
  const parsed = parseDf(result.stdout);
  if (!parsed) {
    throw new AppError('Không đọc được dung lượng ổ đĩa của VPS.', 400, {
      stderr: (result.stderr || '').slice(0, 400),
    });
  }
  return parsed;
}

function persistStorage(serverId, parsed) {
  db.prepare(
    `UPDATE servers
        SET total_bytes = ?, used_bytes = ?, available_bytes = ?,
            last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(parsed.totalBytes, parsed.usedBytes, parsed.availableBytes, serverId);
}

/** Queries the VPS and updates the cached snapshot. */
async function refresh(server) {
  const parsed = await queryStorage(server);
  persistStorage(server.id, parsed);
  return { ...parsed, ...computeSafety(parsed.totalBytes, parsed.availableBytes) };
}

/** Safety view built from the cached snapshot, for rendering pages. */
function fromCache(server) {
  const safety = computeSafety(server.total_bytes, server.available_bytes);
  return {
    ...safety,
    usedBytes: server.used_bytes || 0,
    known: server.total_bytes != null,
    lastCheckedAt: server.last_checked_at,
  };
}

/**
 * Decides whether a file of this size may be written, given a disk reading.
 *
 * Kept pure and separate from the SSH call so the policy can be tested and so
 * the link-import path can reuse it while a download is in flight.
 */
function evaluatePreflight(safety, fileSizeBytes, usedBytes = 0) {
  const size = Number(fileSizeBytes);
  const maxUploadBytes = gbToBytes(config.storage.maxUploadGb);

  const base = {
    ...safety,
    usedBytes,
    fileSizeBytes: Number.isFinite(size) && size > 0 ? size : null,
  };

  if (!Number.isFinite(size) || size <= 0) {
    return {
      ...base,
      allowed: false,
      reason: 'unknown_size',
      message: 'Không xác định được dung lượng file nên không thể kiểm tra ổ đĩa.',
    };
  }

  // Disk space is checked first: it is the physical constraint, and it is the
  // one the user can act on by deleting old videos. The app-level cap is a
  // secondary guard and would otherwise mask the more useful explanation.
  if (size > safety.usableFreeBytes) {
    return {
      ...base,
      allowed: false,
      reason: 'insufficient_space',
      // Spelled out because the user cannot see the VPS themselves (spec section 16).
      message:
        `Không đủ dung lượng VPS.\n\n` +
        `Dung lượng còn trống: ${formatBytes(safety.availableBytes)}\n` +
        `Dung lượng dự phòng bắt buộc: ${formatBytes(safety.reserveBytes)}\n` +
        `Có thể sử dụng: ${formatBytes(safety.usableFreeBytes)}\n` +
        `Video cần thêm: ${formatBytes(size)}\n\n` +
        `Vui lòng xoá video cũ hoặc tăng dung lượng VPS.`,
    };
  }

  if (size > maxUploadBytes) {
    return {
      ...base,
      allowed: false,
      reason: 'over_max',
      message:
        `File ${formatBytes(size)} vượt giới hạn ${config.storage.maxUploadGb} GB mỗi video của app. ` +
        `Hãy nén video nhỏ hơn hoặc tăng MAX_UPLOAD_GB.`,
    };
  }

  return { ...base, allowed: true, reason: null, message: null };
}

/**
 * The preflight gate (spec sections 17B, 45): always asks the VPS for real
 * numbers rather than trusting the cached snapshot, then applies the policy.
 */
async function preflight(server, fileSizeBytes) {
  const parsed = await queryStorage(server);
  persistStorage(server.id, parsed);
  const safety = computeSafety(parsed.totalBytes, parsed.availableBytes);
  return evaluatePreflight(safety, fileSizeBytes, parsed.usedBytes);
}

module.exports = {
  parseDf,
  computeSafety,
  evaluatePreflight,
  queryStorage,
  refresh,
  fromCache,
  preflight,
  persistStorage,
  DF_COMMAND,
  GB,
};
