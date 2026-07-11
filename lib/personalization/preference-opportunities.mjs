// @ts-check
/**
 * Declarative bridge from confirmed preferences to skill monitoring. The
 * default remains ask-first. A recipe may additionally declare
 * `autonomy:"informational"`; that exact, reversible monitor contract can run
 * unattended only when the user selected initiativeMode=safe_auto. Every such
 * run reserves a durable receipt before executing and must create exactly one
 * matching watcher or it is rolled back.
 */
import { createHash, randomUUID } from 'crypto';
import { getConfig } from './config.mjs';
import { listLedger } from './ledger.mjs';
import { hasSensitiveReplayArgs } from './leads.mjs';
import { looksLikeToolError } from '../tool-error.mjs';
import { canonicalPreferenceSubjectKey } from './preference-structure.mjs';

const MAX_SKILLS = 50;
const MAX_RECIPES_PER_SKILL = 3;
const MAX_KEYWORDS = 32;
const MAX_ARGS_BYTES = 4_000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WATCHER_KIND_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const INFORMATIONAL_AUTONOMY = 'informational';
// Preference activations always belong to sandboxed user skills. A future
// tool-capable agent turn would turn changing watcher output into authority, so
// it is deliberately not an approvable delivery contract here. Direct owner
// notification/email/Telegram channels remain exact and receipt-bound.
const APPROVED_DELIVERIES = new Set(['notify', 'email', 'telegram']);
// Only notify is intrinsically informational at the watcher delivery boundary.
const LOCAL_DELIVERIES = new Set(['notify']);
const AUTO_RECEIPT_KIND = 'preference_monitor_activation';
const STALE_ACTIVATION_MS = 5 * 60_000;

// Discovery can be triggered by the six-hour reflection sweep and immediately
// after a deterministic explicit preference is stored. Serialize those paths
// per user so two simultaneous turns/sweeps cannot both observe "no watcher"
// and create duplicate proposals or activation receipts.
const _discoveryTails = new Map();
const _receiptControlTails = new Map();

async function serializeDiscovery(userId, fn) {
  const previous = _discoveryTails.get(userId) || Promise.resolve();
  const current = previous.catch(() => null).then(fn);
  _discoveryTails.set(userId, current);
  try {
    return await current;
  } finally {
    if (_discoveryTails.get(userId) === current) _discoveryTails.delete(userId);
  }
}

