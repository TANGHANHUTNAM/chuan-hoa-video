/**
 * Facebook Live Manager — cầu nối Google Sheets
 * ================================================================
 *
 * Dán toàn bộ file này vào Apps Script của Google Sheet, đặt TOKEN bên dưới,
 * rồi Deploy thành Web app. Hướng dẫn từng bước ở deploy/apps-script/README.md
 *
 * Vì sao script được viết theo kiểu này:
 *
 * Tài khoản Gmail thường chỉ có 90 PHÚT runtime Apps Script mỗi ngày. Mỗi lần
 * gọi tốn khoảng 1–1,5 giây, nên ngân sách chỉ khoảng 3.600 lần gọi/ngày. Vì vậy
 * script được thiết kế để **một lần gọi làm được nhiều việc**:
 *
 *   - đọc: trả về TẤT CẢ tab trong một lần gọi
 *   - ghi: nhận nhiều dòng của nhiều tab trong một lần gọi, và ghi mỗi tab bằng
 *     đúng MỘT lệnh setValues
 *
 * Tuyệt đối tránh appendRow trong vòng lặp — mỗi lần gọi là một lượt API và sẽ
 * đốt hết quota rất nhanh.
 */

// ============================================================================
// CẤU HÌNH — đổi giá trị này
// ============================================================================

/**
 * Chuỗi bí mật dùng chung. Phải TRÙNG với SHEETS_TOKEN trong file .env của app.
 *
 * Bắt buộc phải đổi: URL của web app này ai có cũng gọi được, nên token là thứ
 * duy nhất ngăn người khác đọc và ghi dữ liệu của bạn.
 *
 * Sinh một chuỗi ngẫu nhiên (chạy trong Terminal):
 *   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
 */
var TOKEN = 'DOI_CHUOI_NAY_THANH_TOKEN_CUA_BAN';

/**
 * Tab mà lệnh `read` KHÔNG đọc, trừ khi app xin đích danh.
 *
 * History chỉ để bạn xem, app không bao giờ cần đọc lại. Mà `read` là thao tác
 * tốn nhiều thời gian nhất (đo thật: ~4,4 giây so với ~2 giây của `write`), nên
 * nếu để History lớn dần theo tháng thì MỌI lần đồng bộ sẽ chậm đi và đốt dần
 * hạn mức 90 phút/ngày. Bỏ nó ra khỏi lệnh đọc giữ chi phí ổn định.
 */
var READ_SKIP = { History: true };

/** Số dòng tối đa giữ lại ở tab History. Cũ hơn thì bị cắt bớt. */
var HISTORY_MAX_ROWS = 500;

/** Các tab script này quản lý. Cột đầu luôn là `id`. */
var TABS = {
  Servers: ['id', 'name', 'host', 'port', 'username', 'os', 'ffmpeg', 'rtmps',
            'disk_used', 'disk_total', 'setup_state', 'note', 'updated_at'],
  Videos: ['id', 'server_id', 'name', 'size', 'duration', 'resolution', 'fps',
           'codec', 'audio', 'keyframe_gap', 'status', 'source', 'remote_path',
           'note', 'updated_at'],
  Projects: ['id', 'server_id', 'name', 'video_count', 'destination_count',
             'note', 'updated_at'],
  Playlist: ['id', 'project_id', 'position', 'video_id', 'video_name', 'updated_at'],
  Destinations: ['id', 'project_id', 'name', 'status', 'key_masked', 'uptime',
                 'throughput', 'auto_refresh', 'loop', 'planned_end',
                 'recover_count', 'note', 'updated_at'],
  History: ['id', 'time', 'type', 'message'],
  Meta: ['id', 'key', 'value', 'updated_at'],
};

// ============================================================================
// Điểm vào
// ============================================================================

/** Mở URL bằng trình duyệt để kiểm tra script đã deploy chưa. */
function doGet() {
  return json({ ok: true, service: 'facebook-live-manager-sheets', tabs: Object.keys(TABS) });
}

