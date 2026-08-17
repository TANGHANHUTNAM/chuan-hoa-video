'use strict';

/*
 * Builds a clean folder to hand to someone else.
 *
 *   npm run package
 *
 * Produces dist/facebook-live-manager/ plus a .zip of it.
 *
 * The whole reason this script exists instead of "right-click, Send to,
 * Compressed folder": zipping the project directory by hand includes .env and
 * data/live-manager.db. Together those hand over every SSH credential and
 * Facebook stream key you have stored — the database holds them encrypted, and
 * .env holds the key that decrypts them.
 *
 * node_modules is excluded too, and not only for size: better-sqlite3 is a
 * native addon compiled for one OS and Node version, so a copied node_modules
 * would fail on the recipient's machine anyway. They run `npm install`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'facebook-live-manager';
const STAGE = path.join(DIST, NAME);

/**
 * When runtime/node.exe is present the user has deliberately bundled a portable
 * Node (npm run bundle-runtime), and the intent is a package that needs nothing
 * installed. That only works if node_modules ships too — the recipient has no
 * npm to build it with. Having the runtime present is the signal to include both.
 */
const SELF_CONTAINED = fs.existsSync(path.join(ROOT, 'runtime', 'node.exe'));

/**
 * Directories excluded at the PROJECT ROOT only.
 *
 * Anchored to the root deliberately: matching by name at any depth would strip
 * node_modules/<pkg>/dist and node_modules/<pkg>/data, which is how a package
 * ships its actual entry points. Doing that produces a build that installs fine
 * and then crashes with "Cannot find module".
 */
const EXCLUDE_ROOT_DIRS = new Set(
  [
    '.git', 'dist', 'data', '.claude', 'coverage',
  ].concat(SELF_CONTAINED ? [] : ['node_modules', 'runtime'])
);

/** Copied byte-for-byte, with no filtering of any kind. */
const VERBATIM_ROOTS = new Set(['node_modules', 'runtime']);

const EXCLUDE_FILES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.DS_Store',
  // Holds THIS user's Sheet token, pre-filled for convenience. The recipient of a
  // packaged copy has to create their own Sheet anyway, so they want the template
  // (Code.gs) — shipping the filled-in one would hand over a live credential.
  'Code-DAN-VAO-SHEET.gs',
]);
const EXCLUDE_PATTERNS = [
  /\.db(-wal|-shm|-journal)?$/i,
  /\.log$/i,
  /^npm-debug/i,
];

/**
 * Shapes that cannot appear in legitimate source.
 *
 * Deliberately does NOT match secret-*shaped* placeholders: the forms show
 * "FB-1234567890-0-AbCdEf…" as a hint and "-----BEGIN OPENSSH PRIVATE KEY-----"
 * as a textarea placeholder. Flagging those would train the reader to ignore
 * this check. Instead we look for a real PEM body and for our own encrypted
 * blob format, then compare against the actual secrets on this machine.
 */
const SECRET_PATTERNS = [
  {
    name: 'encrypted secret blob (AES-256-GCM payload)',
    re: /\bv1:[A-Za-z0-9+/=]{12,}:[A-Za-z0-9+/=]{12,}:[A-Za-z0-9+/=]{12,}/,
  },
  {
    // A placeholder stops at the BEGIN line; a real key is followed by base64.
    name: 'a real SSH private key body',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n([A-Za-z0-9+/=]{40,}\s*\n){2,}/,
  },
];

/**
 * Reads the real secrets off this machine so we can check for their literal
 * values. Exact comparison, so no false positives and no missed leaks.
 */
// Published in the spec as the starting password, so it is documentation rather
// than a secret. Finding it in source is expected; still using it is worth saying.
const DOCUMENTED_DEFAULTS = new Set(['drnatro123123!']);

