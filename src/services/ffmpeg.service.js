'use strict';

const config = require('../config');
const { isPositiveInt } = require('../utils/validators');
const { shellEscape } = require('../utils/shell-escape');
const { AppError } = require('../middleware/error-handler');

/**
 * Generates the systemd unit that keeps one FFmpeg process streaming to one
 * Facebook destination.
 *
 * Several choices here differ from the naive version in spec section 25, each for
 * a concrete reason — see the comments in buildUnitFile.
 */

/**
 * Unit and file names are derived only from a numeric database id, never from
 * anything the user typed (spec sections 25, 40.13).
 */
function unitName(destinationId) {
  if (!isPositiveInt(destinationId)) {
    throw new AppError('Mã điểm phát không hợp lệ.', 400);
  }
  return `live-manager-${destinationId}`;
}

/**
 * How long systemd keeps trying to bring FFmpeg back before it gives up.
 *
 * This is the reconnect budget for the auto-refresh recycle, and it was far too
 * small. At RuntimeMaxSec the unit is killed and Restart=always brings it back after
 * RestartSec — but Facebook does not release the previous RTMP session instantly, so
 * the first attempts fail in about a second each. With the old RestartSec=5 and
 * StartLimitBurst=5 that was five tries inside roughly 30 SECONDS, after which
 * systemd answered "start request repeated too quickly" and stopped for good. The
 * 7h45 recycle then killed the broadcast it exists to save, and nothing restarted it.
 *
 * A wrong stream key and a slow reconnect differ by how LONG failure lasts, not by
 * how many attempts it takes, so the budget is written as time: burst x delay. Five
 * minutes is far more than Facebook needs and still stops a genuinely broken
 * destination instead of retrying it forever.
 *
 * Making this generous costs nothing in feedback speed: a wrong key is reported
 * within seconds by inspectEarlyFailure (live.service), which reads the journal four
 * seconds after Start. This limit was never what made that fast.
 */
const RESTART_DELAY_SECONDS = 10;
const RESTART_BUDGET_SECONDS = 300;
const RESTART_BURST = RESTART_BUDGET_SECONDS / RESTART_DELAY_SECONDS;

const unitFilePath = (destinationId) => `/etc/systemd/system/${unitName(destinationId)}.service`;
const envFilePath = (destinationId) => `${config.remote.secrets}/dest-${Number(destinationId)}.env`;

/**
 * The env file holds the full RTMPS URL including the stream key.
 *
 * It exists because /etc/systemd/system/*.service is world-readable: putting the
 * URL directly in ExecStart, as the spec sketch does, would let any user on the
 * VPS read the stream key with `cat`. The env file is mode 600 in a mode 700
 * directory.
 *
 * Honest limitation: once systemd expands the variable, the URL is still visible
 * in `ps` output, because FFmpeg's argv has to contain it. This closes the
 * at-rest leak, not the process-list one.
 */
function buildEnvFile(rtmpsUrl) {
  return `LM_RTMPS_URL=${rtmpsUrl}\n`;
}

/**
 * @param {object} opts
 * @param {number} opts.destinationId
 * @param {string} [opts.videoPath]    single video, absolute path on the VPS
 * @param {string} [opts.playlistPath] concat list, used instead of videoPath
 * @param {string} opts.projectName    for the unit description only
 * @param {boolean} opts.autoRefresh   recycle before Facebook's 8-hour cap
 * @param {number} opts.runtimeMaxSeconds
 */
