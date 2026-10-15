// @ts-check
/** Named resource locks shared by interactive tools, workers, and schedules. */
import { withFileLock } from './file-lock.mjs';
import { currentTaskContext } from './task-proxy-context.mjs';
import { getScheduledContext } from './scheduled-context.mjs';
import { getTurn } from './turn-trace-context.mjs';
import { activeTasks } from '../background-tasks/state.mjs';

function clean(value, max = 160) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function executionOwner(userId) {
  const task = currentTaskContext();
  const rec = task?.userId === userId ? activeTasks.get(task.taskId) : null;
  const scheduled = getScheduledContext();
  const turn = getTurn();
  if (task?.userId === userId && task.taskId) {
    return {
      metadata: { userId, taskId: task.taskId, background: true,
        label: clean(rec?.label || task.taskLabel || rec?.summary || task.taskId) },
      record: rec?.userId === userId ? rec : task,
    };
  }
  if (scheduled?.originTaskOwnerId === userId && scheduled.originTaskId) {
    return {
      metadata: { userId, taskId: scheduled.runId || scheduled.originTaskId, background: true,
        label: clean(scheduled.taskLabel || scheduled.originTaskId) },
      record: scheduled,
    };
  }
  return {
    metadata: { userId, taskId: turn?.userId === userId ? turn.attemptId || turn.turnId : null,
      background: false, label: 'Current chat' },
    record: null,
  };
}

export class ResourceLockedError extends Error {
  constructor(resource, owner) {
    super(`Task ${JSON.stringify(owner.label || 'another operation')} has locked ${resource}. This operation made no changes. Retry after that task finishes.`);
    this.name = 'ResourceLockedError';
    this.code = 'RESOURCE_LOCKED';
    this.failureKind = 'resource_locked';
    this.resourceLock = { resource, taskId: owner.taskId || null, taskLabel: owner.label || 'another operation' };
  }
}

/** Keep lock ownership with the real operation, including after auto-backgrounding. */
export function withTaskResourceLock(lockPath, fn, {
  userId, resource, conflict = 'report', ...options
}) {
  const { metadata, record } = executionOwner(userId);
  const conflictKey = `${lockPath}\0${resource}`;
  let holder = null;
  const refusal = () => {
    const visibleOwner = holder?.userId === userId ? holder : { label: 'another operation' };
    const error = new ResourceLockedError(resource, visibleOwner);
    if (record) {
      record.resourceLockConflicts ||= new Map();
      record.resourceLockConflicts.set(conflictKey, error.message);
    }
    return error;
  };
  return withFileLock(lockPath, async () => {
    const result = await fn();
    // A successful explicit retry resolves this particular blocked operation.
    record?.resourceLockConflicts?.delete(conflictKey);
    return result;
  }, {
    ...options,
    metadata,
    onContention: owner => {
      holder = owner.metadata;
      if (conflict !== 'report') return;
      const sameTask = holder?.userId === userId && holder?.taskId && holder.taskId === metadata.taskId;
      if (sameTask || (!metadata.background && !holder?.background)) return;
      throw refusal();
    },
  }).catch(error => {
    if (error?.code === 'FILE_LOCK_TIMEOUT' && error.lockPath === lockPath) throw refusal();
    throw error;
  });
}

export function resourceLockConflictReport(record) {
  if (!(record?.resourceLockConflicts instanceof Map)) return '';
  return [...new Set(record.resourceLockConflicts.values())].join('\n');
}
