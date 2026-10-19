/**
 * On-disk restart journal for in-flight background tasks.
 * Extracted from background-tasks.mjs — pure move.
 */

import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { BASE_DIR } from '../lib/paths.mjs';
import { withFileLockSync } from '../lib/file-lock.mjs';
import { resolveWriteTargetSync } from '../lib/write-target.mjs';
import { activeTasks } from './state.mjs';

// ── restart journal ───────────────────────────────────────────────────────────
// activeTasks / rootTaskGraphs / the recent* rings are all in-memory, so a
// server restart used to erase every trace that a delegation or worker ever
// existed: the chip stayed "running" until the 1h watcher boot-reap,
// check_workers reported ambiguous silence ("no background work"), and nobody
// was told — which is how the coordinator ends up answering "already in
// progress" from its own stale session promise. The journal is a tiny on-disk
// mirror of in-flight tasks: entry added at dispatch, removed on completion.
// Anything still present at boot was killed by the restart, by definition —
// bootRecoverInterruptedTasks marks each one cancelled everywhere the truth is
// consumed: the recent rings (check_workers), the watcher chip (UI), and the
// owning chat session (the coordinator's next turn).
export const JOURNAL_PATH = path.join(BASE_DIR, 'background-task-journal.json');
const JOURNAL_VERSION = 2;

export function _plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function journalEntriesDirectory() {
  return `${resolveWriteTargetSync(JOURNAL_PATH)}.d`;
}

function readIndex() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { version: JOURNAL_VERSION, entries: {} };
    throw new Error(`background task journal is unreadable: ${error?.message || error}`);
  }
  if (_plainObject(parsed) && _plainObject(parsed.entries) && [1, JOURNAL_VERSION].includes(parsed.version)) {
    if (parsed.version === JOURNAL_VERSION) {
      for (const pointer of Object.values(parsed.entries)) {
        if (!_plainObject(pointer) || typeof pointer.file !== 'string'
            || !/^[a-f0-9]{64}-[a-f0-9-]{36}\.json$/.test(pointer.file)) {
          throw new Error('background task journal has an invalid entry pointer');
        }
      }
    }
    return parsed;
  }
  if (_plainObject(parsed) && !Object.hasOwn(parsed, 'version')) return { version: 1, entries: parsed };
  throw new Error('background task journal has an invalid shape');
}

function readEntry(index, taskId) {
  if (!Object.hasOwn(index.entries, taskId)) return undefined;
  if (index.version !== JOURNAL_VERSION) return index.entries[taskId];
  const file = path.join(journalEntriesDirectory(), index.entries[taskId].file);
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`background task journal entry ${taskId} is unreadable: ${error?.message || error}`); }
  if (!_plainObject(saved) || saved.taskId !== taskId || !_plainObject(saved.entry)) {
    throw new Error(`background task journal entry ${taskId} has an invalid shape`);
  }
  return saved.entry;
}

function readEntries(index) {
  return Object.fromEntries(Object.keys(index.entries).map(id => [id, readEntry(index, id)]));
}

function syncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function atomicDurableWrite(target, value) {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
    syncDirectory(path.dirname(target));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

// Membership changes and multi-job updates prepare fresh entry versions.
// The manifest is their single commit point, including during migration.
function commitEntries(index, changes) {
  const dir = journalEntriesDirectory();
  const pointers = index.version === JOURNAL_VERSION ? { ...index.entries } : {};
  const pending = index.version === JOURNAL_VERSION ? changes
    : new Map([...Object.entries(index.entries), ...changes]);
  const superseded = [];
  for (const [taskId, entry] of pending) {
    if (pointers[taskId]) superseded.push(pointers[taskId].file);
    if (entry === undefined) { delete pointers[taskId]; continue; }
    if (!_plainObject(entry)) throw new Error('background task journal entries must be objects');
    const file = `${createHash('sha256').update(taskId).digest('hex')}-${randomUUID()}.json`;
    atomicDurableWrite(path.join(dir, file), { taskId, entry });
    Object.defineProperty(pointers, taskId, { value: { file }, enumerable: true, configurable: true, writable: true });
  }
  atomicDurableWrite(resolveWriteTargetSync(JOURNAL_PATH), { version: JOURNAL_VERSION, entries: pointers });
  // Cleanup is after the durable commit. Leftovers from an interrupted write
  // are harmless and are reclaimed by the next full snapshot mutation.
  for (const file of superseded) {
    try { fs.unlinkSync(path.join(dir, file)); } catch {}
  }
  return true;
}

function reclaimOrphans(index) {
  const dir = journalEntriesDirectory();
  const referenced = new Set(Object.values(index.entries).map(pointer => pointer.file));
  try {
    for (const file of fs.readdirSync(dir)) {
      if (/^[a-f0-9]{64}-[a-f0-9-]{36}\.json$/.test(file) && !referenced.has(file)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch {}
      }
    }
  } catch {}
}

function locked(fn) {
  return withFileLockSync(`${resolveWriteTargetSync(JOURNAL_PATH)}.lock`, fn, { timeoutMs: 5_000 });
}

export function _journalSnapshot() {
  return locked(() => readEntries(readIndex()));
}

export function _journalReadEntry(taskId) {
  return locked(() => readEntry(readIndex(), taskId));
}

export function _journalMutateEntry(taskId, mutator) {
  try {
    return locked(() => {
      const index = readIndex();
      const entries = { [taskId]: readEntry(index, taskId) };
      const result = mutator(entries);
      if (result === false) return false;
      if (index.version === JOURNAL_VERSION && Object.hasOwn(index.entries, taskId)
          && entries[taskId] !== undefined) {
        if (!_plainObject(entries[taskId])) throw new Error('background task journal entries must be objects');
        // A single existing job commits at its own atomic file replacement.
        // Readers and multi-job transactions hold this same lock, so the
        // manifest need not be rewritten on every action start/result.
        atomicDurableWrite(path.join(journalEntriesDirectory(), index.entries[taskId].file), {
          taskId, entry: entries[taskId],
        });
      } else commitEntries(index, new Map([[taskId, entries[taskId]]]));
      return result ?? true;
    });
  } catch (error) {
    console.warn('[background-tasks] journal mutation refused:', error?.message || error);
    return false;
  }
}

export function _journalMutate(mutator) {
  try {
    return locked(() => {
      const index = readIndex();
      const entries = readEntries(index);
      const before = new Map(Object.entries(entries).map(([id, entry]) => [id, JSON.stringify(entry)]));
      const result = mutator(entries);
      if (result === false) return false;
      const changes = new Map();
      for (const id of new Set([...before.keys(), ...Object.keys(entries)])) {
        if (before.get(id) !== JSON.stringify(entries[id])) changes.set(id, entries[id]);
      }
      if (changes.size || index.version !== JOURNAL_VERSION) commitEntries(index, changes);
      reclaimOrphans(readIndex());
      return result ?? true;
    });
  } catch (error) {
    console.warn('[background-tasks] journal mutation refused:', error?.message || error);
    return false;
  }
}

export function _journalAdd(taskId) {
  const rec = activeTasks.get(taskId);
  if (!rec) return false;
  return _journalMutateEntry(taskId, entries => { entries[taskId] = {
    ...entries[taskId],
    // Runtime-model refreshes must not overwrite newer tool checkpoints.
    ...(rec.checkpoint && !entries[taskId]?.checkpoint ? { checkpoint: rec.checkpoint } : {}),
    userId: rec.userId,
    kind: rec.isWorker ? 'worker' : 'delegation',
    agentId: rec.agentId,
    agentName: rec.agentName,
    agentEmoji: rec.agentEmoji || '🤖',
    ...(rec.isAutoBgTool ? { isAutoBgTool: true, toolName: rec.currentTool } : {}),
    ...(rec.provider ? { provider: String(rec.provider).slice(0, 100) } : {}),
    ...(rec.model ? { model: String(rec.model).slice(0, 300) } : {}),
    ...(rec.runtimeProvider ? { runtimeProvider: String(rec.runtimeProvider).slice(0, 100) } : {}),
    ...(rec.runtimeModel ? { runtimeModel: String(rec.runtimeModel).slice(0, 300) } : {}),
    ...(rec.reasoningEffort ? { reasoningEffort: String(rec.reasoningEffort).slice(0, 40) } : {}),
    ...(rec.executionTargetExplicit === true ? { executionTargetExplicit: true } : {}),
    summary: rec.summary || '',
    originalTask: String(rec.originalTask || rec.summary || '').slice(0, 12_000),
    watcherId: rec.watcherId || null,
    rootWatcherId: rec.rootWatcherId || null,
    rootTaskId: rec.rootTaskId || taskId,
    traceRootTaskId: rec.traceRootTaskId || null,
    spanId: rec.spanId || null,
    parentTaskId: rec.parentTaskId || null,
    parentWatcherId: rec.parentWatcherId || null,
    ownerKey: rec.ownerKey || null,
    coordinatorAgentId: rec.coordinatorAgentId || null,
    visibleAgentId: rec.visibleAgentId || null,
    sourceMessageId: rec.sourceMessageId || null,
    sourceAttemptId: rec.sourceAttemptId || null,
    sourceSessionKey: rec.sourceSessionKey || null,
    sourceSessionEpoch: rec.sourceSessionEpoch || null,
    originScheduledTaskId: rec.originScheduledTaskId || null,
    originScheduledTaskOwnerId: rec.originScheduledTaskOwnerId || null,
    originScheduledTaskAgent: rec.originScheduledTaskAgent || null,
    originScheduledRunId: rec.originScheduledRunId || null,
    originScheduledManual: rec.originScheduledManual === true,
    originScheduledSilent: Boolean(rec.originScheduledTaskId) || rec.originScheduledSilent === true,
    // Nonsecret restart guard only. The verifier lease capability itself is
    // memory-only and is intentionally absent from this explicit serializer.
    verifierLeaseRequired: rec.verifierLeaseRequired === true,
    autoContinue: rec.autoContinue === true,
    startedAt: rec.startedAt,
  }; });
}

export function _journalRemove(taskId) {
  return _journalMutateEntry(taskId, entries => {
    if (!entries[taskId]) return true;
    delete entries[taskId];
    return true;
  });
}

export function _journalMarkCompletion(taskId, completion) {
  return _journalMutateEntry(taskId, entries => {
    if (!entries[taskId]) return false;
    entries[taskId] = {
      ...entries[taskId],
      completion: {
        status: completion.status,
        // This is the crash-recovery source of truth until both session rows
        // are durable. Worker output is already bounded by the provider run;
        // truncating it here silently loses the tail after a mid-finalization
        // restart.
        result: String(completion.result || ''),
        error: String(completion.error || '').slice(0, 8_000),
        ...(completion.requiredNotice ? { requiredNotice: String(completion.requiredNotice) } : {}),
        images: Array.isArray(completion.images) ? completion.images.slice(0, 8) : [],
        completedAt: Date.now(),
      },
    };
    return true;
  });
}
