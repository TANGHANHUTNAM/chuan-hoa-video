'use strict';

const db = require('../db');
const live = require('./live.service');
const videoService = require('./video.service');
const serverService = require('./server.service');
const storage = require('./storage.service');
const { cleanName } = require('../utils/validators');
const { AppError } = require('../middleware/error-handler');

/** A project is one VPS, one current video, and many Facebook destinations. */

function findById(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function findByIdOrThrow(id) {
  const project = findById(id);
  if (!project) throw new AppError('Không tìm thấy project.', 404);
  return project;
}

function list() {
  return db.prepare('SELECT * FROM projects ORDER BY id DESC').all();
}

function create({ serverId, videoId = null, name }) {
  const server = serverService.findByIdOrThrow(serverId);
  if (server.setup_state !== 'ready') {
    throw new AppError(
      `VPS "${server.name}" chưa được chuẩn bị xong. Hãy mở trang VPS và bấm "Kiểm tra lại".`,
      400
    );
  }

  if (videoId) assertVideoUsable(server.id, videoId);

  const info = db
    .prepare('INSERT INTO projects (server_id, video_id, name) VALUES (?, ?, ?)')
    .run(server.id, videoId || null, cleanName(name, 80) || 'Project mới');

  // Seed the playlist so listVideos() is authoritative from the start.
  if (videoId) {
    db.prepare('INSERT INTO project_videos (project_id, video_id, position) VALUES (?, ?, 0)').run(
      info.lastInsertRowid,
      videoId
    );
  }

  db.prepare(
    `INSERT INTO activity_logs (type, message, entity_type, entity_id)
     VALUES ('project_created', ?, 'project', ?)`
  ).run(`Đã tạo project ${name}`, info.lastInsertRowid);

  return findById(info.lastInsertRowid);
}

/** A project may only use a video that lives on the same VPS (spec section 17A). */
function assertVideoUsable(serverId, videoId) {
  const video = videoService.findByIdOrThrow(videoId);
  if (video.server_id !== serverId) {
    throw new AppError(
      'Video này nằm trên một VPS khác. Project chỉ dùng được video trên cùng VPS.',
      400
    );
  }
  return video;
}

// ---------------------------------------------------------------------------
// Playlist
// ---------------------------------------------------------------------------

/**
 * The ordered video list for a project — the single source of truth.
 *
 * projects.video_id is kept in sync with position 0 so existing views and
 * queries keep working, but nothing should read it to decide what to play.
 */
function listVideos(projectId) {
  return db
    .prepare(
      `SELECT v.* FROM project_videos pv
         JOIN videos v ON v.id = pv.video_id
        WHERE pv.project_id = ?
        ORDER BY pv.position, pv.id`
    )
    .all(projectId);
}

/** Renumbers positions to 0..n-1 and points projects.video_id at the first. */
function normalizePositions(projectId) {
  const rows = db
    .prepare('SELECT id FROM project_videos WHERE project_id = ? ORDER BY position, id')
    .all(projectId);

  const renumber = db.transaction(() => {
    rows.forEach((row, index) => {
      db.prepare('UPDATE project_videos SET position = ? WHERE id = ?').run(index, row.id);
    });
    const first = db
      .prepare(
        `SELECT video_id FROM project_videos WHERE project_id = ?
          ORDER BY position, id LIMIT 1`
      )
      .get(projectId);
    db.prepare('UPDATE projects SET video_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      first ? first.video_id : null,
      projectId
    );
  });
  renumber();
}

function addVideo(projectId, videoId) {
  const project = findByIdOrThrow(projectId);
  assertVideoUsable(project.server_id, videoId);

  const existing = db
    .prepare('SELECT id FROM project_videos WHERE project_id = ? AND video_id = ?')
    .get(projectId, videoId);
  if (existing) {
    throw new AppError('Video này đã có trong danh sách phát của project.', 400);
  }

  const next = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM project_videos WHERE project_id = ?')
    .get(projectId).p;

  db.prepare('INSERT INTO project_videos (project_id, video_id, position) VALUES (?, ?, ?)').run(
    projectId,
    videoId,
    next
  );
  normalizePositions(projectId);
  return listVideos(projectId);
}

function removeVideo(projectId, videoId) {
  findByIdOrThrow(projectId);
  db.prepare('DELETE FROM project_videos WHERE project_id = ? AND video_id = ?').run(
    projectId,
    videoId
  );
  normalizePositions(projectId);
  return listVideos(projectId);
}

/** Moves a video one step up or down the playlist. */
function moveVideo(projectId, videoId, direction) {
  const rows = db
    .prepare('SELECT id, video_id FROM project_videos WHERE project_id = ? ORDER BY position, id')
    .all(projectId);

  const index = rows.findIndex((r) => r.video_id === Number(videoId));
  if (index === -1) throw new AppError('Video không có trong danh sách phát.', 404);

  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= rows.length) return listVideos(projectId);

  const swap = db.transaction(() => {
    db.prepare('UPDATE project_videos SET position = ? WHERE id = ?').run(target, rows[index].id);
    db.prepare('UPDATE project_videos SET position = ? WHERE id = ?').run(index, rows[target].id);
  });
  swap();

  normalizePositions(projectId);
  return listVideos(projectId);
}

