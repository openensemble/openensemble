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
import { USERS_DIR } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';

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

/** True if `rec` is CURRENTLY suppressed — i.e. the flag is set AND (no
 * timestamp recorded, or the timestamp is within SUPPRESSION_TTL_MS). */
function _isSuppressionActive(rec) {
  if (!rec?.suppressed) return false;
  if (!rec.suppressedAt) return true; // legacy record with no timestamp — treat as still active
  const ageMs = Date.now() - Date.parse(rec.suppressedAt);
  return Number.isFinite(ageMs) && ageMs < SUPPRESSION_TTL_MS;
}

async function _safeConfig(userId) {
  try {
    const { getConfig } = await import('./config.mjs');
    const cfg = await getConfig(userId);
    return { ...CONFIG_DEFAULTS, ...cfg };
  } catch (e) {
    console.warn(`[personalization] graduation: config unavailable, using defaults (${e.message})`);
    return { ...CONFIG_DEFAULTS };
  }
}

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}
function outcomesPath(userId) {
  return path.join(personalizationDir(userId), 'outcomes.json');
}

function _readFile(userId) {
  const p = outcomesPath(userId);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      version: Number.isInteger(data.version) ? data.version : 0,
      kinds: (data.kinds && typeof data.kinds === 'object') ? data.kinds : {},
      pings: (data.pings && typeof data.pings === 'object') ? data.pings : { date: null, count: 0 },
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[personalization] outcomes.json read failed for ${userId}: ${e.message}`);
    return { version: 0, kinds: {}, pings: { date: null, count: 0 } };
  }
}

function _writeFile(userId, file) {
  const dir = personalizationDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const data = { version: (file.version || 0) + 1, updated_at: Date.now(), kinds: file.kinds, pings: file.pings };
  atomicWriteSync(outcomesPath(userId), JSON.stringify(data, null, 2));
}

function _kindRec(file, kind) {
  if (!file.kinds[kind]) {
    file.kinds[kind] = { accepts: 0, dismisses: 0, suppressed: false, autoApproved: false, graduateOffered: false };
  }
  return file.kinds[kind];
}

/**
 * Records an accept/dismiss for an offer kind and evaluates the graduate /
 * suppress thresholds. `graduate` fires exactly once — the first check that
 * crosses acceptGraduateThreshold — so the "want me to always do this?"
 * follow-up proposal isn't re-created on every subsequent accept.
 */
export async function recordOfferOutcome(userId, kind, outcome) {
  if (!userId || !kind) throw new Error('recordOfferOutcome: userId and kind required');
  const cfg = await _safeConfig(userId);
  return withLock(outcomesPath(userId), () => {
    const file = _readFile(userId);
    const rec = _kindRec(file, kind);
    let graduate = false;

    if (outcome === 'accept') {
      rec.accepts += 1;
      if (!rec.autoApproved && !rec.graduateOffered && rec.accepts >= cfg.acceptGraduateThreshold) {
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
        rec.suppressedAt = new Date().toISOString();
      }
    }

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
  const file = _readFile(userId);
  return _isSuppressionActive(file.kinds[kind]);
}

/**
 * Marks a kind auto-approved after the user accepts the graduate ("always do
 * this?") proposal — future offers of that kind execute immediately with a
 * receipt notice instead of a card. Additive export (not in the original
 * spec list) — offer-handlers.mjs (runPersonalizationGraduate) is the only
 * caller; reflect.mjs consults isKindAutoApproved below before deciding
 * whether to render a card or auto-execute.
 */
export async function markKindAutoApproved(userId, kind) {
  if (!userId || !kind) return false;
  return withLock(outcomesPath(userId), () => {
    const file = _readFile(userId);
    const rec = _kindRec(file, kind);
    rec.autoApproved = true;
    rec.autoApprovedAt = new Date().toISOString();
    _writeFile(userId, file);
    return true;
  });
}

/** Whether a kind has already graduated to auto-approved. */
export async function isKindAutoApproved(userId, kind) {
  const file = _readFile(userId);
  return !!file.kinds[kind]?.autoApproved;
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
    const file = _readFile(userId);
    const today = new Date().toISOString().slice(0, 10);
    if (file.pings.date !== today) file.pings = { date: today, count: 0 };
    if (file.pings.count >= cfg.maxUnsolicitedPingsPerDay) return false;
    file.pings.count += 1;
    _writeFile(userId, file);
    return true;
  });
}
