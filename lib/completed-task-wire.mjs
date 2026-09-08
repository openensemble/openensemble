import { listWatchers } from '../scheduler/watchers.mjs';
import { taskRuntimeFields } from './task-runtime-status.mjs';
import { log } from '../logger.mjs';

const TERMINAL = new Set(['done', 'complete', 'completed', 'error', 'failed', 'cancelled', 'canceled', 'stopped']);
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const timestamp = value => Number.isFinite(value) && value > 0 ? value : null;

function completedChildren(rows, rootTaskId, sessionKey, sessionEpoch) {
  const candidates = (Array.isArray(rows) ? rows : []).slice(0, 100).filter(child => {
    if (!child || !clean(child.taskId, 200) || child.taskId === rootTaskId) return false;
    if (child.sourceSessionKey === sessionKey && child.sourceSessionEpoch === sessionEpoch) return true;
    // A reservation precedes runtime registration. Only an unstarted row with
    // both fields absent may inherit its authenticated, same-graph root scope.
    return child.status === 'queued' && !child.runtimeModel && !child.runtimeProvider
      && child.sourceSessionKey == null && child.sourceSessionEpoch == null;
  });
  const included = new Set([rootTaskId]);
  for (let pass = 0; pass < candidates.length; pass++) {
    const before = included.size;
    for (const child of candidates) {
      if (included.has(child.parentTaskId)) included.add(child.taskId);
    }
    if (included.size === before) break;
  }
  return candidates.filter(child => included.has(child.taskId)).map(child => {
    const status = clean(child.status, 40) || 'unknown';
    const runtime = taskRuntimeFields({ ...child, status, currentTool: null });
    return {
      taskId: clean(child.taskId, 200), parentTaskId: clean(child.parentTaskId, 200),
      agentId: clean(child.agentId, 240) || null,
      name: clean(child.name, 160) || 'Worker', summary: clean(child.summary, 600),
      provider: clean(child.provider, 100) || null, model: clean(child.model, 300) || null,
      ...runtime, sourceSessionKey: sessionKey, sourceSessionEpoch: sessionEpoch,
      activity: TERMINAL.has(status) ? runtime.activity : 'Last reported',
      reasoningEffort: clean(child.reasoningEffort, 40) || null,
      executionTargetExplicit: child.executionTargetExplicit === true,
      status, phase: status, currentTool: null, canCancel: false,
      startedAt: timestamp(child.startedAt), endedAt: timestamp(child.endedAt),
    };
  });
}

function projectCompletedTasks(userId, sessionKey, sessionEpoch) {
  if (typeof userId !== 'string' || !userId || typeof sessionKey !== 'string'
      || !sessionKey.startsWith(`${userId}_`) || sessionKey.length <= userId.length + 1
      || typeof sessionEpoch !== 'string' || !sessionEpoch) return [];
  const recent = listWatchers(userId).recent;
  return recent.filter(record => {
    const state = record?.state;
    return record?.userId === userId && record.kind === 'task_proxy' && TERMINAL.has(record.status)
      && clean(record.id, 200) && clean(state?.taskId, 200)
      && state.sourceSessionKey === sessionKey && state.sourceSessionEpoch === sessionEpoch
      && !state.parentTaskId && (!state.rootTaskId || state.rootTaskId === state.taskId);
  }).slice(0, 20).map(record => {
    const state = record.state;
    const status = record.status;
    const taskId = clean(state.taskId, 200);
    const watcherId = clean(record.id, 200);
    const runtime = taskRuntimeFields({ ...state, status, currentTool: null });
    const name = clean(state.targetAgentName, 160) || 'Background task';
    const summary = clean(state.summary, 600);
    return {
      type: 'status', kind: 'task_proxy', agent: sessionKey, watcherId,
      label: name, text: runtime.activity, ts: timestamp(record.endedAt),
      final: true, finalStatus: status,
      state: {
        taskId, rootTaskId: taskId, rootWatcherId: watcherId, visibleAgentId: sessionKey,
        targetAgentId: clean(state.targetAgentId, 240) || null,
        targetAgentName: name, targetAgentEmoji: clean(state.targetAgentEmoji, 16) || '⟳',
        provider: clean(state.provider, 100) || null, model: clean(state.model, 300) || null,
        ...runtime, sourceSessionKey: sessionKey, sourceSessionEpoch: sessionEpoch,
        reasoningEffort: clean(state.reasoningEffort, 40) || null,
        executionTargetExplicit: state.executionTargetExplicit === true,
        summary, status, phase: status, currentTool: null, canCancel: false,
        startedAt: timestamp(state.startedAt), endedAt: timestamp(record.endedAt),
        lastActivityAt: timestamp(state.lastActivityAt) || timestamp(record.endedAt),
        childTasks: completedChildren(state.childTasks, state.taskId, sessionKey, sessionEpoch),
      },
    };
  });
}

/** Recent terminal UI metadata, kept separate from chat/model history. */
export function completedTasksForSession(userId, sessionKey, sessionEpoch) {
  try { return projectCompletedTasks(userId, sessionKey, sessionEpoch); }
  catch (error) {
    // Optional task history must not prevent authentication or normal chat
    // history from loading when the watcher store is unavailable or malformed.
    log.warn('chat-tasks', 'Completed task history unavailable', {
      err: clean(error?.message, 240) || 'snapshot failed',
    });
    return [];
  }
}
