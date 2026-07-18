// @ts-check
/**
 * Proactive engagement: soft-confirm repeated lookup interest.
 *
 * Quiet / Helpful never convert a one-off "are there deals on chicken?" into
 * a preference. Proactive may notice ≥2 interactive interest observations on
 * the same skill+topic and ask once: remember this + optionally open a
 * preference monitor. Accept still requires the user; nothing starts alone.
 */
import { createHash, randomUUID } from 'crypto';
import { getConfig } from './config.mjs';
import * as personalizationConfig from './config.mjs';
import { readObservations } from './observations.mjs';
import { listLedger, upsertExplicitProfile } from './ledger.mjs';
import { canonicalPreferenceSubjectKey } from './preference-structure.mjs';
import { sanitizeSignalText } from './signal-safety.mjs';

function isQuietEngagement(cfg) {
  try {
    if (typeof personalizationConfig.isQuietEngagement === 'function') {
      return personalizationConfig.isQuietEngagement(cfg);
    }
  } catch { /* partial config mocks omit helpers */ }
  return cfg?.engagement === 'quiet' || cfg?.proactivity === 'quiet';
}

function isProactiveEngagement(cfg) {
  try {
    if (typeof personalizationConfig.isProactiveEngagement === 'function') {
      return personalizationConfig.isProactiveEngagement(cfg);
    }
    if (typeof personalizationConfig.isCompanionEngagement === 'function') {
      return personalizationConfig.isCompanionEngagement(cfg);
    }
  } catch { /* partial config mocks omit helpers */ }
  return cfg?.engagement === 'proactive' || cfg?.engagement === 'companion';
}

const INTEREST_LOOKBACK_MS = 30 * 86_400_000;
const MIN_INTEREST_COUNT = 2;
const COOLDOWN_MS = 30 * 86_400_000;
const MAX_TOPIC_LEN = 80;
const OFFER_KIND_PREFIX = 'interest-confirm-';

const _tails = new Map();

function serialize(userId, fn) {
  const previous = _tails.get(userId) || Promise.resolve();
  const current = previous.catch(() => null).then(fn);
  _tails.set(userId, current);
  current.finally(() => {
    if (_tails.get(userId) === current) _tails.delete(userId);
  });
  return current;
}

function normalizeTopic(value) {
  const clean = sanitizeSignalText(value, MAX_TOPIC_LEN + 1);
  if (!clean) return '';
  return clean
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .slice(0, MAX_TOPIC_LEN);
}

function topicKey(skillId, topic) {
  return createHash('sha256')
    .update(`${skillId}\0${normalizeTopic(topic)}`)
    .digest('hex')
    .slice(0, 16);
}

function offerKindFor(skillId, topic) {
  return `${OFFER_KIND_PREFIX}${topicKey(skillId, topic)}`;
}

function subjectAlreadyKnown(rows, topic) {
  const want = canonicalPreferenceSubjectKey(topic);
  if (!want) return false;
  return rows.some(row => {
    if (row?.type !== 'preference' || row?.status === 'contradicted') return false;
    if (row?.tier !== 'confirmed' && row?.tier !== 'inferred') return false;
    const have = canonicalPreferenceSubjectKey(
      row?.structure?.subject || row?.subject || row?.statement,
    );
    return have && have === want && row.polarity !== 'negative';
  });
}

/**
 * Count interactive interest observations for skill+topic in the lookback window.
 * @param {string} userId
 * @param {string} skillId
 * @param {string} topic
 */
export async function countRecentInterest(userId, skillId, topic) {
  const normalized = normalizeTopic(topic);
  if (!userId || !skillId || !normalized) return 0;
  const cutoff = Date.now() - INTEREST_LOOKBACK_MS;
  const observations = await readObservations(userId, { limit: 500 });
  const seenIds = new Set();
  for (const obs of observations) {
    if (obs?.kind !== 'interest' || obs?.origin === 'automation') continue;
    if (obs?.skillId !== skillId) continue;
    const ts = Date.parse(obs.ts || '');
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const entity = Array.isArray(obs.entities) && obs.entities[0]
      ? obs.entities[0]
      : (typeof obs.digest === 'string' && obs.digest.startsWith('Lookup topic: ')
        ? obs.digest.slice('Lookup topic: '.length)
        : '');
    if (normalizeTopic(entity) !== normalized) continue;
    if (typeof obs.id === 'string' && obs.id) seenIds.add(obs.id);
    else seenIds.add(`anon_${ts}_${seenIds.size}`);
  }
  return seenIds.size;
}

/**
 * After a Proactive interest observation lands, maybe create a soft-confirm
 * card. Fire-and-forget safe: never throws to the tool path.
 */
export function queueProactiveInterestConfirm(userId, {
  skillId = null,
  topic = '',
  recipeId = null,
  agentId = null,
} = {}) {
  return queueCompanionInterestConfirm(userId, { skillId, topic, recipeId, agentId });
}

/** @deprecated use queueProactiveInterestConfirm */
export function queueCompanionInterestConfirm(userId, {
  skillId = null,
  topic = '',
  recipeId = null,
  agentId = null,
} = {}) {
  if (!userId || !skillId || !topic) return;
  Promise.resolve()
    .then(() => maybeProposeInterestConfirm(userId, { skillId, topic, recipeId, agentId }))
    .catch(e => console.warn('[personalization] interest soft-confirm deferred:', e?.message || e));
}

