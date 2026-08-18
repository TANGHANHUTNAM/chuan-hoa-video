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
  // Generated rather than shipped. .env.example is committed, so any password
  // written there is public the moment the repository is.
  const adminPassword = crypto.randomBytes(9).toString('base64url'); // 12 chars

  const content = fs
    .readFileSync(EXAMPLE_PATH, 'utf8')
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${jwtSecret}`)
    .replace(/^APP_ENCRYPTION_KEY=.*$/m, `APP_ENCRYPTION_KEY=${encryptionKey}`)
    .replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${adminPassword}`);

  // Readable only by the current user where the OS supports it.
  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });

  // Printed in BOTH branches on purpose. The launcher passes --quiet and then starts
  // the server itself, so this is the only moment the user is told the password that
  // was just generated for them — staying silent would open a login screen nobody
  // can get past. It is also in .env, which is what the last line points at.
  const email = /^ADMIN_EMAIL=(.*)$/m.exec(content);
  console.log('\n  Tài khoản đăng nhập vừa tạo:');
  console.log(`    Email:      ${(email && email[1].trim()) || '(chưa đặt ADMIN_EMAIL)'}`);
  console.log(`    Mật khẩu:   ${adminPassword}`);
  console.log('    (cả hai nằm trong .env, đổi lúc nào cũng được trước lần chạy đầu)\n');

  // The launcher passes --quiet because it is about to start the server itself;
  // telling the user to run `npm start` there would be wrong.
  if (process.argv.includes('--quiet')) return;

  console.log('  Tiếp theo:');
  console.log('    1. npm start');
  console.log('    2. Mở http://localhost:3000\n');
  console.log('  Lưu ý về .env: đưa nó cho người khác là trao TOÀN QUYỀN — quyền root');
  console.log('  vào VPS và quyền phát live trên kênh của bạn. Chỉ đưa cho người bạn');
  console.log('  thật sự muốn dùng chung dữ liệu, và đừng bao giờ đưa nó lên GitHub.\n');
}

main();
