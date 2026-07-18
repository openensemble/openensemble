// @ts-check
/**
 * Typed, user-auditable personalization profile backed by Cortex user_facts.
 *
 * ledger.json is the ownership/provenance record. A row is safe to mutate in
 * Cortex only when it is present here; semantic dedup never transfers
 * ownership of a user-stated fact to personalization.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { USERS_DIR } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';
import { getTable, remember, isChildAccountJailbreak } from '../../memory/lance.mjs';
import { embed, scoreSalience } from '../../memory/embedding.mjs';
import { queuedWrite, assertId } from '../../memory/shared.mjs';
import { softForgetValues, restoreForgottenValues } from '../../memory/forgotten-state.mjs';
import { recordHistory, scrubHistoryForMemory } from './history.mjs';
import { redactSecretsDeep, sanitizeSignalText } from './signal-safety.mjs';
import { getConfig } from './config.mjs';
import {
  extractPreferenceStructure,
  isValidPreferenceStructure,
  normalizePreferenceStructure,
} from './preference-structure.mjs';

const MAX_STABILITY = 999998;
const REINFORCE_MULTIPLIER = 1.5;
const MAX_EVIDENCE = 20;
const MAX_STATEMENT_LEN = 300;
const VALID_TYPES = new Set(['pattern', 'fact', 'relationship', 'preference', 'constraint', 'goal', 'routine']);
const NEGATIVE_REASONS = new Set(['not_true', 'outdated', 'too_personal', 'forgotten']);
const VALID_TOMBSTONE_REASONS = new Set([...NEGATIVE_REASONS, 'corrected']);
const EVIDENCE_ID_RE = /^[a-zA-Z0-9_.:-]{3,160}$/;
const MAX_LEGACY_EVIDENCE_LEN = 240;
const MAX_PROVENANCE_FIELD_LEN = 120;
const DECAY_THRESHOLD = 0.35;
const DAY_MS = 86_400_000;
// Inferred profile categories do not all become stale at the same speed.
// Facts are deliberately conservative; short-lived goals and behavioral
// patterns require more recent evidence. User-confirmed rows bypass this
// policy entirely unless the user attached an explicit temporary expiry.
const INFERRED_HALF_LIFE_DAYS = Object.freeze({
  pattern: 60,
  fact: 365,
  relationship: 180,
  preference: 120,
  constraint: 180,
  goal: 45,
  routine: 60,
});

async function revokeOpaquePreferenceGrants(userId, memoryId) {
  try {
    const grants = await import('./skill-preference-grants.mjs');
    await grants.revokePreferenceGrants(userId, memoryId);
  } catch (e) {
    // The ledger mutation is the primary authorization boundary: once the row
    // is gone every helper and tick fails closed. Grant cleanup is an opaque,
    // post-commit retention/cap cleanup and can safely retry later.
    console.warn(`[personalization] preference grant cleanup deferred for ${memoryId}: ${e?.message || e}`);
  }
}

function personalizationDir(userId) { return path.join(USERS_DIR, userId, 'personalization'); }
function ledgerPath(userId) { return path.join(personalizationDir(userId), 'ledger.json'); }

function secureDir(userId) {
  const dir = personalizationDir(userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }
}

function normalizeStatement(value) {
  const clean = sanitizeSignalText(value, MAX_STATEMENT_LEN + 1);
  const redacted = redactSecretsDeep(clean, { maxString: MAX_STATEMENT_LEN + 1 });
  const text = String(redacted || '');
  return text.includes('[redacted]') ? '' : text;
}

function statementFingerprint(value) {
  return createHash('sha256').update(normalizeStatement(value).toLowerCase()).digest('hex').slice(0, 24);
}

const TOMBSTONE_TOPIC_STOPWORDS = new Set([
  'i', 'we', 'my', 'our', 'the', 'a', 'an', 'to', 'of', 'for', 'at', 'from',
  'through', 'before', 'after', 'in', 'on', 'only', 'always', 'never', 'do',
  'not', 'dont', 'really', 'absolutely', 'especially', 'like', 'likes', 'love',
  'loves', 'adore', 'adores', 'enjoy', 'enjoys', 'prefer', 'prefers', 'avoid',
  'avoids', 'dislike', 'dislikes', 'hate', 'hates', 'buy', 'buys', 'purchase',
  'purchases', 'order', 'orders', 'choose', 'chooses', 'want', 'wants', 'eat',
  'eats', 'drink', 'drinks', 'use', 'uses', 'wear', 'wears', 'am', 'allergic',
  'morning', 'breakfast', 'noon', 'lunch', 'afternoon', 'dinner', 'evening',
  'night', 'dawn', 'daybreak', 'sunrise', 'midday', 'supper', 'sunset',
  'bedtime', 'overnight', 'early', 'late', 'prior', 'following', 'during',
  'around', 'near', 'work', 'home',
]);

// Small, auditable equivalence classes for common preference-topic wording.
// This is intentionally not an open-ended thesaurus: every group is bounded,
// deterministic, and conservative enough to use as a negative-feedback
// authorization boundary without an LLM or embedding call.
const TOMBSTONE_TOPIC_SYNONYM_GROUPS = Object.freeze([
  Object.freeze(['phone', 'phones', 'telephone', 'telephones', 'cellphone', 'cellphones']),
  Object.freeze(['call', 'calls', 'conversation', 'conversations']),
  Object.freeze(['movie', 'movies', 'film', 'films']),
  Object.freeze(['tv', 'television', 'televisions']),
  Object.freeze(['workout', 'workouts', 'exercise', 'exercises', 'exercising']),
  Object.freeze(['car', 'cars', 'automobile', 'automobiles']),
  Object.freeze(['bike', 'bikes', 'bicycle', 'bicycles']),
  Object.freeze(['child', 'children', 'kid', 'kids']),
  Object.freeze(['doctor', 'doctors', 'physician', 'physicians']),
  Object.freeze(['sofa', 'sofas', 'couch', 'couches']),
  Object.freeze(['bathroom', 'bathrooms', 'restroom', 'restrooms']),
]);
const TOMBSTONE_TOPIC_SYNONYMS = new Map(
  TOMBSTONE_TOPIC_SYNONYM_GROUPS.flatMap(group => group.map(value => [value, group[0]])),
);
const TOMBSTONE_TOPIC_PHRASE_ALIASES = Object.freeze([
  Object.freeze({ pattern: '\\b(?:cell(?:ular)?|mobile|smart)[\\s-]+phones?\\b', replacement: 'phone' }),
  Object.freeze({ pattern: '\\bmotion[\\s-]+pictures?\\b', replacement: 'movie' }),
  Object.freeze({ pattern: '\\bwork(?:ing)?[\\s-]+out\\b', replacement: 'workout' }),
]);

function tombstoneToken(value) {
  let token = String(value || '').toLowerCase();
  const direct = TOMBSTONE_TOPIC_SYNONYMS.get(token);
  if (direct) return direct;
  if (token.length > 4 && token.endsWith('ies')) token = `${token.slice(0, -3)}y`;
  else if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) token = token.slice(0, -1);
  return TOMBSTONE_TOPIC_SYNONYMS.get(token) || token;
}

function canonicalTombstoneTopicTokens(value) {
  let text = String(value || '')
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  for (const alias of TOMBSTONE_TOPIC_PHRASE_ALIASES) {
    text = text.replace(new RegExp(alias.pattern, 'g'), alias.replacement);
  }
  return [...new Set(text.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .map(tombstoneToken)
    .filter(token => token.length >= 2 && token.length <= 40
      && !TOMBSTONE_TOPIC_STOPWORDS.has(token)))]
    .sort().slice(0, 12);
}

function canonicalTombstoneContext(statement, structure) {
  const declared = String(structure?.context || '').normalize('NFKC').toLowerCase().trim();
  const text = String(statement || '').normalize('NFKC').toLowerCase();
  if (['breakfast', 'morning', 'dawn', 'daybreak', 'sunrise'].includes(declared)) return 'morning';
  if (['lunch', 'noon', 'midday'].includes(declared)) return 'midday';
  if (declared === 'afternoon') return 'afternoon';
  if (['dinner', 'supper', 'evening', 'sunset'].includes(declared)) return 'evening';
  if (['night', 'bedtime', 'overnight'].includes(declared)) return 'night';
  if (/\b(?:morning|breakfast|dawn|daybreak|sunrise)\b/.test(text)) return 'morning';
  if (/\b(?:noon|midday|lunch)\b/.test(text)) return 'midday';
  if (/\bafternoon\b/.test(text)) return 'afternoon';
  if (/\b(?:evening|dinner|supper|sunset)\b/.test(text)) return 'evening';
  if (/\b(?:night|bedtime|overnight)\b/.test(text)) return 'night';
  return declared.replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

function tombstoneSignature(statement, type = 'preference', structure = null) {
  if (type !== 'preference') return null;
  const parsed = normalizePreferenceStructure(structure)
    || extractPreferenceStructure(statement);
  const subject = parsed?.subject || statement;
  const tokens = canonicalTombstoneTopicTokens(subject);
  if (!tokens.length) return null;
  return {
    topicTokens: tokens,
    merchant: String(parsed?.merchant || '').toLowerCase().replace(/[^a-z0-9\s&'.-]/g, '').trim().slice(0, 80),
    context: canonicalTombstoneContext(statement, parsed),
  };
}

function makeTombstone(row, reason, days) {
  const signature = tombstoneSignature(row.statement, row.type, row.structure);
  return {
    fingerprint: statementFingerprint(row.statement), reason, type: row.type,
    ...(signature || {}),
    at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
  };
}

function normalizeType(value) { return VALID_TYPES.has(value) ? value : 'fact'; }

function normalizeEvidence(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const id = String(value || '');
    if (!EVIDENCE_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

function normalizeEvidenceDetails(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, MAX_EVIDENCE).flatMap(v => {
    if (!v || typeof v !== 'object') return [];
    const id = String(v.id || '');
    if (!EVIDENCE_ID_RE.test(id)) return [];
    return [{
      id,
      source: String(v.source || 'activity').slice(0, 80),
      // Reflection already resolves these fields from the cited observation.
      // Keep the exact, bounded provenance in the durable sidecar instead of
      // retaining only an opaque observation id that may later be pruned.
      skillId: typeof v.skillId === 'string' && v.skillId
        ? v.skillId.slice(0, MAX_PROVENANCE_FIELD_LEN) : null,
      kind: typeof v.kind === 'string' && v.kind
        ? v.kind.slice(0, MAX_PROVENANCE_FIELD_LEN) : null,
      origin: ['interactive', 'automation', 'external'].includes(v.origin)
        ? v.origin : null,
      at: typeof v.at === 'string' ? v.at.slice(0, 40) : null,
      summary: typeof v.summary === 'string'
        ? String(redactSecretsDeep(sanitizeSignalText(v.summary, 240), { maxString: 240 }) || '')
        : '',
    }];
  });
}

function legacyEvidenceSummary(value) {
  if (typeof value !== 'string' || value.length > MAX_LEGACY_EVIDENCE_LEN) return '';
  return String(redactSecretsDeep(
    sanitizeSignalText(value, MAX_LEGACY_EVIDENCE_LEN),
    { maxString: MAX_LEGACY_EVIDENCE_LEN },
  ) || '').trim();
}

function normalizeStoredEvidence(values, details) {
  const evidence = [];
  const seen = new Set();
  const detailById = new Map(normalizeEvidenceDetails(details).map(detail => [detail.id, detail]));
  for (const value of (Array.isArray(values) ? values : []).slice(0, MAX_EVIDENCE)) {
    let id = String(value || '');
    if (!EVIDENCE_ID_RE.test(id)) {
      const summary = legacyEvidenceSummary(value);
      if (!summary) continue;
      id = `legacy_${createHash('sha256').update(summary).digest('hex').slice(0, 24)}`;
      if (!detailById.has(id)) {
        detailById.set(id, {
          id, source: 'legacy evidence', skillId: null, kind: null, origin: null,
          at: null, summary,
        });
      }
    }
    if (seen.has(id)) continue;
    seen.add(id);
    evidence.push(id);
  }
  return {
    evidence,
    evidenceDetails: [...detailById.values()].filter(detail => seen.has(detail.id)).slice(0, MAX_EVIDENCE),
  };
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  try { assertId(row.id); } catch { return null; }
  const statement = normalizeStatement(row.statement);
  if (!statement || statement.length > MAX_STATEMENT_LEN) return null;
  const storedEvidence = normalizeStoredEvidence(row.evidence, row.evidenceDetails);
  const structure = row.structure == null ? null : normalizePreferenceStructure(row.structure);
  return {
    id: row.id,
    statement,
    type: normalizeType(row.type),
    tier: row.tier === 'confirmed' ? 'confirmed' : 'inferred',
    scope: typeof row.scope === 'string' ? row.scope.slice(0, 80) : 'global',
    subject: typeof row.subject === 'string' ? row.subject.slice(0, 120) : null,
    polarity: row.polarity === 'negative' ? 'negative' : 'positive',
    ...(structure ? { structure } : {}),
    evidence: storedEvidence.evidence,
    evidenceDetails: storedEvidence.evidenceDetails,
    confidence: Number.isFinite(row.confidence) ? Math.max(0, Math.min(1, row.confidence)) : null,
    flag: row.flag === 'contradicted' ? 'contradicted' : null,
    contradictionStatement: typeof row.contradictionStatement === 'string'
      ? normalizeStatement(row.contradictionStatement).slice(0, MAX_STATEMENT_LEN) : null,
    status: row.status === 'contradicted'
      || (row.status == null && row.flag === 'contradicted' && row.tier !== 'confirmed')
      ? 'contradicted' : 'active',
    source: 'personalization',
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : (row.createdAt || new Date().toISOString()),
    lastObservedAt: typeof row.lastObservedAt === 'string' ? row.lastObservedAt : null,
    confirmedAt: typeof row.confirmedAt === 'string' ? row.confirmedAt : null,
    correctionReason: typeof row.correctionReason === 'string' ? row.correctionReason.slice(0, 40) : null,
  };
}

function isValidStoredRowShape(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  if (row.type != null && !VALID_TYPES.has(row.type)) return false;
  if (row.tier != null && !['inferred', 'confirmed'].includes(row.tier)) return false;
  if (row.status != null && !['active', 'contradicted'].includes(row.status)) return false;
  if (row.flag != null && row.flag !== 'contradicted') return false;
  if (row.polarity != null && !['positive', 'negative'].includes(row.polarity)) return false;
  if (row.confidence != null && (!Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1)) return false;
  if (row.scope != null && typeof row.scope !== 'string') return false;
  if (row.subject != null && typeof row.subject !== 'string') return false;
  if (row.structure != null && !isValidPreferenceStructure(row.structure)) return false;
  if (row.structure != null
    && row.structure.sentiment !== (row.polarity === 'negative' ? 'negative' : 'positive')) return false;
  if (row.contradictionStatement != null && typeof row.contradictionStatement !== 'string') return false;
  if (row.correctionReason != null && typeof row.correctionReason !== 'string') return false;
  for (const key of ['createdAt', 'updatedAt', 'lastObservedAt', 'confirmedAt']) {
    if (row[key] != null && (typeof row[key] !== 'string' || !Number.isFinite(Date.parse(row[key])))) return false;
  }
  if (row.evidence != null) {
    if (!Array.isArray(row.evidence) || row.evidence.length > MAX_EVIDENCE) return false;
    const seen = new Set();
    for (const value of row.evidence) {
      if (typeof value !== 'string') return false;
      const normalizedId = EVIDENCE_ID_RE.test(value)
        ? value
        : (() => {
            const summary = legacyEvidenceSummary(value);
            return summary ? `legacy_${createHash('sha256').update(summary).digest('hex').slice(0, 24)}` : '';
          })();
      if (!normalizedId || seen.has(normalizedId)) return false;
      seen.add(normalizedId);
    }
  }
  if (row.evidenceDetails != null) {
    if (!Array.isArray(row.evidenceDetails)) return false;
    for (const value of row.evidenceDetails) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.id !== 'string' || !EVIDENCE_ID_RE.test(value.id)
        || (value.source != null && typeof value.source !== 'string')
        || (value.skillId != null && (typeof value.skillId !== 'string'
          || value.skillId.length > MAX_PROVENANCE_FIELD_LEN))
        || (value.kind != null && (typeof value.kind !== 'string'
          || value.kind.length > MAX_PROVENANCE_FIELD_LEN))
        || (value.origin != null && !['interactive', 'automation', 'external'].includes(value.origin))
        || (value.at != null && (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))))
        || (value.summary != null && typeof value.summary !== 'string')) return false;
    }
  }
  if (row.flag === 'contradicted' && row.status === 'active' && row.tier !== 'confirmed') return false;
  if (row.status === 'contradicted' && row.flag !== 'contradicted') return false;
  return true;
}

function normalizeTombstone(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{24}$/.test(value.fingerprint)) return null;
  if (!VALID_TOMBSTONE_REASONS.has(value.reason) || !VALID_TYPES.has(value.type)) return null;
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null;
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) return null;
  const rawTopicTokens = Array.isArray(value.topicTokens) ? value.topicTokens : [];
  if (value.topicTokens != null && (!Array.isArray(value.topicTokens)
    || rawTopicTokens.length > 12
    || new Set(rawTopicTokens).size !== rawTopicTokens.length
    || rawTopicTokens.some(token => typeof token !== 'string'
      || !/^[a-z0-9-]{2,40}$/.test(token)))) return null;
  // Read-time canonicalization gives already-persisted lexical tombstones the
  // same synonym protection as newly written ones. Collapsed aliases (for
  // example ["phone", "telephone"]) are valid historical data, not corruption.
  const topicTokens = canonicalTombstoneTopicTokens(rawTopicTokens.join(' '));
  if (value.merchant != null && (typeof value.merchant !== 'string' || value.merchant.length > 80)) return null;
  if (value.context != null && (typeof value.context !== 'string' || value.context.length > 40)) return null;
  const merchant = String(value.merchant || '').normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9\s&'.-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const context = canonicalTombstoneContext('', { context: value.context });
  return {
    fingerprint: value.fingerprint,
    reason: value.reason,
    type: value.type,
    ...(topicTokens.length ? { topicTokens } : {}),
    ...(merchant ? { merchant } : {}),
    ...(context ? { context } : {}),
    at: value.at,
    expiresAt: value.expiresAt,
  };
}

function readLedgerFile(userId, { strict = false } = {}) {
  const p = ledgerPath(userId);
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.rows)) throw new Error('invalid ledger envelope');
    const rows = [];
    const rowIds = new Set();
    for (const raw of obj.rows) {
      if (strict && !isValidStoredRowShape(raw)) throw new Error('ledger contains an invalid row shape');
      const row = normalizeRow(raw);
      if (!row) {
        if (strict) throw new Error('ledger contains an invalid row');
        continue;
      }
      if (rowIds.has(row.id)) {
        if (strict) throw new Error(`ledger contains duplicate row id ${row.id}`);
        continue;
      }
      rowIds.add(row.id);
      rows.push(row);
    }
    const tombstones = [];
    if (obj.tombstones != null && !Array.isArray(obj.tombstones)) throw new Error('invalid ledger tombstone envelope');
    for (const raw of (obj.tombstones || []).slice(-500)) {
      const tombstone = normalizeTombstone(raw);
      if (!tombstone) {
        if (strict) throw new Error('ledger contains an invalid tombstone');
        continue;
      }
      tombstones.push(tombstone);
    }
    return { version: Number.isInteger(obj.version) ? obj.version : 0, rows, tombstones, error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 0, rows: [], tombstones: [], error: null };
    console.warn(`[personalization] ledger read failed for ${userId}: ${e.message}`);
    if (strict) throw new Error(`Personalization ledger is unreadable: ${e.message}`);
    return { version: 0, rows: [], tombstones: [], error: e.message };
  }
}

function writeLedgerFile(userId, file) {
  secureDir(userId);
  const data = {
    version: (file.version || 0) + 1,
    updated_at: Date.now(),
    rows: file.rows,
    tombstones: (file.tombstones || []).slice(-500),
  };
  atomicWriteSync(ledgerPath(userId), JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(ledgerPath(userId), 0o600); } catch { /* non-POSIX */ }
  file.version = data.version;
}

