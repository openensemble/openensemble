// @ts-check
/**
 * Privacy-bounded outcome learning for exact proactive-opportunity contracts.
 *
 * This module is intentionally advisory. A `safe_auto` recommendation is not
 * authorization to execute anything: callers must still apply the normal
 * consent, manifest, reviewed-code, child-account, quiet-hours, delivery, and
 * action-risk gates. The recommendation answers only: "given this exact
 * contract's outcomes, how cautiously should it be surfaced?"
 *
 * Storage contains no preference prose, tool arguments/results, prices, or
 * notification text. It retains only canonical contract fingerprints,
 * categorical context slugs, timestamps, and bounded counters in:
 *
 *   users/<uid>/personalization/opportunity-utility.json
 *
 * Writes are serialized, atomic, mode 0600, and the directory is mode 0700.
 * Corrupt stores fail closed and are never replaced by an empty envelope.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { USERS_DIR } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';

export const OPPORTUNITY_OUTCOMES = Object.freeze([
  'shown',
  // Candidate evaluated in shadow mode; never delivered to the user and
  // therefore never interpreted as engagement or sentiment.
  'shadowed',
  'useful',
  'not_useful',
  'acted',
  'dismissed',
  'ignored',
  'stopped',
  'undone',
]);

export const OPPORTUNITY_RECOMMENDATIONS = Object.freeze(['shadow', 'ask', 'safe_auto']);
export const OUTCOME_HALF_LIFE_DAYS = 120;

const OUTCOME_SET = new Set(OPPORTUNITY_OUTCOMES);
const POSITIVE_OUTCOMES = new Set(['useful', 'acted']);
const EXPLICIT_POSITIVE_OUTCOMES = new Set(['useful']);
const LEARNED_NEGATIVE_OUTCOMES = new Set(['not_useful', 'dismissed', 'stopped', 'undone']);
// Dismissing an ordinary proposal commonly means "not now." It contributes a
// decaying negative observation, but only an explicit "not useful," Stop, or
// Undo gets the non-decaying hard-dominance timestamp.
const DOMINATING_NEGATIVE_OUTCOMES = new Set(['not_useful', 'stopped', 'undone']);
const TERMINAL_POLICY_OUTCOMES = new Set(['stopped', 'undone']);
const ACTION_CONTRACT_RE = /^[a-z][a-z0-9_]{2,63}$/;
const CONTRACT_FINGERPRINT_RE = /^[a-f0-9]{16,64}$/;
const CONTEXT_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CONTRACTS = 200;
const MAX_CONTEXTS_PER_CONTRACT = 12;
const MAX_RECENT_EVENT_IDS = 64;
const MAX_TOTAL_COUNT = 1_000_000_000;
const MAX_EFFECTIVE_COUNT = 1_000_000;
const DEFAULT_CONTEXT = 'general';

const FACTOR_DEFAULTS = Object.freeze({
  preferenceConfidence: 0,
  relevance: 0,
  novelty: 0.5,
  timing: 0.5,
  savings: 0,
  interruptionCost: 0.5,
});

const FACTOR_WEIGHTS = Object.freeze({
  preferenceConfidence: 0.20,
  relevance: 0.25,
  novelty: 0.10,
  timing: 0.15,
  savings: 0.15,
  interruptionCost: 0.15,
});

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}

function utilityPath(userId) {
  return path.join(personalizationDir(userId), 'opportunity-utility.json');
}

function requireUserId(userId) {
  if (!USER_ID_RE.test(String(userId || ''))) {
    throw new Error('opportunity utility: userId must be a canonical profile id');
  }
  return String(userId);
}

/**
 * Build the stable identity used by both storage and callers. The existing
 * preference-opportunity bridge supplies `actionContract` and its SHA-256
 * `contractFingerprint`; no display label or model-generated text participates
 * in identity.
 */
export function canonicalOpportunityContractId(contract) {
  const actionContract = String(contract?.actionContract || '');
  const contractFingerprint = String(contract?.contractFingerprint || '');
  if (!ACTION_CONTRACT_RE.test(actionContract)) {
    throw new Error('opportunity utility: actionContract is not canonical');
  }
  if (!CONTRACT_FINGERPRINT_RE.test(contractFingerprint)) {
    throw new Error('opportunity utility: contractFingerprint must be 16-64 lowercase hex characters');
  }
  return `${actionContract}:${contractFingerprint}`;
}

