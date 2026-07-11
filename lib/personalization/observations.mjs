// @ts-check
/**
 * Per-user encrypted-at-rest observation log:
 * users/<uid>/personalization/observations.jsonl
 *
 * Digest-at-capture — this log NEVER stores raw email bodies/full calendar
 * dumps, only one-line digests (hard-capped at 400 chars, see the Observation
 * schema in the personalization spec). Each line is its own AES-256-GCM
 * envelope (per-user key via lib/crypto.mjs), NOT a whole-file envelope, so
 * appends stay O(1) — appendFileSync never has to decrypt+re-encrypt the
 * whole log. Envelope shape matches lib/encrypted-file.mjs's on-disk shape:
 * { __enc:'v1', iv, tag, ct } (hex strings).
 * The personalization directory is forced to 0700 and the log to 0600 on
 * every access/write, repairing permissive modes left by older versions.
 *
 * Corrupt/unreadable lines are skipped and logged, never thrown — a single
 * damaged line (partial write, disk error) must not take down reflection or
 * the ledger UI.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { USERS_DIR } from '../paths.mjs';
import { getUserKey, aesGcmEncrypt, aesGcmDecrypt } from '../crypto.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';
import {
  STRUCTURED_SIGNAL_TYPES,
  redactSecretsDeep,
  sanitizeSignalEntities,
  sanitizeSignalMetadata,
  sanitizeSignalText,
} from './signal-safety.mjs';

const MAX_DIGEST_LEN = 400;
const DEFAULT_LIMIT = 2000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_SOURCE_LEN = 120;
const MAX_ID_FIELD_LEN = 120;
const VALID_KINDS = new Set([
  'tool_result', 'interest', 'unmet_intent', 'capability_miss', 'system',
  ...STRUCTURED_SIGNAL_TYPES,
]);

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}
function obsPath(userId) {
  return path.join(personalizationDir(userId), 'observations.jsonl');
}

function boundedField(value, maxLen) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > maxLen ? clean.slice(0, maxLen) : clean;
}

function ensureSecureObservationDir(userId) {
  const dir = personalizationDir(userId);
  fs.mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
  // mkdir's mode only applies when creating the final component. Re-apply it
  // so an existing directory restored with a permissive mode is repaired too.
  fs.chmodSync(dir, DIRECTORY_MODE);
  return dir;
}

function hardenExistingObservationPaths(userId) {
  const dir = personalizationDir(userId);
  const p = obsPath(userId);
  if (fs.existsSync(dir)) fs.chmodSync(dir, DIRECTORY_MODE);
  if (fs.existsSync(p)) fs.chmodSync(p, FILE_MODE);
}

function genId() {
  return `obs_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

function encryptLine(userId, obs) {
  const key = getUserKey(userId);
  const { iv, tag, ciphertext } = aesGcmEncrypt(key, JSON.stringify(obs));
  return JSON.stringify({ __enc: 'v1', iv, tag, ct: ciphertext });
}

function decryptLine(key, line) {
  const envelope = JSON.parse(line);
  if (envelope.__enc !== 'v1' || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ct !== 'string') {
    throw new Error('unrecognized observation envelope shape');
  }
  const json = aesGcmDecrypt(key, { iv: envelope.iv, tag: envelope.tag, ciphertext: envelope.ct });
  return JSON.parse(json);
}

function isReadableObservation(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.id === 'string' && /^obs_[a-zA-Z0-9_.:-]+$/.test(value.id)
    && typeof value.ts === 'string' && Number.isFinite(Date.parse(value.ts))
    && typeof value.digest === 'string');
}

/**
 * Read + decrypt every well-formed line; corrupt lines are dropped (logged).
 *
 * Returns `{ lines, obs, keyError, readError }` — `keyError:true` means the per-user key
 * itself couldn't be loaded (e.g. transient permission drift on the master
 * key file), as distinct from an individual corrupt/undecryptable LINE.
 * Callers that only ever READ (readObservations) can safely treat both cases
 * the same way (nothing to show), but pruneObservations must NOT: a key
 * failure must abort rather than being treated as "every line is corrupt,
 * remove them all" (which would silently wipe the entire log on rewrite).
 */
