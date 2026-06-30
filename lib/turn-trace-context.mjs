// @ts-check
/**
 * First-class turn trace — a per-turn correlation SPINE, not a new telemetry
 * subsystem. One structured record per top-level chat turn carries: turnId,
 * rootId, the agent spans that ran (incl. delegated sub-agents), the delegation
 * chain, routing decision, per-span model/provider/token/timing, and errors —
 * so a single `tag:"turn"` filter in logs/app.log reconstructs everything that
 * happened in a turn, including delegated sub-turns and background children.
 *
 * Mechanism mirrors lib/scheduled-context.mjs / lib/memory-scope-context.mjs:
 * an AsyncLocalStorage established with enterWith at the head of the turn
 * (chat-dispatch handleChatMessage for interactive turns; lazily inside
 * streamChat for direct background/scheduled callers). Because inline
 * delegation (ask_agent, specialist-router) runs within the parent's async
 * call tree, nested streamChat runs see the parent store automatically and push
 * their own span into the SAME trace — no id threading required.
 *
 * Contract — a trace bug must NEVER break a chat turn:
 *   - every recorder is a no-op outside a turn (getStore() === undefined)
 *   - every function swallows its own errors
 *   - data is accumulated in-memory and written ONCE at turn end; nothing here
 *     blocks the stream.
 *
 * Metadata only: tool NAMES, counts, ids, timing, token counts. Never prompt or
 * message bodies — this keeps the record inside logger.mjs's redaction contract
 * and avoids PII bloat.
 *
 * Token fields are deliberately named inTok/outTok (not inputTokens/
 * outputTokens): logger.mjs's redact() blanks any meta KEY matching /token/i,
 * which would silently nuke the token counts on the way to disk.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export const turnTraceContext = new AsyncLocalStorage();

/**
 * Mint a turn store and enter it for the current async context. If a parent
 * store already exists (a nested/delegated run sharing the same async tree),
 * inherit its rootId and link parentTurnId / depth+1 instead of starting a new
 * root. rootId/parentTurnId args let direct callers (background tasks) seed the
 * trace from an existing rootTaskId so bg children join the originating tree.
 * @param {{ userId?: string|null, agentId?: string|null, source?: string, rootId?: string|null, parentTurnId?: string|null, forceRoot?: boolean }} [opts]
 */
export function beginTurn({ userId, agentId, source = 'web', rootId = null, parentTurnId = null, forceRoot = false } = {}) {
  try {
    // forceRoot ignores any ambient store. Needed for DETACHED runs (background/
    // scheduled tasks) whose IIFE inherited the spawning turn's store via ALS —
    // they must start their own (rootTaskId-seeded) root, not attach to a parent
    // turn that has already been flushed.
    const parent = forceRoot ? null : turnTraceContext.getStore();
    const turnId = 't_' + randomUUID().slice(0, 12);
    const store = {
      turnId,
      rootId: rootId ?? parent?.rootId ?? turnId,
      parentTurnId: parentTurnId ?? parent?.turnId ?? null,
      depth: parent ? parent.depth + 1 : 0,
      userId: userId ?? null,
      agentId: agentId ?? null,
      source: source ?? 'web',
      startedAt: Date.now(),
      routing: null,
      spans: [],
      delegations: [],
      errors: [],
    };
    turnTraceContext.enterWith(store);
    return store;
  } catch {
    return null;
  }
}

/** The current turn store, or null outside a turn. */
export function getTurn() {
  try { return turnTraceContext.getStore() || null; } catch { return null; }
}

/** Merge a routing decision (mode / redirectedTo / fastPath / specialist / toolPlan). No-op outside a turn. */
export function recordRouting(patch) {
  try { const s = getTurn(); if (s && patch) s.routing = { ...(s.routing || {}), ...patch }; } catch { /* never throw */ }
}

/** Push one agent span (built by streamChat). No-op outside a turn. */
export function recordSpan(span) {
  try { const s = getTurn(); if (s && span) s.spans.push(span); } catch { /* never throw */ }
}

/** Push one delegation edge { from, to, directive, ms, background? }. No-op outside a turn. */
export function recordDelegation(d) {
  try { const s = getTurn(); if (s && d) s.delegations.push(d); } catch { /* never throw */ }
}

/** Append an error string to the turn. No-op outside a turn. */
export function recordError(err) {
  try { const s = getTurn(); if (s) s.errors.push(String(err?.message || err).slice(0, 300)); } catch { /* never throw */ }
}

/** Update the turn's top-level agentId (e.g. after an at-mention redirect). No-op outside a turn. */
export function setTurnAgent(agentId) {
  try { const s = getTurn(); if (s && agentId) s.agentId = agentId; } catch { /* never throw */ }
}

/**
 * Assemble the final trace object (stamps endedAt/durationMs). Does NOT clear
 * the ALS — the run() scope ends naturally; this just returns the object to log.
 * Returns null outside a turn.
 */
export function finishTurn() {
  try {
    const s = getTurn();
    if (!s) return null;
    const endedAt = Date.now();
    return { ...s, endedAt, durationMs: endedAt - s.startedAt };
  } catch {
    return null;
  }
}
