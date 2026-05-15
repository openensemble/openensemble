/**
 * Encryption-at-rest for sensitive fields in config.json.
 *
 * Architecture: each registered secret path (dotted) is replaced in-place
 * with an encrypted-blob marker the next time saveConfig() runs. Reads go
 * through getSecret() which transparently decrypts — old plaintext values
 * still work, so the migration is non-blocking.
 *
 * Encrypted-blob shape (back-compat with lib/email-crypto.mjs):
 *   {
 *     "__enc": "v1",
 *     "iv":  "<32 hex>",
 *     "tag": "<32 hex>",
 *     "ct":  "<hex ciphertext>"
 *   }
 *
 * Threat model (matches MIGRATION_per-user-encryption.md):
 *   ✓ Defends against: accidental git commit of config.json, log-share that
 *     snippets config but not the install dir, casual local file-read.
 *   ✗ Does NOT defend against: same-OS-account compromise (the OE process
 *     can read its own key file), runtime memory inspection, OS-level
 *     attacker, OE backup tarball theft (encrypted backups handle that —
 *     see lib/backup-crypto.mjs).
 *
 * Key location: users/_system/.master-key — uses the existing per-user
 * key infrastructure with a "system" pseudo-user. Two consequences:
 *   1. The key travels in OE's built-in backup (users/ is included), so
 *      reinstall + restore "just works" without manual key handling.
 *   2. Threat model identical to the existing per-user encryption — we're
 *      not introducing a weaker policy, just extending the same primitive.
 */

import fs from 'fs';
import path from 'path';
import { aesGcmEncrypt, aesGcmDecrypt, getUserKey } from './crypto.mjs';
import { USERS_DIR } from '../routes/_helpers/paths.mjs';

const SYSTEM_USER_ID = '_system';

/** Explicit dotted paths to encrypt. Used for nested fields where the
 *  `*ApiKey` / `*Token` regex below can't reach them. Add new paths here
 *  for nested secrets; flat top-level secrets are caught by the regex. */
export const SECRET_PATHS = [
  'cortex.lmstudioApiKey',
  'cortex.ollamaApiKey',
  'cortex.ollamaLocalApiKey',
];

/** Top-level field-name regex that flags secrets dynamically. New providers
 *  follow `<id>ApiKey` (e.g., `mistralApiKey`, `groqApiKey`) — this catches
 *  them all without needing an exhaustive list. Token credentials (Telegram
 *  bot, OAuth refresh tokens stored at top level) match too.
 *
 *  We deliberately exclude PUBLIC config that happens to have these names
 *  — none in the current schema, but if we ever add `enabledProviderApiKey`
 *  or similar, list it in NON_SECRET_OVERRIDES below. */
const SECRET_KEY_REGEX = /(ApiKey|BotToken|RefreshToken|AccessToken|ClientSecret)$/;

/** Top-level field names matching SECRET_KEY_REGEX that should NOT be
 *  encrypted (currently empty — placeholder for future false-positive
 *  exclusions). */
const NON_SECRET_OVERRIDES = new Set([]);

/** Resolve all secret-bearing dotted paths in a given cfg by combining
 *  the explicit list above with a top-level regex scan. */
function resolveSecretPaths(cfg) {
  const paths = new Set(SECRET_PATHS);
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(cfg)) {
      if (NON_SECRET_OVERRIDES.has(k)) continue;
      if (SECRET_KEY_REGEX.test(k)) paths.add(k);
    }
  }
  return [...paths];
}

// ── Key handling ─────────────────────────────────────────────────────────────

