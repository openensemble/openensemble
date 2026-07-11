// @ts-check
/**
 * Per-offer-kind telemetry: accept/dismiss counters, dismiss-suppression,
 * "graduate to always-do-this" escalation, and the daily unsolicited-ping
 * budget. Storage: users/<uid>/personalization/outcomes.json — plaintext is
 * fine (kind slugs + counters only, no raw content), written atomically with
 * version + updated_at per the voice-config.mjs convention.
 *
 * outcomes.json shape:
 *   { version, updated_at,
 *     kinds: { <kind>: { accepts, dismisses, suppressed, suppressedAt?,
 *                         autoApproved, autoApprovedAt?, graduateOffered } },
 *     pings: { date: 'YYYY-MM-DD', count } }
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR, userRoleRulesPath } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';
import { configLocalDateKey } from './config.mjs';

const CONFIG_DEFAULTS = {
  acceptGraduateThreshold: 2,
  dismissSuppressThreshold: 2,
  maxUnsolicitedPingsPerDay: 2,
};

// A suppressed kind is not suppressed FOREVER — after this long with no new
// dismissal, it becomes offerable again (a kind the user disliked six months
// ago may be welcome now; without this, two old dismissals lock a kind out
// permanently with no route back other than an admin/db edit). A fresh
// dismissal after expiry re-suppresses (see the dismiss branch below), so a
// kind the user still doesn't want stays suppressed in practice.
const SUPPRESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KIND_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_KIND_LEN = 60;

/** Offer-policy keys are server contracts, not free-form model prose. */
export function isCanonicalOfferKind(kind) {
  return typeof kind === 'string'
    && kind.length > 0
    && kind.length <= MAX_KIND_LEN
    && KIND_RE.test(kind);
}

function requireKind(kind, caller) {
  if (!isCanonicalOfferKind(kind)) {
    throw new Error(`${caller}: kind must be a lowercase kebab slug (max ${MAX_KIND_LEN} chars)`);
  }
  return kind;
}

/** True if `rec` is CURRENTLY suppressed — i.e. the flag is set AND (no
 * timestamp recorded, or the timestamp is within SUPPRESSION_TTL_MS). */
function _isSuppressionActive(rec) {
  if (!rec?.suppressed) return false;
  if (rec.suppressionManual) return true;
  if (!rec.suppressedAt) return true; // legacy record with no timestamp — treat as still active
  const ageMs = Date.now() - Date.parse(rec.suppressedAt);
  // A corrupt timestamp must not silently re-enable a behavior the user
  // muted. Treat it like the legacy missing-timestamp shape: fail closed.
  return !Number.isFinite(ageMs) || ageMs < SUPPRESSION_TTL_MS;
}

async function _safeConfig(userId) {
  try {
    const { getConfig } = await import('./config.mjs');
    const cfg = await getConfig(userId);
    return { ...CONFIG_DEFAULTS, ...cfg };
  } catch (e) {
    console.warn(`[personalization] graduation: config unavailable, disabling automatic escalation (${e.message})`);
    return {
      ...CONFIG_DEFAULTS,
      acceptGraduateThreshold: Number.MAX_SAFE_INTEGER,
      dismissSuppressThreshold: Number.MAX_SAFE_INTEGER,
      maxUnsolicitedPingsPerDay: 0,
    };
  }
}

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}
function outcomesPath(userId) {
  return path.join(personalizationDir(userId), 'outcomes.json');
}

function normalizeKindRecord(value) {
  const rec = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const nonnegativeInt = input => Number.isInteger(input) && input >= 0 ? input : 0;
  return {
    accepts: nonnegativeInt(rec.accepts),
    dismisses: nonnegativeInt(rec.dismisses),
    suppressed: rec.suppressed === true,
    suppressionManual: rec.suppressionManual === true,
    suppressedAt: typeof rec.suppressedAt === 'string' ? rec.suppressedAt : null,
    autoApproved: rec.autoApproved === true,
    autoApprovedAt: typeof rec.autoApprovedAt === 'string' ? rec.autoApprovedAt : null,
    autoApprovalRevokedAt: typeof rec.autoApprovalRevokedAt === 'string' ? rec.autoApprovalRevokedAt : null,
    graduateOffered: rec.graduateOffered === true,
    graduationBlocked: rec.graduationBlocked === true,
    updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : null,
    ...(rec.ruleArtifact && typeof rec.ruleArtifact === 'object' && typeof rec.ruleArtifact.ruleText === 'string'
      ? { ruleArtifact: {
        roleId: typeof rec.ruleArtifact.roleId === 'string' ? rec.ruleArtifact.roleId : 'coordinator',
        ruleText: rec.ruleArtifact.ruleText.slice(0, 500),
      } } : {}),
  };
}

