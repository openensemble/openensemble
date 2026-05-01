/**
 * Per-user polling/monitor service ("watchers").
 *
 * A watcher is a long-running poll registered by a skill (or by the system) to
 * monitor evolving state — video render progress, price alerts, training jobs,
 * pod lifecycle, background syncs. It's NOT a scheduled task: tasks fire once
 * (or on a cron) and finish; watchers tick forever (or until expiry / done /
 * cancellation) and emit status updates over WS as they go.
 *
 * Architecture:
 *   • One supervisor per server instance (single setInterval).
 *   • Watchers live in users/<uid>/watchers.json (per-user file). Disk-backed
 *     because server restart wiping in-memory state is the main pain point this
 *     replaces (see memory: feedback_server_restart_cost).
 *   • Handlers are looked up lazily via the same path skills use for tools:
 *     a skill's executor exports `watcherHandlers: { [kind]: handler }`.
 *   • Skills register watchers via `ctx.watch({kind, state, cadenceSec, expiresAt})`
 *     and unregister via `ctx.unwatch(id)`.
 *   • Status updates flow to chat via the WS `status` message type.
 *
 * Distinction from scheduler/tasks (documented at the type level so authors
 * don't pick the wrong tool):
 *
 *   Task    : fire scheduled action, runs to completion. (cron / once)
 *   Watcher : tick every N seconds, push progress, reap on done/expiry/cancel.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { USERS_DIR } from '../lib/paths.mjs';
import { log } from '../logger.mjs';

const TICK_MS = 5_000;
const DEFAULT_CADENCE_SEC = 30;
const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;       // 1h fallback when caller forgets
const SOFT_EXPIRY_WARN_MS = 30 * 24 * 60 * 60 * 1000; // 30d — long-but-finite is suspicious
const MAX_PER_USER = 10;
const MAX_FAILURES = 3;
const RECENT_KEEP_MS = 60 * 60 * 1000;          // Keep completed/errored watchers visible 1h
const MAX_HISTORY_ENTRIES = 100;                // Per-watcher progress scrollback cap

let _running = false;
let _timer = null;
let _sendStatusFn = null;
let _showImageFn = null;
let _showVideoFn = null;

// In-memory cache per user, mirrored to disk on every change.
//   _byUser: userId -> { active: WatcherRecord[], recent: WatcherRecord[] }
// Recent is a small ring of completed/errored watchers for the tasks drawer.
const _byUser = new Map();

// Ticks-in-flight guard so a slow handler doesn't pile up duplicate runs.
const _inFlight = new Set();

// ── persistence ───────────────────────────────────────────────────────────────

function watchersPath(userId) {
  return path.join(USERS_DIR, userId, 'watchers.json');
}

function loadUserWatchers(userId) {
  if (_byUser.has(userId)) return _byUser.get(userId);
  const p = watchersPath(userId);
  let data = { active: [], recent: [] };
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      data = {
        active: Array.isArray(parsed.active) ? parsed.active : [],
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      };
    }
  } catch (e) {
    log.warn('watchers', `Failed to load ${userId} watchers`, { err: e.message });
  }
  _byUser.set(userId, data);
  return data;
}

function persistUser(userId) {
  const data = _byUser.get(userId);
  if (!data) return;
  const p = watchersPath(userId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (e) {
    log.warn('watchers', `Failed to persist ${userId} watchers`, { err: e.message });
  }
}

function loadAllUsersFromDisk() {
  if (!fs.existsSync(USERS_DIR)) return;
  for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const uid = entry.name;
    // Only load users that actually have a watchers.json — skip junk dirs.
    if (!fs.existsSync(watchersPath(uid))) continue;
    loadUserWatchers(uid);
  }
}

// ── public registration API (used by ctx.watch / ctx.unwatch) ────────────────

/**
 * Register a watcher.
 *
 * @param {object} opts
 * @param {string}  opts.userId      Required.
 * @param {string}  opts.agentId     Agent thread to post status into. Required.
 * @param {string}  opts.kind        Handler key — must match an entry in some
 *                                   skill's executor.watcherHandlers map.
 * @param {object}  [opts.state]     Opaque, kind-specific config (job_id, ...).
 * @param {number}  [opts.cadenceSec=30]   Tick interval.
 * @param {number|null} [opts.expiresAt]   Wall-clock ms. null = indefinite (must
 *                                   be unwatched manually). Omitting it logs a
 *                                   WARN and falls back to 1h.
 * @param {string}  [opts.skillId]   Owning skill — used to locate the handler.
 * @param {string}  [opts.label]     Short user-facing description for the tasks
 *                                   drawer. Falls back to kind.
 * @returns {string} watcherId
 */
