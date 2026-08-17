'use strict';

const db = require('../db');
const config = require('../config');
const ssh = require('./ssh.service');
const jobs = require('./job.service');
const storage = require('./storage.service');
const { encrypt } = require('./crypto.service');
const { shellEscape } = require('../utils/shell-escape');
const { formatBytes } = require('../utils/format-bytes');
const { AppError } = require('../middleware/error-handler');
const logger = require('../utils/logger');

/**
 * Turns a bare Ubuntu VPS into something that can stream, without the user ever
 * seeing a Linux command (spec section 14, plan Phần 4).
 *
 * Everything here is idempotent: pressing "Chuẩn bị VPS" a second time is safe
 * and is also how the per-row fix buttons work.
 */

// Declared in display order. `blocking` marks the checks that must pass before
// a live stream can possibly work.
const CHECK_DEFS = [
  { key: 'ssh', name: 'Kết nối SSH', blocking: true },
  { key: 'privilege', name: 'Quyền quản trị trên VPS', blocking: true },
  { key: 'os', name: 'Hệ điều hành', blocking: false },
  { key: 'app_key', name: 'SSH key riêng cho app', blocking: false },
  { key: 'systemd', name: 'systemd (giữ live chạy 24/7)', blocking: true },
  { key: 'ffmpeg', name: 'FFmpeg', blocking: true },
  { key: 'rtmps', name: 'FFmpeg hỗ trợ RTMPS (Facebook)', blocking: true },
  { key: 'clock', name: 'Đồng hồ hệ thống', blocking: false },
  { key: 'facebook', name: 'Kết nối tới Facebook', blocking: false },
  { key: 'storage', name: 'Thư mục lưu video & dung lượng', blocking: true },
];

const CHECK_ORDER = CHECK_DEFS.map((c) => c.key);
const BLOCKING = new Set(CHECK_DEFS.filter((c) => c.blocking).map((c) => c.key));

function makeCheck(key, status, detail, extra = {}) {
  const def = CHECK_DEFS.find((c) => c.key === key);
  return { key, name: def ? def.name : key, status, detail: detail || '', ...extra };
}

// ---------------------------------------------------------------------------
// Individual probes. Each takes an open connection so one provision run needs
// only one SSH handshake.
// ---------------------------------------------------------------------------

async function probePrivilege(conn, target) {
  const id = await ssh.execOnConnection(conn, 'id -u', { timeout: 15_000 });
  if (id.code === 0 && id.stdout.trim() === '0') return 'root';

  const sudoNoPass = await ssh.execOnConnection(conn, 'sudo -n true', { timeout: 15_000 });
  if (sudoNoPass.code === 0) return 'sudo_nopasswd';

  if (target.password) {
    const withPass = await ssh.execOnConnection(conn, `sudo -S -p '' -- true`, {
      timeout: 15_000,
      stdin: `${target.password}\n`,
    });
    if (withPass.code === 0) return 'sudo_password';
  }

  return 'none';
}

function parseOsRelease(text) {
  const read = (key) => {
    const m = new RegExp(`^${key}=\\"?([^\\"\\n]*)\\"?`, 'm').exec(text || '');
    return m ? m[1] : null;
  };
  return {
    id: read('ID'),
    versionId: read('VERSION_ID'),
    prettyName: read('PRETTY_NAME'),
  };
}

/**
 * Installs a dedicated ed25519 key so the app stops depending on the password.
 *
 * Runs unprivileged on purpose: with sudo, $HOME would resolve to /root and the
 * key would land in the wrong account.
 */
async function installAppKey(conn, target, publicKey) {
  const pk = shellEscape(publicKey);
  const script = [
    'set -e',
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    'chmod 600 "$HOME/.ssh/authorized_keys"',
    `if ! grep -qxF ${pk} "$HOME/.ssh/authorized_keys"; then printf '%s\\n' ${pk} >> "$HOME/.ssh/authorized_keys"; fi`,
  ].join('; ');

  const result = await ssh.execOnConnection(conn, script, { timeout: 20_000 });
  if (result.code !== 0) {
    throw new AppError(
      `Không cài được SSH key lên VPS: ${(result.stderr || '').trim() || `exit ${result.code}`}`,
      400
    );
  }
}

/**
 * Creates the directory layout (spec section 8).
 *
 * The video directories are chowned to the SSH user because uploads arrive over
 * SFTP as that user; without this, a non-root account could not write into a
 * root-owned /opt/live-manager. /etc/live-manager stays root-only — it holds
 * stream keys and is only ever written through a privileged command.
 */
