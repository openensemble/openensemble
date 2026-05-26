// @ts-check
/**
 * Credential primitive — encrypted at-rest store + in-RAM pending-prompt
 * registry. Used by the oe-admin skill (API keys, sudo passwords, plain
 * confirmations) but designed as a general primitive any tool can hook into.
 *
 * Key properties:
 *   - At rest: { iv, tag, ciphertext } per credential under
 *     users/<userId>/credentials/<id>.json, encrypted with the user's
 *     master key (same primitive as IMAP passwords).
 *   - In flight: server emits a `credential_prompt` WS frame; client
 *     pastes value into a protected widget and sends `submit_credential`.
 *     The plaintext value never enters the LLM message history.
 *   - Ephemeral kinds (`sudo`, `confirm`): held in RAM only, never persisted.
 *     `api_key`: persisted by default; opt-out is a future polish.
 *
 * Tool results that contain credential values must be marked
 * `{ isCredential: true, credentialId, ... }` so the per-provider
 * substitution in chat/providers/*.mjs replaces them with a placeholder
 * before sending to the LLM.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { aesGcmEncrypt, aesGcmDecrypt, getUserKey } from './crypto.mjs';
import { getUserDir } from '../routes/_helpers/paths.mjs';
import { log } from '../logger.mjs';

const DEFAULT_TTL_MS = 120_000;

function credentialsDir(userId) {
  return path.join(getUserDir(userId), 'credentials');
}
function credentialPath(userId, id) {
  return path.join(credentialsDir(userId), `${id}.json`);
}

function validateId(id) {
  if (typeof id !== 'string' || !id) return false;
  return /^[a-z0-9][a-z0-9_.-]*[a-z0-9]$|^[a-z0-9]$/i.test(id);
}

// ── At-rest store ────────────────────────────────────────────────────────────

/**
 * Persist a credential (encrypted with the per-user master key).
 * Returns the stored credential record (without plaintext).
 */
export async function storeCredential(userId, { id, label, kind = 'api_key', value, meta = {} }) {
  if (!userId) throw new Error('storeCredential: userId required');
  if (!validateId(id)) throw new Error(`storeCredential: invalid id "${id}"`);
  if (typeof value !== 'string' || !value.length) throw new Error('storeCredential: value must be a non-empty string');

  const dir = credentialsDir(userId);
  await fsp.mkdir(dir, { recursive: true });
  const encrypted = aesGcmEncrypt(getUserKey(userId), value);
  const record = {
    id,
    label: label ?? id,
    kind,
    createdAt: new Date().toISOString(),
    encrypted,
    meta,
  };
  const file = credentialPath(userId, id);
  await fsp.writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  log.info('credentials', 'credential stored', { userId, id, kind });
  return { id: record.id, label: record.label, kind: record.kind, createdAt: record.createdAt };
}

/** Return the plaintext value for a stored credential, or null if missing. */
export function getCredentialValue(userId, id) {
  if (!userId || !validateId(id)) return null;
  const file = credentialPath(userId, id);
  if (!fs.existsSync(file)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!rec.encrypted) return null;
    return aesGcmDecrypt(getUserKey(userId), rec.encrypted);
  } catch (e) {
    log.warn('credentials', 'decrypt failed', { userId, id, err: e.message });
    return null;
  }
}

/** List credentials (metadata only — never returns plaintext). */
export function listCredentials(userId) {
  if (!userId) return [];
  const dir = credentialsDir(userId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      out.push({ id: rec.id, label: rec.label, kind: rec.kind, createdAt: rec.createdAt });
    } catch {}
  }
  return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** Remove a stored credential. Returns true if a file was deleted. */
