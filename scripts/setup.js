'use strict';

/*
 * First-run setup for someone who just received this folder.
 *
 *   npm run setup
 *
 * Creates .env with freshly generated secrets. Generating JWT_SECRET and a
 * 64-hex APP_ENCRYPTION_KEY by hand is the fiddliest part of getting started, so
 * this does it for them.
 *
 * Never overwrites an existing .env: replacing APP_ENCRYPTION_KEY would make
 * every stored SSH credential and stream key permanently undecryptable.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.error(`\n  Cần Node.js 20 trở lên. Bạn đang dùng ${process.version}.`);
    console.error('  Tải tại https://nodejs.org rồi chạy lại.\n');
    process.exit(1);
  }

  if (fs.existsSync(ENV_PATH)) {
    console.log('\n  .env đã có sẵn — không ghi đè.');
    console.log('  (Đổi APP_ENCRYPTION_KEY sẽ làm mất toàn bộ mật khẩu SSH và Stream key đã lưu.)\n');
    return;
  }

  if (!fs.existsSync(EXAMPLE_PATH)) {
    console.error('\n  Không tìm thấy .env.example. Thư mục có thể bị thiếu file.\n');
    process.exit(1);
  }

  const jwtSecret = crypto.randomBytes(48).toString('hex');
  const encryptionKey = crypto.randomBytes(32).toString('hex'); // 64 hex chars

  const content = fs
    .readFileSync(EXAMPLE_PATH, 'utf8')
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${jwtSecret}`)
    .replace(/^APP_ENCRYPTION_KEY=.*$/m, `APP_ENCRYPTION_KEY=${encryptionKey}`);

  // Readable only by the current user where the OS supports it.
  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });

  // The launcher passes --quiet because it is about to start the server itself;
  // telling the user to run `npm start` there would be wrong.
  if (process.argv.includes('--quiet')) {
    console.log('  Đã tạo file cấu hình với khoá bảo mật mới.');
    return;
  }

  console.log('\n  Đã tạo .env với khoá bí mật mới.\n');
  console.log('  Tiếp theo:');
  console.log('    1. Mở .env và đổi ADMIN_EMAIL / ADMIN_PASSWORD thành của bạn');
  console.log('    2. npm start');
  console.log('    3. Mở http://localhost:3000\n');
  console.log('  Lưu ý: KHÔNG gửi file .env cho ai, và không đưa nó lên GitHub.\n');
}

main();
