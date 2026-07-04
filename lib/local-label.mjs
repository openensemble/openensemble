/**
 * lib/local-label.mjs — the skill-agnostic LOCAL LABELING engine.
 *
 * The core insight behind the "local cognition tier": routing a command to a
 * tool and sorting an item into a label are the SAME operation — embed the
 * input, match it against labeled examples, act, learn from corrections. They
 * differ only in the label set. This module is that one operation. Phase 1
 * ships the DISPATCH face (utterance -> which intent/tool + slots); CLASSIFY
 * and the per-user learned-example store land in Phase 3.
 *
 * Skills opt in purely via a manifest `localIntents` block — the engine and
 * the interceptor contain zero skill names:
 *
 *   "localIntents": [
 *     { "id": "search_item", "tool": "publix_bogos_search",
 *       "utterances": ["any bogos on X", "is X buy one get one"],   // -> Tier 2 (nomic)
 *       "patterns":  ["bogos?\\s+(on|for)\\s+(?<query>.+)"],         // -> Tier 1 (regex + named slots)
 *       "slots": ["query"], "confirm": false }
 *   ]
 *
 * Cascade (cheapest first; only runs when the kill switch is on):
 *   Tier 1  regex   — exact match + named-group slot extraction.            (free)
 *   Tier 2  nomic   — embed the utterance, cosine-rank against every intent's
 *                     example utterances (threshold + disambiguation gap,
 *                     mirroring lib/specialist-embed-router.mjs).            (~20ms)
 *   Tier 3  GGUF    — fill messy slots the regex missed. STUB until Phase 2;
 *                     a required slot left unfilled => return null => the
 *                     coordinator LLM handles it (unchanged behavior).
 *
 * The engine only MATCHES + EXTRACTS. Execution (and the chat contract) lives
 * in chat-dispatch/local-intent-fastpath.mjs, which calls executeRoleTool.
 */

import { loadConfig } from '../routes/_helpers.mjs';
import { listRoles, executeRoleTool, agentCanFastpathSkill } from '../roles.mjs';
import { embed } from '../memory/embedding.mjs';
import { loadLearnedIntents } from './learned-intents.mjs';

// Mirror lib/specialist-embed-router.mjs: vectors come back from nomic-embed
// L2-normalized, so dot product == cosine similarity. 0.78 catches paraphrases
// while filtering near-misses; the 0.05 top1-vs-top2 gap rejects ambiguous
// matches (two intents phrased alike) rather than guessing.
const EMBED_THRESHOLD = 0.78;
const EMBED_GAP = 0.05;

// Built-in domain ANCHORS — non-dispatchable pseudo-intents that participate
// in Tier-2 ranking so custom-skill intents can't win uncontested against
// requests that belong to a built-in capability. Field lesson (2026-07-04):
// "set a reminder for tomorrow morning" cleared the threshold against a
// weather intent's "weather tomorrow morning" utterance — the shared temporal
// phrase dominates — and since reminders register no localIntents, nothing
// competed and the gap rule never fired. Anchors give those domains a voice:
// if the best real intent doesn't beat the closest anchor by EMBED_GAP, we
// don't guess — the turn falls through to the normal chain (scheduler
// intercept, specialist router, coordinator), which owns these domains.
// Keep utterances SHORT and canonical — they're competitors, not classifiers,
// and an over-specific anchor can shadow a legitimate custom-skill paraphrase.
export const BUILTIN_DOMAIN_ANCHORS = [
  { domain: 'reminders', utterances: [
    'set a reminder for tomorrow',
    'remind me to call mom tomorrow',
    'remind me tomorrow morning to take out the trash',
    'set an alarm for 7 am',
    'wake me up tomorrow morning',
    'schedule a task for next week',
  ] },
  { domain: 'calendar', utterances: [
    "what's on my calendar tomorrow",
    'do I have anything on my schedule tomorrow',
    'add an event to my calendar',
    'when is my next meeting',
  ] },
  { domain: 'email', utterances: [
    'check my email',
    'any new emails this morning',
    'read me my latest email',
  ] },
  { domain: 'timers', utterances: [
    'set a timer for ten minutes',
    'how much time is left on the timer',
  ] },
  { domain: 'home', utterances: [
    'turn on the kitchen lights',
    'set the thermostat to 72 degrees',
    'lock the front door',
  ] },
  { domain: 'messaging', utterances: [
    "send a message to alex saying I'm running late",
    "text alex that I'll be there soon",
  ] },
  { domain: 'media', utterances: [
    'play some music in the kitchen',
    'stop the music',
  ] },
];

