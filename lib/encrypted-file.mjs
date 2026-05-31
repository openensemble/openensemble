// @ts-check
/**
 * Whole-file JSON encryption-at-rest, for token / config files that aren't
 * `config.json`. Same `__enc:v1` envelope and `_system` master key as
 * lib/config-secrets.mjs — different shape (the envelope is the whole file
 * payload, not a nested field).
 *
 * Threat model & key handling identical to config-secrets — defends against
 * git commit, log snippet, casual disk read; not OS-account compromise.
 *
 * Transparent migration:
 *   - readEncryptedJsonFile() accepts legacy plaintext JSON files unchanged.
 *   - writeEncryptedJsonFile() always writes the encrypted envelope.
 * So callers can switch over and existing plaintext files keep working
 * until their next write.
 */

import fs from 'fs';
import { aesGcmEncrypt, aesGcmDecrypt } from './crypto.mjs';
import { getSystemKey } from './config-secrets.mjs';

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isEncryptedEnvelope(v) {
  return v != null
    && typeof v === 'object'
    && /** @type {{__enc?: string}} */ (v).__enc === 'v1'
    && typeof /** @type {{iv?: unknown}} */ (v).iv === 'string'
    && typeof /** @type {{tag?: unknown}} */ (v).tag === 'string'
    && typeof /** @type {{ct?: unknown}} */ (v).ct === 'string';
}

/**
 * Read a JSON file at `filepath`. If the file is wrapped in our envelope,
 * decrypt and return the inner object. Otherwise treat the file as plain
 * JSON and return it directly — so legacy plaintext token files keep
 * working until their next write.
 *
 * Throws (same as fs.readFileSync / JSON.parse) on I/O errors or invalid
 * JSON. Throws on a malformed envelope / wrong key.
 *
 * @param {string} filepath
 * @returns {any}
 */
export function readEncryptedJsonFile(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!isEncryptedEnvelope(parsed)) return parsed;
  const plain = aesGcmDecrypt(getSystemKey(), {
    iv: parsed.iv, tag: parsed.tag, ciphertext: parsed.ct,
  });
  return JSON.parse(plain);
}

/**
 * Serialize `obj`, encrypt the JSON with the system master key, and write the
 * envelope to `filepath`. Same `{mode}` etc. options as fs.writeFileSync.
 *
 * @param {string} filepath
 * @param {any} obj
 * @param {{ mode?: number }} [opts]
 */
export function writeEncryptedJsonFile(filepath, obj, opts = {}) {
  const plain = JSON.stringify(obj);
  const blob = aesGcmEncrypt(getSystemKey(), plain);
  const envelope = { __enc: 'v1', iv: blob.iv, tag: blob.tag, ct: blob.ciphertext };
  const writeOpts = opts?.mode ? { mode: opts.mode } : undefined;
  fs.writeFileSync(filepath, JSON.stringify(envelope), writeOpts);
  if (opts?.mode) { try { fs.chmodSync(filepath, opts.mode); } catch { /* non-fatal */ } }
}

/**
 * Best-effort one-shot migrate: read filepath, if it parses as plaintext
 * JSON (not yet enveloped), rewrite it as an encrypted envelope.
 * Idempotent — already-encrypted files are skipped.
 *
 * Returns true if a migration happened, false otherwise.
 *
 * @param {string} filepath
 * @param {{ mode?: number }} [opts]
 * @returns {boolean}
 */
export function migrateJsonFileToEncrypted(filepath, opts = {}) {
  if (!fs.existsSync(filepath)) return false;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return false; }
  if (isEncryptedEnvelope(parsed)) return false;
  writeEncryptedJsonFile(filepath, parsed, opts);
  return true;
}

export { isEncryptedEnvelope };

/**
 * Walk every users/<id>/ directory and migrate any token files whose name
 * matches one of the supplied prefixes (e.g. `gmail-token`, `gcal-token`,
 * `ms-token`) from plaintext JSON to the encrypted envelope. Idempotent.
 *
 * Called once at server boot. Without this, plaintext token files sit on
 * disk until the next OAuth refresh hits them (could be an hour for Google,
 * longer if the user isn't actively using the service).
 *
 * @param {{ usersDir: string, prefixes: string[], log?: any }} args
 */
export async function bootstrapTokenFileEncryption({ usersDir, prefixes, log = null }) {
  const fs = (await import('fs')).default;
  const path = (await import('path')).default;
  const stats = { migrated: 0, alreadyEncrypted: 0, errored: 0 };
  if (!fs.existsSync(usersDir)) return stats;
  for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('user_')) continue;
    const userDir = path.join(usersDir, entry.name);
    let files = [];
    try { files = fs.readdirSync(userDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      if (!prefixes.some(pref => f === `${pref}.json` || f.startsWith(`${pref}-`) || f.startsWith(`${pref}.`))) continue;
      const full = path.join(userDir, f);
      try {
        const did = migrateJsonFileToEncrypted(full, { mode: 0o600 });
        if (did) stats.migrated++;
        else stats.alreadyEncrypted++;
      } catch (e) {
        stats.errored++;
        (log?.warn ?? console.warn)(`[encrypted-file] migrate failed for ${full}:`, e.message);
      }
    }
  }
  (log?.info ?? console.log)(`[encrypted-file] token-file bootstrap: migrated=${stats.migrated} already_encrypted=${stats.alreadyEncrypted} errored=${stats.errored}`);
  return stats;
}
