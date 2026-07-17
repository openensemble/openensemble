// @ts-check
/**
 * Skill-agnostic automation for execution profiles.
 *
 * Portable tiers (fast | standard | strong | reasoning) map to concrete
 * provider/model pairs from the account catalog. Custom skills never need a
 * hard-coded id table: authors can set execution_hint, otherwise structure +
 * task-shape priors fill in.
 */

export const EXECUTION_TIERS = Object.freeze(['fast', 'standard', 'strong', 'reasoning']);
export const EXECUTION_EFFORTS = Object.freeze(['off', 'low', 'medium', 'auto', 'high']);

/** @type {Readonly<Record<string, number>>} */
export const TIER_RANK = Object.freeze({
  fast: 1,
  standard: 2,
  strong: 3,
  reasoning: 4,
});

/** @type {Readonly<Record<string, number>>} */
export const EFFORT_RANK = Object.freeze({
  off: 0,
  low: 1,
  medium: 2,
  auto: 3,
  high: 4,
});

/**
 * @param {unknown} value
 * @returns {{tier?: string, effort?: string}|null}
 */
export function normalizeExecutionHint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  /** @type {Record<string, unknown>} */
  const raw = /** @type {Record<string, unknown>} */ (value);
  /** @type {{tier?: string, effort?: string}} */
  const out = {};
  if (Object.hasOwn(raw, 'tier')) {
    const tier = typeof raw.tier === 'string' ? raw.tier.trim().toLowerCase() : '';
    if (!EXECUTION_TIERS.includes(tier)) return null;
    out.tier = tier;
  }
  if (Object.hasOwn(raw, 'effort')) {
    const effort = typeof raw.effort === 'string' ? raw.effort.trim().toLowerCase() : '';
    if (!EXECUTION_EFFORTS.includes(effort)) return null;
    out.effort = effort;
  }
  return out.tier || out.effort ? out : null;
}

/**
 * Infer a portable tier/effort from any skill's manifest structure.
 * Works for built-ins and usr_* customs without skill-id tables.
 *
 * @param {any} manifest
 * @returns {{tier: string, effort: string, score: number, reasons: string[]}}
 */
export function scoreSkillStructure(manifest) {
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  const toolText = tools.map(tool => {
    const fn = tool?.function || tool || {};
    return [
      fn.name,
      fn.description,
      JSON.stringify(fn.parameters || {}),
    ].filter(Boolean).join(' ');
  }).join('\n').toLowerCase();

  const desc = [
    manifest?.description,
    manifest?.name,
    manifest?.category,
    ...(Array.isArray(manifest?.intent_examples) ? manifest.intent_examples : []),
  ].filter(Boolean).join(' ').toLowerCase();

  const blob = `${toolText}\n${desc}`;
  let score = 0;
  /** @type {string[]} */
  const reasons = [];

  if (tools.length >= 12) { score += 2; reasons.push('many-tools'); }
  else if (tools.length >= 6) { score += 1; reasons.push('several-tools'); }

  const destructive = tools.filter(t => t?.destructive === true
    || t?.function?.destructive === true).length;
  if (destructive > 0) { score += 2; reasons.push('destructive-tools'); }

  const sandbox = manifest?.sandbox;
  if (sandbox && sandbox.isolate === false) { score += 2; reasons.push('unsandboxed'); }
  if (sandbox?.network === true) { score += 1; reasons.push('network'); }

  if (manifest?.coordinator_scope === 'exclude') {
    score += 1;
    reasons.push('specialist-scope');
  }

  if (/\b(write|edit|patch|refactor|debug|shell|exec|deploy|compile|test suite|codebase|filesystem)\b/i.test(blob)
      || /\b(coder_|skill_(?:create|update|patch)|node_exec)\b/i.test(blob)) {
    score += 3;
    reasons.push('coding-like');
  }
  if (/\b(research|investigate|synthesize|crawl|multi-step|deep dive|comprehensive)\b/i.test(blob)
      || /\b(deep_research|research_search|web_search)\b/i.test(blob)) {
    score += 3;
    reasons.push('research-like');
  }
  if (/\b(list|get|read|status|count|fetch|search inbox|next event|agenda)\b/i.test(blob)
      && !/\b(write|edit|delete|send|compose|create|deploy)\b/i.test(blob)) {
    score -= 1;
    reasons.push('read-mostly');
  }
  if (/\b(send|compose|delete|trash|purge|label|batch)\b/i.test(blob)
      && tools.length <= 20) {
    // Operational but usually not "reasoning model" work.
    score += 0;
  }

  if (Array.isArray(manifest?.preferenceOpportunities) && manifest.preferenceOpportunities.length) {
    score += 1;
    reasons.push('watchers');
  }
  if (Array.isArray(manifest?.watchers) && manifest.watchers.length) {
    score += 1;
    reasons.push('watcher-kinds');
  }

  score = Math.max(0, score);
  let tier = 'standard';
  let effort = 'auto';
  if (score <= 1) {
    tier = 'fast';
    effort = 'low';
  } else if (score <= 3) {
    tier = 'standard';
    effort = 'auto';
  } else if (score <= 5) {
    tier = 'strong';
    effort = 'auto';
  } else {
    tier = 'reasoning';
    effort = 'high';
  }
  return { tier, effort, score, reasons };
}

