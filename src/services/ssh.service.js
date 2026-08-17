'use strict';

const crypto = require('node:crypto');
const { Client, utils } = require('ssh2');

const db = require('../db');
const { decrypt } = require('./crypto.service');
const { shellEscape } = require('../utils/shell-escape');
const { AppError } = require('../middleware/error-handler');
const logger = require('../utils/logger');

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 20_000;
// Cap captured output so a runaway command cannot exhaust memory.
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Two keepalive profiles, because the right answer differs by workload.
 *
 * SHORT is for commands: a server that stops answering for a minute is broken,
 * and failing fast beats hanging.
 *
 * LONG is for file transfers. ssh2 disconnects after keepaliveCountMax
 * unanswered keepalives, and a busy SFTP channel can legitimately delay its
 * replies — a 60-second budget is why multi-gigabyte uploads were dying partway
 * through. ~60 minutes of tolerance instead.
 */
const KEEPALIVE_SHORT = { keepaliveInterval: 10_000, keepaliveCountMax: 6 };
const KEEPALIVE_LONG = { keepaliveInterval: 15_000, keepaliveCountMax: 240 };

/**
 * OpenSSH-style fingerprint: SHA256:base64 with padding stripped. Matches what
 * `ssh-keyscan`/`ssh-keygen -l` print and what VPS providers show in their
 * console, so the user can compare it by eye.
 */
function fingerprintOf(hostKey) {
  const digest = crypto.createHash('sha256').update(hostKey).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** Turns ssh2/libuv failures into something a non-technical user can act on. */
function friendlySshError(err, target) {
  const raw = err && err.message ? err.message : String(err);
  const code = err && err.code;
  const where = `${target.host}:${target.port}`;

  if (err && err.hostKeyMismatch) return err; // Already a good AppError.

  if (code === 'ECONNREFUSED') {
    return new AppError(
      `VPS ${where} từ chối kết nối. Kiểm tra lại cổng SSH và firewall.`,
      400
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new AppError(`Không tìm thấy địa chỉ ${target.host}. Kiểm tra lại IP hoặc tên miền.`, 400);
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || /timed? ?out/i.test(raw)) {
    return new AppError(
      `Không kết nối được tới VPS ${where}. VPS có thể đang tắt hoặc firewall đang chặn cổng SSH.`,
      400
    );
  }
  if (/All configured authentication methods failed/i.test(raw)) {
    return new AppError(
      `Sai thông tin đăng nhập. Kiểm tra lại username và mật khẩu (hoặc SSH key).`,
      400
    );
  }
  if (/Cannot parse privateKey|Unsupported key format/i.test(raw)) {
    return new AppError(
      `SSH private key không đọc được. Hãy dán đầy đủ nội dung file key, gồm cả dòng BEGIN và END.`,
      400
    );
  }
  if (/encrypted private key|passphrase/i.test(raw)) {
    return new AppError(
      `SSH private key đang được bảo vệ bằng passphrase. Vui lòng dùng key không có passphrase.`,
      400
    );
  }
  return new AppError(`Lỗi SSH tới ${where}: ${raw}`, 400);
}

/**
 * Opens one connection. Callers must always close it — use withConnection()
 * instead of calling this directly (spec section 37: open, execute, close).
 */
function openConnection(target) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) {
        conn.end();
        reject(err);
      } else {
        resolve(value);
      }
    };

    conn.on('ready', () => finish(null, conn));
    conn.on('error', (err) => finish(friendlySshError(err, target)));

    const config = {
      host: target.host,
      port: Number(target.port) || 22,
      username: target.username,
      readyTimeout: READY_TIMEOUT_MS,
      ...(target.keepalive || KEEPALIVE_SHORT),

      /**
       * Trust on first use. ssh2 accepts ANY host key when hostVerifier is
       * absent and has no known_hosts support of its own, so this is the only
       * thing standing between us and a man-in-the-middle.
       */
      hostVerifier: (hostKey, verify) => {
        const fingerprint = fingerprintOf(hostKey);
        target.observedFingerprint = fingerprint;

        if (!target.expectedFingerprint) {
          if (typeof target.onFirstFingerprint === 'function') {
            try {
              target.onFirstFingerprint(fingerprint);
            } catch (err) {
              logger.error('Failed to persist host fingerprint', err);
            }
          }
          return verify(true);
        }

        if (target.expectedFingerprint === fingerprint) return verify(true);

        const mismatch = new AppError(
          `Danh tính SSH của VPS ${target.host} đã thay đổi. ` +
            `Đây có thể là dấu hiệu bị chèn giữa (man-in-the-middle), hoặc VPS đã được cài lại. ` +
            `Nếu bạn vừa cài lại VPS, hãy xoá VPS này khỏi app rồi thêm lại.`,
          409,
          { expected: target.expectedFingerprint, actual: fingerprint }
        );
        mismatch.hostKeyMismatch = true;
        finish(mismatch);
        return verify(false);
      },
    };

    if (target.privateKey) config.privateKey = target.privateKey;
    if (target.password) config.password = target.password;

    if (!config.privateKey && !config.password) {
      return reject(new AppError('Thiếu mật khẩu hoặc SSH key để kết nối VPS.', 400));
    }

    try {
      conn.connect(config);
    } catch (err) {
      finish(friendlySshError(err, target));
    }
  });
}

