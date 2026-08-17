'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

// Load .env for local development. Render injects env vars directly, so a
// missing file is not an error. process.loadEnvFile is built into Node 20.12+,
// which keeps us from adding a dotenv dependency.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // No .env file — expected in production.
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

/**
 * In production a missing secret is fatal: booting with a predictable key would
 * silently make every stored credential forgeable. In development we derive a
 * stable throwaway value so the app runs out of the box, and say so loudly.
 */
function requireSecret(name, devFallbackSeed, validate) {
  let value = process.env[name];

  if (!value || (validate && !validate(value))) {
    const reason = value ? `is invalid` : `is not set`;
    if (isProduction) {
      throw new Error(
        `${name} ${reason}. Refusing to start in production. ` +
          `See .env.example for how to generate it.`
      );
    }
    value = crypto
      .createHash('sha256')
      .update(`insecure-dev-key:${devFallbackSeed}`)
      .digest('hex');
    console.warn(
      `[config] WARNING: ${name} ${reason}. Using an INSECURE development ` +
        `fallback. Never run production like this.`
    );
  }

  return value;
}

const isHex64 = (v) => /^[0-9a-fA-F]{64}$/.test(v);

const config = {
  env: NODE_ENV,
  isProduction,
  port: Number(process.env.PORT) || 3000,

  /**
   * Always absolute, and resolved against the project root rather than the current
   * working directory.
   *
   * The shipped .env uses `DB_PATH=./data/live-manager.db`, which made thumbsDir
   * relative too — and `res.sendFile` refuses a relative path, so every thumbnail
   * request answered 500 ("path must be absolute") the moment a preview existed on
   * disk. Anchoring to the project root also means the database is found the same
   * way however the app was launched.
   */
  dbPath: process.env.DB_PATH
    ? path.resolve(__dirname, '..', process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'live-manager.db'),

  /**
   * Local cache for video thumbnails, next to the database so it lands on the
   * same persistent disk. Losing it is harmless — pages fall back to no image.
   */
  get thumbsDir() {
    return path.join(path.dirname(this.dbPath), 'thumbs');
  },

  /**
   * Normalising on this machine instead of on the VPS.
   *
   * Left empty by default: the service looks in runtime/ffmpeg first (what
   * `npm run bundle-ffmpeg` fills in) and then on PATH. These overrides exist for an
   * ffmpeg installed somewhere unusual.
   */
  local: {
    ffmpegPath: (process.env.LOCAL_FFMPEG_PATH || '').trim(),
    ffprobePath: (process.env.LOCAL_FFPROBE_PATH || '').trim(),
  },

  admin: {
    email: process.env.ADMIN_EMAIL || 'drnatro@gmail.com',
    password: process.env.ADMIN_PASSWORD || 'drnatro123123!',
  },

  jwtSecret: requireSecret('JWT_SECRET', 'jwt'),
  jwtExpiresIn: '7d',
  cookieName: 'flm_session',

  // 32 bytes as hex, used for AES-256-GCM (spec section 10).
  encryptionKey: Buffer.from(
    requireSecret('APP_ENCRYPTION_KEY', 'encryption', isHex64),
    'hex'
  ),

  storage: {
    reservePercent: Number(process.env.STORAGE_RESERVE_PERCENT) || 10,
    reserveMinGb: Number(process.env.STORAGE_RESERVE_MIN_GB) || 5,
    maxUploadGb: Number(process.env.MAX_UPLOAD_GB) || 10,
  },

  // Render bills outbound bandwidth and an SFTP push to the VPS counts as
  // outbound, so we track what we send and warn before the plan runs out.
  bandwidthBudgetGb: Number(process.env.RENDER_BANDWIDTH_BUDGET_GB) || 25,

  sheets: {
    // Off until the user pastes Code.gs into their Sheet and deploys it. With it
    // off, every sheets.service function is a no-op so nothing else changes.
    enabled: process.env.SHEETS_ENABLED === '1',
    webhookUrl: (process.env.SHEETS_WEBHOOK_URL || '').trim(),
    // Must match TOKEN in deploy/apps-script/Code.gs. The webhook URL is
    // unauthenticated, so this is the only thing guarding it.
    token: (process.env.SHEETS_TOKEN || '').trim(),
  },

  watcher: {
    // The background watcher is what turns a dead stream into a restarted one
    // without anybody watching. It only runs while this process is awake, so a
    // host that sleeps on idle loses self-healing (the live itself keeps going,
    // because systemd on the VPS owns FFmpeg).
    enabled: process.env.WATCHER_ENABLED !== '0',
    intervalSeconds: Number(process.env.WATCHER_INTERVAL_SECONDS) || 60,
    // How long FFmpeg's out_time may stand still before we call it stalled.
    // Too low and a brief network hiccup causes a needless restart.
    stallSeconds: Number(process.env.STALL_SECONDS) || 90,
    // FFmpeg pacing itself below this multiple of real time cannot keep up.
    minSpeed: 0.9,
  },

  // Layout of the directories the app creates on the user's VPS (spec section 8).
  remote: {
    base: '/opt/live-manager',
    videos: '/opt/live-manager/videos',
    temp: '/opt/live-manager/temp',
    logs: '/opt/live-manager/logs',
    // Stream keys live here in root-only files so they stay out of the
    // world-readable systemd unit files.
    secrets: '/etc/live-manager',
  },

  facebook: {
    // Default ingest endpoint. Users may paste a different one.
    defaultRtmpsBase: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    ingestHost: 'live-api-s.facebook.com',
    ingestPort: 443,
    // Facebook cuts a broadcast at 8 hours. We recycle before that so the
    // stream keeps going (see plan R5).
    sessionLimitSeconds: 8 * 3600,
    defaultRuntimeMaxSeconds: 27900, // 7h45m
    // Encoder targets from Facebook's published guidelines.
    maxKeyframeIntervalSeconds: 2,
    /**
     * Frame size limit expressed by EDGE, not by width and height.
     *
     * These were maxWidth/maxHeight, compared as `width > 1920 || height > 1080`.
     * That silently rejected every VERTICAL video: 1080×1920 has exactly the same
     * pixel budget as 1920×1080, but its height is 1920, so the check failed and
     * the user was told their video was too large. Since normalise never changed
     * resolution, re-encoding could not fix it either — the video was stuck
     * forever. Comparing long edge against long limit works for both orientations.
     */
    maxLongEdge: 1920,
    maxShortEdge: 1080,
    maxFps: 30,
    /**
     * Audio sample rate for normalised output. 48 kHz is the broadcast standard and
     * what Facebook's own live guidance asks for.
     *
     * Deliberately NOT part of the compliance check: 44.1 kHz streams to Facebook
     * perfectly well, so flagging existing 44.1 kHz files would force re-encodes that
     * cost a generation of picture quality to fix something that was not broken. New
     * output is 48 kHz; old files are left alone.
     */
    audioSampleRate: 48000,
  },
};

module.exports = config;
