// @ts-check
/**
 * Read-only, policy-enforcing Personalization surface for skills.
 *
 * Skills never query Cortex directly. The helper is bound by the host to one
 * user and one owning skill, re-checks the master switch on every call, and
 * returns only a small projection of confirmed preferences matching keywords
 * that skill declared in preferenceOpportunities.
 */
import { canonicalPreferenceSubjectKey } from './preference-structure.mjs';

const MAX_OPPORTUNITIES = 3;
const MAX_KEYWORDS = 32;
const MAX_RESULTS = 20;
const MAX_STATEMENT_LEN = 300;
const MAX_SUBJECT_LEN = 120;
const MAX_MERCHANT_LEN = 80;
const MAX_CONTEXT_LEN = 40;
const MAX_UNIT_LEN = 24;
const MAX_TEMPORARY_HINT_LEN = 40;
const MAX_PRICE = 100_000_000;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function declaredKeywords(manifest) {
  const values = Array.isArray(manifest?.preferenceOpportunities)
    ? manifest.preferenceOpportunities.slice(0, MAX_OPPORTUNITIES) : [];
  const tools = new Map((manifest?.tools || [])
    .map(tool => [tool?.function?.name, tool])
    .filter(([name]) => typeof name === 'string' && name));
  const watchers = new Set((manifest?.watchers || [])
    .map(watcher => typeof watcher?.kind === 'string' ? watcher.kind : '')
    .filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const opportunity of values) {
    const id = typeof opportunity?.id === 'string' ? opportunity.id.trim() : '';
    const activationTool = typeof opportunity?.activationTool === 'string' ? opportunity.activationTool.trim() : '';
    const watcherKind = typeof opportunity?.watcherKind === 'string' ? opportunity.watcherKind.trim() : '';
    const dedupKey = typeof opportunity?.dedupKey === 'string' ? opportunity.dedupKey.trim() : '';
    // Do not let a stray keyword-only manifest field become a profile-read
    // capability. The same skill must own a confirmation-gated activation
    // tool and the watcher kind described by a structurally valid recipe.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64
      || tools.get(activationTool)?.destructive !== true || !watchers.has(watcherKind)
      || !dedupKey || dedupKey.length > 160) continue;
    for (const raw of (Array.isArray(opportunity?.preferenceKeywords) ? opportunity.preferenceKeywords : [])) {
      const keyword = normalizeText(raw);
      if (keyword.length < 3 || keyword.length > 40 || seen.has(keyword)) continue;
      seen.add(keyword);
      out.push(keyword);
      if (out.length >= MAX_KEYWORDS) return out;
    }
  }
  return out;
}

function matchesKeyword(statement, keywords) {
  const normalized = normalizeText(statement);
  const tokens = normalized.split(' ').filter(Boolean);
  return keywords.some(keyword => {
    if (keyword.includes(' ')) return ` ${normalized} `.includes(` ${keyword} `);
    return tokens.some(token => token === keyword || token === `${keyword}s` || token === `${keyword}es`);
  });
}

function preferenceMatchText(row) {
  return [row?.structure?.subject, row?.subject, row?.statement]
    .filter(value => typeof value === 'string' && value.trim())
    .join(' ');
}

function preferenceStillCurrent(row, now = Date.now()) {
  const expiresAt = row?.structure?.temporary?.expiresAt;
  return !expiresAt || (Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > now);
}

function projectionText(value, maxLen) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

/**
 * Re-project an already validated ledger row at the skill boundary. The ledger
 * is canonical, but this second clamp ensures a mocked, migrated, or partially
 * corrupt source still cannot widen the skill-facing shape.
 */
function projectPreferenceDetail(row) {
  const structure = row?.structure && typeof row.structure === 'object'
    && !Array.isArray(row.structure) ? row.structure : null;
  const statement = projectionText(row?.statement, MAX_STATEMENT_LEN);
  const subject = projectionText(
    structure?.subject || row?.subject || statement,
    MAX_SUBJECT_LEN,
  );
  const merchant = projectionText(structure?.merchant, MAX_MERCHANT_LEN);
  const context = projectionText(structure?.context, MAX_CONTEXT_LEN);

  const priceValue = structure?.priceCeiling?.value;
  const priceCurrency = projectionText(structure?.priceCeiling?.currency, 3).toUpperCase();
  const priceUnit = projectionText(structure?.priceCeiling?.unit, MAX_UNIT_LEN);
  const priceCeiling = typeof priceValue === 'number' && Number.isFinite(priceValue)
    && priceValue > 0 && priceValue <= MAX_PRICE
    ? {
        value: Math.round(priceValue * 100) / 100,
        ...(/^[A-Z]{3}$/.test(priceCurrency) ? { currency: priceCurrency } : {}),
        ...(priceUnit ? { unit: priceUnit } : {}),
      }
    : null;

  const temporaryHint = projectionText(structure?.temporary?.hint, MAX_TEMPORARY_HINT_LEN);
  const rawExpiresAt = projectionText(structure?.temporary?.expiresAt, 40);
  const expiresAtMs = Date.parse(rawExpiresAt);
  const temporary = temporaryHint || Number.isFinite(expiresAtMs)
    ? {
        ...(temporaryHint ? { hint: temporaryHint } : {}),
        ...(Number.isFinite(expiresAtMs) ? { expiresAt: new Date(expiresAtMs).toISOString() } : {}),
      }
    : null;

  return {
    statement,
    subject,
    sentiment: row?.polarity === 'negative' ? 'negative' : 'positive',
    ...(merchant ? { merchant } : {}),
    ...(context ? { context } : {}),
    ...(priceCeiling ? { priceCeiling } : {}),
    ...(temporary ? { temporary } : {}),
  };
}