function _readFile(userId, { strict = false } = {}) {
  const p = outcomesPath(userId);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || !data.kinds || typeof data.kinds !== 'object' || Array.isArray(data.kinds)) {
      throw new Error('invalid outcomes envelope');
    }
    const kinds = Object.create(null);
    for (const [kind, rec] of Object.entries(data.kinds)) kinds[kind] = normalizeKindRecord(rec);
    return {
      version: Number.isInteger(data.version) ? data.version : 0,
      // Null-prototype + own-entry copy prevents model-controlled kind keys
      // such as "__proto__" / "constructor" from reaching Object.prototype.
      kinds,
      pings: {
        date: typeof data.pings?.date === 'string' ? data.pings.date : null,
        count: Number.isInteger(data.pings?.count) && data.pings.count >= 0 ? data.pings.count : 0,
      },
    };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[personalization] outcomes.json read failed for ${userId}: ${e.message}`);
      if (strict) throw new Error(`Personalization outcomes are unreadable: ${e.message}`);
    }
    return { version: 0, kinds: Object.create(null), pings: { date: null, count: 0 } };
  }
}

function _writeFile(userId, file) {
  const dir = personalizationDir(userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const data = { version: (file.version || 0) + 1, updated_at: Date.now(), kinds: file.kinds, pings: file.pings };
  atomicWriteSync(outcomesPath(userId), JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(outcomesPath(userId), 0o600); } catch { /* best effort */ }
}

function _kindRec(file, kind) {
  if (!Object.hasOwn(file.kinds, kind) || !file.kinds[kind] || typeof file.kinds[kind] !== 'object') {
    file.kinds[kind] = { accepts: 0, dismisses: 0, suppressed: false, autoApproved: false, graduateOffered: false };
  }
  return file.kinds[kind];
}

function _legacyRuleArtifact(userId, kind) {
  try {
    const p = path.join(USERS_DIR, userId, 'proposals.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const proposals = Array.isArray(data?.proposals) ? data.proposals : [];
    const match = [...proposals].reverse().find(row => row?.kind === 'personalization_graduate'
      && row.offerKind === kind && row.producedArtifact?.kind === 'rule');
    return match?.producedArtifact?.ruleText ? {
      roleId: match.producedArtifact.roleId || match.roleId || 'coordinator',
      ruleText: String(match.producedArtifact.ruleText),
    } : null;
  } catch { return null; }
}

/**
 * Records an accept/dismiss for an offer kind and evaluates the graduate /
 * suppress thresholds. `graduate` fires exactly once — the first check that
 * crosses acceptGraduateThreshold — so the "want me to always do this?"
 * follow-up proposal isn't re-created on every subsequent accept.
 */
export async function recordOfferOutcome(userId, kind, outcome) {
  if (!userId || !kind) throw new Error('recordOfferOutcome: userId and kind required');
  requireKind(kind, 'recordOfferOutcome');
  const cfg = await _safeConfig(userId);
  return withLock(outcomesPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const rec = _kindRec(file, kind);
    let graduate = false;

    if (outcome === 'accept') {
      rec.accepts += 1;
      if (!rec.autoApproved && !rec.graduateOffered && !rec.graduationBlocked
        && rec.accepts >= cfg.acceptGraduateThreshold) {
        rec.graduateOffered = true;
        graduate = true;
      }
    } else if (outcome === 'dismiss') {
      rec.dismisses += 1;
      // Re-arms suppression on a FRESH dismissal even after a prior
      // suppression has expired (_isSuppressionActive is false past the
      // 30-day TTL) — dismisses never reset, so once the threshold has been
      // crossed once, any later dismissal while not currently suppressed
      // re-suppresses with a new suppressedAt, restarting the 30-day clock.
      if (!_isSuppressionActive(rec) && rec.dismisses >= cfg.dismissSuppressThreshold) {
        rec.suppressed = true;
        rec.suppressionManual = false;
        rec.suppressedAt = new Date().toISOString();
      }
    }

    rec.updatedAt = new Date().toISOString();

    _writeFile(userId, file);
    return { graduate, suppressed: _isSuppressionActive(rec), counts: { accepts: rec.accepts, dismisses: rec.dismisses } };
  });
}

/**
 * Whether offers of this kind should be filtered out before rendering.
 * Auto-expires after SUPPRESSION_TTL_MS (see _isSuppressionActive) — a
 * suppressed kind becomes offerable again once that long has passed with no
 * fresh dismissal.
 */
export async function isKindSuppressed(userId, kind) {
  if (!isCanonicalOfferKind(kind)) return true; // invalid model output fails closed
  const file = _readFile(userId, { strict: true });
  return _isSuppressionActive(Object.hasOwn(file.kinds, kind) ? file.kinds[kind] : null);
}

/**
 * Marks a kind auto-approved after the user accepts the graduate ("always do
 * this?") proposal — future offers of that kind execute immediately with a
 * receipt notice instead of a card. Additive export (not in the original
 * spec list) — offer-handlers.mjs (runPersonalizationGraduate) is the only
 * caller; reflect.mjs consults isKindAutoApproved below before deciding
 * whether to render a card or auto-execute.
 */
export async function markKindAutoApproved(userId, kind, { roleId = null, ruleText = null } = {}) {
  if (!userId || !kind) return false;
  requireKind(kind, 'markKindAutoApproved');
  return withLock(outcomesPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const rec = _kindRec(file, kind);
    rec.autoApproved = true;
    rec.autoApprovedAt = new Date().toISOString();
    rec.autoApprovalRevokedAt = null;
    rec.graduationBlocked = false;
    rec.graduateOffered = true;
    if (typeof ruleText === 'string' && ruleText.trim()) {
      rec.ruleArtifact = { roleId: roleId || 'coordinator', ruleText: ruleText.trim().slice(0, 500) };
    }
    rec.updatedAt = new Date().toISOString();
    _writeFile(userId, file);
    return true;
  });
}

/** Whether a kind has already graduated to auto-approved. */
export async function isKindAutoApproved(userId, kind) {
  if (!isCanonicalOfferKind(kind)) return false;
  const file = _readFile(userId, { strict: true });
  return Object.hasOwn(file.kinds, kind) && file.kinds[kind]?.autoApproved === true;
}

/**
 * Whether initiativeMode=safe_auto may run this exact kind unattended.
 * `graduationBlocked` is the existing durable "keep asking" bit set when a
 * user revokes automatic behavior. Reusing it keeps Undo distinct from Mute:
 * blocked kinds can still surface ask-first suggestions, while suppressed
 * kinds cannot surface at all.
 */
export async function isKindSafeAutoAllowed(userId, kind) {
  if (!isCanonicalOfferKind(kind)) return false;
  const file = _readFile(userId, { strict: true });
  if (!Object.hasOwn(file.kinds, kind)) return true;
  return file.kinds[kind]?.graduationBlocked !== true;
}

/** Return an auto-approved kind to ask-first behavior without erasing history. */
export async function revokeKindAutoApproval(userId, kind) {
  if (!userId) throw new Error('revokeKindAutoApproval: userId required');
  requireKind(kind, 'revokeKindAutoApproval');
  const result = await withLock(outcomesPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const rec = _kindRec(file, kind);
    const ruleArtifact = rec.ruleArtifact || _legacyRuleArtifact(userId, kind);
    const previous = {
      autoApproved: rec.autoApproved === true,
      autoApprovedAt: rec.autoApprovedAt || null,
      graduationBlocked: rec.graduationBlocked === true,
      graduateOffered: rec.graduateOffered === true,
    };
    rec.autoApproved = false;
    rec.autoApprovalRevokedAt = new Date().toISOString();
    // A manual revoke means "keep asking", not "ask me to graduate again on
    // the next successful action".
    rec.graduationBlocked = true;
    rec.graduateOffered = true;
    rec.updatedAt = new Date().toISOString();
    _writeFile(userId, file);
    return { ok: true, kind, autoApproved: false, ruleArtifact, previous };
  });
  let ruleRemoved = false;
  /** @type {Error|null} */
  let cleanupError = null;
  const artifact = result.ruleArtifact;
  if (artifact?.ruleText) {
    const rp = userRoleRulesPath(userId, artifact.roleId || 'coordinator');
    await withLock(rp, () => {
      try {
        if (!fs.existsSync(rp)) return;
        const exact = `- ${String(artifact.ruleText).trim()}`;
        const before = fs.readFileSync(rp, 'utf8').split('\n');
        const after = before.filter(line => line.trim() !== exact);
        if (after.length === before.length) return;
        atomicWriteSync(rp, after.filter(Boolean).join('\n') + (after.some(Boolean) ? '\n' : ''), { mode: 0o600 });
        try { fs.chmodSync(rp, 0o600); } catch { /* best effort */ }
        ruleRemoved = true;
      } catch (e) {
        console.warn(`[personalization] revoke auto-approval rule cleanup failed for ${kind}: ${e.message}`);
        cleanupError = e instanceof Error ? e : new Error(String(e));
      }
    });
  }
  if (cleanupError) {
    // Do not let Settings claim "Ask first" while a legacy imperative rule
    // still exists. Restore visible automatic state before surfacing failure.
    await withLock(outcomesPath(userId), () => {
      const file = _readFile(userId, { strict: true });
      const rec = _kindRec(file, kind);
      rec.autoApproved = result.previous.autoApproved;
      rec.autoApprovedAt = result.previous.autoApprovedAt;
      rec.autoApprovalRevokedAt = null;
      rec.graduationBlocked = result.previous.graduationBlocked;
      rec.graduateOffered = result.previous.graduateOffered;
      rec.updatedAt = new Date().toISOString();
      _writeFile(userId, file);
    });
    throw new Error(`Auto-approval was revoked, but a legacy standing rule could not be removed: ${cleanupError.message}`);
  }
  const { ruleArtifact, previous, ...publicResult } = result;
  return { ...publicResult, ruleRemoved };
}

/** Explicit UI mute/resume; automatic dismiss suppression still has a TTL. */
export async function setKindSuppressed(userId, kind, suppressed) {
  if (!userId) throw new Error('setKindSuppressed: userId required');
  requireKind(kind, 'setKindSuppressed');
  return withLock(outcomesPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const rec = _kindRec(file, kind);
    rec.suppressed = !!suppressed;
    rec.suppressionManual = !!suppressed;
    rec.suppressedAt = suppressed ? new Date().toISOString() : null;
    rec.updatedAt = new Date().toISOString();
    _writeFile(userId, file);
    return { ok: true, kind, suppressed: !!suppressed };
  });
}

export function suppressKindOffers(userId, kind) {
  return setKindSuppressed(userId, kind, true);
}

export function resumeKindOffers(userId, kind) {
  return setKindSuppressed(userId, kind, false);
}

/**
 * Release the one-shot graduate proposal latch when proposal persistence was
 * rejected or failed.  Successful creation leaves the latch set.
 */
export async function resetGraduateOffer(userId, kind) {
  if (!userId || !isCanonicalOfferKind(kind)) return false;
  return withLock(outcomesPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    if (!Object.hasOwn(file.kinds, kind)) return false;
    const rec = file.kinds[kind];
    if (rec.autoApproved || rec.graduationBlocked) return false;
    rec.graduateOffered = false;
    rec.updatedAt = new Date().toISOString();
    _writeFile(userId, file);
    return true;
  });
}

/** UI-facing, TTL-aware policy inventory. */
export async function listOfferPolicies(userId) {
  if (!userId) return [];
  const file = _readFile(userId, { strict: true });
  return Object.entries(file.kinds)
    .filter(([kind, rec]) => isCanonicalOfferKind(kind) && rec && typeof rec === 'object')
    .map(([kind, rec]) => {
      const suppressed = _isSuppressionActive(rec);
      const suppressedAtMs = Date.parse(rec.suppressedAt || '');
      return {
        kind,
        accepts: Math.max(0, Number(rec.accepts) || 0),
        dismisses: Math.max(0, Number(rec.dismisses) || 0),
        suppressed,
        suppressedAt: rec.suppressedAt || null,
        suppressionExpiresAt: suppressed && !rec.suppressionManual && Number.isFinite(suppressedAtMs)
          ? new Date(suppressedAtMs + SUPPRESSION_TTL_MS).toISOString() : null,
        // Malformed legacy truthy strings must never authorize unattended
        // execution. Only the literal boolean true is authoritative.
        autoApproved: rec.autoApproved === true,
        autoApprovedAt: rec.autoApprovedAt || null,
        autoApprovalRevokedAt: rec.autoApprovalRevokedAt || null,
        safeAutoBlocked: rec.graduationBlocked === true,
        graduateOffered: !!rec.graduateOffered,
        updatedAt: rec.updatedAt || rec.autoApprovedAt || rec.suppressedAt || null,
      };
    })
    .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '') || a.kind.localeCompare(b.kind));
}

/**
 * Daily unsolicited-ping budget (config.maxUnsolicitedPingsPerDay). The
 * check-and-increment happens under the file lock so it's atomic even if
 * multiple lead hits resolve in the same sweep tick. Day boundary is the
 * UTC calendar date — coarse, but fine for a soft "don't nag more than N
 * times a day" guard.
 */
export async function consumePingBudget(userId) {
  const cfg = await _safeConfig(userId);
  return withLock(outcomesPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const today = configLocalDateKey(cfg, new Date());
    if (file.pings.date !== today) file.pings = { date: today, count: 0 };
    if (file.pings.count >= cfg.maxUnsolicitedPingsPerDay) return false;
    file.pings.count += 1;
    _writeFile(userId, file);
    return true;
  });
}

/** Undo a reservation when no delivery channel accepted the notification. */
export async function refundPingBudget(userId) {
  const cfg = await _safeConfig(userId);
  return withLock(outcomesPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const today = configLocalDateKey(cfg, new Date());
    if (file.pings.date !== today || !(file.pings.count > 0)) return false;
    file.pings.count -= 1;
    _writeFile(userId, file);
    return true;
  });
}
