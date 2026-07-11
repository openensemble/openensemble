// @ts-check
/**
 * chat-dispatch/slot-registry.mjs
 *
 * The per-turn concurrency registry that backs handleChatMessage:
 *   - abortControllers     `${userId}_${agentId}` → AbortController
 *   - activeStreams        `${userId}_${agentId}` → { userId, agentId, startTs }
 *   - busyPromises         agentId → Promise (next slot queues behind this)
 *
 * Public surface:
 *   - markAgentBusy(scopedKey)  → { waitTurn, release } slot
 *   - isAgentBusy / waitForAgentIdle — read-only views for ask_agent
 *   - getActiveStreams(userId)  — used by WS reconnect to surface in-flight runs
 *   - abortChat(userId, agentId) / abortAllChats() — cancel an in-flight run
 *   - finalizeTurn(scopedKey, slot) — drop the 4-line cleanup tuple at end
 *     of every short-circuit / finally
 *
 * Pulling this out of chat-dispatch.mjs lets the orchestrator stop touching
 * module-private state — every concurrency concern goes through this surface.
 */

import { clearStreamBuffer, writeStreamBuffer } from '../sessions.mjs';

// Track active AbortControllers so in-progress runs can be cancelled.
// Keyed by `${userId}_${agentId}` so one user's chat can't abort another user's
// concurrent chat on the same agent id (cross-user DoS).
const abortControllers = new Map();

// Track which agents are actively streaming, so reconnecting clients can be told.
// Same scoped key as abortControllers.
const activeStreams = new Map(); // `${userId}_${agentId}` → authoritative reconnect snapshot

// Track in-flight work per agent (WS *and* delegate) so ask_agent can queue
// behind an active run instead of colliding with it.
const busyPromises = new Map(); // agentId → Promise (resolves when current run ends)

export function isAgentBusy(agentId) {
  return busyPromises.has(agentId);
}

export function waitForAgentIdle(agentId) {
  return busyPromises.get(agentId) ?? Promise.resolve();
}

/**
 * Register an in-flight run. Returns a `release()` fn the caller MUST
 * invoke on finish — otherwise the next call to markAgentBusy(agentId)
 * waits forever. waitTurn() resolves when the previous slot for this
 * agent (if any) completes.
 *
 * @param {string} agentId  scoped session key — `${userId}_${agentId}` at call sites.
 * @returns {{waitTurn: () => Promise<unknown>, release: () => void}}
 */
export function markAgentBusy(agentId) {
  // Serialize: if something is already in flight, chain onto it.
  const prev = busyPromises.get(agentId) ?? Promise.resolve();
  /** @type {() => void} */
  let resolveSlot = () => {};
  const slot = new Promise(res => { resolveSlot = /** @type {() => void} */ (res); });
  const chained = prev.then(() => slot);
  busyPromises.set(agentId, chained);
  // Fallback: clear the map if the slot settles without an explicit
  // release() (caller crashed before finalizeTurn could run).
  chained.finally(() => {
    if (busyPromises.get(agentId) === chained) busyPromises.delete(agentId);
  });
  return {
    waitTurn: () => prev,
    // release() drops the map entry SYNCHRONOUSLY in addition to resolving
    // the slot promise. Without the sync delete, isAgentBusy() would still
    // see this slot for several microtask ticks after the turn finished
    // — long enough that a follow-up `await handleChatMessage` would
    // observe the prior slot as still busy in tests, and could theoretically
    // affect production correctness if a caller polled isAgentBusy right
    // after a turn returned. The async .finally above is now just a safety
    // net for the no-explicit-release path.
    release: () => {
      if (busyPromises.get(agentId) === chained) busyPromises.delete(agentId);
      resolveSlot();
    },
  };
}

export function getActiveStreams(userId) {
  const result = [];
  for (const info of activeStreams.values()) {
    if (info.userId === userId) result.push(snapshotActiveStream(info));
  }
  return result;
}

export function getActiveStream(userId, agentId) {
  const info = activeStreams.get(`${userId}_${agentId}`);
  return info ? snapshotActiveStream(info) : null;
}

/** @param {any} info */
function snapshotActiveStream(info) {
  return {
    agentId: info.agentId,
    startTs: info.startTs,
    turnId: info.turnId ?? null,
    messageId: info.messageId ?? null,
    attemptId: info.attemptId ?? info.turnId ?? null,
    seq: info.seq ?? 0,
    phase: info.phase ?? 'running',
    content: info.content ?? '',
    hidden: info.hidden === true,
    toolEvents: (info.toolEvents || []).map(ev => ({ ...ev })),
    permissionRequest: info.permissionRequest ? { ...info.permissionRequest } : null,
  };
}

/**
 * Fold one already-correlated outward event into the server's authoritative
 * in-flight snapshot. Browser reconnects consume this instead of trying to
 * stitch a persisted `.streaming` fragment to newly arriving tokens.
 */
