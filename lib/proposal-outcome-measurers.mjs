// @ts-check
/**
 * Per-kind outcome measurers — each returns a richer signal than the coarse
 * "proposals emitted in window" fallback. proposal-outcomes.mjs dispatches
 * here first by kind; falls back to the coarse count if no measurer is
 * registered (or if a measurer returns null).
 *
 * Measurer contract:
 *   (userId, proposal) => null                      // not measurable
 *     | { preCount, postCount, delta,               // raw numbers
 *         semantic: 'lower-better'|'higher-better', // arrow direction for UI
 *         note?: string }                           // tooltip label
 *
 * The 7d post window is enforced by the caller — measurers only run AFTER
 * (acceptedAt + POST_WINDOW_MS) has elapsed, so they can do clean count-in-
 * range queries without checking elapsed time themselves.
 */
import { loadFailures } from './tool-failures.mjs';
import { loadPinEvents } from './tool-defaults.mjs';
import { countCorrectionsInWindow } from './correction-events.mjs';
import { countInvocationsInWindow } from './invocation-events.mjs';
import { countFiresInWindow } from './routine-fires.mjs';
import { countFiresForOverride } from './routing-overrides.mjs';
import { countAliasHitsInWindow } from './alias-hits.mjs';
import { countDeadPathProbes } from './node-exec-paths.mjs';

const POST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function _toolFailureMeasurer(userId, p) {
  if (!p.tool || !p.acceptedAt) return null;
  const all = loadFailures(userId)[p.tool];
  if (!all || !Array.isArray(all.msgs)) return null;
  const accAt = p.acceptedAt;
  const pre  = all.msgs.filter(m => m.ts >= accAt - POST_WINDOW_MS && m.ts < accAt).length;
  const post = all.msgs.filter(m => m.ts >= accAt && m.ts < accAt + POST_WINDOW_MS).length;
  return {
    preCount: pre,
    postCount: post,
    delta: post - pre,
    semantic: 'lower-better',
    note: `failures of \`${p.tool}\``,
  };
}

function _rulePromotionMeasurer(userId, p) {
  if (!p.agentId || !p.acceptedAt) return null;
  const accAt = p.acceptedAt;
  const pre  = countCorrectionsInWindow(userId, { agentId: p.agentId }, accAt - POST_WINDOW_MS, accAt);
  const post = countCorrectionsInWindow(userId, { agentId: p.agentId }, accAt, accAt + POST_WINDOW_MS);
  return {
    preCount: pre,
    postCount: post,
    delta: post - pre,
    semantic: 'lower-better',
    note: 'corrections to this agent',
  };
}

function _skillRefineMeasurer(userId, p) {
  if (!p.skillId || !p.acceptedAt) return null;
  const accAt = p.acceptedAt;
  const pre  = countCorrectionsInWindow(userId, { skillId: p.skillId }, accAt - POST_WINDOW_MS, accAt);
  const post = countCorrectionsInWindow(userId, { skillId: p.skillId }, accAt, accAt + POST_WINDOW_MS);
  return {
    preCount: pre,
    postCount: post,
    delta: post - pre,
    semantic: 'lower-better',
    note: `corrections to \`${p.skillId}\``,
  };
}

function _skillProposalMeasurer(userId, p) {
  // newSkillId is patched onto the outcome record by runSkillProposal after
  // the skill is built. If the accept path never set it (skill creation
  // failed), we can't measure — return null.
  if (!p.newSkillId || !p.acceptedAt) return null;
  const accAt = p.acceptedAt;
  const post = countInvocationsInWindow(userId, { skillId: p.newSkillId }, accAt, accAt + POST_WINDOW_MS);
  return {
    preCount: 0,              // by definition: the skill didn't exist pre
    postCount: post,
    delta: post,              // raw count; "higher" means the new skill is being used
    semantic: 'higher-better',
    note: `invocations of \`${p.newSkillId}\``,
  };
}

function _routineProposalMeasurer(userId, p) {
  if (!p.routineId || !p.acceptedAt) return null;
  const accAt = p.acceptedAt;
  const post = countFiresInWindow(userId, p.routineId, accAt, accAt + POST_WINDOW_MS);
  return {
    preCount: 0,              // routine didn't exist pre
    postCount: post,
    delta: post,
    semantic: 'higher-better',
    note: `fast-path fires of \`${p.routineId}\``,
  };
}

function _locationFactMeasurer(userId, p) {
  if (!p.hostname || !p.failedPath || !p.acceptedAt) return null;
  const accAt = p.acceptedAt;
  const post = countDeadPathProbes(userId, p.hostname, p.failedPath, accAt, accAt + POST_WINDOW_MS);
  return {
    preCount: 0,
    postCount: post,
    delta: post,
    semantic: 'lower-better',
    note: `re-probes of dead path \`${p.failedPath}\``,
  };
}

function _aliasProposalMeasurer(userId, p) {
  if (!p.phrase || !p.acceptedAt) return null;
  const accAt = p.acceptedAt;
  const post = countAliasHitsInWindow(userId, p.phrase, accAt, accAt + POST_WINDOW_MS);
  return {
    preCount: 0,
    postCount: post,
    delta: post,
    semantic: 'higher-better',
    note: `times \`${p.phrase}\` resolved via fast-path`,
  };
}

function _routingOverrideMeasurer(userId, p) {
  if (!p.overrideId || !p.acceptedAt) return null;
  const accAt = p.acceptedAt;
  const post = countFiresForOverride(userId, p.overrideId, accAt, accAt + POST_WINDOW_MS);
  return {
    preCount: 0,
    postCount: post,
    delta: post,
    semantic: 'higher-better',
    note: `times the override fired`,
  };
}

function _defaultArgMeasurer(userId, p) {
  if (!p.tool || !p.arg || !p.acceptedAt) return null;
  const accAt = p.acceptedAt;
  const events = loadPinEvents(userId)
    .filter(e => e.tool === p.tool && e.arg === p.arg && e.ts >= accAt && e.ts < accAt + POST_WINDOW_MS);
  // preCount = 0 by convention (pin didn't exist before accept; the
  // proposal's `count` field is the raw observation count of the value
  // being supplied, but it isn't a comparable "override" measurement).
  const overrides = events.filter(e => e.kind === 'override').length;
  return {
    preCount: 0,
    postCount: overrides,
    delta: overrides,
    semantic: 'lower-better',
    note: `times you overrode the pinned value`,
  };
}

const MEASURERS = {
  tool_failure:     _toolFailureMeasurer,
  rule_promotion:   _rulePromotionMeasurer,
  skill_refine:     _skillRefineMeasurer,
  default_arg:      _defaultArgMeasurer,
  skill_proposal:   _skillProposalMeasurer,
  routine_proposal: _routineProposalMeasurer,
  routing_override: _routingOverrideMeasurer,
  alias_proposal:   _aliasProposalMeasurer,
  location_fact:    _locationFactMeasurer,
  // Intentionally absent: skill_deprecation (skill deleted — no signal),
  // watch, recurring_task. Those fall back to the coarse count for now.
};

/**
 * Dispatch — returns the per-kind measurement or null if no measurer is
 * registered for this kind (caller should fall back to the coarse signal).
 */
export function measureProposalOutcome(userId, proposal) {
  if (!proposal?.kind) return null;
  const fn = MEASURERS[proposal.kind];
  if (!fn) return null;
  try {
    return fn(userId, proposal);
  } catch (e) {
    console.warn(`[outcome-measurers] ${proposal.kind} measurer threw:`, e.message);
    return null;
  }
}

export function hasMeasurer(kind) {
  return !!MEASURERS[kind];
}
