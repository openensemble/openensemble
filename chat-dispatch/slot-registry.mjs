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

import { clearStreamBuffer } from '../sessions.mjs';

// Track active AbortControllers so in-progress runs can be cancelled.
// Keyed by `${userId}_${agentId}` so one user's chat can't abort another user's
// concurrent chat on the same agent id (cross-user DoS).
const abortControllers = new Map();

// Track which agents are actively streaming, so reconnecting clients can be told.
// Same scoped key as abortControllers.
const activeStreams = new Map(); // `${userId}_${agentId}` → { userId, agentId, startTs }

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
    if (info.userId === userId) result.push({ agentId: info.agentId, startTs: info.startTs });
  }
  return result;
}

/**
 * Register the AbortController + active-stream metadata for a new turn.
 * Returns the AbortController so the caller can pass `.signal` to streamChat.
 * Aborts any prior controller for the same scoped key first — defensive,
 * since handleChatMessage shouldn't be entered twice for the same key.
 */
export function openTurn(scopedSessionKey, userId, agentId) {
  abortControllers.get(scopedSessionKey)?.abort();
  const ac = new AbortController();
  abortControllers.set(scopedSessionKey, ac);
  activeStreams.set(scopedSessionKey, { userId, agentId, startTs: Date.now() });
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
export function finalizeTurn(scopedSessionKey, busySlot) {
  abortControllers.delete(scopedSessionKey);
  activeStreams.delete(scopedSessionKey);
  clearStreamBuffer(scopedSessionKey);
  busySlot.release();
}