async function serializeReceiptControl(userId, receiptId, fn) {
  const key = `${userId}\0${receiptId}`;
  const previous = _receiptControlTails.get(key) || Promise.resolve();
  const current = previous.catch(() => null).then(fn);
  _receiptControlTails.set(key, current);
  try {
    return await current;
  } finally {
    if (_receiptControlTails.get(key) === current) _receiptControlTails.delete(key);
  }
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function activationArgsAreBounded(value) {
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (current.value == null || typeof current.value !== 'object') continue;
    if (current.depth > 5 || seen.has(current.value)) return false;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > 20) return false;
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const entries = Object.entries(current.value);
    if (entries.length > 32 || entries.some(([key]) => DANGEROUS_KEYS.has(key))) return false;
    for (const [, child] of entries) stack.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

function normalizeRecipe(manifest, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const activationTool = typeof value.activationTool === 'string' ? value.activationTool.trim() : '';
  const watcherKind = typeof value.watcherKind === 'string' ? value.watcherKind.trim() : '';
  const dedupKey = typeof value.dedupKey === 'string' ? value.dedupKey.trim() : '';
  if (!SLUG_RE.test(id) || id.length > 64 || !activationTool
    || !WATCHER_KIND_RE.test(watcherKind) || !dedupKey || dedupKey.length > 160
    || /[\u0000-\u001f\u007f]/.test(dedupKey)) return null;

  const toolDef = Array.isArray(manifest.tools)
    ? manifest.tools.find(tool => tool?.function?.name === activationTool) : null;
  // Activation changes durable watcher state and therefore must be explicitly
  // marked as a confirmation-requiring/destructive tool in its own manifest.
  if (!toolDef || toolDef.destructive !== true) return null;
  // The proposal's duplicate/active-state guard is meaningful only when the
  // same skill actually owns the watcher kind it names.  Recheck this at
  // runtime too; manifests may predate (or bypass) builder validation.
  const ownsWatcher = Array.isArray(manifest.watchers)
    && manifest.watchers.some(watcher => watcher?.kind === watcherKind);
  if (!ownsWatcher) return null;

  const keywords = Array.isArray(value.preferenceKeywords)
    ? [...new Set(value.preferenceKeywords.map(normalizeText)
      .filter(keyword => keyword.length >= 3 && keyword.length <= 40))].slice(0, MAX_KEYWORDS)
    : [];
  if (!keywords.length) return null;

  const activationArgs = value.activationArgs == null ? {} : value.activationArgs;
  if (!activationArgs || typeof activationArgs !== 'object' || Array.isArray(activationArgs)
    || !activationArgsAreBounded(activationArgs) || hasSensitiveReplayArgs(activationArgs)) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(activationArgs), 'utf8') > MAX_ARGS_BYTES) return null;
  } catch { return null; }
  const declaredArgs = toolDef?.function?.parameters?.properties;
  const activationArgKeys = Object.keys(activationArgs);
  if (activationArgKeys.length && (!declaredArgs || typeof declaredArgs !== 'object'
    || activationArgKeys.some(key => !Object.hasOwn(declaredArgs, key)))) return null;

  const autonomy = value.autonomy === INFORMATIONAL_AUTONOMY
    ? INFORMATIONAL_AUTONOMY : null;
  // Unattended delivery is intentionally local-only. An informational
  // declaration with an external destination (email/Telegram/etc.) remains a
  // perfectly valid ask-first recipe but never crosses the safe-auto gate.
  const autoEligible = autonomy === INFORMATIONAL_AUTONOMY
    && LOCAL_DELIVERIES.has(activationArgs.deliver);

  return {
    id,
    activationTool,
    activationArgs: JSON.parse(JSON.stringify(activationArgs)),
    watcherKind,
    dedupKey,
    keywords,
    autonomy,
    autoEligible,
    title: typeof value.title === 'string' && value.title.trim()
      ? value.title.trim().slice(0, 100) : `Turn on ${String(manifest.name || manifest.id).slice(0, 80)} updates?`,
    body: typeof value.body === 'string' ? value.body.trim().slice(0, 400) : '',
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function recipeContract(manifest, recipe) {
  return {
    version: 2,
    skillId: manifest.id,
    recipeId: recipe.id,
    preferenceKeywords: recipe.keywords,
    autonomy: recipe.autonomy,
    activationTool: recipe.activationTool,
    activationArgs: recipe.activationArgs,
    watcherKind: recipe.watcherKind,
    watcherIdentity: recipe.dedupKey,
  };
}

function recipeContractFingerprint(manifest, recipe) {
  return createHash('sha256').update(stableJson(recipeContract(manifest, recipe))).digest('hex').slice(0, 20);
}

function recipeOfferKind(manifest, recipe) {
  return `skill-activation-${recipeContractFingerprint(manifest, recipe).slice(0, 16)}`;
}

function textMatchScore(value, keyword, weight) {
  const normalized = normalizeText(value);
  if (!normalized) return 0;
  const tokens = normalized.split(' ').filter(Boolean);
  if (keyword.includes(' ')) {
    if (` ${normalized} `.includes(` ${keyword} `)) return weight;
    return 0;
  }
  return tokens.some(token => token === keyword || token === `${keyword}s` || token === `${keyword}es`)
    ? weight : 0;
}

function preferenceIsCurrent(row, now = Date.now()) {
  const expiresAt = row?.structure?.temporary?.expiresAt;
  return !expiresAt || (Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > now);
}

function preferenceObservedAt(row) {
  return Date.parse(row?.updatedAt || row?.confirmedAt || row?.createdAt || '') || 0;
}

function preferenceFacet(row, key) {
  return normalizeText(row?.structure?.[key]);
}

function preferenceAppliesToSkill(row, skillId) {
  return row?.scope === 'global' || row?.scope === skillId;
}

function preferencesConflict(positive, negative) {
  const positiveSubject = canonicalPreferenceSubjectKey(
    positive?.structure?.subject || positive?.subject || positive?.statement,
  );
  const negativeSubject = canonicalPreferenceSubjectKey(
    negative?.structure?.subject || negative?.subject || negative?.statement,
  );
  if (!positiveSubject || positiveSubject !== negativeSubject) return false;
  for (const key of ['merchant', 'context']) {
    const left = preferenceFacet(positive, key);
    const right = preferenceFacet(negative, key);
    if (left && right && left !== right) return false;
  }
  return true;
}

function matchingPreference(preferences, recipe, skillId, { preferenceMemoryId = null } = {}) {
  const applicable = preferences.filter(row =>
    preferenceAppliesToSkill(row, skillId) && preferenceIsCurrent(row));
  const negatives = applicable.filter(row => row.polarity === 'negative');
  let best = null;
  for (const row of applicable) {
    // Scope is an authorization boundary, not merely ranking metadata. Legacy
    // rows with no explicit scope do not authorize a new skill activation.
    if (row?.polarity === 'negative'
      || (preferenceMemoryId && row?.id !== preferenceMemoryId)) continue;
    if (negatives.some(negative => preferencesConflict(row, negative)
      && preferenceObservedAt(negative) >= preferenceObservedAt(row))) continue;
    for (const keyword of recipe.keywords) {
      const score = Math.max(
        textMatchScore(row?.structure?.subject, keyword, 1),
        textMatchScore(row?.subject, keyword, 0.95),
        textMatchScore(row?.statement, keyword, keyword.includes(' ') ? 0.88 : 0.84),
      );
      if (score > (best?.relevance || 0)) {
        best = { row, relevance: score, matchedKeyword: keyword };
      }
    }
  }
  return best;
}

function watcherMatchesRecipe(watcher, skillId, recipe) {
  const identity = watcher?.personalizationOrigin?.watcherIdentity
    || watcher?.state?.dedupKey || watcher?.dedupKey;
  return watcher?.kind === recipe.watcherKind
    && watcher?.skillId === skillId
    && identity === recipe.dedupKey;
}

async function visibleCustomRecipes(userId) {
  const { listRoles } = await import('../../roles.mjs');
  const { getUser, getUserEnabledSkills } = await import('../../routes/_helpers.mjs');
  if (typeof getUser !== 'function') return [];
  const profile = getUser(userId);
  // A missing/unreadable profile is not consent, and an installed skill is not
  // necessarily enabled for this user. Use the same enabled-skill resolver as
  // agent/tool composition; this check is repeated by every safe watcher tick
  // through safeAutoContext.
  if (!profile || typeof getUserEnabledSkills !== 'function') return [];
  let enabledSkills;
  try { enabledSkills = getUserEnabledSkills(userId); } catch { return []; }
  if (!Array.isArray(enabledSkills)) return [];
  const enabled = new Set(enabledSkills.filter(skillId => typeof skillId === 'string'));
  const resolvedById = new Map();
  for (const manifest of listRoles(userId)) {
    if (!manifest?.id) continue;
    const prior = resolvedById.get(manifest.id);
    if (!prior || manifest.userScope === userId) resolvedById.set(manifest.id, manifest);
  }
  const manifests = [...resolvedById.values()]
    .filter(manifest => Array.isArray(manifest?.preferenceOpportunities) && manifest.preferenceOpportunities.length)
    .filter(manifest => enabled.has(manifest.id))
    .filter(manifest => profile?.role !== 'child'
      || !Array.isArray(profile.allowedSkills)
      || profile.allowedSkills.includes(manifest.id))
    .slice(0, MAX_SKILLS);
  const out = [];
  for (const manifest of manifests) {
    const recipes = Array.isArray(manifest.preferenceOpportunities)
      ? manifest.preferenceOpportunities.slice(0, MAX_RECIPES_PER_SKILL) : [];
    for (const raw of recipes) {
      const recipe = normalizeRecipe(manifest, raw);
      if (recipe) out.push({ manifest, recipe, profileRole: profile?.role || null });
    }
  }
  return out;
}

/** Revalidate a persisted activation card immediately before execution. */
export async function validatePreferenceActivationProposal(userId, proposal) {
  if (!userId || proposal?.actionContract !== 'skill_preference_activation') return null;
  const cfg = await getConfig(userId);
  if (cfg.enabled !== true || cfg.setupComplete !== true) return null;
  const entries = await visibleCustomRecipes(userId);
  const found = entries.find(({ manifest, recipe }) => manifest.id === proposal.skillId
    && recipe.id === proposal.preferenceOpportunityId);
  if (!found) return null;
  const { recipe } = found;
  const expectedDelivery = typeof recipe.activationArgs?.deliver === 'string'
    ? recipe.activationArgs.deliver : 'notify';
  if (!APPROVED_DELIVERIES.has(expectedDelivery)) return null;
  const contractFingerprint = recipeContractFingerprint(found.manifest, recipe);
  const offerKind = recipeOfferKind(found.manifest, recipe);
  if (proposal.contractFingerprint && proposal.contractFingerprint !== contractFingerprint) return null;
  if (proposal.contractFingerprint && proposal.offerKind !== offerKind) return null;
  if (proposal.action?.tool !== recipe.activationTool) return null;
  if (stableJson(proposal.action?.args || {}) !== stableJson(recipe.activationArgs)) return null;
  const preferences = await confirmedPreferenceRows(userId);
  const match = matchingPreference(preferences, recipe, found.manifest.id, {
    preferenceMemoryId: proposal.preferenceMemoryId || null,
  });
  if (!match) return null;
  const { listWatchers, assertWatcherStoreHealthy } = await import('../../scheduler/watchers.mjs');
  assertWatcherStoreHealthy(userId);
  const active = listWatchers(userId)?.active || [];
  if (active.some(watcher => watcherMatchesRecipe(watcher, found.manifest.id, recipe))) return null;
  const grants = await import('./skill-preference-grants.mjs');
  const identity = grants.currentSkillGrantIdentity(userId, found.manifest);
  if (!identity) return null;
  return {
    tool: recipe.activationTool,
    args: recipe.activationArgs,
    skillId: found.manifest.id,
    watcherKind: recipe.watcherKind,
    dedupKey: recipe.dedupKey,
    watcherIdentity: recipe.dedupKey,
    autonomy: recipe.autonomy,
    contractFingerprint,
    offerKind,
    preferenceMemoryId: match.row.id,
    utilityContextKey: opportunityContextKey(match.row),
    executorDigest: identity.executorDigest,
    manifestDigest: identity.manifestDigest,
    expectedDelivery,
  };
}

/** Resolve the exact watcher registered for a validated activation contract. */
export async function getPreferenceActivationWatcher(userId, expectation) {
  const watcherIdentity = expectation?.watcherIdentity || expectation?.dedupKey;
  if (!userId || !expectation?.skillId || !expectation?.watcherKind || !watcherIdentity) return null;
  const { listWatchers, assertWatcherStoreHealthy } = await import('../../scheduler/watchers.mjs');
  assertWatcherStoreHealthy(userId);
  const active = listWatchers(userId)?.active || [];
  return active.find(watcher => watcherMatchesRecipe(watcher, expectation.skillId, {
    watcherKind: expectation.watcherKind,
    dedupKey: watcherIdentity,
  })) || null;
}

/** Verify that an accepted activation tool actually registered its contract. */
export async function preferenceActivationIsActive(userId, expectation) {
  return !!(await getPreferenceActivationWatcher(userId, expectation));
}

function isToolRefusal(text) {
  const value = String(text || '').trim();
  return /^(?:Unknown tool:|Tool ".+" is not permitted for this account\.|Tool ".+" is from a disabled skill\.|Tool ".+" is hidden by your settings\.)/i.test(value)
    || /\bis running in the background\b/i.test(value);
}

async function runActivationAction(userId, agentId, action, provenance) {
  const [roleModule, { suppressObservations }, { runWithPreferenceSafeAutoContext }, userHelpers] = await Promise.all([
    import('../../roles.mjs'),
    import('./recorder.mjs'),
    import('./safe-auto-context.mjs'),
    import('../../routes/_helpers.mjs'),
  ]);
  return runWithPreferenceSafeAutoContext(provenance, () => suppressObservations(async () => {
    // Direct execution deliberately bypasses executeToolStreaming's 10-second
    // auto-background path. We must await the activation tool to completion;
    // a detached completion could register a watcher after receipt rollback.
    const liveProfile = userHelpers.getUser(userId);
    const liveEnabledSkills = liveProfile && typeof userHelpers.getUserEnabledSkills === 'function'
      ? userHelpers.getUserEnabledSkills(userId) : null;
    if (!liveProfile || !Array.isArray(liveEnabledSkills)
      || !liveEnabledSkills.includes(provenance.skillId)) {
      throw new Error('preference activation skill is no longer enabled for this user');
    }
    const liveCandidates = roleModule.listRoles(userId)
      .filter(manifest => manifest?.id === provenance.skillId);
    const liveManifest = liveCandidates.find(manifest => manifest?.userScope === userId)
      || liveCandidates.find(manifest => manifest?.userScope == null);
    const { reviewedInformationalSkillDigest } = await import('./reviewed-informational-skills.mjs');
    if (!liveManifest
      || reviewedInformationalSkillDigest(userId, liveManifest) !== provenance.reviewedExecutorDigest) {
      throw new Error('reviewed informational skill implementation changed before dispatch');
    }
    const { assertSkillToolAutomationAllowed } = await import('../skill-overrides.mjs');
    if (!assertSkillToolAutomationAllowed(userId, provenance.skillId, action.tool, !!provenance.alwaysOn)) {
      throw new Error('activation tool is disabled or hidden');
    }
    const value = await roleModule.executeReviewedRoleToolForSkill(
      provenance.skillId, action.tool, action.args || {}, userId, agentId || null,
      provenance.reviewedExecutorDigest,
    );
    let text = '';
    let explicitError = false;
    if (typeof value === 'string') text = value;
    else if (value && typeof value === 'object') {
      if (typeof value.text === 'string') text = value.text;
      else {
        try { text = JSON.stringify(value); } catch { text = '[unserializable result]'; }
      }
      explicitError = value.isError === true || value.error === true;
    }
    text = text.slice(0, 2_000).trim();
    const sawResult = value !== null && value !== undefined;
    return {
      text,
      sawResult,
      isError: !sawResult || explicitError || looksLikeToolError(text.slice(0, 4_000)) || isToolRefusal(text.slice(0, 4_000)),
    };
  }));
}

async function confirmedPreferenceRows(userId) {
  return (await listLedger(userId, { includeContradicted: false }))
    .filter(row => row.tier === 'confirmed' && row.type === 'preference'
      && !row.flag && preferenceIsCurrent(row))
    .sort((a, b) => preferenceObservedAt(b) - preferenceObservedAt(a));
}

function opportunityUtilityContract(contractFingerprint) {
  return { actionContract: 'skill_preference_activation', contractFingerprint };
}

function opportunityContextKey(preference) {
  // Utility storage is deliberately prose-free and may outlive a deleted
  // preference. Persist only one fixed categorical context; raw merchant
  // names stay in the live, bounded skill projection and receipt explanations
  // resolve from the ledger by opaque id.
  const allowed = new Set([
    'purchase', 'consumption', 'usage', 'breakfast', 'lunch', 'dinner',
    'travel', 'work', 'home',
  ]);
  const context = normalizeText(preference?.structure?.context).replace(/\s+/g, '-');
  return allowed.has(context) ? context : 'general';
}

async function preferenceOpportunityUtilityPolicy(
  userId, cfg, entry, match, ids, safeAutoAllowed,
  { active = false, reviewedNotifyOnly: reviewedOverride = null } = {},
) {
  const now = new Date();
  const contract = opportunityUtilityContract(ids.contractFingerprint);
  const contextKey = opportunityContextKey(match?.row);
  try {
    const [utility, reviewModule, roleModule] = await Promise.all([
      import('./opportunity-utility.mjs'),
      import('./reviewed-informational-skills.mjs'),
      import('../../roles.mjs'),
    ]);
    const prior = await utility.getOpportunityOutcome(userId, contract, { contextKey, now });
    let timing = 1;
    if (!active) {
      try {
        const configModule = await import('./config.mjs');
        if (typeof configModule.isQuietHours === 'function' && configModule.isQuietHours(cfg, now)) timing = 0.45;
      } catch { timing = 0.7; }
    }
    const reviewedNotifyOnly = typeof reviewedOverride === 'boolean'
      ? reviewedOverride
      : (entry.recipe.autoEligible === true
        && !!reviewModule.reviewedInformationalSkillDigest(userId, entry.manifest)
        && typeof roleModule.isSandboxedSkill === 'function'
        && roleModule.isSandboxedSkill(entry.manifest.id, userId));
    const shown = Number(prior?.totals?.shown || 0);
    const lastShownMs = shown > 0 ? Date.parse(prior?.updatedAt || '') : NaN;
    // Novelty/timing decide whether to interrupt now. They must not revoke an
    // already-running, otherwise-authorized monitor during quiet hours or
    // merely because its setup receipt was recently shown. Delivery has its
    // own live quiet-hours and budget checks.
    const novelty = active ? 1 : Number.isFinite(lastShownMs)
      ? Math.max(0.2, Math.min(1, (now.getTime() - lastShownMs) / (30 * 86_400_000))) : 1;
    const safeAutoEligible = cfg.initiativeMode === 'safe_auto'
      && entry.recipe.autoEligible === true && entry.profileRole !== 'child'
      && safeAutoAllowed === true;
    const policy = await utility.recommendOpportunityPolicy(userId, contract, {
      contextKey,
      factors: {
        preferenceConfidence: Number(match?.row?.confidence) || 0.99,
        relevance: Number(match?.relevance) || 0,
        novelty,
        timing,
        // Before a skill has a concrete result, value is deliberately neutral;
        // self-attested manifest prose cannot inflate unattended authority.
        savings: 0.5,
        interruptionCost: entry.recipe.activationArgs?.deliver === 'notify' ? 0.15 : 0.65,
      },
      safeAutoEligible,
      reviewedNotifyOnly,
      explicitPreferenceConfirmed: match?.row?.tier === 'confirmed',
      now,
    });
    // Server review is the cold-start evidence for the narrow notify-only
    // path. Every other new contract must match stably in at least two
    // distinct six-hour buckets before it can interrupt with an ask-first card.
    // Shadow readiness is a count of distinct idempotent evaluation buckets,
    // not engagement evidence, so use immutable totals rather than a decayed
    // fractional counter that could hover just below the threshold forever.
    const shadowed = Number(prior?.totals?.shadowed || 0);
    const hasExplicitOutcome = Number(policy?.evidence?.positive || 0)
      + Number(policy?.evidence?.negative || 0) > 0;
    if (!reviewedNotifyOnly && !hasExplicitOutcome && shadowed < 2) {
      return { ...policy, recommendation: 'shadow', reason: 'new-contract-shadow', contextKey, contract };
    }
    return { ...policy, contextKey, contract };
  } catch (e) {
    console.warn(`[personalization] opportunity utility unavailable for ${ids.offerKind}: ${e?.message || e}`);
    return {
      recommendation: 'shadow', reason: 'utility-store-unavailable', score: 0,
      contextKey, contract,
    };
  }
}

async function recordPreferenceOpportunityOutcome(userId, contract, outcome, options = {}) {
  try {
    const utility = await import('./opportunity-utility.mjs');
    return await utility.recordOpportunityOutcome(userId, contract, outcome, options);
  } catch (e) {
    console.warn(`[personalization] opportunity outcome ${outcome} could not be recorded: ${e?.message || e}`);
    return null;
  }
}

/** Record a bounded outcome from an ordinary ask-first proposal. */
export async function recordPreferenceProposalOutcome(userId, proposal, outcome) {
  if (!userId || proposal?.actionContract !== 'skill_preference_activation'
    || !['acted', 'dismissed'].includes(outcome)
    || typeof proposal.contractFingerprint !== 'string'
    || !/^[a-f0-9]{16,64}$/.test(proposal.contractFingerprint)) return null;
  const contextKey = typeof proposal.utilityContextKey === 'string'
    && /^[a-z][a-z0-9_-]{0,39}$/.test(proposal.utilityContextKey)
    ? proposal.utilityContextKey : 'general';
  return recordPreferenceOpportunityOutcome(
    userId,
    opportunityUtilityContract(proposal.contractFingerprint),
    outcome,
    { contextKey, eventId: proposal.id ? `proposal:${proposal.id}:${outcome}` : null },
  );
}

/** Final, live authorization for an informational unattended activation. */
async function safeAutoContext(userId, expected, { allowActive = false } = {}) {
  const cfg = await getConfig(userId);
  if (cfg.enabled !== true || cfg.setupComplete !== true
    || cfg.initiativeMode !== 'safe_auto' || cfg.proactivity === 'quiet'
    || !(Number(cfg.maxOffersPerRun) > 0)) return null;

  const entries = await visibleCustomRecipes(userId);
  const found = entries.find(({ manifest, recipe, profileRole }) => profileRole !== 'child'
    && manifest.id === expected.skillId
    && (!expected.recipeId || recipe.id === expected.recipeId)
    && recipe.autoEligible === true
    && recipeContractFingerprint(manifest, recipe) === expected.contractFingerprint
    && recipeOfferKind(manifest, recipe) === expected.offerKind);
  if (!found) return null;
  const { isSandboxedSkill } = await import('../../roles.mjs');
  if (typeof isSandboxedSkill !== 'function'
    || !isSandboxedSkill(found.manifest.id, userId)) return null;
  const { reviewedInformationalSkillDigest } = await import('./reviewed-informational-skills.mjs');
  const reviewedExecutorDigest = reviewedInformationalSkillDigest(userId, found.manifest);
  if (!reviewedExecutorDigest) return null;
  const { assertSkillToolAutomationAllowed } = await import('../skill-overrides.mjs');
  if (!assertSkillToolAutomationAllowed(userId, found.manifest.id, found.recipe.activationTool, !!found.manifest.always_on)) return null;

  const preferences = await confirmedPreferenceRows(userId);
  const match = matchingPreference(preferences, found.recipe, found.manifest.id, {
    preferenceMemoryId: expected.preferenceMemoryId || null,
  });
  if (!match) return null;

  const { isKindSuppressed, isKindSafeAutoAllowed } = await import('./graduation.mjs');
  const [suppressed, safeAutoAllowed] = await Promise.all([
    isKindSuppressed(userId, expected.offerKind),
    isKindSafeAutoAllowed(userId, expected.offerKind),
  ]);
  if (suppressed || !safeAutoAllowed) return null;

  // Outcome learning is part of authorization, not only discovery ranking.
  // A fresh "not useful", Stop, or Undo therefore closes the next-tick window
  // even when reconciliation has not run yet. Failures remain fail-closed.
  const utilityPolicy = await preferenceOpportunityUtilityPolicy(
    userId, cfg, found, match, expected, safeAutoAllowed,
    { active: allowActive, reviewedNotifyOnly: true },
  );
  if (utilityPolicy.recommendation !== 'safe_auto') return null;

  const { listWatchers, assertWatcherStoreHealthy } = await import('../../scheduler/watchers.mjs');
  assertWatcherStoreHealthy(userId);
  const active = listWatchers(userId)?.active || [];
  if (!allowActive && active.some(watcher => watcherMatchesRecipe(watcher, found.manifest.id, found.recipe))) return null;
  return { cfg, ...found, active, reviewedExecutorDigest, match, utilityPolicy };
}

async function rollbackNewWatchers(userId, records) {
  if (!Array.isArray(records) || !records.length) return { removed: 0, complete: true, remaining: [] };
  const watcherModule = await import('../../scheduler/watchers.mjs');
  try { watcherModule.assertWatcherStoreHealthy(userId); }
  catch { return { removed: 0, complete: false, remaining: records }; }
  const ids = new Set(records.map(record => record?.id).filter(Boolean));
  for (const record of records) {
    try { if (record?.id) watcherModule.unregisterWatcher(userId, record.id, 'auto_activation_rollback'); }
    catch (e) { console.warn(`[personalization] failed to roll back watcher ${record?.id || '(unknown)'}: ${e?.message || e}`); }
  }
  const remaining = (watcherModule.listWatchers(userId)?.active || [])
    .filter(watcher => ids.has(watcher?.id));
  return { removed: Math.max(0, ids.size - remaining.length), complete: remaining.length === 0, remaining };
}

async function deliverPreferenceActivationReceipt(userId, event, title) {
  if (!event || event.status === 'delivered' || event.status === 'read') return;
  let cfg;
  try { cfg = await getConfig(userId); } catch { return; }
  if (cfg.enabled !== true || cfg.setupComplete !== true
    || cfg.proactivity === 'quiet' || cfg.deliveryMode !== 'immediate') return;
  try {
    const { isQuietHours } = await import('./config.mjs');
    if (isQuietHours(cfg, new Date())) return;
  } catch { return; }

  const inbox = await import('./proactive-inbox.mjs');
  const claimed = await inbox.claimProactiveEvent(userId, event.id, { now: new Date() });
  if (!claimed) return;
  const { consumePingBudget, refundPingBudget } = await import('./graduation.mjs');
  const budgetOk = await consumePingBudget(userId).catch(() => false);
  if (!budgetOk) {
    await inbox.recordProactiveDeliveryAttempt(userId, event.id, {
      claimToken: claimed.claimToken, deliveryCount: 0, channel: 'websocket', error: 'daily ping budget exhausted',
    });
    return;
  }

  let liveCfg;
  try { liveCfg = await getConfig(userId); } catch { liveCfg = null; }
  let hold = !liveCfg || liveCfg.enabled !== true || liveCfg.setupComplete !== true
    || liveCfg.proactivity === 'quiet' || liveCfg.deliveryMode !== 'immediate';
  try {
    const { isQuietHours } = await import('./config.mjs');
    if (!hold && isQuietHours(liveCfg, new Date())) hold = true;
  } catch { hold = true; }
  if (hold) {
    await refundPingBudget(userId).catch(() => false);
    await inbox.recordProactiveDeliveryAttempt(userId, event.id, {
      claimToken: claimed.claimToken, deliveryCount: 0, channel: 'websocket', error: 'delivery controls changed',
    });
    return;
  }

  let delivered = 0;
  let error = null;
  try {
    const { notifyUser } = await import('./notify.mjs');
    delivered = await notifyUser(userId, {
      type: 'status', kind: 'personalization', watcherId: `preference_${event.sourceId || event.id}`,
      label: 'Personalization', text: `Started automatically: ${String(title || 'preference updates').slice(0, 120)}. You can stop or undo it from Proactive activity.`,
      final: true, finalStatus: 'done',
    });
  } catch (e) { error = e?.message || String(e); }
  if (!(delivered > 0)) await refundPingBudget(userId).catch(() => false);
  await inbox.recordProactiveDeliveryAttempt(userId, event.id, {
    claimToken: claimed.claimToken,
    deliveryCount: delivered,
    channel: 'websocket',
    error: delivered > 0 ? null : (error || 'user offline'),
  });
}

/**
 * Run one exact informational monitor contract under safe_auto. The durable
 * receipt is the pre-side-effect idempotency boundary. Returns handled:false
 * on any doubt so discovery can surface the ordinary ask-first proposal.
 */
async function autoActivatePreferenceOpportunity(userId, agentId, entry, ids) {
  const { manifest, recipe } = entry;
  const inbox = await import('./proactive-inbox.mjs');
  const receiptDedup = `preference-auto:${ids.offerKind}`;
  const activationNonce = `pa_${randomUUID()}`;
  let reservation;
  try {
    reservation = await inbox.reserveProactiveEvent(userId, {
      dedupKey: receiptDedup,
      kind: AUTO_RECEIPT_KIND,
      sourceId: ids.opportunityId,
      title: 'Preference monitor started',
      text: `Automatic setup started: ${recipe.title}`,
      metadata: {
        actionContract: 'skill_preference_activation',
        offerKind: ids.offerKind,
        activationNonce,
        recipeId: ids.recipeId,
        contractFingerprint: ids.contractFingerprint,
        autonomy: INFORMATIONAL_AUTONOMY,
        executionState: 'started',
        executionStartedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.warn(`[personalization] preference auto-activation receipt unavailable: ${e?.message || e}`);
    return { handled: false, review: 'Automatic setup could not be safely reserved, so approval is required.' };
  }

  if (!reservation.reserved) {
    const prior = reservation.event;
    const active = await getPreferenceActivationWatcher(userId, {
      skillId: manifest.id, watcherKind: recipe.watcherKind, watcherIdentity: recipe.dedupKey,
    });
    if (prior?.metadata?.executionState === 'succeeded' && active) return { handled: true };
    return { handled: false, review: 'A previous automatic setup is no longer active or had an uncertain result. Approval is required to try again.' };
  }

  const expected = {
    skillId: manifest.id,
    recipeId: recipe.id,
    contractFingerprint: ids.contractFingerprint,
    offerKind: ids.offerKind,
    preferenceMemoryId: ids.preferenceMemoryId,
  };
  let context;
  try { context = await safeAutoContext(userId, expected); } catch { context = null; }
  if (!context) {
    await inbox.updateProactiveEventByDedupKey(userId, receiptDedup, {
      text: `Automatic setup canceled for review: ${recipe.title}`,
      metadata: { executionState: 'canceled', executionCanceledAt: new Date().toISOString() },
    }).catch(() => null);
    return { handled: false, review: 'Settings or the live skill contract changed, so approval is required.' };
  }

  // Re-read all authorization inputs immediately before the tool boundary.
  try { context = await safeAutoContext(userId, expected); } catch { context = null; }
  if (!context) {
    await inbox.updateProactiveEventByDedupKey(userId, receiptDedup, {
      text: `Automatic setup canceled for review: ${recipe.title}`,
      metadata: { executionState: 'canceled', executionCanceledAt: new Date().toISOString() },
    }).catch(() => null);
    return { handled: false, review: 'Settings changed before setup, so approval is required.' };
  }

  let result;
  try {
    result = await runActivationAction(userId, agentId, {
      tool: context.recipe.activationTool,
      args: context.recipe.activationArgs,
    }, {
      activationNonce,
      skillId: manifest.id,
      watcherKind: recipe.watcherKind,
      watcherIdentity: recipe.dedupKey,
      offerKind: ids.offerKind,
      contractFingerprint: ids.contractFingerprint,
      receiptEventId: reservation.event.id,
      alwaysOn: !!manifest.always_on,
      reviewedExecutorDigest: context.reviewedExecutorDigest,
    });
  } catch (e) {
    result = { sawResult: false, isError: true, text: String(e?.message || e) };
  }

  const watcherModule = await import('../../scheduler/watchers.mjs');
  const after = watcherModule.listWatchers(userId)?.active || [];
  // Async-local provenance identifies only watchers created by this exact
  // activation invocation. Concurrent same-skill/cross-skill registrations
  // do not carry its unguessable nonce and can never become rollback victims.
  const created = after.filter(watcher => watcher?.personalizationOrigin?.activationNonce === activationNonce);
  const exact = created.find(watcher => watcherMatchesRecipe(watcher, manifest.id, recipe));
  let postAuthorized;
  try { postAuthorized = await safeAutoContext(userId, expected, { allowActive: true }); }
  catch { postAuthorized = null; }
  // Keep the watcher in non-runnable pending state until the succeeded receipt
  // is durably committed. This closes the crash window between registration
  // and receipt persistence.
  const succeeded = result.sawResult && !result.isError && !!postAuthorized
    && !!exact && created.length === 1 && created[0].id === exact.id
    && exact.onFire?.type === 'notify'
    && exact.personalizationOrigin?.contractMatch === true;

  if (!succeeded) {
    const rollback = await rollbackNewWatchers(userId, created);
    if (!rollback.complete) {
      // A partial rollback is a hard failure: block and mute the exact
      // contract before returning, so the remaining watcher can never be
      // compounded by another unattended activation.
      try {
        const policy = await import('./graduation.mjs');
        await policy.revokeKindAutoApproval(userId, ids.offerKind);
        await policy.setKindSuppressed(userId, ids.offerKind, true);
      } catch (e) {
        console.warn(`[personalization] failed to quarantine partial watcher rollback: ${e?.message || e}`);
      }
    }
    await inbox.updateProactiveEventByDedupKey(userId, receiptDedup, {
      text: `Automatic setup needs review: ${recipe.title}`,
      metadata: {
        executionState: created.length && rollback.complete ? 'rolled_back' : 'failed',
        executionFailedAt: new Date().toISOString(),
        rollbackIncomplete: !rollback.complete,
        ...(rollback.complete ? {} : {
          rollback: { watcherIds: rollback.remaining.map(watcher => watcher.id).slice(0, 8), skillId: manifest.id },
        }),
      },
    }).catch(() => null);
    return { handled: false, review: 'The skill did not create exactly the promised informational monitor, so approval is required.' };
  }

  const artifact = {
    kind: 'preference_monitor',
    watcherId: exact.id,
    skillId: manifest.id,
    watcherKind: recipe.watcherKind,
    watcherIdentity: recipe.dedupKey,
    offerKind: ids.offerKind,
    contractFingerprint: ids.contractFingerprint,
  };
  let receipt;
  try {
    receipt = await inbox.updateProactiveEventByDedupKey(userId, receiptDedup, {
      text: `Started automatically: ${recipe.title}. You can stop or undo this monitor at any time.`,
      metadata: {
        executionState: 'succeeded',
        executedAt: new Date().toISOString(),
        control: {
          actions: ['useful', 'not_useful', 'acted', 'snooze', 'edit_preference', 'stop', 'undo'],
          artifact,
          reviewedExecutorDigest: context.reviewedExecutorDigest,
          source: {
            preferenceMemoryId: ids.preferenceMemoryId,
            context: ids.utilityContextKey || 'general',
          },
        },
      },
    });
    if (!receipt) throw new Error('receipt reservation disappeared');
  } catch (e) {
    const rollback = await rollbackNewWatchers(userId, [exact]);
    if (!rollback.complete) {
      try {
        const policy = await import('./graduation.mjs');
        await policy.revokeKindAutoApproval(userId, ids.offerKind);
        await policy.setKindSuppressed(userId, ids.offerKind, true);
      } catch { /* retry/reconciliation remains fail closed */ }
    }
    console.warn(`[personalization] preference activation receipt commit failed; watcher rolled back: ${e?.message || e}`);
    return { handled: false, review: 'The receipt could not be committed, so the monitor was rolled back and approval is required.' };
  }

  // Only a committed succeeded receipt authorizes promotion to runnable.
  const marked = watcherModule.markWatcherSafeInformational(userId, exact.id, {
    activationNonce,
    skillId: manifest.id,
    watcherKind: recipe.watcherKind,
    watcherIdentity: recipe.dedupKey,
    offerKind: ids.offerKind,
    contractFingerprint: ids.contractFingerprint,
    receiptEventId: reservation.event.id,
    reviewedExecutorDigest: context.reviewedExecutorDigest,
    preferenceMemoryId: ids.preferenceMemoryId,
    utilityContextKey: ids.utilityContextKey || 'general',
  });
  if (!marked) {
    const rollback = await rollbackNewWatchers(userId, [exact]);
    if (!rollback.complete) {
      try {
        const policy = await import('./graduation.mjs');
        await policy.revokeKindAutoApproval(userId, ids.offerKind);
        await policy.setKindSuppressed(userId, ids.offerKind, true);
      } catch { /* pinned rollback authority is retried by reconciliation */ }
    }
    await inbox.updateProactiveEventByDedupKey(userId, receiptDedup, {
      text: `Automatic setup was rolled back: ${recipe.title}`,
      metadata: {
        executionState: rollback.complete ? 'rolled_back' : 'failed',
        rollbackIncomplete: !rollback.complete,
        ...(rollback.complete ? {} : {
          rollback: { watcherIds: rollback.remaining.map(watcher => watcher.id).slice(0, 8), skillId: manifest.id },
        }),
      },
    }).catch(() => null);
    return { handled: false, review: 'The watcher could not be safely finalized, so approval is required.' };
  }

  await recordPreferenceOpportunityOutcome(
    userId,
    opportunityUtilityContract(ids.contractFingerprint),
    'shown',
    {
      contextKey: ids.utilityContextKey || 'general',
      eventId: receipt.id,
    },
  );
  await deliverPreferenceActivationReceipt(userId, receipt, recipe.title).catch(e => {
    console.warn(`[personalization] preference activation receipt delivery deferred: ${e?.message || e}`);
  });
  return { handled: true };
}

/**
 * Commit an ask-first preference activation after the user approved it. The
 * activation AsyncLocal context stamps every newly registered watcher with an
 * unguessable nonce; exactly one matching watcher must exist and every other
 * nonce-stamped side effect is rolled back before this can succeed.
 */
export async function completeApprovedPreferenceActivation(
  userId, proposal, expected, activationNonce, { actionSucceeded = false } = {},
) {
  if (!userId || !expected || typeof activationNonce !== 'string' || !activationNonce) {
    return { ok: false, error: 'invalid approved preference activation context' };
  }
  const watchers = await import('../../scheduler/watchers.mjs');
  watchers.assertWatcherStoreHealthy(userId);
  const created = (watchers.listWatchers(userId)?.active || [])
    .filter(watcher => watcher?.personalizationOrigin?.activationNonce === activationNonce);
  const exact = created.filter(watcher => watcherMatchesRecipe(watcher, expected.skillId, {
    watcherKind: expected.watcherKind,
    dedupKey: expected.watcherIdentity || expected.dedupKey,
  }) && (!expected.expectedDelivery || watcher.onFire?.type === expected.expectedDelivery));
  if (!actionSucceeded || created.length !== 1 || exact.length !== 1
    || exact[0].personalizationOrigin?.type !== 'preference_approved_pending') {
    const rollback = await rollbackNewWatchers(userId, created);
    return {
      ok: false,
      error: actionSucceeded
        ? 'The skill did not create exactly the approved preference monitor.'
        : 'The activation failed and its pending monitor was rolled back.',
      rollbackComplete: rollback.complete,
    };
  }

  const watcher = exact[0];
  const inbox = await import('./proactive-inbox.mjs');
  const dedupKey = `preference-approved:${proposal?.id || activationNonce}`;
  const reservation = await inbox.reserveProactiveEvent(userId, {
    dedupKey,
    kind: AUTO_RECEIPT_KIND,
    sourceId: expected.offerKind,
    title: 'Preference monitor approved',
    text: 'Committing the preference monitor you approved.',
    metadata: {
      actionContract: 'skill_preference_activation',
      offerKind: expected.offerKind,
      activationNonce,
      recipeId: proposal?.preferenceOpportunityId || null,
      contractFingerprint: expected.contractFingerprint,
      autonomy: 'approved',
      executionState: 'started',
      executionStartedAt: new Date().toISOString(),
    },
  });
  if (!reservation.reserved) {
    await rollbackNewWatchers(userId, [watcher]);
    return { ok: false, error: 'An approved activation receipt already exists.' };
  }

  const artifact = {
    kind: 'preference_monitor', watcherId: watcher.id,
    skillId: expected.skillId, watcherKind: expected.watcherKind,
    watcherIdentity: expected.watcherIdentity || expected.dedupKey,
    offerKind: expected.offerKind, contractFingerprint: expected.contractFingerprint,
  };
  const source = {
    preferenceMemoryId: expected.preferenceMemoryId,
    context: expected.utilityContextKey || 'general',
  };
  let granted = false;
  try {
    const grants = await import('./skill-preference-grants.mjs');
    await grants.grantSkillPreference(userId, {
      skillId: expected.skillId,
      preferenceMemoryId: expected.preferenceMemoryId,
      contractFingerprint: expected.contractFingerprint,
      executorDigest: expected.executorDigest,
      manifestDigest: expected.manifestDigest,
      watcherId: watcher.id,
    });
    granted = true;
    const receipt = await inbox.updateProactiveEventByDedupKey(userId, dedupKey, {
      expectedExecutionState: 'started',
      text: 'Started with your approval. You can rate, snooze, edit, stop, or undo this monitor.',
      metadata: {
        executionState: 'succeeded',
        executedAt: new Date().toISOString(),
        control: {
          actions: ['useful', 'not_useful', 'acted', 'snooze', 'edit_preference', 'stop', 'undo'],
          artifact, source,
          executorDigest: expected.executorDigest,
          manifestDigest: expected.manifestDigest,
          expectedDelivery: expected.expectedDelivery,
        },
      },
    });
    if (!receipt) throw new Error('approved activation receipt could not be committed');
    const marked = watchers.markWatcherPreferenceApproved(userId, watcher.id, {
      activationNonce,
      skillId: expected.skillId,
      watcherKind: expected.watcherKind,
      watcherIdentity: expected.watcherIdentity || expected.dedupKey,
      offerKind: expected.offerKind,
      contractFingerprint: expected.contractFingerprint,
      preferenceMemoryId: expected.preferenceMemoryId,
      utilityContextKey: expected.utilityContextKey || 'general',
      executorDigest: expected.executorDigest,
      manifestDigest: expected.manifestDigest,
      expectedDelivery: expected.expectedDelivery,
      receiptEventId: reservation.event.id,
    });
    if (!marked) throw new Error('approved preference monitor could not be finalized');
    const visibleReceipt = await inbox.markProactiveEventDelivered(userId, receipt.id, {
      deliveryCount: 1, channel: 'proposal',
    });
    await recordPreferenceOpportunityOutcome(
      userId, opportunityUtilityContract(expected.contractFingerprint), 'shown',
      { contextKey: expected.utilityContextKey || 'general', eventId: receipt.id },
    );
    return { ok: true, watcher: marked, artifact, receipt: visibleReceipt || receipt };
  } catch (e) {
    await rollbackNewWatchers(userId, [watcher]);
    if (granted) {
      const grants = await import('./skill-preference-grants.mjs');
      await grants.revokeSkillPreferenceGrant(userId, {
        skillId: expected.skillId,
        preferenceMemoryId: expected.preferenceMemoryId,
        contractFingerprint: expected.contractFingerprint,
      }).catch(() => 0);
    }
    await inbox.updateProactiveEventByDedupKey(userId, dedupKey, {
      text: 'Approved preference monitor setup was rolled back safely.',
      metadata: { executionState: 'rolled_back', rollbackCompletedAt: new Date().toISOString() },
    }).catch(() => null);
    return { ok: false, error: e?.message || String(e) };
  }
}

function validMonitorArtifact(artifact) {
  const validText = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max;
  if (artifact?.kind !== 'preference_monitor'
    || !validText(artifact.watcherId)
    || !validText(artifact.skillId, 100)
    || !validText(artifact.watcherKind, 100)
    || !validText(artifact.watcherIdentity)
    || !validText(artifact.offerKind, 60)
    || !validText(artifact.contractFingerprint, 64)) return null;
  return artifact;
}

function validControlArtifact(event) {
  const artifact = validMonitorArtifact(event?.metadata?.control?.artifact);
  if (event?.kind !== AUTO_RECEIPT_KIND
    || event?.metadata?.actionContract !== 'skill_preference_activation'
    || !['succeeded', 'stopped', 'undone'].includes(event?.metadata?.executionState)
    || !artifact
    || artifact.offerKind !== event.metadata.offerKind
    || artifact.contractFingerprint !== event.metadata.contractFingerprint) return null;
  return artifact;
}

/**
 * Revalidate one promoted safe-auto watcher against its exact durable receipt
 * and every live authorization input immediately before a handler tick. This
 * intentionally repeats the reviewed-executor digest check in safeAutoContext:
 * periodic reconciliation alone leaves a window where edited custom code could
 * run under an older approval.
 */
export async function preferenceSafeAutoWatcherIsAuthorized(userId, watcher) {
  const origin = watcher?.personalizationOrigin;
  if (!userId || watcher?.userId !== userId || watcher?.status !== 'active'
    || origin?.type !== 'preference_safe_auto'
    || typeof origin.receiptEventId !== 'string' || !origin.receiptEventId) return false;

  try {
    const inbox = await import('./proactive-inbox.mjs');
    const event = await inbox.getProactiveEvent(userId, origin.receiptEventId);
    const artifact = validControlArtifact(event);
    const source = event?.metadata?.control?.source;
    const identity = watcher?.state?.dedupKey || watcher?.dedupKey;
    if (!artifact || event?.metadata?.executionState !== 'succeeded'
      || artifact.watcherId !== watcher.id
      || artifact.skillId !== watcher.skillId
      || artifact.watcherKind !== watcher.kind
      || artifact.watcherIdentity !== identity
      || artifact.watcherIdentity !== origin.watcherIdentity
      || artifact.offerKind !== origin.offerKind
      || artifact.contractFingerprint !== origin.contractFingerprint
      || typeof origin.preferenceMemoryId !== 'string'
      || source?.preferenceMemoryId !== origin.preferenceMemoryId
      || typeof origin.reviewedExecutorDigest !== 'string'
      || event.metadata?.control?.reviewedExecutorDigest !== origin.reviewedExecutorDigest
      || watcher.onFire?.type !== 'notify') return false;

    const live = await safeAutoContext(userId, {
      skillId: artifact.skillId,
      recipeId: event.metadata?.recipeId || null,
      contractFingerprint: artifact.contractFingerprint,
      offerKind: artifact.offerKind,
      preferenceMemoryId: origin.preferenceMemoryId,
    }, { allowActive: true });
    if (!live || live.reviewedExecutorDigest !== origin.reviewedExecutorDigest
      || live.match?.row?.id !== origin.preferenceMemoryId) return false;

    const current = await getPreferenceActivationWatcher(userId, {
      skillId: artifact.skillId,
      watcherKind: artifact.watcherKind,
      watcherIdentity: artifact.watcherIdentity,
    });
    return current?.id === watcher.id
      && current?.personalizationOrigin?.type === 'preference_safe_auto'
      && current.personalizationOrigin.receiptEventId === event.id
      && current.personalizationOrigin.offerKind === artifact.offerKind
      && current.personalizationOrigin.contractFingerprint === artifact.contractFingerprint;
  } catch {
    return false;
  }
}

/**
 * Revalidate one explicitly approved preference watcher. Approval authorizes
 * exactly one preference id, recipe contract, watcher, skill implementation,
 * and delivery channel. A self-authored manifest keyword is never itself a
 * profile-read grant.
 */
export async function preferenceApprovedWatcherIsAuthorized(userId, watcher) {
  const origin = watcher?.personalizationOrigin;
  if (!userId || watcher?.userId !== userId || watcher?.status !== 'active'
    || origin?.type !== 'preference_approved'
    || typeof origin.receiptEventId !== 'string' || !origin.receiptEventId
    || typeof origin.preferenceMemoryId !== 'string' || !origin.preferenceMemoryId
    || typeof origin.executorDigest !== 'string' || !/^[a-f0-9]{64}$/.test(origin.executorDigest)
    || typeof origin.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(origin.manifestDigest)
    || !APPROVED_DELIVERIES.has(origin.expectedDelivery)
    || watcher.onFire?.type !== origin.expectedDelivery) return false;

  try {
    const cfg = await getConfig(userId);
    if (cfg.enabled !== true || cfg.setupComplete !== true || cfg.proactivity === 'quiet') return false;

    const inbox = await import('./proactive-inbox.mjs');
    const event = await inbox.getProactiveEvent(userId, origin.receiptEventId);
    const artifact = validControlArtifact(event);
    const source = event?.metadata?.control?.source;
    const identity = watcher?.state?.dedupKey || watcher?.dedupKey;
    if (!artifact || event?.metadata?.executionState !== 'succeeded'
      || event?.metadata?.autonomy !== 'approved'
      || artifact.watcherId !== watcher.id
      || artifact.skillId !== watcher.skillId
      || artifact.watcherKind !== watcher.kind
      || artifact.watcherIdentity !== identity
      || artifact.watcherIdentity !== origin.watcherIdentity
      || artifact.offerKind !== origin.offerKind
      || artifact.contractFingerprint !== origin.contractFingerprint
      || source?.preferenceMemoryId !== origin.preferenceMemoryId
      || event.metadata?.control?.executorDigest !== origin.executorDigest
      || event.metadata?.control?.manifestDigest !== origin.manifestDigest
      || event.metadata?.control?.expectedDelivery !== origin.expectedDelivery) return false;

    const entries = await visibleCustomRecipes(userId);
    const found = entries.find(({ manifest, recipe }) => manifest.id === watcher.skillId
      && recipeContractFingerprint(manifest, recipe) === origin.contractFingerprint
      && recipeOfferKind(manifest, recipe) === origin.offerKind
      && recipe.watcherKind === watcher.kind
      && recipe.dedupKey === identity
      && (recipe.activationArgs?.deliver || 'notify') === origin.expectedDelivery);
    if (!found) return false;

    const [{ isSandboxedSkill }, { assertSkillToolAutomationAllowed }, policy, grants] = await Promise.all([
      import('../../roles.mjs'),
      import('../skill-overrides.mjs'),
      import('./graduation.mjs'),
      import('./skill-preference-grants.mjs'),
    ]);
    if (!isSandboxedSkill(found.manifest.id, userId)
      || !assertSkillToolAutomationAllowed(
        userId, found.manifest.id, found.recipe.activationTool, !!found.manifest.always_on,
      )
      || await policy.isKindSuppressed(userId, origin.offerKind)) return false;

    const currentIdentity = grants.currentSkillGrantIdentity(userId, found.manifest);
    if (!currentIdentity
      || currentIdentity.executorDigest !== origin.executorDigest
      || currentIdentity.manifestDigest !== origin.manifestDigest) return false;
    const grantRows = await grants.grantedPreferenceGrantsForSkill(userId, watcher.skillId);
    const exactGrant = grantRows.some(grant => grant.watcherId === watcher.id
      && grant.preferenceMemoryId === origin.preferenceMemoryId
      && grant.contractFingerprint === origin.contractFingerprint
      && grant.executorDigest === origin.executorDigest
      && grant.manifestDigest === origin.manifestDigest);
    if (!exactGrant) return false;

    const preferences = await confirmedPreferenceRows(userId);
    const sourcePreference = preferences.find(row => row.id === origin.preferenceMemoryId);
    if (!sourcePreference
      || !matchingPreference(preferences, found.recipe, found.manifest.id, {
        preferenceMemoryId: origin.preferenceMemoryId,
      })) return false;

    const current = await getPreferenceActivationWatcher(userId, {
      skillId: artifact.skillId,
      watcherKind: artifact.watcherKind,
      watcherIdentity: artifact.watcherIdentity,
    });
    return current?.id === watcher.id
      && current?.personalizationOrigin?.type === 'preference_approved'
      && current.personalizationOrigin.receiptEventId === event.id
      && current.personalizationOrigin.preferenceMemoryId === origin.preferenceMemoryId;
  } catch {
    return false;
  }
}

/** Apply an exact watcher artifact control; used by proposal Undo and receipts. */
export async function controlPreferenceMonitorArtifact(userId, artifactValue, action = 'undo') {
  const artifact = validMonitorArtifact(artifactValue);
  if (!userId || !artifact || !['stop', 'undo'].includes(action)) {
    return { ok: false, error: 'invalid preference monitor artifact or action' };
  }

  // Block unattended reactivation before removing the watcher. Undo leaves
  // ask-first suggestions available; Stop additionally mutes the kind.
  const policy = await import('./graduation.mjs');
  const blocked = await policy.revokeKindAutoApproval(userId, artifact.offerKind);
  if (!blocked?.ok) return { ok: false, error: 'could not return this monitor to ask-first' };
  if (action === 'stop') {
    const suppressed = await policy.setKindSuppressed(userId, artifact.offerKind, true);
    if (!suppressed?.ok) return { ok: false, error: 'could not suppress this monitor contract' };
  }

  // Once policy blocks future delivery, neutralize already-queued updates
  // before touching the independently-fallible watcher store.
  const { cancelPendingProactiveEventsBySource } = await import('./proactive-inbox.mjs');
  const canceledUpdates = await cancelPendingProactiveEventsBySource(
    userId, 'preference_monitor_update', artifact.watcherId, { reason: action },
  );

  const watchers = await import('../../scheduler/watchers.mjs');
  watchers.assertWatcherStoreHealthy(userId);
  const current = (watchers.listWatchers(userId)?.active || [])
    .find(watcher => watcher?.id === artifact.watcherId) || null;
  const approvedOrigin = current?.personalizationOrigin?.type === 'preference_approved'
    ? current.personalizationOrigin : null;
  if (current) {
    const identity = current?.personalizationOrigin?.watcherIdentity
      || current?.state?.dedupKey || current?.dedupKey;
    if (current.skillId !== artifact.skillId || current.kind !== artifact.watcherKind
      || identity !== artifact.watcherIdentity) {
      return { ok: false, error: 'live watcher no longer matches this artifact' };
    }
  }
  const stopped = current
    ? watchers.unregisterWatcher(userId, artifact.watcherId, action === 'undo' ? 'undone' : 'stopped')
    : false;
  let grantRevoked = 0;
  if (approvedOrigin) {
    try {
      const grants = await import('./skill-preference-grants.mjs');
      grantRevoked = await grants.revokeSkillPreferenceGrant(userId, {
        skillId: artifact.skillId,
        preferenceMemoryId: approvedOrigin.preferenceMemoryId,
        contractFingerprint: artifact.contractFingerprint,
      });
    } catch (e) {
      console.warn(`[personalization] inactive preference grant cleanup deferred: ${e?.message || e}`);
    }
  }
  return {
    ok: true, action, stopped, alreadyStopped: !current,
    canceledUpdates, grantRevoked, artifact,
  };
}

/**
 * Exact event control for authenticated UI/NL callers.
 * - undo: stop this watcher and return the contract to ask-first.
 * - stop: same, plus manually suppress future suggestions for the contract.
 */
async function controlPreferenceAutomationReceiptUnlocked(userId, eventId, action) {
  if (!userId || !eventId || !['stop', 'undo'].includes(action)) {
    return { ok: false, error: 'action must be stop or undo' };
  }
  const inbox = await import('./proactive-inbox.mjs');
  const event = await inbox.getProactiveEvent(userId, eventId);
  if (!event) return { ok: false, error: 'receipt not found' };
  const artifact = validControlArtifact(event);
  if (!artifact) return { ok: false, error: 'receipt has no valid preference monitor control' };
  const source = event.metadata?.control?.source;
  const contract = opportunityUtilityContract(artifact.contractFingerprint);
  const sourceContext = source?.context || source?.utilityContextKey;
  const contextKey = typeof sourceContext === 'string'
    && /^[a-z][a-z0-9_-]{0,39}$/.test(sourceContext)
    ? sourceContext : 'general';
  const currentState = event.metadata?.executionState;
  if (currentState === 'stopped' || currentState === 'undone') {
    const matching = (currentState === 'stopped' && action === 'stop')
      || (currentState === 'undone' && action === 'undo');
    if (!matching) {
      return { ok: false, error: `receipt is already ${currentState}; use behavior settings for a new policy change` };
    }
    await recordPreferenceOpportunityOutcome(userId, contract,
      action === 'stop' ? 'stopped' : 'undone', {
        contextKey, eventId: `control:${event.id}:${action}`,
      });
    try {
      const grants = await import('./skill-preference-grants.mjs');
      await grants.revokeSkillPreferenceGrant(userId, {
        skillId: artifact.skillId,
        preferenceMemoryId: source?.preferenceMemoryId || null,
        contractFingerprint: artifact.contractFingerprint,
      });
    } catch { /* inactive grants remain fail-closed and cleanup can retry */ }
    return { ok: true, action, stopped: false, alreadyStopped: true, receiptUpdated: true, event };
  }
  const controlled = await controlPreferenceMonitorArtifact(userId, artifact, action);
  if (!controlled.ok) return controlled;
  let updated = null;
  try {
    updated = await inbox.updateProactiveEventByDedupKey(userId, event.dedupKey, {
      expectedExecutionState: 'succeeded',
      text: action === 'undo'
        ? 'Automatic preference monitor undone. Future setup will ask first.'
        : 'Preference monitor stopped. This contract will stay muted.',
      metadata: {
        executionState: action === 'undo' ? 'undone' : 'stopped',
        controlledAt: new Date().toISOString(),
        control: {
          ...event.metadata.control, actions: [], action,
          state: action === 'undo' ? 'undone' : 'stopped',
        },
      },
    });
  } catch (e) {
    console.warn(`[personalization] monitor stopped but receipt update failed: ${e?.message || e}`);
  }
  await recordPreferenceOpportunityOutcome(userId, contract,
    action === 'stop' ? 'stopped' : 'undone', {
      contextKey, eventId: `control:${event.id}:${action}`,
    });
  if (event.metadata?.autonomy === 'approved') {
    try {
      const grants = await import('./skill-preference-grants.mjs');
      await grants.revokeSkillPreferenceGrant(userId, {
        skillId: artifact.skillId,
        preferenceMemoryId: source?.preferenceMemoryId || null,
        contractFingerprint: artifact.contractFingerprint,
      });
    } catch { /* inactive grant is fail-closed without its watcher */ }
  }
  const currentEvent = updated || await inbox.getProactiveEvent(userId, event.id).catch(() => null);
  return { ...controlled, receiptUpdated: !!updated, event: currentEvent || event };
}

export async function controlPreferenceAutomationReceipt(userId, eventId, action) {
  if (!userId || !eventId) return { ok: false, error: 'action must be stop or undo' };
  return serializeReceiptControl(
    userId, eventId,
    () => controlPreferenceAutomationReceiptUnlocked(userId, eventId, action),
  );
}

/**
 * Learn from one visible proactive monitor receipt/update. Feedback is tied to
 * the exact immutable activation contract, never to display prose. "Not
 * useful" stops the live monitor and returns it to ask-first; Snooze postpones
 * only this watcher and is intentionally neutral utility evidence.
 */
async function feedbackPreferenceAutomationReceiptUnlocked(
  userId, eventId, outcome, { snoozeDays = 7 } = {},
) {
  const allowed = new Set(['useful', 'not_useful', 'acted', 'snooze']);
  if (!userId || !eventId || !allowed.has(outcome)) {
    return { ok: false, error: 'outcome must be useful, not_useful, acted, or snooze' };
  }
  const inbox = await import('./proactive-inbox.mjs');
  const sourceEvent = await inbox.getProactiveEvent(userId, eventId);
  if (!sourceEvent) return { ok: false, error: 'proactive item not found' };
  let receipt = sourceEvent;
  if (sourceEvent.kind === 'preference_monitor_update') {
    const receiptId = sourceEvent.metadata?.control?.eventId;
    if (typeof receiptId !== 'string' || !receiptId) {
      return { ok: false, error: 'update has no valid activation receipt' };
    }
    receipt = await inbox.getProactiveEvent(userId, receiptId);
  }
  const artifact = validControlArtifact(receipt);
  if (!artifact || receipt?.metadata?.executionState !== 'succeeded') {
    return { ok: false, error: 'preference monitor is no longer active' };
  }
  const source = receipt.metadata?.control?.source;
  const sourceContext = source?.context || source?.utilityContextKey;
  const contextKey = typeof sourceContext === 'string'
    && /^[a-z][a-z0-9_-]{0,39}$/.test(sourceContext)
    ? sourceContext : 'general';
  const contract = opportunityUtilityContract(artifact.contractFingerprint);

  if (outcome === 'snooze') {
    const days = Math.max(1, Math.min(30, Math.floor(Number(snoozeDays) || 7)));
    const until = Date.now() + days * 86_400_000;
    const watchers = await import('../../scheduler/watchers.mjs');
    const snoozed = watchers.snoozeWatcher(userId, artifact.watcherId, until);
    if (!snoozed) return { ok: false, error: 'monitor could not be snoozed' };
    const canceledUpdates = await inbox.cancelPendingProactiveEventsBySource(
      userId, 'preference_monitor_update', artifact.watcherId, { reason: 'snoozed' },
    );
    const updated = await inbox.updateProactiveEventByDedupKey(userId, receipt.dedupKey, {
      expectedExecutionState: 'succeeded',
      metadata: {
        control: {
          ...receipt.metadata.control,
          snoozedUntil: new Date(until).toISOString(),
          lastFeedback: { outcome, at: new Date().toISOString(), sourceEventId: sourceEvent.id },
        },
      },
    });
    if (!updated) return { ok: false, error: 'preference monitor is no longer active' };
    return {
      ok: true, outcome, snoozedUntil: new Date(until).toISOString(),
      canceledUpdates, event: updated || receipt,
    };
  }

  const recorded = await recordPreferenceOpportunityOutcome(userId, contract, outcome, {
    contextKey,
    eventId: `feedback:${sourceEvent.id}:${outcome}`,
  });

  if (outcome === 'not_useful') {
    const controlled = await controlPreferenceAutomationReceiptUnlocked(userId, receipt.id, 'undo');
    if (!controlled.ok) return controlled;
    return { ...controlled, ok: true, outcome, learned: !!recorded };
  }

  if (!recorded) return { ok: false, error: 'feedback could not be saved' };

  const updated = await inbox.updateProactiveEventByDedupKey(userId, receipt.dedupKey, {
    expectedExecutionState: 'succeeded',
    metadata: {
      control: {
        ...receipt.metadata.control,
        lastFeedback: { outcome, at: new Date().toISOString(), sourceEventId: sourceEvent.id },
      },
    },
  });
  if (!updated) return { ok: false, error: 'preference monitor is no longer active' };
  return { ok: true, outcome, learned: true, duplicate: recorded.duplicate === true, event: updated || receipt };
}

export async function feedbackPreferenceAutomationReceipt(
  userId, eventId, outcome, options = {},
) {
  if (!userId || !eventId) {
    return { ok: false, error: 'outcome must be useful, not_useful, acted, or snooze' };
  }
  let canonicalReceiptId = eventId;
  try {
    const inbox = await import('./proactive-inbox.mjs');
    const source = await inbox.getProactiveEvent(userId, eventId);
    if (source?.kind === 'preference_monitor_update'
      && typeof source.metadata?.control?.eventId === 'string'
      && source.metadata.control.eventId) canonicalReceiptId = source.metadata.control.eventId;
  } catch {
    // The unlocked controller returns the canonical not-found/error response.
  }
  return serializeReceiptControl(
    userId, canonicalReceiptId,
    () => feedbackPreferenceAutomationReceiptUnlocked(userId, eventId, outcome, options),
  );
}

/**
 * Reconcile durable automatic-monitor receipts against live consent,
 * preference, manifest, policy, and watcher state. Called even while the
 * master switch is off so disabling Personalization stops previously-created
 * unattended monitors instead of merely preventing new ones.
 */
export async function reconcilePreferenceAutomationReceipts(userId) {
  if (!userId) return 0;
  const inbox = await import('./proactive-inbox.mjs');
  // Scan the inbox's full bounded activation history. Filtering after a
  // newest-100 cap can permanently starve an older still-succeeded receipt
  // once many newer terminal rows accumulate.
  const events = await inbox.listProactiveEventsByKind(userId, AUTO_RECEIPT_KIND, { limit: 500 });
  let reconciled = 0;

  for (const event of events) {
    // Retry an exact, previously-incomplete rollback before doing anything
    // else. These rows are pinned by proactive-inbox until cleanup succeeds.
    if (event?.metadata?.rollbackIncomplete === true) {
      const ids = Array.isArray(event.metadata?.rollback?.watcherIds)
        ? new Set(event.metadata.rollback.watcherIds.filter(id => typeof id === 'string')) : new Set();
      const skillId = event.metadata?.rollback?.skillId;
      const activationNonce = event.metadata?.activationNonce;
      const watcherModule = await import('../../scheduler/watchers.mjs');
      watcherModule.assertWatcherStoreHealthy(userId);
      const targets = (watcherModule.listWatchers(userId)?.active || [])
        .filter(watcher => ids.has(watcher?.id)
          && (skillId ? watcher?.skillId === skillId
            : watcher?.personalizationOrigin?.activationNonce === activationNonce));
      const rollback = await rollbackNewWatchers(userId, targets);
      for (const target of targets) {
        const origin = target?.personalizationOrigin;
        if (!String(origin?.type || '').startsWith('preference_approved')) continue;
        try {
          const grants = await import('./skill-preference-grants.mjs');
          await grants.revokeSkillPreferenceGrant(userId, {
            skillId: target.skillId,
            preferenceMemoryId: origin.preferenceMemoryId || null,
            contractFingerprint: origin.contractFingerprint || event.metadata?.contractFingerprint,
          });
        } catch { /* watcher removal already makes the grant inert */ }
      }
      if (rollback.complete) {
        await inbox.updateProactiveEventByDedupKey(userId, event.dedupKey, {
          text: 'Automatic preference monitor setup was rolled back safely.',
          metadata: {
            executionState: 'rolled_back', rollbackIncomplete: false,
            rollbackCompletedAt: new Date().toISOString(),
          },
        }).catch(() => null);
        reconciled++;
      }
      continue;
    }

    const executionState = event?.metadata?.executionState;
    const activationNonce = event?.metadata?.activationNonce;
    if (['started', 'canceled', 'failed', 'rolled_back'].includes(executionState)
      && typeof activationNonce === 'string') {
      const startedMs = Date.parse(event.metadata?.executionStartedAt || '');
      if (executionState === 'started' && Number.isFinite(startedMs)
        && Date.now() - startedMs < STALE_ACTIVATION_MS) continue;
      const watcherModule = await import('../../scheduler/watchers.mjs');
      watcherModule.assertWatcherStoreHealthy(userId);
      const targets = (watcherModule.listWatchers(userId)?.active || [])
        .filter(watcher => watcher?.personalizationOrigin?.activationNonce === activationNonce);
      const rollback = await rollbackNewWatchers(userId, targets);
      for (const target of targets) {
        const origin = target?.personalizationOrigin;
        if (!String(origin?.type || '').startsWith('preference_approved')) continue;
        try {
          const grants = await import('./skill-preference-grants.mjs');
          await grants.revokeSkillPreferenceGrant(userId, {
            skillId: target.skillId,
            preferenceMemoryId: origin.preferenceMemoryId || null,
            contractFingerprint: origin.contractFingerprint || event.metadata?.contractFingerprint,
          });
        } catch { /* watcher removal already makes the grant inert */ }
      }
      if (!rollback.complete) {
        try {
          const policy = await import('./graduation.mjs');
          await policy.revokeKindAutoApproval(userId, event.metadata?.offerKind);
          await policy.setKindSuppressed(userId, event.metadata?.offerKind, true);
        } catch { /* keep the pinned retry marker */ }
      }
      await inbox.updateProactiveEventByDedupKey(userId, event.dedupKey, {
        text: rollback.complete
          ? 'Incomplete automatic preference monitor setup was rolled back safely.'
          : 'Automatic preference monitor cleanup needs review.',
        metadata: {
          executionState: rollback.complete ? 'rolled_back' : 'failed',
          rollbackIncomplete: !rollback.complete,
          rollbackCompletedAt: rollback.complete ? new Date().toISOString() : null,
          ...(rollback.complete ? {} : {
            rollback: {
              watcherIds: rollback.remaining.map(watcher => watcher.id).slice(0, 8),
              skillId: rollback.remaining[0]?.skillId || targets[0]?.skillId
                || event.metadata?.rollback?.skillId || null,
            },
          }),
        },
      }).catch(() => null);
      if (targets.length || executionState === 'started') reconciled++;
      continue;
    }

    if (event?.metadata?.executionState !== 'succeeded') continue;
    const artifact = validControlArtifact(event);
    if (!artifact) continue; // corrupt control metadata never authorizes a stop

    let authorized = false;
    try {
      const current = await getPreferenceActivationWatcher(userId, {
        skillId: artifact.skillId,
        watcherKind: artifact.watcherKind,
        watcherIdentity: artifact.watcherIdentity,
      });
      authorized = current?.id === artifact.watcherId
        && (event.metadata?.autonomy === 'approved'
          ? await preferenceApprovedWatcherIsAuthorized(userId, current)
          : await preferenceSafeAutoWatcherIsAuthorized(userId, current));
    } catch { authorized = false; }
    if (authorized) continue;

    const controlled = await controlPreferenceMonitorArtifact(userId, artifact, 'undo');
    if (!controlled.ok) {
      // At minimum block future unattended setup when a corrupt/mismatched
      // live watcher prevents an exact unregister.
      try {
        const { revokeKindAutoApproval } = await import('./graduation.mjs');
        await revokeKindAutoApproval(userId, artifact.offerKind);
      } catch { /* next sweep retries */ }
      continue;
    }
    await inbox.updateProactiveEventByDedupKey(userId, event.dedupKey, {
      expectedExecutionState: 'succeeded',
      text: 'Automatic preference monitor stopped because its authorization or live contract changed.',
      metadata: {
        executionState: 'stopped', controlledAt: new Date().toISOString(),
        control: {
          ...event.metadata.control,
          actions: [],
          action: 'reconcile',
          state: 'stopped',
        },
      },
    }).catch(() => null);
    reconciled++;
  }
  return reconciled;
}

/**
 * Handle at most one preference opportunity per pass: either a verified
 * informational safe-auto activation with receipt, or an ask-first proposal.
 * Returns 0/1. Existing active watchers and pending cards are skipped.
 */
async function discoverPreferenceOpportunitiesUnlocked(userId, { limit = 1 } = {}) {
  if (!userId) return 0;
  const cfg = await getConfig(userId);
  if (cfg.enabled !== true || cfg.setupComplete !== true || cfg.proactivity === 'quiet'
    || !(Number(cfg.maxOffersPerRun) > 0) || !(Number(limit) > 0)) return 0;
  // Timing is a delivery/defer decision, not evidence that the opportunity
  // should be downgraded from Safe initiative to a month-long ask-first card.
  // Re-evaluate on the next event/sweep after quiet hours instead.
  try {
    const { isQuietHours } = await import('./config.mjs');
    if (typeof isQuietHours === 'function' && isQuietHours(cfg, new Date())) return 0;
  } catch {
    // A broken timing resolver must not create an unsolicited opportunity.
    return 0;
  }

  const preferences = await confirmedPreferenceRows(userId);
  if (!preferences.length) return 0;

  const [{ listWatchers }, proposals, { getUserCoordinatorAgentId }] = await Promise.all([
    import('../../scheduler/watchers.mjs'),
    import('../proposals.mjs'),
    import('../../routes/_helpers.mjs'),
  ]);
  const active = listWatchers(userId)?.active || [];
  const pending = proposals.listUserProposals(userId, 'pending');
  const recentCutoff = Date.now() - 30 * 86_400_000;
  const recent = proposals.listUserProposals(userId, null);
  const coordId = getUserCoordinatorAgentId(userId);
  if (!coordId) return 0;

  for (const { manifest, recipe, profileRole } of await visibleCustomRecipes(userId)) {
    const match = matchingPreference(preferences, recipe, manifest.id);
    if (!match) continue;
    if (active.some(watcher => watcherMatchesRecipe(watcher, manifest.id, recipe))) continue;
    const activationKey = `${manifest.id}:${recipe.id}`;
    if (pending.some(proposal => proposal.actionContract === 'skill_preference_activation'
      && proposal.activationKey === activationKey)) continue;
    if (recent.some(proposal => proposal.actionContract === 'skill_preference_activation'
      && proposal.activationKey === activationKey && Number(proposal.createdAt) >= recentCutoff)) continue;

    const contractFingerprint = recipeContractFingerprint(manifest, recipe);
    const offerKind = recipeOfferKind(manifest, recipe);
    const opportunityId = offerKind;
    const { isKindSuppressed, isKindSafeAutoAllowed } = await import('./graduation.mjs');
    if (await isKindSuppressed(userId, offerKind)) continue;
    const safeAutoAllowed = await isKindSafeAutoAllowed(userId, offerKind);
    const utilityPolicy = await preferenceOpportunityUtilityPolicy(
      userId, cfg, { manifest, recipe, profileRole }, match,
      { contractFingerprint, offerKind }, safeAutoAllowed,
    );
    if (utilityPolicy.recommendation === 'shadow') {
      if (utilityPolicy.reason === 'new-contract-shadow') {
        const bucket = Math.floor(Date.now() / (6 * 3_600_000));
        await recordPreferenceOpportunityOutcome(userId, utilityPolicy.contract, 'shadowed', {
          contextKey: utilityPolicy.contextKey,
          eventId: `shadow:${offerKind}:${bucket}`,
        });
      }
      // Shadowing one unreviewed contract must not starve a later reviewed,
      // notify-only recipe in this same discovery pass.
      continue;
    }
    let review = '';
    if (utilityPolicy.recommendation === 'safe_auto'
      && cfg.initiativeMode === 'safe_auto' && recipe.autoEligible && profileRole !== 'child'
      && safeAutoAllowed) {
      const automatic = await autoActivatePreferenceOpportunity(userId, coordId, {
        manifest, recipe, profileRole, preference: match.row,
      }, {
        activationKey, recipeId: recipe.id, contractFingerprint, offerKind, opportunityId,
        preferenceMemoryId: match.row.id,
        utilityContextKey: utilityPolicy.contextKey,
        utilityScore: utilityPolicy.score,
      });
      if (automatic.handled) return 1;
      review = automatic.review || '';
    }
    const created = await proposals.createProposal({
      id: `prop_${randomUUID().slice(0, 12)}`,
      userId,
      agentId: coordId,
      kind: 'personalization_offer',
      offerKind,
      opportunityId,
      activationKey,
      actionContract: 'skill_preference_activation',
      preferenceOpportunityId: recipe.id,
      preferenceMemoryId: match.row.id,
      skillId: manifest.id,
      autonomy: recipe.autonomy,
      contractFingerprint,
      utilityContextKey: utilityPolicy.contextKey,
      utilityScore: utilityPolicy.score,
      utilityReason: utilityPolicy.reason,
      action: { tool: recipe.activationTool, args: recipe.activationArgs },
      // Do not copy the preference statement into proposal history: deleting
      // the source preference must be enough to remove its retained wording.
      message: `${recipe.title}\n\n${[
        review,
        recipe.body || `${manifest.name || manifest.id} can use one of your confirmed preferences to watch for relevant updates and let you know when it finds one.`,
      ].filter(Boolean).join('\n\n')}`,
      accept_label: 'Turn it on',
      dismiss_label: 'Not now',
      createdAt: Date.now(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      status: 'pending',
      graduateEligible: false,
    });
    if (created) {
      await recordPreferenceOpportunityOutcome(userId, utilityPolicy.contract, 'shown', {
        contextKey: utilityPolicy.contextKey,
        eventId: created.id || `proposal:${offerKind}:${Date.now()}`,
      });
      return 1;
    }
  }
  return 0;
}

/**
 * Discover at most one preference-backed skill opportunity. All callers share
 * the same per-user serialization boundary, including event-driven explicit
 * preference capture and the periodic reflection sweep.
 */
export async function discoverPreferenceOpportunities(userId, { limit = 1 } = {}) {
  if (!userId) return 0;
  return serializeDiscovery(userId, () => discoverPreferenceOpportunitiesUnlocked(userId, { limit }));
}

/**
 * Event-driven entry point used after an explicit preference is durably
 * confirmed. It deliberately awaits the same discovery contract as the
 * scheduled sweep: the caller may fire-and-forget it, while tests and explicit
 * API flows can await it for deterministic behavior.
 */
export async function discoverPreferenceOpportunitiesNow(userId, { limit = 1 } = {}) {
  return discoverPreferenceOpportunities(userId, { limit });
}

/**
 * Event-driven profile-change hook. Reconcile existing automatic monitors
 * first (a newly stated dislike/constraint may revoke their authorization),
 * then evaluate one newly relevant opportunity. Any reconciliation failure
 * fails closed and leaves the periodic sweep to retry.
 */
export async function refreshPreferenceOpportunitiesForProfileChange(userId, { limit = 1 } = {}) {
  if (!userId) return 0;
  try {
    await reconcilePreferenceAutomationReceipts(userId);
  } catch (e) {
    console.warn(`[personalization] immediate preference reconciliation deferred: ${e?.message || e}`);
    return 0;
  }
  return discoverPreferenceOpportunities(userId, { limit });
}
