'use strict';

/*
 * Double-click launcher, driven by "Bat dau mo app quan ly live facebook.cmd".
 *
 * Everything a non-technical user would otherwise have to type lives here:
 * install dependencies on first run, create .env if missing, start the server,
 * wait for it to answer, open the browser.
 *
 * The logic sits in Node rather than in the .cmd file because cmd.exe parses
 * batch files byte-by-byte and multi-byte UTF-8 characters corrupt its line
 * boundaries — Vietnamese text with diacritics makes a .cmd unrunnable. The .cmd
 * is therefore ASCII-only and does nothing but call this script.
 *
 * Never regenerates an existing .env: replacing APP_ENCRYPTION_KEY would make
 * every stored SSH credential and stream key permanently unreadable.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LINE = '  ' + '='.repeat(58);

function say(text = '') {
  process.stdout.write(`${text}\n`);
}

function banner(lines) {
  say();
  say(LINE);
  for (const line of lines) say(line ? `     ${line}` : '');
  say(LINE);
  say();
}

/** Reads PORT out of .env so a customised port still works. */
function readPort() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const match = /^PORT=(\d+)\s*$/m.exec(fs.readFileSync(envPath, 'utf8'));
    if (match) return Number(match[1]);
  }
  return Number(process.env.PORT) || 3000;
}

/**
 * Fingerprint of this install folder — the same value /health reports, computed the
 * same way, so the two can be compared without sending a path over HTTP.
 */
function instanceId() {
  return require('node:crypto').createHash('sha256').update(ROOT).digest('hex').slice(0, 12);
}

/**
 * Asks whoever holds the port which folder they were started from.
 *
 * Returns null when the answer is unusable — an old build with no `instance` field,
 * or something else entirely on that port. Null means "cannot tell", and the caller
 * then behaves the way it always did rather than blocking on a guess.
 */
async function whoIsOnPort(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    return typeof body.instance === 'string' ? body.instance : null;
  } catch {
    return null;
  }
}

/** True if something is already listening on the port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // The empty string is start's "window title" argument; without it a
      // quoted URL would be treated as the title and no browser would open.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    say(`  Không mở được trình duyệt. Hãy tự mở: ${url}`);
  }
}

/**
 * Runs npm with its output visible.
 *
 * Passed as one command string rather than a command plus args array: npm is
 * npm.cmd on Windows and Node refuses to spawn a .cmd without a shell, but
 * combining an args array with shell:true triggers DEP0190 and prints a
 * deprecation warning over the user's screen. The command is a hardcoded
 * constant with no interpolated input, so there is nothing to escape.
 */
