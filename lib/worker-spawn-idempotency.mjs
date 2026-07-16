// @ts-check
/** Durable at-most-once admission for task-scoped background workers. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { USERS_DIR } from './paths.mjs';
import { getTurn } from './turn-trace-context.mjs';
import { withFileLock } from './file-lock.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const STORE_DIR = 'worker-spawn-idempotency';
const LOCK_TIMEOUT_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const _turnOrdinals = new WeakMap();

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeSegment(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || path.basename(text) !== text || text === '.' || text === '..') {
    throw new Error(`A valid ${label} is required for worker admission.`);
  }
  return text;
}

function storeDir(userId) {
  return path.join(USERS_DIR, safeSegment(userId, 'userId'), STORE_DIR);
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function jobFingerprint(label, task) {
  const normalizedLabel = normalizeText(label);
  if (normalizedLabel) return `label:${sha256(normalizedLabel)}`;
  const normalizedTask = normalizeText(task);
  if (!normalizedTask) throw new Error('A non-empty worker task is required.');
  return `task:${sha256(normalizedTask)}`;
}

function ambientScopeAndOrdinal() {
  const turn = getTurn();
  if (!turn || typeof turn !== 'object') return { scopeId: null, ordinal: null };
  const messageId = String(turn.messageId || '').trim();
  const rootId = String(turn.rootId || turn.attemptId || turn.turnId || '').trim();
  const scopeId = messageId ? `message:${messageId}` : (rootId ? `root:${rootId}` : null);
  if (!scopeId) return { scopeId: null, ordinal: null };
  const next = (_turnOrdinals.get(turn) || 0) + 1;
  _turnOrdinals.set(turn, next);
  return { scopeId, ordinal: next };
}

function readRecord(file) {
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Worker admission record is malformed; refusing to launch another worker.'); }
  if (!value || value.version !== 1 || !Array.isArray(value.jobs)) {
    throw new Error('Worker admission record has an invalid shape; refusing to launch another worker.');
  }
  return value;
}

function writeRecord(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function sweep(dir, now) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs > RETENTION_MS) fs.rmSync(file, { force: true });
    } catch { /* retention is best effort; admission itself remains fail closed */ }
  }
}

function validTaskId(value) {
  const taskId = String(value ?? '');
  if (!/^wkr_\d+_[a-z0-9]+$/.test(taskId)) {
    throw new Error('Worker dispatcher returned an invalid task id.');
  }
  return taskId;
}

/**
 * Launch one worker for a logical message slot. Browser Retry recreates the
 * same ordinal and therefore receives the original task id even if the model
 * rephrases the task. A later tool round that repeats the same label/task is
 * also coalesced. Distinct parallel workers remain valid through distinct
 * ordinals and labels.
 *
 * All admissions for one user share a lock. `beforeSpawn` therefore provides
 * an atomic place to re-check that user's applicable concurrency quota before
 * the durable dispatch tombstone is created.
 */
export async function spawnWorkerIdempotently({
  userId,
  ownerKey,
  label,
  task,
  spawn,
  beforeSpawn = null,
  scopeId: scopeOverride = undefined,
  ordinal: ordinalOverride = undefined,
}) {
  if (typeof spawn !== 'function') throw new Error('spawn callback is required');
  if (beforeSpawn != null && typeof beforeSpawn !== 'function') {
    throw new Error('beforeSpawn must be a function when provided');
  }
  const safeUserId = safeSegment(userId, 'userId');
  const safeOwnerKey = safeSegment(ownerKey, 'ownerKey');
  const ambient = ambientScopeAndOrdinal();
  const scopeId = scopeOverride === undefined ? ambient.scopeId : String(scopeOverride || '').trim() || null;
  const ordinal = ordinalOverride === undefined ? ambient.ordinal : Number(ordinalOverride);
  const hasLogicalIdentity = Boolean(scopeId) && Number.isSafeInteger(ordinal) && ordinal >= 1;
  const fingerprint = jobFingerprint(label, task);
  const dir = storeDir(safeUserId);
  const lockPath = path.join(dir, '.locks', 'admission.lock');

  return withFileLock(lockPath, async () => {
    const now = Date.now();
    sweep(dir, now);

    // Direct callers outside a traced turn cannot be coalesced across Retry,
    // but they still participate in the same atomic per-user quota reservation.
    if (!hasLogicalIdentity) {
      if (beforeSpawn) await beforeSpawn();
      return { duplicate: false, taskId: validTaskId(await spawn()) };
    }

    const operationId = sha256(`${safeUserId}\0${safeOwnerKey}\0${scopeId}`);
    const recordPath = path.join(dir, `${operationId}.json`);
    const record = readRecord(recordPath) || {
      version: 1,
      operationId,
      scopeId,
      ownerKey: safeOwnerKey,
      createdAt: now,
      updatedAt: now,
      jobs: [],
    };
    if (record.scopeId !== scopeId || record.ownerKey !== safeOwnerKey) {
      throw new Error('Worker admission identity changed; refusing to launch another worker.');
    }
    const existing = record.jobs.find(job => job.ordinal === ordinal)
      || record.jobs.find(job => job.fingerprint === fingerprint);
    if (existing) {
      if (existing.status === 'started' && existing.taskId) {
        return { duplicate: true, taskId: String(existing.taskId) };
      }
      throw new Error('A worker launch for this request may already have started. Check workers before trying again.');
    }

    // Capacity/policy failures are known not to have dispatched anything, so
    // run this before recording the fail-closed ambiguous-dispatch tombstone.
    if (beforeSpawn) await beforeSpawn();

    const job = {
      ordinal,
      fingerprint,
      status: 'dispatching',
      taskId: null,
      createdAt: now,
      updatedAt: now,
    };
    record.jobs.push(job);
    record.updatedAt = now;
    writeRecord(recordPath, record);
    try {
      const taskId = validTaskId(await spawn());
      job.status = 'started';
      job.taskId = taskId;
      job.updatedAt = Date.now();
      record.updatedAt = job.updatedAt;
      writeRecord(recordPath, record);
      return { duplicate: false, taskId };
    } catch (error) {
      // The dispatcher may explicitly prove that no producer was launched
      // (for example, its completion journal could not be registered). That
      // known-safe failure may be retried after storage recovers; every other
      // post-tombstone error remains ambiguous and fail-closed.
      if (error?.code === 'WORKER_NOT_STARTED') {
        record.jobs = record.jobs.filter(candidate => candidate !== job);
        record.updatedAt = Date.now();
        try {
          if (record.jobs.length) writeRecord(recordPath, record);
          else fs.rmSync(recordPath, { force: true });
        } catch { /* leaving a tombstone fails closed */ }
        throw error;
      }
      // Once dispatching was durably recorded, a crash/error is ambiguous: the
      // detached worker may already be running. Never erase the tombstone and
      // turn that ambiguity into a duplicate side effect.
      job.status = 'uncertain';
      job.updatedAt = Date.now();
      record.updatedAt = job.updatedAt;
      try { writeRecord(recordPath, record); } catch {}
      throw error;
    }
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

export const _internal = { normalizeText, jobFingerprint };
