// @ts-check
/**
 * Disk-persisted destructive-operation approvals.
 *
 * Entries are scoped by (userId, kind, agentId) and stored at
 * users/<userId>/pending-approvals.json.  Every operation, including reads
 * that may prune expired rows, runs under a cross-process filesystem lock.
 * This matters when a development server and the systemd service overlap:
 * process-local Maps/Promises cannot prevent both processes from consuming
 * and executing the same destructive approval.
 *
 * Store shape:
 *   { [kind]: [ { agentId, sessionEpoch, ts, expiresAt, opId, payload } ] }
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { USERS_DIR } from './paths.mjs';
import { getTurn } from './turn-trace-context.mjs';
import { withFileLockSync } from './file-lock.mjs';
import { getSessionEpoch } from '../sessions.mjs';

const MINUTE = 60 * 1000;
const DEFAULT_TTL_MS = 10 * MINUTE;

/** Finite server-side lifetime for every approval family. */
export const APPROVAL_TTL_MS = Object.freeze({
  expense_delete: 10 * MINUTE,
  email_purge: 10 * MINUTE,
  trust_promotion: 10 * MINUTE,
  watcher_op: 5 * MINUTE,
});

function safeId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, '_'); }
function filePath(userId) { return path.join(USERS_DIR, safeId(userId), 'pending-approvals.json'); }
function lockPath(userId) { return `${filePath(userId)}.lock`; }

function assertUserId(userId) {
  if (userId == null || userId === 'null' || userId === 'undefined') {
    throw new Error('pending-approvals: refusing access without a userId');
  }
}

