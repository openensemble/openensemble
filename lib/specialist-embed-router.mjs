/**
 * Embedding-based specialist router.
 *
 * Companion to the regex-based router in chat-dispatch.mjs. When regex misses,
 * we embed the user's message with the bundled nomic-embed model (~70MB, ~20ms
 * per query in-process) and find the nearest example phrase across all
 * specialist skills. If the match is confident and unambiguous, we route the
 * turn straight to that skill's owner — skipping Sydney's reasoning entirely.
 *
 * Manifest field: each service skill can declare `intent_examples` — an array
 * of natural-language phrases that represent typical user requests for that
 * skill. Boot-time we embed every example once; per-turn we embed the user's
 * message and dot-product against all examples (already normalized, so dot =
 * cosine similarity).
 *
 * Tunables:
 *   - threshold: minimum cosine sim for a confident match. Default 0.72.
 *     Toggleable at runtime via /threshold N (in chat-dispatch).
 *   - gap: minimum margin between best and second-best skill. If two skills
 *     score within `gap` of each other, treat as ambiguous → fall through.
 *     Default 0.05.
 *
 * Returns null on:
 *   - cache not loaded
 *   - user not on coordinator
 *   - no example exceeds threshold
 *   - best skill within `gap` of second-best (ambiguous)
 */

import { embed } from '../memory/embedding.mjs';
import { listRoles, listAllRoles, getRoleAssignments } from '../roles.mjs';

let _examples = []; // [{ skillId, name, phrase, vec }]
let _loaded = false;
// 0.78 default chosen empirically: catches most paraphrases (sim 0.80-0.95 for
// real intents) while keeping false positives like "what time is it" → gcal
// (sim 0.777) below threshold. Tune live via /threshold in chat.
let _threshold = 0.78;
const DEFAULT_GAP = 0.05;

export async function loadIntentEmbeddings() {
  _loaded = false;
  const next = [];
  let skillCount = 0;
  const start = Date.now();
  // listAllRoles() (not listRoles()) so per-user custom skills with
  // intent_examples also get indexed. Each example is tagged with the owning
  // userId derived from manifest.createdBy (or null for global system skills),
  // and classifyByEmbedding filters out cross-user examples at query time so
  // user A's custom-skill phrases never match user B's prompts.
  for (const m of listAllRoles()) {
    if (!Array.isArray(m.intent_examples) || m.intent_examples.length === 0) continue;
    const ownerUserId = typeof m.createdBy === 'string' ? m.createdBy : null;
    skillCount++;
    for (const phrase of m.intent_examples) {
      if (typeof phrase !== 'string' || !phrase.trim()) continue;
      try {
        const vec = await embed(phrase);
        if (Array.isArray(vec) && vec.length) next.push({ skillId: m.id, name: m.name, phrase, vec, ownerUserId });
      } catch (e) {
        console.warn(`[embed-router] failed to embed example "${phrase}" for ${m.id}:`, e.message);
      }
    }
  }
  _examples = next;
  _loaded = true;
  console.log(`[embed-router] loaded ${_examples.length} examples across ${skillCount} skills in ${Date.now() - start}ms`);
}

// Force a rebuild — call after a skill is added/removed/edited so new examples
// take effect without a server restart.
export function invalidateIntentEmbeddings() {
  _loaded = false;
  _examples = [];
}

export function getEmbedThreshold() { return _threshold; }
export function setEmbedThreshold(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 1) return false;
  _threshold = n;
  return true;
}

// Vectors come back from nomic-embed normalized (see memory/builtin-embed.mjs
// `normalize: true`), so dot product equals cosine similarity. No /(|a||b|).
function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Classify a user message against the loaded intent examples.
 * Returns { skillId, agentId, name, sim, phrase, strategy } or null.
 *
 * Only fires when:
 *   - currentAgentId matches the user's coordinator (don't surprise users in
 *     specialist chats)
 *   - exactly one skill clearly wins (sim ≥ threshold, gap to next ≥ gap)
 *   - that skill is assigned to a non-coordinator agent
 */
export async function classifyByEmbedding(text, userId, currentAgentId, opts = {}) {
  if (!_loaded || _examples.length === 0) return null;
  if (typeof text !== 'string' || text.trim().length < 4) return null;

  const assignments = getRoleAssignments(userId);
  const coordAgentId = assignments?.coordinator;
  // currentAgentId guard: when set, must match the user's coordinator.
  // The tool-router calls with currentAgentId=null to mean "I am the
  // coordinator's pre-LLM trim — don't gate on the chat's agent."
  if (currentAgentId != null && (!coordAgentId || currentAgentId !== coordAgentId)) return null;

  const threshold = typeof opts.threshold === 'number' ? opts.threshold : _threshold;
  const gap = typeof opts.gap === 'number' ? opts.gap : DEFAULT_GAP;
  // includeUnassigned: tool-router passes true so non-service skills like
  // `profiles` (which have no agent owner) can also win. Specialist-router
  // calls without it — for routing-to-a-specialist we need a real owner.
  const includeUnassigned = opts.includeUnassigned === true;

  let queryVec;
  try { queryVec = await embed(text); }
  catch (e) { console.warn('[embed-router] query embed failed:', e.message); return null; }
  if (!Array.isArray(queryVec) || queryVec.every(v => v === 0)) return null;

  // Best example per skill, ignoring skills not assigned (or owned by coord).
  // The literal "coordinator" string is an alias — resolve it first.
  const bestPerSkill = new Map();
  for (const ex of _examples) {
    // Per-user scoping: examples from user A's custom skills must NOT match
    // user B's prompts. ownerUserId === null means a global system skill,
    // which is shared by everyone.
    if (ex.ownerUserId && ex.ownerUserId !== userId) continue;
    const rawOwner = assignments[ex.skillId];
    let owner = null;
    if (rawOwner) {
      owner = rawOwner === 'coordinator' ? coordAgentId : rawOwner;
      if (owner === coordAgentId) continue;
    } else if (!includeUnassigned) {
      continue;
    }
    const sim = dot(queryVec, ex.vec);
    const cur = bestPerSkill.get(ex.skillId);
    if (!cur || sim > cur.sim) {
      bestPerSkill.set(ex.skillId, { sim, agentId: owner, name: ex.name, phrase: ex.phrase });
    }
  }
  if (bestPerSkill.size === 0) return null;

  // Rank skills by their best example similarity.
  const ranked = [...bestPerSkill.entries()]
    .map(([skillId, b]) => ({ skillId, ...b }))
    .sort((a, b) => b.sim - a.sim);
  const top = ranked[0];
  if (top.sim < threshold) return null;

  // Disambiguation: if the next-best skill is within `gap`, it's a tie — fall
  // through so the LLM can clarify rather than guess wrong.
  const second = ranked[1];
  if (second && (top.sim - second.sim) < gap) return null;

  return {
    skillId: top.skillId,
    agentId: top.agentId,
    name: top.name,
    sim: top.sim,
    phrase: top.phrase,
    strategy: 'embed',
  };
}