/** Runtime kill switch. Absent/false => the whole tier is inert (Phase-1 default). */
export function localTierEnabled() {
  try { return loadConfig()?.localTier?.enabled === true; }
  catch { return false; }
}

/**
 * Tier-3 (<extract> GGUF) sub-flag. Off until the plan model has actually been
 * trained on the <extract> task AND deployed — otherwise extractSlots returns
 * schema-valid-but-wrong values and we'd waste ~1.5s of inference per turn only
 * to fail the source-text validation and fall through anyway. Keep it off until
 * smoke-extract passes on the shipped model.
 */
function extractEnabled() {
  try { return loadConfig()?.localTier?.extract === true; }
  catch { return false; }
}

/**
 * Phase-3 learning sub-flag. When on, collectLocalIntents merges each user's
 * learned utterances (lib/learned-intents.mjs) into Tier-2, and the post-turn
 * capture hook (lib/intent-learner.mjs) records misses. Off => the tier behaves
 * exactly as Phase-1/2 (manifest utterances only). Exported so intent-learner
 * shares one reader (keeps the dependency one-way: intent-learner -> local-label).
 */
export function learningEnabled() {
  try { return loadConfig()?.localTier?.learning === true; }
  catch { return false; }
}

/**
 * Flatten every visible skill's `localIntents` into resolvable match entries.
 * `requiredSlots` is the intersection of the intent's declared slots and the
 * bound tool's JSON-schema `required` — so we know when a match can't execute
 * without an unfilled slot (and must fall through to a lower tier / the LLM).
 * Reuses listRoles(userId) (globals + the user's own skills, disable-aware).
 */
export function collectLocalIntents(userId) {
  const out = [];
  // Phase 3: merge per-user LEARNED utterances into Tier-2. Gated on the learning
  // sub-flag so it's zero IO when off. The _uttVec cache is text-keyed and
  // additive-safe, so newly-learned utterances are just first-use cache-misses —
  // no invalidation needed, and they take effect on the very next dispatch.
  const learned = learningEnabled() ? loadLearnedIntents(userId) : null;
  const roles = listRoles(userId);
  for (const manifest of roles) {
    const intents = Array.isArray(manifest.localIntents) ? manifest.localIntents : null;
    if (!intents?.length) continue;
    const toolsByName = new Map((manifest.tools || []).map(t => [t.function?.name, t]));
    for (const intent of intents) {
      if (!intent?.id || !intent?.tool) continue;
      const tool = toolsByName.get(intent.tool);
      if (!tool) continue;   // a localIntent must bind a tool the same skill owns
      const params = tool.function?.parameters || {};
      const requiredParams = Array.isArray(params.required) ? params.required : [];
      const slots = Array.isArray(intent.slots) ? intent.slots : [];
      const manifestUtts = Array.isArray(intent.utterances) ? intent.utterances : [];
      const learnedUtts = learned?.[manifest.id]?.[intent.id]?.utterances;
      out.push({
        skillId: manifest.id,
        intentId: intent.id,
        tool: intent.tool,
        utterances: (Array.isArray(learnedUtts) && learnedUtts.length)
          ? [...manifestUtts, ...learnedUtts]
          : manifestUtts,
        patterns: Array.isArray(intent.patterns) ? intent.patterns : [],
        slots,
        requiredSlots: slots.filter(s => requiredParams.includes(s)),
        confirm: intent.confirm === true,
        // Anchors only compete against CUSTOM skills — a built-in's own
        // localIntents (email's list_email, etc.) legitimately sit on top of
        // their domain's anchor and must never be vetoed by it.
        custom: manifest.custom === true,
        // no_learn: high-variance generic readers (email_list, etc.) opt out of
        // the dispatch-learning loop — their phrasing space is unbounded, so
        // proposing to learn individual phrasings is noise. Still dispatchable
        // locally via their manifest utterances; just never proposed for.
        no_learn: intent.no_learn === true,
      });
    }
  }
  // Learned-ONLY intents — store entries no manifest intent declares. Two
  // producers: the auto-proposer (a CUSTOM skill with no localIntents block
  // kept getting cloud-routed for one deterministic tool → `auto_<tool>`) and
  // explicit teaching (`teach_fastpath_phrase` → `user_taught_<tool>` or an
  // existing intent id). The store saves the bound tool per entry, so these
  // are self-describing; same tool-must-exist gate as manifest intents, and
  // deleting users/<id>/learned-intents.json reverts everything.
  if (learned) out.push(...materializeLearnedOnlyIntents(learned, roles, out));
  return out;
}

