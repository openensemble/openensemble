// @ts-check
/** Durable at-most-once boundary for outbound Telegram messages. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { USERS_DIR } from './paths.mjs';
import { getTurn } from './turn-trace-context.mjs';
import { withFileLock } from './file-lock.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const STORE_DIR = 'telegram-idempotency';
const LOCK_TIMEOUT_MS = 60_000;
const MIN_COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BACKGROUND_COMPLETED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PREFLIGHT_RETENTION_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_RECORDS = 25_000;
const _inflight = new Map();
const _lastSweep = new Map();

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function storeDir(userId) {
  const id = String(userId || '');
  if (!id || path.basename(id) !== id || id === '.' || id === '..') {
    throw new Error('A valid userId is required for Telegram delivery idempotency.');
  }
  return path.join(USERS_DIR, id, STORE_DIR);
}

export function currentTelegramTurnScope() {
  const turn = getTurn();
  if (!turn) return null;
  const messageId = String(turn.messageId || '').trim();
  if (messageId) return `message:${messageId}`;
  const rootId = String(turn.rootId || turn.attemptId || turn.turnId || '').trim();
  return rootId ? `root:${rootId}` : null;
}

/**
 * Stable scope for a scheduler-owned Telegram side effect. Timer rehydration
 * and builtin retries reuse the scheduler's occurrence identity; legacy
 * callers fail safe by collapsing onto the task's own durable identity.
 */
export function scheduledTelegramDeliveryScope(kind, task, runContext = {}) {
  const purpose = String(kind || 'scheduled-notification').trim() || 'scheduled-notification';
  const taskId = String(task?.id || 'unknown-task');
  const occurrence = String(
    runContext.scheduledRunRootId
      || runContext.occurrenceId
      || task?.datetime
      || task?.nextRunAt
      || `legacy:${taskId}`,
  );
  return `${purpose}:${taskId}:${occurrence}`;
}