export function registerWatcher(opts) {
  const { userId, agentId, kind, state = {}, cadenceSec, expiresAt, skillId, label } = opts || {};
  if (!userId)  throw new Error('registerWatcher: userId required');
  if (!agentId) throw new Error('registerWatcher: agentId required');
  if (!kind)    throw new Error('registerWatcher: kind required');

  const data = loadUserWatchers(userId);

  if (data.active.length >= MAX_PER_USER) {
    log.warn('watchers', 'Per-user cap reached, refusing registration', { userId, kind });
    throw new Error(`watcher cap reached (${MAX_PER_USER} active per user)`);
  }

  // Caller MUST set expiresAt explicitly. If they omit it, warn loudly so it
  // gets fixed at the call site, then fall back to a 1h ceiling.
  let resolvedExpires;
  if (expiresAt === null) {
    resolvedExpires = null; // indefinite — explicit opt-out
  } else if (typeof expiresAt === 'number' && expiresAt > Date.now()) {
    resolvedExpires = expiresAt;
    if (expiresAt - Date.now() > SOFT_EXPIRY_WARN_MS) {
      log.warn('watchers', 'Suspiciously long expiresAt (>30d) — confirm this is intended', { kind, daysOut: (expiresAt - Date.now()) / 86400000 });
    }
  } else {
    log.warn('watchers', `kind=${kind} registered without valid expiresAt — defaulting to 1h, fix the caller`, { userId });
    resolvedExpires = Date.now() + DEFAULT_EXPIRY_MS;
  }

  const record = {
    id: randomUUID(),
    userId,
    agentId,
    kind,
    skillId: skillId || null,
    label: label || kind,
    state,
    cadenceSec: Math.max(5, Number(cadenceSec) || DEFAULT_CADENCE_SEC),
    createdAt: Date.now(),
    nextTickAt: Date.now() + 1000, // first tick almost immediately
    expiresAt: resolvedExpires,
    lastStatusText: null,
    lastChangeAt: Date.now(),
    failures: 0,
    ticks: 0,
    status: 'active', // active | done | error | expired | cancelled
    history: [],      // [{text, ts, final?, finalStatus?}] — bounded scrollback
  };

  data.active.push(record);
  persistUser(userId);
  return record.id;
}

export function unregisterWatcher(userId, watcherId, reason = 'cancelled') {
  const data = loadUserWatchers(userId);
  const idx = data.active.findIndex(w => w.id === watcherId);
  if (idx < 0) return false;
  const w = data.active.splice(idx, 1)[0];
  w.status = reason;
  w.endedAt = Date.now();
  data.recent.unshift(w);
  data.recent = data.recent.slice(0, 20);
  persistUser(userId);
  return true;
}

export function listWatchers(userId) {
  const data = loadUserWatchers(userId);
  // Drop recent entries older than 1h before returning.
  const cutoff = Date.now() - RECENT_KEEP_MS;
  data.recent = data.recent.filter(w => (w.endedAt || 0) > cutoff);
  // Strip per-watcher history from the list payload — it's potentially large
  // and only needed when the user expands a single bubble. The per-id GET
  // (getWatcher) returns the full record including history.
  const stripHistory = (w) => ({ ...w, history: undefined, historyLen: w.history?.length || 0 });
  return {
    active: data.active.map(stripHistory),
    recent: data.recent.map(stripHistory),
  };
}