function modifyLedger(userId, mutator) {
  return withLock(ledgerPath(userId), async () => {
    const file = readLedgerFile(userId, { strict: true });
    const rollbacks = [];
    const afterCommits = [];
    const registerRollback = fn => { if (typeof fn === 'function') rollbacks.push(fn); };
    const afterCommit = fn => { if (typeof fn === 'function') afterCommits.push(fn); };
    try {
      const result = await mutator(file, registerRollback, afterCommit);
      writeLedgerFile(userId, file);
      for (const commit of afterCommits) {
        try { await commit(); }
        catch (commitError) {
          console.warn(`[personalization] ledger post-commit audit failed for ${userId}: ${commitError?.message || commitError}`);
        }
      }
      return result;
    } catch (error) {
      // Cortex and the JSON sidecar are separate stores. If the sidecar write
      // fails after a Cortex mutation, compensate in reverse order so the
      // user never sees one belief in About You while agents use another.
      for (const rollback of rollbacks.reverse()) {
        try { await rollback(); }
        catch (rollbackError) {
          console.error(`[personalization] ledger compensation failed for ${userId}: ${rollbackError?.message || rollbackError}`);
        }
      }
      throw error;
    }
  });
}

function newRow(overrides) {
  const now = new Date().toISOString();
  return normalizeRow({
    id: overrides.id,
    statement: overrides.statement,
    type: overrides.type,
    tier: 'inferred',
    scope: 'global',
    subject: null,
    polarity: 'positive',
    evidence: [],
    evidenceDetails: [],
    confidence: null,
    flag: null,
    contradictionStatement: null,
    status: 'active',
    source: 'personalization',
    createdAt: now,
    updatedAt: now,
    lastObservedAt: now,
    confirmedAt: null,
    correctionReason: null,
    ...overrides,
  });
}

