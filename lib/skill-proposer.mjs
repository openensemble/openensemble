/**
 * Auto-skill proposer — OE's variant of Hermes Agent's skill-from-experience loop.
 *
 * After any agent turn that uses MIN_TOOLS+ "interesting" tools without
 * obvious failure, stash a candidate. On the user's NEXT turn the candidate
 * is either emitted as a kind='skill_proposal' bubble (non-corrective
 * follow-up → workflow likely succeeded) or dropped (corrective follow-up
 * → bundling a broken sequence is worse than no skill at all).
 *
 * Gates beyond Hermes' raw "5 tool calls" heuristic:
 *   - dismiss cooldown by sorted tool-set hash (don't re-ask same combo)
 *   - per-agent rate cap (1 active proposal per 7 days)
 *   - skip turns whose tool calls are ONLY memory/rule mutations
 *     (those are already first-class actions; bundling adds nothing)
 *   - skip when skill-* tools fired (user is already authoring)
 *   - skip when the user message contains a destructive verb
 *   - DEFER one turn: drop candidate if the user's next message looks
 *     corrective (no point bundling a workflow they're complaining about)
 *
 * The defer logic loses proposals when the user never sends a follow-up,
 * which is acceptable: silent passes are cheaper than noisy false-positives,
 * and the same workflow can re-trigger on the next session.
 */
import { proposeSkill } from './proposals.mjs';

const MIN_TOOLS = 4;
// Per-agent rate cap on NEW proposals — separate from the per-pattern
// dismiss cooldown (lib/proposals.mjs DISMISS_COOLDOWN_MS), which handles
// "user already said no to this combo". A week gives the user time to
// actually use the skill they just built before being nudged about another
// one; daily was over-eager and produced proposal fatigue.
const RATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 30 * 60 * 1000;

// Per-skill Jaccard threshold for "this new tool-set duplicates an existing
// custom skill". 0.5 means at least half of the union of (new tools, skill
// tools) is shared. Tuned to skip true duplicates without false-firing on
// single-tool overlap (e.g. both use web_search).
const OVERLAP_THRESHOLD = 0.5;
// Invocation count above which an overlapping existing skill is treated as
// "actively used" — proposing a duplicate then is pure churn.
const MIN_ACTIVE_INVOCATIONS = 3;
// Age after which an unused overlapping skill counts as dormant rather than
// "user hasn't tried it yet." 7 days lines up with the per-agent rate cap.
const DORMANT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const _lastProposedPerAgent = new Map();
const _pendingCandidates = new Map(); // agentId -> { candidate, createdAt }

// Tools whose presence is ignored when counting "interesting" tool calls.
// They're either explicit-intent mutations (the user asked for them directly)
// or the skill-authoring path itself.
const SKIP_TOOLS = new Set([
  'forget_fact', 'remember_fact',
  'role_add_rule', 'role_remove_rule', 'role_list_rules',
  'skill_create', 'skill_update_code', 'skill_patch_code',
  'skill_delete', 'skill_list', 'skill_read_code', 'skill_read_blueprint',
]);

const DESTRUCTIVE_RE = /\b(?:delete|remove|wipe|drop|format|destroy|erase|rm|uninstall|purge|trash|unlink|truncate|shred|kill|reset|clear)\b/i;

// Fast in-process correction detector. False positives are cheap (we drop a
// proposal that might have been useful — recoverable next time the workflow
// runs). False negatives are also cheap (user dismisses the bubble). Patterns
// chosen for clear "that's not what I wanted" shapes, not generic negatives —
// "no" alone isn't enough since user replies often start with "no, also can
// you…".
const CORRECTION_PHRASE_RE = /\b(?:wrong|incorrect|not (?:what|right|correct|like that|that)|that'?s? (?:not|wrong)|don'?t (?:do|need|want)|undo|redo|fix (?:that|it|this)|try again|i (?:said|wanted|meant)|why did you|you didn'?t|you forgot|you missed|you (?:were|are) wrong|that'?s (?:bad|broken))\b/i;

export function toolsetKey(toolsUsed) {
  if (!Array.isArray(toolsUsed)) return '';
  return [...new Set(toolsUsed.map(t => t?.name).filter(Boolean))].sort().join(',');
}

// Test hook — reset rate-limit + candidate state between test cases.
export function _resetForTests() {
  _lastProposedPerAgent.clear();
  _pendingCandidates.clear();
}