export function canonicalOpportunityContextKey(value = DEFAULT_CONTEXT) {
  const contextKey = value == null || value === '' ? DEFAULT_CONTEXT : String(value);
  if (!CONTEXT_RE.test(contextKey)) {
    throw new Error('opportunity utility: contextKey must be a lowercase categorical slug');
  }
  return contextKey;
}

function parseContractId(id) {
  const split = String(id || '').lastIndexOf(':');
  if (split < 1) throw new Error('invalid opportunity contract id');
  const contract = {
    actionContract: id.slice(0, split),
    contractFingerprint: id.slice(split + 1),
  };
  if (canonicalOpportunityContractId(contract) !== id) throw new Error('invalid opportunity contract id');
  return contract;
}

function emptyCounts() {
  return Object.fromEntries(OPPORTUNITY_OUTCOMES.map(outcome => [outcome, 0]));
}

function emptyEvidence(at = new Date().toISOString()) {
  return {
    anchorAt: at,
    counts: emptyCounts(),
    positiveSinceNegative: 0,
    usefulSinceNegative: 0,
    lastOutcomeAt: null,
    lastExplicitPositiveAt: null,
    lastExplicitNegativeAt: null,
    lastExplicitOutcome: null,
  };
}

function emptyRecord(contract, at) {
  return {
    actionContract: contract.actionContract,
    contractFingerprint: contract.contractFingerprint,
    createdAt: at,
    updatedAt: at,
    totals: emptyCounts(),
    evidence: emptyEvidence(at),
    contexts: Object.create(null),
    policyOutcome: null,
    policyOutcomeAt: null,
    recentEvents: [],
  };
}

function cleanCounter(value, { integer = false, name = 'counter' } = {}) {
  if (value == null) return 0;
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`invalid opportunity utility ${name}`);
  }
  return Math.min(integer ? MAX_TOTAL_COUNT : MAX_EFFECTIVE_COUNT, value);
}