function mergeEvidence(row, evidence, details) {
  const before = new Set(row.evidence || []);
  const merged = normalizeEvidence([...(row.evidence || []), ...normalizeEvidence(evidence)]);
  const added = merged.filter(id => !before.has(id));
  row.evidence = merged;
  const byId = new Map((row.evidenceDetails || []).map(x => [x.id, x]));
  for (const d of normalizeEvidenceDetails(details)) byId.set(d.id, d);
  row.evidenceDetails = [...byId.values()].filter(d => merged.includes(d.id)).slice(0, MAX_EVIDENCE);
  return added;
}

function isTombstoned(file, statement, { type = 'preference', structure = null } = {}) {
  const fp = statementFingerprint(statement);
  const now = Date.now();
  const signature = tombstoneSignature(statement, type, structure);
  return file.tombstones.some(t => {
    if (t.expiresAt && Date.parse(t.expiresAt) <= now) return false;
    if (t.fingerprint === fp) return true;
    if (type !== 'preference' || t.type !== 'preference' || !signature
      || !Array.isArray(t.topicTokens) || !t.topicTokens.length) return false;
    if (t.merchant && signature.merchant && t.merchant !== signature.merchant) return false;
    if (t.context && signature.context && t.context !== signature.context) return false;
    const prior = new Set(t.topicTokens);
    const current = new Set(signature.topicTokens);
    let shared = 0;
    for (const token of current) if (prior.has(token)) shared++;
    const minimumShared = Math.min(prior.size, current.size) === 1 ? 1 : 2;
    return shared >= minimumShared
      && shared / Math.max(prior.size, current.size) >= 2 / 3;
  });
}