/**
 * Lightweight effort prior from the user/worker task text alone.
 * @param {unknown} text
 * @returns {'low'|'medium'|'auto'|'high'|null}
 */
export function taskShapeEffort(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return null;
  const t = raw.toLowerCase();

  if (/\b(status|how's it going|how is it going|still running|is .+ done|check_workers|what happened)\b/i.test(t)
      && t.length < 160) {
    return 'low';
  }
  if (t.length < 40 && /^(list|show|what(?:'s| is)|when is|how many)\b/i.test(t)) {
    return 'low';
  }
  if (/\b(deep research|thorough|comprehensive|multi-step|refactor|debug|investigate|architect|from scratch)\b/i.test(t)) {
    return 'high';
  }
  if (/\b(then|also|after that|and then|as well as)\b/i.test(t) && t.length > 80) {
    return 'medium';
  }
  if (t.length > 400 || (t.match(/\n/g) || []).length >= 4) {
    return 'medium';
  }
  return null;
}

/**
 * Classify a concrete model id into a portable tier (heuristic).
 * @param {string} modelId
 * @returns {'fast'|'standard'|'strong'|'reasoning'}
 */
export function classifyModelTier(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return 'standard';
  if (/\b(o3|o4|opus|r1|reasoning|thinking|deepseek-r|sonar-reasoning|sonar-deep)\b/.test(id)
      || /gpt-5\.5|claude-opus|o1(?!-mini)/.test(id)) {
    return 'reasoning';
  }
  if (/\b(mini|nano|haiku|flash|small|lite|fast|8b|7b|3\.5-turbo|gpt-4o-mini|gpt-5\.4-mini|gpt-5-nano)\b/.test(id)) {
    return 'fast';
  }
  if (/\b(sonnet|codex|gpt-5(?![\d.]*-mini)|gpt-4\.1(?!-mini)|claude-4|70b|72b|405b|large|pro(?!-mini))\b/.test(id)
      || /gpt-5\.4(?!-mini)|gpt-5\.2|claude-sonnet/.test(id)) {
    return 'strong';
  }
  return 'standard';
}

/**
 * Score how well a catalog model fits a desired tier. Higher is better.
 * @param {string} modelId
 * @param {string} desiredTier
 */
export function modelFitScore(modelId, desiredTier) {
  const desired = TIER_RANK[desiredTier] ?? TIER_RANK.standard;
  const actual = TIER_RANK[classifyModelTier(modelId)] ?? TIER_RANK.standard;
  const distance = Math.abs(desired - actual);
  // Prefer exact tier; slight preference for over- vs under-provisioning on strong tasks.
  let score = 100 - distance * 25;
  if (actual < desired) score -= 8;
  if (actual > desired && desired <= TIER_RANK.standard) score -= 5;
  // Mild preference for newer-looking ids when still in-band.
  if (/\bgpt-5|claude-(?:sonnet-4|opus-4)|gemini-2|grok-3|grok-4\b/i.test(modelId)) score += 2;
  return score;
}

/**
 * @param {string[]} catalog
 * @param {string} tier
 * @param {{preferModel?: string|null}} [opts]
 * @returns {string|null}
 */
export function pickModelFromCatalog(catalog, tier, opts = {}) {
  const models = (Array.isArray(catalog) ? catalog : []).map(String).filter(Boolean);
  if (!models.length) return null;
  const desired = EXECUTION_TIERS.includes(tier) ? tier : 'standard';
  // standard → prefer keeping the caller's model when it is in catalog
  if (desired === 'standard' && opts.preferModel && models.includes(opts.preferModel)) {
    return opts.preferModel;
  }
  let best = null;
  let bestScore = -Infinity;
  for (const model of models) {
    let score = modelFitScore(model, desired);
    if (opts.preferModel && model === opts.preferModel) score += 3;
    if (score > bestScore) {
      bestScore = score;
      best = model;
    }
  }
  return best;
}

/**
 * Infer execution_hint for a newly authored custom skill from tools/description.
 * @param {{tools?: any[], description?: string, name?: string, code?: string}} spec
 */
export function inferExecutionHintFromSpec(spec) {
  const pseudo = {
    name: spec?.name,
    description: spec?.description,
    tools: spec?.tools,
    category: 'utility',
    // Treat unsandboxed / network-heavy code as higher blast radius when present.
    sandbox: /\ballow_network\b|sandbox\s*:\s*false/i.test(String(spec?.code || ''))
      ? { isolate: false }
      : undefined,
  };
  const scored = scoreSkillStructure(pseudo);
  return normalizeExecutionHint({ tier: scored.tier, effort: scored.effort });
}

export const _internal = {
  EXECUTION_TIERS,
  TIER_RANK,
};
