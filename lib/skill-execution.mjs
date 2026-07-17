// @ts-check
/**
 * Resolve a turn's per-skill execution profile without mutating its base agent.
 *
 * Priority per selected skill:
 *   1. User pin (skill-overrides.json execution)
 *   2. Manifest execution_hint (portable tier/effort) → catalog model
 *   3. Structural score of the skill tools/manifest → tier/effort → catalog
 *   4. Task-shape effort prior (routeText) when no skill supplies effort
 *
 * Only skill ids explicitly selected by the turn router are considered. Merely
 * carrying a skill's tools is not enough to activate its model. Provider/model
 * always travel as one atomic pair. When several selected skills contribute,
 * the model pair belonging to the strongest rank among pair-bearing candidates
 * wins; ties preserve the router's selected-skill order. Effort is selected
 * independently across every eligible entry (including effort-only).
 */

import { loadSkillOverrides, normalizeSkillExecution } from './skill-overrides.mjs';
import {
  EFFORT_RANK,
  TIER_RANK,
  normalizeExecutionHint,
  pickModelFromCatalog,
  scoreSkillStructure,
  taskShapeEffort,
} from './execution-auto.mjs';

export { EFFORT_RANK } from './execution-auto.mjs';

/** Narrow structural/capability gate for models used by chat execution routes. */
export function isExecutionTextModel(provider, model) {
  if (typeof provider !== 'string' || typeof model !== 'string'
      || !provider || !model
      || provider !== provider.trim() || model !== model.trim()
      || provider.length > 100 || model.length > 300
      || /[\x00-\x1f\x7f]/.test(provider) || /[\x00-\x1f\x7f]/.test(model)) {
    return false;
  }
  const normalizedProvider = provider.toLowerCase();
  if (normalizedProvider === 'fireworks') return false;
  if ((normalizedProvider === 'grok' || normalizedProvider === 'xai')
      && /^grok-imagine-(?:image|video)/i.test(model)) return false;
  return true;
}

function executionShape(agent) {
  /** @type {{provider: any, model: any, reasoningEffort?: any}} */
  const shape = {
    provider: agent?.provider ?? null,
    model: agent?.model ?? null,
  };
  if (agent && Object.hasOwn(agent, 'reasoningEffort')) shape.reasoningEffort = agent.reasoningEffort;
  return shape;
}

function uniqueSkillIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const skillId = raw.trim();
    if (!skillId || seen.has(skillId)) continue;
    seen.add(skillId);
    out.push(skillId);
  }
  return out;
}

function isAllowedModel(model, allowedModels) {
  return !Array.isArray(allowedModels) || allowedModels.includes(model);
}

/**
 * Rank used for multi-skill arbitration. Explicit effort wins the scale;
 * otherwise portable tier supplies a comparable rank.
 */
function candidateRank(candidate) {
  if (typeof candidate.effortRank === 'number' && candidate.effortRank >= 0) return candidate.effortRank;
  if (candidate.tier && TIER_RANK[candidate.tier] != null) return TIER_RANK[candidate.tier];
  return -1;
}

function strongerCandidate(candidate, current) {
  if (!current) return true;
  const a = candidateRank(candidate);
  const b = candidateRank(current);
  if (a !== b) return a > b;
  return candidate.selectedIndex < current.selectedIndex;
}

/**
 * @param {object} args
 * @param {string} [args.userId]
 * @param {object} args.baseAgent
 * @param {string[]} [args.selectedSkillIds]
 * @param {string[]|null} [args.allowedModels]
 * @param {Map|null} [args.modelAccess]
 * @param {Record<string, object>|null} [args.autoCandidates]
 * @param {string|null} [args.routeText]
 */
