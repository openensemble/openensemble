/**
 * chat-dispatch/local-intent-fastpath.mjs
 *
 * Pre-LLM interceptor for the skill-agnostic local cognition tier (DISPATCH
 * face). Asks lib/local-label.mjs whether the user's message matches any
 * skill's declared `localIntents`; if so, runs the bound tool locally and
 * streams the result back — no cloud coordinator call. Falls through (returns
 * null) on no match, on a destructive/confirm intent (Phase 1 defers those to
 * the LLM's existing APPROVE staging), or on any error.
 *
 * Same contract as tryHaFastpath: returns { handled:true } after owning
 * appendToSession + onEvent(token/done), or null to continue down the chain.
 * Gated by the localTier.enabled kill switch — when off, dispatch() is never
 * called, so the tier adds zero overhead.
 */

import { appendToSession } from '../sessions.mjs';
import { localTierEnabled, dispatch, runIntent } from '../lib/local-label.mjs';

// executeRoleTool can return a string, an object with `.text`, or an async
// generator (streaming skills). Normalize all three to a single string.
async function normalizeResult(result) {
  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    let acc = '';
    for await (const chunk of result) {
      if (typeof chunk === 'string') acc += chunk;
      else if (chunk?.text) acc += chunk.text;
    }
    return acc;
  }
  if (typeof result === 'string') return result;
  if (result?.text) return result.text;
  return result == null ? '' : String(result);
}

export async function tryLocalIntentFastpath({ userText, userId, agentId, onEvent }) {
  if (!userText) return null;
  if (!localTierEnabled()) return null;
  try {
    const match = await dispatch(userText, userId);
    if (!match) return null;

    // Phase-1 safety: never auto-run a destructive/confirm intent. Fall through
    // so the coordinator's existing "APPROVE …" staging asks the user first.
    // Local staging for confirm intents lands in Phase 3.
    if (match.confirm) {
      console.log(`[local-label] matched ${match.skillId}/${match.intentId} (confirm) — deferring to LLM approval flow`);
      return null;
    }

    const text = await normalizeResult(await runIntent(match, userId, agentId));
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: text, ts: Date.now() },
    );
    onEvent({ type: 'token', text, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    console.log(`[local-label] dispatch handled ${match.skillId}/${match.intentId} via ${match.via} (no LLM)`);
    return { handled: true };
  } catch (e) {
    console.warn('[local-label] fastpath threw, falling through:', e.message);
    return null;
  }
}
