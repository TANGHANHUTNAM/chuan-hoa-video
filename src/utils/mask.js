'use strict';

/**
 * Scrubs secrets out of any text before it reaches a log file or the browser
 * (spec sections 24, 30, 40.5).
 *
 * Applied in two places that both matter:
 *  - everything the logger writes
 *  - FFmpeg/journalctl output shown in the Logs viewer, which routinely echoes
 *    the full RTMPS URL including the stream key
 */

// Keep the first 2 and last 4 characters so the user can still tell two
// destinations apart, but not enough to reuse the key.
function maskToken(token) {
  if (!token || token.length <= 8) return '****';
  return `${token.slice(0, 2)}${'*'.repeat(Math.max(4, token.length - 6))}${token.slice(-4)}`;
}

const PATTERNS = [
  // rtmps://host[:port]/rtmp/STREAM_KEY  ->  keep host, mask the key
  {
    re: /(rtmps?:\/\/[^\s/]+\/[^\s/]*\/)([^\s"'&]+)/gi,
    replace: (_m, prefix, key) => `${prefix}${maskToken(key)}`,
  },
  // Bare Facebook stream keys, which look like FB-<digits>-<digits>-<blob>
  {
    re: /\bFB-[0-9]+-[0-9]+-[A-Za-z0-9_-]+/g,
    replace: (m) => maskToken(m),
  },
  // PEM private key blocks
  {
    re: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    replace: () => '[private key redacted]',
  },
];

function maskSecrets(input) {
  if (input == null) return input;
  let text = typeof input === 'string' ? input : String(input);
  for (const { re, replace } of PATTERNS) {
    text = text.replace(re, replace);
  }
  return text;
}

/**
 * Display form for a saved destination: rtmps://host/.../FB-****abcd
 * Used in the UI so a saved stream key is never echoed back in full.
 */
function maskRtmpsUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const key = segments.pop() || '';
    return `${parsed.protocol}//${parsed.host}/${segments.join('/')}/${maskToken(key)}`;
  } catch {
    return maskSecrets(url);
  }
}

/** Last 4 characters of the stream key, for compact UI labels. */
function keyLast4(url) {
  if (!url) return '';
  const segments = String(url).split('/').filter(Boolean);
  const key = segments[segments.length - 1] || '';
  return key.slice(-4);
}

module.exports = { maskSecrets, maskRtmpsUrl, maskToken, keyLast4 };
