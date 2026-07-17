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
const _inflight = new Map();

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
  const recordPath = path.join(dir, `${operationId}.json`);
  const lockPath = path.join(dir, '.locks', `${operationId}.lock`);

  const active = _inflight.get(operationId);
  if (active) {
    await active;
    const record = readRecord(recordPath);
    return record?.status === 'completed'
      ? { ok: true, duplicate: true, messageIds: record.messageIds || [] }
      : { ok: false, duplicate: true, uncertain: true, messageIds: [] };
  }

  const operation = withFileLock(lockPath, async () => {
    const existing = readRecord(recordPath);
    if (existing?.status === 'completed') {
      return { ok: true, duplicate: true, messageIds: existing.messageIds || [] };
    }
    if (existing?.status === 'preflight') {
      // A lock holder cannot coexist here; this is a crash before dispatch and
      // is safe to retry.
      fs.rmSync(recordPath, { force: true });
    } else if (existing || fs.existsSync(recordPath)) {
      return { ok: false, duplicate: true, uncertain: true, messageIds: [] };
    }

    const now = Date.now();
    writeRecord(recordPath, {
      version: 1, operationId, scope, payloadHash,
      status: 'preflight', createdAt: now, updatedAt: now,
    });
    let dispatched = false;
    const markDispatchStarted = () => {
      if (dispatched) return;
      writeRecord(recordPath, {
        version: 1, operationId, scope, payloadHash,
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
          status: 'uncertain', createdAt: now, updatedAt: Date.now(),
        });
        return { ok: false, duplicate: false, uncertain: dispatched, messageIds: [] };
      }
      writeRecord(recordPath, {
        version: 1, operationId, scope, payloadHash,
        status: 'completed', createdAt: now, updatedAt: Date.now(),
        messageIds: result.messageIds,
      });
      return { ok: true, duplicate: false, messageIds: result.messageIds };
    } catch (error) {
      if (!dispatched) fs.rmSync(recordPath, { force: true });
      else writeRecord(recordPath, {
        version: 1, operationId, scope, payloadHash,
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