// Single-watcher fetch — used by the chat bubble's click-to-expand history.
// Searches both active and recent so a finished bubble can still be opened
// while the watcher is in the 1h reap window.
export function getWatcher(userId, watcherId) {
  const data = loadUserWatchers(userId);
  return (
    data.active.find(w => w.id === watcherId) ||
    data.recent.find(w => w.id === watcherId) ||
    null
  );
}

export function patchWatcher(userId, watcherId, patch) {
  const data = loadUserWatchers(userId);
  const w = data.active.find(x => x.id === watcherId);
  if (!w) return false;
  // Only allow user-mutable fields. Everything else is supervisor-managed.
  if (patch.expiresAt !== undefined) {
    w.expiresAt = patch.expiresAt === null ? null : Math.max(Date.now() + 60_000, Number(patch.expiresAt));
  }
  if (patch.cadenceSec !== undefined) {
    w.cadenceSec = Math.max(5, Number(patch.cadenceSec));
  }
  if (patch.label !== undefined) w.label = String(patch.label);
  persistUser(userId);
  return true;
}

// ── handler resolution ───────────────────────────────────────────────────────
//
// Handlers live on the owning skill's executor under `watcherHandlers`. Same
// lazy-import path the role tool dispatcher uses.

async function resolveHandler(record) {
  const { skillId } = record;
  if (!skillId) {
    // No owning skill; this watcher came from the system layer.
    return _systemHandlers.get(record.kind) || null;
  }
  try {
    const { getWatcherHandler } = await import('../roles.mjs');
    return await getWatcherHandler(skillId, record.userId, record.kind);
  } catch (e) {
    log.warn('watchers', 'Failed to resolve handler', { skillId, kind: record.kind, err: e.message });
    return null;
  }
}

const _systemHandlers = new Map();
export function registerSystemWatcherHandler(kind, fn) {
  _systemHandlers.set(kind, fn);
}

// ── supervisor loop ──────────────────────────────────────────────────────────

async function tickOne(record) {
  const inFlightKey = `${record.userId}:${record.id}`;
  if (_inFlight.has(inFlightKey)) return; // previous tick still running
  _inFlight.add(inFlightKey);

  try {
    // Expiry check — only if not indefinite.
    if (record.expiresAt !== null && Date.now() > record.expiresAt) {
      finalizeWatcher(record, 'expired', `⏰ Monitor expired without completing.`);
      return;
    }

    const handler = await resolveHandler(record);
    if (!handler) {
      record.failures++;
      log.warn('watchers', 'Handler not found', { kind: record.kind, skillId: record.skillId });
      if (record.failures >= MAX_FAILURES) {
        finalizeWatcher(record, 'error', `❌ No handler registered for kind=${record.kind}.`);
      } else {
        record.nextTickAt = Date.now() + record.cadenceSec * 1000;
        persistUser(record.userId);
      }
      return;
    }

    // Build a small per-call helpers object for the handler.
    const helpers = handlerHelpers(record);
    let result;
    try {
      result = await handler(record.state, helpers);
    } catch (e) {
      record.failures++;
      log.warn('watchers', 'Handler threw', { kind: record.kind, err: e.message });
      if (record.failures >= MAX_FAILURES) {
        finalizeWatcher(record, 'error', `❌ ${record.label}: handler failed ${MAX_FAILURES}× — ${e.message}`);
      } else {
        record.nextTickAt = Date.now() + record.cadenceSec * 1000;
        persistUser(record.userId);
      }
      return;
    }

    record.failures = 0;
    record.ticks++;

    if (result && typeof result === 'object') {
      if (result.newState !== undefined) {
        record.state = result.newState;
        record.lastChangeAt = Date.now();
      }
      if (result.extendExpiryBy && record.expiresAt !== null) {
        record.expiresAt = (record.expiresAt || Date.now()) + Number(result.extendExpiryBy);
      }
      if (result.nextCadenceSec) {
        record.cadenceSec = Math.max(5, Number(result.nextCadenceSec));
      }
      if (result.textUpdate) {
        // Dedup consecutive identical updates so the chat doesn't fill with
        // the same line tick after tick.
        if (result.textUpdate !== record.lastStatusText) {
          record.lastStatusText = result.textUpdate;
          pushHistory(record, { text: result.textUpdate, ts: Date.now() });
          if (_sendStatusFn) {
            _sendStatusFn(record.userId, {
              type: 'status',
              agent: record.agentId,
              watcherId: record.id,
              kind: record.kind,
              label: record.label,
              text: result.textUpdate,
              ts: Date.now(),
            });
          }
        }
      }
      if (result.done) {
        finalizeWatcher(record, 'done', result.textUpdate || `✓ ${record.label} done.`);
        return;
      }
    }

    record.nextTickAt = Date.now() + record.cadenceSec * 1000;
    persistUser(record.userId);
  } finally {
    _inFlight.delete(inFlightKey);
  }
}