function runNpm(commandLine) {
  const result = spawnSync(commandLine, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  return result.status === 0;
}

/**
 * Whether npm is reachable. A machine running only the bundled runtime has
 * node.exe but no npm, so we must not assume it exists.
 */
function hasNpm() {
  const result = spawnSync('npm -v', { stdio: 'ignore', shell: true });
  return result.status === 0;
}

/** Runs one of our own Node scripts. No shell, so paths with spaces are safe. */
function runNode(scriptPath, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return result.status === 0;
}

async function waitForServer(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    banner([
      'PHIÊN BẢN NODE.JS QUÁ CŨ',
      '',
      `Đang dùng: ${process.version}`,
      'Cần: Node.js 20 trở lên',
      '',
      'Hãy tải bản LTS tại https://nodejs.org rồi mở lại app.',
    ]);
    return 1;
  }

  const port = readPort();
  const url = `http://localhost:${port}`;

  // Already running: bring the window up instead of failing on a port clash — but
  // only after checking it is THIS folder's app. A second copy of the project (a
  // clone, a downloaded zip) defaults to the same port, and silently opening the
  // browser onto the other copy makes its data look like ours: you press "Lấy dữ
  // liệu từ Sheet về" in one folder and inspect the result in the other.
  if (await portInUse(port)) {
    const running = await whoIsOnPort(url);

    if (running && running !== instanceId()) {
      banner([
        `CỔNG ${port} ĐANG ĐƯỢC MỘT BẢN KHÁC DÙNG`,
        '',
        'Có một bản app khác của dự án này đang chạy sẵn ở',
        `http://localhost:${port} — không phải bản trong thư mục này:`,
        '',
        `  ${ROOT}`,
        '',
        'Nếu mở trình duyệt bây giờ, bạn sẽ xem dữ liệu của bản kia.',
        '',
        'Cách xử lý, chọn một trong hai:',
        '  1. Tắt bản kia (đóng cửa sổ đen của nó) rồi bấm đôi lại file này',
        `  2. Mở file .env trong thư mục này, sửa PORT=${port} thành`,
        `     PORT=${port + 1} để hai bản chạy song song`,
      ]);
      return 1;
    }

    say();
    say('  App đang chạy sẵn. Đang mở trình duyệt...');
    say();
    openBrowser(url);
    await new Promise((r) => setTimeout(r, 1500));
    return 0;
  }

  // First run: install dependencies. A package built with the bundled runtime
  // ships node_modules too, so this whole branch is skipped and the app opens
  // straight away with no network needed.
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    if (!hasNpm()) {
      banner([
        'THIẾU THƯ VIỆN VÀ KHÔNG CÓ NPM',
        '',
        'Bản này thiếu thư mục node_modules, mà máy lại không có',
        'npm để tải về.',
        '',
        'Hãy xin lại bản đóng gói đầy đủ từ người gửi cho bạn.',
      ]);
      return 1;
    }

    banner([
      'LẦN ĐẦU CHẠY — ĐANG CÀI ĐẶT',
      '',
      'Việc này mất khoảng 1–2 phút và chỉ làm một lần.',
      'Vui lòng đợi, đừng đóng cửa sổ này.',
    ]);

    if (!runNpm('npm install --no-audit --no-fund')) {
      banner([
        'CÀI ĐẶT KHÔNG THÀNH CÔNG',
        '',
        'Thường do máy không có mạng, hoặc mạng chặn npm.',
        'Hãy kiểm tra kết nối Internet rồi mở lại app.',
      ]);
      return 1;
    }
    say();
    say('  Đã cài xong.');
  }

  // Create .env only when absent — an existing one is left exactly as it is.
  if (!fs.existsSync(path.join(ROOT, '.env'))) {
    say();
    if (!runNode(path.join(ROOT, 'scripts', 'setup.js'), ['--quiet'])) {
      banner([
        'KHÔNG TẠO ĐƯỢC FILE CẤU HÌNH',
        '',
        'Hãy kiểm tra thư mục này có bị khoá quyền ghi hay không,',
        'rồi mở lại app.',
      ]);
      return 1;
    }
  }

  banner([
    'APP ĐANG KHỞI ĐỘNG...',
    '',
    `Địa chỉ: ${url}`,
    '',
    'ĐỂ TẮT APP: đóng cửa sổ này (hoặc bấm Ctrl + C)',
    '',
    'Các buổi live đang phát nằm trên VPS nên vẫn tiếp tục',
    'chạy bình thường kể cả khi app này tắt.',
  ]);

  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  // Open the browser only once the server actually answers, so the user never
  // lands on a connection-refused page.
  waitForServer(port).then((up) => {
    if (up) {
      say();
      say(`  Đang mở trình duyệt: ${url}`);
      say();
      openBrowser(url);
    } else {
      say();
      say(`  Server khởi động chậm hơn bình thường. Hãy tự mở: ${url}`);
      say();
    }
  });

  // Pass Ctrl+C through so the server shuts down cleanly.
  const forward = (signal) => {
    if (!server.killed) server.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  return new Promise((resolve) => {
    server.on('exit', (code) => {
      if (code && code !== 0) {
        banner([
          'APP ĐÃ DỪNG DO LỖI',
          '',
          'Hãy chụp lại phần thông báo phía trên để gửi cho',
          'người hỗ trợ bạn.',
        ]);
      }
      resolve(code || 0);
    });
    server.on('error', (err) => {
      say(`  Không chạy được server: ${err.message}`);
      resolve(1);
    });
  });
}

main()
  .then((code) => {
    // A non-zero exit means the .cmd will pause so the message stays readable.
    process.exitCode = code;
  })
  .catch((err) => {
    say(`  Lỗi không mong muốn: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
