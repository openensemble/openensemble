// @ts-check
/**
 * Small, privacy-bounded personalization decision timeline.
 *
 * This is an audit of what the subsystem decided, never a second observation
 * log: callers pass counts, stable ids, short redacted labels, and outcomes —
 * not raw tool output, calendar bodies, or conversation text.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { USERS_DIR } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';
import { redactSecretsDeep, sanitizeSignalText } from './signal-safety.mjs';

const MAX_EVENTS = 200;
const MAX_DETAIL_KEYS = 20;
const MAX_STRING = 300;
const TYPE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

function dirFor(userId) { return path.join(USERS_DIR, userId, 'personalization'); }
function fileFor(userId) { return path.join(dirFor(userId), 'history.json'); }

function secureDir(userId) {
  const dir = dirFor(userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }
}

function readFile(userId, { strict = false } = {}) {
  try {
    const obj = JSON.parse(fs.readFileSync(fileFor(userId), 'utf8'));
    return {
      version: Number.isInteger(obj?.version) ? obj.version : 0,
      events: Array.isArray(obj?.events) ? obj.events : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[personalization] history read failed for ${userId}: ${e.message}`);
      if (strict) throw new Error(`Personalization history is unreadable: ${e.message}`);
    }
    return { version: 0, events: [] };
  }
}

function safeValue(value, depth = 0) {
  if (depth > 2 || value == null) return value == null ? null : undefined;
  if (typeof value === 'string') return redactSecretsDeep(value, { maxString: MAX_STRING });
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => safeValue(v, depth + 1)).filter(v => v !== undefined);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, MAX_DETAIL_KEYS)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(k)) continue;
      const safe = safeValue(v, depth + 1);
      if (safe !== undefined) out[k] = safe;
    }
    return out;
  }
  return undefined;
}

/** Record one short audit event and return its stored shape. */
export async function recordHistory(userId, event = {}) {
  if (!userId) return null;
  const type = TYPE_RE.test(String(event.type || '')) ? String(event.type) : 'system.event';
  const stored = {
    id: `ph_${Date.now()}_${randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
    type,
    summary: redactSecretsDeep(sanitizeSignalText(event.summary, MAX_STRING), { maxString: MAX_STRING }),
    // Apply the shared object sanitizer at the final boundary too: safeValue
    // bounds shape/depth, while redactSecretsDeep also replaces sensitive
    // field names so the audit cannot leak that a particular credential key
    // existed.
    details: redactSecretsDeep(safeValue(event.details || {}) || {}, {
      maxDepth: 4, maxKeys: MAX_DETAIL_KEYS, maxArray: 20, maxString: MAX_STRING,
    }),
  };
  return withLock(fileFor(userId), () => {
    const file = readFile(userId, { strict: true });
    file.events.push(stored);
    if (file.events.length > MAX_EVENTS) file.events.splice(0, file.events.length - MAX_EVENTS);
    secureDir(userId);
    atomicWriteSync(fileFor(userId), JSON.stringify({
      version: file.version + 1, updated_at: Date.now(), events: file.events,
    }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(fileFor(userId), 0o600); } catch { /* non-POSIX */ }
    return stored;
  });
}

export async function listHistory(userId, { limit = 50 } = {}) {
  if (!userId) return [];
  const cap = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
  return readFile(userId, { strict: true }).events.slice(-cap).reverse();
}

/** Remove audit rows tied to a profile memory before/after that memory is erased. */
export async function scrubHistoryForMemory(userId, memoryId) {
  if (!userId || !memoryId) return 0;
  return withLock(fileFor(userId), () => {
    const file = readFile(userId, { strict: true });
    const before = file.events.length;
    file.events = file.events.filter(event => event?.details?.memoryId !== memoryId);
    const removed = before - file.events.length;
    if (!removed) return 0;
    secureDir(userId);
    atomicWriteSync(fileFor(userId), JSON.stringify({
      version: file.version + 1, updated_at: Date.now(), events: file.events,
    }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(fileFor(userId), 0o600); } catch { /* non-POSIX */ }
    return removed;
  });
}

export async function clearHistory(userId) {
  if (!userId) return false;
  return withLock(fileFor(userId), () => {
    const file = readFile(userId, { strict: true });
    secureDir(userId);
    atomicWriteSync(fileFor(userId), JSON.stringify({
      version: file.version + 1, updated_at: Date.now(), events: [],
    }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(fileFor(userId), 0o600); } catch { /* non-POSIX */ }
    return true;
  });
}