export function resolveSkillExecutionForTurn({
  userId,
  baseAgent,
  selectedSkillIds,
  allowedModels = null,
  modelAccess = null,
  autoCandidates = null,
  routeText = null,
}) {
  const baseline = executionShape(baseAgent);
  const effective = { ...baseline };
  const selected = uniqueSkillIds(selectedSkillIds);
  const sourceSkillIds = { model: null, reasoningEffort: null };
  const sourceKinds = { model: null, reasoningEffort: null };

  const all = userId ? loadSkillOverrides(userId) : {};
  /** @type {any[]} */
  const contenders = [];
  /** @type {any|null} */
  let modelWinner = null;
  /** @type {any|null} */
  let effortWinner = null;

  /**
   * @param {any} candidate
   */
  function consider(candidate) {
    contenders.push(candidate);
    if (!candidate.eligible) return;
    const hasModelPair = Object.hasOwn(candidate, 'provider') && Object.hasOwn(candidate, 'model');
    const hasExplicitEffort = Object.hasOwn(candidate, 'reasoningEffort');
    if (hasModelPair && strongerCandidate(candidate, modelWinner)) modelWinner = candidate;
    if (hasExplicitEffort && strongerCandidate(candidate, effortWinner)) effortWinner = candidate;
  }

  for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex++) {
    const skillId = selected[selectedIndex];
    const rawExecution = all?.[skillId]?.execution;
    let userEligible = false;

    if (rawExecution != null) {
      const execution = normalizeSkillExecution(rawExecution);
      if (!execution) {
        consider({
          skillId, selectedIndex, source: 'user', eligible: false,
          reason: 'invalid-execution-override', effortRank: -1,
        });
      } else {
        const hasModelPair = Object.hasOwn(execution, 'provider') && Object.hasOwn(execution, 'model');
        const hasExplicitEffort = Object.hasOwn(execution, 'reasoningEffort');
        const effortRank = hasExplicitEffort ? EFFORT_RANK[execution.reasoningEffort] : -1;
        const allowedByAccount = !hasModelPair || isAllowedModel(execution.model, allowedModels);
        const access = hasModelPair && modelAccess instanceof Map
          ? modelAccess.get(`${execution.provider}\0${execution.model}`)
          : null;
        const eligible = !hasModelPair || (allowedByAccount && access?.ok !== false);
        userEligible = eligible;
        consider({
          skillId, selectedIndex, source: 'user',
          ...(hasModelPair ? { provider: execution.provider, model: execution.model } : {}),
          ...(hasExplicitEffort ? { reasoningEffort: execution.reasoningEffort } : {}),
          effortRank, eligible,
          reason: eligible
            ? 'eligible'
            : (!allowedByAccount ? 'model-not-allowed' : access?.reason || 'model-unavailable'),
        });
      }
    }

    // Auto path only when there is no eligible user pin for this skill.
    if (userEligible) continue;
    const auto = autoCandidates && typeof autoCandidates === 'object'
      ? autoCandidates[skillId]
      : null;
    if (!auto || typeof auto !== 'object') continue;

    const hasModelPair = typeof auto.provider === 'string' && typeof auto.model === 'string'
      && auto.provider && auto.model;
    const hasExplicitEffort = typeof auto.reasoningEffort === 'string' && auto.reasoningEffort;
    if (!hasModelPair && !hasExplicitEffort) continue;

    const effortRank = hasExplicitEffort
      ? (EFFORT_RANK[auto.reasoningEffort] ?? -1)
      : (auto.tier && TIER_RANK[auto.tier] != null ? TIER_RANK[auto.tier] : -1);
    const allowedByAccount = !hasModelPair || isAllowedModel(auto.model, allowedModels);
    const access = hasModelPair && modelAccess instanceof Map
      ? modelAccess.get(`${auto.provider}\0${auto.model}`)
      : null;
    const eligible = !hasModelPair || (allowedByAccount && access?.ok !== false);
    consider({
      skillId, selectedIndex,
      source: auto.source || 'auto',
      tier: auto.tier || null,
      ...(hasModelPair ? { provider: auto.provider, model: auto.model } : {}),
      ...(hasExplicitEffort ? { reasoningEffort: auto.reasoningEffort } : {}),
      effortRank, eligible,
      reason: eligible
        ? (auto.reason || 'auto-eligible')
        : (!allowedByAccount ? 'model-not-allowed' : access?.reason || 'model-unavailable'),
    });
  }

  // Task-shape prior fills effort only when no skill contributed effort.
  const prior = taskShapeEffort(routeText);
  if (prior && !effortWinner) {
    consider({
      skillId: '_task',
      selectedIndex: selected.length,
      source: 'task',
      reasoningEffort: prior,
      effortRank: EFFORT_RANK[prior] ?? -1,
      eligible: true,
      reason: 'task-shape-prior',
    });
  }

  if (!modelWinner && !effortWinner) {
    const reason = contenders.some(candidate => candidate.reason === 'model-not-allowed')
      ? 'no-allowed-execution-overrides'
      : (selected.length ? 'no-execution-overrides' : 'no-selected-skills');
    return {
      baseline, effective, sourceSkillIds, sourceKinds, contenders, reason,
      applied: false, reasoningEffortInherited: true,
    };
  }

  if (modelWinner) {
    effective.provider = modelWinner.provider;
    effective.model = modelWinner.model;
    sourceSkillIds.model = modelWinner.skillId === '_task' ? null : modelWinner.skillId;
    sourceKinds.model = modelWinner.source || 'user';
  }
  if (effortWinner) {
    effective.reasoningEffort = effortWinner.reasoningEffort;
    sourceSkillIds.reasoningEffort = effortWinner.skillId === '_task' ? null : effortWinner.skillId;
    sourceKinds.reasoningEffort = effortWinner.source || 'user';
  }

  const modelChanged = Boolean(modelWinner)
    && (effective.provider !== baseline.provider || effective.model !== baseline.model);
  const effortChanged = Boolean(effortWinner)
    && effective.reasoningEffort !== baseline.reasoningEffort;
  // Explicit user effort pins still count as applied even when they match the
  // baseline value (the user chose a fixed policy). Auto sources only apply
  // when they change the frozen profile.
  const userEffortPin = Boolean(effortWinner) && effortWinner?.source === 'user';
  const applied = modelChanged || effortChanged || userEffortPin;

  let reason = 'no-execution-overrides';
  if (applied || modelWinner || effortWinner) {
    const kinds = [sourceKinds.model, sourceKinds.reasoningEffort].filter(Boolean);
    reason = kinds.every(k => k === 'user') || kinds.includes('user')
      ? 'selected-skill-execution'
      : 'auto-skill-execution';
    if (kinds.includes('user') && kinds.some(k => k && k !== 'user')) {
      reason = 'selected-skill-execution';
    }
  }

  return {
    baseline, effective, sourceSkillIds, sourceKinds, contenders,
    reason: (!modelWinner && !effortWinner)
      ? (contenders.some(c => c.reason === 'model-not-allowed')
        ? 'no-allowed-execution-overrides'
        : (selected.length ? 'no-execution-overrides' : 'no-selected-skills'))
      : reason,
    applied,
    reasoningEffortInherited: effortWinner === null,
  };
}