async function ensureDirectories(conn, target) {
  const { videos, temp, logs, secrets } = config.remote;
  const owner = shellEscape(`${target.username}:${target.username}`);

  const script = [
    'set -e',
    `mkdir -p ${shellEscape(videos)} ${shellEscape(temp)} ${shellEscape(logs)}`,
    `chown -R ${owner} ${shellEscape(config.remote.base)}`,
    `chmod 755 ${shellEscape(config.remote.base)}`,
    `mkdir -p ${shellEscape(secrets)}`,
    `chmod 700 ${shellEscape(secrets)}`,
  ].join('; ');

  const result = await ssh.execPrivilegedOnConnection(conn, target, script, { timeout: 30_000 });
  if (result.code !== 0) {
    throw new AppError(
      `Không tạo được thư mục trên VPS: ${(result.stderr || '').trim() || `exit ${result.code}`}`,
      400
    );
  }
}

async function detectFfmpeg(conn) {
  const which = await ssh.execOnConnection(conn, 'command -v ffmpeg 2>/dev/null || true', {
    timeout: 15_000,
  });
  const path = which.stdout.trim();
  if (!path) return { installed: false, path: null, version: null };

  const version = await ssh.execOnConnection(
    conn,
    'ffmpeg -version 2>/dev/null | head -n 1',
    { timeout: 20_000 }
  );
  return { installed: true, path, version: version.stdout.trim() || null };
}

async function installFfmpeg(conn, target) {
  // Lock::Timeout copes with unattended-upgrades holding the apt lock, which is
  // common on a freshly created VPS and otherwise fails the install outright.
  const script = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get -o DPkg::Lock::Timeout=180 update -qq',
    'apt-get -o DPkg::Lock::Timeout=180 install -y -qq ffmpeg',
  ].join('; ');

  return ssh.execPrivilegedOnConnection(conn, target, script, { timeout: 600_000 });
}

/**
 * Facebook only accepts RTMPS. Whether a given FFmpeg build can speak it depends
 * on how it was compiled, so we ask the binary instead of assuming (plan R6).
 */
async function detectRtmps(conn) {
  const result = await ssh.execOnConnection(conn, 'ffmpeg -hide_banner -protocols 2>/dev/null', {
    timeout: 20_000,
  });
  return /(^|\s)rtmps(\s|$)/m.test(result.stdout || '');
}

/**
 * A wrong clock breaks the TLS handshake to Facebook with an error that looks
 * nothing like "your clock is wrong", so we measure the skew directly.
 */
async function probeClock(conn) {
  const [remote, ntp] = await Promise.all([
    ssh.execOnConnection(conn, 'date -u +%s', { timeout: 15_000 }),
    ssh.execOnConnection(
      conn,
      'timedatectl show -p NTPSynchronized --value 2>/dev/null || true',
      { timeout: 15_000 }
    ),
  ]);

  const remoteEpoch = Number(remote.stdout.trim());
  const skewSeconds = Number.isFinite(remoteEpoch)
    ? Math.abs(remoteEpoch - Math.floor(Date.now() / 1000))
    : null;

  return {
    skewSeconds,
    ntpSynchronized: ntp.stdout.trim() === 'yes',
  };
}

/**
 * One curl to the ingest host proves DNS, routing, port 443 and the TLS
 * handshake all work — the whole path a live stream depends on.
 */
async function probeFacebook(conn) {
  const url = `https://${config.facebook.ingestHost}/`;
  const result = await ssh.execOnConnection(
    conn,
    `curl -sS -o /dev/null --connect-timeout 8 --max-time 15 ${shellEscape(url)}`,
    { timeout: 25_000 }
  );

  const REASONS = {
    6: 'VPS không phân giải được tên miền của Facebook (lỗi DNS).',
    7: 'VPS không kết nối được tới Facebook ở cổng 443 (firewall đang chặn).',
    28: 'Kết nối tới Facebook bị timeout.',
    35: 'Bắt tay TLS với Facebook thất bại. Thường do đồng hồ hệ thống sai giờ.',
    60: 'Chứng chỉ TLS không được chấp nhận. Kiểm tra đồng hồ và ca-certificates.',
  };

  return {
    ok: result.code === 0,
    code: result.code,
    reason: result.code === 0 ? null : REASONS[result.code] || (result.stderr || '').trim(),
  };
}