/** Decrypts a `servers` row into a connection target and wires up TOFU pinning. */
function resolveTarget(server) {
  if (!server) throw new AppError('Không tìm thấy VPS.', 404);

  const target = {
    // Marks this as an already-resolved target. Without it, passing the target
    // back into withConnection/exec would send it through resolveTarget a second
    // time, where the absent encrypted_* fields would silently drop the
    // credentials.
    __isTarget: true,
    host: server.host,
    port: server.port,
    username: server.username,
    expectedFingerprint: server.host_key_fingerprint || null,
    privilegeMode: server.privilege_mode || null,
  };

  if (server.encrypted_private_key) target.privateKey = decrypt(server.encrypted_private_key);
  if (server.encrypted_password) target.password = decrypt(server.encrypted_password);

  // First successful handshake pins the fingerprint for every later connection.
  if (!target.expectedFingerprint && server.id) {
    target.onFirstFingerprint = (fingerprint) => {
      db.prepare(
        `UPDATE servers SET host_key_fingerprint = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND host_key_fingerprint IS NULL`
      ).run(fingerprint, server.id);
      logger.info(`Pinned host key for server ${server.id}: ${fingerprint}`);
    };
  }

  return target;
}

function asTarget(serverOrTarget) {
  // A plain target (from the Add Server form, before a row exists) already has
  // credentials in the clear; a DB row needs decrypting first.
  return serverOrTarget && serverOrTarget.__isTarget
    ? serverOrTarget
    : resolveTarget(serverOrTarget);
}

/** Builds a target from raw form input, for testing a connection pre-save. */
function targetFromInput({ host, port, username, password, privateKey, expectedFingerprint }) {
  return {
    __isTarget: true,
    host,
    port: Number(port) || 22,
    username,
    password: password || undefined,
    privateKey: privateKey || undefined,
    expectedFingerprint: expectedFingerprint || null,
  };
}

/** Opens a connection, runs fn, and always closes it. */
async function withConnection(serverOrTarget, fn) {
  const target = asTarget(serverOrTarget);
  const conn = await openConnection(target);
  try {
    return await fn(conn, target);
  } finally {
    conn.end();
  }
}

function execOnConnection(conn, command, { timeout = DEFAULT_EXEC_TIMEOUT_MS, stdin } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';
      let timer = null;
      let done = false;

      const settle = (fn, arg) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        fn(arg);
      };

      const append = (current, chunk) => {
        const next = current + chunk.toString('utf8');
        // Keep the tail: for a failing command the end of the output is where
        // the actual error message is.
        return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
      };

      if (timeout > 0) {
        timer = setTimeout(() => {
          try {
            stream.close();
          } catch {
            /* already gone */
          }
          settle(reject, new AppError(`Lệnh trên VPS chạy quá ${Math.round(timeout / 1000)}s và đã bị huỷ.`, 504));
        }, timeout);
      }

      stream.on('data', (chunk) => {
        stdout = append(stdout, chunk);
      });
      stream.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk);
      });
      stream.on('close', (code, signal) => {
        settle(resolve, { code: code == null ? -1 : code, signal, stdout, stderr });
      });
      stream.on('error', (streamErr) => settle(reject, streamErr));

      if (stdin != null) {
        stream.write(stdin);
      }
      stream.end();
    });
  });
}

