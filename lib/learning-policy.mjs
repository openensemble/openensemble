// @ts-check
/**
 * Central proposal governance for OE learning.
 *
 * Detectors decide "I saw a pattern." This module decides whether that
 * pattern is allowed to become persistent behavior, what risk class it has,
 * and which negative-feedback keys should suppress related future proposals.
 */
import { isDestructiveTool, isLearnableAliasPhrase } from './learning-safety.mjs';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

export const RISK = Object.freeze({
  SAFE: 'safe',
  REVERSIBLE: 'reversible',
  TARGETED: 'targeted',
  ROUTING: 'routing',
  AUTOMATION: 'automation',
  DESTRUCTIVE: 'destructive',
});

/** @typedef {'safe'|'reversible'|'targeted'|'routing'|'automation'|'destructive'} RiskValue */

const KIND_RISK = Object.freeze({
  rule_promotion: RISK.REVERSIBLE,
  skill_proposal: RISK.AUTOMATION,
  skill_deprecation: RISK.DESTRUCTIVE,
  skill_refine: RISK.REVERSIBLE,
  routine_proposal: RISK.AUTOMATION,
  alias_proposal: RISK.TARGETED,
  location_fact: RISK.REVERSIBLE,
  default_arg: RISK.TARGETED,
  tool_failure: RISK.REVERSIBLE,
  routing_override: RISK.ROUTING,
  learned_intent: RISK.ROUTING,
  recurring_task: RISK.AUTOMATION,
  watch: RISK.AUTOMATION,
});

// Kinds we no longer emit at all. Historical records still render, and the
// boot sweep in proposals.mjs fails any still-pending card of a retired kind
// on old installs (this deny is that migration path). default_arg retired
// 2026-07-02: audited mined candidates were all agent-authored args, never a
// user preference. Accepted pins keep working via the tool-defaults merge.
export const RETIRED_PROPOSAL_KINDS = Object.freeze(new Set(['default_arg']));

const KIND_MIN_EVIDENCE = Object.freeze({
  default_arg: 4,
  routing_override: 3,
  learned_intent: 3,
  routine_proposal: 1,
  alias_proposal: 1,
  skill_proposal: 1,
  rule_promotion: 2,
});

const GENERIC_ROUTING_PATTERNS = new Set([
  'delete', 'remove', 'email', 'message', 'search', 'find', 'download',
  'send', 'open', 'close', 'list', 'create', 'update', 'check',
]);

const OUTCOME_ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_UTILITY_SCORE = 0.5;

/**
 * @param {string} reason
 * @param {RiskValue} [risk]
 * @param {Record<string, any>} [extras]
 */
function deny(reason, risk = RISK.SAFE, extras = {}) {
  return { allow: false, reason, risk, ...extras };
}

/**
 * @param {string} reason
 * @param {RiskValue} risk
 * @param {Record<string, any>} [extras]
 */
function allow(reason, risk, extras = {}) {
  return { allow: true, reason, risk, ...extras };
}

function usefulPattern(pattern) {
  const p = String(pattern || '').trim().toLowerCase();
  if (p.length < 8) return false;
  const words = p.split(/\s+/).filter(Boolean);
  if (words.length === 1 && GENERIC_ROUTING_PATTERNS.has(words[0])) return false;
  if (words.length > 8) return false;
  return true;
}

function overridesPath(userId) {
  return path.join(USERS_DIR, userId, 'learning-policy-overrides.json');
}

function proposalsPath(userId) {
  return path.join(USERS_DIR, userId, 'proposals.json');
}

// Mtime-checked parse cache. evaluateLearningProposal runs per pending
// record on EVERY UI poll, and each evaluation re-read overrides +
// proposals + proposal-outcomes (≈6 sync parses per record). One statSync
// replaces each parse; writes from this module invalidate directly, writes
// from other modules (proposals.mjs persist, outcome recorder) are caught
// by the mtime change.
const _jsonCache = new Map(); // path -> { mtimeMs, data }
function readJsonSafe(p) {
  let st;
  try { st = fs.statSync(p); } catch { _jsonCache.delete(p); return {}; }
  const hit = _jsonCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
  _jsonCache.set(p, { mtimeMs: st.mtimeMs, data });
  return data;
}

