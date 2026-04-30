/**
 * AES-256-GCM encrypt/decrypt for IMAP passwords.
 *
 * As of 2026-04-30 this layer uses per-user keys at users/{userId}/.master-key
 * via lib/crypto.mjs. The legacy global key in config.json:imapEncryptionKey
 * is preserved as a read-only fallback for un-migrated records during the
 * dual-key window — see scripts/migrate-email-crypto-to-per-user.mjs and
 * MIGRATION_per-user-encryption.md for the migration path. Once every install
 * has migrated, the global-key path can be removed (Phase 5 in the migration
 * doc).
 */

import { Buffer } from 'buffer';
import { loadConfig } from '../routes/_helpers.mjs';
import { aesGcmEncrypt, aesGcmDecrypt, getUserKey } from './crypto.mjs';

let warnedGlobalFallback = false;

function getGlobalKey() {
  const cfg = loadConfig();
  if (!cfg.imapEncryptionKey) return null;
  return Buffer.from(cfg.imapEncryptionKey, 'hex');
}

/**
 * Encrypt an IMAP password for a specific user. Always uses the per-user key.
 */
export async function encrypt(userId, plaintext) {
  if (!userId) throw new Error('encrypt requires a userId (per-user encryption)');
  const key = getUserKey(userId);
  return aesGcmEncrypt(key, plaintext);
}

/**
 * Decrypt an IMAP password for a specific user.
 *
 * Tries the per-user key first; on auth-tag mismatch falls back to the
 * legacy global key. The fallback path lets pre-migration records keep
 * working while the migration script is being run — see MIGRATION_per-user-
 * encryption.md for the full migration plan.
 */
export async function decrypt(userId, ciphertext) {
  if (!userId) throw new Error('decrypt requires a userId (per-user encryption)');
  if (!ciphertext || !ciphertext.iv) {
    throw new Error('decrypt requires { iv, tag, ciphertext }');
  }

  // Per-user first — the post-migration norm.
  try {
    const userKey = getUserKey(userId);
    return aesGcmDecrypt(userKey, ciphertext);
  } catch (e) {
    // Auth-tag mismatch or key-format error — try the legacy global key.
    const globalKey = getGlobalKey();
    if (!globalKey) {
      throw new Error(`IMAP decrypt failed for user ${userId} and no global imapEncryptionKey is configured: ${e.message}`);
    }
    try {
      const plaintext = aesGcmDecrypt(globalKey, ciphertext);
      if (!warnedGlobalFallback) {
        // Warn once per process so the operator notices un-migrated records
        // without spamming the log on every fetch.
        console.warn(
          `[email-crypto] Decrypting with legacy global imapEncryptionKey ` +
          `for user ${userId} — run scripts/migrate-email-crypto-to-per-user.mjs ` +
          `to re-key existing records with per-user keys.`
        );
        warnedGlobalFallback = true;
      }
      return plaintext;
    } catch (e2) {
      throw new Error(`IMAP decrypt failed with both per-user and global keys for user ${userId}: ${e2.message}`);
    }
  }
}