/** Runs one command and returns { code, stdout, stderr }. Does not throw on non-zero exit. */
async function exec(serverOrTarget, command, opts = {}) {
  return withConnection(serverOrTarget, (conn) => execOnConnection(conn, command, opts));
}

/** Runs several commands over a single connection, in order. */
async function execMany(serverOrTarget, commands, opts = {}) {
  return withConnection(serverOrTarget, async (conn) => {
    const results = [];
    for (const command of commands) {
      results.push(await execOnConnection(conn, command, opts));
    }
    return results;
  });
}

/** Like exec() but throws when the command fails, using stderr as the message. */
async function execChecked(serverOrTarget, command, opts = {}) {
  const result = await exec(serverOrTarget, command, opts);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new AppError(`Lệnh trên VPS thất bại: ${detail || `exit code ${result.code}`}`, 400);
  }
  return result;
}

/**
 * Wraps a command so it runs with root privileges, based on what we detected
 * about the account (spec section 14 requires the user never run anything
 * themselves, so we must cope with both root and sudo accounts).
 */
function privilegedCommand(target, command) {
  const mode = target.privilegeMode || (target.username === 'root' ? 'root' : 'sudo_nopasswd');

  switch (mode) {
    case 'root':
      return { command, stdin: undefined };
    case 'sudo_nopasswd':
      return { command: `sudo -n -- /bin/sh -c ${shellEscape(command)}`, stdin: undefined };
    case 'sudo_password':
      if (!target.password) {
        throw new AppError(
          'Tài khoản này cần mật khẩu để dùng sudo, nhưng app không còn lưu mật khẩu. ' +
            'Hãy cập nhật lại mật khẩu cho VPS.',
          400
        );
      }
      // -S reads the password from stdin, -p '' suppresses the prompt text.
      return {
        command: `sudo -S -p '' -- /bin/sh -c ${shellEscape(command)}`,
        stdin: `${target.password}\n`,
      };
    default:
      throw new AppError(
        'Tài khoản SSH này không có quyền quản trị nên app không thể cài đặt trên VPS. ' +
          'Hãy dùng tài khoản root, hoặc bật sudo không cần mật khẩu cho tài khoản này.',
        400
      );
  }
}

async function execPrivileged(serverOrTarget, command, opts = {}) {
  const target = asTarget(serverOrTarget);
  const { command: wrapped, stdin } = privilegedCommand(target, command);
  return exec(target, wrapped, { ...opts, stdin });
}

async function execPrivilegedOnConnection(conn, target, command, opts = {}) {
  const { command: wrapped, stdin } = privilegedCommand(target, command);
  return execOnConnection(conn, wrapped, { ...opts, stdin });
}

/** Detects whether the account is root, has passwordless sudo, or neither. */
async function detectPrivilegeMode(serverOrTarget) {
  const target = asTarget(serverOrTarget);

  return withConnection(target, async (conn) => {
    const idResult = await execOnConnection(conn, 'id -u', { timeout: 15_000 });
    if (idResult.code === 0 && idResult.stdout.trim() === '0') return 'root';

    const sudoNoPass = await execOnConnection(conn, 'sudo -n true 2>&1', { timeout: 15_000 });
    if (sudoNoPass.code === 0) return 'sudo_nopasswd';

    if (target.password) {
      const sudoWithPass = await execOnConnection(
        conn,
        `sudo -S -p '' -- true`,
        { timeout: 15_000, stdin: `${target.password}\n` }
      );
      if (sudoWithPass.code === 0) return 'sudo_password';
    }

    return 'none';
  });
}

/** Opens SFTP over a connection that the caller owns. */
function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

/**
 * Opens a connection plus an SFTP channel and hands both to fn. Unlike exec,
 * uploads legitimately hold a connection open for a long time
 * (spec section 37, exception clause).
 */
async function withSftp(serverOrTarget, fn) {
  // Transfers get the long keepalive budget. Without this a 2 GB upload is
  // dropped mid-flight once the busy channel delays keepalive replies past a
  // minute.
  const target = { ...asTarget(serverOrTarget), keepalive: KEEPALIVE_LONG };

  return withConnection(target, async (conn) => {
    const sftp = await openSftp(conn);
    try {
      return await fn(sftp, conn, target);
    } finally {
      try {
        sftp.end();
      } catch {
        /* connection is closing anyway */
      }
    }
  });
}