function realSecretValues() {
  const values = [];
  const warnings = [];
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return { values, warnings };

  const env = fs.readFileSync(envPath, 'utf8');
  // SHEETS_TOKEN is the ONLY thing guarding an unauthenticated Apps Script URL, and
  // SHEETS_WEBHOOK_URL is the address it guards. Together they are read/write access
  // to the user's spreadsheet, so neither may travel inside a folder handed to
  // someone else — the same rule as the encryption key.
  for (const key of [
    'JWT_SECRET',
    'APP_ENCRYPTION_KEY',
    'ADMIN_PASSWORD',
    'SHEETS_TOKEN',
    'SHEETS_WEBHOOK_URL',
  ]) {
    const match = new RegExp(`^${key}=(.+)$`, 'm').exec(env);
    const value = match && match[1].trim();
    if (!value || value.length < 8 || /^0+$/.test(value)) continue;

    if (DOCUMENTED_DEFAULTS.has(value)) {
      warnings.push(
        `${key} vẫn là mật khẩu mặc định trong spec — ai đọc spec cũng biết. ` +
          `Nên đổi trước khi dùng thật.`
      );
      continue;
    }
    values.push({ name: `giá trị ${key} thật`, value });
  }
  return { values, warnings };
}

/**
 * @param {string} from     absolute source directory
 * @param {string} to       absolute destination directory
 * @param {string} relDir   path relative to the project root ('' at the root)
 * @param {boolean} verbatim copy everything without filtering
 */
function copyTree(from, to, report, relDir = '', verbatim = false) {
  fs.mkdirSync(to, { recursive: true });

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const isDir = entry.isDirectory();
    const atRoot = relDir === '';

    if (!verbatim) {
      // The standalone tool's workspace holds the user's own footage, gigabytes per
      // file, and it is nested rather than at the root — so this match is by NAME at
      // any depth. The tool recreates both folders on first run.
      if (isDir && ['video-can-chuan-hoa', 'video-da-chuan-hoa'].includes(entry.name)) {
        report.skipped.push(`${entry.name}/`);
        continue;
      }
      if (isDir && atRoot && EXCLUDE_ROOT_DIRS.has(entry.name)) {
        report.skipped.push(`${entry.name}/`);
        continue;
      }
      if (!isDir && (EXCLUDE_FILES.has(entry.name) || EXCLUDE_PATTERNS.some((re) => re.test(entry.name)))) {
        report.skipped.push(entry.name);
        continue;
      }
    }

    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);

    if (isDir) {
      // Third-party trees are handed over untouched from here down.
      const childVerbatim = verbatim || (atRoot && VERBATIM_ROOTS.has(entry.name));
      copyTree(src, dest, report, relDir ? `${relDir}/${entry.name}` : entry.name, childVerbatim);
    } else if (entry.isSymbolicLink()) {
      // npm creates symlinks for workspace/bin entries; preserve rather than
      // dereference so a broken link cannot become a copied stub.
      try {
        fs.symlinkSync(fs.readlinkSync(src), dest);
      } catch {
        fs.copyFileSync(src, dest);
      }
      report.files.push(path.relative(STAGE, dest).replace(/\\/g, '/'));
    } else {
      fs.copyFileSync(src, dest);
      report.files.push(path.relative(STAGE, dest).replace(/\\/g, '/'));
      report.bytes += fs.statSync(src).size;
    }
  }
}

/**
 * Reads every staged text file back and fails the build if a secret is present.
 * The exclude list is the intent; this is the check that the intent held.
 */
function auditStage() {
  const findings = [];
  const { values: secrets, warnings } = realSecretValues();
  const TEXT = /\.(js|json|ejs|css|md|sql|txt|yaml|yml|example|gitignore)$/i;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(STAGE, full).replace(/\\/g, '/');

      // Structural check: these files must simply not be here. Cannot
      // false-positive. .env.example is required by `npm run setup`, so it is
      // matched exactly rather than by prefix.
      const isRealEnv = entry.name === '.env' || /^\.env\.(local|production)$/.test(entry.name);
      if (isRealEnv || /\.db(-wal|-shm|-journal)?$/i.test(entry.name)) {
        findings.push(`${rel} — file này không được có trong bản đóng gói`);
        continue;
      }

      // Third-party trees are not ours to audit line by line, and scanning tens
      // of thousands of files would make this unusably slow. The structural
      // check above still applies to them.
      if (rel.startsWith('node_modules/') || rel.startsWith('runtime/')) continue;

      if (!TEXT.test(entry.name)) continue;

      const text = fs.readFileSync(full, 'utf8');

      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(text)) findings.push(`${rel} — chứa ${name}`);
      }
      // The decisive check: does this file contain one of my actual secrets?
      for (const { name, value } of secrets) {
        if (text.includes(value)) findings.push(`${rel} — chứa ${name}`);
      }
    }
  };

  walk(STAGE);
  return { findings, warnings, checkedAgainst: secrets.length };
}

