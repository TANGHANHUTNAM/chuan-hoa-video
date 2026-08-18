'use strict';

/*
 * Builds the paste-ready copy of the Apps Script bridge.
 *
 *   npm run sheets-script
 *
 * Code.gs is the template and is committed with a placeholder token. This writes
 * Code-DAN-VAO-SHEET.gs next to it with SHEETS_TOKEN from .env already filled in, so
 * updating the Sheet is copy-all, paste, Deploy — no hand-editing a line in the
 * middle of a 400-line file and no chance of pasting a stale copy.
 *
 * The output is gitignored and excluded from `npm run package`: it carries the only
 * thing guarding an unauthenticated web app URL.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'deploy', 'apps-script', 'Code.gs');
const OUTPUT = path.join(ROOT, 'deploy', 'apps-script', 'Code-DAN-VAO-SHEET.gs');
const PLACEHOLDER = 'DOI_CHUOI_NAY_THANH_TOKEN_CUA_BAN';

function main() {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    console.error('\n  Không tìm thấy .env. Chạy `npm run setup` trước.\n');
    process.exit(1);
  }

  const token = (process.env.SHEETS_TOKEN || '').trim();
  if (!token) {
    console.error('\n  .env chưa có SHEETS_TOKEN.');
    console.error('  Sinh một chuỗi ngẫu nhiên rồi dán vào .env:');
    console.error(
      '    node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"\n'
    );
    process.exit(1);
  }

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(PLACEHOLDER)) {
    console.error(`\n  Code.gs không còn chỗ đặt token (${PLACEHOLDER}).\n`);
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT, template.replace(PLACEHOLDER, token), { mode: 0o600 });

  console.log('\n  Đã tạo deploy/apps-script/Code-DAN-VAO-SHEET.gs (token đã điền sẵn).\n');
  console.log('  Tiếp theo:');
  console.log('    1. Mở Google Sheet của bạn → Tiện ích mở rộng → Apps Script');
  console.log('    2. Xoá hết nội dung cũ, dán toàn bộ file này vào');
  console.log('    3. Deploy → Quản lý bản triển khai → sửa bản đang có → Triển khai');
  console.log('       (sửa bản đang có, ĐỪNG tạo bản mới: URL trong .env phải giữ nguyên)');
  console.log('    4. Vào app → Tổng quan → thẻ Google Sheet → "Đẩy toàn bộ lên Sheet"\n');
  console.log('  Bước 4 là bước điền các cột mới vào Sheet.\n');
}

main();