export function deleteCredential(userId, id) {
  if (!userId || !validateId(id)) return false;
  const file = credentialPath(userId, id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  log.info('credentials', 'credential deleted', { userId, id });
  return true;
}

// ── In-RAM pending-prompt registry ───────────────────────────────────────────

// Two complementary maps:
//   _pending[id] → { userId, kind, persist, resolve, reject, timer }
//   _ramValues[id] → string (only for kind='sudo'|'confirm', never persisted)
const _pending = new Map();
const _ramValues = new Map();

let _emit = null;

/**
 * Wire up the server-side WS broadcast helper. Called once from server.mjs
 * after the WS handler is initialized. `sendToUserFn(userId, payload)` is
 * the existing per-user broadcast in ws-handler.mjs.
 */
export function setCredentialEmitter(sendToUserFn) {
  _emit = sendToUserFn;
}

function newCredentialId(kind) {
  return `${kind}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Request a credential from the user. Emits a `credential_prompt` WS frame
 * and resolves with the credential id once the client submits.
 *
 * Options:
 *   userId        — owner of the credential (must be a real user id)
 *   id?           — explicit credential id (otherwise auto-generated)
 *   label         — display label shown in the chat widget
 *   description?  — optional supporting text
 *   kind          — 'api_key' | 'sudo' | 'confirm'
 *   ttlMs         — optional timeout (default 120s; sudo/longer recipes pass more)
 *   persist       — defaults to (kind === 'api_key'); ephemeral kinds always false
 *
 * Returns a Promise that resolves with { id, label, kind, persisted } or
 * rejects with { code: 'TIMEOUT' | 'CANCELLED' }.
 */
export function requestCredential(opts) {
  const {
    userId, id: explicitId, label = '', description = '',
    kind = 'api_key', ttlMs = DEFAULT_TTL_MS,
  } = opts ?? {};
  if (!userId) return Promise.reject(new Error('requestCredential: userId required'));
  if (!_emit) return Promise.reject(new Error('requestCredential: emitter not wired (server still starting?)'));
  const persist = kind === 'api_key' ? (opts.persist ?? true) : false;
  const id = explicitId ?? newCredentialId(kind);
  if (!validateId(id)) return Promise.reject(new Error(`requestCredential: invalid id "${id}"`));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      const e = /** @type {Error & {code?: string}} */ (new Error(`credential prompt timed out (${ttlMs}ms): ${id}`));
      e.code = 'TIMEOUT';
      reject(e);
    }, ttlMs);
    _pending.set(id, { userId, kind, label, persist, resolve, reject, timer });
    try {
      _emit(userId, {
        type: 'credential_prompt',
        credentialId: id,
        label,
        description,
        kind,
      });
    } catch (e) {
      clearTimeout(timer);
      _pending.delete(id);
      reject(e);
    }
  });
}

/**
 * Server-side handler for the client → server `submit_credential` WS frame.
 * Returns { ok, error? } so ws-handler can ack the client appropriately.
 */
export async function submitCredential({ credentialId, value, userId }) {
  const entry = _pending.get(credentialId);
  if (!entry) return { ok: false, error: 'no_pending_prompt' };
  if (entry.userId !== userId) return { ok: false, error: 'wrong_user' };
  if (typeof value !== 'string' || !value.length) return { ok: false, error: 'empty_value' };
  clearTimeout(entry.timer);
  _pending.delete(credentialId);
  try {
    if (entry.persist) {
      await storeCredential(userId, {
        id: credentialId,
        label: entry.label,
        kind: entry.kind,
        value,
      });
    } else {
      _ramValues.set(credentialId, value);
    }
    entry.resolve({ id: credentialId, label: entry.label, kind: entry.kind, persisted: entry.persist });
    // Tell the client the prompt is resolved so its widget can show a final
    // "Provided" state. The actual value is never echoed back.
    try { _emit?.(userId, { type: 'credential_resolved', credentialId }); } catch {}
    return { ok: true };
  } catch (e) {
    entry.reject(e);
    return { ok: false, error: e.message };
  }
}

/** Client cancelled the prompt. Rejects the pending promise. */
export function cancelCredential({ credentialId, userId }) {
  const entry = _pending.get(credentialId);
  if (!entry || entry.userId !== userId) return { ok: false };
  clearTimeout(entry.timer);
  _pending.delete(credentialId);
  const e = /** @type {Error & {code?: string}} */ (new Error(`credential prompt cancelled: ${credentialId}`));
  e.code = 'CANCELLED';
  entry.reject(e);
  try { _emit?.(userId, { type: 'credential_resolved', credentialId, cancelled: true }); } catch {}
  return { ok: true };
}

/**
 * Resolve a credential value at run time. Looks first in the RAM map
 * (sudo/confirm), then on disk (api_key). Returns null if missing.
 */
export function resolveCredentialValue(userId, credentialId) {
  if (_ramValues.has(credentialId)) return _ramValues.get(credentialId);
  return getCredentialValue(userId, credentialId);
}

/**
 * Drop an in-RAM credential value as soon as the consuming op completes.
 * Always call after a sudo/confirm credential has been used.
 */
export function dropRamCredential(credentialId) {
  if (_ramValues.has(credentialId)) {
    // Best-effort overwrite before delete (defense-in-depth; Node strings are
    // immutable so this only matters if the value happened to be stored as a
    // Buffer somewhere upstream).
    _ramValues.set(credentialId, '');
    _ramValues.delete(credentialId);
  }
}

/**
 * Replace text containing a credential value with redacted placeholders.
 * Used to scrub command output (e.g., sudo echoing the password on auth
 * failure) before surfacing as a tool_result.
 */
export function redactSecret(text, secret) {
  if (!text || !secret) return text;
  // Escape regex metas in the secret.
  const esc = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp(esc, 'g'), '[REDACTED]');
}

// ── Global redaction registry (defense-in-depth) ─────────────────────────────
//
// Tools that handle secrets register the literal value with `registerRedaction`
// before executing any subprocess that might echo it. The provider layer calls
// `applyRedactions()` on every tool_result content string before appending it
// to the LLM-bound working[] payload, so a value that slips into stdout never
// reaches the model.
//
// Primary defense is still tool design: never put credential values in result
// strings, and use `redactSecret(output, password)` when running subprocesses.
// This registry is the backstop.

const _redactSet = new Set();

export function registerRedaction(value) {
  if (typeof value === 'string' && value.length >= 4) {
    _redactSet.add(value);
  }
}

export function unregisterRedaction(value) {
  if (typeof value === 'string') _redactSet.delete(value);
}

/**
 * Scrub any registered redaction values from a string. Cheap when the
 * registry is empty (common case).
 */
export function applyRedactions(text) {
  if (!text || _redactSet.size === 0) return text;
  let out = String(text);
  for (const secret of _redactSet) {
    if (!secret) continue;
    const esc = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'g'), '[REDACTED]');
  }
  return out;
}

/**
 * For tests: drop all pending prompts and RAM values.
 */
export function _resetForTests() {
  for (const [, entry] of _pending) {
    clearTimeout(entry.timer);
    try {
      const e = /** @type {Error & {code?: string}} */ (new Error('reset for tests'));
      e.code = 'RESET';
      entry.reject(e);
    } catch {}
  }
  _pending.clear();
  _ramValues.clear();
  _redactSet.clear();
}
