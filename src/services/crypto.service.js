'use strict';

const crypto = require('node:crypto');
const config = require('../config');

/**
 * AES-256-GCM for the three secrets we must never store in plaintext
 * (spec section 10): SSH passwords, SSH private keys, and Facebook RTMPS URLs.
 *
 * Stored format is a single self-describing string:
 *   v1:<iv base64>:<ciphertext base64>:<authTag base64>
 *
 * The version prefix means a future key rotation or algorithm change can be
 * detected instead of silently producing garbage.
 */

const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce length.
const ALGORITHM = 'aes-256-gcm';

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, config.encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    ciphertext.toString('base64'),
    authTag.toString('base64'),
  ].join(':');
}

function decrypt(payload) {
  if (payload == null || payload === '') return null;

  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Dữ liệu mã hoá không đúng định dạng.');
  }

  const [, ivB64, ctB64, tagB64] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    config.encryptionKey,
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM authentication failed: either the value was tampered with or
    // APP_ENCRYPTION_KEY changed since it was written.
    throw new Error(
      'Không giải mã được dữ liệu. APP_ENCRYPTION_KEY có thể đã bị thay đổi.'
    );
  }
}

/** Best-effort decrypt for display paths where a failure must not crash a page. */
function tryDecrypt(payload) {
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt, tryDecrypt };
