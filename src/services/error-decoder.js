'use strict';

const { maskSecrets } = require('../utils/mask');

/**
 * Translates FFmpeg and systemd output into something the user can act on.
 *
 * This is the layer that delivers on "the user never needs to know Linux": when a
 * stream fails, they should read "Stream key sai" and not
 * "Server error: Failed to publish stream: NetStream.Publish.BadName".
 *
 * Ordered most-specific first; the first match wins.
 */
const RULES = [
  {
    match: /BadName|Failed to publish|already publishing|Publish.*Denied|access denied/i,
    title: 'Stream key không đúng hoặc đã hết hạn',
    message:
      'Facebook từ chối stream key này. Mở lại Facebook Live Producer, lấy Stream key mới ' +
      'rồi bấm Sửa để cập nhật cho điểm phát này.',
    action: 'edit-destination',
  },
  {
    match: /rtmps?.*protocol not found|Protocol not found|Unknown protocol/i,
    title: 'FFmpeg trên VPS không hỗ trợ RTMPS',
    message:
      'Bản FFmpeg đang cài không phát được lên Facebook. Vào trang VPS và bấm "Cài lại FFmpeg".',
    action: 'reinstall-ffmpeg',
  },
  {
    // Deliberately does not match a bare "tls://" in a URL: FFmpeg writes
    // "Cannot open connection tls://host:443" for an ordinary TCP failure, which
    // is a connectivity problem and is handled by the rule below.
    match: /handshake|SSL routines|certificate verif|self.signed|Error in the pull function/i,
    title: 'Không bắt tay bảo mật được với Facebook',
    message:
      'Thường do đồng hồ hệ thống của VPS sai giờ. Vào trang VPS và bấm "Kiểm tra lại" ' +
      'để app đồng bộ lại giờ.',
    action: 'provision',
  },
  {
    match: /Cannot open connection|Connection refused|Network is unreachable|No route to host/i,
    title: 'VPS không kết nối ra được Facebook',
    message:
      'VPS không mở được kết nối tới Facebook ở cổng 443. Kiểm tra firewall của VPS ' +
      'hoặc nhà cung cấp có chặn cổng này không.',
    action: 'provision',
  },
  {
    match: /Temporary failure in name resolution|Name or service not known|Could not resolve/i,
    title: 'VPS không phân giải được tên miền',
    message: 'DNS trên VPS đang lỗi nên không tìm được máy chủ Facebook.',
    action: 'provision',
  },
  {
    match: /No such file or directory|does not exist/i,
    title: 'Không tìm thấy file video trên VPS',
    message:
      'File video đã bị xoá hoặc di chuyển trên VPS. Hãy chọn lại video cho project.',
    action: 'change-video',
  },
  {
    match: /Broken pipe|Connection reset by peer|Error writing trailer|End of file/i,
    title: 'Facebook đã ngắt kết nối',
    message:
      'Kết nối tới Facebook bị ngắt giữa buổi live. Thường do băng thông upload của VPS ' +
      'không đủ. Thử giảm số điểm phát chạy cùng lúc.',
    action: null,
  },
  {
    match: /Invalid data found|moov atom not found|Invalid argument/i,
    title: 'File video bị lỗi',
    message:
      'FFmpeg không đọc được file này. Hãy thử chuẩn hoá lại video, hoặc tải lên bản khác.',
    action: 'normalize',
  },
  {
    match: /Permission denied/i,
    title: 'Không có quyền truy cập file',
    message: 'VPS không đọc được file video. Vào trang VPS và bấm "Kiểm tra lại" để sửa quyền.',
    action: 'provision',
  },
  {
    match: /Cannot allocate memory|out of memory|Killed/i,
    title: 'VPS hết bộ nhớ',
    message:
      'VPS không đủ RAM cho số điểm phát đang chạy. Hãy giảm số điểm phát hoặc nâng cấp VPS.',
    action: null,
  },
  {
    match: /start request repeated too quickly|Start request repeated/i,
    title: 'Live liên tục lỗi nên đã dừng lại',
    message:
      'FFmpeg khởi động lại quá nhiều lần trong thời gian ngắn nên systemd đã dừng. ' +
      'Xem log bên dưới để biết nguyên nhân gốc, thường là stream key sai.',
    action: 'logs',
  },
];

// Warnings that look alarming in the log but are harmless, so they must not be
// reported as the cause of a failure.
const BENIGN = [
  /Non-monotonous DTS/i,
  /Past duration .* too large/i,
  /deprecated pixel format/i,
  /VBV buffer size not set/i,
];

/**
 * @param {string} text raw journal / stderr output
 * @returns {?{title: string, message: string, action: ?string, evidence: string}}
 */
function decode(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  for (const rule of RULES) {
    const found = rule.match.exec(raw);
    if (!found) continue;

    // Keep the matching line as evidence so an advanced user can still see why.
    const line =
      raw
        .split('\n')
        .find((l) => rule.match.test(l)) || found[0];

    return {
      title: rule.title,
      message: rule.message,
      action: rule.action,
      evidence: maskSecrets(line.trim()).slice(0, 300),
    };
  }

  return null;
}

/** True when the log holds nothing but known-harmless warnings. */
function isBenign(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return true;
  return lines.every((line) => BENIGN.some((re) => re.test(line)));
}

module.exports = { decode, isBenign, RULES, BENIGN };