function readAllDecrypted(userId) {
  const p = obsPath(userId);
  let raw;
  try {
    hardenExistingObservationPaths(userId);
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[personalization] observations read failed for ${userId}: ${e.message}`);
    return { lines: [], obs: [], keyError: false, readError: e.code === 'ENOENT' ? null : e };
  }
  let key;
  try {
    key = getUserKey(userId);
  } catch (e) {
    console.warn(`[personalization] observations key error for ${userId}: ${e.message}`);
    return { lines: [], obs: [], keyError: true, readError: null };
  }
  const rawLines = raw.split('\n').filter(Boolean);
  const lines = [];
  const obs = [];
  for (const line of rawLines) {
    try {
      const o = decryptLine(key, line);
      if (!isReadableObservation(o)) throw new Error('invalid observation payload');
      lines.push(line);
      obs.push(o);
    } catch (e) {
      console.warn(`[personalization] skipping corrupt observation line for ${userId}: ${e.message}`);
    }
  }
  return { lines, obs, keyError: false, readError: null };
}

/**
 * Append one observation. Fills id (obs_<ts>_<rand>) and ts (ISO-8601);
 * caller-supplied digest is normalized to one line and hard-capped at 400
 * chars regardless of source. Entities and metadata are bounded and metadata
 * is recursively credential-redacted at this final persistence boundary.
 * Returns the stored (plaintext) observation object.
 */
export async function appendObservation(userId, obsPartial) {
  if (!userId) throw new Error('appendObservation requires a userId');
  const partial = obsPartial && typeof obsPartial === 'object' ? obsPartial : {};
  const cleanDigest = sanitizeSignalText(partial.digest, MAX_DIGEST_LEN);
  const digest = String(redactSecretsDeep(cleanDigest, { maxString: MAX_DIGEST_LEN }) || '');
  const obs = {
    schemaVersion: 1,
    id: genId(),
    ts: new Date().toISOString(),
    source: boundedField(partial.source, MAX_SOURCE_LEN) || 'system',
    skillId: boundedField(partial.skillId, MAX_ID_FIELD_LEN),
    kind: VALID_KINDS.has(partial.kind) ? partial.kind : 'system',
    digest,
    entities: sanitizeSignalEntities(partial.entities),
    metadata: sanitizeSignalMetadata(partial.metadata),
    agentId: boundedField(partial.agentId, MAX_ID_FIELD_LEN),
    // Provenance: 'automation' = fired by a scheduled task/watcher, not a
    // live user turn. Anything else (including absent, incl. pre-07-07 rows)
    // normalizes to 'interactive'.
    origin: partial.origin === 'automation' ? 'automation' : 'interactive',
  };
  const p = obsPath(userId);
  return withLock(p, () => {
    ensureSecureObservationDir(userId);
    if (fs.existsSync(p)) fs.chmodSync(p, FILE_MODE);
    const line = encryptLine(userId, obs);
    fs.appendFileSync(p, line + '\n', { encoding: 'utf8', mode: FILE_MODE });
    fs.chmodSync(p, FILE_MODE);
    return obs;
  });
}

/**
 * Read observations, optionally filtered to ts >= sinceTs (ISO string),
 * capped to the most recent `limit` (default 2000). Insertion order
 * preserved for the returned window.
 */
export async function readObservations(userId, { sinceTs = null, limit = DEFAULT_LIMIT } = {}) {
  if (!userId) throw new Error('readObservations requires a userId');
  const { obs, keyError, readError } = readAllDecrypted(userId);
  // An absent log is a real empty log; an unreadable log/key is not. Surface
  // the latter so reflection retains its cursor instead of mistaking a
  // transient permission/key failure for "no new signal".
  if (keyError) throw new Error('observation key unavailable');
  if (readError) throw new Error(`observation log unavailable: ${readError.message}`);
  let filtered = obs;
  const sinceMs = sinceTs ? Date.parse(sinceTs) : NaN;
  if (!Number.isNaN(sinceMs)) {
    filtered = filtered.filter(o => {
      const ms = Date.parse(o.ts);
      return Number.isNaN(ms) ? true : ms >= sinceMs;
    });
  }
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  return filtered.length > cap ? filtered.slice(filtered.length - cap) : filtered;
}

/**
 * Drop observations older than retentionDays (by ts). Corrupt lines
 * encountered during the sweep are dropped too (they're unreadable anyway).
 * Rewrites the file only when something was actually removed, via
 * atomicWriteSync (a full-file rewrite, unlike the O(1) append path).
 *
 * If the user's key can't be loaded at all, ABORTS without rewriting
 * anything — {removed:0, aborted:'key-unavailable'} — rather than treating
 * "key failed" the same as "every line is corrupt" (which would silently
 * wipe the whole observation log on a transient key-read failure, e.g.
 * permission drift after a restore/rsync).
 */
export async function pruneObservations(userId, retentionDays) {
  if (!userId) throw new Error('pruneObservations requires a userId');
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 30;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const p = obsPath(userId);
  return withLock(p, () => {
    if (!fs.existsSync(p)) return { removed: 0 };
    hardenExistingObservationPaths(userId);

    const { lines, obs, keyError, readError } = readAllDecrypted(userId);
    if (keyError || readError) {
      const reason = keyError ? 'key-unavailable' : 'read-unavailable';
      console.warn(`[personalization] pruneObservations: aborting for ${userId} — observation ${reason} (never rewriting an unreadable log)`);
      return { removed: 0, aborted: reason };
    }
    // readAllDecrypted already silently drops undecryptable lines from `lines`
    // relative to the raw file — count those as removed too.
    let rawLineCount = 0;
    try { rawLineCount = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch { /* handled above */ }
    let removed = Math.max(0, rawLineCount - lines.length);

    const keptLines = [];
    for (let i = 0; i < obs.length; i++) {
      const ms = Date.parse(obs[i].ts);
      if (!Number.isNaN(ms) && ms < cutoffMs) { removed++; continue; }
      keptLines.push(lines[i]);
    }
    if (removed > 0) {
      atomicWriteSync(p, keptLines.length ? keptLines.join('\n') + '\n' : '', { mode: FILE_MODE });
      fs.chmodSync(p, FILE_MODE);
    }
    return { removed };
  });
}