function pushHistory(record, entry) {
  if (!Array.isArray(record.history)) record.history = [];
  record.history.push(entry);
  if (record.history.length > MAX_HISTORY_ENTRIES) {
    record.history = record.history.slice(-MAX_HISTORY_ENTRIES);
  }
}

function finalizeWatcher(record, status, finalText) {
  const data = _byUser.get(record.userId);
  if (!data) return;
  const idx = data.active.findIndex(w => w.id === record.id);
  if (idx >= 0) data.active.splice(idx, 1);
  record.status = status;
  record.endedAt = Date.now();
  record.lastStatusText = finalText || record.lastStatusText;
  if (finalText) {
    const last = record.history?.[record.history.length - 1];
    if (!last || last.text !== finalText) {
      pushHistory(record, { text: finalText, ts: Date.now(), final: true, finalStatus: status });
    } else {
      // Annotate the existing tail as the final entry so the scrollback shows
      // which line ended the run.
      last.final = true; last.finalStatus = status;
    }
  }
  data.recent.unshift(record);
  data.recent = data.recent.slice(0, 20);
  persistUser(record.userId);
  if (_sendStatusFn && finalText) {
    _sendStatusFn(record.userId, {
      type: 'status',
      agent: record.agentId,
      watcherId: record.id,
      kind: record.kind,
      label: record.label,
      text: finalText,
      ts: Date.now(),
      final: true,
      finalStatus: status,
    });
  }
}

function handlerHelpers(record) {
  return {
    userId: record.userId,
    agentId: record.agentId,
    watcherId: record.id,
    showImage: async (img) => _showImageFn?.(record.userId, { ...img, agent: record.agentId }),
    showVideo: async (vid) => _showVideoFn?.(record.userId, { ...vid, agent: record.agentId }),
    postStatus: (text) => {
      if (text === record.lastStatusText) return;
      record.lastStatusText = text;
      pushHistory(record, { text, ts: Date.now() });
      _sendStatusFn?.(record.userId, {
        type: 'status', agent: record.agentId, watcherId: record.id,
        kind: record.kind, label: record.label, text, ts: Date.now(),
      });
    },
  };
}

async function tick() {
  if (!_running) return;
  const now = Date.now();
  for (const [userId, data] of _byUser) {
    for (const w of data.active.slice()) {
      if (w.nextTickAt > now) continue;
      // Fire and forget — tickOne guards against re-entry per-watcher.
      tickOne(w).catch(e => log.warn('watchers', 'tickOne unhandled', { id: w.id, err: e.message }));
    }
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Start the supervisor. Pass it the WS push functions so handlers can post
 * status / image / video bubbles.
 */
export function startWatcherSupervisor({ sendStatus, showImage, showVideo } = {}) {
  if (_running) return;
  _sendStatusFn = sendStatus || null;
  _showImageFn = showImage || null;
  _showVideoFn = showVideo || null;
  loadAllUsersFromDisk();
  _running = true;
  _timer = setInterval(tick, TICK_MS);
  const totalActive = [..._byUser.values()].reduce((n, d) => n + d.active.length, 0);
  log.info('watchers', 'Supervisor started', { tickMs: TICK_MS, activeOnBoot: totalActive });
}

export function stopWatcherSupervisor() {
  _running = false;
  if (_timer) clearInterval(_timer);
  _timer = null;
}

export function isWatcherSupervisorRunning() { return _running; }
