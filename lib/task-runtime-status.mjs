import { activeTasks } from '../background-tasks/state.mjs';
import { currentTaskContext } from './task-proxy-context.mjs';
import { getTurn } from './turn-trace-context.mjs';

let onRuntimeChange = null;

function clean(value, limit) {
  return typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ').trim().slice(0, limit) : '';
}

export function bindTaskRuntimeStatus(listener) {
  onRuntimeChange = typeof listener === 'function' ? listener : null;
}

/** Keep nested work attached to the originating chat, including session reset. */
export function taskSourceFields({ userId, parentTaskId = null } = {}) {
  const parent = activeTasks.get(parentTaskId);
  const turn = getTurn();
  const ownParent = parent?.userId === userId ? parent : null;
  const ownTurn = turn?.userId === userId ? turn : null;
  return {
    sourceSessionKey: clean(ownParent?.sourceSessionKey || ownTurn?.sessionKey, 240) || null,
    sourceSessionEpoch: clean(ownParent?.sourceSessionEpoch || ownTurn?.sessionEpoch, 200) || null,
  };
}

/** Capture the target actually dispatched after routing, never model output. */
export function recordTaskRuntimeExecution(event, context = currentTaskContext()) {
  if (event?.type !== '__model_call' || !context?.taskId || !context?.userId) return false;
  const rec = activeTasks.get(context.taskId);
  if (!rec || rec.userId !== context.userId || rec._finalizationClaimed
      || ['done', 'error', 'cancelled', 'cancelling', 'stopped'].includes(rec.status)) return false;
  const runtimeProvider = clean(event.provider, 100) || null;
  const runtimeModel = clean(event.model, 300) || null;
  if (!runtimeModel) return false;
  if (rec.runtimeProvider === runtimeProvider && rec.runtimeModel === runtimeModel) return false;
  rec.runtimeProvider = runtimeProvider;
  rec.runtimeModel = runtimeModel;
  rec.lastActivityAt = Date.now();
  if (rec.phase === 'queued') rec.phase = 'running';
  // A UI/journal failure must never interrupt provider dispatch.
  try { onRuntimeChange?.(context.taskId, rec); }
  catch (error) { console.warn('[task-status] runtime update failed:', error?.message || error); }
  return true;
}

export function taskActivity(task = {}) {
  const status = clean(task.status, 40).toLowerCase();
  const phase = clean(task.phase, 40).toLowerCase();
  if (['done', 'complete', 'completed'].includes(status)) return 'Completed';
  if (['error', 'failed'].includes(status)) return 'Failed';
  if (['cancelled', 'canceled', 'stopped'].includes(status)) return 'Stopped';
  if (status === 'cancelling' || phase === 'cancelling') return 'Stopping';
  if (status === 'paused' || phase === 'paused') return 'Paused for recovery review';
  if (phase === 'resuming') return 'Continuing after restart';
  if (task.awaiting_input === true) return 'Waiting for your reply';
  if (phase === 'finalizing') return 'Delivering the result';
  if (phase === 'queued') return 'Getting started';
  const tool = clean(task.currentTool, 160);
  if (tool) return `Using ${tool}`;
  // Only explicit report_progress notes are displayable. Token streams,
  // reasoning, tool arguments and result bodies are deliberately excluded.
  const note = Array.isArray(task.progress)
    ? task.progress.findLast(entry => entry?.kind === 'note')?.text
    : null;
  return clean(note, 240) || (phase === 'child_running' ? 'Waiting for team members' : 'Working');
}

export function taskRuntimeFields(task = {}) {
  const runtimeModel = clean(task.runtimeModel, 300) || null;
  return {
    runtimeProvider: clean(task.runtimeProvider, 100) || null,
    runtimeModel,
    modelSource: runtimeModel ? 'runtime' : (task.model || task.provider ? 'configured' : 'unknown'),
    activity: taskActivity(task),
    sourceSessionKey: clean(task.sourceSessionKey, 240) || null,
    sourceSessionEpoch: clean(task.sourceSessionEpoch, 200) || null,
  };
}
