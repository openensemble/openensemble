// @ts-check
/**
 * Central proposal governance for OE learning.
 *
 * Detectors decide "I saw a pattern." This module decides whether that
 * pattern is allowed to become persistent behavior, what risk class it has,
 * and which negative-feedback keys should suppress related future proposals.
 */
import { isDefaultArgNoise, isDestructiveTool, isLearnableAliasPhrase } from './learning-safety.mjs';
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

const KIND_CONFIDENCE = Object.freeze({
  rule_promotion: 0.72,
  skill_proposal: 0.58,
  skill_deprecation: 0.66,
  skill_refine: 0.68,
  routine_proposal: 0.62,
  alias_proposal: 0.7,
  location_fact: 0.76,
  default_arg: 0.64,
  tool_failure: 0.6,
  routing_override: 0.58,
  learned_intent: 0.62,
  recurring_task: 0.56,
  watch: 0.56,
});

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

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function loadOverrides(userId) {
  if (!userId) return {};
  const data = readJsonSafe(overridesPath(userId));
  return data && typeof data === 'object' ? data : {};
}

async function saveOverrides(userId, data) {
  const p = overridesPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  });
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

export function confidenceForProposal(record) {
  return KIND_CONFIDENCE[record?.kind] ?? 0.5;
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

  const override = policyOverrideFor(userId, kind);
  if (override?.enabled === false) return deny('kind-disabled-by-user-policy', risk);

  const minEvidence = evidenceRequirementForProposal(userId, record);
  const evidenceCount = Number(record?.evidenceCount ?? record?.count ?? 1);
  if (evidenceCount < minEvidence) {
    return deny('insufficient-evidence', risk, {
      confidence: confidenceForProposal(record),
      evidenceCount,
      minEvidence,
      preview: dryRunPreviewForProposal(record),
    });
  }

  if (kind === 'default_arg') {
    if (isDefaultArgNoise(record.tool, record.arg, record.value)) {
      return deny('unsafe-default-arg', risk);
    }
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
        confidence: confidenceForProposal(record),
        evidenceCount,
        minEvidence,
        preview: dryRunPreviewForProposal(record),
      });
    }
  }

  if (kind === 'skill_deprecation') {
    if (!record.skillId) return deny('missing-skill-id', risk);
  }

  return allow('allowed', risk, {
    confidence: confidenceForProposal(record),
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