/**
 * Build dispatchable intents from learned-store entries that have no manifest
 * counterpart. Pure — exported for tests. `existing` guards double-emission
 * (a manifest intent with the same id already carries its learned utterances
 * via the merge in collectLocalIntents).
 */
export function materializeLearnedOnlyIntents(learned, roles, existing = []) {
  const out = [];
  const emitted = new Set(existing.map(i => `${i.skillId}|${i.intentId}`));
  const byId = new Map(roles.map(m => [m.id, m]));
  for (const [skillId, intents] of Object.entries(learned || {})) {
    const manifest = byId.get(skillId);
    if (!manifest) continue;   // skill removed/disabled — entries stay dormant
    const toolsByName = new Map((manifest.tools || []).map(t => [t.function?.name, t]));
    for (const [intentId, entry] of Object.entries(intents || {})) {
      if (emitted.has(`${skillId}|${intentId}`)) continue;
      const tool = toolsByName.get(entry?.tool);
      if (!tool) continue;     // must bind a tool the skill still owns
      const utterances = Array.isArray(entry?.utterances) ? entry.utterances.filter(Boolean) : [];
      if (!utterances.length) continue;
      const params = tool.function?.parameters || {};
      const requiredParams = Array.isArray(params.required) ? params.required : [];
      out.push({
        skillId, intentId, tool: entry.tool, utterances,
        custom: manifest.custom === true,
        patterns: [],
        // Let Tier-3 extract attempt the tool's required params; if it can't
        // fill them from the utterance, dispatch falls through to the LLM —
        // never a half-filled call.
        slots: requiredParams,
        requiredSlots: requiredParams,
        confirm: tool.destructive === true,
        no_learn: false,
      });
    }
  }
  return out;
}

// Compiled-regex cache (patterns are static manifest strings). A bad pattern
// caches as null so we don't recompile-and-throw every turn.
const _reCache = new Map();
function compile(pattern) {
  if (_reCache.has(pattern)) return _reCache.get(pattern);
  let re = null;
  try { re = new RegExp(pattern, 'i'); } catch { re = null; }
  _reCache.set(pattern, re);
  return re;
}

// Try an intent's regex patterns against the text; first match wins. Named
// capture groups that name a declared slot become args. Returns { matched, args }.
function regexExtract(intent, text) {
  for (const pattern of intent.patterns) {
    const re = compile(pattern);
    if (!re) continue;
    const m = re.exec(text);
    if (!m) continue;
    const args = {};
    if (m.groups) {
      for (const [k, v] of Object.entries(m.groups)) {
        if (v == null) continue;
        if (intent.slots.length === 0 || intent.slots.includes(k)) args[k] = v.trim();
      }
    }
    return { matched: true, args };
  }
  return { matched: false, args: {} };
}

