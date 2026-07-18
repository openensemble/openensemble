// @ts-check
/**
 * Shared watcher supervisor state + cadence constants.
 * Imported by watchers.mjs and watchers/supervisor.mjs so Maps stay identical.
 */

export const TICK_MS = 5_000;
export const DEFAULT_CADENCE_SEC = 30;
export const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;       // 1h fallback when caller forgets
export const SOFT_EXPIRY_WARN_MS = 30 * 24 * 60 * 60 * 1000; // 30d — long-but-finite is suspicious
// 50 is the post-coalescence number — when watchers were 1-per-signal we ran
// 10 because a few onboarded services would already swamp the budget. Now
// each profile is 1 watcher (state.signals[] internal), so 50 covers 50
// managed services + headroom for video gen, training runs, price alerts,
// custom skills, etc. Bump again if it becomes load-bearing.
export const MAX_PER_USER = 50;
export const MAX_FAILURES = 3;
export const RECENT_KEEP_MS = 60 * 60 * 1000;          // Keep completed/errored watchers visible 1h
export const MAX_HISTORY_ENTRIES = 100;                // Per-watcher progress scrollback cap
export const MAX_MEDIA_DELIVERY_RESERVATIONS = 20;
export const STUCK_RATIO = 5;                          // No change for 5×cadence → annotate as "stuck"
export const STUCK_BACKOFF_MAX_SEC = 3600;             // Back off noisy stuck polls up to hourly
export const EXTERNAL_DISPATCH_STALE_MS = 5 * 60 * 1000;

/** Supervisor lifecycle + WS push hooks (mutated from start/stop). */
export const lifecycle = {
  running: false,
  timer: null,
  sendStatusFn: null,
  sendNotificationFn: null,
  showImageFn: null,
  showVideoFn: null,
};

// userId -> { active: WatcherRecord[], recent: WatcherRecord[] }
export const byUser = new Map();
// userId -> last load/persist failure (assertWatcherStoreHealthy surfaces this)
export const watcherLoadErrors = new Map();

// In-flight tick keys + abort controllers for late control races
export const inFlight = new Set();
export const inFlightControllers = new Map();