/** Replaces the whole playlist with exactly one video. */
function setSingleVideo(projectId, videoId) {
  const project = findByIdOrThrow(projectId);
  assertVideoUsable(project.server_id, videoId);

  const replace = db.transaction(() => {
    db.prepare('DELETE FROM project_videos WHERE project_id = ?').run(projectId);
    db.prepare('INSERT INTO project_videos (project_id, video_id, position) VALUES (?, ?, 0)').run(
      projectId,
      videoId
    );
  });
  replace();
  normalizePositions(projectId);
  return listVideos(projectId);
}

/**
 * concat with `-c copy` needs every file to share codec, resolution, frame rate
 * and time base. Our normalise step forces exactly one preset, so videos that
 * went through it always match — but two videos can each be individually
 * Facebook-compliant and still differ (1920x1080 next to 1280x720).
 *
 * Without this check the stream would start, play the first video, then break up
 * at the join — a failure that looks nothing like its cause.
 */
function checkPlaylistCompatible(projectId) {
  const videos = listVideos(projectId);
  if (videos.length < 2) return { compatible: true, problems: [], videos };

  const [first, ...rest] = videos;
  const shape = (v) => ({
    width: v.width,
    height: v.height,
    fps: v.fps == null ? null : Math.round(v.fps),
    codecVideo: v.codec_video,
    codecAudio: v.codec_audio,
  });

  const base = shape(first);
  const problems = [];

  for (const video of rest) {
    const other = shape(video);
    const differences = [];

    if (other.width !== base.width || other.height !== base.height) {
      differences.push(
        `độ phân giải ${other.width}×${other.height} khác ${base.width}×${base.height}`
      );
    }
    if (other.fps !== base.fps) differences.push(`${other.fps} FPS khác ${base.fps} FPS`);
    if (other.codecVideo !== base.codecVideo) {
      differences.push(`codec ${other.codecVideo} khác ${base.codecVideo}`);
    }
    if (other.codecAudio !== base.codecAudio) {
      differences.push(`âm thanh ${other.codecAudio} khác ${base.codecAudio}`);
    }

    if (differences.length) {
      problems.push({ videoId: video.id, name: video.original_name, differences });
    }
  }

  return { compatible: problems.length === 0, problems, videos, reference: first };
}

function assertPlaylistCompatible(projectId) {
  const result = checkPlaylistCompatible(projectId);
  if (result.compatible) return result;

  const detail = result.problems
    .map((p) => `- ${p.name}: ${p.differences.join(', ')}`)
    .join('\n');

  // Whether normalising helps depends on WHAT differs. It forces codec, fps and
  // pixel format to one target, so those converge. It deliberately preserves
  // orientation and aspect ratio, so a vertical video and a horizontal one will
  // never match no matter how many times they are normalised — telling the user to
  // try would send them in a circle.
  const sizeMismatch = result.problems.some((p) =>
    p.differences.some((d) => d.startsWith('độ phân giải'))
  );

  throw new AppError(
    `Các video trong danh sách phát không cùng thông số nên không thể nối liền mạch.\n\n` +
      `So với "${result.reference.original_name}":\n${detail}\n\n` +
      (sizeMismatch
        ? `Khác nhau về khung hình thì chuẩn hoá KHÔNG gộp lại được — app giữ nguyên ` +
          `chiều dọc/ngang và tỉ lệ của mỗi video. Hãy tách thành hai project, mỗi ` +
          `project một khung hình, hoặc tự xuất lại các video về cùng một khung hình.`
        : `Hãy chuẩn hoá những video lệch ở mục "Chuẩn hoá tại máy" — bước đó đưa codec, ` +
          `FPS và định dạng màu về cùng một thông số.`),
    400,
    { problems: result.problems }
  );
}

/**
 * Points the project at a different video and, if asked, restarts whatever is
 * already live so the change takes effect (spec section 32).
 */
