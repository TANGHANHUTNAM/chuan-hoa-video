'use strict';

const config = require('../config');
const ssh = require('./ssh.service');
const { shellEscape } = require('../utils/shell-escape');
const { isValidHttpUrl } = require('../utils/validators');
const { AppError } = require('../middleware/error-handler');

/**
 * "Nhập video từ link": the VPS downloads the file itself with curl.
 *
 * Why this exists at all (plan R3): pushing a 2 GB video browser -> Render -> VPS
 * spends 2 GB of Render's billable outbound bandwidth, and the Hobby plan only
 * includes 5 GB a month before Render suspends the service. Downloading directly
 * on the VPS costs nothing, takes one hop instead of two, resumes on failure and
 * keeps going if the browser closes.
 */

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

/** Pulls a Google Drive file id out of any of the URL shapes Drive hands out. */
function driveFileId(url) {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]{10,})/,   // /file/d/ID/view
    /\/d\/([a-zA-Z0-9_-]{10,})/,          // /d/ID
    /[?&]id=([a-zA-Z0-9_-]{10,})/,        // ?id=ID, /uc?id=ID, /open?id=ID
  ];
  for (const re of patterns) {
    const m = re.exec(url);
    if (m) return m[1];
  }
  return null;
}

const PROVIDERS = {
  google_drive: {
    label: 'Google Drive',
    matches: (u) => /(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$|(^|\.)drive\.usercontent\.google\.com$/.test(u.hostname),
    rewrite: (u, raw) => {
      const id = driveFileId(raw);
      if (!id) {
        throw new AppError(
          'Không đọc được mã file trong link Google Drive. Hãy dùng link dạng ' +
            'https://drive.google.com/file/d/…/view',
          400
        );
      }
      // The endpoint that serves file bytes directly. confirm=t skips the
      // "virus scan" interstitial that Drive shows for large files and that
      // curl would otherwise save as an HTML page.
      return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
    },
    // Surfaced in the UI, because this is the one provider that can fail in a
    // way the user has to fix on their side.
    note:
      'Google Drive chỉ tải được khi file đã được chia sẻ "Anyone with the link". ' +
      'Với file lớn, Drive đôi khi chặn tải tự động — khi đó hãy dùng Dropbox, ' +
      'OneDrive, link trực tiếp, hoặc tải lên từ máy tính.',
    reliability: 'medium',
  },

  dropbox: {
    label: 'Dropbox',
    matches: (u) => /(^|\.)dropbox\.com$|(^|\.)dropboxusercontent\.com$/.test(u.hostname),
    rewrite: (u) => {
      // dl=1 returns the file itself instead of the preview page.
      u.searchParams.delete('dl');
      u.searchParams.set('dl', '1');
      return u.toString();
    },
    note: null,
    reliability: 'high',
  },

  onedrive: {
    label: 'OneDrive',
    matches: (u) => /(^|\.)1drv\.ms$|(^|\.)onedrive\.live\.com$|(^|\.)sharepoint\.com$/.test(u.hostname),
    rewrite: (u) => {
      u.searchParams.set('download', '1');
      return u.toString();
    },
    note: 'Với OneDrive, hãy dùng link "Anyone with the link can view".',
    reliability: 'high',
  },

  direct: {
    label: 'Link trực tiếp',
    matches: () => true,
    rewrite: (u) => u.toString(),
    note: null,
    reliability: 'high',
  },
};

/**
 * Turns whatever the user pasted into a URL curl can actually fetch.
 * @returns {{url: string, provider: string, label: string, note: ?string, reliability: string}}
 */
function normalizeSourceUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) throw new AppError('Vui lòng dán link video.', 400);
  if (!isValidHttpUrl(raw)) {
    throw new AppError('Link phải bắt đầu bằng http:// hoặc https://', 400);
  }

  const parsed = new URL(raw);

  for (const [key, provider] of Object.entries(PROVIDERS)) {
    if (key === 'direct') continue;
    if (provider.matches(parsed)) {
      return {
        url: provider.rewrite(parsed, raw),
        provider: key,
        label: provider.label,
        note: provider.note,
        reliability: provider.reliability,
      };
    }
  }

  return {
    url: PROVIDERS.direct.rewrite(parsed, raw),
    provider: 'direct',
    label: PROVIDERS.direct.label,
    note: null,
    reliability: 'high',
  };
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/** Reads the last value of a header across curl's redirect chain. */
function lastHeader(headerText, name) {
  const re = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'gim');
  let match;
  let value = null;
  while ((match = re.exec(headerText)) !== null) value = match[1].trim();
  return value;
}

function lastStatus(headerText) {
  const matches = String(headerText).match(/^HTTP\/[\d.]+\s+(\d{3})/gim) || [];
  const last = matches[matches.length - 1];
  return last ? Number(last.match(/(\d{3})/)[1]) : null;
}