// Utterance-vector cache. Keyed by utterance text (a small, bounded set drawn
// from manifests) — NOT by user query (unbounded). embed() also LRU-caches
// internally, so this is just to avoid re-walking the model on every turn.
const _uttVec = new Map();
async function utteranceVec(text) {
  let v = _uttVec.get(text);
  if (v) return v;
  v = await embed(text);
  if (!v?.length || v.every(x => x === 0)) return null;   // embed failure => skip
  _uttVec.set(text, v);
  return v;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// Cosine-rank intents by their closest example utterance. Returns the winning
// intent only when it clears the threshold AND beats the runner-up by the gap.
async function embeddingMatch(intents, queryText) {
  const q = await embed(queryText);
  if (!q?.length || q.every(x => x === 0)) return null;
  let best = null, second = null;
  for (const intent of intents) {
    let sim = -Infinity;
    for (const u of intent.utterances) {
      const uv = await utteranceVec(u);
      if (!uv) continue;
      const s = dot(q, uv);
      if (s > sim) sim = s;
    }
    if (sim === -Infinity) continue;
    if (!best || sim > best.sim) { second = best; best = { intent, sim }; }
    else if (!second || sim > second.sim) { second = { intent, sim }; }
  }
  if (!best || best.sim < EMBED_THRESHOLD) return null;
  if (second && (best.sim - second.sim) < EMBED_GAP) return null;   // ambiguous -> don't guess
  // Built-in anchor veto — same don't-guess rule, but against domains that
  // have no localIntents of their own. Custom skills only: a built-in skill's
  // own intents (email's "check my email") legitimately overlap their domain
  // anchor and must keep their fast-path. Checked last so the (cheap, cached)
  // anchor vectors only get compared when a custom intent actually won.
  if (!best.intent.custom) return best.intent;
  for (const anchor of BUILTIN_DOMAIN_ANCHORS) {
    for (const u of anchor.utterances) {
      const uv = await utteranceVec(u);
      if (!uv) continue;
      const s = dot(q, uv);
      if ((best.sim - s) < EMBED_GAP) {
        console.log(`[local-label] dispatch vetoed: "${best.intent.skillId}/${best.intent.intentId}" (${best.sim.toFixed(3)}) too close to builtin ${anchor.domain} ("${u}" ${s.toFixed(3)}) — falling through`);
        return null;
      }
    }
  }
  return best.intent;
}

/**
 * Match `text` to a local intent and extract its args. Returns
 * { skillId, intentId, tool, args, confirm, via } or null (no confident match
 * / required slot unfilled). Pure: no execution, no side effects.
 */
export async function dispatch(text, userId, { agentId = null } = {}) {
  const t = (text || '').trim();
  if (!t) return null;
  let intents = collectLocalIntents(userId);
  // Scope the fast-path to the agent in this chat: the coordinator may run any
  // skill's intent, a specialist only its own. Without this, ANY agent (e.g.
  // the deep-research agent) could fire email_list/email_inbox_stats on a
  // paraphrase. Owner + coordinator keep their fast-paths; others fall through
  // to the LLM (which escalates to the coordinator).
  if (agentId) intents = intents.filter(i => agentCanFastpathSkill(agentId, i.skillId, userId));
  if (!intents.length) return null;

  // Tier 1 — regex EXTRACTION, not classification. A pattern earns a
  // short-circuit only when it actually pulls a slot out of the utterance:
  // required slots all satisfied AND at least one declared slot captured. A
  // no-slot ("classifier") pattern never wins here — it falls through to Tier-2
  // embeddings, which classify more robustly and self-improve via the learning
  // loop. This confines regex to what it's uniquely good at: structured tokens
  // (emails, ids, ZIPs, dates). Free-text slots are left to Tier-3 extract.
  for (const intent of intents) {
    const { matched, args } = regexExtract(intent, t);
    if (matched
        && intent.requiredSlots.every(s => s in args)
        && intent.slots.some(s => s in args)) {
      return resolve(intent, args, 'regex');
    }
  }

  // Tier 2 — nomic classification. Pick the intent, then slot-fill (regex first,
  // then Tier-3 extract for anything left).
  const matched = await embeddingMatch(intents, t);
  if (matched) {
    const filled = { ...regexExtract(matched, t).args };

    // Every DECLARED slot already captured (or the intent has none) — nothing to
    // extract, return now. (No-slot intents like a list/toggle land here.)
    if (matched.slots.every(s => s in filled)) {
      return resolve(matched, filled, 'embed');
    }

    // Tier 3 — <extract> GGUF. Fill any DECLARED slot the regex didn't — required
    // OR optional. The search "query" in "any deals on greek yogurt" is optional
    // in the tool schema, but the user clearly named it, and no regex cleanly
    // captures free text — so extract must run here, not only when a slot is
    // *required*. Lazy import keeps node-llama-cpp off the hot path; gated by the
    // extract sub-flag. Every extracted value must appear verbatim in the
    // utterance (anti-hallucination), so a slot the user didn't mention stays
    // empty and the tool runs with its default.
    if (extractEnabled()) {
      try {
        const { extractSlots } = await import('../scheduler/builtin-plan.mjs');
        const ex = await extractSlots({ utterance: t, schema: slotSchema(matched) });
        if (ex) {
          for (const s of matched.slots) {
            if (filled[s] != null) continue;
            const v = ex[s];
            if (typeof v === 'string' && valueInText(v, t) && !isDomainNoise(v, matched)) filled[s] = v.trim();
          }
        }
      } catch (e) {
        console.debug('[local-label] extract failed:', e.message);
      }
    }

    // Return once every REQUIRED slot is satisfied; optional slots may stay empty
    // (the user simply didn't name them). A missing REQUIRED slot => LLM.
    if (matched.requiredSlots.every(s => s in filled)) {
      return resolve(matched, filled, extractEnabled() ? 'extract' : 'embed');
    }
    return null;
  }

  return null;
}

// Build a JSON Schema for an intent's slots: an object whose properties are the
// declared slots (nullable strings), all required so the model emits each field
// (null when the utterance doesn't mention it). Fed to extractSlots both as the
// prompt hint and the grammar.
function slotSchema(intent) {
  const properties = {};
  for (const s of intent.slots) properties[s] = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  return { type: 'object', properties, required: intent.slots };
}

// Anti-hallucination guard: a model-extracted value is only trusted if it
// actually appears in the source utterance (case-insensitive substring).
function valueInText(val, text) {
  const v = (val || '').trim().toLowerCase();
  return v.length > 0 && text.toLowerCase().includes(v);
}

// Domain-noise guard: the extract model sometimes returns a FRAMING word as a
// slot value — e.g. "publix" pulled as the search query from "what are the
// publix bogos". If every token of the value also appears in the skill/intent/
// tool identifiers, it's framing, not content; drop it so the slot stays empty
// and the tool runs with its default (here: show all, not filter by "publix").
function isDomainNoise(value, intent) {
  const domain = new Set(
    `${intent.skillId} ${intent.intentId} ${intent.tool}`
      .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  );
  const toks = String(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return toks.length > 0 && toks.every(tok => domain.has(tok));
}

function resolve(intent, args, via) {
  return {
    skillId: intent.skillId,
    intentId: intent.intentId,
    tool: intent.tool,
    args,
    confirm: intent.confirm,
    via,
  };
}

/** Execute a matched intent's bound tool directly — no LLM. */
export function runIntent(match, userId, agentId) {
  return executeRoleTool(match.tool, match.args || {}, userId, agentId);
}
