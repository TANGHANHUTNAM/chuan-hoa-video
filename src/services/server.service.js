'use strict';

const db = require('../db');
const ssh = require('./ssh.service');
const storage = require('./storage.service');
const provision = require('./provision.service');
const { encrypt } = require('./crypto.service');
const {
  isValidHost,
  isValidPort,
  isValidUsername,
  cleanName,
} = require('../utils/validators');
const { AppError } = require('../middleware/error-handler');

/** CRUD and view models for the `servers` table. */

function findById(id) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

function findByIdOrThrow(id) {
  const server = findById(id);
  if (!server) throw new AppError('Không tìm thấy VPS.', 404);
  return server;
}

function list() {
  return db.prepare('SELECT * FROM servers ORDER BY id').all();
}

/** Servers that finished provisioning, i.e. the ones a project may use. */
function listReady() {
  return db.prepare(`SELECT * FROM servers WHERE setup_state = 'ready' ORDER BY id`).all();
}

function countAll() {
  return db.prepare('SELECT COUNT(*) AS n FROM servers').get().n;
}

/** Normalises and validates the Add/Edit Server form. */
function validateInput(input, { requireCredential = true } = {}) {
  const name = cleanName(input.name, 60);
  const host = String(input.host || '').trim();
  const port = input.port ? Number(input.port) : 22;
  const username = String(input.username || 'root').trim();
  const authType = input.auth_type === 'private_key' ? 'private_key' : 'password';
  const password = String(input.password || '');
  const privateKey = String(input.private_key || '').trim();

  if (!host) throw new AppError('Vui lòng nhập IP hoặc tên miền của VPS.', 400);
  if (!isValidHost(host)) {
    throw new AppError(`"${host}" không phải IP hoặc tên miền hợp lệ.`, 400);
  }
  if (!isValidPort(port)) throw new AppError('Cổng SSH phải là số từ 1 đến 65535.', 400);
  if (!isValidUsername(username)) {
    throw new AppError('Tên đăng nhập SSH không hợp lệ.', 400);
  }

  if (requireCredential) {
    if (authType === 'password' && !password) {
      throw new AppError('Vui lòng nhập mật khẩu SSH.', 400);
    }
    if (authType === 'private_key' && !privateKey) {
      throw new AppError('Vui lòng dán nội dung SSH private key.', 400);
    }
  }

  // Fail fast on an unusable key rather than after a confusing SSH error.
  if (authType === 'private_key' && privateKey) ssh.validatePrivateKey(privateKey);

  return {
    name: name || host,
    host,
    port,
    username,
    authType,
    password,
    privateKey,
  };
}

/** Builds a connection target from form input, before any row exists. */
function targetFrom(input, existingServer = null) {
  const data = validateInput(input, { requireCredential: !existingServer });

  const target = ssh.targetFromInput({
    host: data.host,
    port: data.port,
    username: data.username,
    password: data.authType === 'password' ? data.password : '',
    privateKey: data.authType === 'private_key' ? data.privateKey : '',
    expectedFingerprint: existingServer ? existingServer.host_key_fingerprint : null,
  });

  // Editing without re-entering the credential: reuse what is stored.
  if (existingServer && !target.password && !target.privateKey) {
    const stored = ssh.resolveTarget(existingServer);
    target.password = stored.password;
    target.privateKey = stored.privateKey;
  }

  return { data, target };
}

function create(input) {
  const data = validateInput(input);

  const info = db
    .prepare(
      `INSERT INTO servers (name, host, port, username, auth_type,
                            encrypted_password, encrypted_private_key, setup_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`
    )
    .run(
      data.name,
      data.host,
      data.port,
      data.username,
      data.authType,
      data.authType === 'password' ? encrypt(data.password) : null,
      data.authType === 'private_key' ? encrypt(data.privateKey) : null
    );

  db.prepare(
    `INSERT INTO activity_logs (type, message, entity_type, entity_id)
     VALUES ('server_connected', ?, 'server', ?)`
  ).run(`Đã thêm VPS ${data.name} (${data.host})`, info.lastInsertRowid);

  return findById(info.lastInsertRowid);
}

function update(id, input) {
  const server = findByIdOrThrow(id);
  const data = validateInput({ ...input }, { requireCredential: false });

  // A changed host means a different machine, so the pinned key no longer applies.
  const hostChanged = data.host !== server.host || data.port !== server.port;

  const fields = {
    name: data.name,
    host: data.host,
    port: data.port,
    username: data.username,
  };

  if (data.authType === 'password' && data.password) {
    fields.auth_type = 'password';
    fields.encrypted_password = encrypt(data.password);
    fields.encrypted_private_key = null;
    fields.key_installed_at = null;
  } else if (data.authType === 'private_key' && data.privateKey) {
    fields.auth_type = 'private_key';
    fields.encrypted_private_key = encrypt(data.privateKey);
    fields.encrypted_password = null;
    fields.key_installed_at = null;
  }

  if (hostChanged) fields.host_key_fingerprint = null;

  const keys = Object.keys(fields);
  db.prepare(
    `UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(', ')},
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...keys.map((k) => fields[k]), id);

  return findById(id);
}

/**
 * Removing a server is refused while anything is live on it (spec section 46):
 * the systemd units would keep streaming with nothing left to manage them.
 */
function assertRemovable(id) {
  const activeLives = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM live_destinations d
         JOIN projects p ON p.id = d.project_id
        WHERE p.server_id = ? AND d.status IN ('live', 'starting', 'refreshing')`
    )
    .get(id).n;

  if (activeLives > 0) {
    throw new AppError(
      `VPS này đang có ${activeLives} buổi live đang chạy. Hãy dừng tất cả live trước khi xoá VPS.`,
      409
    );
  }
}

function remove(id) {
  const server = findByIdOrThrow(id);
  assertRemovable(id);

  // Removing from the app never deletes the user's video files (spec section 46).
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM live_destinations
        WHERE project_id IN (SELECT id FROM projects WHERE server_id = ?)`
    ).run(id);
    db.prepare('DELETE FROM projects WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM videos WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM jobs WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  });
  tx();

  db.prepare(
    `INSERT INTO activity_logs (type, message, entity_type, entity_id)
     VALUES ('server_removed', ?, 'server', ?)`
  ).run(`Đã xoá VPS ${server.name} khỏi app (không xoá file trên VPS)`, id);

  return true;
}

/** View model used by dashboard cards, server list and project pages. */
function toView(server) {
  const disk = storage.fromCache(server);
  const checks = provision.readChecks(server);
  const blocking = checks.filter((c) => c.status === 'error');

  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    authType: server.auth_type,
    usesAppKey: Boolean(server.key_installed_at),
    setupState: server.setup_state,
    isReady: server.setup_state === 'ready',
    osName: server.os_name,
    ffmpegVersion: server.ffmpeg_version,
    hasRtmps: server.ffmpeg_has_rtmps === 1,
    fingerprint: server.host_key_fingerprint,
    cpuCores: server.cpu_cores,
    ramTotalMb: server.ram_total_mb,
    capacity: provision.capacityAdvice(server.nic_speed_mbps),
    lastCheckedAt: server.last_checked_at,
    disk,
    checks,
    problemCount: blocking.length,
  };
}

module.exports = {
  findById,
  findByIdOrThrow,
  list,
  listReady,
  countAll,
  validateInput,
  targetFrom,
  create,
  update,
  remove,
  assertRemovable,
  toView,
};
