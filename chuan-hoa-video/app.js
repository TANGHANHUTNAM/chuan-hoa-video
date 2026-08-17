'use strict';

/**
 * Chuẩn Hoá Video — a standalone tool.
 *
 * Deliberately independent of the Facebook Live Manager app next door: no shared
 * modules, no database, no login, no SSH, no dependencies at all beyond Node itself.
 * Copy this folder anywhere and it still works. It runs on its own port so both can
 * be open at the same time.
 *
 * Why it exists: normalising on the VPS was measured at 0.32–0.51x realtime on 2
 * shared cores — about an hour for a 26-minute video — while competing for CPU with
 * the live streams that VPS is there to serve. The same file on a desktop took ten
 * minutes.
 *
 * The encode targets below are the ones verified against Facebook and against the
 * live pipeline. If they ever change in the main app, change them here too — that
 * duplication is the price of the two being independent, and it is written down
 * rather than hidden.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = __dirname;

/**
 * The two working folders live one level up, beside the launchers.
 *
 * Someone who does not write code unzips the folder and has to SEE where the video
 * goes. Burying it in chuan-hoa-video/ meant they had to know to look inside a
 * folder full of code first. So: `Chuan Hoa Video.cmd`, `video-can-chuan-hoa` and
 * `video-da-chuan-hoa` all sit at the top, next to `Facebook Live Manager.cmd`, and
 * only app.js stays out of the way.
 *
 * Overridable so the tool still works if its folder is moved somewhere on its own.
 */
const BASE = process.env.CHV_BASE
  ? path.resolve(process.env.CHV_BASE)
  : path.resolve(ROOT, '..');
const INBOX = path.join(BASE, 'video-can-chuan-hoa');
const OUTBOX = path.join(BASE, 'video-da-chuan-hoa');

// Not 3000: the Live Manager uses that, and both are meant to be open at once.
const PORT = Number(process.env.PORT) || 3100;

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.flv', '.m4v', '.webm', '.ts', '.mpg', '.mpeg', '.wmv']);

// ---------------------------------------------------------------------------
// The spec. One place, so it can be audited at a glance.
// ---------------------------------------------------------------------------

const SPEC = {
  maxLongEdge: 1920,
  maxShortEdge: 1080,
  maxFps: 30,
  maxKeyframeSeconds: 2,
  videoBitrate: '4500k',
  audioBitrate: '128k',
  audioSampleRate: 48000,
};

/** Output frames the user can ask for, named the way OBS names them. */
const TARGETS = {
  '1920x1080': { width: 1920, height: 1080, ratio: '16:9', label: 'ngang' },
  '1080x1920': { width: 1080, height: 1920, ratio: '9:16', label: 'dọc' },
};

// ---------------------------------------------------------------------------
// Finding ffmpeg
// ---------------------------------------------------------------------------

