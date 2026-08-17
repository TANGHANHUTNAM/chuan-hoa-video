'use strict';

/*
 * Downloads a portable Node.js runtime into runtime/ so the app can be handed to
 * someone who has nothing installed.
 *
 *   npm run bundle-runtime
 *
 * Why pin the version we are running: better-sqlite3 is a native addon compiled
 * against one Node ABI. node_modules/ as built on this machine only loads in a
 * Node with the same ABI, so bundling a different version would ship a runtime
 * that cannot open the database.
 *
 * The download is checked against Node's published SHASUMS256.txt. We are about
 * to redistribute an executable to other people; shipping one we never verified
 * would be careless.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');

const VERSION = process.argv[2] || `v${process.versions.node}`;
const ABI = process.versions.modules;

function say(text = '') {
  process.stdout.write(`${text}\n`);
}

function fail(message) {
  say(`\n  ${message}\n`);
  process.exit(1);
}

/** Only Windows is supported for the bundled path; that is who receives this. */
function targetName() {
  if (process.platform !== 'win32') {
    fail(
      `Chức năng này chỉ đóng gói runtime cho Windows.\n` +
        `  Máy hiện tại là ${process.platform}. Người nhận dùng Windows thì hãy chạy lệnh này trên Windows.`
    );
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `node-${VERSION}-win-${arch}`;
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) fail(`Tải thất bại (${response.status}): ${url}`);

  const total = Number(response.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  let lastShown = 0;

  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    // Progress on one rewriting line so a 36 MB download does not look stuck.
    if (total && received - lastShown > 2 * 1024 * 1024) {
      lastShown = received;
      const pct = Math.round((received / total) * 100);
      process.stdout.write(
        `\r  Đang tải... ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)   `
      );
    }
  }
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  const buffer = Buffer.concat(chunks);
  fs.writeFileSync(destination, buffer);
  return buffer;
}

async function fetchExpectedHash(fileName) {
  const response = await fetch(`https://nodejs.org/dist/${VERSION}/SHASUMS256.txt`);
  if (!response.ok) {
    fail(`Không lấy được file checksum của Node ${VERSION} (HTTP ${response.status}).`);
  }
  const text = await response.text();
  const line = text.split('\n').find((l) => l.trim().endsWith(fileName));
  if (!line) fail(`Không tìm thấy ${fileName} trong SHASUMS256.txt.`);
  return line.trim().split(/\s+/)[0];
}

/**
 * Pulls just node.exe and the licence out of the archive.
 *
 * Uses bsdtar (Windows ships it as System32\tar.exe) because it can read zip and
 * extract single members. A Git-Bash GNU tar may shadow it on PATH and cannot
 * read zip, so the Windows copy is named explicitly.
 */
function extract(zipPath, folderName) {
  const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (!fs.existsSync(bsdtar)) fail('Không tìm thấy tar.exe của Windows để giải nén.');

  fs.mkdirSync(RUNTIME, { recursive: true });

  const members = [`${folderName}/node.exe`, `${folderName}/LICENSE`];
  const result = spawnSync(
    bsdtar,
    ['-xf', zipPath, '-C', RUNTIME, '--strip-components=1', ...members],
    { stdio: 'pipe' }
  );

  if (result.status !== 0) {
    fail(`Giải nén thất bại: ${(result.stderr || '').toString().trim().slice(0, 300)}`);
  }
  if (!fs.existsSync(path.join(RUNTIME, 'node.exe'))) {
    fail('Giải nén xong nhưng không thấy node.exe.');
  }
}

/** Proves the bundled runtime can actually load the native addon. */
function verify() {
  const nodeExe = path.join(RUNTIME, 'node.exe');

  const version = spawnSync(nodeExe, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  if (version.status !== 0) fail('node.exe vừa tải về không chạy được.');
  const reported = (version.stdout || '').trim();

  const abi = spawnSync(nodeExe, ['-p', 'process.versions.modules'], { encoding: 'utf8' });
  const reportedAbi = (abi.stdout || '').trim();

  say(`  Runtime: Node v${reported} (ABI ${reportedAbi})`);

  if (reportedAbi !== ABI) {
    fail(
      `ABI không khớp: runtime là ${reportedAbi}, node_modules trên máy này build cho ${ABI}.\n` +
        `  Hãy chạy: npm rebuild   rồi đóng gói lại.`
    );
  }

  // The decisive check: better-sqlite3 is the one native dependency, so if it
  // loads under the bundled runtime, everything will.
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'better-sqlite3'))) {
    const load = spawnSync(
      nodeExe,
      ['-e', "require('better-sqlite3'); console.log('ok')"],
      { cwd: ROOT, encoding: 'utf8' }
    );
    if (load.status !== 0 || !/ok/.test(load.stdout || '')) {
      fail(
        `Runtime chạy được nhưng không load được better-sqlite3:\n` +
          `  ${(load.stderr || '').trim().slice(0, 300)}\n` +
          `  Hãy chạy: npm rebuild better-sqlite3`
      );
    }
    say('  better-sqlite3 load được bằng runtime này: OK');
  } else {
    say('  Chưa có node_modules — hãy chạy npm install rồi chạy lại để kiểm tra.');
  }

  return reported;
}

async function main() {
  const folderName = targetName();
  const fileName = `${folderName}.zip`;
  const url = `https://nodejs.org/dist/${VERSION}/${fileName}`;

  say();
  say(`  Đóng gói Node runtime ${VERSION} (${process.arch}) vào runtime/`);
  say(`  Nguồn: ${url}`);
  say();

  const tmp = path.join(os.tmpdir(), fileName);

  say('  Đang lấy checksum chính thức...');
  const expected = await fetchExpectedHash(fileName);

  const buffer = await download(url, tmp);
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');

  if (actual !== expected) {
    fs.rmSync(tmp, { force: true });
    fail(
      `CHECKSUM KHÔNG KHỚP — không dùng file này.\n` +
        `  Mong đợi: ${expected}\n` +
        `  Thực tế : ${actual}`
    );
  }
  say(`  Checksum khớp: ${expected.slice(0, 24)}…`);

  say('  Đang giải nén node.exe...');
  fs.rmSync(RUNTIME, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  extract(tmp, folderName);
  fs.rmSync(tmp, { force: true });

  const reported = verify();

  fs.writeFileSync(
    path.join(RUNTIME, 'README.txt'),
    [
      'Node.js runtime kèm theo app',
      '='.repeat(60),
      '',
      `Phiên bản: v${reported}`,
      `Nền tảng : win-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
      `ABI      : ${ABI}`,
      `Nguồn    : ${url}`,
      '',
      'Thư mục này chứa Node.js chính thức, tải từ nodejs.org và đã đối chiếu',
      'SHA256 với file SHASUMS256.txt công bố kèm bản phát hành.',
      '',
      'Nhờ có nó, app chạy được mà người dùng không cần cài Node.js.',
      'Đừng xoá thư mục này.',
      '',
      'Node.js phát hành theo giấy phép MIT — xem file LICENSE cùng thư mục.',
      '',
    ].join('\n')
  );

  const size = fs.statSync(path.join(RUNTIME, 'node.exe')).size;
  say();
  say(`  Xong. runtime/node.exe — ${(size / 1024 / 1024).toFixed(0)} MB`);
  say();
  say('  Giờ chạy: npm run package');
  say('  Bản đóng gói sẽ kèm runtime + node_modules, người nhận không cần cài gì.');
  say();
}

main().catch((err) => {
  fail(`Lỗi: ${err && err.message ? err.message : err}`);
});