/**
 * Build auto candidates for skills that lack an eligible user pin.
 * Pure of network when resolveTier is injected; production supplies catalog lookup.
 *
 * @param {object} args
 * @param {string[]} args.selectedSkillIds
 * @param {object} args.baseAgent
 * @param {(skillId: string) => any} args.getManifest
 * @param {(tier: string, baseAgent: object) => Promise<{provider: string, model: string}|null>} args.resolveTier
 */
export async function buildAutoExecutionCandidates({
  selectedSkillIds,
  baseAgent,
  getManifest,
  resolveTier,
}) {
  /** @type {Record<string, object>} */
  const out = {};
  const selected = uniqueSkillIds(selectedSkillIds);
  for (const skillId of selected) {
    let manifest = null;
    try { manifest = getManifest(skillId); } catch { manifest = null; }
    const hint = normalizeExecutionHint(manifest?.execution_hint);
    const structure = scoreSkillStructure(manifest || { id: skillId, tools: [] });
    const tier = hint?.tier || structure.tier;
    const effort = hint?.effort || structure.effort;
    const source = hint ? 'hint' : 'structure';

    /** @type {object} */
    const candidate = {
      source,
      tier,
      reasoningEffort: effort,
      reason: hint ? 'manifest-execution-hint' : `structure-score:${structure.score}`,
      structureScore: structure.score,
      structureReasons: structure.reasons,
    };

    // standard tier keeps the agent model (effort-only auto is still useful).
    if (tier && tier !== 'standard' && typeof resolveTier === 'function') {
      try {
        const pair = await resolveTier(tier, baseAgent);
        if (pair?.provider && pair?.model) {
          candidate.provider = pair.provider;
          candidate.model = pair.model;
        }
      } catch { /* inherit model */ }
    }
    out[skillId] = candidate;
  }
  return out;
}

/**
 * Map a portable tier to a concrete provider/model using the account catalog.
 * Prefers the base agent's provider; fails closed to null (inherit).
 */
