// @ts-check
/**
 * Per-user Personalization config: users/<uid>/personalization/config.json.
 *
 * Plaintext JSON on disk (no raw content, statements only — see
 * observations.mjs for the encrypted log) but written via atomicWriteSync
 * with { version, updated_at } envelope fields, mirroring lib/voice-config.mjs
 * so a crash or concurrent reader never sees a half-written file.
 *
 * getConfig() always returns every field with defaults merged in — callers
 * never need to null-check a field that predates a schema addition.
 *
 * onConfigSaved(cb) lets other modules react to a successful saveConfig()
 * write (by userId) without this module importing them back — see
 * recorder.mjs, which uses it to invalidate its own config cache.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';

const DEFAULTS = Object.freeze({
  enabled: true,
  // Existing installs are treated as acknowledged for backwards
  // compatibility. mergeDefaults() overrides this to false only when no
  // config file exists yet, giving genuinely-new users a first-run consent
  // screen without surprising upgraded users.
  setupComplete: true,
  model: 'coordinator',           // sentinel 'coordinator' | 'off' | {provider, model}
  // No per-user schedule field: reflection cadence is the global 6-hour
  // interval task (scheduler-init.mjs). A 'schedule' key lingering in older
  // saved config.json files is ignored harmlessly.
  retentionDays: 30,
  maxInferencesPerRun: 5,
  maxOffersPerRun: 2,
  maxOpenLeads: 8,
  leadChecksDefault: 2,
  acceptGraduateThreshold: 2,
  dismissSuppressThreshold: 2,
  maxUnsolicitedPingsPerDay: 2,
  proactivity: 'balanced',        // quiet | balanced | proactive
  initiativeMode: 'suggest',      // suggest | safe_auto
  deliveryMode: 'immediate',      // immediate | briefing
  timezone: null,                 // optional IANA timezone; null = server timezone
  quietHours: Object.freeze({ start: '22:00', end: '08:00' }),
  sources: Object.freeze({ tools: true, calendar: true, sessions: true }),
  lastRun: null,
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MODEL_PROVIDER_MAX = 100;
const MODEL_ID_MAX = 300;

// Listener hook for saveConfig() success, keyed by nothing (just a flat
// Set) since there are only ever a couple of subscribers (recorder.mjs's
// cache invalidation today). This module must NOT import recorder.mjs —
// recorder.mjs already imports config.mjs, so that would be a cycle —
// hence recorder.mjs instead registers itself here at module load. A
// listener throwing must never fail the save it's reacting to.
const _onSaveListeners = new Set();

/**
 * Subscribe to be notified (with the userId) after saveConfig() persists a
 * successful write. Used by recorder.mjs to drop its short-lived per-user
 * config cache the moment the user flips a setting, instead of waiting out
 * CONFIG_TTL_MS.
 * @param {(userId: string) => void} cb
 */
export function onConfigSaved(cb) {
  if (typeof cb === 'function') _onSaveListeners.add(cb);
}

function notifyConfigSaved(userId) {
  for (const cb of _onSaveListeners) {
    try { cb(userId); } catch (e) { console.warn(`[personalization] onConfigSaved listener failed: ${e?.message || e}`); }
  }
}

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}
function configPath(userId) {
  return path.join(personalizationDir(userId), 'config.json');
}

