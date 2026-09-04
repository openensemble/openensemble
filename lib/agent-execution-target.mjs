// @ts-check
/** Provider-neutral execution targets for explicitly routed ephemeral agents. */

import { modelCapabilityPrompt } from './model-capabilities.mjs';
import { isReasoningEffortValue, reasoningEffortOptions } from './reasoning-effort.mjs';

const MAX_PROVIDER_LENGTH = 100;
const MAX_MODEL_LENGTH = 300;

function cleanPart(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\x00-\x1f\x7f]/.test(text)) return null;
  return text;
}

function isExecutionTextTarget(provider, model) {
  const normalizedProvider = provider.toLowerCase();
  if (normalizedProvider === 'fireworks') return false;
  return !((normalizedProvider === 'grok'
    || normalizedProvider === 'xai'
    || normalizedProvider === 'xai-oauth')
    && /^grok-imagine-(?:image|video)/i.test(model));
}

export function normalizeAgentExecutionTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Execution targets must be provider/model objects.' };
  }
  const provider = cleanPart(value.provider, MAX_PROVIDER_LENGTH);
  const model = cleanPart(value.model, MAX_MODEL_LENGTH);
  if (!provider || !model) {
    return { ok: false, error: 'Every execution target requires both provider and model.' };
  }
  if (!isExecutionTextTarget(provider, model)) {
    return { ok: false, error: `${provider}/${model} is not a valid text-model target.` };
  }
  const rawEffort = value.reasoningEffort ?? value.reasoning_effort;
  let reasoningEffort = null;
  if (rawEffort != null) {
    reasoningEffort = typeof rawEffort === 'string' ? rawEffort.trim().toLowerCase() : '';
    if (!isReasoningEffortValue(reasoningEffort)) {
      return { ok: false, error: 'reasoning_effort must be a valid provider-advertised effort id.' };
    }
  }
  return {
    ok: true,
    target: {
      provider,
      model,
      ...(reasoningEffort === null ? {} : { reasoningEffort }),
    },
  };
}

export function normalizeAgentExecutionAllocation(value, maxCount = 12) {
  if (value == null) return { ok: true, entries: [] };
  if (!Array.isArray(value) || value.length < 1 || value.length > maxCount) {
    return { ok: false, error: `execution_targets must contain 1–${maxCount} configured targets.` };
  }
  const entries = [];
  for (const raw of value) {
    const normalized = normalizeAgentExecutionTarget(raw);
    if (!normalized.ok) return normalized;
    let count = null;
    if (raw.count != null) {
      const parsed = typeof raw.count === 'number'
        ? raw.count
        : (typeof raw.count === 'string' && /^\d+$/.test(raw.count.trim())
          ? Number(raw.count.trim())
          : NaN);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxCount) {
        return { ok: false, error: `Every execution target count must be a whole number from 1 to ${maxCount}.` };
      }
      count = parsed;
    }
    entries.push({ ...normalized.target, count });
  }
  return { ok: true, entries };
}

export function executionTargetKey(value) {
  const effort = Object.hasOwn(value || {}, 'reasoningEffort')
    ? `effort:${value.reasoningEffort}`
    : 'effort:(inherit)';
  return `${value?.provider || ''}\0${value?.model || ''}\0${effort}`;
}

export function executionTargetLabel(value) {
  const pair = `${value?.provider || 'unknown'}/${value?.model || 'unknown'}`;
  return Object.hasOwn(value || {}, 'reasoningEffort')
    ? `${pair} (effort ${value.reasoningEffort})`
    : pair;
}

export function executionTargetMultisetMatches(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
    return false;
  }
  const counts = new Map();
  for (const target of expected) {
    const key = executionTargetKey(target);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const target of actual) {
    const key = executionTargetKey(target);
    const remaining = counts.get(key) || 0;
    if (remaining < 1) return false;
    if (remaining === 1) counts.delete(key);
    else counts.set(key, remaining - 1);
  }
  return counts.size === 0;
}

