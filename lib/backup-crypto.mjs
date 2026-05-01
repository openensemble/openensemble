/**
 * Password-based encryption for OpenEnsemble backup archives.
 *
 * Format (all big-endian):
 *   [4 bytes ] magic     "OE1\x01"
 *   [16 bytes] salt      (scrypt salt, random per backup)
 *   [12 bytes] iv        (AES-GCM IV, random per backup)
 *   [N bytes ] ciphertext  (AES-256-GCM encryption of the original tar.gz)
 *   [16 bytes] auth tag   (GCM tag)
 *
 * Constants for v1:
 *   - KDF: scrypt N=2^15, r=8, p=1, dkLen=32 (~30ms on a modern CPU)
 *   - Cipher: AES-256-GCM
 *
 * Forgot-the-password recovery is impossible by design — the key is derived
 * solely from the password + salt, neither of which alone reveals plaintext.
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';

export const MAGIC = Buffer.from([0x4f, 0x45, 0x31, 0x01]); // "OE1\x01"
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN; // 32

export function isEncryptedBackup(buf) {
  if (!buf || buf.length < MAGIC.length) return false;
  return buf.slice(0, MAGIC.length).equals(MAGIC);
}

function deriveKey(password, salt) {
  if (typeof password !== 'string' || !password.length) {
    throw new Error('Password is required');
  }
  return scryptSync(Buffer.from(password, 'utf8'), salt, KEY_LEN, KDF);
}

/**
 * Encrypt a plaintext buffer (the raw tar.gz backup) with the given password.
 * Returns a single Buffer in the layout described above.
 */
export function encryptBackup(plain, password) {
  if (!Buffer.isBuffer(plain)) throw new Error('encryptBackup expects a Buffer');
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, ct, tag]);
}

/**
 * Decrypt an encrypted-backup buffer back into the raw tar.gz. Throws on
 * wrong password (auth-tag mismatch surfaces as "Unsupported state or
 * unable to authenticate data" — we rewrap with a friendlier message).
 */
export function decryptBackup(buf, password) {
  if (!isEncryptedBackup(buf)) {
    throw new Error('Not an encrypted OpenEnsemble backup');
  }
  if (buf.length < HEADER_LEN + TAG_LEN) {
    throw new Error('Encrypted backup is truncated');
  }
  const salt = buf.slice(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = buf.slice(MAGIC.length + SALT_LEN, HEADER_LEN);
  const ct = buf.slice(HEADER_LEN, buf.length - TAG_LEN);
  const tag = buf.slice(buf.length - TAG_LEN);
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (e) {
    // Auth-tag mismatch / wrong password — surface as a clear message.
    const err = new Error('Wrong password or corrupted backup');
    err.cause = e;
    throw err;
  }
}
