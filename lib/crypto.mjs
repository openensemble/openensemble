/**
 * AES-256-GCM primitive + per-user key resolver.
 *
 * Keys live at users/{userId}/.master-key (32 random bytes, mode 0600).
 * Generated lazily on first call; subsequent reads reuse the same file.
 *
 * Ciphertext shape: { iv, tag, ciphertext } with hex-encoded strings —
 * same shape as the older lib/email-crypto.mjs so on-disk records do not
 * need a format migration when callers switch to per-user keys.
 *
 * This module is the foundation for both IMAP-password encryption (see
 * lib/email-crypto.mjs) and the upcoming skill-config secret encryption.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, statSync } from 'fs';
import path from 'path';
import { getUserDir } from '../routes/_helpers/paths.mjs';

const KEY_FILENAME = '.master-key';
const KEY_BYTES = 32; // AES-256 → 32-byte key

/**
 * Read or lazily generate a 32-byte per-user encryption key.
 * Always returns a Buffer of length KEY_BYTES.
 */
export function getUserKey(userId) {
  if (!userId) throw new Error('getUserKey requires a userId');
  const keyPath = path.join(getUserDir(userId), KEY_FILENAME);

  if (existsSync(keyPath)) {
    const buf = readFileSync(keyPath);
    if (buf.length !== KEY_BYTES) {
      throw new Error(`Master key at ${keyPath} is ${buf.length} bytes, expected ${KEY_BYTES}`);
    }
    // Best-effort: re-chmod on every read so permissions don't drift after
    // restore/rsync (mirrors active-sessions.json's pattern).
    try {
      const mode = statSync(keyPath).mode & 0o777;
      if (mode !== 0o600) chmodSync(keyPath, 0o600);
    } catch { /* non-fatal */ }
    return buf;
  }

  // Atomic create — flag 'wx' fails if the file appeared between the
  // existsSync above and this write (parallel first-use race).
  const fresh = randomBytes(KEY_BYTES);
  try {
    writeFileSync(keyPath, fresh, { flag: 'wx', mode: 0o600 });
    try { chmodSync(keyPath, 0o600); } catch { /* non-fatal */ }
    return fresh;
  } catch (e) {
    if (e.code === 'EEXIST') return readFileSync(keyPath); // someone else won the race
    throw e;
  }
}

/**
 * Encrypt a UTF-8 plaintext with the given key. Returns a record with
 * hex-encoded { iv, tag, ciphertext } — JSON-friendly, same shape as
 * lib/email-crypto.mjs's existing format.
 */
export function aesGcmEncrypt(key, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`aesGcmEncrypt requires a ${KEY_BYTES}-byte Buffer key`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv:         iv.toString('hex'),
    tag:        tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Decrypt an { iv, tag, ciphertext } record with the given key. Throws
 * with a recognizable message on auth-tag mismatch so callers can choose
 * to fall back to a different key (e.g. global → per-user migration).
 */
export function aesGcmDecrypt(key, { iv, tag, ciphertext }) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`aesGcmDecrypt requires a ${KEY_BYTES}-byte Buffer key`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(Buffer.from(ciphertext, 'hex')) + decipher.final('utf8');
}
