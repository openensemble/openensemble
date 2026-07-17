// @ts-check
/**
 * Resolve a turn's per-skill execution override without mutating its base agent.
 *
 * Only skill ids explicitly selected by the turn router are considered. Merely
 * carrying a skill's tools is not enough to activate its model. Provider/model
 * always travel as one atomic pair. When several selected skills have execution
 * overrides, the model pair belonging to the strongest explicit effort among
 * pair-bearing candidates wins; ties preserve the router's selected-skill
 * order. The final effort is selected independently across every eligible
 * override, including effort-only entries.
 */

import { loadSkillOverrides, normalizeSkillExecution } from './skill-overrides.mjs';

const EFFORT_RANK = Object.freeze({ off: 0, low: 1, medium: 2, auto: 3, high: 4 });

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

function strongerCandidate(candidate, current) {
  if (!current) return true;
  if (candidate.effortRank !== current.effortRank) return candidate.effortRank > current.effortRank;
  return candidate.selectedIndex < current.selectedIndex;
}

export function resolveSkillExecutionForTurn({
  userId,
  baseAgent,
  selectedSkillIds,
  allowedModels = null,
  modelAccess = null,
}) {
  const baseline = executionShape(baseAgent);
  const effective = { ...baseline };
  const selected = uniqueSkillIds(selectedSkillIds);
  const sourceSkillIds = { model: null, reasoningEffort: null };

  if (!selected.length) {
    return {
      baseline, effective, sourceSkillIds, contenders: [],
      reason: 'no-selected-skills', applied: false, reasoningEffortInherited: true,
    };
  }

  const all = loadSkillOverrides(userId);
  const contenders = [];
  let modelWinner = null;
  let effortWinner = null;

  for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex++) {
    const skillId = selected[selectedIndex];
    const rawExecution = all?.[skillId]?.execution;
    if (rawExecution == null) continue;
    const execution = normalizeSkillExecution(rawExecution);
    if (!execution) {
      contenders.push({ skillId, selectedIndex, eligible: false, reason: 'invalid-execution-override' });
      continue;
    }

    const hasModelPair = Object.hasOwn(execution, 'provider') && Object.hasOwn(execution, 'model');
    const hasExplicitEffort = Object.hasOwn(execution, 'reasoningEffort');
    const effortRank = hasExplicitEffort ? EFFORT_RANK[execution.reasoningEffort] : -1;
    const allowedByAccount = !hasModelPair || isAllowedModel(execution.model, allowedModels);
    const access = hasModelPair && modelAccess instanceof Map
      ? modelAccess.get(`${execution.provider}\0${execution.model}`)
      : null;
    const eligible = !hasModelPair || (allowedByAccount && access?.ok !== false);
    const candidate = {
      skillId, selectedIndex,
      ...(hasModelPair ? { provider: execution.provider, model: execution.model } : {}),
      ...(hasExplicitEffort ? { reasoningEffort: execution.reasoningEffort } : {}),
      effortRank, eligible,
      reason: eligible ? 'eligible' : (!allowedByAccount ? 'model-not-allowed' : access?.reason || 'model-unavailable'),
    };
    contenders.push(candidate);
    if (!eligible) continue;
    if (hasModelPair && strongerCandidate(candidate, modelWinner)) modelWinner = candidate;
    if (hasExplicitEffort && strongerCandidate(candidate, effortWinner)) effortWinner = candidate;
  }

  if (!modelWinner && !effortWinner) {
    const reason = contenders.some(candidate => candidate.reason === 'model-not-allowed')
      ? 'no-allowed-execution-overrides' : 'no-execution-overrides';
    return {
      baseline, effective, sourceSkillIds, contenders, reason,
      applied: false, reasoningEffortInherited: true,
    };
  }

  if (modelWinner) {
    effective.provider = modelWinner.provider;
    effective.model = modelWinner.model;
    sourceSkillIds.model = modelWinner.skillId;
  }
  if (effortWinner) {
    effective.reasoningEffort = effortWinner.reasoningEffort;
    sourceSkillIds.reasoningEffort = effortWinner.skillId;
  }

  return {
    baseline, effective, sourceSkillIds, contenders,
    reason: 'selected-skill-execution',
    applied: effective.provider !== baseline.provider
      || effective.model !== baseline.model || effortWinner !== null,
    reasoningEffortInherited: effortWinner === null,
  };
}

/**
 * Runtime entrypoint. Saved profiles are untrusted durable preferences: check
 * the owning user and every selected provider/model pair again immediately
 * before a turn uses them. Invalid/revoked entries remain stored for the UI to
 * repair, but cannot affect execution.
 */
export async function resolveValidatedSkillExecutionForTurn(args) {
  const selected = uniqueSkillIds(args?.selectedSkillIds);
  if (!selected.length) return resolveSkillExecutionForTurn(args);

  const all = loadSkillOverrides(args?.userId);
  const selectedExecutions = selected
    .map(skillId => ({ skillId, execution: normalizeSkillExecution(all?.[skillId]?.execution) }))
    .filter(item => item.execution);
  if (!selectedExecutions.length) return resolveSkillExecutionForTurn(args);

  // Dynamic imports avoid pulling user/config credential machinery into chat
  // processes that have no saved execution profile at all.
  const [{ getUser }, { validateExecutionModelAccess }] = await Promise.all([
    import('../routes/_helpers.mjs'),
    import('./execution-model-policy.mjs'),
  ]);
  if (!getUser(args?.userId)) {
    const baseline = executionShape(args?.baseAgent);
    return {
      baseline, effective: { ...baseline }, sourceSkillIds: { model: null, reasoningEffort: null },
      contenders: selectedExecutions.map(item => ({
        skillId: item.skillId, eligible: false, reason: 'user-not-found',
      })),
      reason: 'user-not-found', applied: false, reasoningEffortInherited: true,
    };
  }

  const pairs = new Map();
  for (const { execution } of selectedExecutions) {
    if (!Object.hasOwn(execution, 'provider') || !Object.hasOwn(execution, 'model')) continue;
    const key = `${execution.provider}\0${execution.model}`;
    if (!pairs.has(key)) pairs.set(key, null);
  }
  await Promise.all([...pairs.keys()].map(async key => {
    const [provider, model] = key.split('\0');
    pairs.set(key, await validateExecutionModelAccess(args.userId, provider, model));
  }));
  return resolveSkillExecutionForTurn({ ...args, modelAccess: pairs });
}

export const _internal = { EFFORT_RANK, uniqueSkillIds };