/**
 * Tools are tried in order of how portable their output is.
 *
 * Windows PowerShell 5.1's Compress-Archive writes entry paths with backslashes,
 * which is not valid zip and makes `unzip` on macOS/Linux complain. pwsh 7 and
 * bsdtar both write proper forward slashes, so they come first and 5.1 is only a
 * last resort before falling back to a tarball.
 */
function makeZip(zipPath) {
  const attempts = [
    {
      label: 'PowerShell 7 Compress-Archive',
      run: () =>
        execFileSync(
          'pwsh',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Compress-Archive -Path '${STAGE}' -DestinationPath '${zipPath}' -Force`,
          ],
          { stdio: 'pipe' }
        ),
    },
    {
      // Info-ZIP on macOS/Linux.
      label: 'zip',
      run: () => execFileSync('zip', ['-r', '-q', zipPath, NAME], { cwd: DIST, stdio: 'pipe' }),
    },
    {
      // bsdtar/libarchive can write zip. Windows 10+ ships it as tar.exe, but a
      // Git-Bash GNU tar may shadow it on PATH and GNU tar cannot write zip, so
      // the Windows copy is named explicitly.
      label: 'bsdtar',
      run: () => {
        const bsdtar =
          process.platform === 'win32'
            ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
            : 'tar';
        execFileSync(bsdtar, ['-a', '-c', '-f', zipPath, NAME], { cwd: DIST, stdio: 'pipe' });
      },
    },
    {
      label: 'Windows PowerShell Compress-Archive',
      run: () =>
        execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Compress-Archive -Path '${STAGE}' -DestinationPath '${zipPath}' -Force`,
          ],
          { stdio: 'pipe' }
        ),
    },
  ];

  for (const attempt of attempts) {
    try {
      attempt.run();
      if (fs.existsSync(zipPath)) return attempt.label;
    } catch {
      // Try the next tool.
    }
  }

  // Last resort: a tarball, which every platform can produce.
  const tarPath = zipPath.replace(/\.zip$/, '.tar.gz');
  try {
    execFileSync('tar', ['-czf', tarPath, NAME], { cwd: DIST, stdio: 'pipe' });
    if (fs.existsSync(tarPath)) return `tar (${path.basename(tarPath)})`;
  } catch {
    /* fall through */
  }

  return null;
}

/**
 * Clears the output directory.
 *
 * Retries because this project may sit inside OneDrive/Dropbox, whose sync agent
 * holds handles on files it has just uploaded and makes deletion fail with
 * EPERM. If the directory itself cannot go, emptying it is good enough.
 */
function resetDist() {
  try {
    fs.rmSync(DIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;

    let emptied = true;
    for (const entry of fs.readdirSync(DIST, { withFileTypes: true })) {
      try {
        fs.rmSync(path.join(DIST, entry.name), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 250,
        });
      } catch {
        emptied = false;
      }
    }

    if (!emptied) {
      console.error(
        `\n  Không dọn được thư mục dist/ — có thể OneDrive hoặc một chương trình khác đang giữ file.\n` +
          `  Hãy đóng các cửa sổ đang mở thư mục đó rồi chạy lại, hoặc xoá dist/ thủ công.\n`
      );
      process.exit(1);
    }
  }
}