function doPost(e) {
  // Google bills SERVER-SIDE script execution time against the daily allowance.
  // The app used to estimate cost from its own wall-clock, which also includes
  // DNS, TLS, the redirect hop and body transfer — over-reporting on a slow
  // connection and under-reporting on a fast one. Returning the real number lets
  // the app budget against what Google actually counts.
  var startedAt = Date.now();

  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }

    // Kiểm token TRƯỚC mọi việc khác.
    if (!TOKEN || TOKEN === 'DOI_CHUOI_NAY_THANH_TOKEN_CUA_BAN') {
      return json({ ok: false, error: 'Chưa đặt TOKEN trong Code.gs' }, 500, startedAt);
    }
    if (!body.token || !safeEqual(String(body.token), TOKEN)) {
      return json({ ok: false, error: 'Token không đúng' }, 403, startedAt);
    }

    switch (body.action) {
      case 'ping':
        return json({ ok: true, now: new Date().toISOString() }, null, startedAt);
      case 'read':
        return json({ ok: true, data: readAll(body.tabs) }, null, startedAt);
      case 'write':
        return json(
          { ok: true, result: writeAll(body.upserts || {}, body.deletes || {}) },
          null,
          startedAt
        );
      case 'reset':
        return json({ ok: true, result: resetTabs(body.tabs) }, null, startedAt);
      default:
        return json({ ok: false, error: 'action không hợp lệ: ' + body.action }, 400, startedAt);
    }
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 500, startedAt);
  }
}

// ============================================================================
// Đọc
// ============================================================================

/**
 * Trả về tất cả tab trong một lần gọi.
 *
 * Mỗi tab đọc bằng đúng một getValues, và bỏ qua dòng có `id` rỗng để người dùng
 * có thể chèn dòng trống hoặc ghi chú bên dưới mà không làm app hiểu sai.
 */
function readAll(onlyTabs) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = {};
  var wanted = null;
  if (onlyTabs && onlyTabs.length) {
    wanted = {};
    for (var w = 0; w < onlyTabs.length; w++) wanted[onlyTabs[w]] = true;
  }

  for (var tab in TABS) {
    // History is skipped unless asked for by name: it is the only tab that grows
    // without bound, and read is the most expensive operation, so including it
    // would make every sync slower month after month.
    if (wanted ? !wanted[tab] : READ_SKIP[tab]) continue;

    var sheet = ss.getSheetByName(tab);
    if (!sheet) {
      out[tab] = { header: TABS[tab], rows: [] };
      continue;
    }

    var values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      out[tab] = { header: TABS[tab], rows: [] };
      continue;
    }

    var header = values[0].map(function (h) { return String(h).trim(); });
    var rows = [];

    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var obj = {};
      var hasId = false;

      for (var c = 0; c < header.length; c++) {
        if (!header[c]) continue;
        var v = row[c];
        if (v instanceof Date) v = v.toISOString();
        obj[header[c]] = v === '' || v === null || v === undefined ? null : v;
      }

      hasId = obj.id !== null && obj.id !== undefined && String(obj.id).trim() !== '';
      if (hasId) rows.push(obj);
    }

    out[tab] = { header: header, rows: rows };
  }

  return out;
}

// ============================================================================
// Ghi
// ============================================================================

/**
 * Ghi nhiều tab trong một lần gọi.
 *
 * @param {Object} upserts  { TênTab: [ {id: 1, ...}, ... ] }
 * @param {Object} deletes  { TênTab: [id, id, ...] }
 *
 * Mỗi tab: đọc một lần, gộp thay đổi trong bộ nhớ, ghi lại bằng một setValues.
 * Cách này giữ số lượt gọi API ở mức 2 lượt mỗi tab bất kể sửa bao nhiêu dòng.
 */
