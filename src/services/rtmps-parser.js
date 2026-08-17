'use strict';

const config = require('../config');
const { cleanName } = require('../utils/validators');
const { AppError } = require('../middleware/error-handler');

/**
 * Turns whatever the user copied out of Facebook Live Producer into a usable
 * RTMPS URL.
 *
 * Facebook shows the server URL and the stream key in two separate boxes, and
 * people paste them in every possible combination — sometimes joined, sometimes
 * just the key, sometimes the address of the Live Producer page itself. Handling
 * all of that here is what keeps the user from needing to understand RTMPS.
 */

// e.g. FB-1234567890-0-AbCdEf_gh, and the older keys without the FB- prefix.
const FB_KEY = /^(FB-)?[A-Za-z0-9][A-Za-z0-9_-]{7,}$/;

function stripWrapping(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["'<]+|["'>]+$/g, '')
    .trim();
}

/**
 * @param {string} input   full RTMPS URL, or a bare stream key
 * @param {string} [serverUrl] optional separate "Server URL" field
 * @returns {{url: string, host: string, streamKey: string, warnings: string[]}}
 */
function parseStreamTarget(input, serverUrl) {
  const raw = stripWrapping(input);
  const base = stripWrapping(serverUrl);
  const warnings = [];

  if (!raw && !base) {
    throw new AppError('Vui lòng dán Stream key hoặc RTMPS URL từ Facebook.', 400);
  }

  // Two separate fields, the way Live Producer presents them.
  if (base && raw && !/^rtmps?:\/\//i.test(raw)) {
    return buildFromParts(base, raw, warnings);
  }

  const candidate = raw || base;

  if (/^rtmps?:\/\//i.test(candidate)) return parseFullUrl(candidate, warnings);

  // The single most common mistake: pasting the browser address of the Live
  // Producer page instead of the stream key.
  if (/^https?:\/\//i.test(candidate) || /facebook\.com/i.test(candidate)) {
    throw new AppError(
      'Đây là link trang Facebook, không phải Stream key.\n\n' +
        'Mở Facebook Live Producer → chọn "Use stream key" → copy ô "Stream key" ' +
        '(dạng FB-…) rồi dán vào đây.',
      400
    );
  }

  if (candidate.includes(' ')) {
    throw new AppError(
      'Stream key không được chứa dấu cách. Hãy copy lại đúng ô Stream key từ Facebook.',
      400
    );
  }

  if (!FB_KEY.test(candidate)) {
    throw new AppError(
      `"${candidate.slice(0, 40)}" không giống Stream key của Facebook. ` +
        `Stream key thường có dạng FB-1234567890-0-AbCdEf…`,
      400
    );
  }

  // Bare key: pair it with Facebook's standard ingest endpoint.
  return buildFromParts(config.facebook.defaultRtmpsBase, candidate, warnings);
}

function buildFromParts(serverUrl, streamKey, warnings) {
  let base = stripWrapping(serverUrl);

  if (!/^rtmps?:\/\//i.test(base)) {
    throw new AppError(
      `"${base.slice(0, 40)}" không phải RTMPS URL. URL phải bắt đầu bằng rtmps://`,
      400
    );
  }
  if (/^rtmp:\/\//i.test(base)) {
    base = base.replace(/^rtmp:\/\//i, 'rtmps://');
    warnings.push('Đã chuyển sang rtmps:// vì Facebook chỉ nhận kết nối bảo mật.');
  }

  const key = stripWrapping(streamKey);
  if (!key) throw new AppError('Thiếu Stream key.', 400);

  const url = `${base.replace(/\/+$/, '')}/${key}`;
  return finalize(url, warnings);
}

function parseFullUrl(candidate, warnings) {
  let value = candidate;
  if (/^rtmp:\/\//i.test(value)) {
    value = value.replace(/^rtmp:\/\//i, 'rtmps://');
    warnings.push('Đã chuyển sang rtmps:// vì Facebook chỉ nhận kết nối bảo mật.');
  }
  return finalize(value, warnings);
}

function finalize(url, warnings) {
  let parsed;
  try {
    // The URL parser does not understand rtmps://, so borrow https:// to
    // validate the host and path, then put the scheme back.
    parsed = new URL(url.replace(/^rtmps:\/\//i, 'https://'));
  } catch {
    throw new AppError(`Không đọc được RTMPS URL: ${url.slice(0, 60)}`, 400);
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const streamKey = segments.pop() || '';

  // A URL like rtmps://host/rtmp/ leaves 'rtmp' as the last segment: that is the
  // application path, not a key, so the key is what is actually missing.
  const APP_PATHS = new Set(['rtmp', 'rtmps', 'live', 'app', 'live2']);
  if (!streamKey || (APP_PATHS.has(streamKey.toLowerCase()) && !segments.length)) {
    throw new AppError(
      'RTMPS URL chưa có Stream key ở cuối.\n\n' +
        'Facebook cho bạn hai thứ: Server URL và Stream key. ' +
        'Hãy dán Stream key (dạng FB-…) vào ô này.',
      400
    );
  }
  if (!segments.length) {
    throw new AppError(
      'RTMPS URL thiếu đường dẫn ứng dụng (thường là /rtmp/). ' +
        'Hãy copy lại Server URL từ Facebook.',
      400
    );
  }

  const host = parsed.hostname;
  if (!/facebook\.com$/i.test(host)) {
    warnings.push(
      `Máy chủ "${host}" không phải của Facebook. App vẫn phát được, ` +
        `nhưng hãy kiểm tra lại nếu bạn muốn live lên Facebook.`
    );
  }

  const port = parsed.port || '443';
  const finalUrl = `rtmps://${host}:${port}/${segments.join('/')}/${streamKey}`;

  return { url: finalUrl, host, streamKey, warnings };
}

/**
 * Parses a multi-line paste into several destinations at once, which is how a
 * user with many fanpages sets them all up in one go.
 *
 * Each line may be "Tên | key", "Tên | full url", or just a key/url.
 */
function parseBulk(text, { startIndex = 1 } = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];
  const errors = [];

  lines.forEach((line, i) => {
    // Accept | or tab as the separator; a comma would clash with nothing in a
    // key but is risky in names, so it is not used.
    const separator = line.includes('|') ? '|' : line.includes('\t') ? '\t' : null;
    let name = '';
    let target = line;

    if (separator) {
      const parts = line.split(separator);
      name = cleanName(parts.shift(), 60);
      target = parts.join(separator).trim();
    }

    try {
      const parsed = parseStreamTarget(target);
      rows.push({
        name: name || `Điểm phát ${startIndex + rows.length}`,
        url: parsed.url,
        streamKey: parsed.streamKey,
        host: parsed.host,
        warnings: parsed.warnings,
      });
    } catch (err) {
      errors.push({ line: i + 1, text: line.slice(0, 60), message: err.message });
    }
  });

  if (!rows.length && !errors.length) {
    throw new AppError('Không tìm thấy dòng nào để thêm.', 400);
  }

  return { rows, errors };
}

module.exports = { parseStreamTarget, parseBulk, FB_KEY, stripWrapping };