export async function resolveTierToModelPair(userId, baseAgent, tier, allowedModels = null) {
  if (!tier || tier === 'standard') return null;
  const policy = await import('./execution-model-policy.mjs');
  let compatProviders = {};
  try {
    const shared = await import('../chat/providers/_shared.mjs');
    compatProviders = shared.OPENAI_COMPAT_PROVIDERS || {};
  } catch { /* optional */ }

  const preferred = typeof baseAgent?.provider === 'string' ? baseAgent.provider : null;
  /** @type {string[]} */
  const providers = [];
  if (preferred) providers.push(preferred);
  for (const id of [
    'openai-oauth', 'xai-oauth', 'anthropic', 'openrouter', 'grok', 'xai',
    'openai', 'gemini', 'deepseek', 'mistral', 'groq', 'together',
    'ollama', 'lmstudio', 'perplexity',
    ...Object.keys(compatProviders),
  ]) {
    if (!providers.includes(id)) providers.push(id);
  }

  for (const provider of providers) {
    if (!policy.canUseExecutionProvider(userId, provider).ok) continue;
    const catalog = await policy.listExecutionCatalog(userId, provider);
    if (!catalog.length) continue;
    const filtered = Array.isArray(allowedModels)
      ? catalog.filter(m => allowedModels.includes(m))
      : catalog;
    if (!filtered.length) continue;
    const model = pickModelFromCatalog(filtered, tier, {
      preferModel: provider === preferred ? baseAgent?.model : null,
    });
    if (!model || !isExecutionTextModel(provider, model)) continue;
    // Same pair as the baseline is a no-op — keep looking (e.g. another provider)
    // only when this pick is identical; otherwise accept the catalog choice.
    if (provider === baseAgent?.provider && model === baseAgent?.model) continue;
    const access = await policy.validateExecutionModelAccess(userId, provider, model);
    if (!access.ok) continue;
    return { provider, model };
  }
  return null;
}

/**
 * Runtime entrypoint. Saved profiles and auto-resolved pairs are rechecked
 * against the live catalog before a turn uses them.
 */
export async function resolveValidatedSkillExecutionForTurn(args) {
  const selected = uniqueSkillIds(args?.selectedSkillIds);
  const routeText = typeof args?.routeText === 'string' ? args.routeText : null;

  // Even with no selected skills, a task-shape effort prior may still apply.
  if (!selected.length) {
    return resolveSkillExecutionForTurn({ ...args, routeText, autoCandidates: null });
  }

  const all = loadSkillOverrides(args?.userId);
  /** @type {Array<{skillId: string, execution: any}>} */
  const userExecutions = [];
  for (const skillId of selected) {
    const execution = normalizeSkillExecution(all?.[skillId]?.execution);
    if (execution) userExecutions.push({ skillId, execution });
  }

  // Dynamic imports avoid credential machinery when nothing needs validation.
  const [{ getUser }, { validateExecutionModelAccess }] = await Promise.all([
    import('../routes/_helpers.mjs'),
    import('./execution-model-policy.mjs'),
  ]);
  if (args?.userId && !getUser(args.userId)) {
    const baseline = executionShape(args?.baseAgent);
    return {
      baseline, effective: { ...baseline },
      sourceSkillIds: { model: null, reasoningEffort: null },
      sourceKinds: { model: null, reasoningEffort: null },
      contenders: selected.map(skillId => ({
        skillId, eligible: false, reason: 'user-not-found',
      })),
      reason: 'user-not-found', applied: false, reasoningEffortInherited: true,
    };
  }

  // Build auto candidates for every selected skill; the pure resolver skips
  // them when a user pin is eligible.
  let autoCandidates = {};
  try {
    const { getRoleManifest } = await import('../roles.mjs');
    autoCandidates = await buildAutoExecutionCandidates({
      selectedSkillIds: selected,
      baseAgent: args.baseAgent,
      getManifest: skillId => getRoleManifest(skillId, args.userId),
      resolveTier: (tier, baseAgent) => resolveTierToModelPair(
        args.userId, baseAgent, tier, args.allowedModels ?? null,
      ),
    });
  } catch {
    autoCandidates = {};
  }

  const pairs = new Map();
  for (const { execution } of userExecutions) {
    if (!Object.hasOwn(execution, 'provider') || !Object.hasOwn(execution, 'model')) continue;
    const key = `${execution.provider}\0${execution.model}`;
    if (!pairs.has(key)) pairs.set(key, null);
  }
  for (const auto of Object.values(autoCandidates)) {
    if (!auto?.provider || !auto?.model) continue;
    const key = `${auto.provider}\0${auto.model}`;
    if (!pairs.has(key)) pairs.set(key, null);
  }

  if (pairs.size) {
    await Promise.all([...pairs.keys()].map(async key => {
      const [provider, model] = key.split('\0');
      pairs.set(key, await validateExecutionModelAccess(args.userId, provider, model));
    }));
  }

  return resolveSkillExecutionForTurn({
    ...args,
    routeText,
    autoCandidates,
    modelAccess: pairs,
  });
}

export const _internal = { EFFORT_RANK, TIER_RANK, uniqueSkillIds, candidateRank, strongerCandidate };