function locate(binary) {
  const exe = process.platform === 'win32' ? `${binary}.exe` : binary;

  for (const candidate of [
    path.join(ROOT, 'runtime', 'ffmpeg', exe),
    path.join(ROOT, 'ffmpeg', exe),
    // A copy sitting next to this folder, e.g. when it was unzipped beside the
    // Live Manager. Checked last so the tool's own copy always wins.
    path.join(ROOT, '..', 'runtime', 'ffmpeg', exe),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(finder, [binary], { encoding: 'utf8' });
  if (found.status === 0) {
    const first = String(found.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

const FFMPEG = locate('ffmpeg');
const FFPROBE = locate('ffprobe');

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const evenSize = (n) => { const r = Math.round(n); return Math.max(2, r - (r % 2)); };
const evenOffset = (n) => { const r = Math.max(0, Math.round(n)); return r - (r % 2); };

/**
 * How to place a picture inside a chosen output frame, or null when there is nothing
 * to do. Bars are the only reason to reframe: a 540x960 clip asked for 1080x1920 is
 * already 9:16, so re-encoding it would only cost a generation of quality.
 */
function fitPlan(width, height, choice) {
  if (!choice || choice === 'keep' || !width || !height) return null;
  const at = choice.lastIndexOf('_');
  const target = TARGETS[choice.slice(0, at)];
  const style = choice.slice(at + 1);
  if (!target || !['pad', 'blur'].includes(style)) return null;
  if (width === target.width && height === target.height) return null;

  const scale = Math.min(target.width / width, target.height / height);
  const contentWidth = Math.min(target.width, evenSize(width * scale));
  const contentHeight = Math.min(target.height, evenSize(height * scale));
  if (contentWidth === target.width && contentHeight === target.height) return null;

  return {
    style,
    frame: { width: target.width, height: target.height },
    content: { width: contentWidth, height: contentHeight },
    offset: {
      x: evenOffset((target.width - contentWidth) / 2),
      y: evenOffset((target.height - contentHeight) / 2),
    },
  };
}

/**
 * setsar=1 matters: rounding the content to even numbers makes `scale` preserve the
 * DISPLAY aspect by inventing a non-square sample aspect (measured: SAR 1215:1216,
 * DAR 135:76 instead of 16:9). A frame built by hand out of square pixels must say so.
 */
function fitFilter(plan) {
  const { frame, content, offset } = plan;
  const scaled = `scale=${content.width}:${content.height},setsar=1`;
  if (plan.style === 'pad') {
    return `[0:v]${scaled},pad=${frame.width}:${frame.height}:${offset.x}:${offset.y}:black,setsar=1[vout]`;
  }
  return (
    `[0:v]split=2[bg][fg];` +
    `[bg]scale=${frame.width}:${frame.height}:force_original_aspect_ratio=increase,` +
    `crop=${frame.width}:${frame.height},setsar=1,gblur=sigma=28[bgblur];` +
    `[fg]${scaled}[fgs];` +
    `[bgblur][fgs]overlay=${offset.x}:${offset.y},setsar=1[vout]`
  );
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

function parseFrameRate(value) {
  if (!value) return null;
  const [num, den] = String(value).split('/').map(Number);
  if (!den) return num || null;
  return Math.round((num / den) * 100) / 100;
}

/**
 * Largest gap between keyframes in the sampled stretch.
 *
 * The duration clamp is not a detail: without it a video SHORTER than the window is
 * condemned, because the tail is measured against time that does not exist. A
 * 10-second clip with perfect 2-second keyframes reported a 22-second gap.
 */
function maxKeyframeGap(times, windowSeconds, durationSeconds) {
  const t = times.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!t.length) return null;
  const end = durationSeconds > 0 ? Math.min(windowSeconds, durationSeconds) : windowSeconds;
  if (t.length === 1) return Math.round(Math.max(0, end - t[0]) * 100) / 100;
  let max = 0;
  for (let i = 1; i < t.length; i += 1) max = Math.max(max, t[i] - t[i - 1]);
  max = Math.max(max, end - t[t.length - 1]);
  return Math.round(Math.max(0, max) * 100) / 100;
}

function probe(file) {
  const meta = spawnSync(
    FFPROBE,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 }
  );
  let json;
  try { json = JSON.parse(meta.stdout); } catch { throw new Error('Không đọc được video này.'); }

  const streams = Array.isArray(json.streams) ? json.streams : [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('File không có luồng video.');

  const durationSeconds = Number(json.format?.duration) || null;
  const kf = spawnSync(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries',
      'frame=pts_time', '-read_intervals', '%+30', '-of', 'csv=p=0', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 }
  );

  return {
    durationSeconds,
    width: Number(v.width) || null,
    height: Number(v.height) || null,
    fps: parseFrameRate(v.r_frame_rate || v.avg_frame_rate),
    codecVideo: v.codec_name || null,
    codecAudio: a ? a.codec_name : null,
    pixelFormat: v.pix_fmt || null,
    hasAudio: Boolean(a),
    bitrate: Number(json.format?.bit_rate) || null,
    maxKeyframeInterval: maxKeyframeGap(
      String(kf.stdout || '').split(/\r?\n/).map((s) => s.trim().replace(/,+$/, '')).filter(Boolean),
      30,
      durationSeconds
    ),
  };
}

/** What is wrong for Facebook, and which stream has to be re-encoded to fix it. */
function evaluate(meta) {
  const notes = [];
  let video = false;
  let audio = false;

  if (meta.codecVideo !== 'h264') { notes.push(`Codec hình là ${meta.codecVideo || 'không rõ'}, Facebook cần H.264.`); video = true; }
  if (meta.pixelFormat && meta.pixelFormat !== 'yuv420p') { notes.push(`Định dạng màu ${meta.pixelFormat}, cần yuv420p.`); video = true; }

  if (!meta.width || !meta.height) { notes.push('Không đọc được độ phân giải.'); video = true; }
  else {
    const long = Math.max(meta.width, meta.height);
    const short = Math.min(meta.width, meta.height);
    if (long > SPEC.maxLongEdge || short > SPEC.maxShortEdge) {
      notes.push(`Khung hình ${meta.width}×${meta.height} vượt mức (cạnh dài ≤ ${SPEC.maxLongEdge}, cạnh ngắn ≤ ${SPEC.maxShortEdge} — dọc hay ngang đều được).`);
      video = true;
    }
  }

  if (meta.fps && meta.fps > SPEC.maxFps + 0.5) { notes.push(`${meta.fps} FPS cao hơn mức ${SPEC.maxFps}.`); video = true; }

  if (meta.maxKeyframeInterval == null) { notes.push('Không đo được khoảng cách khung hình chính.'); video = true; }
  else if (meta.maxKeyframeInterval > SPEC.maxKeyframeSeconds + 0.05) {
    notes.push(`Khung hình chính cách nhau tới ${meta.maxKeyframeInterval}s, Facebook cần ≤ ${SPEC.maxKeyframeSeconds}s. Đây là lý do phổ biến nhất khiến live bị giật.`);
    video = true;
  }

  if (!meta.hasAudio) { notes.push('Video không có tiếng. Facebook cần một luồng âm thanh.'); audio = true; }
  else if (meta.codecAudio && meta.codecAudio !== 'aac') { notes.push(`Âm thanh dùng ${meta.codecAudio}, cần AAC.`); audio = true; }

  return { ok: notes.length === 0, notes, needsVideo: video, needsAudio: audio };
}

/** Frame sizes that would actually change this video. */
function frameOptions(meta) {
  return Object.entries(TARGETS)
    .filter(([key]) => fitPlan(meta.width, meta.height, `${key}_pad`))
    .map(([key, t]) => ({ key, label: `${t.width}×${t.height}`, ratio: t.ratio, orientation: t.label }));
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function buildArgs({ input, output, meta, plan, reencodeVideo, encoder }) {
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'warning', '-progress', '-', '-i', input];

  const filter = reencodeVideo && plan ? fitFilter(plan) : null;

  if (!meta.hasAudio) {
    args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${SPEC.audioSampleRate}`);
    if (filter) args.push('-filter_complex', filter, '-map', '[vout]', '-map', '1:a:0');
    else args.push('-map', '0:v:0', '-map', '1:a:0');
    args.push('-shortest');
  } else if (filter) {
    args.push('-filter_complex', filter, '-map', '[vout]', '-map', '0:a:0');
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0');
  }

  if (reencodeVideo) {
    const common = [
      '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-r', String(SPEC.maxFps),
      '-g', String(SPEC.maxFps * SPEC.maxKeyframeSeconds),
      '-b:v', SPEC.videoBitrate, '-maxrate', SPEC.videoBitrate,
      '-bufsize', `${parseInt(SPEC.videoBitrate, 10) * 2}k`,
    ];
    if (encoder === 'libx264') {
      // x264's scene-cut detection would insert extra keyframes and stretch the gap
      // past 2s around them.
      args.push('-c:v', 'libx264', '-preset', 'veryfast', ...common,
        '-keyint_min', String(SPEC.maxFps * SPEC.maxKeyframeSeconds), '-sc_threshold', '0');
    } else {
      args.push('-c:v', encoder, ...common);
      if (encoder === 'h264_nvenc') args.push('-preset', 'p4', '-rc', 'cbr', '-no-scenecut', '1');
      else if (encoder === 'h264_qsv') args.push('-preset', 'medium');
      else if (encoder === 'h264_amf') args.push('-quality', 'balanced', '-rc', 'cbr');
    }
  } else {
    args.push('-c:v', 'copy');
  }

  args.push('-c:a', 'aac', '-b:a', SPEC.audioBitrate, '-ar', String(SPEC.audioSampleRate),
    '-ac', '2', '-movflags', '+faststart', output);
  return args;
}

/**
 * Which encoders actually work here.
 *
 * A listed encoder proves nothing: measured on this project, a machine with a real
 * GTX 1650 could not use h264_nvenc because ffmpeg 9.0 wants driver 610.00+ and the
 * installed one reports 12.2. So each is tried for one frame, and the failure reason
 * is kept to explain itself.
 */
let encoderCache = null;
function encoders() {
  if (encoderCache) return encoderCache;
  if (!FFMPEG) return { usable: [], unusable: [] };

  const listed = String(spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');
  const usable = [];
  const unusable = [];

  for (const key of ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf']) {
    if (!new RegExp(`\\b${key}\\b`).test(listed)) continue;
    if (key === 'libx264') { usable.push(key); continue; }
    const t = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=1',
      '-c:v', key, '-b:v', '1000k', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 });
    if (t.status === 0) usable.push(key);
    else {
      const lines = String(t.stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const why = lines.find((l) => l.includes(key) && !/Error while opening encoder/.test(l)) || lines[0] || '';
      unusable.push({ key, reason: why.replace(/^\[[^\]]+\]\s*/, '').slice(0, 200) });
    }
  }
  encoderCache = { usable, unusable };
  return encoderCache;
}

const jobs = new Map();

function start(name, choice, encoder) {
  const input = path.join(INBOX, name);
  if (!fs.existsSync(input)) throw new Error('Không tìm thấy file.');
  const running = jobs.get(name);
  if (running && running.status === 'running') return running;

  const meta = probe(input);
  const plan = fitPlan(meta.width, meta.height, choice);
  const verdict = evaluate(meta);

  // Re-encoding a file that is already correct cannot improve it; it can only cost a
  // generation of quality, because the encoder spends bitrate reproducing the
  // previous encode's artefacts.
  if (!plan && verdict.ok) {
    throw new Error(
      `${name} đã đạt chuẩn Facebook và đã ở khung ${meta.width}×${meta.height}. ` +
      `Không cần chuẩn hoá — dùng thẳng file này. Encode lại chỉ làm giảm chất lượng.`
    );
  }

  fs.mkdirSync(OUTBOX, { recursive: true });
  const base = path.basename(name, path.extname(name));
  const output = path.join(OUTBOX, `${base}${plan ? `-${plan.frame.width}x${plan.frame.height}` : '-chuan'}.mp4`);
  const reencodeVideo = Boolean(plan) || verdict.needsVideo;

  const job = {
    name, status: 'running', percent: 0, encoder, choice, output,
    startedAt: Date.now(), duration: meta.durationSeconds,
    step: reencodeVideo
      ? (plan ? `Đang đưa về khung ${plan.frame.width}×${plan.frame.height}` : 'Đang encode lại hình')
      : 'Chỉ sửa âm thanh, giữ nguyên hình',
    error: null,
  };
  jobs.set(name, job);

  const child = spawn(FFMPEG, buildArgs({ input, output, meta, plan, reencodeVideo, encoder }), { windowsHide: true });
  let tail = '';

  child.stdout.on('data', (chunk) => {
    let last = null;
    for (const m of String(chunk).matchAll(/out_time_us=(\d+)/g)) last = Number(m[1]);
    if (last != null && meta.durationSeconds > 0) {
      const at = last / 1_000_000;
      job.percent = Math.max(1, Math.min(99, Math.round((at / meta.durationSeconds) * 100)));
      const rate = at / ((Date.now() - job.startedAt) / 1000);
      job.step = `${job.percent}%` + (rate > 0 ? ` · còn khoảng ${Math.round((meta.durationSeconds - at) / rate)}s` : '');
    }
  });
  child.stderr.on('data', (c) => { tail = (tail + String(c)).slice(-2000); });
  child.on('error', (err) => { job.status = 'failed'; job.error = err.message; });
  child.on('close', (code) => {
    if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) {
      const secs = Math.round((Date.now() - job.startedAt) / 1000);
      job.status = 'success';
      job.percent = 100;
      job.step = `Xong sau ${secs}s (${meta.durationSeconds ? (meta.durationSeconds / secs).toFixed(2) : '?'}× thời gian thực)`;
    } else {
      job.status = 'failed';
      job.error = tail.trim().split(/\r?\n/).slice(-4).join('\n') || `ffmpeg exit ${code}`;
      // A half-written file would look like a finished result.
      try { fs.rmSync(output, { force: true }); } catch { /* best effort */ }
    }
  });
  return job;
}

// ---------------------------------------------------------------------------
// Web UI — plain HTML, no framework, no dependencies
// ---------------------------------------------------------------------------

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const hhmmss = (s) => {
  if (!s) return '';
  const t = Math.round(s);
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60]
    .map((x, i) => (i === 0 && x === 0 ? null : String(x).padStart(2, '0')))
    .filter((x) => x !== null).join(':');
};

function listInbox() {
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(OUTBOX, { recursive: true });
  return fs.readdirSync(INBOX, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => ({ name: e.name, size: fs.statSync(path.join(INBOX, e.name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

const CSS = `
:root{--bg:#0f1115;--card:#171a21;--line:#252a34;--tx:#e6e8ee;--mut:#9aa3b2;--ac:#4f8cff;--ok:#3fb950;--wa:#d29922;--er:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:1.5rem;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.card h3{margin:0 0 8px;font-size:1.05rem}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:.86em}
pre{background:#0b0d11;border:1px solid var(--line);border-radius:7px;padding:10px 12px;overflow-x:auto;margin:6px 0}
.mut{color:var(--mut)}.sm{font-size:.88rem}.tiny{font-size:.8rem}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:.75rem;font-weight:600}
.b-ok{background:rgba(63,185,80,.15);color:var(--ok)}.b-wa{background:rgba(210,153,34,.15);color:var(--wa)}
.b-er{background:rgba(248,81,73,.15);color:var(--er)}
.al{border-radius:8px;padding:11px 13px;margin:0 0 12px;font-size:.92rem}
.a-ok{background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.35)}
.a-wa{background:rgba(210,153,34,.1);border:1px solid rgba(210,153,34,.35)}
.a-er{background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.35)}
label.opt{display:block;padding:9px 11px;border:1px solid var(--line);border-radius:7px;margin-bottom:7px;cursor:pointer}
label.opt:hover{border-color:var(--ac)}label.opt input{margin-right:8px}
.hint{color:var(--mut);font-size:.83rem;margin-left:24px}
button{background:var(--ac);color:#fff;border:0;border-radius:7px;padding:9px 16px;font-size:.93rem;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.1)}select{background:#0b0d11;color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:7px 9px}
.bar{height:7px;background:#0b0d11;border-radius:99px;overflow:hidden;margin:8px 0}
.bar>span{display:block;height:100%;background:var(--ok);transition:width .4s}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
`;

function page() {
  const enc = encoders();
  const files = FFMPEG && FFPROBE ? listInbox() : [];
  let html = '';

  html += `<div class="wrap"><h1>Chuẩn Hoá Video</h1>
  <p class="sub">Công cụ riêng, chạy trên máy này. Không liên quan tới app Facebook Live Manager.</p>`;

  if (!FFMPEG || !FFPROBE) {
    html += `<div class="al a-er"><b>Chưa có ffmpeg trên máy này.</b>
      <p style="margin:8px 0 6px">Mở PowerShell và chạy một lần:</p>
      <pre>winget install --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements</pre>
      <p class="sm" style="margin:6px 0 0">Xong thì đóng cửa sổ đen của tool và bấm đôi lại.</p></div></div>`;
    return html;
  }

  html += `<div class="al a-ok">Sẽ encode trên <b>${esc(os.hostname())}</b> —
    ${esc(process.platform === 'win32' ? 'Windows' : process.platform)},
    ${os.cpus().length} luồng CPU${os.cpus()[0] ? ` (${esc(os.cpus()[0].model.trim())})` : ''}.</div>`;

  html += `<div class="card"><h3>Thư mục</h3>
    <p class="sm mut" style="margin:0 0 4px">Bỏ video vào đây:</p><pre>${esc(INBOX)}</pre>
    <p class="sm mut" style="margin:8px 0 4px">Kết quả:</p><pre>${esc(OUTBOX)}</pre></div>`;

  if (enc.unusable.length) {
    html += `<div class="card"><h3>Bộ mã hoá không dùng được</h3>`;
    for (const u of enc.unusable) {
      html += `<p class="sm" style="margin:0 0 6px"><span class="mono">${esc(u.key)}</span>
        <span class="mut"> — ${esc(u.reason)}</span></p>`;
    }
    html += `<p class="tiny mut" style="margin:6px 0 0">Có tên trong bản build không có nghĩa là máy chạy được,
      nên tool encode thử một khung trước khi đưa ra chọn.</p></div>`;
  }

  if (!files.length) {
    html += `<div class="card"><h3>Thư mục còn trống</h3>
      <p class="mut sm" style="margin:0">Copy video vào thư mục trên rồi tải lại trang (F5).</p></div>`;
  }

  for (const f of files) {
    const full = path.join(INBOX, f.name);
    let meta = null; let err = null;
    try { meta = probe(full); } catch (e) { err = e.message; }
    const job = jobs.get(f.name);

    html += `<div class="card"><div class="row"><h3 style="margin:0">${esc(f.name)}</h3>`;
    if (err) html += `<span class="badge b-er">Không đọc được</span>`;
    else {
      const vd = evaluate(meta);
      html += vd.ok ? `<span class="badge b-ok">Đã đạt chuẩn</span>` : `<span class="badge b-wa">Cần chuẩn hoá</span>`;
    }
    html += `</div>`;

    if (err) { html += `<div class="al a-er" style="margin:10px 0 0">${esc(err)}</div></div>`; continue; }

    const vd = evaluate(meta);
    const ratio = meta.width > meta.height ? '16:9 (ngang)' : meta.width < meta.height ? '9:16 (dọc)' : '1:1 (vuông)';
    html += `<p class="tiny mut" style="margin:6px 0 10px">${mb(f.size)} · ${meta.width}×${meta.height} · ${ratio}
      · ${meta.fps} FPS · ${esc(String(meta.codecVideo).toUpperCase())}/${esc(String(meta.codecAudio || 'không tiếng').toUpperCase())}
      · ${hhmmss(meta.durationSeconds)} · keyframe ${meta.maxKeyframeInterval}s</p>`;

    if (!vd.ok) {
      html += `<div class="al a-wa"><b>Vì sao cần chuẩn hoá</b><ul style="margin:6px 0 0;padding-left:20px">`;
      for (const n of vd.notes) html += `<li>${esc(n)}</li>`;
      html += `</ul></div>`;
    }

    if (job && job.status === 'running') {
      html += `<div class="bar"><span style="width:${job.percent}%"></span></div>
        <p class="sm" data-job="${esc(f.name)}" style="margin:0">${esc(job.step)}</p></div>`;
      continue;
    }
    if (job && job.status === 'success') {
      html += `<div class="al a-ok"><b>Xong.</b> ${esc(job.step)}<br>
        <span class="mono tiny">${esc(job.output)}</span></div>`;
    }
    if (job && job.status === 'failed') {
      html += `<div class="al a-er"><b>Không chuẩn hoá được.</b><pre style="white-space:pre-wrap">${esc(job.error)}</pre></div>`;
    }

    html += `<form method="post" action="/run"><input type="hidden" name="name" value="${esc(f.name)}">
      <p class="sm" style="margin:0 0 7px"><b>Độ phân giải đầu ra</b></p>
      <label class="opt"><input type="radio" name="choice" value="keep" checked>
        Giữ nguyên <b>${meta.width}×${meta.height}</b> · ${ratio}
        <div class="hint">Chỉ sửa những gì Facebook cần. Không đổi khung hình.</div></label>`;

    for (const opt of frameOptions(meta)) {
      for (const style of ['blur', 'pad']) {
        html += `<label class="opt"><input type="radio" name="choice" value="${opt.key}_${style}">
          <b>${opt.label}</b> · Tỉ lệ ${opt.ratio} (${opt.orientation}) — ${style === 'blur' ? 'nền mờ' : 'viền đen'}
          <div class="hint">${style === 'blur'
            ? 'Phần trống là bản phóng to làm mờ của chính video: full khung, không méo.'
            : 'Phần trống để đen trơn. Nhanh nhất và tốn ít bit nhất, nên phần hình được nhiều bit nhất.'}</div></label>`;
      }
    }

    if (enc.usable.length > 1) {
      html += `<p class="sm" style="margin:12px 0 6px"><b>Bộ mã hoá</b></p><select name="encoder">`;
      for (const e of enc.usable) {
        html += `<option value="${e}">${e === 'libx264' ? 'libx264 (CPU) — chất lượng tốt nhất trên mỗi bit' : `${e} (GPU)`}</option>`;
      }
      html += `</select>`;
    } else if (enc.usable.length === 1) {
      html += `<input type="hidden" name="encoder" value="${enc.usable[0]}">`;
    }

    html += `<p style="margin:14px 0 0"><button type="submit">Chuẩn hoá</button></p></form></div>`;
  }

  html += `</div><script>
    if (document.querySelector('[data-job]')) setInterval(async () => {
      try {
        const jobs = await (await fetch('/jobs')).json();
        let running = false;
        document.querySelectorAll('[data-job]').forEach((el) => {
          const j = jobs[el.getAttribute('data-job')];
          if (!j) return;
          el.textContent = j.step || '';
          if (j.status === 'running') running = true;
        });
        if (!running) location.reload();
      } catch (e) {}
    }, 2000);
  </script>`;
  return html;
}

// ---------------------------------------------------------------------------

http.createServer((req, res) => {
  const send = (code, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type }); res.end(body);
  };

  if (req.method === 'GET' && req.url === '/jobs') {
    return send(200, JSON.stringify(Object.fromEntries(jobs)), 'application/json; charset=utf-8');
  }

  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      try {
        start(p.get('name'), p.get('choice') || 'keep', p.get('encoder') || 'libx264');
        res.writeHead(302, { location: '/' }); res.end();
      } catch (e) {
        send(400, `<div class="wrap"><div class="al a-er"><b>Chưa chạy được</b><p>${esc(e.message)}</p></div>
          <p><a href="/" style="color:#4f8cff">← Quay lại</a></p></div>
          <style>${CSS}</style>`);
      }
    });
    return undefined;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    return send(200, `<!doctype html><html lang="vi"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Chuẩn Hoá Video</title><style>${CSS}</style></head><body>${page()}</body></html>`);
  }

  return send(404, 'Not found', 'text/plain; charset=utf-8');
}).listen(PORT, '127.0.0.1', () => {
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(OUTBOX, { recursive: true });
  const url = `http://localhost:${PORT}`;
  process.stdout.write(`\n  CHUAN HOA VIDEO\n  ${'-'.repeat(52)}\n`);
  process.stdout.write(`  Dia chi : ${url}\n`);
  process.stdout.write(`  ffmpeg  : ${FFMPEG || 'CHUA CO - xem huong dan tren trang web'}\n`);
  process.stdout.write(`  Bo video vao: ${INBOX}\n`);
  process.stdout.write(`  Ket qua o    : ${OUTBOX}\n`);
  process.stdout.write(`\n  DE TAT: dong cua so nay (hoac Ctrl + C)\n\n`);
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
});