function cleanTimestamp(value, { nullable = true, name = 'timestamp' } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid opportunity utility ${name}`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizeCounts(value, { integer = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid opportunity utility counts');
  }
  const out = {};
  for (const outcome of OPPORTUNITY_OUTCOMES) {
    out[outcome] = cleanCounter(value[outcome], { integer, name: `${outcome} count` });
  }
  return out;
}

function normalizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid opportunity utility evidence');
  }
  const lastExplicitOutcome = value.lastExplicitOutcome == null
    ? null : String(value.lastExplicitOutcome);
  if (lastExplicitOutcome != null
    && !EXPLICIT_POSITIVE_OUTCOMES.has(lastExplicitOutcome)
    && !DOMINATING_NEGATIVE_OUTCOMES.has(lastExplicitOutcome)) {
    throw new Error('invalid opportunity utility explicit outcome');
  }
  return {
    anchorAt: cleanTimestamp(value.anchorAt, { nullable: false, name: 'evidence anchor' }),
    counts: normalizeCounts(value.counts),
    positiveSinceNegative: cleanCounter(value.positiveSinceNegative, {
      integer: true, name: 'positiveSinceNegative',
    }),
    usefulSinceNegative: cleanCounter(value.usefulSinceNegative, {
      integer: true, name: 'usefulSinceNegative',
    }),
    lastOutcomeAt: cleanTimestamp(value.lastOutcomeAt),
    lastExplicitPositiveAt: cleanTimestamp(value.lastExplicitPositiveAt),
    lastExplicitNegativeAt: cleanTimestamp(value.lastExplicitNegativeAt),
    lastExplicitOutcome,
  };
}

function normalizeRecord(id, value) {
  const contract = parseContractId(id);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.actionContract !== contract.actionContract
    || value.contractFingerprint !== contract.contractFingerprint) {
    throw new Error('invalid opportunity utility contract record');
  }
  if (!value.contexts || typeof value.contexts !== 'object' || Array.isArray(value.contexts)) {
    throw new Error('invalid opportunity utility contexts');
  }
  const contexts = Object.create(null);
  const entries = Object.entries(value.contexts);
  if (entries.length > MAX_CONTEXTS_PER_CONTRACT) {
    throw new Error('opportunity utility context bound exceeded');
  }
  for (const [contextKey, evidence] of entries) {
    canonicalOpportunityContextKey(contextKey);
    contexts[contextKey] = normalizeEvidence(evidence);
  }
  const policyOutcome = value.policyOutcome == null ? null : String(value.policyOutcome);
  if (policyOutcome != null && !TERMINAL_POLICY_OUTCOMES.has(policyOutcome)) {
    throw new Error('invalid opportunity utility policy outcome');
  }
  const recentEvents = Array.isArray(value.recentEvents) ? value.recentEvents : [];
  if (recentEvents.length > MAX_RECENT_EVENT_IDS
    || recentEvents.some(item => !item || typeof item !== 'object'
      || !/^[a-f0-9]{24}$/.test(String(item.id || ''))
      || !Number.isFinite(Date.parse(item.at || '')))) {
    throw new Error('invalid opportunity utility event deduplication data');
  }
  return {
    actionContract: contract.actionContract,
    contractFingerprint: contract.contractFingerprint,
    createdAt: cleanTimestamp(value.createdAt, { nullable: false, name: 'record createdAt' }),
    updatedAt: cleanTimestamp(value.updatedAt, { nullable: false, name: 'record updatedAt' }),
    totals: normalizeCounts(value.totals, { integer: true }),
    evidence: normalizeEvidence(value.evidence),
    contexts,
    policyOutcome,
    policyOutcomeAt: cleanTimestamp(value.policyOutcomeAt),
    recentEvents: recentEvents.map(item => ({
      id: String(item.id), at: new Date(Date.parse(item.at)).toISOString(),
    })),
  };
}

function emptyStore() {
  return { version: 0, contracts: Object.create(null) };
}

function readStore(userId) {
  const file = utilityPath(userId);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Number.isInteger(value.version) || value.version < 0
      || !value.contracts || typeof value.contracts !== 'object' || Array.isArray(value.contracts)) {
      throw new Error('invalid utility store envelope');
    }
    const entries = Object.entries(value.contracts);
    if (entries.length > MAX_CONTRACTS) throw new Error('utility store contract bound exceeded');
    const contracts = Object.create(null);
    for (const [id, record] of entries) contracts[id] = normalizeRecord(id, record);
    return { version: value.version, contracts };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    throw new Error(`Personalization opportunity outcomes are unreadable: ${error?.message || error}`);
  }
}

function secureDir(userId) {
  const dir = personalizationDir(userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX */ }
}

function writeStore(userId, store) {
  secureDir(userId);
  const file = utilityPath(userId);
  atomicWriteSync(file, JSON.stringify({
    version: store.version + 1,
    updated_at: Date.now(),
    contracts: store.contracts,
  }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on non-POSIX */ }
}

function roundEvidence(value) {
  return Math.round(Math.min(MAX_EFFECTIVE_COUNT, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

/**
 * Exponentially decay effective evidence without altering immutable totals.
 * Exported for deterministic policy tests and offline diagnostics.
 */
export function decayOpportunityEvidence(value, {
  now = new Date(), halfLifeDays = OUTCOME_HALF_LIFE_DAYS,
} = {}) {
  const evidence = normalizeEvidence(value);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const halfLifeMs = Number(halfLifeDays) * 86_400_000;
  if (!Number.isFinite(nowMs) || !(halfLifeMs > 0)) {
    throw new Error('opportunity utility: valid now and positive halfLifeDays required');
  }
  const anchorMs = Date.parse(evidence.anchorAt);
  const elapsed = Math.max(0, nowMs - anchorMs);
  const factor = Math.pow(0.5, elapsed / halfLifeMs);
  return {
    ...evidence,
    anchorAt: new Date(Math.max(nowMs, anchorMs)).toISOString(),
    counts: Object.fromEntries(OPPORTUNITY_OUTCOMES.map(outcome => [
      outcome, roundEvidence(evidence.counts[outcome] * factor),
    ])),
  };
}

function incrementEvidence(value, outcome, atMs) {
  const effectiveAt = Math.max(atMs, Date.parse(value.anchorAt));
  const evidence = decayOpportunityEvidence(value, { now: new Date(effectiveAt) });
  evidence.counts[outcome] = roundEvidence(evidence.counts[outcome] + 1);
  evidence.lastOutcomeAt = new Date(Math.max(
    effectiveAt, Date.parse(evidence.lastOutcomeAt || '') || 0,
  )).toISOString();

  if (POSITIVE_OUTCOMES.has(outcome)) {
    evidence.positiveSinceNegative = Math.min(MAX_TOTAL_COUNT, evidence.positiveSinceNegative + 1);
    if (outcome === 'useful') evidence.usefulSinceNegative = Math.min(MAX_TOTAL_COUNT, evidence.usefulSinceNegative + 1);
  }
  if (LEARNED_NEGATIVE_OUTCOMES.has(outcome)) {
    evidence.positiveSinceNegative = 0;
    evidence.usefulSinceNegative = 0;
  }
  if (DOMINATING_NEGATIVE_OUTCOMES.has(outcome)) {
    if (effectiveAt >= (Date.parse(evidence.lastExplicitNegativeAt || '') || 0)) {
      evidence.lastExplicitNegativeAt = new Date(effectiveAt).toISOString();
      evidence.lastExplicitOutcome = outcome;
    }
  } else if (EXPLICIT_POSITIVE_OUTCOMES.has(outcome)
    && effectiveAt >= (Date.parse(evidence.lastExplicitPositiveAt || '') || 0)) {
    evidence.lastExplicitPositiveAt = new Date(effectiveAt).toISOString();
    // Only a newer explicit positive can supersede explicit negative
    // sentiment. Merely clicking/acting is useful evidence but is not consent.
    if (effectiveAt > (Date.parse(evidence.lastExplicitNegativeAt || '') || 0)) {
      evidence.lastExplicitOutcome = outcome;
    }
  }
  return evidence;
}

function negativeDominates(evidence) {
  const negativeAt = Date.parse(evidence?.lastExplicitNegativeAt || '') || 0;
  const positiveAt = Date.parse(evidence?.lastExplicitPositiveAt || '') || 0;
  return negativeAt > 0 && negativeAt >= positiveAt;
}

function recordPinnedForSafety(record) {
  return TERMINAL_POLICY_OUTCOMES.has(record?.policyOutcome) || negativeDominates(record?.evidence);
}

function ensureContractCapacity(store) {
  const entries = Object.entries(store.contracts);
  if (entries.length < MAX_CONTRACTS) return;
  // Never age explicit negative state out just to admit a new behavior. If all
  // records are safety-pinned, fail closed at the bound.
  const removable = entries
    .filter(([, record]) => !recordPinnedForSafety(record))
    .sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt)
      || a[0].localeCompare(b[0]));
  if (!removable.length) throw new Error('opportunity utility store is full of explicit policy records');
  delete store.contracts[removable[0][0]];
}

function ensureContextBucket(record, requestedKey, at) {
  if (requestedKey === DEFAULT_CONTEXT) return { key: DEFAULT_CONTEXT, bucket: null };
  if (Object.hasOwn(record.contexts, requestedKey)) {
    return { key: requestedKey, bucket: record.contexts[requestedKey] };
  }
  const entries = Object.entries(record.contexts);
  if (entries.length >= MAX_CONTEXTS_PER_CONTRACT) {
    // Prefer replacing old non-negative context evidence. The contract-wide
    // aggregate still retains all outcomes. A full set of negative contexts
    // is kept intact; the new outcome remains in the aggregate only.
    const removable = entries
      .filter(([, evidence]) => !negativeDominates(evidence))
      .sort((a, b) => Date.parse(a[1].lastOutcomeAt || a[1].anchorAt)
        - Date.parse(b[1].lastOutcomeAt || b[1].anchorAt) || a[0].localeCompare(b[0]));
    if (!removable.length) return { key: null, bucket: null };
    delete record.contexts[removable[0][0]];
  }
  record.contexts[requestedKey] = emptyEvidence(at);
  return { key: requestedKey, bucket: record.contexts[requestedKey] };
}

function dedupEventFingerprint(eventId, outcome) {
  if (eventId == null || eventId === '') return null;
  const value = String(eventId);
  if (value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('opportunity utility: outcome eventId is invalid');
  }
  return createHash('sha256').update(`${outcome}\0${value}`).digest('hex').slice(0, 24);
}

function publicOutcomeRecord(id, record, { contextKey = DEFAULT_CONTEXT, now = new Date() } = {}) {
  const context = contextKey !== DEFAULT_CONTEXT && Object.hasOwn(record.contexts, contextKey)
    ? decayOpportunityEvidence(record.contexts[contextKey], { now }) : null;
  return {
    contractId: id,
    actionContract: record.actionContract,
    contractFingerprint: record.contractFingerprint,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    totals: { ...record.totals },
    evidence: decayOpportunityEvidence(record.evidence, { now }),
    contextKey,
    contextEvidence: context,
    policyOutcome: record.policyOutcome,
    policyOutcomeAt: record.policyOutcomeAt,
  };
}

/**
 * Record one outcome for an exact contract. `eventId` is optional but strongly
 * recommended for receipt/control wiring; it is hashed before persistence and
 * makes retries idempotent per outcome. `ignored` records delivery silence and
 * `shadowed` records a non-visible candidate evaluation; policy scoring treats
 * both as neutral.
 */
export async function recordOpportunityOutcome(userId, contract, outcome, {
  contextKey = DEFAULT_CONTEXT,
  eventId = null,
  at = new Date(),
} = {}) {
  const safeUserId = requireUserId(userId);
  const contractId = canonicalOpportunityContractId(contract);
  const canonicalContext = canonicalOpportunityContextKey(contextKey);
  if (!OUTCOME_SET.has(outcome)) {
    throw new Error(`opportunity utility: outcome must be one of ${OPPORTUNITY_OUTCOMES.join(', ')}`);
  }
  const atMs = at instanceof Date ? at.getTime() : Date.parse(String(at));
  if (!Number.isFinite(atMs)) throw new Error('opportunity utility: at must be a valid time');
  const atIso = new Date(atMs).toISOString();
  const eventFingerprint = dedupEventFingerprint(eventId, outcome);

  return withLock(utilityPath(safeUserId), () => {
    const store = readStore(safeUserId);
    let record = Object.hasOwn(store.contracts, contractId) ? store.contracts[contractId] : null;
    if (!record) {
      ensureContractCapacity(store);
      const parsed = parseContractId(contractId);
      record = emptyRecord(parsed, atIso);
      store.contracts[contractId] = record;
    }
    if (eventFingerprint && record.recentEvents.some(item => item.id === eventFingerprint)) {
      return {
        recorded: false,
        duplicate: true,
        outcome,
        ...publicOutcomeRecord(contractId, record, { contextKey: canonicalContext, now: new Date(atMs) }),
      };
    }

    record.totals[outcome] = Math.min(MAX_TOTAL_COUNT, record.totals[outcome] + 1);
    record.evidence = incrementEvidence(record.evidence, outcome, atMs);
    const context = ensureContextBucket(record, canonicalContext, atIso);
    if (context.bucket) record.contexts[context.key] = incrementEvidence(context.bucket, outcome, atMs);
    record.updatedAt = new Date(Math.max(atMs, Date.parse(record.updatedAt))).toISOString();

    if (TERMINAL_POLICY_OUTCOMES.has(outcome)) {
      // Stop is stronger than Undo and cannot be erased by passive outcomes.
      if (record.policyOutcome !== 'stopped') {
        record.policyOutcome = outcome;
        record.policyOutcomeAt = atIso;
      }
    }
    if (eventFingerprint) {
      record.recentEvents.push({ id: eventFingerprint, at: atIso });
      if (record.recentEvents.length > MAX_RECENT_EVENT_IDS) {
        record.recentEvents.splice(0, record.recentEvents.length - MAX_RECENT_EVENT_IDS);
      }
    }
    writeStore(safeUserId, store);
    return {
      recorded: true,
      duplicate: false,
      outcome,
      storedContextKey: context.key,
      ...publicOutcomeRecord(contractId, record, { contextKey: canonicalContext, now: new Date(atMs) }),
    };
  });
}

/** Read bounded outcome evidence for one exact contract. */
export async function getOpportunityOutcome(userId, contract, {
  contextKey = DEFAULT_CONTEXT, now = new Date(),
} = {}) {
  const safeUserId = requireUserId(userId);
  const contractId = canonicalOpportunityContractId(contract);
  const canonicalContext = canonicalOpportunityContextKey(contextKey);
  const store = readStore(safeUserId);
  if (!Object.hasOwn(store.contracts, contractId)) return null;
  return publicOutcomeRecord(contractId, store.contracts[contractId], {
    contextKey: canonicalContext, now,
  });
}

/** List newest-first without exposing deduplication internals. */
export async function listOpportunityOutcomes(userId, { limit = 100, now = new Date() } = {}) {
  const safeUserId = requireUserId(userId);
  const cap = Math.max(1, Math.min(MAX_CONTRACTS, Number.isInteger(limit) ? limit : 100));
  const store = readStore(safeUserId);
  return Object.entries(store.contracts)
    .sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt) || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([id, record]) => publicOutcomeRecord(id, record, { now }));
}

function resumeRecordAsAskFirst(contractId, record, atMs) {
  const changed = record.policyOutcome !== 'undone';
  if (changed) {
    // `undone` is the durable ask-first boundary. Keep the original Stop / Not
    // useful evidence intact so Resume cannot be mistaken for positive
    // feedback or consent to unattended execution.
    record.policyOutcome = 'undone';
    record.policyOutcomeAt = new Date(atMs).toISOString();
    record.updatedAt = new Date(Math.max(atMs, Date.parse(record.updatedAt))).toISOString();
  }
  return {
    ok: true,
    found: true,
    changed,
    recommendation: 'ask',
    reason: 'explicit-resume-requires-ask',
    ...publicOutcomeRecord(contractId, record, { now: new Date(atMs) }),
  };
}

function validMutationTime(at) {
  const atMs = at instanceof Date ? at.getTime() : Date.parse(String(at));
  if (!Number.isFinite(atMs)) throw new Error('opportunity utility: at must be a valid time');
  return atMs;
}

/**
 * Explicitly resume one exact opportunity contract as ask-first. This never
 * clears outcome counters or negative sentiment and never restores safe-auto;
 * it only replaces a shadowing Stop with the durable `undone` boundary used by
 * the policy evaluator for user-approved, ask-first suggestions.
 */
export async function resumeOpportunityContractAsAskFirst(userId, contract, {
  at = new Date(),
} = {}) {
  const safeUserId = requireUserId(userId);
  const contractId = canonicalOpportunityContractId(contract);
  const atMs = validMutationTime(at);
  return withLock(utilityPath(safeUserId), () => {
    const store = readStore(safeUserId);
    const record = Object.hasOwn(store.contracts, contractId) ? store.contracts[contractId] : null;
    if (!record) return { ok: true, found: false, changed: false, recommendation: 'ask' };
    const result = resumeRecordAsAskFirst(contractId, record, atMs);
    if (result.changed) writeStore(safeUserId, store);
    return result;
  });
}

/**
 * Resolve the opaque preference activation kind shown in Behavior settings
 * back to its exact stored utility contract, then resume it ask-first. The
 * 64-bit prefix is already the canonical public kind; ambiguity fails closed
 * instead of changing more than one contract.
 */
export async function resumePreferenceOpportunityKindAsAskFirst(userId, offerKind, {
  at = new Date(),
} = {}) {
  const safeUserId = requireUserId(userId);
  const match = /^skill-activation-([a-f0-9]{16})$/.exec(String(offerKind || ''));
  if (!match) return { ok: true, found: false, changed: false, recommendation: 'ask' };
  const atMs = validMutationTime(at);
  return withLock(utilityPath(safeUserId), () => {
    const store = readStore(safeUserId);
    const matches = Object.entries(store.contracts).filter(([, record]) => (
      record.actionContract === 'skill_preference_activation'
      && record.contractFingerprint.startsWith(match[1])
    ));
    if (matches.length > 1) {
      throw new Error('opportunity utility: ambiguous preference opportunity kind');
    }
    if (!matches.length) {
      return { ok: true, found: false, changed: false, recommendation: 'ask' };
    }
    const [contractId, record] = matches[0];
    const result = resumeRecordAsAskFirst(contractId, record, atMs);
    if (result.changed) writeStore(safeUserId, store);
    return result;
  });
}

function unit(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : fallback;
}

/** Normalize all utility inputs to explicit 0..1 values. */
export function normalizeOpportunityFactors(value = {}) {
  return {
    preferenceConfidence: unit(value.preferenceConfidence, FACTOR_DEFAULTS.preferenceConfidence),
    relevance: unit(value.relevance, FACTOR_DEFAULTS.relevance),
    novelty: unit(value.novelty, FACTOR_DEFAULTS.novelty),
    timing: unit(value.timing, FACTOR_DEFAULTS.timing),
    savings: unit(value.savings, FACTOR_DEFAULTS.savings),
    interruptionCost: unit(value.interruptionCost, FACTOR_DEFAULTS.interruptionCost),
  };
}

function rounded(value) {
  return Math.round(value * 10_000) / 10_000;
}

function evidenceMetrics(value) {
  const counts = value?.counts || emptyCounts();
  const positive = (counts.useful || 0) + (counts.acted || 0);
  const negative = (counts.not_useful || 0) + (counts.dismissed || 0)
    + (counts.stopped || 0) + (counts.undone || 0);
  const explicit = positive + negative;
  // A neutral beta(1,1) prior avoids pretending no history is either success
  // or failure. `ignored` and `shown` are intentionally absent here.
  const positiveRate = (positive + 1) / (explicit + 2);
  // Beta-smoothed risk decays toward zero with old evidence. Using
  // negative/explicit here would leave one dismissed-only contract at a 100%
  // negative rate forever even after its effective count had nearly vanished.
  const negativeRate = negative / (explicit + 2);
  const shown = counts.shown || 0;
  return {
    shown: rounded(shown),
    shadowed: rounded(counts.shadowed || 0),
    useful: rounded(counts.useful || 0),
    acted: rounded(counts.acted || 0),
    notUseful: rounded(counts.not_useful || 0),
    dismissed: rounded(counts.dismissed || 0),
    stopped: rounded(counts.stopped || 0),
    undone: rounded(counts.undone || 0),
    ignored: rounded(counts.ignored || 0),
    positive: rounded(positive),
    negative: rounded(negative),
    explicit: rounded(explicit),
    positiveRate: rounded(positiveRate),
    negativeRate: rounded(negativeRate),
    ignoredRate: rounded(shown > 0 ? Math.min(1, (counts.ignored || 0) / shown) : 0),
    positiveSinceNegative: Math.max(0, Number(value?.positiveSinceNegative) || 0),
    usefulSinceNegative: Math.max(0, Number(value?.usefulSinceNegative) || 0),
  };
}

/**
 * Pure deterministic policy calculation. The six contextual inputs form the
 * base value; learned explicit outcome rates adjust it. Silence never lowers
 * the score. A latest explicit negative overrides arithmetic, while Stop and
 * Undo remain durable policy boundaries.
 */
export function evaluateOpportunityUtility({
  factors = {},
  evidence = emptyEvidence(),
  overallEvidence = evidence,
  policyOutcome = null,
  safeAutoEligible = false,
  reviewedNotifyOnly = false,
  explicitPreferenceConfirmed = false,
} = {}) {
  if (policyOutcome != null && !TERMINAL_POLICY_OUTCOMES.has(policyOutcome)) {
    throw new Error('opportunity utility: policyOutcome must be stopped, undone, or null');
  }
  const normalizedFactors = normalizeOpportunityFactors(factors);
  const selectedEvidence = normalizeEvidence(evidence);
  const normalizedOverall = normalizeEvidence(overallEvidence);
  const metrics = evidenceMetrics(selectedEvidence);
  const overallMetrics = evidenceMetrics(normalizedOverall);

  const contextScore = (
    normalizedFactors.preferenceConfidence * FACTOR_WEIGHTS.preferenceConfidence
    + normalizedFactors.relevance * FACTOR_WEIGHTS.relevance
    + normalizedFactors.novelty * FACTOR_WEIGHTS.novelty
    + normalizedFactors.timing * FACTOR_WEIGHTS.timing
    + normalizedFactors.savings * FACTOR_WEIGHTS.savings
    + (1 - normalizedFactors.interruptionCost) * FACTOR_WEIGHTS.interruptionCost
  );
  // Context is the majority of utility. Learned quality adjusts, rather than
  // replaces, present-day relevance. Explicit-negative risk receives a
  // separate penalty before the hard dominance checks below.
  const score = Math.max(0, Math.min(1,
    contextScore * 0.72 + metrics.positiveRate * 0.28 - metrics.negativeRate * 0.30,
  ));

  const latestNegativeDominates = negativeDominates(selectedEvidence)
    || negativeDominates(normalizedOverall);
  const factorsSupportAsk = normalizedFactors.preferenceConfidence >= 0.45
    && normalizedFactors.relevance >= 0.45 && score >= 0.52;
  const minimumSafeEvidence = metrics.shown >= 3
    && metrics.positive >= 2.5
    && metrics.useful >= 1.5
    && metrics.positiveSinceNegative >= 3
    && metrics.usefulSinceNegative >= 2
    && metrics.positiveRate >= 0.75
    && metrics.negativeRate <= 0.15;
  const minimumSafeContext = contextScore >= 0.78 && score >= 0.78
    && normalizedFactors.preferenceConfidence >= 0.70
    && normalizedFactors.relevance >= 0.70
    && normalizedFactors.timing >= 0.65
    && normalizedFactors.interruptionCost <= 0.35;
  // A server-reviewed notify-only contract may retain today's immediate
  // friend-like behavior after a directly confirmed preference. This is a
  // narrow cold-start alternative to outcome graduation, not a generic
  // override: all three independent gates must be literal true, current
  // utility must be high, and no negative outcome may exist. Callers remain
  // responsible for the actual execution authorization described above.
  const trustedSafeBaseline = safeAutoEligible === true
    && reviewedNotifyOnly === true
    && explicitPreferenceConfirmed === true
    && metrics.negative === 0
    && overallMetrics.negative === 0
    && contextScore >= 0.74
    && score >= 0.72
    && normalizedFactors.preferenceConfidence >= 0.90
    && normalizedFactors.relevance >= 0.75
    && normalizedFactors.timing >= 0.60
    && normalizedFactors.interruptionCost <= 0.35;

  let recommendation = 'shadow';
  let reason = 'utility-below-ask-threshold';
  if (policyOutcome === 'stopped') {
    reason = 'explicit-stop';
  } else if (policyOutcome === 'undone') {
    recommendation = 'ask';
    reason = 'explicit-undo-requires-ask';
  } else if (latestNegativeDominates) {
    reason = 'latest-explicit-feedback-negative';
  } else if (!factorsSupportAsk) {
    reason = 'insufficient-current-relevance';
  } else if (trustedSafeBaseline) {
    recommendation = 'safe_auto';
    reason = 'reviewed-notify-only-confirmed-preference';
  } else if (safeAutoEligible === true && minimumSafeEvidence && minimumSafeContext) {
    recommendation = 'safe_auto';
    reason = 'high-utility-with-conservative-positive-evidence';
  } else {
    recommendation = 'ask';
    reason = safeAutoEligible === true
      ? 'safe-auto-needs-more-positive-evidence'
      : 'ask-first';
  }

  return {
    recommendation,
    reason,
    score: rounded(score),
    contextScore: rounded(contextScore),
    factors: normalizedFactors,
    evidence: metrics,
    overallEvidence: overallMetrics,
    negativeDominates: latestNegativeDominates,
    minimumSafeEvidence,
    minimumSafeContext,
    trustedSafeBaseline,
    safeAutoEligible: safeAutoEligible === true,
    reviewedNotifyOnly: reviewedNotifyOnly === true,
    explicitPreferenceConfirmed: explicitPreferenceConfirmed === true,
  };
}

/**
 * Load decayed evidence and return an advisory shadow/ask/safe-auto policy.
 * Missing history is a valid cold start. It can recommend safe-auto only via
 * the narrow reviewed-notify-only + directly-confirmed-preference baseline.
 */
export async function recommendOpportunityPolicy(userId, contract, {
  contextKey = DEFAULT_CONTEXT,
  factors = {},
  safeAutoEligible = false,
  reviewedNotifyOnly = false,
  explicitPreferenceConfirmed = false,
  now = new Date(),
} = {}) {
  const safeUserId = requireUserId(userId);
  const contractId = canonicalOpportunityContractId(contract);
  const canonicalContext = canonicalOpportunityContextKey(contextKey);
  const store = readStore(safeUserId);
  const record = Object.hasOwn(store.contracts, contractId) ? store.contracts[contractId] : null;
  const overallEvidence = record
    ? decayOpportunityEvidence(record.evidence, { now }) : emptyEvidence(new Date(now).toISOString());
  const contextual = record && canonicalContext !== DEFAULT_CONTEXT
    && Object.hasOwn(record.contexts, canonicalContext)
    ? decayOpportunityEvidence(record.contexts[canonicalContext], { now }) : null;
  // A named context starts conservatively. If it has no evidence, falling
  // back to contract-wide positives could auto-graduate a behavior in an
  // untested situation (for example, work hours vs. a quiet weekend).
  const evidence = canonicalContext === DEFAULT_CONTEXT
    ? overallEvidence
    : (contextual || emptyEvidence(new Date(now).toISOString()));
  return {
    contractId,
    contextKey: canonicalContext,
    ...evaluateOpportunityUtility({
      factors,
      evidence,
      overallEvidence,
      policyOutcome: record?.policyOutcome || null,
      safeAutoEligible,
      reviewedNotifyOnly,
      explicitPreferenceConfirmed,
    }),
  };
}
