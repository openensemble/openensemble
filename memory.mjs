/**
 * Cortex — Persistent memory for OpenEnsemble
 * LanceDB + nomic-embed-text embeddings + qwen2.5:7b salience scoring
 *
 * This file is a public facade. The implementation is split across memory/*.mjs:
 *
 *   memory/shared.mjs         — constants, config, write queue, provider helpers
 *   memory/embedding.mjs      — embed + LRU cache, salience, contradiction
 *   memory/lance.mjs          — DB handles, remember, pin, rememberFast, enrich
 *   memory/recall.mjs         — recall, forget, spaced repetition, temporal
 *   memory/session-buffer.mjs — per-agent buffers, idle summaries, triage
 *   memory/context.mjs        — buildAgentContext + formatContext
 *   memory/signals.mjs        — corrections, preferences, friction, processSignals
 *   memory/migration.mjs      — getMemoryStats, migrateSharedCortexToUser
 *
 * Features:
 *  - Fast write path: embedding only (~5ms), scoring queued for background
 *  - Ebbinghaus temporal decay (memories fade unless recalled)
 *  - Salience scoring: emotional weight, decision weight, uniqueness
 *  - Contradiction detection: new facts supersede old conflicting ones
 *  - Signal tracking: corrections, preferences, friction auto-promoted to immortal
 *  - Shared user facts across all agents
 *  - Context window budgeting: never fills up regardless of conversation length
 */

export { embed } from './memory/embedding.mjs';
export { remember, pin } from './memory/lance.mjs';
export {
  recall, getDueReviews, updateReviewSchedule, forget, forgetByText,
} from './memory/recall.mjs';
export { addToSessionBuffer } from './memory/session-buffer.mjs';
export { buildAgentContext, formatContext } from './memory/context.mjs';
export {
  detectAndStoreCorrection, detectAndStorePreference, trackFriction, processSignals, pinFact,
} from './memory/signals.mjs';
export { getMemoryStats, migrateSharedCortexToUser } from './memory/migration.mjs';