function buildUnitFile({
  destinationId,
  videoPath,
  playlistPath = null,
  projectName = '',
  autoRefresh = true,
  runtimeMaxSeconds = config.facebook.defaultRuntimeMaxSeconds,
  totalSeconds = null,
}) {
  if (!playlistPath && !videoPath) {
    throw new AppError('Thiếu video để tạo cấu hình phát live.', 400);
  }
  const name = unitName(destinationId);
  const description = `Facebook Live Manager destination ${destinationId}` +
    (projectName ? ` (${String(projectName).replace(/[\r\n]/g, ' ').slice(0, 60)})` : '');

  const refreshWindow = Math.max(300, Number(runtimeMaxSeconds) || 0);
  const total = Number(totalSeconds) > 0 ? Math.round(Number(totalSeconds)) : null;

  /**
   * Can FFmpeg itself place the end of the broadcast?
   *
   * Only when the whole thing fits inside one session. `-t` counts a single
   * process's output, so if systemd recycles the unit before Facebook's 8-hour cap
   * the counter starts again from zero and the broadcast would run twice as long as
   * asked. Past that length the app enforces the end instead (watcher.service), and
   * the recycle stays — losing the recycle would have Facebook cut the stream, which
   * is worse than ending a minute late.
   */
  const endsItself = total != null && (!autoRefresh || total <= refreshWindow);

  const ffmpegArgs = [
    config.remote.ffmpegPath,
    '-hide_banner',
    // Without -nostdin, FFmpeg under systemd can consume stdin and misbehave.
    '-nostdin',
    '-loglevel', 'warning',
    // Throughput samples for the watcher. -loglevel warning suppresses the
    // usual "frame= fps= speed=" stat lines, but -progress writes to this file
    // regardless, so the journal stays readable and we still get numbers.
    // Without this the app can only see that the process exists, not that video
    // is actually reaching Facebook.
    '-progress', progressFilePath(destinationId),
    // -re paces the file at real time; without it FFmpeg would push the whole
    // file as fast as it can and Facebook would reject the stream.
    '-re',
    // Loop forever (spec section 31). Applied to the input, so with a concat list
    // it repeats the whole playlist rather than the last file.
    '-stream_loop', '-1',
    // Regenerate timestamps: looping otherwise produces non-monotonic DTS at each
    // wrap point, which can break the muxer mid-broadcast.
    '-fflags', '+genpts',
    // Input options must precede -i. -safe 0 is required because the list holds
    // absolute paths, which concat refuses by default.
    ...(playlistPath ? ['-f', 'concat', '-safe', '0', '-i', playlistPath] : ['-i', videoPath]),
    // Output-side limit, so it caps the looped OUTPUT rather than one pass of the
    // input. Verified on the VPS: a 5-second file with -t 12 ends at 12.26s, so a
    // finite broadcast can stop part-way through a loop instead of only on a video
    // boundary.
    ...(endsItself ? ['-t', String(total)] : []),
    // No re-encoding: the video was already made Facebook-compliant during
    // normalise, so copying costs almost no CPU and lets one VPS feed many pages.
    '-c', 'copy',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    '${LM_RTMPS_URL}',
  ].join(' ');

  const lines = [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    // Without a start-limit window, a permanently bad stream key would make systemd
    // retry forever. The window has to outlast the budget itself, or systemd would
    // count attempts from an earlier failure against this one.
    `StartLimitIntervalSec=${RESTART_BUDGET_SECONDS * 3}`,
    `StartLimitBurst=${RESTART_BURST}`,
    '',
    '[Service]',
    'Type=simple',
    `EnvironmentFile=${envFilePath(destinationId)}`,
    `ExecStart=${ffmpegArgs}`,
    // The decisive line for a finite broadcast.
    //
    // Restart=always brings a process back even when it exited cleanly — a probe
    // unit on this VPS ran 3 times in 9 seconds — so with `always` the `-t` above
    // would be pointless and the stream would loop forever anyway. on-failure lets
    // a finished broadcast stay finished while still restarting a crash (the same
    // probe, made to exit 1, was restarted 4 times).
    endsItself ? 'Restart=on-failure' : 'Restart=always',
    // Long enough that a reconnect is not hammering a session Facebook has not let
    // go of yet, short enough that a real crash is back on air quickly.
    `RestartSec=${RESTART_DELAY_SECONDS}`,
  ];

  if (autoRefresh && !endsItself) {
    // Facebook ends a broadcast at 8 hours. Stopping a little before that and
    // letting Restart=always bring FFmpeg straight back means the stream keeps
    // going, since Facebook accepts a reconnect on a persistent stream key.
    //
    // Skipped when FFmpeg ends the broadcast itself: the recycle would reset `-t`
    // and the stream would run past the length the user asked for.
    lines.push(`RuntimeMaxSec=${refreshWindow}`);
  }

  lines.push(
    'KillSignal=SIGTERM',
    'TimeoutStopSec=20',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  );

  return { name, path: unitFilePath(destinationId), content: lines.join('\n') };
}

/** Where a running destination writes its throughput samples. */
const progressFilePath = (destinationId) =>
  `${config.remote.logs}/dest-${Number(destinationId)}.progress`;

/** Concat demuxer list for a project that plays several videos in sequence. */
const playlistFilePath = (projectId) =>
  `${config.remote.videos}/playlist-${Number(projectId)}.txt`;