function readRecord(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function writeRecord(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function currentDeliverySource() {
  const turn = getTurn();
  return {
    sourceMessageId: String(turn?.messageId || '').trim() || null,
    sourceSessionKey: String(turn?.sessionKey || '').trim() || null,
    sourceSessionEpoch: String(turn?.sessionEpoch || '').trim() || null,
  };
}

function sessionLocalId(userId, sessionKey) {
  const raw = String(sessionKey || '');
  const local = raw.startsWith(`${userId}_`) ? raw.slice(userId.length + 1) : raw;
  return local.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sessionContainsMessage(filePath, messageId) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    return lines.some(line => {
      try { return JSON.parse(line)?.messageId === messageId; }
      catch { return false; }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return null;
  }
}

/** True while the durable source message can still authorize browser Retry. */
function sourceMessageIsRetriable(userId, record) {
  const messageId = String(record?.sourceMessageId
    || (String(record?.scope || '').startsWith('message:') ? String(record.scope).slice(8) : '')).trim();
  if (!messageId) return null;
  const sessionsDir = path.join(USERS_DIR, userId, 'sessions');
  if (record?.sourceSessionKey) {
    if (record.sourceSessionEpoch) {
      const epochPath = path.join(sessionsDir, `${sessionLocalId(userId, record.sourceSessionKey)}.session-epoch`);
      let currentEpoch = 'legacy';
      try { currentEpoch = fs.readFileSync(epochPath, 'utf8').trim() || 'legacy'; }
      catch (error) { if (error?.code !== 'ENOENT') return true; }
      if (currentEpoch !== record.sourceSessionEpoch) return false;
    }
    return sessionContainsMessage(
      path.join(sessionsDir, `${sessionLocalId(userId, record.sourceSessionKey)}.jsonl`),
      messageId,
    );
  }

  // Legacy records lack a session key. Scan bounded session logs; any read
  // uncertainty retains the tombstone instead of guessing authority expired.
  let entries;
  try { entries = fs.readdirSync(sessionsDir, { withFileTypes: true }); }
  catch (error) { return error?.code === 'ENOENT' ? false : true; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const found = sessionContainsMessage(path.join(sessionsDir, entry.name), messageId);
    if (found === true || found === null) return true;
  }
  return false;
}

function shouldDeleteCompleted(userId, record, stat, now, {
  minCompletedRetentionMs,
  backgroundCompletedRetentionMs,
}) {
  const age = now - stat.mtimeMs;
  if (age <= minCompletedRetentionMs) return false;
  const sourceRetriable = sourceMessageIsRetriable(userId, record);
  if (sourceRetriable === true) return false;
  if (sourceRetriable === false) return true;
  return age > backgroundCompletedRetentionMs;
}

function replayResult(record, payloadHash) {
  // One scope authorizes one exact payload. Returning a prior success for new
  // text would let the caller claim that text was delivered when it was not.
  // Missing hashes (corrupt/legacy records) also fail closed.
  if (!record || record.payloadHash !== payloadHash) {
    return {
      ok: false,
      duplicate: true,
      payloadMismatch: Boolean(record),
      uncertain: true,
      messageIds: [],
    };
  }
  if (record.status === 'completed') {
    return { ok: true, duplicate: true, messageIds: record.messageIds || [] };
  }
  return { ok: false, duplicate: true, uncertain: true, messageIds: [] };
}

/**
 * Reclaim only records whose provider boundary is known. Dispatching,
 * uncertain, and malformed tombstones are retained indefinitely; deleting
 * any of those could authorize a duplicate send. Capacity therefore fails
 * closed when safe cleanup cannot make room.
 */
function sweepDeliveryRecords(dir, userId, now = Date.now(), {
  force = false,
  minCompletedRetentionMs = MIN_COMPLETED_RETENTION_MS,
  backgroundCompletedRetentionMs = BACKGROUND_COMPLETED_RETENTION_MS,
  preflightRetentionMs = PREFLIGHT_RETENTION_MS,
  maxRecords = MAX_RECORDS,
} = {}) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return { retained: 0, atCapacity: false, removed: 0 };
    throw error;
  }
  let records = entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name));
  const lastSweep = _lastSweep.get(dir) || 0;
  const shouldSweep = force || now - lastSweep >= SWEEP_INTERVAL_MS || records.length >= maxRecords;
  let removed = 0;
  if (shouldSweep) {
    _lastSweep.set(dir, now);
    for (const entry of records) {
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        const record = readRecord(file);
        const age = now - stat.mtimeMs;
        const safeToDelete = record?.status === 'completed'
          ? shouldDeleteCompleted(userId, record, stat, now, {
            minCompletedRetentionMs,
            backgroundCompletedRetentionMs,
          })
          : record?.status === 'preflight' && age > preflightRetentionMs;
        if (safeToDelete) {
          fs.rmSync(file, { force: true });
          removed += 1;
        }
      } catch { /* best-effort cleanup; capacity below remains fail closed */ }
    }
    if (removed) {
      try {
        records = fs.readdirSync(dir, { withFileTypes: true })
          .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name));
      } catch { /* use the conservative pre-cleanup count */ }
    }
  }
  return { retained: records.length, atCapacity: records.length >= maxRecords, removed };
}

/**
 * One logical browser/background request authorizes at most one Telegram
 * delivery. Telegram has no idempotency-key API, so any transport failure
 * after dispatch begins is retained as uncertain and never retried.
 */