async function matchingConfirmedRows(userId, skillId, authorization = null) {
  if (!userId || !skillId) return [];
  // Keep this module dependency-free at load time: roles.mjs exposes the
  // in-process ctx and also sits on a route/memory import cycle. Loading
  // config/ledger only when a skill actually asks avoids that cycle.
  const { getConfig } = await import('./config.mjs');
  const config = await getConfig(userId);
  if (config?.enabled !== true || config?.setupComplete !== true) return [];

  const [{ listRoles }, { listLedger }, userHelpers] = await Promise.all([
    import('../../roles.mjs'),
    import('./ledger.mjs'),
    import('../../routes/_helpers.mjs'),
  ]);
  const profile = userHelpers.getUser?.(userId);
  let enabledSkills;
  try { enabledSkills = userHelpers.getUserEnabledSkills?.(userId); } catch { return []; }
  if (!profile || !Array.isArray(enabledSkills) || !enabledSkills.includes(skillId)
    || (profile.role === 'child' && Array.isArray(profile.allowedSkills)
      && !profile.allowedSkills.includes(skillId))) return [];
  const manifestCandidates = listRoles(userId).filter(candidate => candidate?.id === skillId);
  const manifest = manifestCandidates.find(candidate => candidate?.userScope === userId)
    || manifestCandidates.find(candidate => candidate?.userScope == null);
  if (!manifest || manifest.id !== skillId) return [];
  const keywords = declaredKeywords(manifest);
  if (!keywords.length) return [];
  let proactive = false;
  try {
    const configMod = await import('./config.mjs');
    if (typeof configMod.isProactiveEngagement === 'function') {
      proactive = configMod.isProactiveEngagement(config);
    } else if (typeof configMod.isCompanionEngagement === 'function') {
      proactive = configMod.isCompanionEngagement(config);
    } else {
      proactive = config?.engagement === 'proactive' || config?.engagement === 'companion';
    }
  } catch {
    proactive = config?.engagement === 'proactive' || config?.engagement === 'companion';
  }

  let trusted = false;
  try {
    const { reviewedInformationalSkillDigest } = await import('./reviewed-informational-skills.mjs');
    trusted = !!reviewedInformationalSkillDigest(userId, manifest);
  } catch { trusted = false; }
  let granted = new Set();
  if (!trusted) {
    try {
      const grants = await import('./skill-preference-grants.mjs');
      const identity = grants.currentSkillGrantIdentity(userId, manifest);
      if (!identity) return [];
      const records = await grants.grantedPreferenceGrantsForSkill(userId, skillId);
      const watchers = await import('../../scheduler/watchers.mjs');
      watchers.assertWatcherStoreHealthy(userId);
      const active = new Map((watchers.listWatchers(userId)?.active || [])
        .map(watcher => [watcher.id, watcher]));
      granted = new Set(records
        .filter(grant => grant.executorDigest === identity.executorDigest
          && grant.manifestDigest === identity.manifestDigest
          && active.get(grant.watcherId)?.personalizationOrigin?.type === 'preference_approved'
          && active.get(grant.watcherId)?.personalizationOrigin?.contractFingerprint === grant.contractFingerprint
          && active.get(grant.watcherId)?.personalizationOrigin?.preferenceMemoryId === grant.preferenceMemoryId
          && active.get(grant.watcherId)?.personalizationOrigin?.executorDigest === grant.executorDigest
          && active.get(grant.watcherId)?.personalizationOrigin?.manifestDigest === grant.manifestDigest)
        .map(grant => grant.preferenceMemoryId));
      const { getPreferenceSafeAutoContext } = await import('./safe-auto-context.mjs');
      const transient = getPreferenceSafeAutoContext();
      if (transient?.mode === 'approved' && transient.skillId === skillId
        && typeof transient.preferenceMemoryId === 'string') {
        granted.add(transient.preferenceMemoryId);
      }
    } catch {
      return []; // an unreadable grant store is never implicit consent
    }
  }
  const rows = await listLedger(userId, { includeContradicted: false });
  const watcherBoundIds = new Set((Array.isArray(authorization?.preferenceMemoryIds)
    ? authorization.preferenceMemoryIds : [authorization?.preferenceMemoryId])
    .filter(value => typeof value === 'string' && value));
  const now = Date.now();
  const subjectKey = row => canonicalPreferenceSubjectKey(
    row?.structure?.subject || row?.subject || row?.statement,
  );
  const facet = (row, key) => normalizeText(row?.structure?.[key]);
  const facetsConflict = (left, right) => {
    if (!subjectKey(left) || subjectKey(left) !== subjectKey(right)) return false;
    for (const key of ['merchant', 'context']) {
      const a = facet(left, key);
      const b = facet(right, key);
      // A general preference conflicts with a more specific one; two explicit
      // but different merchants/contexts describe separate preferences.
      if (a && b && a !== b) return false;
    }
    return true;
  };
  const observedAt = row => Date.parse(
    row?.updatedAt || row?.confirmedAt || row?.createdAt || '',
  ) || 0;
  const matchingRows = rows
    .filter(row => row?.tier === 'confirmed' && row?.type === 'preference'
      && row?.status === 'active' && !row?.flag
      && (row.scope === 'global' || row.scope === skillId)
      && (!watcherBoundIds.size || watcherBoundIds.has(row.id) || row.polarity === 'negative')
      && preferenceStillCurrent(row, now)
      && (
        matchesKeyword(preferenceMatchText(row), keywords)
        // Proactive soft-confirmed prefs are skill-scoped; include them even
        // when the subject was never listed in the skill's static keywords.
        || (proactive && row.scope === skillId
          && String(row?.structure?.subject || row?.subject || '').trim().length >= 3)
      ));
  const authorizedRows = matchingRows
    // A scope label is organization, not consent. Every unreviewed skill read
    // requires the exact opaque grant bound to its active approved watcher.
    .filter(row => trusted || granted.has(row.id));
  // Exact-grant privacy: an unreviewed skill's result may be influenced only
  // by rows it is authorized to read. Host-level watcher authorization sees
  // the full ledger and revokes/stops a now-conflicted watcher separately.
  const negatives = authorizedRows.filter(row => row.polarity === 'negative');
  return authorizedRows
    .filter(row => row.polarity !== 'negative')
    .filter(row => !negatives.some(negative => facetsConflict(row, negative)
      && observedAt(negative) >= observedAt(row)))
    .sort((a, b) => observedAt(b) - observedAt(a))
    .slice(0, MAX_RESULTS);
}