async function changeVideo(projectId, videoId, { restartActive = true } = {}) {
  findByIdOrThrow(projectId);
  // Replaces the playlist rather than only the legacy video_id column, so a
  // project that had several videos ends up with exactly the chosen one.
  setSingleVideo(projectId, videoId);

  const active = live
    .listForProject(projectId)
    .filter((d) => live.ACTIVE_STATES.has(d.status));

  if (!restartActive || !active.length) {
    return { restarted: [], pending: active.length };
  }

  // restart() rewrites the unit file with the new path before restarting, so the
  // user never edits an FFmpeg command (spec section 32).
  const restarted = [];
  for (const dest of active) {
    try {
      await live.restart(dest.id);
      restarted.push({ id: dest.id, name: dest.name, ok: true });
    } catch (err) {
      restarted.push({ id: dest.id, name: dest.name, ok: false, error: err.message });
    }
  }

  return { restarted, pending: 0 };
}

/** Stops and removes every destination, then the project (spec section 47). */
async function remove(projectId) {
  const project = findByIdOrThrow(projectId);

  for (const dest of live.listForProject(projectId)) {
    await live.remove(dest.id).catch(() => {
      // Still delete the row: leaving the project undeletable because a VPS is
      // unreachable would trap the user.
      db.prepare('DELETE FROM live_destinations WHERE id = ?').run(dest.id);
    });
  }

  // Playlist rows must go before the project, or the foreign key blocks it.
  db.prepare('DELETE FROM project_videos WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

  db.prepare(
    `INSERT INTO activity_logs (type, message, entity_type, entity_id)
     VALUES ('project_deleted', ?, 'project', ?)`
  ).run(`Đã xoá project ${project.name} (video vẫn được giữ lại)`, projectId);

  return true;
}

/** Full view model for the project detail page. */
function toView(project) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(project.server_id);

  const playlist = listVideos(project.id).map(videoService.toView);
  const video = playlist[0] || null;

  const destinations = live.listForProject(project.id).map(live.toView);
  const activeCount = destinations.filter((d) => d.isActive).length;

  const videoView = video;
  const notReady = playlist.filter((v) => !v.isReady);
  const compatibility = checkPlaylistCompatible(project.id);

  const canStart = Boolean(
    server &&
      server.setup_state === 'ready' &&
      playlist.length > 0 &&
      notReady.length === 0 &&
      compatibility.compatible
  );

  return {
    id: project.id,
    name: project.name,
    serverId: project.server_id,
    server: server ? serverService.toView(server) : null,
    disk: server ? storage.fromCache(server) : null,
    video: videoView,
    playlist,
    isPlaylist: playlist.length > 1,
    // One pass through everything, so the loop settings can show what N loops
    // actually costs in hours. Null when any video has not been analysed yet,
    // because a partial sum would be a wrong number rather than a missing one.
    playlistSeconds: playlist.length && playlist.every((v) => v.durationSeconds)
      ? playlist.reduce((sum, v) => sum + v.durationSeconds, 0)
      : null,
    playlistProblems: compatibility.problems,
    destinations,
    activeCount,
    canStart,
    // Explains a disabled Start button instead of leaving the user guessing.
    blockedReason: canStart
      ? null
      : !server
        ? 'Project chưa gắn với VPS.'
        : server.setup_state !== 'ready'
          ? 'VPS chưa được chuẩn bị xong.'
          : !playlist.length
            ? 'Chưa chọn video cho project.'
            : notReady.length
              ? notReady.some((v) => v.needsOptimize)
                ? `Còn ${notReady.length} video cần chuẩn hoá cho Facebook.`
                : `Còn ${notReady.length} video chưa sẵn sàng.`
              : 'Các video trong danh sách phát không cùng thông số.',
    createdAt: project.created_at,
  };
}

/** Compact card for the dashboard and project list. */
function toCard(project) {
  const view = toView(project);
  return {
    id: view.id,
    name: view.name,
    serverName: view.server ? view.server.name : '—',
    videoName: view.video ? view.video.name : null,
    destinationCount: view.destinations.length,
    activeCount: view.activeCount,
    canStart: view.canStart,
  };
}

module.exports = {
  findById,
  findByIdOrThrow,
  list,
  create,
  assertVideoUsable,
  changeVideo,
  remove,
  toView,
  toCard,
  // Playlist
  listVideos,
  addVideo,
  removeVideo,
  moveVideo,
  setSingleVideo,
  checkPlaylistCompatible,
  assertPlaylistCompatible,
};