/** Ensure users/_system/ exists so getUserKey('_system') can write the key. */
function ensureSystemUserDir() {
  const dir = path.join(USERS_DIR, SYSTEM_USER_ID);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Bootstrap gate. Default = silently regenerating the master key is NOT
// allowed. The encryption-at-rest migration sets this to true for the
// duration of `migratePlaintextSecrets`, which is the ONLY code path that
// is allowed to generate a fresh master key. Anywhere else (decrypt on
// load, encrypt on save) requires the existing key to be present —
// silently creating a new one would orphan every previously-encrypted
// secret, losing them irrecoverably.
//
// History (2026-05-12): users/_system/ went missing for unknown reasons
// (likely a stale users/-wipe), OE restarted, getSystemKey silently
// generated a fresh key, and 11 stored API keys became permanently
// undecryptable. This gate makes the same failure loud instead of silent.
let _allowKeyCreation = false;

let _cachedSystemKey = null;
function getSystemKey() {
  if (_cachedSystemKey) return _cachedSystemKey;
  ensureSystemUserDir();
  const keyPath = path.join(USERS_DIR, SYSTEM_USER_ID, '.master-key');
  if (!fs.existsSync(keyPath) && !_allowKeyCreation) {
    throw new Error(
      `OE master key missing at ${keyPath}. ` +
      `If this is a fresh install, restart OE — startup migration will create one. ` +
      `If the key was deleted from a populated install, all encrypted-at-rest ` +
      `secrets (every *ApiKey in config.json) are irrecoverable: restore the file ` +
      `from a backup, or accept the loss and re-enter every API key in Settings.`
    );
  }
  _cachedSystemKey = getUserKey(SYSTEM_USER_ID);
  return _cachedSystemKey;
}

// ── Blob shape ───────────────────────────────────────────────────────────────

export function isEncryptedField(v) {
  return v != null
    && typeof v === 'object'
    && v.__enc === 'v1'
    && typeof v.iv === 'string'
    && typeof v.tag === 'string'
    && typeof v.ct === 'string';
}

function encryptValue(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return plaintext;
  const blob = aesGcmEncrypt(getSystemKey(), plaintext);
  return { __enc: 'v1', iv: blob.iv, tag: blob.tag, ct: blob.ciphertext };
}

function decryptValue(blob) {
  return aesGcmDecrypt(getSystemKey(), { iv: blob.iv, tag: blob.tag, ciphertext: blob.ct });
}

// ── Dotted-path get/set ──────────────────────────────────────────────────────

function splitPath(p) { return String(p).split('.').filter(Boolean); }

function getAtPath(obj, dotted) {
  if (!obj) return undefined;
  let cur = obj;
  for (const seg of splitPath(dotted)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setAtPath(obj, dotted, value) {
  const segs = splitPath(dotted);
  if (!segs.length) return;
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Encrypt every registered secret path in `cfg` that's currently plaintext.
 * Mutates cfg in place. Idempotent — already-encrypted values are skipped.
 *
 * Returns { encrypted: number, alreadyEncrypted: number, missing: number }
 * for caller logging.
 */
export function encryptConfigSecrets(cfg) {
  const stats = { encrypted: 0, alreadyEncrypted: 0, missing: 0 };
  if (!cfg || typeof cfg !== 'object') return stats;
  for (const p of resolveSecretPaths(cfg)) {
    const v = getAtPath(cfg, p);
    if (v == null || v === '') { stats.missing++; continue; }
    if (isEncryptedField(v)) { stats.alreadyEncrypted++; continue; }
    if (typeof v !== 'string') { stats.missing++; continue; }
    setAtPath(cfg, p, encryptValue(v));
    stats.encrypted++;
  }
  return stats;
}

/**
 * Decrypt all registered secret paths in `cfg`, returning a NEW object with
 * the decrypted values inlined. Use this when you need a fully-resolved
 * view (e.g., handing off to a provider client). The returned object is
 * a shallow-cloned copy — mutating it doesn't affect the input.
 *
 * Cheap getSecret(cfg, path) is the preferred call for single-field reads.
 */
export function decryptedConfigView(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const out = JSON.parse(JSON.stringify(cfg));
  for (const p of resolveSecretPaths(out)) {
    const v = getAtPath(out, p);
    if (isEncryptedField(v)) {
      try { setAtPath(out, p, decryptValue(v)); }
      catch (e) {
        console.warn(`[config-secrets] decrypt failed for ${p}:`, e.message);
        setAtPath(out, p, '');
      }
    }
  }
  return out;
}

/**
 * Read one secret by dotted path. Handles both encrypted and legacy
 * plaintext shapes — returns the decrypted string, or null if missing.
 *
 * Use this everywhere a config secret is consumed:
 *     const key = getSecret(cfg, 'cortex.anthropicKey');
 */
export function getSecret(cfg, dottedPath) {
  const v = getAtPath(cfg, dottedPath);
  if (v == null || v === '') return null;
  if (isEncryptedField(v)) {
    try { return decryptValue(v); }
    catch (e) { console.warn(`[config-secrets] decrypt failed for ${dottedPath}:`, e.message); return null; }
  }
  if (typeof v === 'string') return v; // legacy plaintext, still works
  return null;
}

/**
 * Set one secret by dotted path. Stores PLAINTEXT in the cfg object —
 * encryption happens in saveConfig() via encryptConfigSecrets(). Use
 * setSecret + saveConfig together.
 */
export function setSecret(cfg, dottedPath, value) {
  setAtPath(cfg, dottedPath, value ?? '');
}

/**
 * One-shot boot migration. Reads the raw config.json from disk (bypassing
 * the in-memory cache), and if any registered secret path is currently
 * plaintext, encrypts it in place and writes back. Idempotent — re-running
 * after everything is encrypted is a no-op.
 *
 * Called once from server startup. New installs hit this with empty config
 * (no-op). Existing installs migrating from a pre-encryption build encrypt
 * their plaintext keys on the first boot post-upgrade.
 */
export async function bootstrapEncryption({ cfgPath, atomicWriteSync, log = null }) {
  const fs = await import('fs');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') (log?.warn ?? console.warn)('[config-secrets] bootstrap read failed:', e.message);
    return { encrypted: 0, alreadyEncrypted: 0, missing: 0 };
  }
  const inspect = inspectSecrets(raw);
  const plaintextCount = Object.values(inspect).filter(v => v === 'plaintext').length;
  const encryptedCount = Object.values(inspect).filter(v => v === 'encrypted').length;

  if (plaintextCount === 0 && encryptedCount === 0) {
    // Fresh / empty config — nothing to migrate. Still create the master key
    // so the first save has somewhere to encrypt to. This is the canonical
    // first-run path.
    _allowKeyCreation = true;
    try { getSystemKey(); } finally { _allowKeyCreation = false; }
    (log?.info ?? (() => {}))('[config-secrets] no secrets configured yet; master key initialized');
    return { encrypted: 0, alreadyEncrypted: 0, missing: 0 };
  }
  if (plaintextCount === 0) {
    // Encrypted secrets already exist on disk — DO NOT create a new master
    // key if it's missing. Doing so would orphan every ciphertext. The
    // getSystemKey() call further down will throw a loud error in that
    // case, which is the desired behavior: forces the operator to restore
    // from backup or knowingly wipe and start over.
    (log?.info ?? (() => {}))('[config-secrets] all registered secrets already encrypted at rest');
    return { encrypted: 0, alreadyEncrypted: encryptedCount, missing: 0 };
  }
  // Mixed state or pure plaintext: legitimate first-time migration. Allow
  // key creation just for this call so encryptConfigSecrets can run.
  _allowKeyCreation = true;
  let stats;
  try {
    stats = encryptConfigSecrets(raw);
  } finally {
    _allowKeyCreation = false;
  }
  atomicWriteSync(cfgPath, JSON.stringify(raw, null, 2));
  (log?.info ?? console.log)(`[config-secrets] migrated ${stats.encrypted} plaintext secret${stats.encrypted === 1 ? '' : 's'} to encrypted-at-rest (key: users/_system/.master-key)`);
  return stats;
}

/**
 * For test / debug visibility: list which secret paths are currently
 * encrypted vs plaintext in the given config.
 */
export function inspectSecrets(cfg) {
  const result = {};
  for (const p of resolveSecretPaths(cfg)) {
    const v = getAtPath(cfg, p);
    if (v == null || v === '') result[p] = 'missing';
    else if (isEncryptedField(v))  result[p] = 'encrypted';
    else if (typeof v === 'string') result[p] = 'plaintext';
    else                            result[p] = 'unknown';
  }
  return result;
}
