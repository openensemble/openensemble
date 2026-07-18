// @ts-check
/**
 * Auto-background tool helpers (iterator ownership, completion normalize,
 * report-back continuation). Extracted from roles.mjs — pure move.
 * executeToolStreaming remains in roles.mjs and imports this module.
 */

import { log } from '../logger.mjs';
import { getVoiceContext } from '../lib/voice-context.mjs';
import { getScheduledContext } from '../lib/scheduled-context.mjs';
import { registerScheduledChild, completeScheduledChild } from '../lib/scheduled-child-barrier.mjs';
import { normalizeToolResult } from '../lib/tool-error.mjs';
import { isEphemeralAgentId as _isEphem } from '../lib/ephemeral-tool-cache.mjs';
import { getTurnContext } from '../lib/turn-abort-context.mjs';
import { currentTaskContext } from '../lib/task-proxy-context.mjs';
import {
  raceWithAbort,
} from '../lib/abort-utils.mjs';

// Resolve the agent id we should attribute background-task surfaces to
// (chip, session injection) when the caller didn't pass one. Uses the
// user's configured coordinator agent — works regardless of what each
// user named their coordinator. Falls back to userId only if the user has
// no coordinator assigned (edge case during onboarding).
export async function _resolveAttributionAgent(userId, agentId) {
  if (agentId) return agentId;
  try {
    const { getUserCoordinatorAgentId } = await import('../routes/_helpers.mjs');
    const coordId = getUserCoordinatorAgentId(userId);
    return coordId ? `${userId}_${coordId}` : userId;
  } catch { return userId; }
}

