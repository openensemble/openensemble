/**
 * Predictive context injection — tighten the cortex memory block before it
 * lands in the LLM system prompt.
 *
 * Two layers, both cheap and deterministic. A real cortex classifier head
 * can drop in later (see `classifyRecallShape` — the surface is stable):
 *
 *   1. `shouldSkipRecall(userMessage)` — fast regex pre-filter. Returns
 *      true for messages that clearly don't benefit from memory recall:
 *      single-token confirmations, slash commands, voice-control utterances
 *      ("volume up", "stop", "pause"), and ultra-short non-question reactions.
 *      Saves the embed + 3 LanceDB queries that `buildAgentContext` would
 *      otherwise do for every "yes" / "/threshold" / "go" turn.
 *
 *   2. `filterByConfidence(memories, threshold)` — drop snippets whose
 *      ranker score didn't clear the threshold. The existing recall path
 *      always returns its top-K even when the K-th item is barely relevant;
 *      injecting weak hits actively misleads the LLM (it grounds on them
 *      confidently). This is the "wrong snippet → wrong answer" tradeoff
 *      called out in the design discussion.
 *
 * The defaults are conservative — biased toward NOT injecting when in doubt,
 * because false-positive injection (wrong context) is worse than false-
 * negative (missing context). When the threshold cuts everything, the
 * `<cortex-memory>` block is omitted entirely; the LLM falls back to its
 * own tool use if it actually needs prior context.
 */

// ── Layer 1: cheap pre-filter ────────────────────────────────────────────────

// Single-token confirmations and rejections — exact-match shape from
// memory/signals.mjs:CONFIRMATION_RE, kept in sync deliberately. These
// turns are responses to the agent, not new queries, and recall would
// surface stale context.
const CONFIRMATION_RE = /^(?:yes|no|ok|okay|sure|confirm|cancel|go|stop|done|trash|delete|send|proceed|continue|skip|nope|yep|yup|aye|nah|please|thanks|thank you|got it|sounds good|do it|go ahead|abort)[\s!.]*$/i;

// Slash commands (/trim, /threshold, /claim, etc.) are pure dispatcher
// directives — the slash-command interceptor handles them before LLM, so
// recall would be wasted work even if we never injected the result.
const SLASH_COMMAND_RE = /^\s*\//;

// Voice-control commands resolved by the voice-preprocess interceptors
// (volume / pause / play / mute / etc). Listed here so the recall layer
// doesn't fire for them when they arrive via the web chat surface — the
// voice interceptors only run for source === 'voice-device'.
const VOICE_CONTROL_RE = /^(?:volume (?:up|down|max|min|to \d+%?)|mute|unmute|pause|resume|play|stop|next|previous|skip)[\s.!?]*$/i;

// Very short non-question reactions — "huh", "wait", "oh", etc. Same shape
// as SHORT_REACTION_RE in signals.mjs, kept narrow on purpose: if the user
// types "wait, what about X?" the trailing content forces it past the
// length gate and we DO recall.
const SHORT_REACTION_RE = /^(?:o+h?\s|wait\b|huh\b|hmm+\b|really\??$|no way\b|i thought\b|i think it'?s\b|actually\b|whoops\b|oops\b|nvm\b|never mind\b)/i;
const SHORT_REACTION_MAX_LEN = 80;

// Cheap structural signal that a message is a question — keep recall
// enabled even for very short ones if they end with "?" or start with a
// question word, since those are exactly the cases where prior context
// matters most.
const QUESTION_HINT_RE = /\?|^(?:what'?s?|which|who'?s?|whose|when|where|why|how|do|does|did|is|are|was|were|can|could|should|would|will|am|have|has|had|tell me|show me|list)\b/i;

/**
 * Returns `{ skip: true, reason }` when the message is unlikely to benefit
 * from cortex recall, `{ skip: false }` otherwise. Reason is logged at
 * debug level so we can audit false-skips in production.
 *
 * @param {string} userMessage
 * @returns {{ skip: boolean, reason?: string }}
 */
export function shouldSkipRecall(userMessage) {
  const t = (userMessage || '').trim();
  if (!t) return { skip: true, reason: 'empty' };
  if (CONFIRMATION_RE.test(t)) return { skip: true, reason: 'confirmation' };
  if (SLASH_COMMAND_RE.test(t)) return { skip: true, reason: 'slash_command' };
  if (VOICE_CONTROL_RE.test(t)) return { skip: true, reason: 'voice_control' };
  if (
    t.length <= SHORT_REACTION_MAX_LEN &&
    SHORT_REACTION_RE.test(t) &&
    !QUESTION_HINT_RE.test(t)
  ) {
    // "wait" alone skips, but "wait, what about X?" hits QUESTION_HINT_RE
    // and falls through — recall is exactly what those turns need.
    return { skip: true, reason: 'short_reaction' };
  }
  return { skip: false };
}

// ── Layer 2: confidence post-filter ──────────────────────────────────────────

/**
 * Default minimum `final_score` for a snippet to be injected. Tuned so the
 * top-of-stack hit on a vaguely-related query gets dropped while a clearly-
 * relevant hit passes. recall.mjs's blended score is roughly:
 *   semSim*0.40 + salience*0.30 + retention*0.20 + confidence*0.10
 * On a typical user_facts row with high confidence + stability, a
 * `_distance` of ~0.45 (semSim = 0.55) yields final_score ~0.55; a
 * `_distance` of ~0.70 (semSim = 0.30) yields ~0.40. The threshold is
 * the cutoff between "probably useful" and "probably noise".
 */
export const DEFAULT_INJECTION_THRESHOLD = 0.45;

/**
 * Drop low-confidence snippets from a recall result. Always preserves
 * immortal rows regardless of score — they're pinned for a reason and
 * skipping them would silently disable user-explicit preferences when
 * the query happens to be tangentially related.
 *
 * @param {Array<{final_score?: number, immortal?: boolean}>} memories
 * @param {number} [threshold]
 * @returns {Array}
 */
export function filterByConfidence(memories, threshold = DEFAULT_INJECTION_THRESHOLD) {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  return memories.filter(m => {
    if (m?.immortal) return true;
    // recall.mjs's immortal path is loaded separately and lacks final_score;
    // anything without a score that isn't immortal is unusual — keep it
    // rather than silently drop, but the typical case is the immortal path.
    if (typeof m?.final_score !== 'number') return true;
    return m.final_score >= threshold;
  });
}

// ── Layer 3: recall-shape classifier (stub for future cortex head) ──────────

/**
 * Future hook for a trained "what kind of recall does this turn need?"
 * classifier. Today returns the conservative all-true shape so callers
 * exist in their final form before the classifier lands.
 *
 * Once a cortex head ships (see project_cortex_automation_todo.md), this
 * function calls into `generateCombined(..., { caller: 'recall_scope' })`
 * and maps the parsed output into the shape. Callers will not need to
 * change.
 *
 * @param {string} _userMessage
 * @returns {{ needsParams: boolean, needsEpisodes: boolean, needsFacts: boolean }}
 */
export function classifyRecallShape(_userMessage) {
  return { needsParams: true, needsEpisodes: true, needsFacts: true };
}
