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
import { atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';

const DEFAULTS = Object.freeze({
  enabled: true,
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
  quietHours: Object.freeze({ start: '22:00', end: '08:00' }),
  sources: Object.freeze({ tools: true, calendar: true, sessions: true }),
  lastRun: null,
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

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

/** Read the raw on-disk object (no defaults merged), or null if missing/corrupt. */
function readRawConfig(userId) {
  try {
    return JSON.parse(fs.readFileSync(configPath(userId), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[personalization] config read failed for ${userId}: ${e.message}`);
    }
    return null;
  }
}

function mergeDefaults(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULTS,
    ...obj,
    quietHours: {
      ...DEFAULTS.quietHours,
      ...(obj.quietHours && typeof obj.quietHours === 'object' ? obj.quietHours : {}),
    },
    sources: {
      ...DEFAULTS.sources,
      ...(obj.sources && typeof obj.sources === 'object' ? obj.sources : {}),
    },
  };
}

function isValidModel(m) {
  if (m === 'coordinator' || m === 'off') return true;
  return !!(m && typeof m === 'object' && typeof m.provider === 'string' && typeof m.model === 'string');
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** Full config for this user, defaults merged over whatever is on disk. */
export async function getConfig(userId) {
  if (!userId) throw new Error('getConfig requires a userId');
  return mergeDefaults(readRawConfig(userId));
}

/**
 * Shallow-merge `patch` onto the current config, validating each known field
 * (invalid values are dropped, keeping the previous value — never throws on
 * a bad patch value). Unknown keys are ignored. Persists via atomicWriteSync
 * with a versioned envelope and returns the saved, defaults-merged config.
 */
export async function saveConfig(userId, patch) {
  if (!userId) throw new Error('saveConfig requires a userId');
  const rawPrev = readRawConfig(userId);
  const current = mergeDefaults(rawPrev);
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = { ...current };

  if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
  if ('model' in p && isValidModel(p.model)) next.model = p.model;
  if ('retentionDays' in p) next.retentionDays = clampInt(p.retentionDays, 1, 365, current.retentionDays);
  if ('maxInferencesPerRun' in p) next.maxInferencesPerRun = clampInt(p.maxInferencesPerRun, 0, 50, current.maxInferencesPerRun);
  if ('maxOffersPerRun' in p) next.maxOffersPerRun = clampInt(p.maxOffersPerRun, 0, 20, current.maxOffersPerRun);
  if ('maxOpenLeads' in p) next.maxOpenLeads = clampInt(p.maxOpenLeads, 0, 50, current.maxOpenLeads);
  if ('leadChecksDefault' in p) next.leadChecksDefault = clampInt(p.leadChecksDefault, 0, 20, current.leadChecksDefault);
  if ('acceptGraduateThreshold' in p) next.acceptGraduateThreshold = clampInt(p.acceptGraduateThreshold, 1, 20, current.acceptGraduateThreshold);
  if ('dismissSuppressThreshold' in p) next.dismissSuppressThreshold = clampInt(p.dismissSuppressThreshold, 1, 20, current.dismissSuppressThreshold);
  if ('maxUnsolicitedPingsPerDay' in p) next.maxUnsolicitedPingsPerDay = clampInt(p.maxUnsolicitedPingsPerDay, 0, 50, current.maxUnsolicitedPingsPerDay);

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
  fs.mkdirSync(dir, { recursive: true });
  // version/updated_at MUST be spread last — `next` is derived from
  // mergeDefaults(rawPrev), which itself carries forward any stale
  // version/updated_at from the previous envelope; spreading `next` first
  // and the fresh version/updated_at after ensures the bump always wins.
  const envelope = {
    ...next,
    version: (Number.isInteger(rawPrev?.version) ? rawPrev.version : 0) + 1,
    updated_at: Date.now(),
  };
  atomicWriteSync(configPath(userId), JSON.stringify(envelope, null, 2));
  notifyConfigSaved(userId);
  return mergeDefaults(envelope);
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
  const now = date.getHours() * 60 + date.getMinutes();
  if (start < end) return now >= start && now < end;
  return now >= start || now < end; // overnight wrap
}