async function cortexRow(userId, memoryId) {
  const id = assertId(memoryId);
  const table = await getTable('user_facts', userId);
  const rows = await table.query().where(`id = '${id}'`).limit(1).toArray().catch(() => []);
  return { table, row: rows[0] || null, id };
}

function normalizeForgottenUpdate(values) {
  if (values?.forgotten === true && !Number.isFinite(Date.parse(values.forgotten_at || ''))) {
    return { ...values, ...softForgetValues() };
  }
  if (values?.forgotten === false) {
    return { ...values, ...restoreForgottenValues() };
  }
  return values;
}

async function updateCortex(userId, memoryId, values) {
  values = normalizeForgottenUpdate(values);
  const { table, row, id } = await cortexRow(userId, memoryId);
  if (!row) return false;
  await queuedWrite('user_facts', () => table.update({ where: `id = '${id}'`, values }), userId);
  await table.checkoutLatest?.();
  const verify = await table.query().where(`id = '${id}'`).limit(1).toArray().catch(() => []);
  if (!verify.length) return false;
  return Object.entries(values).every(([k, v]) => {
    if (Array.isArray(v)) {
      const stored = verify[0][k];
      const actual = Array.isArray(stored)
        ? stored
        : (ArrayBuffer.isView(stored) && !(stored instanceof DataView)
            ? Array.from(/** @type {any} */ (stored))
            : null);
      return !!actual && actual.length === v.length && actual.every((item, index) => (
        typeof item === 'number' && typeof v[index] === 'number'
          ? Math.abs(item - v[index]) < 1e-6
          : item === v[index]
      ));
    }
    return verify[0][k] === v;
  });
}

function previousCortexValues(row, values) {
  const defaults = {
    text: '', source: '', confidence: 0, category: '', stability: 24,
    forgotten: false, forgotten_at: '', status: 'active', vector: [], enriched: false,
    salience_composite: 0, emotional_weight: 0, decision_weight: 0,
    uniqueness_score: 0, priority: 0,
  };
  return Object.fromEntries(Object.keys(values).map(key => [
    key,
    row?.[key] === undefined ? defaults[key] : row[key],
  ]));
}