// Called by chat.mjs persist() AFTER each turn. Detects qualifying multi-tool
// turns and stashes them — does NOT emit a proposal. The emit happens on the
// next turn from flushPendingSkillCandidate(), gated on whether the follow-up
// message looks corrective.
export async function maybeProposeSkill({ userId, agentId, agentName, userMessage, assistantContent, toolsUsed }) {
  if (!userId || !agentId || !Array.isArray(toolsUsed)) return null;
  if (DESTRUCTIVE_RE.test(userMessage || '')) return null;

  const last = _lastProposedPerAgent.get(agentId);
  if (last && (Date.now() - last) < RATE_LIMIT_MS) return null;

  // Don't propose when the user was already authoring a skill on this turn —
  // skill_* tool calls mean skill-builder is the active workflow.
  if (toolsUsed.some(t => typeof t?.name === 'string' && t.name.startsWith('skill_'))) return null;

  const interesting = toolsUsed.filter(t => t?.name && !SKIP_TOOLS.has(t.name));
  if (interesting.length < MIN_TOOLS) return null;

  const toolNames = [...new Set(interesting.map(t => t.name))];

  // Per-skill Jaccard overlap check (was: flat-union `some()` which over-fired
  // on single shared utility tools like web_search). For each existing
  // custom skill, compute |new ∩ skill| / |new ∪ skill|; require ≥
  // OVERLAP_THRESHOLD to consider it a duplicate. Then factor in usage —
  // a heavily-used overlapping skill is a hard skip (definite duplicate),
  // an unused one is still a skip but logged separately so a future
  // reassignment-proposal path has a clear hook.
  //
  // Reason codes returned in `skipped`:
  //   overlaps_active_skill   — overlap + invocations ≥ MIN_ACTIVE_INVOCATIONS
  //   overlaps_dormant_skill  — overlap + zero invocations + skill > DORMANT_AGE_MS old
  //   overlaps_fresh_skill    — overlap + low usage AND skill is recent (give it time)
  try {
    const { listRoles } = await import('../roles.mjs');
    const { getSkillStats } = await import('./skill-telemetry.mjs');
    const stats = getSkillStats(userId);
    const newSet = new Set(toolNames);
    let bestMatch = null; // { skillId, jaccard, invocations, ageMs }
    for (const m of listRoles(userId)) {
      const isCustomSkill = (m.userScope === userId) || (m.custom && !m.service);
      if (!isCustomSkill) continue;
      const skillTools = new Set();
      for (const t of (m.tools ?? [])) {
        const name = t?.function?.name;
        if (name) skillTools.add(name);
      }
      if (skillTools.size === 0) continue;
      let intersect = 0;
      for (const n of newSet) if (skillTools.has(n)) intersect++;
      const union = newSet.size + skillTools.size - intersect;
      const jaccard = union === 0 ? 0 : intersect / union;
      if (jaccard < OVERLAP_THRESHOLD) continue;
      if (!bestMatch || jaccard > bestMatch.jaccard) {
        const skillStats = stats[m.id];
        const createdAt = Date.parse(m.createdAt || '') || 0;
        bestMatch = {
          skillId: m.id,
          jaccard,
          invocations: skillStats?.invocations || 0,
          ageMs: createdAt > 0 ? Date.now() - createdAt : Infinity,
        };
      }
    }
    if (bestMatch) {
      if (bestMatch.invocations >= MIN_ACTIVE_INVOCATIONS) {
        return { skipped: 'overlaps_active_skill', overlapWith: bestMatch.skillId };
      }
      if (bestMatch.invocations === 0 && bestMatch.ageMs >= DORMANT_AGE_MS) {
        return { skipped: 'overlaps_dormant_skill', overlapWith: bestMatch.skillId };
      }
      return { skipped: 'overlaps_fresh_skill', overlapWith: bestMatch.skillId };
    }
  } catch (e) {
    // Non-fatal — fall through and let the proposal fire if everything
    // else passes. Skipping the check is preferable to dropping a
    // legitimate proposal on a transient import error.
    console.debug('[skill-proposer] custom-skill overlap check failed:', e.message);
  }
  const userExcerpt = (userMessage || '').slice(0, 140).replace(/\s+/g, ' ').trim();
  const previewTools = toolNames.slice(0, 5).join(', ') + (toolNames.length > 5 ? ', …' : '');
  const message =
    `That turn used ${toolNames.length} different tools (${previewTools}). ` +
    `Want me to bundle this into a reusable skill so similar requests turn into one tool call next time?\n\n` +
    `> ${userExcerpt}`;

  _pendingCandidates.set(agentId, {
    candidate: {
      userId, agentId,
      agentName: agentName ?? '',
      userTrigger: userMessage ?? '',
      agentSummary: (assistantContent ?? '').slice(0, 400),
      toolNames,
      toolsKey: toolsetKey(toolsUsed),
      message,
    },
    createdAt: Date.now(),
  });
  return { stashed: true, agentId };
}

// Called at the START of a new turn before any LLM work. Decides what to do
// with the pending candidate (if any) from the prior turn on this agent.
// Returns the proposal record on emit, { dropped: '...' } on drop, or null
// when there was nothing to flush.
export async function flushPendingSkillCandidate({ agentId, currentUserMessage }) {
  const stash = _pendingCandidates.get(agentId);
  if (!stash) return null;
  _pendingCandidates.delete(agentId);

  if (Date.now() - stash.createdAt > CANDIDATE_TTL_MS) return { dropped: 'ttl' };

  if (CORRECTION_PHRASE_RE.test(currentUserMessage || '')) {
    return { dropped: 'correction' };
  }

  // Re-check rate limit (someone else could have proposed for this agent
  // since the candidate was stashed — but with the current single-emitter
  // setup this is mostly belt-and-suspenders).
  const last = _lastProposedPerAgent.get(agentId);
  if (last && (Date.now() - last) < RATE_LIMIT_MS) return { dropped: 'ratelimited' };

  const proposed = await proposeSkill(stash.candidate);
  if (proposed) _lastProposedPerAgent.set(agentId, Date.now());
  return proposed;
}