export async function confirmedPreferencesForSkill(userId, skillId, authorization = null) {
  if (!userId || !skillId) return [];
  try {
    const rows = await matchingConfirmedRows(userId, skillId, authorization);
    const seen = new Set();
    return rows
      .flatMap(row => {
        const statement = projectionText(row.statement, MAX_STATEMENT_LEN);
        if (!statement || seen.has(statement.toLocaleLowerCase())) return [];
        seen.add(statement.toLocaleLowerCase());
        return [statement];
      })
      .slice(0, MAX_RESULTS);
  } catch (e) {
    console.warn(`[personalization] confirmedPreferences unavailable for ${userId}/${skillId}: ${e?.message || e}`);
    return [];
  }
}

/**
 * Additive structured projection for skills that can apply conditions such as
 * merchant, context, a price ceiling, or a temporary expiry. It exposes no
 * evidence/provenance and remains bounded by the skill's own declared
 * preference keywords. The legacy string helper above remains unchanged.
 */
export async function confirmedPreferenceDetailsForSkill(userId, skillId, authorization = null) {
  if (!userId || !skillId) return [];
  try {
    const rows = await matchingConfirmedRows(userId, skillId, authorization);
    return rows.map(projectPreferenceDetail);
  } catch (e) {
    console.warn(`[personalization] confirmedPreferenceDetails unavailable for ${userId}/${skillId}: ${e?.message || e}`);
    return [];
  }
}

/**
 * A watcher may bind this surface to one exact opaque preference id. That
 * prevents a broad skill-level keyword declaration from making a receipt or
 * explanation about a different preference than the one the user approved.
 * Interactive tool calls intentionally omit this option and retain the
 * ordinary skill-scoped union.
 * @param {{userId?: string, skillId?: string|null, preferenceMemoryId?: string|null}} [opts]
 */
export function buildSkillPersonalizationHelpers(opts = {}) {
  const { userId, skillId, preferenceMemoryId = null } = opts;
  const authorization = preferenceMemoryId ? { preferenceMemoryId } : null;
  return {
    confirmedPreferences: () => confirmedPreferencesForSkill(userId, skillId, authorization),
    confirmedPreferenceDetails: () => confirmedPreferenceDetailsForSkill(userId, skillId, authorization),
  };
}
