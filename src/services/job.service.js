'use strict';

const db = require('../db');
const logger = require('../utils/logger');
const { maskSecrets } = require('../utils/mask');
const { AppError } = require('../middleware/error-handler');

/**
 * In-process background jobs.
 *
 * The MVP runs on exactly one Render instance with SQLite (spec section 6), so a
 * Map of in-flight work plus a `jobs` table is enough — no Redis or queue
 * service, which spec section 3 rules out anyway.
 *
 * The important design point: work that lives on the VPS (a download in a
 * systemd unit, an FFmpeg normalise) keeps running even when this process
 * restarts. Those jobs are re-attached on boot rather than marked failed.
 */

const TERMINAL = new Set(['success', 'failed', 'cancelled']);

// jobId -> { promise }
const running = new Map();
// job type -> resume handler, registered by the service that owns that type
const resumers = new Map();

function get(jobId) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

function getOrThrow(jobId) {
  const job = get(jobId);
  if (!job) throw new AppError('Không tìm thấy tiến trình này.', 404);
  return job;
}

function create({ serverId = null, type, entityType = null, entityId = null, step = null }) {
  const info = db
    .prepare(
      `INSERT INTO jobs (server_id, type, entity_type, entity_id, status, step)
       VALUES (?, ?, ?, ?, 'queued', ?)`
    )
    .run(serverId, type, entityType, entityId, step);
  return get(info.lastInsertRowid);
}

function update(jobId, fields) {
  const allowed = [
    'status',
    'progress_percent',
    'step',
    'detail',
    'unit_name',
    'error_message',
    'cancel_requested',
  ];
  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      // Never let an unmasked secret reach the DB and then the browser.
      const value = fields[key];
      values.push(
        key === 'detail' || key === 'error_message' || key === 'step'
          ? maskSecrets(value)
          : value
      );
    }
  }
  if (!sets.length) return get(jobId);

  if (fields.status && TERMINAL.has(fields.status)) {
    sets.push('finished_at = CURRENT_TIMESTAMP');
  }
  sets.push('updated_at = CURRENT_TIMESTAMP');
  values.push(jobId);

  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return get(jobId);
}

/** Most recent job for one entity, e.g. the import job of video 12. */
function latestForEntity(entityType, entityId) {
  return db
    .prepare(
      `SELECT * FROM jobs WHERE entity_type = ? AND entity_id = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(entityType, entityId);
}

/** Unfinished job of a given type, used to enforce "one at a time" rules. */
function findActive({ type, serverId = null, entityType = null, entityId = null }) {
  const clauses = [`status IN ('queued','running')`];
  const values = [];

  if (type) {
    clauses.push('type = ?');
    values.push(type);
  }
  if (serverId != null) {
    clauses.push('server_id = ?');
    values.push(serverId);
  }
  if (entityType != null) {
    clauses.push('entity_type = ?');
    values.push(entityType);
  }
  if (entityId != null) {
    clauses.push('entity_id = ?');
    values.push(entityId);
  }

  return db
    .prepare(`SELECT * FROM jobs WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT 1`)
    .get(...values);
}

function isCancelRequested(jobId) {
  const row = db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(jobId);
  return Boolean(row && row.cancel_requested);
}

/** Marks a job for cancellation. The worker notices on its next progress check. */
function requestCancel(jobId) {
  const job = getOrThrow(jobId);
  if (TERMINAL.has(job.status)) return job;
  return update(jobId, { cancel_requested: 1, step: 'Đang huỷ…' });
}

/** Signals a worker to abort cooperatively. */
class JobCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'JobCancelled';
  }
}

/** The handle a worker uses to report progress. */
function makeContext(jobId) {
  return {
    jobId,

    /** @param {{percent?: number, step?: string, detail?: string, unit?: string}} info */
    progress(info = {}) {
      const fields = {};
      if (info.percent != null) {
        fields.progress_percent = Math.max(0, Math.min(100, Math.round(info.percent)));
      }
      if (info.step != null) fields.step = info.step;
      if (info.detail != null) fields.detail = info.detail;
      if (info.unit != null) fields.unit_name = info.unit;
      if (Object.keys(fields).length) update(jobId, fields);
    },

    cancelled() {
      return isCancelRequested(jobId);
    },

    /** Throws JobCancelled if the user asked to stop; call inside polling loops. */
    throwIfCancelled() {
      if (isCancelRequested(jobId)) throw new JobCancelled();
    },

    /** Cancellable sleep for remote polling loops. */
    async sleep(ms) {
      const step = 500;
      let waited = 0;
      while (waited < ms) {
        this.throwIfCancelled();
        await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
        waited += step;
      }
    },
  };
}

function execute(jobId, worker) {
  update(jobId, { status: 'running' });

  const promise = (async () => {
    const ctx = makeContext(jobId);
    try {
      await worker(ctx);
      // A worker may already have set a terminal state (e.g. cancelled cleanup).
      const current = get(jobId);
      if (current && !TERMINAL.has(current.status)) {
        update(jobId, { status: 'success', progress_percent: 100 });
      }
    } catch (err) {
      if (err instanceof JobCancelled) {
        update(jobId, { status: 'cancelled', step: 'Đã huỷ' });
        logger.info(`Job ${jobId} cancelled`);
      } else {
        const message = err && err.expected ? err.message : 'Có lỗi không mong muốn xảy ra.';
        update(jobId, { status: 'failed', error_message: message });
        logger.error(`Job ${jobId} failed`, err);
      }
    } finally {
      running.delete(jobId);
    }
  })();

  running.set(jobId, { promise });
  return promise;
}

/**
 * Creates a job and starts it without waiting. The caller returns the job id to
 * the browser immediately, which then polls /api/jobs/:id.
 */
function start(spec, worker) {
  const job = create(spec);
  execute(job.id, worker);
  return job;
}

/** Lets a service declare how to re-attach to its own jobs after a restart. */
function registerResumer(type, handler) {
  resumers.set(type, handler);
}

/**
 * Called once at boot. Work running on the VPS survived our restart, so hand it
 * back to its owning service; anything we cannot resume is honestly marked
 * failed rather than left spinning forever.
 */
function resumeOrphaned() {
  const orphans = db
    .prepare(`SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY id`)
    .all();

  for (const job of orphans) {
    const resumer = resumers.get(job.type);
    if (!resumer) {
      update(job.id, {
        status: 'failed',
        error_message: 'App đã khởi động lại trong lúc tiến trình đang chạy. Vui lòng thử lại.',
      });
      continue;
    }

    logger.info(`Resuming ${job.type} job ${job.id}`);
    execute(job.id, (ctx) => resumer(job, ctx));
  }

  return orphans.length;
}

const STATUS_LABELS = {
  queued: 'Đang chờ',
  running: 'Đang chạy',
  success: 'Hoàn tất',
  failed: 'Thất bại',
  cancelled: 'Đã huỷ',
};

/** Shape returned to the browser. Never includes anything unmasked. */
function toJson(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    statusLabel: STATUS_LABELS[job.status] || job.status,
    percent: job.progress_percent,
    step: job.step || '',
    detail: job.detail || '',
    error: job.error_message || '',
    entityType: job.entity_type,
    entityId: job.entity_id,
    finished: TERMINAL.has(job.status),
  };
}

module.exports = {
  get,
  getOrThrow,
  create,
  update,
  start,
  execute,
  latestForEntity,
  findActive,
  requestCancel,
  isCancelRequested,
  registerResumer,
  resumeOrphaned,
  toJson,
  JobCancelled,
  TERMINAL,
};