export async function sendTelegramIdempotently({ userId, text, send, scopeId = undefined }) {
  if (typeof send !== 'function') throw new Error('send callback is required');
  const scope = scopeId === undefined ? currentTelegramTurnScope() : String(scopeId || '').trim() || null;
  // An unscoped automatic call is not authorized to cross the provider
  // boundary. Interactive tool calls inherit their current turn above;
  // schedulers/watchers must supply their durable event scope explicitly.
  if (!scope) return { ok: false, duplicate: false, scopeMissing: true, messageIds: [] };

  const dir = storeDir(userId);
  const operationId = sha256(`${userId}\0${scope}`);
  const payloadHash = sha256(String(text));
  const source = currentDeliverySource();
  const recordPath = path.join(dir, `${operationId}.json`);
  const lockPath = path.join(dir, '.locks', `${operationId}.lock`);

  const active = _inflight.get(operationId);
  if (active) {
    const first = await active;
    const record = readRecord(recordPath);
    return record ? replayResult(record, payloadHash) : { ...first, duplicate: true };
  }

  const operation = withFileLock(lockPath, async () => {
    const existing = readRecord(recordPath);
    if (existing?.status === 'completed') {
      return replayResult(existing, payloadHash);
    }
    if (existing?.status === 'preflight') {
      // A lock holder cannot coexist here; this is a crash before dispatch and
      // is safe to retry.
      fs.rmSync(recordPath, { force: true });
    } else if (existing || fs.existsSync(recordPath)) {
      return replayResult(existing, payloadHash);
    }

    const now = Date.now();
    // Distinct operation locks do not serialize quota checks. Reserve the
    // preflight tombstone under one short per-user admission lock, then release
    // it before the network call so unrelated Telegram sends remain parallel.
    const admission = await withFileLock(path.join(dir, '.locks', 'admission.lock'), async () => {
      const capacity = sweepDeliveryRecords(dir, userId, now);
      if (capacity.atCapacity) return { admitted: false, capacity };
      writeRecord(recordPath, {
        version: 1, operationId, scope, payloadHash,
        ...source,
        status: 'preflight', createdAt: now, updatedAt: now,
      });
      return { admitted: true, capacity };
    }, { timeoutMs: LOCK_TIMEOUT_MS });
    if (!admission.admitted) {
      return {
        ok: false,
        duplicate: false,
        storageFull: true,
        uncertain: true,
        messageIds: [],
      };
    }
    let dispatched = false;
    const markDispatchStarted = () => {
      if (dispatched) return;
      writeRecord(recordPath, {
        version: 1, operationId, scope, payloadHash,
        ...source,
        status: 'dispatching', createdAt: now, updatedAt: Date.now(),
      });
      dispatched = true;
    };
    try {
      const result = await send(markDispatchStarted);
      if (result?.ok !== true || !Array.isArray(result.messageIds)) {
        if (!dispatched) fs.rmSync(recordPath, { force: true });
        else writeRecord(recordPath, {
          version: 1, operationId, scope, payloadHash,
          ...source,
          status: 'uncertain', createdAt: now, updatedAt: Date.now(),
        });
        return { ok: false, duplicate: false, uncertain: dispatched, messageIds: [] };
      }
      writeRecord(recordPath, {
        version: 1, operationId, scope, payloadHash,
        ...source,
        status: 'completed', createdAt: now, updatedAt: Date.now(),
        messageIds: result.messageIds,
      });
      return { ok: true, duplicate: false, messageIds: result.messageIds };
    } catch (error) {
      if (!dispatched) fs.rmSync(recordPath, { force: true });
      else writeRecord(recordPath, {
        version: 1, operationId, scope, payloadHash,
        ...source,
        status: 'uncertain', createdAt: now, updatedAt: Date.now(),
        error: String(error?.message || error).slice(0, 500),
      });
      throw error;
    }
  }, { timeoutMs: LOCK_TIMEOUT_MS });

  _inflight.set(operationId, operation);
  try { return await operation; }
  finally { if (_inflight.get(operationId) === operation) _inflight.delete(operationId); }
}

export const _internal = Object.freeze({
  MIN_COMPLETED_RETENTION_MS,
  BACKGROUND_COMPLETED_RETENTION_MS,
  PREFLIGHT_RETENTION_MS,
  MAX_RECORDS,
  storeDir,
  sweepDeliveryRecords,
});