async function reversibleCortexUpdate(userId, memoryId, values, registerRollback, currentRow = null) {
  const current = currentRow || (await cortexRow(userId, memoryId)).row;
  if (!current) return false;
  values = normalizeForgottenUpdate(values);
  const previous = previousCortexValues(current, values);
  const ok = await updateCortex(userId, memoryId, values);
  if (!ok) {
    await updateCortex(userId, memoryId, previous).catch(() => false);
    return false;
  }
  registerRollback?.(async () => {
    if (!(await updateCortex(userId, memoryId, previous))) {
      throw new Error(`failed to restore cortex memory ${memoryId}`);
    }
  });
  return true;
}

async function forgetOwnedCortex(userId, row, registerRollback = null) {
  if (!row) return false;
  const current = await cortexRow(userId, row.id);
  if (!current.row) return true;
  // Ownership is established by the sidecar row. Still reject an unrelated
  // user-stated row defensively; old personalization rows may have been
  // promoted to user_confirmed/user_corrected by this module.
  const source = current.row.source;
  if (!['personalization', 'user_confirmed', 'user_corrected'].includes(source)) return false;
  return reversibleCortexUpdate(userId, row.id, { forgotten: true }, registerRollback, current.row);
}

function asTimestamp(value, fallback = NaN) {
  const timestamp = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
    : typeof value === 'string' ? Date.parse(value)
    : NaN;
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function temporaryExpiryTimestamp(row) {
  return asTimestamp(row?.structure?.temporary?.expiresAt);
}

/**
 * Confidence used by the personalization lifecycle at a particular instant.
 * This is computed rather than persisted, so a periodic sweep never rewrites
 * a row merely to lower a number. Confirmed beliefs remain stable; an explicit
 * temporary expiry is the sole automatic deletion path for them.
 */
export function effectiveLedgerConfidence(row, now = Date.now()) {
  const nowMs = asTimestamp(now, Date.now());
  const base = Number.isFinite(row?.confidence)
    ? Math.max(0, Math.min(1, Number(row.confidence)))
    : row?.tier === 'confirmed' ? 0.99 : 0;
  const expiresAt = temporaryExpiryTimestamp(row);
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return 0;
  if (row?.tier === 'confirmed') return base;

  const observedAt = asTimestamp(
    row?.lastObservedAt || row?.updatedAt || row?.createdAt,
    nowMs,
  );
  const elapsedMs = Math.max(0, nowMs - observedAt);
  const halfLifeDays = INFERRED_HALF_LIFE_DAYS[normalizeType(row?.type)];
  return base * Math.pow(0.5, elapsedMs / (halfLifeDays * DAY_MS));
}

/**
 * Remove stale inferred rows and explicitly expired temporary rows.
 *
 * The cheap preflight prevents a no-op sweep from incrementing ledger.json's
 * version every six hours. Every candidate is then found and evaluated again
 * under the ledger lock before Cortex is touched: a concurrent confirmation,
 * correction, or reinforcement therefore wins over a stale decay decision.
 * Natural expiry intentionally creates no tombstone, allowing genuinely new
 * evidence to teach the same preference again later.
 */
export async function decayPersonalizationRows(userId, { now = Date.now() } = {}) {
  const nowMs = asTimestamp(now, Date.now());
  const initial = readLedgerFile(userId, { strict: true });
  const hasCandidate = initial.rows.some(row => {
    const expiresAt = temporaryExpiryTimestamp(row);
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return true;
    return row.tier !== 'confirmed'
      && effectiveLedgerConfidence(row, nowMs) < DECAY_THRESHOLD;
  });
  if (!hasCandidate) {
    return { removed: 0, expired: 0, decayed: 0, failed: 0, failedIds: [] };
  }

  return modifyLedger(userId, async (file, registerRollback, afterCommit) => {
    const candidates = file.rows.map(row => ({
      id: row.id,
      tier: row.tier,
      statementFingerprint: statementFingerprint(row.statement),
    }));
    const removed = [];
    const failedIds = [];

    for (const candidate of candidates) {
      const idx = file.rows.findIndex(row => row.id === candidate.id);
      if (idx < 0) continue;
      const row = file.rows[idx];

      // Explicit stale-decision guards. Recompute freshness from the current
      // locked row as well; the preflight snapshot never authorizes deletion.
      if (row.tier !== candidate.tier
        || statementFingerprint(row.statement) !== candidate.statementFingerprint) continue;
      const expiresAt = temporaryExpiryTimestamp(row);
      const isExpired = Number.isFinite(expiresAt) && expiresAt <= nowMs;
      const effectiveConfidence = effectiveLedgerConfidence(row, nowMs);
      const isDecayed = row.tier !== 'confirmed' && effectiveConfidence < DECAY_THRESHOLD;
      if (!isExpired && !isDecayed) continue;

      if (!(await forgetOwnedCortex(userId, row, registerRollback))) {
        failedIds.push(row.id);
        continue;
      }
      file.rows.splice(idx, 1);
      removed.push({
        id: row.id,
        category: row.type,
        reason: isExpired ? 'expired' : 'decayed',
        effectiveConfidence,
      });
    }

    if (removed.length) {
      afterCommit(async () => {
        for (const item of removed) {
          await revokeOpaquePreferenceGrants(userId, item.id);
          await scrubHistoryForMemory(userId, item.id);
          await recordHistory(userId, {
            type: `profile.${item.reason}`,
            summary: item.reason === 'expired'
              ? 'Removed an expired temporary profile entry.'
              : 'Removed a stale inferred profile entry.',
            details: {
              memoryId: item.id,
              category: item.category,
              reason: item.reason,
              effectiveConfidence: Math.round(item.effectiveConfidence * 1000) / 1000,
            },
          });
        }
      });
    }
    return {
      removed: removed.length,
      expired: removed.filter(item => item.reason === 'expired').length,
      decayed: removed.filter(item => item.reason === 'decayed').length,
      failed: failedIds.length,
      failedIds,
    };
  });
}

export async function listLedger(userId, { includeContradicted = true } = {}) {
  const file = readLedgerFile(userId, { strict: true });
  return includeContradicted ? file.rows : file.rows.filter(r => r.status === 'active');
}

export async function getLedgerState(userId) {
  const file = readLedgerFile(userId, { strict: true });
  return { version: file.version, rows: file.rows, tombstones: file.tombstones };
}

/** Apply a validated reflection inference. */
export async function applyInference(userId, inference) {
  const statement = normalizeStatement(inference?.statement);
  const type = normalizeType(inference?.type);
  const confidence = Number.isFinite(inference?.confidence) ? Math.max(0, Math.min(1, inference.confidence)) : 0.6;
  const evidence = normalizeEvidence(inference?.evidence);
  const evidenceDetails = normalizeEvidenceDetails(inference?.evidenceDetails);
  const verb = ['new', 'reinforce', 'contradict'].includes(inference?.verb) ? inference.verb : 'new';
  const targetMemoryId = inference?.targetMemoryId || null;
  const inferencePolarity = inference?.polarity === 'negative' ? 'negative' : 'positive';
  const candidateStructure = normalizePreferenceStructure(inference?.structure);
  const inferenceStructure = candidateStructure?.sentiment === inferencePolarity
    ? candidateStructure : null;
  const tombstoneProbe = { type, structure: inferenceStructure };
  if (!userId || !statement || statement.length > MAX_STATEMENT_LEN || evidence.length === 0) {
    return { action: 'skipped', reason: 'invalid statement or evidence' };
  }
  if (isChildAccountJailbreak(userId, statement)) {
    return { action: 'skipped', reason: 'unsafe child-profile statement' };
  }

  if (verb === 'reinforce' || verb === 'contradict') {
    let target;
    try { target = assertId(targetMemoryId); } catch { return { action: 'skipped', reason: 'invalid target' }; }
    return modifyLedger(userId, async (file, registerRollback) => {
      const row = file.rows.find(r => r.id === target);
      if (!row) return { action: 'skipped', reason: 'target is not personalization-owned' };
      const current = await cortexRow(userId, target);
      if (!current.row || !['personalization', 'user_confirmed', 'user_corrected'].includes(current.row.source)) {
        return { action: 'skipped', reason: 'owned cortex target not found', memoryId: target };
      }
      if (verb === 'reinforce' && row.status === 'contradicted') {
        return { action: 'skipped', reason: 'contradicted target requires user review', memoryId: target };
      }
      const added = mergeEvidence(row, evidence, evidenceDetails);
      if (!added.length) return { action: 'skipped', reason: 'no novel evidence', memoryId: target };
      if (verb === 'reinforce') {
        const stability = Math.min(MAX_STABILITY, (current.row.stability || 24) * REINFORCE_MULTIPLIER);
        if (!(await reversibleCortexUpdate(userId, target, { stability }, registerRollback, current.row))) {
          throw new Error('failed to reinforce cortex memory');
        }
        row.confidence = Math.max(row.confidence ?? 0, confidence);
        row.lastObservedAt = row.updatedAt = new Date().toISOString();
        return { action: 'reinforced', memoryId: target };
      }
      row.flag = 'contradicted';
      row.contradictionStatement = statement;
      row.lastObservedAt = row.updatedAt = new Date().toISOString();
      // A model may challenge something the user explicitly confirmed, but it
      // may not silently overrule them. Surface the conflict for review while
      // keeping the confirmed Cortex fact active until the user edits/removes
      // it. Inferred rows are suppressed immediately below.
      if (row.tier === 'confirmed') {
        row.status = 'active';
        return { action: 'flagged', memoryId: target };
      }
      row.status = 'contradicted';
      // Keep the owned Cortex row present for user review. recall() excludes
      // contradicted status, while Confirm/Edit can safely reactivate it;
      // forgotten rows may be hard-deleted by cleanup before review.
      if (!(await reversibleCortexUpdate(userId, target, { forgotten: false, status: 'contradicted' }, registerRollback, current.row))) {
        throw new Error('failed to suppress contradicted cortex memory');
      }
      return { action: 'contradicted', memoryId: target };
    });
  }

  let pre;
  try {
    pre = readLedgerFile(userId, { strict: true });
  } catch (e) {
    // Never create a Cortex row when its ownership/provenance sidecar cannot
    // be read safely. Returning a retryable skip keeps background reflection
    // non-throwing and, crucially, leaves the corrupt file untouched.
    return { action: 'skipped', reason: `ledger unavailable: ${e.message}` };
  }
  const matchingOwned = pre.rows.find(row => statementFingerprint(row.statement) === statementFingerprint(statement));
  if (matchingOwned?.status === 'contradicted') {
    return { action: 'skipped', reason: 'contradicted claim requires user review', memoryId: matchingOwned.id };
  }
  if (isTombstoned(pre, statement, tombstoneProbe)) {
    return { action: 'skipped', reason: 'previously rejected by user' };
  }

  let record;
  try {
    record = await remember({
      agentId: 'shared', type: 'user_facts', text: `INFERRED: ${statement}`,
      immortal: false, source: 'personalization', confidence,
      metadata: { category: type, role_scope: inference?.scope || '' }, userId,
    });
  } catch (e) {
    return { action: 'skipped', reason: e.message };
  }
  if (!record?.id) return { action: 'skipped', reason: 'memory write returned no id' };
  if (record._dedupHit && record.source !== 'personalization') {
    return { action: 'known', memoryId: record.id, reason: 'already known outside personalization' };
  }

  try {
    const result = await modifyLedger(userId, async (file, registerRollback, afterCommit) => {
      if (isTombstoned(file, statement, tombstoneProbe)) {
        // remember() necessarily runs before the sidecar lock. A user can
        // delete/reject this statement in that gap, so the locked tombstone
        // recheck must also compensate the Cortex row remember() just created
        // (or rediscovered). Returning "skipped" alone leaves an active orphan
        // that recall can still inject despite the user's rejection.
        const current = await cortexRow(userId, record.id);
        if (current.row?.source === 'personalization' && current.row.forgotten !== true) {
          if (!(await reversibleCortexUpdate(userId, record.id, { forgotten: true }, registerRollback, current.row))) {
            throw new Error('failed to suppress tombstoned cortex memory');
          }
        }
        return { action: 'skipped', reason: 'previously rejected by user', memoryId: record.id };
      }
      let row = file.rows.find(r => r.id === record.id);
      if (row) {
        const added = mergeEvidence(row, evidence, evidenceDetails);
        row.lastObservedAt = row.updatedAt = new Date().toISOString();
        row.confidence = Math.max(row.confidence ?? 0, confidence);
        return { action: added.length ? 'deduped' : 'skipped', memoryId: record.id, reason: added.length ? undefined : 'no novel evidence' };
      }
      if (record._dedupHit) {
        // A personalization-source Cortex hit without a matching sidecar row
        // is an unmanaged crash orphan. Never adopt it under a semantically
        // close but potentially different statement: About You and recall
        // would then disagree. Suppress it and retry learning from clean
        // evidence on a later run.
        const current = await cortexRow(userId, record.id);
        if (current.row?.source === 'personalization' && current.row.forgotten !== true) {
          if (!(await reversibleCortexUpdate(userId, record.id, { forgotten: true }, registerRollback, current.row))) {
            throw new Error('failed to suppress unowned personalization dedup');
          }
        }
        return { action: 'skipped', reason: 'unowned personalization dedup', memoryId: record.id };
      }
      row = newRow({
        id: record.id, statement, type, confidence, evidence, evidenceDetails,
        scope: typeof inference?.scope === 'string' ? inference.scope : 'global',
        subject: typeof inference?.subject === 'string' ? inference.subject : null,
        polarity: inferencePolarity,
        structure: inferenceStructure,
      });
      if (!row) throw new Error('failed to normalize new ledger row');
      file.rows.push(row);
      if (!record._dedupHit) {
        afterCommit(() => recordHistory(userId, {
          type: 'profile.created', summary: statement,
          details: { memoryId: record.id, category: type, confidence },
        }));
      }
      return { action: 'created', memoryId: record.id };
    });
    return result;
  } catch (e) {
    // A newly-created Cortex row without a sidecar would be invisible to the
    // user's personalization controls. Roll it back rather than orphan it.
    if (!record._dedupHit) await updateCortex(userId, record.id, { forgotten: true }).catch(() => false);
    return { action: 'skipped', reason: `ledger write failed: ${e.message}`, memoryId: record.id };
  }
}

/**
 * Promote a directly stated user preference/constraint into the typed profile
 * immediately. Unlike inferred dedup, adopting a matching fact is safe here:
 * the user just stated it explicitly, and the Cortex row is rewritten as
 * user_confirmed before it becomes manageable through the ledger.
 */
export async function upsertExplicitProfile(userId, {
  statement = '', type = 'preference', scope = 'global', subject = null,
  polarity = 'positive', structure = undefined, evidence = [], evidenceDetails = [],
} = {}) {
  const text = normalizeStatement(statement);
  const profileType = normalizeType(type);
  const profilePolarity = polarity === 'negative' ? 'negative' : 'positive';
  const candidateStructure = normalizePreferenceStructure(structure);
  const normalizedStructure = candidateStructure?.sentiment === profilePolarity
    ? candidateStructure : null;
  if (!userId || text.length < 3 || text.length > MAX_STATEMENT_LEN) return null;
  if (isChildAccountJailbreak(userId, text)) return null;
  if (!(await explicitProfileWritesEnabled(userId))) return null;
  const record = await remember({
    agentId: 'shared', type: 'user_facts', text,
    immortal: false, source: 'user_confirmed', confidence: 0.99,
    metadata: { category: profileType, role_scope: scope === 'global' ? '' : scope }, userId,
  });
  if (!record?.id) return null;
  const values = {
    text, source: 'user_confirmed', confidence: 0.99, category: profileType,
    forgotten: false, status: 'active', stability: Math.max(720, record.stability || 24),
  };
  try {
    return await modifyLedger(userId, async (file, registerRollback, afterCommit) => {
      // Consent can change while remember() is embedding/writing. Re-check
      // under the sidecar lock immediately before promotion and suppress a
      // new Cortex row if collection was disabled in that gap.
      if (!(await explicitProfileWritesEnabled(userId))) {
        if (!record._dedupHit) {
          const current = await cortexRow(userId, record.id);
          if (current.row && !(await reversibleCortexUpdate(
            userId, record.id, { forgotten: true }, registerRollback, current.row,
          ))) throw new Error('failed to suppress profile memory after consent changed');
        }
        return null;
      }
      if (!(await reversibleCortexUpdate(userId, record.id, values, registerRollback))) {
        throw new Error('failed to promote explicit profile memory');
      }
      let row = file.rows.find(r => r.id === record.id);
      if (!row) {
        row = newRow({
          id: record.id, statement: text, type: profileType, tier: 'confirmed',
          scope, subject, polarity: profilePolarity,
          structure: normalizedStructure,
          confidence: 0.99, evidence, evidenceDetails,
          confirmedAt: new Date().toISOString(),
        });
        if (!row) throw new Error('failed to normalize explicit profile row');
        file.rows.push(row);
      } else {
        const priorStatement = row.statement;
        const priorPolarity = row.polarity;
        row.statement = text;
        row.type = profileType;
        row.scope = scope;
        row.subject = subject;
        row.polarity = profilePolarity;
        if (normalizedStructure) row.structure = normalizedStructure;
        else if (structure !== undefined
          || priorStatement !== text || priorPolarity !== profilePolarity) delete row.structure;
        row.tier = 'confirmed';
        row.confidence = 0.99;
        row.status = 'active';
        row.flag = null;
        row.confirmedAt ||= new Date().toISOString();
        row.updatedAt = new Date().toISOString();
        mergeEvidence(row, evidence, evidenceDetails);
      }
      afterCommit(async () => {
        await scrubHistoryForMemory(userId, record.id);
        await recordHistory(userId, { type: 'profile.explicit', summary: text, details: { memoryId: record.id, category: profileType } });
      });
      return row;
    });
  } catch (e) {
    // `remember` may have created a brand-new row before the sidecar lock/read
    // failed. It is not manageable without the sidecar, so hide that orphan.
    if (!record._dedupHit) await updateCortex(userId, record.id, { forgotten: true }).catch(() => false);
    throw e;
  }
}

async function explicitProfileWritesEnabled(userId) {
  try {
    const config = await getConfig(userId);
    return config?.enabled === true && config?.setupComplete !== false
      && config?.sources?.sessions !== false;
  } catch {
    return false;
  }
}

export async function confirmLedgerRow(userId, memoryId) {
  const id = assertId(memoryId);
  return modifyLedger(userId, async (file, registerRollback, afterCommit) => {
    const row = file.rows.find(r => r.id === id);
    if (!row) return null;
    if (isChildAccountJailbreak(userId, row.statement)) return null;
    const current = await cortexRow(userId, id);
    const values = {
      text: row.statement,
      source: 'user_confirmed',
      confidence: 0.99,
      category: row.type,
      stability: Math.max(720, Number(current.row?.stability) || 24),
      forgotten: false,
      status: 'active',
    };
    if (!(await reversibleCortexUpdate(userId, id, values, registerRollback, current.row))) throw new Error('failed to confirm cortex memory');
    row.tier = 'confirmed';
    row.confidence = 0.99;
    row.flag = null;
    row.status = 'active';
    row.contradictionStatement = null;
    row.confirmedAt = row.updatedAt = new Date().toISOString();
    afterCommit(() => recordHistory(userId, { type: 'profile.confirmed', summary: row.statement, details: { memoryId: id, category: row.type } }));
    return row;
  });
}

/** Edit/correct a fact, or remove it with durable negative feedback. */
export async function correctLedgerRow(userId, memoryId, { statement = null, reason = 'edit', type = null } = {}) {
  const id = assertId(memoryId);
  if (reason !== 'edit' && !NEGATIVE_REASONS.has(reason)) throw new Error('invalid correction reason');
  const preferenceTimeZone = reason === 'edit'
    ? (await getConfig(userId).catch(() => null))?.timezone || null : null;
  return modifyLedger(userId, async (file, registerRollback, afterCommit) => {
    const idx = file.rows.findIndex(r => r.id === id);
    if (idx < 0) return null;
    const row = file.rows[idx];
    if (reason !== 'edit') {
      if (!(await forgetOwnedCortex(userId, row, registerRollback))) throw new Error('failed to forget cortex memory');
      const days = reason === 'outdated' ? 30 : 3650;
      file.tombstones.push(makeTombstone(row, reason, days));
      file.rows.splice(idx, 1);
      afterCommit(async () => {
        await revokeOpaquePreferenceGrants(userId, id);
        await scrubHistoryForMemory(userId, id);
        await recordHistory(userId, {
          type: `profile.${reason}`,
          summary: 'Removed a personalization profile entry.',
          details: { memoryId: id, category: row.type, reason },
        });
      });
      return { removed: true, reason, id };
    }

    const next = normalizeStatement(statement);
    if (next.length < 3 || next.length > MAX_STATEMENT_LEN) throw new Error('statement must be 3-300 characters');
    if (isChildAccountJailbreak(userId, next)) throw new Error('unsafe child-profile statement');
    const nextType = type == null ? row.type : normalizeType(type);
    const vector = await embed(next);
    if (!vector.length || vector.every(v => v === 0)) throw new Error('embedding failed');
    const salience = await scoreSalience(next, { userId, agentId: 'shared' });
    const current = await cortexRow(userId, id);
    const values = {
      text: next, vector, source: 'user_corrected', confidence: 1,
      category: nextType, forgotten: false, status: 'active',
      salience_composite: salience.composite,
      emotional_weight: salience.emotional_weight,
      decision_weight: salience.decision_weight,
      uniqueness_score: salience.uniqueness,
      priority: salience.composite,
      stability: Math.max(720, Number(current.row?.stability) || 24), enriched: true,
    };
    if (!(await reversibleCortexUpdate(userId, id, values, registerRollback, current.row))) throw new Error('failed to update cortex memory');
    file.tombstones.push(makeTombstone(row, 'corrected', 3650));
    row.statement = next;
    row.type = nextType;
    // Rebuild every preference facet from the corrected wording. A concise
    // subject-only edit preserves the prior sentiment but never the prior
    // subject/merchant/price/context; a clear negative/positive canonical or
    // first-person phrase updates polarity too. Changing category clears the
    // old preference projection altogether.
    if (nextType === 'preference') {
      const correctedStructure = extractPreferenceStructure(next, { timeZone: preferenceTimeZone })
        || normalizePreferenceStructure({
          subject: next,
          sentiment: row.polarity === 'negative' ? 'negative' : 'positive',
        });
      if (!correctedStructure) throw new Error('corrected preference could not be structured safely');
      row.structure = correctedStructure;
      row.subject = correctedStructure.subject;
      row.polarity = correctedStructure.sentiment;
    } else {
      delete row.structure;
      row.subject = null;
      row.polarity = 'positive';
    }
    row.tier = 'confirmed';
    row.confidence = 1;
    row.flag = null;
    row.status = 'active';
    row.contradictionStatement = null;
    row.correctionReason = 'edit';
    row.confirmedAt ||= new Date().toISOString();
    row.updatedAt = new Date().toISOString();
    afterCommit(async () => {
      await scrubHistoryForMemory(userId, id);
      await recordHistory(userId, { type: 'profile.corrected', summary: next, details: { memoryId: id, category: nextType } });
    });
    return row;
  });
}

export async function forgetLedgerRow(userId, memoryId, { reason = 'forgotten', expectedStatement = null } = {}) {
  const id = assertId(memoryId);
  const expected = expectedStatement == null ? null : normalizeStatement(expectedStatement);
  return modifyLedger(userId, async (file, registerRollback, afterCommit) => {
    const idx = file.rows.findIndex(r => r.id === id);
    if (idx < 0) return false;
    const row = file.rows[idx];
    // Do not let a semantic-search hit delete wording that was corrected
    // between search and this locked transaction.
    if (expected != null && (!expected
      || statementFingerprint(row.statement) !== statementFingerprint(expected))) return false;
    if (!(await forgetOwnedCortex(userId, row, registerRollback))) return false;
    if (NEGATIVE_REASONS.has(reason)) {
      const days = reason === 'outdated' ? 30 : 3650;
      file.tombstones.push(makeTombstone(row, reason, days));
    }
    file.rows.splice(idx, 1);
    afterCommit(async () => {
      await revokeOpaquePreferenceGrants(userId, id);
      await scrubHistoryForMemory(userId, id);
      await recordHistory(userId, {
        type: 'profile.forgotten',
        summary: 'Removed a personalization profile entry.',
        details: { memoryId: id, category: row.type, reason },
      });
    });
    return true;
  });
}

export async function resetInferredRows(userId) {
  return modifyLedger(userId, async (file, registerRollback, afterCommit) => {
    const snapshot = file.rows.filter(r => r.tier !== 'confirmed');
    const removedIds = new Set();
    const failedIds = [];
    for (const row of snapshot) {
      if (await forgetOwnedCortex(userId, row, registerRollback)) removedIds.add(row.id);
      else failedIds.push(row.id);
    }
    file.rows = file.rows.filter(r => !removedIds.has(r.id));
    afterCommit(async () => {
      for (const id of removedIds) await scrubHistoryForMemory(userId, id);
      await recordHistory(userId, { type: 'profile.reset', summary: `Removed ${removedIds.size} inferred profile entries.`, details: { removed: removedIds.size, failed: failedIds.length } });
    });
    return { removed: removedIds.size, failed: failedIds.length, failedIds, keptConfirmed: file.rows.filter(r => r.tier === 'confirmed').length };
  });
}

/** Legacy cortex-only API retained for older route/tests; source-safe. */
export async function forgetInferredRow(userId, memoryId) {
  let id;
  try { id = assertId(memoryId); } catch { return false; }
  const file = readLedgerFile(userId, { strict: true });
  const row = file.rows.find(r => r.id === id);
  return forgetOwnedCortex(userId, row);
}