export function _agentIdFromSessionKey(sessionKey, userId) {
  const raw = String(sessionKey || '');
  const prefix = `${userId}_`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

export async function _emitAutoBgNotify(userId, agentId, notify) {
  if (!userId || !agentId || !notify) return;
  try {
    const { emitAgentNotification } = await import('../ws-handler.mjs');
    emitAgentNotification(userId, _agentIdFromSessionKey(agentId, userId), notify);
  } catch (_) { /* best-effort */ }
}

// Drain an async iterator after executeToolStreaming has already read the
// event that crossed the foreground -> background threshold. The boundary
// value belongs to the detached sink just as much as every later value; losing
// it is especially damaging when it is the terminal result (and therefore the
// only carrier for structured artifacts such as `_images`).
export async function drainIteratorIncludingBoundary(iter, boundaryValue, visit) {
  await visit(boundaryValue);
  while (true) {
    const next = await iter.next();
    if (next.done) return;
    await visit(next.value);
  }
}

// Tools whose background completion warrants waking the owning agent with a
// concise report-back turn. Most auto-backgrounded tools just drop their
// result into the task chip + agent_report bubble — the user already sees it,
// so a second LLM turn would be redundant and costly. The tools here are the
// long-running shell/command ones whose raw output the agent must interpret to
// continue its workflow (run tests → read failures → fix; apt upgrade → human
// go/no-go) — without this the agent in a DIRECT chat silently stalls mid-task
// when the command crosses the auto-bg threshold. Add a tool here only when its
// result genuinely needs the agent to react. Domain-specific behavior (how to
// summarize, what to ask) belongs in the owning skill's systemPromptAddition,
// NOT the continuation prompt below.
export const BG_REPORT_TOOLS = new Set(['node_exec', 'coder_run_command', 'desktop_run_command']);

export async function _runAutoBgToolContinuation({ userId, agentId, toolName, args, resultText, errorMsg = null }) {
  if (!userId || !agentId) return;
  if (_isEphem(agentId)) return;
  if (!BG_REPORT_TOOLS.has(toolName)) return;
  const targetAgentId = _agentIdFromSessionKey(agentId, userId);
  if (!targetAgentId) return;
  const prompt = [
    'A background tool call you started has completed. Continue the original user workflow for THIS completed tool only.',
    '',
    `<background_tool name="${toolName}">`,
    `<args>${JSON.stringify(args ?? {})}</args>`,
    errorMsg ? `<error>${errorMsg}</error>` : `<result>${resultText || ''}</result>`,
    '</background_tool>',
    '',
    'Give the user a concise completion update based on this result, following any guidance in your system instructions for this kind of task. Do not take further actions or make changes unless the user explicitly confirms.',
  ].join('\n');
  try {
    const { handleChatMessage } = await import('../chat-dispatch.mjs');
    const { sendToUser } = await import('../ws-handler.mjs');
    await handleChatMessage({
      userId,
      agentId: targetAgentId,
      text: prompt,
      attachment: null,
      source: /** @type {'voice-device'|'web'|'telegram'|'desktop-app'} */ (getVoiceContext()?.source || 'web'),
      onEvent: (e) => sendToUser(userId, e),
      onBroadcast: () => {},
      onNotify: () => {},
      _hiddenUser: true,
      _isBackgroundContinuation: true,
      // This turn exists only to interpret already-finished command output.
      // Enforce the prompt's "do not take further actions" rule structurally
      // so a model cannot turn a report-back into an uncorrelated side effect.
      toolPlan: { mode: 'none' },
      _readOnlyTurn: true,
    });
  } catch (e) {
    log.warn('tool', 'auto-bg continuation failed', { tool: toolName, userId, agentId: targetAgentId, err: e?.message || String(e) });
  }
}

export function _autoBgChildId(watcherId) {
  return watcherId ? `autobg_${watcherId}` : null;
}

/**
 * Race one (and only one) async-iterator read against an auto-background
 * boundary. A timeout returns the original promise so ownership can move to a
 * detached drain without issuing a second iter.next().
 */
export async function racePendingIteratorNext(pendingNext, timeoutMs, signal = null) {
  let timeoutId;
  try {
    return await raceWithAbort(
      Promise.race([
        pendingNext.then(
          next => ({ kind: 'next', next }),
          error => ({ kind: 'error', error }),
        ),
        new Promise(resolve => {
          timeoutId = setTimeout(() => resolve({ kind: 'timeout', pendingNext }), Math.max(0, timeoutMs));
        }),
      ]),
      signal,
      'Tool execution cancelled',
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** Do not detach a tool a second time when a durable task already owns it. */
export function autoBackgroundToolsInCurrentContext() {
  return currentTaskContext() == null
    && getTurnContext()?.awaitSlowTools !== true;
}

let _autoBackgroundDelayForTest = null;

/** Narrow deterministic seam for slow-tool ownership tests. */
export function setAutoBackgroundDelayForTest(delayMs = null) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('auto-background delay test seam is unavailable');
  }
  _autoBackgroundDelayForTest = delayMs == null
    ? null
    : Math.max(1, Number(delayMs) || 1);
}

export function _autoBackgroundDelayMs(suppressLearning) {
  if (_autoBackgroundDelayForTest != null) return _autoBackgroundDelayForTest;
  return suppressLearning ? 600_000 : 10_000;
}

const AUTO_BG_REPORT_TEXT_MAX = 4_000;
const AUTO_BG_WATCHER_TEXT_MAX = 1_200;

/**
 * Classify a detached completion once so every durable and live surface uses
 * the same terminal status. In particular, ctx.toolError() and legacy
 * `Error: ...` results must never be journaled or displayed as success.
 */
export function normalizeAutoBgCompletion(value, displayName = 'Tool') {
  const structured = value && typeof value === 'object' && typeof value.text === 'string';
  const normalized = normalizeToolResult(structured ? value.text : String(value ?? ''));
  const isError = value?.isError === true || normalized.isError;
  const text = String(normalized.text ?? '').slice(0, AUTO_BG_REPORT_TEXT_MAX);
  const content = text || (isError ? 'Tool error: Tool failed' : `${displayName} completed.`);
  const status = isError ? 'error' : 'done';
  return {
    text,
    content,
    isError,
    status,
    watcherFinalText: isError
      ? `⚠ ${displayName} failed: ${content.slice(0, AUTO_BG_WATCHER_TEXT_MAX)}`
      : `✓ ${displayName} done${text ? `: ${text.slice(-AUTO_BG_WATCHER_TEXT_MAX)}` : ''}`,
    observation: { resultText: text, ok: !isError },
    report: { content, status },
    scheduled: {
      resultText: isError ? '' : content,
      errorMsg: isError ? content : null,
    },
    continuation: {
      resultText: isError ? '' : content,
      errorMsg: isError ? content : null,
    },
    images: structured && Array.isArray(value._images) ? value._images : null,
    notify: structured && value._notify ? value._notify : null,
  };
}

export function _registerScheduledAutoBgChild({ scheduledCtx, userId, watcherId, label, kind = 'tool', cancel = null }) {
  if (!scheduledCtx?.originTaskId || !watcherId) return null;
  return registerScheduledChild({
    userId,
    scheduledCtx,
    childId: _autoBgChildId(watcherId),
    label,
    kind,
    cancel,
  });
}

// Mark an auto-backgrounded tool's barrier child done. The scheduled-task
// reaction + finalize are driven by the barrier (see scheduler.runTask), so
// this just records completion; it's a no-op outside a scheduled run.
export function _completeScheduledAutoBgChild({ scheduledCtx, userId, watcherId, resultText, errorMsg = null }) {
  if (!scheduledCtx?.originTaskId || !watcherId) return;
  completeScheduledChild({
    userId,
    scheduledCtx,
    childId: _autoBgChildId(watcherId),
    resultText,
    errorMsg,
  });
}

export async function _emitAutoBgToolReport({
  userId,
  agentId,
  toolName,
  displayName = null,
  displayEmoji = '⏵',
  watcherId,
  rootWatcherId = null,
  targetAgentId = null,
  content,
  status = 'done',
  images = null,
  notify = null,
}) {
  if (!userId || !watcherId) return;
  const name = displayName || toolName || 'Tool';
  const body = String(content || `${name} completed.`).slice(0, 4000);
  const key = agentId
    ? (String(agentId).startsWith(`${userId}_`) ? String(agentId) : `${userId}_${agentId}`)
    : null;
  const ts = Date.now();
  const report = {
    role: 'assistant',
    kind: 'agent_report',
    agentName: name,
    agentEmoji: displayEmoji || '⏵',
    ...(targetAgentId ? { targetAgentId } : {}),
    content: body,
    taskId: `autobg_${watcherId}`,
    watcherId,
    rootWatcherId: rootWatcherId || watcherId,
    tool: toolName,
    status,
    ...(images ? { images } : {}),
    ...(notify ? { notify } : {}),
    ts,
  };
  if (key) {
    try {
      const { appendToSession } = await import('../sessions.mjs');
      await appendToSession(key, report);
    } catch (_) { /* best-effort */ }
  }
  try {
    const { sendToUser } = await import('../ws-handler.mjs');
    sendToUser(userId, {
      type: 'agent_report',
      agent: key || agentId || null,
      agentName: report.agentName,
      agentEmoji: report.agentEmoji,
      ...(targetAgentId ? { targetAgentId } : {}),
      content: body,
      ...(images ? { images } : {}),
      ...(notify ? { notify } : {}),
      taskId: report.taskId,
      watcherId,
      rootWatcherId: report.rootWatcherId,
      tool: toolName,
      status,
      ts,
    });
  } catch (_) { /* best-effort */ }
  await _emitAutoBgNotify(userId, key || agentId, notify);
}