async function probeCapacity(conn) {
  const [nic, cores, ram] = await Promise.all([
    // Virtual NICs often report -1 or nothing at all; treat that as unknown.
    ssh.execOnConnection(conn, "cat /sys/class/net/*/speed 2>/dev/null | sort -rn | head -n 1 || true", {
      timeout: 15_000,
    }),
    ssh.execOnConnection(conn, 'nproc 2>/dev/null || true', { timeout: 15_000 }),
    ssh.execOnConnection(conn, "free -m 2>/dev/null | awk '/^Mem:/{print $2}' || true", {
      timeout: 15_000,
    }),
  ]);

  const speed = Number(nic.stdout.trim());
  return {
    nicSpeedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
    cpuCores: Number(cores.stdout.trim()) || null,
    ramTotalMb: Number(ram.stdout.trim()) || null,
  };
}

/** Rough guidance on how many simultaneous destinations the uplink can carry. */
function capacityAdvice(nicSpeedMbps) {
  if (!nicSpeedMbps) return null;
  const perLiveMbps = 4.5; // Facebook's recommended ceiling.
  // Leave headroom; a link saturated to 100% drops frames.
  const maxLives = Math.max(1, Math.floor((nicSpeedMbps * 0.7) / perLiveMbps));
  return { nicSpeedMbps, maxLives };
}

// ---------------------------------------------------------------------------
// The provision job
// ---------------------------------------------------------------------------

function loadServer(serverId) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) throw new AppError('Không tìm thấy VPS.', 404);
  return server;
}