function readProposalRecords(userId) {
  if (!userId) return [];
  const data = readJsonSafe(proposalsPath(userId));
  return Array.isArray(data?.proposals) ? data.proposals : [];
}

function loadOverrides(userId) {
  if (!userId) return {};
  const data = readJsonSafe(overridesPath(userId));
  return data && typeof data === 'object' ? data : {};
}

async function saveOverrides(userId, data) {
  const p = overridesPath(userId);
  try {
    await withLock(p, () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    });
  } finally {
    // Callers mutate the object readJsonSafe returned — drop the cache entry
    // even on a failed write so it can't serve uncommitted state as current.
    _jsonCache.delete(p);
  }
}

function policyOverrideFor(userId, kind) {
  const o = loadOverrides(userId);
  return o?.kinds?.[kind] || null;
}

function storedOutcomeSummaryForKind(userId, kind) {
  if (!userId || !kind) return null;
  const p = path.join(USERS_DIR, userId, 'proposal-outcomes.json');
  const all = readJsonSafe(p);
  if (!all || typeof all !== 'object') return null;
  const cutoff = Date.now() - OUTCOME_ROLLING_WINDOW_MS;
  let measured = 0;
  let improved = 0;
  for (const rec of Object.values(all)) {
    if (!rec || rec.kind !== kind) continue;
    if ((rec.acceptedAt || 0) < cutoff) continue;
    if (rec.postCount === null || rec.postCount === undefined) continue;
    measured++;
    const semantic = rec.semantic || 'lower-better';
    const delta = rec.delta ?? 0;
    const ok = semantic === 'higher-better' ? delta >= 0 : delta <= 0;
    if (ok) improved++;
  }
  return measured ? { measured, improved } : null;
}

