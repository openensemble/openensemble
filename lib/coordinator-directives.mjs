// @ts-check
import { currentTaskContext } from './task-proxy-context.mjs';
import {
  acknowledgeTaskReplan,
  consumeTaskDirectives,
  taskActionBarrier,
} from './work-coordination.mjs';

/** Consume and format server-owned manager updates for the current child. */
export function consumeCoordinatorUpdateText() {
  const taskId = currentTaskContext()?.taskId;
  const directives = taskId ? consumeTaskDirectives(taskId) : [];
  if (!directives.length) return '';
  const lines = directives
    .map(item => `- ${item.text}${item.reason ? ` (${item.reason})` : ''}`)
    .join('\n');
  return `[COORDINATOR UPDATE — follow before taking another action]\n${lines}`;
}

/**
 * Inject an update at the last safe boundary before a provider request.
 * Every supported provider accepts a plain user text message in its working
 * conversation. Returns true only when a directive was consumed.
 */
export function appendPendingCoordinatorUpdate(messages) {
  if (!Array.isArray(messages)) return false;
  const taskId = currentTaskContext()?.taskId;
  const text = consumeCoordinatorUpdateText();
  // Reaching the next provider request proves that any prior claim result or
  // redirect-bearing tool result has been appended to model history. New tool
  // calls may now proceed under the revised scope.
  if (taskId) acknowledgeTaskReplan(taskId);
  if (!text) return false;
  messages.push({ role: 'user', content: text });
  return true;
}

/**
 * Guard a later call from the same provider-emitted tool batch. This is a
 * non-consuming peek: pending directives remain queued for the next provider
 * request, where they are injected as authoritative control text.
 */
export function coordinatedToolBarrierText() {
  const taskId = currentTaskContext()?.taskId;
  const reason = taskId ? taskActionBarrier(taskId) : '';
  if (!reason) return '';
  return `Skipped this stale tool call before execution. ${reason} Return to the model and choose the next action under the updated, non-overlapping scope.`;
}