function saveChecks(serverId, checks, setupState) {
  const ordered = CHECK_ORDER.map((key) => checks[key]).filter(Boolean);
  db.prepare(
    `UPDATE servers SET checks_json = ?, setup_state = ?, status = ?,
            last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(
    JSON.stringify(ordered),
    setupState,
    setupState === 'ready' ? 'connected' : 'error',
    serverId
  );
}

function logActivity(type, message, entityId) {
  db.prepare(
    `INSERT INTO activity_logs (type, message, entity_type, entity_id) VALUES (?, ?, 'server', ?)`
  ).run(type, message, entityId);
}

/**
 * The worker behind [Kết nối & Chuẩn bị VPS].
 *
 * @param {number} serverId
 * @param {{installKey?: boolean, reinstallFfmpeg?: boolean}} opts
 */
function buildWorker(serverId, opts = {}) {
  const installKey = opts.installKey !== false;

  async function runProvision(ctx) {
    const server = loadServer(serverId);
    const checks = {};
    const target = ssh.resolveTarget(server);

    db.prepare(`UPDATE servers SET setup_state = 'provisioning' WHERE id = ?`).run(serverId);

    ctx.progress({ percent: 4, step: 'Đang kết nối SSH tới VPS…' });

    await ssh.withConnection(target, async (conn) => {
      checks.ssh = makeCheck(
        'ssh',
        'ok',
        `Đã kết nối ${target.username}@${target.host}:${target.port}`,
        { fingerprint: target.observedFingerprint || server.host_key_fingerprint }
      );

      // --- privileges -------------------------------------------------------
      ctx.progress({ percent: 12, step: 'Đang kiểm tra quyền quản trị…' });
      const privilegeMode = await probePrivilege(conn, target);
      target.privilegeMode = privilegeMode;
      db.prepare('UPDATE servers SET privilege_mode = ? WHERE id = ?').run(privilegeMode, serverId);

      if (privilegeMode === 'none') {
        checks.privilege = makeCheck(
          'privilege',
          'error',
          'Tài khoản này không có quyền quản trị nên app không thể cài đặt gì trên VPS. ' +
            'Hãy dùng tài khoản root, hoặc cấp quyền sudo không cần mật khẩu cho tài khoản này.'
        );
        // Nothing further can succeed, so stop with a clear reason.
        for (const key of CHECK_ORDER) {
          if (!checks[key]) checks[key] = makeCheck(key, 'skipped', 'Chưa kiểm tra được.');
        }
        saveChecks(serverId, checks, 'failed');
        throw new AppError(
          'Tài khoản SSH không có quyền quản trị. Hãy dùng root hoặc bật sudo không cần mật khẩu.',
          400
        );
      }

      const privilegeLabel = {
        root: 'Đăng nhập bằng root',
        sudo_nopasswd: 'Dùng sudo không cần mật khẩu',
        sudo_password: 'Dùng sudo kèm mật khẩu',
      }[privilegeMode];
      checks.privilege = makeCheck('privilege', 'ok', privilegeLabel);

      // --- operating system -------------------------------------------------
      ctx.progress({ percent: 18, step: 'Đang đọc thông tin hệ điều hành…' });
      const osRaw = await ssh.execOnConnection(conn, 'cat /etc/os-release 2>/dev/null || true', {
        timeout: 15_000,
      });
      const os = parseOsRelease(osRaw.stdout);
      const supported = ['ubuntu', 'debian'].includes((os.id || '').toLowerCase());
      checks.os = makeCheck(
        'os',
        supported ? 'ok' : 'warn',
        supported
          ? os.prettyName || 'Ubuntu/Debian'
          : `${os.prettyName || 'Không xác định'} — app được thiết kế cho Ubuntu/Debian, ` +
            `các bản khác có thể không cài được FFmpeg tự động.`
      );
      db.prepare('UPDATE servers SET os_name = ? WHERE id = ?').run(os.prettyName || null, serverId);

      // --- dedicated SSH key ------------------------------------------------
      ctx.progress({ percent: 26, step: 'Đang cài SSH key riêng cho app…' });
      if (server.key_installed_at && server.encrypted_private_key) {
        checks.app_key = makeCheck(
          'app_key',
          'ok',
          `Đã dùng SSH key riêng của app (cài ngày ${String(server.key_installed_at).slice(0, 10)})`
        );
      } else if (!installKey) {
        checks.app_key = makeCheck(
          'app_key',
          'warn',
          'Đang dùng thông tin đăng nhập bạn cung cấp. Bật "Tự tạo SSH key riêng" để app dùng key riêng.'
        );
      } else {
        const keyPair = ssh.generateKeyPair(`facebook-live-manager-server-${serverId}`);
        await installAppKey(conn, target, keyPair.publicKey);

        // Prove the key actually authenticates BEFORE trusting it. Saving the
        // key and dropping the password first could lock us out of the VPS.
        const verifyTarget = ssh.targetFromInput({
          host: server.host,
          port: server.port,
          username: server.username,
          privateKey: keyPair.privateKey,
          expectedFingerprint: server.host_key_fingerprint || target.observedFingerprint,
        });

        try {
          await ssh.withConnection(verifyTarget, (verifyConn) =>
            ssh.execOnConnection(verifyConn, 'true', { timeout: 15_000 })
          );
        } catch (err) {
          checks.app_key = makeCheck(
            'app_key',
            'warn',
            `Đã thêm key nhưng chưa đăng nhập được bằng key (${err.message}). ` +
              `App sẽ tiếp tục dùng mật khẩu.`
          );
          logger.warn(`App key verification failed for server ${serverId}: ${err.message}`);
        }

        if (!checks.app_key) {
          const keepPassword = privilegeMode === 'sudo_password';
          db.prepare(
            `UPDATE servers
                SET encrypted_private_key = ?, auth_type = 'private_key',
                    key_installed_at = CURRENT_TIMESTAMP,
                    encrypted_password = ${keepPassword ? 'encrypted_password' : 'NULL'},
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`
          ).run(encrypt(keyPair.privateKey), serverId);

          checks.app_key = makeCheck(
            'app_key',
            'ok',
            keepPassword
              ? 'Đã tạo và cài SSH key riêng. Mật khẩu vẫn được giữ vì tài khoản cần nó cho sudo.'
              : 'Đã tạo và cài SSH key riêng. Mật khẩu đã được xoá khỏi app.'
          );
          logActivity('server_key_installed', `Đã cài SSH key riêng cho VPS ${server.name}`, serverId);
        }
      }

      // --- systemd ----------------------------------------------------------
      ctx.progress({ percent: 34, step: 'Đang kiểm tra systemd…' });
      const systemctl = await ssh.execOnConnection(
        conn,
        'command -v systemctl >/dev/null 2>&1 && systemctl --version 2>/dev/null | head -n 1 || true',
        { timeout: 15_000 }
      );
      const systemdVersion = systemctl.stdout.trim();
      checks.systemd = systemdVersion
        ? makeCheck('systemd', 'ok', systemdVersion)
        : makeCheck(
            'systemd',
            'error',
            'Không tìm thấy systemd. App dùng systemd để giữ buổi live chạy liên tục, ' +
              'nên VPS này chưa dùng được. Hãy chọn VPS Ubuntu/Debian tiêu chuẩn.'
          );

      // --- directories & disk ----------------------------------------------
      ctx.progress({ percent: 42, step: 'Đang tạo thư mục lưu video…' });
      await ensureDirectories(conn, target);

      // --- FFmpeg -----------------------------------------------------------
      ctx.progress({ percent: 50, step: 'Đang kiểm tra FFmpeg…' });
      let ffmpeg = await detectFfmpeg(conn);

      if (!ffmpeg.installed || opts.reinstallFfmpeg) {
        ctx.progress({
          percent: 55,
          step: 'Đang cài FFmpeg (có thể mất 1–3 phút)…',
        });
        const install = await installFfmpeg(conn, target);
        if (install.code !== 0) {
          const tail = (install.stderr || install.stdout || '').trim().split('\n').slice(-4).join('\n');
          checks.ffmpeg = makeCheck(
            'ffmpeg',
            'error',
            `Cài FFmpeg không thành công. ${tail || `exit ${install.code}`}`
          );
        } else {
          ffmpeg = await detectFfmpeg(conn);
        }
      }

      if (!checks.ffmpeg) {
        checks.ffmpeg = ffmpeg.installed
          ? makeCheck('ffmpeg', 'ok', ffmpeg.version || ffmpeg.path)
          : makeCheck('ffmpeg', 'error', 'Vẫn chưa tìm thấy FFmpeg sau khi cài.');
        db.prepare('UPDATE servers SET ffmpeg_version = ? WHERE id = ?').run(
          ffmpeg.version || null,
          serverId
        );
      }

      // --- RTMPS support ----------------------------------------------------
      ctx.progress({ percent: 66, step: 'Đang kiểm tra hỗ trợ RTMPS…' });
      if (ffmpeg.installed) {
        const hasRtmps = await detectRtmps(conn);
        db.prepare('UPDATE servers SET ffmpeg_has_rtmps = ? WHERE id = ?').run(
          hasRtmps ? 1 : 0,
          serverId
        );
        checks.rtmps = hasRtmps
          ? makeCheck('rtmps', 'ok', 'Bản FFmpeg này phát được RTMPS tới Facebook.')
          : makeCheck(
              'rtmps',
              'error',
              'Bản FFmpeg trên VPS không hỗ trợ RTMPS nên không phát được lên Facebook. ' +
                'Hãy bấm "Cài lại FFmpeg" để thử bản khác.',
              { fix: 'reinstall-ffmpeg' }
            );
      } else {
        checks.rtmps = makeCheck('rtmps', 'skipped', 'Cần có FFmpeg trước.');
      }

      // --- clock ------------------------------------------------------------
      ctx.progress({ percent: 74, step: 'Đang kiểm tra đồng hồ hệ thống…' });
      let clock = await probeClock(conn);

      if (!clock.ntpSynchronized || (clock.skewSeconds != null && clock.skewSeconds > 120)) {
        await ssh.execPrivilegedOnConnection(conn, target, 'timedatectl set-ntp true', {
          timeout: 20_000,
        });
        clock = await probeClock(conn);
      }

      if (clock.skewSeconds != null && clock.skewSeconds > 300) {
        checks.clock = makeCheck(
          'clock',
          'error',
          `Đồng hồ VPS lệch ${clock.skewSeconds} giây so với giờ thật. ` +
            `Lệch giờ làm TLS tới Facebook thất bại.`
        );
      } else if (!clock.ntpSynchronized) {
        checks.clock = makeCheck(
          'clock',
          'warn',
          'Chưa đồng bộ giờ tự động (NTP). Giờ hiện tại vẫn đúng nên live vẫn chạy được.'
        );
      } else {
        checks.clock = makeCheck(
          'clock',
          'ok',
          `Đã đồng bộ NTP, lệch ${clock.skewSeconds ?? 0} giây.`
        );
      }

      // --- Facebook reachability -------------------------------------------
      ctx.progress({ percent: 82, step: 'Đang thử kết nối tới Facebook…' });
      const fb = await probeFacebook(conn);
      checks.facebook = fb.ok
        ? makeCheck('facebook', 'ok', `Kết nối được tới ${config.facebook.ingestHost}:443`)
        : makeCheck('facebook', 'error', fb.reason || 'Không kết nối được tới Facebook.');

      // --- capacity & storage ----------------------------------------------
      ctx.progress({ percent: 90, step: 'Đang đọc dung lượng ổ đĩa…' });
      const capacity = await probeCapacity(conn);
      db.prepare(
        'UPDATE servers SET nic_speed_mbps = ?, cpu_cores = ?, ram_total_mb = ? WHERE id = ?'
      ).run(capacity.nicSpeedMbps, capacity.cpuCores, capacity.ramTotalMb, serverId);

      const dfResult = await ssh.execOnConnection(conn, storage.DF_COMMAND, { timeout: 20_000 });
      const disk = storage.parseDf(dfResult.stdout);

      if (!disk) {
        checks.storage = makeCheck('storage', 'error', 'Không đọc được dung lượng ổ đĩa.');
      } else {
        storage.persistStorage(serverId, disk);
        const safety = storage.computeSafety(disk.totalBytes, disk.availableBytes);
        const advice = capacityAdvice(capacity.nicSpeedMbps);

        const parts = [
          `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} đã dùng`,
          `còn trống ${formatBytes(disk.availableBytes)}`,
          `có thể upload an toàn ${formatBytes(safety.usableFreeBytes)}`,
        ];
        if (capacity.cpuCores) parts.push(`${capacity.cpuCores} CPU`);
        if (advice) parts.push(`mạng ${advice.nicSpeedMbps} Mbps (~${advice.maxLives} live cùng lúc)`);

        checks.storage = makeCheck(
          'storage',
          safety.level === 'critical' ? 'warn' : 'ok',
          parts.join(' · ')
        );
      }
    });

    // Fill anything that never ran so the checklist is never partially blank.
    for (const key of CHECK_ORDER) {
      if (!checks[key]) checks[key] = makeCheck(key, 'skipped', 'Chưa kiểm tra.');
    }

    const failedBlocking = CHECK_ORDER.filter(
      (key) => BLOCKING.has(key) && checks[key].status === 'error'
    );
    const state = failedBlocking.length ? 'failed' : 'ready';
    saveChecks(serverId, checks, state);

    ctx.progress({
      percent: 100,
      step: state === 'ready' ? 'VPS đã sẵn sàng phát live.' : 'Còn hạng mục cần xử lý.',
    });

    if (state === 'ready') {
      logActivity('server_setup', `VPS ${server.name} đã được chuẩn bị xong`, serverId);
    } else {
      const names = failedBlocking.map((k) => checks[k].name).join(', ');
      throw new AppError(`VPS chưa dùng được. Cần xử lý: ${names}.`, 400);
    }
  }

  /**
   * A failure anywhere (most often: the VPS is unreachable) must leave the
   * server in a state the UI can explain. Without this the row would sit at
   * 'provisioning' forever with no job running behind it, and the detail page
   * would claim work is still in progress.
   */
  return async function worker(ctx) {
    try {
      await runProvision(ctx);
    } catch (err) {
      const current = db.prepare('SELECT setup_state, checks_json FROM servers WHERE id = ?').get(serverId);
      if (current && current.setup_state === 'provisioning') {
        const existing = current.checks_json ? readChecks({ checks_json: current.checks_json }) : [];
        const checks = existing.length
          ? existing
          : [makeCheck('ssh', 'error', err && err.expected ? err.message : 'Không kết nối được tới VPS.')];
        const byKey = Object.fromEntries(checks.map((c) => [c.key, c]));
        for (const key of CHECK_ORDER) {
          if (!byKey[key]) byKey[key] = makeCheck(key, 'skipped', 'Chưa kiểm tra được.');
        }
        saveChecks(serverId, byKey, 'failed');
      }
      throw err;
    }
  };
}

/** Starts (or reuses) a provisioning job for one server. */
function startProvision(serverId, opts = {}) {
  const existing = jobs.findActive({ type: 'setup', serverId });
  if (existing) return existing;

  return jobs.start(
    { serverId, type: 'setup', entityType: 'server', entityId: serverId, step: 'Đang chuẩn bị…' },
    buildWorker(serverId, opts)
  );
}

// A provisioning run happens entirely inside this process, so a restart really
// does abandon it. Re-running is safe and quick, so just start over.
jobs.registerResumer('setup', (job, ctx) => buildWorker(job.entity_id, {})(ctx));

/** Parsed checklist for rendering, tolerant of an empty or stale column. */
function readChecks(server) {
  if (!server.checks_json) return [];
  try {
    const parsed = JSON.parse(server.checks_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = {
  CHECK_DEFS,
  startProvision,
  buildWorker,
  readChecks,
  capacityAdvice,
  parseOsRelease,
  // exported for tests
  probeClock,
  probeFacebook,
  detectRtmps,
};