/**
 * Writes a file on the VPS by piping base64 through `base64 -d`.
 *
 * Content here includes generated systemd units and files holding stream keys.
 * Base64 contains only [A-Za-z0-9+/=], so nothing in the payload can be
 * interpreted by the shell — stronger than escaping the raw content, which may
 * contain newlines, quotes and $ (spec section 40.11).
 */
async function writeRemoteFile(serverOrTarget, remotePath, content, { mode = '600', privileged = true } = {}) {
  const target = asTarget(serverOrTarget);
  const b64 = Buffer.from(String(content), 'utf8').toString('base64');
  const escapedPath = shellEscape(remotePath);

  // umask keeps the file from ever existing world-readable, even briefly,
  // between creation and chmod.
  const script =
    `umask 077 && printf '%s' ${shellEscape(b64)} | base64 -d > ${escapedPath} && ` +
    `chmod ${shellEscape(mode)} ${escapedPath}`;

  const result = privileged
    ? await execPrivileged(target, script)
    : await exec(target, script);

  if (result.code !== 0) {
    throw new AppError(
      `Không ghi được file ${remotePath} trên VPS: ${(result.stderr || '').trim() || `exit ${result.code}`}`,
      400
    );
  }
  return true;
}

/**
 * Copies a small remote file to local disk.
 *
 * Used for video thumbnails: fetching one once beats opening an SFTP channel
 * every time a page renders a list of videos.
 */
async function downloadRemoteFile(serverOrTarget, remotePath, localPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { pipeline } = require('node:stream/promises');

  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  return withSftp(serverOrTarget, async (sftp) => {
    await pipeline(sftp.createReadStream(remotePath), fs.createWriteStream(localPath));
    return localPath;
  });
}

/**
 * Generates a dedicated ed25519 key pair for one VPS.
 * ssh2 returns both halves already in OpenSSH format, so the user never has to
 * run ssh-keygen or touch a terminal.
 */
function generateKeyPair(comment = 'facebook-live-manager') {
  const keys = utils.generateKeyPairSync('ed25519', { comment });
  return { privateKey: keys.private, publicKey: keys.public.trim() };
}

/** Validates a pasted private key before we store it, so errors surface early. */
function validatePrivateKey(privateKey) {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) {
    if (/encrypted/i.test(parsed.message)) {
      throw new AppError(
        'SSH key này có passphrase. App không thể dùng key có passphrase — hãy tạo key không passphrase.',
        400
      );
    }
    throw new AppError(
      `SSH private key không hợp lệ: ${parsed.message}. Hãy dán đầy đủ nội dung file key.`,
      400
    );
  }
  return { type: parsed.type, comment: parsed.comment || '' };
}

/**
 * Connects and reports what we found, without saving anything.
 * Used by the Test Connection button (spec section 13).
 */
async function testConnection(serverOrTarget) {
  const target = asTarget(serverOrTarget);
  const started = Date.now();

  const results = await withConnection(target, async (conn) => {
    const [uname, osRelease, ffmpeg] = await Promise.all([
      execOnConnection(conn, 'uname -sr', { timeout: 15_000 }),
      execOnConnection(conn, 'cat /etc/os-release 2>/dev/null || true', { timeout: 15_000 }),
      execOnConnection(conn, 'command -v ffmpeg || true', { timeout: 15_000 }),
    ]);
    return { uname, osRelease, ffmpeg };
  });

  const prettyName = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(results.osRelease.stdout);

  return {
    ok: true,
    fingerprint: target.observedFingerprint || null,
    kernel: results.uname.stdout.trim() || null,
    osName: prettyName ? prettyName[1] : results.uname.stdout.trim() || null,
    ffmpegPath: results.ffmpeg.stdout.trim() || null,
    latencyMs: Date.now() - started,
  };
}

module.exports = {
  // Connection primitives
  openConnection,
  withConnection,
  withSftp,
  openSftp,
  targetFromInput,
  resolveTarget,

  // Commands
  exec,
  execMany,
  execChecked,
  execOnConnection,
  execPrivileged,
  execPrivilegedOnConnection,
  detectPrivilegeMode,

  // Files and keys
  writeRemoteFile,
  downloadRemoteFile,
  generateKeyPair,
  validatePrivateKey,

  // Diagnostics
  testConnection,
  fingerprintOf,
  friendlySshError,
};
