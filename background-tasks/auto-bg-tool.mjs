/**
 * Generic slow-tool auto-background ownership in activeTasks + journal.
 * Extracted from background-tasks.mjs — pure move.
 */

import { activeTasks, _slug } from './state.mjs';
import { _journalAdd, _journalMarkCompletion, _journalRemove } from './journal.mjs';

/** Give a generic slow-tool handoff a real liveness/cancellation owner. */
export function registerAutoBackgroundTool({
  taskId, userId, agentId, toolName, watcherId, startedAt = Date.now(), abort = null,
}) {
  if (!taskId || !userId || !watcherId || activeTasks.has(taskId)) return null;
  const rawAgentId = String(agentId || 'jarvis');
  const scopedAgentId = rawAgentId.startsWith(`${userId}_`)
    ? rawAgentId
    : `${userId}_${rawAgentId}`;
  activeTasks.set(taskId, {
    agentId: rawAgentId,
    userId,
    coordinatorAgentId: scopedAgentId,
    visibleAgentId: scopedAgentId,
    agentName: toolName || 'Background tool',
    agentEmoji: '⏵',
    startedAt,
    summary: `${toolName || 'Background tool'} is still running`,
    originalTask: `${toolName || 'Background tool'} is still running`,
    phase: 'backgrounded',
    status: 'running',
    currentTool: toolName || null,
    watcherId,
    rootTaskId: watcherId,
    rootWatcherId: watcherId,
    spanId: `${taskId}:tool:${_slug(toolName)}`,
    aliases: [taskId, watcherId].filter(Boolean),
    isAutoBgTool: true,
    abort: typeof abort === 'function' ? abort : null,
  });
  // Admission is complete only when the restart journal owns the execution.
  // Callers still hold the foreground promise/iterator when this returns null,
  // so failing closed here avoids an unjournaled detached side effect.
  if (!_journalAdd(taskId)) {
    activeTasks.delete(taskId);
    return null;
  }
  return { taskId, watcherId };
}

/** Persist provider settlement before report/session/continuation awaits. */
export function markAutoBackgroundToolTerminal(taskId, { status = 'done', result = '', error = null } = {}) {
  const rec = activeTasks.get(taskId);
  if (!rec?.isAutoBgTool || rec._terminalMarked) return false;
  const terminal = status === 'cancelled' ? 'cancelled' : (status === 'done' && !error ? 'done' : 'error');
  // Persist provider settlement first. User-facing completion delivery is
  // allowed only after this succeeds, so a crash can recover the real terminal
  // result instead of relabelling completed work as interrupted.
  if (!_journalMarkCompletion(taskId, {
    status: terminal,
    result: terminal === 'done' ? result : '',
    error: terminal === 'done' ? null : (error || result || 'Background tool failed.'),
    images: [],
  })) return false;
  rec._terminalMarked = true;
  rec.abort = null;
  rec.status = terminal;
  rec.phase = 'finalizing';
  rec.currentTool = null;
  rec.lastUpdateAt = Date.now();
  return true;
}

/** Retire only the generic slow-tool owner; roles.mjs owns user surfaces. */
export function retireAutoBackgroundTool(taskId) {
  const rec = activeTasks.get(taskId);
  if (!rec?.isAutoBgTool || rec._finalizationClaimed) return false;
  if (!rec._terminalMarked) {
    const marked = markAutoBackgroundToolTerminal(taskId, {
      status: 'error', error: 'Background tool ended without terminal evidence.',
    });
    if (!marked) return false;
  }
  rec._finalizationClaimed = true;
  activeTasks.delete(taskId);
  _journalRemove(taskId);
  return true;
}

