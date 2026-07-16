/**
 * lib/turn-abort-context.mjs — the current turn's AbortSignal, carried across
 * the async tree via AsyncLocalStorage (same pattern as tool-router-context /
 * turn-trace-context).
 *
 * Why: a user "stop" fires the TURN's AbortController (slot-registry
 * abortChat), which kills the coordinator's streamChat — but a sync
 * delegation (ask_agent) runs the specialist under its OWN AbortController,
 * reachable only from the task chip's Stop button. Field bug 2026-07-04: user
 * asked about the crypto market, the coordinator delegated to the finance
 * specialist, user said "stop" — the coordinator died but the delegation ran
 * to completion. Skill executors have no signal parameter (five positional
 * args across ~40 skills), so the signal rides ALS instead: the LLM loop
 * runs its streamChat consumption inside runWithTurnSignal(), and
 * skills/delegate links its per-delegation controller to whatever signal is
 * live. Nested delegations (depth 2) execute inside the same async tree, so
 * they link to the root turn's signal too — one stop unwinds the whole chain.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/**
 * Run fn with the turn's ambient context. Besides the abort signal, carries
 * the voice-device origin (deviceId + conversation flag) so work that
 * OUTLIVES the turn — auto-backgrounded tools, explicit background
 * delegations — can route its completion back to the device's speaker via
 * the voice announcement queue.
 */
export function runWithTurnContext(ctx, fn) {
  return als.run(ctx ?? {}, fn);
}

/** Back-compat: signal-only wrapper. */
export function runWithTurnSignal(signal, fn) {
  return runWithTurnContext({ signal }, fn);
}

/** The ambient turn AbortSignal, or null outside any turn context. */
export function getTurnSignal() {
  return als.getStore()?.signal ?? null;
}

/**
 * Full ambient turn context ({signal, deviceId, conversationMode,
 * suppressLearning, verifierAllowedTools, verifierLeaseRequired,
 * verifierLeaseToken}) or null.
 * verifierLeaseToken is an ephemeral capability and must never be serialized.
 */
export function getTurnContext() {
  return als.getStore() ?? null;
}