/**
 * Builds the concat demuxer list.
 *
 * Paths are quoted AND escaped. This used to be safe without escaping because
 * every filename was a UUID we generated, but videos adopted from the VPS folder
 * carry names the user chose, which can contain apostrophes
 * ("Chợ Hậu's live.mp4"). FFmpeg's concat format escapes a quote by closing it,
 * escaping, and reopening — `'\''` — which is exactly what shellEscape produces,
 * so it is reused rather than reimplemented.
 *
 * A newline in a filename cannot be escaped at all, since the format is one file
 * per line; those are rejected at scan time instead.
 */
function buildPlaylistFile(videoPaths) {
  const lines = [
    '# Facebook Live Manager playlist — do not edit by hand.',
    '# Regenerated every time the project starts or its videos change.',
  ];

  for (const remotePath of videoPaths) {
    if (/[\r\n]/.test(remotePath)) {
      throw new AppError(
        `Tên file có ký tự xuống dòng nên không thể đưa vào danh sách phát: ${remotePath.replace(/[\r\n]/g, '?')}`,
        400
      );
    }
    lines.push(`file ${shellEscape(remotePath)}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Parses FFmpeg's `-progress` key=value output.
 *
 * The file grows as a series of blocks, so only the last value of each key is
 * current. Shared by the live watcher and the normalise job rather than parsed
 * twice for the same format.
 *
 * Note on out_time_ms: despite the name, most FFmpeg builds write microseconds
 * into it, same as out_time_us. Treated identically here.
 */
function parseProgressFields(text) {
  const fields = {
    frame: null,
    fps: null,
    bitrateKbps: null,
    totalSize: null,
    outTimeUs: null,
    speed: null,
    ended: false,
  };

  for (const line of String(text || '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const raw = line.slice(eq + 1).trim();

    switch (key) {
      case 'frame': {
        const n = Number(raw);
        if (Number.isFinite(n)) fields.frame = n;
        break;
      }
      case 'fps': {
        const n = Number(raw);
        if (Number.isFinite(n)) fields.fps = n;
        break;
      }
      case 'bitrate': {
        // e.g. "4500.1kbits/s", or "N/A" before the first frame is muxed.
        const m = /([\d.]+)\s*kbits\/s/i.exec(raw);
        if (m) fields.bitrateKbps = Number(m[1]);
        break;
      }
      case 'total_size': {
        const n = Number(raw);
        if (Number.isFinite(n)) fields.totalSize = n;
        break;
      }
      case 'out_time_us':
      case 'out_time_ms': {
        const n = Number(raw);
        if (Number.isFinite(n)) fields.outTimeUs = n;
        break;
      }
      case 'speed': {
        // e.g. "1.00x", or "N/A" at startup.
        const m = /([\d.]+)\s*x/i.exec(raw);
        if (m) fields.speed = Number(m[1]);
        break;
      }
      case 'progress':
        if (raw === 'end') fields.ended = true;
        break;
      default:
        break;
    }
  }

  return fields;
}

/** Maps `systemctl is-active` output to our own status vocabulary (spec section 29). */
function mapSystemdState(raw) {
  switch (String(raw || '').trim()) {
    case 'active':
      return 'live';
    case 'activating':
      return 'starting';
    // Auto-refresh makes this state a normal, recurring event rather than an
    // error: the unit is being recycled and Restart=always brings it back.
    case 'deactivating':
      return 'refreshing';
    case 'failed':
      return 'error';
    case 'inactive':
      return 'stopped';
    default:
      return 'unknown';
  }
}

const STATUS_LABELS = {
  live: 'ĐANG LIVE',
  starting: 'ĐANG BẮT ĐẦU',
  refreshing: 'ĐANG LÀM MỚI',
  stopped: 'ĐÃ DỪNG',
  error: 'LỖI',
  unknown: 'CHƯA RÕ',
};

const STATUS_TONES = {
  live: 'live',
  starting: 'warn',
  refreshing: 'warn',
  stopped: 'idle',
  error: 'error',
  unknown: 'idle',
};

module.exports = {
  unitName,
  unitFilePath,
  envFilePath,
  progressFilePath,
  playlistFilePath,
  buildEnvFile,
  buildPlaylistFile,
  buildUnitFile,
  parseProgressFields,
  mapSystemdState,
  STATUS_LABELS,
  STATUS_TONES,
};