/** Read the raw on-disk object (no defaults merged), or null if missing. */
function readRawConfig(userId, { strict = false } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(userId), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid config envelope');
    return parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[personalization] config read failed for ${userId}: ${e.message}`);
      if (strict) throw new Error(`Personalization config is unreadable: ${e.message}`);
    }
    return null;
  }
}

function mergeDefaults(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  /** @type {any} */
  const out = {
    ...DEFAULTS,
    quietHours: { ...DEFAULTS.quietHours },
    sources: { ...DEFAULTS.sources },
  };
  if (Object.hasOwn(obj, 'enabled')) out.enabled = typeof obj.enabled === 'boolean' ? obj.enabled : false;
  out.setupComplete = raw == null
    ? false
    : (!Object.hasOwn(obj, 'setupComplete') ? true : (typeof obj.setupComplete === 'boolean' ? obj.setupComplete : false));
  if (Object.hasOwn(obj, 'model')) out.model = isValidModel(obj.model) ? obj.model : 'off';
  for (const [field, min, max] of [
    ['retentionDays', 1, 365], ['maxInferencesPerRun', 0, 50],
    ['maxOffersPerRun', 0, 20], ['maxOpenLeads', 0, 50],
    ['leadChecksDefault', 0, 20], ['acceptGraduateThreshold', 1, 20],
    ['dismissSuppressThreshold', 1, 20], ['maxUnsolicitedPingsPerDay', 0, 50],
  ]) {
    if (Number.isInteger(obj[field]) && obj[field] >= min && obj[field] <= max) out[field] = obj[field];
  }
  if (Object.hasOwn(obj, 'proactivity')) {
    if (['quiet', 'balanced', 'proactive'].includes(obj.proactivity)) out.proactivity = obj.proactivity;
    else {
      out.proactivity = 'quiet';
      out.maxOffersPerRun = 1;
      out.maxUnsolicitedPingsPerDay = 0;
    }
  }
  if (Object.hasOwn(obj, 'initiativeMode')) {
    // Unknown/corrupt values fail closed to ask-first behavior.
    out.initiativeMode = ['suggest', 'safe_auto'].includes(obj.initiativeMode)
      ? obj.initiativeMode : 'suggest';
  }
  // Older experimental builds exposed digest/email/Telegram modes without
  // delivery workers. Migrate those values to an honest supported mode so
  // pending updates cannot become permanently undeliverable.
  if (Object.hasOwn(obj, 'deliveryMode')) {
    out.deliveryMode = ['immediate', 'briefing'].includes(obj.deliveryMode) ? obj.deliveryMode : DEFAULTS.deliveryMode;
  }
  if (obj.timezone === null || obj.timezone === '') out.timezone = null;
  else if (isValidTimezone(obj.timezone)) out.timezone = obj.timezone;
  if (obj.quietHours && typeof obj.quietHours === 'object' && !Array.isArray(obj.quietHours)) {
    if (typeof obj.quietHours.start === 'string' && TIME_RE.test(obj.quietHours.start)) out.quietHours.start = obj.quietHours.start;
    if (typeof obj.quietHours.end === 'string' && TIME_RE.test(obj.quietHours.end)) out.quietHours.end = obj.quietHours.end;
  }
  if (Object.hasOwn(obj, 'sources')) {
    if (!obj.sources || typeof obj.sources !== 'object' || Array.isArray(obj.sources)) {
      out.sources = { tools: false, calendar: false, sessions: false };
    } else {
      for (const source of ['tools', 'calendar', 'sessions']) {
        if (Object.hasOwn(obj.sources, source)) {
          out.sources[source] = typeof obj.sources[source] === 'boolean' ? obj.sources[source] : false;
        }
      }
    }
  }
  if (obj.lastRun === null || (obj.lastRun && typeof obj.lastRun === 'object' && !Array.isArray(obj.lastRun))) {
    out.lastRun = obj.lastRun;
  }
  return out;
}

function isValidModel(m) {
  if (m === 'coordinator' || m === 'off') return true;
  if (!m || typeof m !== 'object' || Array.isArray(m)
    || Object.keys(m).some(key => key !== 'provider' && key !== 'model')) return false;
  const validPart = (value, max) => typeof value === 'string' && value.length > 0
    && value.length <= max && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
  return validPart(m.provider, MODEL_PROVIDER_MAX) && validPart(m.model, MODEL_ID_MAX);
}

function isValidTimezone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
  catch { return false; }
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** Full config for this user, defaults merged over whatever is on disk. */
export async function getConfig(userId) {
  if (!userId) throw new Error('getConfig requires a userId');
  return mergeDefaults(readRawConfig(userId, { strict: true }));
}

/**
 * Shallow-merge `patch` onto the current config, validating each known field
 * (invalid values are dropped, keeping the previous value — never throws on
 * a bad patch value). Unknown keys are ignored. Persists via atomicWriteSync
 * with a versioned envelope and returns the saved, defaults-merged config.
 */
export async function saveConfig(userId, patch) {
  if (!userId) throw new Error('saveConfig requires a userId');
  const saved = await withLock(configPath(userId), () => {
    const rawPrev = readRawConfig(userId, { strict: true });
    const current = mergeDefaults(rawPrev);
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = { ...current };

    if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
    if (typeof p.setupComplete === 'boolean') next.setupComplete = p.setupComplete;
    if ('model' in p && isValidModel(p.model)) next.model = p.model;
    if ('retentionDays' in p) next.retentionDays = clampInt(p.retentionDays, 1, 365, current.retentionDays);
    if ('maxInferencesPerRun' in p) next.maxInferencesPerRun = clampInt(p.maxInferencesPerRun, 0, 50, current.maxInferencesPerRun);
    if ('maxOffersPerRun' in p) next.maxOffersPerRun = clampInt(p.maxOffersPerRun, 0, 20, current.maxOffersPerRun);
    if ('maxOpenLeads' in p) next.maxOpenLeads = clampInt(p.maxOpenLeads, 0, 50, current.maxOpenLeads);
    if ('leadChecksDefault' in p) next.leadChecksDefault = clampInt(p.leadChecksDefault, 0, 20, current.leadChecksDefault);
    if ('acceptGraduateThreshold' in p) next.acceptGraduateThreshold = clampInt(p.acceptGraduateThreshold, 1, 20, current.acceptGraduateThreshold);
    if ('dismissSuppressThreshold' in p) next.dismissSuppressThreshold = clampInt(p.dismissSuppressThreshold, 1, 20, current.dismissSuppressThreshold);
    if ('maxUnsolicitedPingsPerDay' in p) next.maxUnsolicitedPingsPerDay = clampInt(p.maxUnsolicitedPingsPerDay, 0, 50, current.maxUnsolicitedPingsPerDay);

    if (['quiet', 'balanced', 'proactive'].includes(p.proactivity)) {
      next.proactivity = p.proactivity;
      // Presets intentionally tune only interruption volume. The source and
      // model privacy choices remain independent, explicit controls.
      const preset = {
        quiet: { maxOffersPerRun: 1, maxUnsolicitedPingsPerDay: 0 },
        balanced: { maxOffersPerRun: 2, maxUnsolicitedPingsPerDay: 2 },
        proactive: { maxOffersPerRun: 4, maxUnsolicitedPingsPerDay: 4 },
      }[p.proactivity];
      if (!('maxOffersPerRun' in p)) next.maxOffersPerRun = preset.maxOffersPerRun;
      if (!('maxUnsolicitedPingsPerDay' in p)) next.maxUnsolicitedPingsPerDay = preset.maxUnsolicitedPingsPerDay;
    }
    if (['suggest', 'safe_auto'].includes(p.initiativeMode)) {
      next.initiativeMode = p.initiativeMode;
    }
    if (['immediate', 'briefing'].includes(p.deliveryMode)) {
      next.deliveryMode = p.deliveryMode;
    }
    if (p.timezone === null || p.timezone === '') {
      next.timezone = null;
    } else if (typeof p.timezone === 'string' && p.timezone.length <= 64) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: p.timezone });
        next.timezone = p.timezone;
      } catch { /* invalid IANA zone — retain the current value */ }
    }

    if (p.quietHours && typeof p.quietHours === 'object') {
      const start = typeof p.quietHours.start === 'string' && TIME_RE.test(p.quietHours.start) ? p.quietHours.start : current.quietHours.start;
      const end = typeof p.quietHours.end === 'string' && TIME_RE.test(p.quietHours.end) ? p.quietHours.end : current.quietHours.end;
      next.quietHours = { start, end };
    }
    if (p.sources && typeof p.sources === 'object') {
      next.sources = {
        tools: typeof p.sources.tools === 'boolean' ? p.sources.tools : current.sources.tools,
        calendar: typeof p.sources.calendar === 'boolean' ? p.sources.calendar : current.sources.calendar,
        sessions: typeof p.sources.sessions === 'boolean' ? p.sources.sessions : current.sources.sessions,
      };
    }
    // lastRun is written internally (by reflect.mjs) rather than user-edited via
    // the settings panel, but a well-formed object/null is accepted as-is.
    if ('lastRun' in p && (p.lastRun === null || typeof p.lastRun === 'object')) next.lastRun = p.lastRun;

    const dir = personalizationDir(userId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
    // Envelope metadata is derived from the raw file rather than merged into
    // the runtime config object, so stale/unknown disk keys never leak back.
    const envelope = {
      ...next,
      version: (Number.isInteger(rawPrev?.version) ? rawPrev.version : 0) + 1,
      updated_at: Date.now(),
    };
    atomicWriteSync(configPath(userId), JSON.stringify(envelope, null, 2), { mode: 0o600 });
    try { fs.chmodSync(configPath(userId), 0o600); } catch { /* best effort */ }
    return mergeDefaults(envelope);
  });

  // Cache invalidation and other observers only see committed state. A failed
  // read or atomic write rejects before this point and emits no notification.
  notifyConfigSaved(userId);
  return saved;
}

/**
 * True if `date` (local time) falls inside config.quietHours. Handles an
 * overnight window (start > end, e.g. 22:00–08:00) by wrapping past
 * midnight. Start boundary is inclusive, end boundary exclusive. Malformed
 * quietHours (missing/unparseable) never throws — returns false.
 */
export function isQuietHours(config, date = new Date()) {
  const qh = config?.quietHours;
  if (!qh || typeof qh.start !== 'string' || typeof qh.end !== 'string') return false;
  const toMinutes = (s) => {
    const m = TIME_RE.exec(s);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const start = toMinutes(qh.start);
  const end = toMinutes(qh.end);
  if (start == null || end == null || start === end) return false;
  let hour = date.getHours();
  let minute = date.getMinutes();
  if (config?.timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(date);
      hour = Number(parts.find(p => p.type === 'hour')?.value);
      minute = Number(parts.find(p => p.type === 'minute')?.value);
    } catch { /* invalid persisted zone — use server-local time */ }
  }
  const now = hour * 60 + minute;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end; // overnight wrap
}

/** YYYY-MM-DD in the configured user's timezone (UTC/server fallback safe). */
export function configLocalDateKey(config, date = new Date()) {
  if (config?.timezone) {
    try { return date.toLocaleDateString('en-CA', { timeZone: config.timezone }); }
    catch { /* fall through */ }
  }
  return date.toLocaleDateString('en-CA');
}