export function recordStreamEvent(scopedSessionKey, event) {
  const info = activeStreams.get(scopedSessionKey);
  if (!info || !event || typeof event !== 'object') return;
  if (event.turn_id && info.turnId && event.turn_id !== info.turnId) return;
  if (Number.isFinite(event.seq)) info.seq = Math.max(info.seq ?? 0, event.seq);
  switch (event.type) {
    case 'turn_accepted':
      info.phase = 'running';
      break;
    case 'token':
      info.content += String(event.text ?? '');
      info.phase = 'running';
      break;
    case 'replace':
      info.content = String(event.text ?? '');
      break;
    case 'tool_call': {
      const callId = event.toolCallId || event.tool_call_id || event.callId || null;
      info.toolEvents.push({
        name: event.name,
        args: event.args ?? null,
        callId,
        startedAt: Date.now(),
        status: 'running',
      });
      break;
    }
    case 'tool_progress': {
      const callId = event.toolCallId || event.tool_call_id || event.callId || null;
      const target = [...info.toolEvents].reverse().find(ev =>
        ev.status !== 'done' && (callId ? ev.callId === callId : ev.name === event.name));
      if (target) target.progressPreview = String(event.text ?? '').slice(-1200);
      break;
    }
    case 'tool_result': {
      const callId = event.toolCallId || event.tool_call_id || event.callId || null;
      const target = [...info.toolEvents].reverse().find(ev =>
        ev.status !== 'done' && (callId ? ev.callId === callId : ev.name === event.name));
      if (target) {
        target.status = 'done';
        target.endedAt = Date.now();
        target.durationMs = target.startedAt ? target.endedAt - target.startedAt : null;
        target.preview = String(event.preview ?? '').slice(0, 1200);
        target.text = String(event.text ?? '').slice(0, 10_000);
      }
      break;
    }
    case 'permission_request':
      info.phase = 'awaiting_permission';
      info.permissionRequest = {
        text: String(event.text ?? ''),
        permissionId: event.permissionId ?? event.permission_id ?? null,
      };
      break;
    case 'hide_turn':
      info.hidden = true;
      info.content = '';
      break;
    case 'error':
      info.phase = 'failed';
      break;
    case 'done':
      info.phase = 'complete';
      break;
  }

  // Throttled/durable crash snapshot. Raw tool args are intentionally omitted
  // from disk; they can contain credentials. The live in-memory snapshot still
  // carries args for a same-process reconnect.
  writeStreamBuffer(scopedSessionKey, {
    content: info.content,
    turnId: info.turnId,
    messageId: info.messageId,
    attemptId: info.attemptId,
    seq: info.seq,
    phase: info.phase,
    hidden: info.hidden,
    toolEvents: info.toolEvents.map(({ args, text, ...ev }) => ({ ...ev, ...(text ? { text } : {}) })),
    permissionRequest: info.permissionRequest,
  });
}

/**
 * Register the AbortController + active-stream metadata for a new turn.
 * Returns the AbortController so the caller can pass `.signal` to streamChat.
 * Aborts any prior controller for the same scoped key first — defensive,
 * since handleChatMessage shouldn't be entered twice for the same key.
 * @param {string} scopedSessionKey
 * @param {string} userId
 * @param {string} agentId
 * @param {{turnId?: string|null, messageId?: string|null, attemptId?: string|null, seq?: number}} [meta]
 */
export function openTurn(scopedSessionKey, userId, agentId, meta = {}) {
  abortControllers.get(scopedSessionKey)?.abort();
  const ac = new AbortController();
  abortControllers.set(scopedSessionKey, ac);
  const info = {
    userId,
    agentId,
    startTs: Date.now(),
    turnId: meta.turnId ?? null,
    messageId: meta.messageId ?? null,
    attemptId: meta.attemptId ?? meta.turnId ?? null,
    seq: meta.seq ?? 0,
    phase: 'running',
    content: '',
    hidden: false,
    toolEvents: [],
    permissionRequest: null,
  };
  activeStreams.set(scopedSessionKey, info);
  writeStreamBuffer(scopedSessionKey, {
    content: '', turnId: info.turnId, messageId: info.messageId,
    attemptId: info.attemptId, seq: info.seq, phase: info.phase,
    hidden: false, toolEvents: [], permissionRequest: null,
  });
  return ac;
}

export function abortChat(userId, agentId) {
  if (!userId || !agentId) return;
  const key = `${userId}_${agentId}`;
  abortControllers.get(key)?.abort();
  abortControllers.delete(key);
  activeStreams.delete(key);
}

export function abortAllChats() {
  for (const [id, ac] of abortControllers) {
    ac.abort();
    abortControllers.delete(id);
  }
  activeStreams.clear();
}

/**
 * The cleanup tuple every short-circuit and the main finally-block share:
 * clear the AbortController + active-stream registries, drop the stream
 * buffer, and release the busy slot so the next message can run.
 *
 * Only safe to call AFTER openTurn() has been called and a slot has been
 * acquired via markAgentBusy. Early-return paths above that setup don't
 * need this.
 *
 * @param {string} scopedSessionKey   `${userId}_${agentId}`
 * @param {{release: () => void}} busySlot  slot returned by markAgentBusy
 */
export function finalizeTurn(scopedSessionKey, busySlot, ownAc = null) {
  // Only tear down the abort/stream registries + buffer if THIS turn still owns
  // the key. A barge-in (a second interactive message on the same agent) calls
  // openTurn(), which replaces the controller under this key; without this
  // ownership check the first turn's finalize would delete the SECOND turn's
  // controller + stream entry + buffer, leaving it unkillable (Stop finds no
  // controller) and invisible to WS reconnect. ownAc omitted → legacy callers
  // keep the old unconditional cleanup.
  if (!ownAc || abortControllers.get(scopedSessionKey) === ownAc) {
    abortControllers.delete(scopedSessionKey);
    activeStreams.delete(scopedSessionKey);
    clearStreamBuffer(scopedSessionKey);
  }
  busySlot.release();
}