export function riskForProposal(record) {
  return KIND_RISK[record?.kind] || RISK.SAFE;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function roundScore(n) {
  return Math.round(clamp(n, 0.05, 0.95) * 100) / 100;
}

function canonicalValueKey(value) {
  const t = typeof value;
  if (t === 'string') return `s:${value}`;
  if (t === 'number') return `n:${value}`;
  if (t === 'boolean') return `b:${value}`;
  return `j:${JSON.stringify(value)}`;
}

function valueDistinctivenessScore(userId, record) {
  if (record?.kind !== 'default_arg') return 0.55;
  const t = typeof record.value;
  if (t === 'boolean') return 0.05;
  if (t !== 'string' && t !== 'number') return 0.2;
  if (!userId || !record.tool || !record.arg) return 0.5;
  const counts = readJsonSafe(path.join(USERS_DIR, userId, 'tool-arg-counts.json'));
  const buckets = counts?.[`${record.tool}.${record.arg}`];
  if (!buckets || typeof buckets !== 'object') return 0.55;
  const entries = Object.entries(buckets).filter(([, arr]) => Array.isArray(arr) && arr.length);
  if (!entries.length) return 0.55;
  const own = buckets[canonicalValueKey(record.value)];
  const ownCount = Array.isArray(own) ? own.length : Number(record.evidenceCount ?? record.count ?? 0);
  const total = entries.reduce((sum, [, arr]) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  const dominance = total > 0 ? ownCount / total : 0;
  if (entries.length === 1) return clamp(0.65 + dominance * 0.2, 0.65, 0.85);
  if (dominance >= 0.8) return 0.55;
  if (dominance >= 0.6) return 0.4;
  return 0.2;
}

export function targetKeyForProposal(record) {
  if (!record?.kind) return null;
  if (record.kind === 'default_arg' && record.tool && record.arg) return `default:${record.tool}.${record.arg}`;
  if (record.kind === 'watch') {
    if (record.watchSourceKey) return `watch:${record.watchSourceKey}`;
    if (record.matched) return `watch:${String(record.matched).toLowerCase().trim()}`;
  }
  if (record.kind === 'rule_promotion' && record.ruleText) return `rule:${String(record.ruleText).toLowerCase().trim()}`;
  if (record.kind === 'routine_proposal' && record.trigger) return `routine:${String(record.trigger).toLowerCase().trim()}`;
  if (record.kind === 'alias_proposal' && record.phrase) return `alias:${String(record.phrase).toLowerCase().trim()}`;
  if (record.kind === 'location_fact' && record.hostname && record.foundPath) return `locfact:${record.hostname}:${record.foundPath}`;
  if (record.kind === 'tool_failure' && record.tool) return `failure:${record.tool}`;
  if (record.kind === 'routing_override' && record.correctedAgent && record.pattern) return `routing:${record.correctedAgent}:${record.pattern}`;
  if (record.kind === 'learned_intent' && record.skillId && record.intentId) return `learned:${record.skillId}:${record.intentId}`;
  if (record.kind === 'skill_proposal' && record.toolsKey) return `tools:${record.toolsKey}`;
  if (record.kind === 'skill_deprecation' && record.skillId) return `deprecate:${record.skillId}`;
  if (record.kind === 'skill_refine' && record.skillId) return `refine:${record.skillId}`;
  return null;
}

export function proposalFeedbackSummary(userId, { kind = null, targetKey = null, windowMs = OUTCOME_ROLLING_WINDOW_MS } = {}) {
  const cutoff = Date.now() - windowMs;
  const out = { total: 0, accepted: 0, dismissed: 0, blocked: 0, pending: 0 };
  for (const rec of readProposalRecords(userId)) {
    if (kind && rec.kind !== kind) continue;
    if (targetKey && targetKeyForProposal(rec) !== targetKey) continue;
    const ts = rec.createdAt || rec.dismissedAt || rec.endedAt || 0;
    if (ts && ts < cutoff) continue;
    if (rec.status === 'accepted') out.accepted++;
    else if (rec.status === 'dismissed' && rec.blocked) out.blocked++;
    else if (rec.status === 'dismissed') out.dismissed++;
    else if (rec.status === 'pending' || rec.status === 'snoozed' || rec.status === 'running') out.pending++;
    else continue;
    out.total++;
  }
  return out;
}

export function scoreForProposal(record, { userId = record?.userId, evidenceCount = null, minEvidence = null } = {}) {
  if (!record?.kind) return { score: null, parts: null };
  const ev = Number(evidenceCount ?? record.evidenceCount ?? record.count ?? 1);
  const min = Number(minEvidence ?? evidenceRequirementForProposal(userId, record) ?? 1);
  const evidenceRatio = min > 0 ? ev / min : 1;
  const evidenceScore = clamp(0.45 + Math.min(0.25, evidenceRatio * 0.2) + Math.max(0, ev - min) * 0.05, 0.25, 0.9);

  const kindHistory = proposalFeedbackSummary(userId, { kind: record.kind });
  const judged = kindHistory.accepted + kindHistory.dismissed + kindHistory.blocked;
  const historyScore = judged > 0
    ? (kindHistory.accepted + 1) / (kindHistory.accepted + kindHistory.dismissed + (kindHistory.blocked * 2) + 2)
    : 0.5;

  const targetKey = targetKeyForProposal(record);
  const targetHistory = targetKey ? proposalFeedbackSummary(userId, { targetKey }) : null;
  const targetDismisses = (targetHistory?.dismissed || 0) + (targetHistory?.blocked || 0) * 2;
  const targetPenalty = Math.min(0.4, targetDismisses * 0.18);
  const valueScore = valueDistinctivenessScore(userId, record);
  const score = roundScore((evidenceScore * 0.42) + (historyScore * 0.33) + (valueScore * 0.25) - targetPenalty);
  return {
    score,
    parts: {
      evidence: roundScore(evidenceScore),
      history: roundScore(historyScore),
      value: roundScore(valueScore),
      targetDismisses,
    },
  };
}

export function confidenceForProposal(record, opts = {}) {
  return scoreForProposal(record, opts).score;
}

export function evidenceRequirementForProposal(userId, record) {
  const kind = record?.kind;
  let min = KIND_MIN_EVIDENCE[kind] ?? 1;
  const risk = riskForProposal(record);
  if (risk === RISK.ROUTING) min = Math.max(min, 3);
  if (risk === RISK.DESTRUCTIVE) min = Math.max(min, 5);

  try {
    const summary = storedOutcomeSummaryForKind(userId, kind);
    if (summary?.measured >= 3) {
      const rate = summary.measured > 0 ? summary.improved / summary.measured : 0;
      if (rate < 0.5) min += 2;
      else if (rate >= 0.85) min = Math.max(1, min - 1);
    }
  } catch {
    // Outcome data is advisory; never fail policy evaluation because stats are unreadable.
  }

  const override = policyOverrideFor(userId, kind);
  if (Number.isFinite(override?.minEvidence)) {
    min = Math.max(1, Math.floor(override.minEvidence));
  }
  return min;
}

export function dryRunPreviewForProposal(record) {
  if (!record?.kind) return null;
  if (record.kind === 'default_arg') {
    return {
      effect: 'fills_missing_tool_arg',
      tool: record.tool || null,
      arg: record.arg || null,
      value: record.value,
      userArgsOverride: true,
    };
  }
  if (record.kind === 'routing_override') {
    return {
      effect: 'force_route_on_contains_match',
      pattern: record.pattern || null,
      forcedAgent: record.correctedAgent || null,
      examples: Array.isArray(record.examples) ? record.examples.slice(0, 3) : [],
    };
  }
  if (record.kind === 'learned_intent') {
    return {
      effect: 'add_local_utterance_match',
      skillId: record.skillId || null,
      intentId: record.intentId || null,
      tool: record.tool || null,
      confirm: record.confirm === true,
      utterances: Array.isArray(record.utterances) ? record.utterances.slice(0, 5) : [],
    };
  }
  if (record.kind === 'routine_proposal') {
    return {
      effect: 'bind_phrase_to_action',
      trigger: record.trigger || null,
      service: record.service || null,
      entityId: record.entityId || null,
    };
  }
  if (record.kind === 'alias_proposal') {
    return {
      effect: 'bind_phrase_to_entity',
      phrase: record.phrase || null,
      entityId: record.entityId || null,
    };
  }
  return null;
}

export function evaluateLearningProposal(record, { userId = record?.userId } = {}) {
  const kind = record?.kind;
  const risk = riskForProposal(record);
  if (!kind) return deny('missing-kind', risk);
  if (RETIRED_PROPOSAL_KINDS.has(kind)) return deny('kind-retired', risk);

  const override = policyOverrideFor(userId, kind);
  const allOverrides = loadOverrides(userId);
  if (allOverrides?.enabled === false) return deny('learning-disabled-by-user-policy', risk);
  if (override?.enabled === false) return deny('kind-disabled-by-user-policy', risk);

  const minEvidence = evidenceRequirementForProposal(userId, record);
  const evidenceCount = Number(record?.evidenceCount ?? record?.count ?? 1);
  const scored = scoreForProposal(record, { userId, evidenceCount, minEvidence });
  if (evidenceCount < minEvidence) {
    return deny('insufficient-evidence', risk, {
      confidence: scored.score,
      utilityScore: scored.score,
      scoreParts: scored.parts,
      evidenceCount,
      minEvidence,
      preview: dryRunPreviewForProposal(record),
    });
  }

  if (kind === 'alias_proposal') {
    if (!isLearnableAliasPhrase(record.phrase)) return deny('unsafe-alias-phrase', risk);
  }

  if (kind === 'routine_proposal') {
    if (!isLearnableAliasPhrase(record.trigger)) return deny('unsafe-routine-trigger', risk);
    if (!record.entityId || !record.service) return deny('missing-routine-target', risk);
  }

  if (kind === 'routing_override') {
    if (!usefulPattern(record.pattern)) return deny('unsafe-routing-pattern', risk);
    if (!record.correctedAgent) return deny('missing-routing-agent', risk);
  }

  if (kind === 'learned_intent') {
    if (!Array.isArray(record.utterances) || record.utterances.length === 0) {
      return deny('missing-learned-utterances', risk);
    }
    if (isDestructiveTool(record.tool) && record.confirm !== true) {
      return deny('destructive-local-intent-requires-confirm', RISK.DESTRUCTIVE);
    }
    if (isDestructiveTool(record.tool) && record.confirm === true) {
      return allow('allowed-confirmed-destructive', RISK.DESTRUCTIVE, {
        confidence: scored.score,
        utilityScore: scored.score,
        scoreParts: scored.parts,
        evidenceCount,
        minEvidence,
        preview: dryRunPreviewForProposal(record),
      });
    }
  }

  if (kind === 'skill_deprecation') {
    if (!record.skillId) return deny('missing-skill-id', risk);
  }

  if (Number.isFinite(scored.score) && scored.score < MIN_UTILITY_SCORE) {
    return deny('low-utility-score', risk, {
      confidence: scored.score,
      utilityScore: scored.score,
      scoreParts: scored.parts,
      evidenceCount,
      minEvidence,
      preview: dryRunPreviewForProposal(record),
    });
  }

  return allow('allowed', risk, {
    confidence: scored.score,
    utilityScore: scored.score,
    scoreParts: scored.parts,
    evidenceCount,
    minEvidence,
    preview: dryRunPreviewForProposal(record),
  });
}

export function listLearningPolicy(userId) {
  return loadOverrides(userId);
}

export async function setLearningKindPolicy(userId, kind, patch = {}) {
  if (!userId || !kind) return { ok: false, error: 'bad args' };
  const all = loadOverrides(userId);
  if (!all.kinds || typeof all.kinds !== 'object') all.kinds = {};
  const next = { ...(all.kinds[kind] || {}) };
  if ('enabled' in patch) next.enabled = patch.enabled !== false;
  if ('minEvidence' in patch) {
    const n = Number(patch.minEvidence);
    if (!Number.isFinite(n) || n < 1 || n > 50) return { ok: false, error: 'minEvidence must be 1..50' };
    next.minEvidence = Math.floor(n);
  }
  next.updatedAt = Date.now();
  all.kinds[kind] = next;
  await saveOverrides(userId, all);
  return { ok: true, policy: next };
}

export async function setLearningPolicy(userId, patch = {}) {
  if (!userId) return { ok: false, error: 'bad args' };
  const all = loadOverrides(userId);
  if ('enabled' in patch) all.enabled = patch.enabled !== false;
  all.updatedAt = Date.now();
  await saveOverrides(userId, all);
  return { ok: true, policy: all };
}

export async function clearLearningPolicy(userId) {
  if (!userId) return { ok: false, error: 'bad args' };
  const all = loadOverrides(userId);
  if (Object.prototype.hasOwnProperty.call(all, 'enabled')) {
    delete all.enabled;
    all.updatedAt = Date.now();
    await saveOverrides(userId, all);
  }
  return { ok: true };
}

export async function clearLearningKindPolicy(userId, kind) {
  if (!userId || !kind) return { ok: false, error: 'bad args' };
  const all = loadOverrides(userId);
  if (all.kinds && Object.prototype.hasOwnProperty.call(all.kinds, kind)) {
    delete all.kinds[kind];
    await saveOverrides(userId, all);
  }
  return { ok: true };
}

export function relatedFeedbackKeys(record) {
  const out = [];
  if (!record) return out;
  if (record.kind === 'default_arg') {
    if (record.tool && record.arg) out.push(`default:${record.tool}.${record.arg}`);
    if (record.tool) out.push(`default-tool:${record.tool}`);
    if (record.arg) out.push(`default-arg:${record.arg}`);
  } else if (record.kind === 'watch') {
    if (record.watchSourceKey) out.push(`watch:${record.watchSourceKey}`);
    else if (record.matched) out.push(`watch:${String(record.matched).toLowerCase().trim()}`);
  } else if (record.kind === 'alias_proposal') {
    if (record.phrase) out.push(`alias:${record.phrase}`);
    if (record.entityId) out.push(`alias-entity:${record.entityId}`);
  } else if (record.kind === 'routing_override') {
    if (record.correctedAgent && record.pattern) out.push(`routing:${record.correctedAgent}:${record.pattern}`);
    if (record.correctedAgent) out.push(`routing-agent:${record.correctedAgent}`);
  } else if (record.kind === 'learned_intent') {
    if (record.skillId && record.intentId) out.push(`learned:${record.skillId}:${record.intentId}`);
    if (record.tool) out.push(`learned-tool:${record.tool}`);
  }
  return [...new Set(out)];
}