/**
 * @param {string} userId
 * @param {{ skillId?: string, topic?: string, recipeId?: string|null, agentId?: string|null }} args
 * @returns {Promise<boolean>}
 */
export async function maybeProposeInterestConfirm(userId, {
  skillId, topic, recipeId = null, agentId = null,
} = {}) {
  return serialize(userId, async () => {
    const cfg = await getConfig(userId);
    if (cfg.enabled !== true || cfg.setupComplete !== true) return false;
    if (isQuietEngagement(cfg) || !isProactiveEngagement(cfg)) return false;
    if (!(Number(cfg.maxOffersPerRun) > 0)) return false;

    const normalized = normalizeTopic(topic);
    if (normalized.length < 3) return false;

    const count = await countRecentInterest(userId, skillId, normalized);
    if (count < MIN_INTEREST_COUNT) return false;

    const rows = await listLedger(userId, { includeContradicted: false });
    if (subjectAlreadyKnown(rows, normalized)) return false;

    const kind = offerKindFor(skillId, normalized);
    const { isKindSuppressed } = await import('./graduation.mjs');
    if (await isKindSuppressed(userId, kind)) return false;

    const proposals = await import('../proposals.mjs');
    const pending = proposals.listUserProposals(userId, 'pending') || [];
    if (pending.some(p => p?.actionContract === 'preference_soft_confirm'
      && p?.skillId === skillId
      && normalizeTopic(p?.interestTopic) === normalized)) return false;

    const recentCutoff = Date.now() - COOLDOWN_MS;
    const recent = proposals.listUserProposals(userId, null) || [];
    if (recent.some(p => p?.actionContract === 'preference_soft_confirm'
      && p?.skillId === skillId
      && normalizeTopic(p?.interestTopic) === normalized
      && Number(p?.createdAt) >= recentCutoff)) return false;

    const { getUserCoordinatorAgentId } = await import('../../routes/_helpers.mjs');
    const coordId = getUserCoordinatorAgentId(userId) || agentId;
    if (!coordId) return false;

    // Display the original topic casing from the latest observation when possible.
    const displayTopic = sanitizeSignalText(topic, MAX_TOPIC_LEN) || normalized;
    const statement = `Likes ${displayTopic}`.slice(0, 220);

    const created = await proposals.createProposal({
      id: `prop_${randomUUID().slice(0, 12)}`,
      userId,
      agentId: coordId,
      kind: 'personalization_offer',
      offerKind: kind,
      opportunityId: kind,
      actionContract: 'preference_soft_confirm',
      skillId,
      preferenceOpportunityId: typeof recipeId === 'string' ? recipeId : null,
      interestTopic: displayTopic,
      preferenceStatement: statement,
      preferenceSubject: displayTopic,
      // No tool action — accept writes the ledger via offer-handlers.
      action: null,
      graduateEligible: false,
      message: [
        `Remember that you like ${displayTopic}?`,
        skillId
          ? `You have looked this up more than once. I can save it as a preference`
            + (recipeId ? ' and offer to watch for matching updates.' : '.')
          : 'You have looked this up more than once. I can save it as a preference.',
      ].join('\n\n'),
      accept_label: 'Yes, remember it',
      dismiss_label: 'Not now',
      createdAt: Date.now(),
      expiresAt: new Date(Date.now() + COOLDOWN_MS).toISOString(),
      status: 'pending',
    });
    return !!created;
  });
}

/**
 * Accept path: confirm the preference (skill-scoped) and refresh monitor discovery.
 * @param {object} proposal
 * @returns {Promise<{ok:boolean, row?: object|null, error?: string}>}
 */
export async function acceptInterestSoftConfirm(proposal) {
  const userId = proposal?.userId;
  const skillId = typeof proposal?.skillId === 'string' ? proposal.skillId : null;
  const subject = sanitizeSignalText(proposal?.preferenceSubject || proposal?.interestTopic, MAX_TOPIC_LEN);
  const statement = sanitizeSignalText(proposal?.preferenceStatement, 220)
    || (subject ? `Likes ${subject}` : '');
  if (!userId || !skillId || !subject || statement.length < 3) {
    return { ok: false, error: 'soft-confirm proposal is missing preference details' };
  }
  const cfg = await getConfig(userId);
  if (cfg.enabled !== true || cfg.setupComplete !== true) {
    return { ok: false, error: 'personalization is not enabled' };
  }

  const row = await upsertExplicitProfile(userId, {
    statement,
    type: 'preference',
    // Scope to the skill that observed the interest so Proactive monitor
    // matching cannot leak "likes chicken" into unrelated domains.
    scope: skillId,
    subject,
    polarity: 'positive',
    structure: {
      subject,
      sentiment: 'positive',
      context: 'purchase',
    },
    evidence: [],
    evidenceDetails: [{
      id: `soft_${topicKey(skillId, subject)}`,
      source: 'proactive interest soft-confirm',
      at: new Date().toISOString(),
      summary: `Confirmed after repeated ${skillId} lookups`,
    }],
  });
  if (!row) return { ok: false, error: 'could not save the preference' };

  try {
    const { refreshPreferenceOpportunitiesForProfileChange } = await import('./preference-opportunities.mjs');
    await refreshPreferenceOpportunitiesForProfileChange(userId, { limit: 1 });
  } catch (e) {
    console.warn('[personalization] post soft-confirm opportunity refresh deferred:', e?.message || e);
  }
  return { ok: true, row };
}