function writeAll(upserts, deletes) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var summary = {};
  var touched = {};

  for (var t in upserts) touched[t] = true;
  for (var t2 in deletes) touched[t2] = true;

  for (var tab in touched) {
    if (!TABS[tab]) continue;

    var sheet = ensureSheet(ss, tab);
    var header = TABS[tab];
    var values = sheet.getDataRange().getValues();

    // Dòng hiện có, theo id.
    var byId = {};
    var order = [];
    for (var r = 1; r < values.length; r++) {
      var id = values[r][0];
      if (id === '' || id === null || id === undefined) continue;
      var key = String(id);
      byId[key] = values[r];
      order.push(key);
    }

    // Xoá.
    var toDelete = deletes[tab] || [];
    for (var d = 0; d < toDelete.length; d++) {
      var dk = String(toDelete[d]);
      if (byId[dk]) {
        delete byId[dk];
        var idx = order.indexOf(dk);
        if (idx !== -1) order.splice(idx, 1);
      }
    }
    summary[tab] = { deleted: toDelete.length, upserted: 0 };

    // Thêm hoặc cập nhật.
    var rows = upserts[tab] || [];
    for (var i = 0; i < rows.length; i++) {
      var incoming = rows[i];
      if (incoming.id === null || incoming.id === undefined) continue;
      var k = String(incoming.id);

      var line = byId[k] ? byId[k].slice() : [];
      // Chuẩn hoá đúng độ dài hàng tiêu đề.
      //
      // Phải CẮT phần dư, không chỉ đệm thêm: nếu người dùng gõ gì vào ô bên
      // phải hàng tiêu đề, dòng đó dài hơn header, và setValues trên vùng rộng
      // đúng header.length sẽ báo "number of columns does not match" — làm MỌI
      // lần ghi sau đó thất bại.
      while (line.length < header.length) line.push('');
      if (line.length > header.length) line.length = header.length;

      for (var c2 = 0; c2 < header.length; c2++) {
        var col = header[c2];
        // Chỉ ghi cột mà app gửi lên. Cột app không gửi (ví dụ `note` do người
        // dùng tự nhập) được giữ nguyên — đây là điều làm cho việc sửa trên
        // Sheet không bị app ghi đè.
        if (Object.prototype.hasOwnProperty.call(incoming, col)) {
          var val = incoming[col];
          line[c2] = val === null || val === undefined ? '' : val;
        }
      }

      if (!byId[k]) order.push(k);
      byId[k] = line;
      summary[tab].upserted++;
    }

    // Cắt bớt History để nó không phình vô hạn. Tab càng lớn thì mọi lần đọc/ghi
    // càng chậm, mà thời gian chạy chính là hạn mức bị tính phí.
    if (tab === 'History' && order.length > HISTORY_MAX_ROWS) {
      order = order.slice(order.length - HISTORY_MAX_ROWS);
      summary[tab].trimmed = true;
    }

    // Ghi lại toàn bộ tab bằng một lệnh.
    var matrix = [header];
    for (var o = 0; o < order.length; o++) matrix.push(byId[order[o]]);

    sheet.clearContents();
    sheet.getRange(1, 1, matrix.length, header.length).setValues(matrix);
    sheet.setFrozenRows(1);
  }

  return summary;
}

/** Tạo lại tab trống kèm hàng tiêu đề. Dùng cho lần khởi tạo đầu. */
function resetTabs(tabs) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var list = tabs && tabs.length ? tabs : Object.keys(TABS);
  var done = [];

  for (var i = 0; i < list.length; i++) {
    var tab = list[i];
    if (!TABS[tab]) continue;
    var sheet = ensureSheet(ss, tab);
    sheet.clear();
    sheet.getRange(1, 1, 1, TABS[tab].length).setValues([TABS[tab]]);
    sheet.setFrozenRows(1);
    done.push(tab);
  }

  return { reset: done };
}

// ============================================================================
// Phụ trợ
// ============================================================================

function ensureSheet(ss, tab) {
  var sheet = ss.getSheetByName(tab);
  if (!sheet) {
    sheet = ss.insertSheet(tab);
    sheet.getRange(1, 1, 1, TABS[tab].length).setValues([TABS[tab]]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  // Tab có sẵn nhưng chưa có tiêu đề.
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, TABS[tab].length).setValues([TABS[tab]]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** So sánh không phụ thuộc độ dài, để không tiết lộ token qua thời gian phản hồi. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(obj, status, startedAt) {
  // Apps Script không cho đặt HTTP status cho web app, nên mã lỗi nằm trong body
  // và client đọc trường `ok`.
  if (status) obj.status = status;
  // Thời gian chạy thật phía Google — đây mới là con số bị trừ vào hạn mức
  // 90 phút/ngày, nên app dùng nó để tính thay vì đo bằng đồng hồ của mình.
  if (startedAt) obj.ms = Date.now() - startedAt;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
