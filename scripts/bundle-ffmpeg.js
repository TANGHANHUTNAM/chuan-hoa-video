'use strict';

/**
 * Copies the ffmpeg already installed on this machine into runtime/ffmpeg/, so the
 * packaged folder carries its own copy and the person you hand it to needs nothing
 * installed.
 *
 * Deliberately COPIES rather than downloads. The Node runtime is fetched from
 * nodejs.org because there is an official checksum file to verify against; the
 * common Windows ffmpeg builds have no equivalent guarantee, and downloading ~106 MB
 * of binary on the user's behalf to bundle into something they will redistribute is
 * not a decision this script should make silently. Installing it is one winget
 * command, and this script then packages what the user chose to trust.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'runtime', 'ffmpeg');
const BINARIES = ['ffmpeg', 'ffprobe'];

const say = (line = '') => process.stdout.write(`${line}\n`);

function fail(message) {
  say();
  say(`  DỪNG LẠI: ${message}`);
  say();
  process.exit(1);
}

/** Where is this binary right now? */
function find(binary) {
  const exe = process.platform === 'win32' ? `${binary}.exe` : binary;

  const bundled = path.join(TARGET, exe);
  if (fs.existsSync(bundled)) return { path: bundled, alreadyBundled: true };

  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(finder, [binary], { encoding: 'utf8' });
  if (found.status === 0) {
    const first = String(found.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return { path: first, alreadyBundled: false };
  }
  return null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  say();
  say('  Đóng gói ffmpeg vào runtime/ffmpeg');
  say('  ' + '-'.repeat(58));

  const found = {};
  for (const binary of BINARIES) {
    const hit = find(binary);
    if (!hit) {
      fail(
        `Không tìm thấy ${binary} trên máy này.\n\n` +
          `  Cài một lần bằng lệnh:\n` +
          `    winget install --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements\n\n` +
          `  Rồi MỞ LẠI cửa sổ terminal (winget vừa thêm nó vào PATH) và chạy lại lệnh này.`
      );
    }
    found[binary] = hit;
  }

  fs.mkdirSync(TARGET, { recursive: true });

  let copied = 0;
  let total = 0;
  for (const binary of BINARIES) {
    const src = found[binary].path;
    const exe = process.platform === 'win32' ? `${binary}.exe` : binary;
    const dest = path.join(TARGET, exe);

    if (found[binary].alreadyBundled) {
      const size = fs.statSync(dest).size;
      total += size;
      say(`  ${exe.padEnd(12)} đã có sẵn trong runtime (${(size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }

    fs.copyFileSync(src, dest);
    const size = fs.statSync(dest).size;
    total += size;
    copied += 1;
    say(`  ${exe.padEnd(12)} ${(size / 1024 / 1024).toFixed(1)} MB`);
    say(`  ${' '.repeat(12)} từ ${src}`);
    say(`  ${' '.repeat(12)} sha256 ${sha256(dest).slice(0, 16)}…`);
  }

  // A binary that cannot run is worse than none: the app would find it and fail at
  // the point of use instead of falling back to PATH.
  for (const binary of BINARIES) {
    const exe = process.platform === 'win32' ? `${binary}.exe` : binary;
    const check = spawnSync(path.join(TARGET, exe), ['-hide_banner', '-version'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (check.status !== 0) {
      fail(`${exe} đã copy nhưng không chạy được. Có thể bản cài thiếu DLL đi kèm.`);
    }
    say(`  ${exe.padEnd(12)} chạy được: ${String(check.stdout).split(/\r?\n/)[0].slice(0, 60)}`);
  }

  const encoders = spawnSync(
    path.join(TARGET, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ['-hide_banner', '-encoders'],
    { encoding: 'utf8', timeout: 30_000 }
  );
  const hw = ['h264_nvenc', 'h264_qsv', 'h264_amf'].filter((e) =>
    new RegExp(`\\b${e}\\b`).test(String(encoders.stdout || ''))
  );

  say();
  say(`  Xong. ${copied} file mới, tổng ${(total / 1024 / 1024).toFixed(1)} MB trong runtime/ffmpeg`);
  say(
    hw.length
      ? `  Bộ mã hoá GPU có trong bản build: ${hw.join(', ')}`
      : '  Bản build này không có bộ mã hoá GPU — sẽ dùng libx264 (CPU).'
  );
  say();
  say('  npm run package sẽ kèm thư mục này vào zip, nên người nhận không cần cài ffmpeg.');
  say();
}

main();