function main() {
  console.log('\n  Đang đóng gói…\n');

  if (fs.existsSync(DIST)) resetDist();
  fs.mkdirSync(STAGE, { recursive: true });

  const report = { files: [], skipped: [], bytes: 0 };
  copyTree(ROOT, STAGE, report);

  // A short quick-start for whoever opens the folder first.
  fs.writeFileSync(
    path.join(STAGE, 'BAT-DAU-TU-DAY.txt'),
    [
      'FACEBOOK LIVE MANAGER — BẮT ĐẦU TỪ ĐÂY',
      '='.repeat(60),
      '',
      'TRONG THƯ MỤC NÀY CÓ HAI APP. Bấm đôi để mở:',
      '',
      '   1) Bat dau mo app quan ly live facebook.cmd   — quản lý VPS và phát live',
      '   2) Bat dau mo app chuan hoa video.cmd         — chuẩn hoá video trên máy này',
      '',
      ...(SELF_CONTAINED
        ? ['App mở sau vài giây và trình duyệt tự bật lên.']
        : [
            'Lần đầu sẽ mất 1–2 phút để tự cài đặt, sau đó trình duyệt',
            'tự mở ra. Những lần sau chỉ vài giây.',
          ]),
      '',
      'ĐỂ TẮT APP: đóng cửa sổ màu đen đó.',
      '',
      'Hai app chạy độc lập, mở cùng lúc được.',
      '',
      'CHUẨN HOÁ VIDEO',
      '-'.repeat(60),
      'Facebook cần video H.264 + AAC, keyframe mỗi 2 giây. Video xuất từ',
      'phần mềm dựng thường không đạt, và app sẽ báo "CẦN CHUẨN HOÁ".',
      '',
      'Cách làm:',
      '   1. Copy video vào thư mục  video-can-chuan-hoa',
      '   2. Bấm đôi                 Bat dau mo app chuan hoa video.cmd',
      '   3. Chọn độ phân giải rồi bấm Chuẩn hoá',
      '   4. Kết quả nằm ở thư mục   video-da-chuan-hoa',
      '   5. Copy file đó lên VPS, rồi bấm "Làm mới" ở trang Video',
      '',
      'Việc này chạy trên MÁY NÀY, không chạy trên VPS: VPS 2 core mất',
      'khoảng 1 giờ cho video 26 phút, máy tính thường mất khoảng 10 phút,',
      'và CPU của VPS còn phải phục vụ các buổi live đang phát.',
      '',
      'Buổi live đang phát nằm trên VPS nên vẫn chạy bình thường',
      'kể cả khi app này tắt hoặc máy tính tắt.',
      '',
      'CẦN CÓ TRƯỚC',
      '-'.repeat(60),
      ...(SELF_CONTAINED
        ? [
            'Chỉ cần một VPS Ubuntu có SSH',
            '(IP + mật khẩu root do nhà cung cấp VPS gửi cho bạn).',
            '',
            'KHÔNG cần cài Node.js hay bất cứ thứ gì khác — bản này đã',
            'kèm sẵn đầy đủ. Lần mở app đầu tiên cũng không cần mạng.',
          ]
        : [
            '1. Node.js 20 trở lên — tải bản LTS ở https://nodejs.org',
            '   (nếu chưa có, file .cmd sẽ tự mở trang tải giúp bạn)',
            '2. Một VPS Ubuntu có SSH (IP + mật khẩu root từ nhà cung cấp)',
          ]),
      '',
      'NẾU WINDOWS CHẶN FILE',
      '-'.repeat(60),
      'File tải từ mạng có thể bị Windows chặn. Nếu gặp:',
      'bấm chuột phải vào file .cmd → Properties → tích "Unblock" → OK.',
      '',
      'ĐĂNG NHẬP',
      '-'.repeat(60),
      'Dùng ADMIN_EMAIL / ADMIN_PASSWORD trong file .env',
      '(file này được tạo tự động ở lần mở app đầu tiên).',
      'Nên đổi mật khẩu đó thành của riêng bạn.',
      '',
      'NẾU BẠN ĐƯỢC CHO FILE .env CỦA MÁY CŨ',
      '-'.repeat(60),
      'Copy .env vào thư mục này rồi mở app. Danh sách VPS / video',
      'sẽ TRỐNG, vì dữ liệu nằm trong data/app.db chứ không nằm trong',
      '.env. Nếu máy cũ có bật Google Sheet thì dựng lại như sau:',
      '',
      '   1. Trang Tổng quan → thẻ Google Sheet →',
      '      bấm "Lấy dữ liệu từ Sheet về"   (có lại VPS + project)',
      '   2. Trang VPS → nhập lại mật khẩu root → "Kiểm tra lại"',
      '   3. Trang Video → "Làm mới"          (nhận lại file trên VPS)',
      '   4. Bấm "Lấy dữ liệu từ Sheet về" lần nữa (khớp danh sách phát)',
      '   5. Tạo lại điểm phát và dán Stream key',
      '',
      'Mật khẩu VPS và Stream key phải nhập tay vì hai thứ đó không',
      'bao giờ được ghi lên Sheet — Sheet chỉ lưu 4 ký tự cuối.',
      '',
      'LƯU Ý BẢO MẬT',
      '-'.repeat(60),
      'File .env chứa khoá mã hoá của riêng bạn. Đừng gửi cho ai,',
      'đừng đưa lên GitHub. Nếu đổi APP_ENCRYPTION_KEY thì mọi mật',
      'khẩu SSH và Stream key đã lưu sẽ không đọc lại được.',
      '',
      'Đọc README.md để biết chi tiết và cách deploy lên Render.',
      '',
    ].join('\n')
  );
  report.files.push('BAT-DAU-TU-DAY.txt');

  // Verify the intent held before producing anything shippable.
  const { findings, warnings, checkedAgainst } = auditStage();
  if (findings.length) {
    console.error('  DỪNG LẠI — phát hiện dữ liệu bí mật trong bản đóng gói:\n');
    for (const f of findings) console.error(`    ✕ ${f}`);
    console.error('\n  Không tạo file zip. Hãy xử lý các mục trên rồi chạy lại.\n');
    process.exit(1);
  }

  const zipPath = path.join(DIST, `${NAME}.zip`);
  const tool = makeZip(zipPath);

  const mb = (report.bytes / 1024 / 1024).toFixed(2);
  console.log(`  Đã copy ${report.files.length} file (${mb} MB)`);
  console.log(`  Đã loại bỏ: ${[...new Set(report.skipped)].join(', ')}`);
  console.log(
    SELF_CONTAINED
      ? '  Kèm Node runtime + node_modules: người nhận KHÔNG cần cài gì'
      : '  Không kèm runtime: người nhận cần có Node.js (chạy npm run bundle-runtime để kèm)'
  );
  console.log(
    `  Kiểm tra bí mật: sạch ` +
      `(đối chiếu với ${checkedAgainst} giá trị thật trong .env của bạn)`
  );
  for (const w of warnings) console.log(`  Lưu ý: ${w}`);
  console.log('');

  if (tool) {
    const finalPath = fs.existsSync(zipPath)
      ? zipPath
      : zipPath.replace(/\.zip$/, '.tar.gz');
    const sizeMb = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(2);
    console.log(`  Xong: ${path.relative(ROOT, finalPath)} (${sizeMb} MB, dùng ${tool})`);
  } else {
    console.log(`  Xong: ${path.relative(ROOT, STAGE)}`);
    console.log('  (Không nén được tự động — bạn có thể tự nén thư mục này.)');
  }

  console.log('\n  Gửi file đó cho người khác. Họ chỉ cần:');
  if (SELF_CONTAINED) {
    console.log('    giải nén  →  bấm đôi vào "Bat dau mo app quan ly live facebook.cmd"');
    console.log('             hoặc "Bat dau mo app chuan hoa video.cmd" để chuẩn hoá video');
    console.log('    (không cần cài Node.js, không cần mạng lúc mở app)\n');
  } else {
    console.log('    giải nén  →  bấm đôi vào "Bat dau mo app quan ly live facebook.cmd"');
    console.log('    (máy họ cần có Node.js; lần đầu mở sẽ tự cài thư viện)\n');
  }
}

main();