function kindTtlMs(kind) {
  return APPROVAL_TTL_MS[kind] ?? DEFAULT_TTL_MS;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function corruptStore(message, cause = null) {
  const error = /** @type {Error & {code: string, cause?: unknown}} */ (
    new Error(`pending-approvals: unreadable/corrupt store (${message}); refusing approval operations`)
  );
  error.code = 'PENDING_APPROVAL_STORE_CORRUPT';
  if (cause) error.cause = cause;
  return error;
}

/**
 * Parse and validate the whole store.  ENOENT alone means "no approvals";
 * malformed JSON, bad shape, or any other read failure is fail-closed and must
 * never be silently replaced with an empty store.
 */
function loadUnlocked(userId) {
  const p = filePath(userId);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { data: Object.create(null), dirty: false };
    throw corruptStore(e?.message || 'read failed', e);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw corruptStore('invalid JSON', e);
  }
  if (!isRecord(parsed)) throw corruptStore('root must be an object');

  const data = Object.create(null);
  let dirty = false;
  for (const [kind, rawList] of Object.entries(parsed)) {
    if (!Array.isArray(rawList)) throw corruptStore(`'${kind}' must be an array`);
    data[kind] = rawList.map((rawEntry, index) => {
      if (!isRecord(rawEntry)) throw corruptStore(`'${kind}' entry ${index} must be an object`);
      if (!Number.isFinite(rawEntry.ts)) throw corruptStore(`'${kind}' entry ${index} has invalid ts`);
      if (rawEntry.agentId != null && typeof rawEntry.agentId !== 'string') {
        throw corruptStore(`'${kind}' entry ${index} has invalid agentId`);
      }
      if (rawEntry.sessionEpoch != null && typeof rawEntry.sessionEpoch !== 'string') {
        throw corruptStore(`'${kind}' entry ${index} has invalid sessionEpoch`);
      }
      if (!isRecord(rawEntry.payload)) throw corruptStore(`'${kind}' entry ${index} has invalid payload`);
      if (rawEntry.opId != null && typeof rawEntry.opId !== 'string') {
        throw corruptStore(`'${kind}' entry ${index} has invalid opId`);
      }
      if (rawEntry.expiresAt != null && !Number.isFinite(rawEntry.expiresAt)) {
        throw corruptStore(`'${kind}' entry ${index} has invalid expiresAt`);
      }

      // Upgrade pre-TTL/pre-opId rows inside the same locked transaction.
      // Their age still counts from original staging, so old indefinite rows
      // expire immediately rather than receiving a fresh window on upgrade.
      const opId = rawEntry.opId || ('ap_' + randomUUID());
      const expiresAt = rawEntry.expiresAt ?? (rawEntry.ts + kindTtlMs(kind));
      if (!rawEntry.opId || rawEntry.expiresAt == null) dirty = true;
      return {
        agentId: rawEntry.agentId ?? null,
        sessionEpoch: rawEntry.sessionEpoch ?? null,
        ts: rawEntry.ts,
        expiresAt,
        opId,
        payload: rawEntry.payload,
      };
    });
  }
  return { data, dirty };
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Atomic, fsync-durable save. Must be called while holding the user lock. */
function saveUnlocked(userId, data) {
  const p = filePath(userId);
  const dir = path.dirname(p);
  const hasEntries = Object.values(data).some(list => Array.isArray(list) && list.length > 0);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (!hasEntries) {
    try {
      fs.unlinkSync(p);
      fsyncDirectory(dir);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
    return;
  }

  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, p);
    // The file fsync persists bytes; the directory fsync persists the rename.
    fsyncDirectory(dir);
  } catch (e) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

function withStoreLock(userId, fn) {
  assertUserId(userId);
  return withFileLockSync(lockPath(userId), fn);
}

/** Exact chat scoping. Legacy/null rows are visible only to null-agent callers. */
function agentsMatch(a, b) {
  return (a ?? null) === (b ?? null);
}

function pruneExpired(data, now) {
  let changed = false;
  for (const [kind, list] of Object.entries(data)) {
    const keep = list.filter(entry => entry.expiresAt > now);
    if (keep.length !== list.length) {
      data[kind] = keep;
      changed = true;
    }
  }
  return changed;
}

function pruneSupersededSession(data, userId) {
  let changed = false;
  for (const [kind, list] of Object.entries(data)) {
    const keep = list.filter(entry => {
      if (!entry.agentId || !entry.sessionEpoch) return true;
      const scopedAgentId = entry.agentId.startsWith(`${userId}_`)
        ? entry.agentId
        : `${userId}_${entry.agentId}`;
      // Never prune against the caller's ALS epoch. A cleared/aborted E1 turn
      // may finish after a new E2 turn stages an approval; using E1 here let the
      // stale finalizer delete the newer destructive operation. The durable
      // session generation is the sole authority shared by every process.
      return entry.sessionEpoch === getSessionEpoch(scopedAgentId);
    });
    if (keep.length !== list.length) {
      data[kind] = keep;
      changed = true;
    }
  }
  return changed;
}

function callerDeadline(entry, ttlMs) {
  if (ttlMs == null) return entry.expiresAt;
  if (!Number.isFinite(ttlMs)) throw new TypeError('pending-approvals: ttlMs must be finite or null');
  // A caller may narrow the central policy (legacy watcher API), never extend
  // a persisted approval beyond its server-side expiry.
  return Math.min(entry.expiresAt, entry.ts + ttlMs);
}

function publicEntry(entry) {
  return {
    ...entry.payload,
    ts: entry.ts,
    expiresAt: entry.expiresAt,
    agentId: entry.agentId ?? null,
    sessionEpoch: entry.sessionEpoch ?? null,
    opId: entry.opId,
  };
}

/**
 * Stage or replace one approval for (kind, current turn agent).
 * @param {string} userId
 * @param {string} kind
 * @param {object} payload
 */
export function stagePending(userId, kind, payload) {
  assertUserId(userId);
  if (typeof kind !== 'string' || !kind) throw new TypeError('pending-approvals: kind is required');
  if (!isRecord(payload)) throw new TypeError('pending-approvals: payload must be an object');
  const agentId = getTurn()?.agentId ?? null;
  const sessionEpoch = getTurn()?.sessionEpoch ?? null;
  const now = Date.now();
  const opId = 'ap_' + randomUUID();

  return withStoreLock(userId, () => {
    if (agentId && sessionEpoch) {
      const scopedAgentId = agentId.startsWith(`${userId}_`)
        ? agentId
        : `${userId}_${agentId}`;
      if (getSessionEpoch(scopedAgentId) !== sessionEpoch) {
        const error = /** @type {Error & {code?: string}} */ (
          new Error('pending-approvals: session was cleared before approval staging')
        );
        error.code = 'SESSION_CLEARED';
        throw error;
      }
    }
    const { data } = loadUnlocked(userId);
    pruneExpired(data, now);
    pruneSupersededSession(data, userId);
    const list = Array.isArray(data[kind]) ? data[kind] : [];
    data[kind] = [
      ...list.filter(entry => !agentsMatch(entry.agentId, agentId)),
      { agentId, sessionEpoch, ts: now, expiresAt: now + kindTtlMs(kind), opId, payload },
    ];
    saveUnlocked(userId, data);
    return opId;
  });
}

/**
 * Read without consuming. Expiry cleanup and legacy migration are persisted
 * under the same exclusive lock.
 */
export function getPending(userId, kind, agentId = null, { ttlMs = null } = {}) {
  const now = Date.now();
  return withStoreLock(userId, () => {
    const state = loadUnlocked(userId);
    let changed = state.dirty || pruneExpired(state.data, now);
    changed = pruneSupersededSession(state.data, userId) || changed;
    const list = Array.isArray(state.data[kind]) ? state.data[kind] : [];
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (agentsMatch(list[i].agentId, agentId)) { idx = i; break; }
    }

    if (idx !== -1 && callerDeadline(list[idx], ttlMs) <= now) {
      list.splice(idx, 1);
      state.data[kind] = list;
      idx = -1;
      changed = true;
    }
    if (changed) saveUnlocked(userId, state.data);
    return idx === -1 ? null : publicEntry(list[idx]);
  });
}