function filenameFromHeaders(headerText, url) {
  const disposition = lastHeader(headerText, 'content-disposition');
  if (disposition) {
    const star = /filename\*=(?:UTF-8'')?([^;\r\n]+)/i.exec(disposition);
    if (star) {
      try {
        return decodeURIComponent(star[1].replace(/"/g, ''));
      } catch {
        /* fall through */
      }
    }
    const plain = /filename="?([^";\r\n]+)"?/i.exec(disposition);
    if (plain) return plain[1];
  }
  try {
    const path = new URL(url).pathname;
    const base = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
    if (base && base.includes('.')) return base;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Asks the VPS to fetch just the headers.
 *
 * Probing from the VPS rather than from Render is deliberate: it proves the
 * machine that will do the download can actually reach the URL, and it keeps the
 * bytes off Render entirely.
 */
async function probeUrl(server, rawUrl) {
  const source = normalizeSourceUrl(rawUrl);
  const escaped = shellEscape(source.url);

  // -I first. Some hosts reject HEAD, so fall back to asking for a single byte,
  // which returns the same headers over a normal GET.
  const command =
    `curl -sIL --connect-timeout 10 --max-time 25 ${escaped} 2>/dev/null || true; ` +
    `echo '---SPLIT---'; ` +
    `curl -sL --connect-timeout 10 --max-time 25 -r 0-0 -D - -o /dev/null ${escaped} 2>/dev/null || true`;

  const result = await ssh.exec(server, command, { timeout: 60_000 });
  const [headOut = '', rangeOut = ''] = String(result.stdout).split('---SPLIT---');

  const pick = (name) => lastHeader(headOut, name) || lastHeader(rangeOut, name);
  const status = lastStatus(headOut) || lastStatus(rangeOut);
  const contentType = (pick('content-type') || '').toLowerCase();

  let sizeBytes = null;
  const contentRange = lastHeader(rangeOut, 'content-range'); // "bytes 0-0/2170552320"
  if (contentRange) {
    const total = /\/(\d+)\s*$/.exec(contentRange);
    if (total) sizeBytes = Number(total[1]);
  }
  if (sizeBytes == null) {
    const len = lastHeader(headOut, 'content-length');
    if (len && Number(len) > 1) sizeBytes = Number(len);
  }

  const probe = {
    ...source,
    status,
    contentType: contentType || null,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : null,
    filename: filenameFromHeaders(headOut || rangeOut, source.url),
  };

  if (!status) {
    throw new AppError(
      `VPS không kết nối được tới link này. Kiểm tra lại link, hoặc VPS có thể đang bị chặn ra ngoài internet.`,
      400,
      probe
    );
  }

  if (status >= 400) {
    throw new AppError(
      source.provider === 'google_drive'
        ? `Google Drive trả về lỗi ${status}. File có thể chưa được chia sẻ công khai. ` +
          `Mở Drive → Share → "Anyone with the link".`
        : `Link trả về lỗi ${status}. Kiểm tra lại link hoặc quyền truy cập.`,
      400,
      probe
    );
  }

  // An HTML body means we were served a web page, not a video. For Drive this is
  // the classic "not shared publicly" or "virus scan interstitial" case, and
  // without this check we would happily download an HTML file and hand it to
  // FFmpeg (plan Phần 3, safety layer 2).
  if (contentType.includes('text/html')) {
    throw new AppError(
      source.provider === 'google_drive'
        ? `Google Drive trả về một trang web thay vì file video.\n\n` +
          `Thường là do file chưa được chia sẻ công khai. Hãy mở file trên Drive → ` +
          `Share → chọn "Anyone with the link".\n\n` +
          `Nếu đã chia sẻ mà vẫn lỗi, Drive đang chặn tải tự động với file lớn. ` +
          `Hãy dùng Dropbox, OneDrive, link trực tiếp, hoặc tải lên từ máy tính.`
        : `Link này trả về một trang web, không phải file video. ` +
          `Hãy dùng link tải trực tiếp tới file.`,
      400,
      probe
    );
  }

  return probe;
}

/**
 * Builds the download script that runs on the VPS.
 *
 * The URL goes into a mode-600 file rather than onto a command line, so it
 * cannot be read out of `ps aux` by other users on the machine — link imports
 * often use signed URLs that are credentials in their own right.
 */
function buildDownloadScript({ url, partPath, finalPath }) {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    `URL=${shellEscape(url)}`,
    `PART=${shellEscape(partPath)}`,
    `FINAL=${shellEscape(finalPath)}`,
    '',
    '# -C - resumes a partial file; --retry rides out transient network errors.',
    'curl -fL --retry 5 --retry-delay 3 --retry-connrefused \\',
    '     -C - --connect-timeout 15 --max-time 21600 \\',
    '     -o "$PART" "$URL"',
    '',
    'mv -f "$PART" "$FINAL"',
    '',
  ].join('\n');
}

/** systemd unit name for one video's import. Numeric id only (spec section 25). */
function importUnitName(videoId) {
  return `lm-import-${videoId}`;
}

module.exports = {
  normalizeSourceUrl,
  driveFileId,
  probeUrl,
  buildDownloadScript,
  importUnitName,
  lastHeader,
  lastStatus,
  filenameFromHeaders,
  PROVIDERS,
};
