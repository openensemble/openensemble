/**
 * On-disk restart journal for in-flight background tasks.
 * Extracted from background-tasks.mjs — pure move.
 */

import fs from 'fs';
import path from 'path';
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
const JOURNAL_LOCK_PATH = `${JOURNAL_PATH}.lock`;
const JOURNAL_VERSION = 1;

export function _plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function _journalReadUnlocked() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`background task journal is unreadable: ${error?.message || error}`);
  }
  // Read the pre-versioned object written by older candidates, then migrate it
  // on the next successful mutation. Every other shape fails closed.
  if (_plainObject(parsed) && parsed.version === JOURNAL_VERSION && _plainObject(parsed.entries)) {
    return parsed.entries;
  }
  if (_plainObject(parsed) && !Object.prototype.hasOwnProperty.call(parsed, 'version')) return parsed;
  throw new Error('background task journal has an invalid shape');
}

function _journalSaveUnlocked(entries) {
  if (!_plainObject(entries)) throw new Error('background task journal entries must be an object');
  const target = resolveWriteTargetSync(JOURNAL_PATH);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: JOURNAL_VERSION, entries }, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    try {
      const dirFd = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* directory fsync is unavailable on some platforms */ }
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    console.warn('[background-tasks] journal write failed:', e.message);
    return false;
  }
}

export function _journalSnapshot() {
  return withFileLockSync(JOURNAL_LOCK_PATH, () => _journalReadUnlocked(), { timeoutMs: 5_000 });
}

export function _journalMutate(mutator) {
  try {
    return withFileLockSync(JOURNAL_LOCK_PATH, () => {
      const entries = _journalReadUnlocked();
      const result = mutator(entries);
      if (!_journalSaveUnlocked(entries)) return false;
      return result ?? true;
    }, { timeoutMs: 5_000 });
  } catch (error) {
    console.warn('[background-tasks] journal mutation refused:', error?.message || error);
    return false;
  }
}

export function _journalAdd(taskId) {
  const rec = activeTasks.get(taskId);
  if (!rec) return false;
  return _journalMutate(entries => { entries[taskId] = {
    userId: rec.userId,
    kind: rec.isWorker ? 'worker' : 'delegation',
    agentId: rec.agentId,
    agentName: rec.agentName,
    agentEmoji: rec.agentEmoji || '🤖',
    summary: rec.summary || '',
    originalTask: String(rec.originalTask || rec.summary || '').slice(0, 12_000),
    watcherId: rec.watcherId || null,
    rootWatcherId: rec.rootWatcherId || null,
    rootTaskId: rec.rootTaskId || taskId,
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
    originScheduledSilent: rec.originScheduledSilent === true,
    // Nonsecret restart guard only. The verifier lease capability itself is
    // memory-only and is intentionally absent from this explicit serializer.
    verifierLeaseRequired: rec.verifierLeaseRequired === true,
    startedAt: rec.startedAt,
  }; });
}

export function _journalRemove(taskId) {
  return _journalMutate(entries => {
    if (!(taskId in entries)) return true;
    delete entries[taskId];
    return true;
  });
}

export function _journalMarkCompletion(taskId, completion) {
  return _journalMutate(entries => {
    if (!(taskId in entries)) return false;
    entries[taskId] = {
      ...entries[taskId],
      completion: {
        status: completion.status,
        result: String(completion.result || '').slice(0, 50_000),
        error: String(completion.error || '').slice(0, 8_000),
        images: Array.isArray(completion.images) ? completion.images.slice(0, 8) : [],
        completedAt: Date.now(),
      },
    };
    return true;
  });
}