/**
 * Atomically claim an approval: select + validate expiry + durably remove all
 * happen inside ONE cross-process critical section.  The entry is returned to
 * the destructive executor only after its removal is fsync-durable, so two OE
 * processes can never both receive the same operation.
 */
export function takePending(userId, kind, agentId = null, { ttlMs = null, expectedOpId = null } = {}) {
  const now = Date.now();
  if (expectedOpId != null && typeof expectedOpId !== 'string') {
    throw new TypeError('pending-approvals: expectedOpId must be a string or null');
  }
  return withStoreLock(userId, () => {
    const state = loadUnlocked(userId);
    let changed = state.dirty || pruneExpired(state.data, now);
    changed = pruneSupersededSession(state.data, userId) || changed;
    const list = Array.isArray(state.data[kind]) ? state.data[kind] : [];
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (agentsMatch(list[i].agentId, agentId)) { idx = i; break; }
    }

    if (idx === -1) {
      if (changed) saveUnlocked(userId, state.data);
      return null;
    }
    if (callerDeadline(list[idx], ttlMs) <= now) {
      list.splice(idx, 1);
      state.data[kind] = list;
      saveUnlocked(userId, state.data);
      return null;
    }
    // Optional compare-and-consume hook for approval cards.  A stale card can
    // ask to claim X without consuming a newer Y that replaced it.
    if (expectedOpId != null && list[idx].opId !== expectedOpId) {
      if (changed) saveUnlocked(userId, state.data);
      return null;
    }

    const found = list[idx];
    list.splice(idx, 1);
    state.data[kind] = list;
    changed = true;
    if (changed) saveUnlocked(userId, state.data);
    return publicEntry(found);
  });
}

/** Drop only this agent's approval family (plus legacy null-agent rows). */
export function clearPendingFor(userId, kind, agentId = null, { expectedOpId = null } = {}) {
  const now = Date.now();
  return withStoreLock(userId, () => {
    const state = loadUnlocked(userId);
    let changed = state.dirty || pruneExpired(state.data, now);
    changed = pruneSupersededSession(state.data, userId) || changed;
    const list = Array.isArray(state.data[kind]) ? state.data[kind] : [];
    const keep = list.filter(entry =>
      !agentsMatch(entry.agentId, agentId)
      || (expectedOpId != null && entry.opId !== expectedOpId));
    let removed = false;
    if (keep.length !== list.length) {
      state.data[kind] = keep;
      changed = true;
      removed = true;
    }
    if (changed) saveUnlocked(userId, state.data);
    return removed;
  });
}

/** Test hook: wipe the whole store file through the same process-safe lock. */
export function _resetPendingApprovals(userId) {
  return withStoreLock(userId, () => saveUnlocked(userId, Object.create(null)));
}