export async function validateAgentExecutionTargets(userId, targets, options = {}) {
  // Keep this dependency off the ordinary no-target delegation path. The
  // execution policy reaches into routes/configuration, while delegate itself
  // deliberately avoids importing that graph during module initialization.
  const policy = await import('./execution-model-policy.mjs');
  const { validateExecutionModelAccess } = policy;
  const hasReasoningCatalog = Reflect.has(policy, 'listExecutionReasoningEfforts');
  const listExecutionReasoningEfforts = hasReasoningCatalog
    ? policy.listExecutionReasoningEfforts
    : async (_userId, provider, model) => reasoningEffortOptions(provider, model);
  // Validate each provider/model pair against one catalog snapshot. The same
  // model may legitimately appear more than once with different efforts, but
  // refreshing its catalog once per effort risks both unnecessary provider
  // calls and inconsistent answers if the catalog changes between calls.
  const requested = Array.isArray(targets) ? targets : [];
  const pairs = new Map();
  for (const target of requested) {
    const key = `${target?.provider || ''}\0${target?.model || ''}`;
    if (!pairs.has(key)) pairs.set(key, target);
  }
  const results = await Promise.all([...pairs.entries()].map(async ([key, target]) => ({
    key,
    target,
    access: await validateExecutionModelAccess(
      userId,
      target.provider,
      target.model,
      { refreshCatalog: options.refreshCatalog === true },
    ),
  })));
  const denied = results.find(result => result.access?.ok !== true);
  if (denied) {
    const reason = denied.access?.error || denied.access?.reason || 'target is unavailable';
    return {
      ok: false,
      error: `Cannot use ${executionTargetLabel(denied.target)} for a spawned agent: ${reason}. No worker was started.`,
    };
  }

  const effortsByPair = new Map();
  await Promise.all(results.map(async result => {
    if (!requested.some(target => `${target?.provider || ''}\0${target?.model || ''}` === result.key
      && Object.hasOwn(target, 'reasoningEffort'))) return;
    // Access validation just loaded/refreshed and persisted this pair, so read
    // that exact persisted snapshot rather than issuing a second forced refresh.
    effortsByPair.set(result.key, await listExecutionReasoningEfforts(
      userId, result.target.provider, result.target.model, { refreshCatalog: false },
    ));
  }));
  for (const target of requested) {
    if (!Object.hasOwn(target, 'reasoningEffort')) continue;
    const key = `${target?.provider || ''}\0${target?.model || ''}`;
    const supported = effortsByPair.get(key) || [];
    if (!supported.some(option => option.value === target.reasoningEffort)) {
      return {
        ok: false,
        error: `Cannot use ${executionTargetLabel(target)} for a spawned agent: reasoning effort "${target.reasoningEffort}" is not supported by that provider/model. No worker was started.`,
      };
    }
  }
  return { ok: true };
}

function replaceModelGuidance(text, priorGuidance, nextGuidance) {
  if (typeof text !== 'string' || !text) return text;
  if (priorGuidance && text.includes(priorGuidance)) {
    return text.replace(priorGuidance, nextGuidance);
  }
  if (!nextGuidance || text.includes(nextGuidance)) return text;
  return `${text}\n\n${nextGuidance}`;
}

/** Clone an agent onto an explicit provider/model and lock that choice for its turn. */
export function applyAgentExecutionTarget(agent, target) {
  const normalized = normalizeAgentExecutionTarget(target);
  if (!normalized.ok) throw new Error(normalized.error);
  const nextTarget = normalized.target;
  const priorProvider = agent?.provider ?? 'ollama';
  const priorModel = agent?.model ?? '';
  const priorGuidance = modelCapabilityPrompt(priorProvider, priorModel);
  const nextGuidance = modelCapabilityPrompt(nextTarget.provider, nextTarget.model);
  const next = {
    ...(agent || {}),
    provider: nextTarget.provider,
    model: nextTarget.model,
    contextSize: null,
    _executionTargetLocked: true,
    _explicitExecutionTarget: { ...nextTarget },
  };
  // Effort semantics differ by provider/model. An explicit model target starts
  // from that model's default; per-skill/task effort policy may still tune it.
  if (Object.hasOwn(nextTarget, 'reasoningEffort')) {
    next.reasoningEffort = nextTarget.reasoningEffort;
    next._executionEffortLocked = true;
  } else {
    delete next.reasoningEffort;
    delete next._executionEffortLocked;
  }
  delete next._executionModelLocked;
  delete next._skillExecutionApplied;
  delete next._skillExecutionSource;
  next.systemPrompt = replaceModelGuidance(next.systemPrompt, priorGuidance, nextGuidance);
  if (next._promptTiers) {
    next._promptTiers = {
      ...next._promptTiers,
      stable: replaceModelGuidance(next._promptTiers.stable, priorGuidance, nextGuidance),
    };
  }
  if (typeof next._systemPromptShell === 'string') {
    next._systemPromptShell = replaceModelGuidance(
      next._systemPromptShell,
      priorGuidance,
      nextGuidance,
    );
  }
  delete next._promptTiersAssembled;
  return next;
}
