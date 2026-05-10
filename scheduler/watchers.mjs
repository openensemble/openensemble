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
// 50 is the post-coalescence number — when watchers were 1-per-signal we ran
// 10 because a few onboarded services would already swamp the budget. Now
// each profile is 1 watcher (state.signals[] internal), so 50 covers 50
// managed services + headroom for video gen, training runs, price alerts,
// custom skills, etc. Bump again if it becomes load-bearing.
const MAX_PER_USER = 50;
const MAX_FAILURES = 3;
const RECENT_KEEP_MS = 60 * 60 * 1000;          // Keep completed/errored watchers visible 1h
const MAX_HISTORY_ENTRIES = 100;                // Per-watcher progress scrollback cap
const STUCK_RATIO = 5;                          // No change for 5×cadence → annotate as "stuck"

let _running = false;
let _timer = null;
let _sendStatusFn = null;
let _sendNotificationFn = null;
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
    onFire: opts.onFire || null, // { type: 'notify' | 'agent', prompt? } — see executeOnFire
  };

  data.active.push(record);
  // event_subscription watchers register against the in-process bus so
  // emitEvent() can pull their nextTickAt forward when their event arrives.
  // Polling kinds skip this — the supervisor's regular sweep handles them.
  if (kind === 'event_subscription') subscribeToEvent(record);
  persistUser(userId);
  return record.id;
}

export function unregisterWatcher(userId, watcherId, reason = 'cancelled') {
  const data = loadUserWatchers(userId);
  const idx = data.active.findIndex(w => w.id === watcherId);
  if (idx < 0) return false;
  const w = data.active.splice(idx, 1)[0];
  if (w.kind === 'event_subscription') unsubscribeFromEvent(w);
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

// ── event bus ────────────────────────────────────────────────────────────────
//
// In-process pub/sub for "an external thing happened" — webhook arrivals,
// Telegram bot replies, file-change notifications, anything with a real
// trigger source instead of a polled one.
//
// A watcher with kind='event_subscription' and state.event='<name>' subscribes
// itself at registration time. emitEvent() finds matching watchers, stamps
// the payload onto state, and pulls their nextTickAt forward so the
// supervisor picks them up on the next 5s sweep. The handler then evaluates
// any predicate and decides whether to fire.

const _eventListeners = new Map(); // userId -> Map(eventName -> Set<watcherId>)

function eventKey(record) {
  return record?.state?.event || null;
}

function subscribeToEvent(record) {
  const ev = eventKey(record);
  if (!ev) return;
  if (!_eventListeners.has(record.userId)) _eventListeners.set(record.userId, new Map());
  const userMap = _eventListeners.get(record.userId);
  if (!userMap.has(ev)) userMap.set(ev, new Set());
  userMap.get(ev).add(record.id);
}

function unsubscribeFromEvent(record) {
  const userMap = _eventListeners.get(record.userId);
  if (!userMap) return;
  const ev = eventKey(record);
  if (!ev) return;
  const set = userMap.get(ev);
  if (set) {
    set.delete(record.id);
    if (!set.size) userMap.delete(ev);
  }
}

/**
 * Fire an event. Any watcher of kind='event_subscription' with a matching
 * state.event will get its payload stamped and tick on the next supervisor
 * sweep. Returns the count of matched watchers.
 *
 * Safe to call even when the supervisor is idle — just no-ops.
 */
export function emitEvent(userId, eventName, payload = {}) {
  if (!userId || !eventName) return 0;
  const userMap = _eventListeners.get(userId);
  if (!userMap) return 0;
  const watcherIds = userMap.get(eventName);
  if (!watcherIds || !watcherIds.size) return 0;
  const data = _byUser.get(userId);
  if (!data) return 0;
  let matched = 0;
  for (const wid of watcherIds) {
    const w = data.active.find(x => x.id === wid);
    if (!w) continue;
    w.state = { ...w.state, lastEventPayload: payload, lastEventAt: Date.now() };
    w.nextTickAt = Date.now(); // tick on next supervisor sweep
    matched++;
  }
  if (matched) persistUser(userId);
  return matched;
}

// Built-in event_subscription handler. Runs whenever the supervisor ticks the
// watcher — either after emitEvent() pulled nextTickAt forward, or once every
// 24h as a sanity sweep. Without a fresh lastEventAt it just goes back to
// sleep; with one, it evaluates the predicate and fires/declines.
async function eventSubscriptionHandler(state) {
  const { event, predicate } = state || {};
  if (!event) return { done: true, textUpdate: '❌ event watcher missing event name' };
  if (state.lastEventAt === undefined) {
    return {}; // waiting for first event
  }
  // Each event fires the handler once. Mark consumed by clearing lastEventAt
  // so a subsequent supervisor sweep doesn't re-evaluate the same payload.
  const payload = state.lastEventPayload;
  const consumedState = { ...state, lastEventAt: undefined, lastEventPayload: undefined };

  if (predicate) {
    let val;
    try {
      // Reuse the dotted-path logic from watch-handlers via a tiny inline
      // walker — keeping watchers.mjs free of cross-file imports for the
      // built-in handler.
      val = walkPath(payload, predicate.jsonPath || '$');
    } catch { val = undefined; }
    let hit = false;
    try { hit = comparePayload(val, predicate.comparator, predicate.target); }
    catch (e) { return { done: true, textUpdate: `❌ ${e.message}` }; }
    if (!hit) {
      return { newState: consumedState }; // event came but didn't match
    }
  }
  return { done: true, textUpdate: `🔔 event "${event}" fired` };
}

// Tiny duplicates of compare/jsonGet from scheduler/watch-handlers.mjs — kept
// inline so this file doesn't depend on the handler module's load order.
function walkPath(obj, path) {
  if (!path || path === '$') return obj;
  let cur = obj;
  const tokens = path.replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) || [];
  for (const tok of tokens) {
    if (cur == null) return undefined;
    cur = tok.startsWith('[') ? cur[Number(tok.slice(1, -1))] : cur[tok];
  }
  return cur;
}
function comparePayload(value, comparator, target) {
  switch (comparator) {
    case 'gte':      return Number(value) >= Number(target);
    case 'lte':      return Number(value) <= Number(target);
    case 'gt':       return Number(value) >  Number(target);
    case 'lt':       return Number(value) <  Number(target);
    case 'eq':       return String(value) === String(target);
    case 'neq':      return String(value) !== String(target);
    case 'matches':  return new RegExp(String(target)).test(String(value));
    case 'contains': return String(value).includes(String(target));
    default: throw new Error(`unknown comparator "${comparator}"`);
  }
}
_systemHandlers.set('event_subscription', eventSubscriptionHandler);

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
      }
      if (result.extendExpiryBy && record.expiresAt !== null) {
        record.expiresAt = (record.expiresAt || Date.now()) + Number(result.extendExpiryBy);
      }
      if (result.nextCadenceSec) {
        record.cadenceSec = Math.max(5, Number(result.nextCadenceSec));
      }
      if (result.textUpdate) {
        // Dedup consecutive identical updates so the chat doesn't fill with
        // the same line tick after tick. lastChangeAt tracks visible-text
        // changes specifically — that's the signal stuck-detection uses,
        // since handlers may update lastValue cosmetically every tick.
        if (result.textUpdate !== record.lastStatusText) {
          record.lastStatusText = result.textUpdate;
          record.lastChangeAt = Date.now();
          record.stuckAnnounced = false;
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

    // Stuck detection — fire one synthetic status when N×cadence elapses
    // with no visible change. Don't reap; long-running things like price
    // alerts genuinely sit unchanged for hours. The user can read the
    // annotation and decide whether to cancel.
    const sinceChange = Date.now() - record.lastChangeAt;
    const stuckThresholdMs = STUCK_RATIO * record.cadenceSec * 1000;
    if (!record.stuckAnnounced && sinceChange > stuckThresholdMs) {
      record.stuckAnnounced = true;
      const minutes = Math.round(sinceChange / 60_000);
      const stuckText = `${record.lastStatusText || record.label} — no change for ${minutes} min, may be stuck`;
      pushHistory(record, { text: stuckText, ts: Date.now(), stuck: true });
      if (_sendStatusFn) {
        _sendStatusFn(record.userId, {
          type: 'status',
          agent: record.agentId,
          watcherId: record.id,
          kind: record.kind,
          label: record.label,
          text: stuckText,
          ts: Date.now(),
          stuck: true,
        });
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
  if (record.kind === 'event_subscription') unsubscribeFromEvent(record);
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
  // Only fire the chained action on a successful predicate hit. Errors,
  // expiries, and user-cancellations should not auto-run an agent — that
  // would burn cloud tokens on a state the user didn't intend to act on.
  if (status === 'done' && record.onFire && record.onFire.type && record.onFire.type !== 'notify') {
    executeOnFire(record).catch(e =>
      log.warn('watchers', 'on_fire failed', { id: record.id, type: record.onFire?.type, err: e.message })
    );
  }
}

// Run the watcher's onFire action. The supported shapes are:
//
//   { type: 'notify' }                 — status bubble only (default; not handled here)
//   { type: 'agent', prompt? }         — kick off an agent run on the watcher's
//                                        owning agentId, with an injected
//                                        [WATCHER FIRED] system note that
//                                        explains the trigger and tells the
//                                        agent to act, not ask.
//
// agentId on the watcher record is the WS-scoped sessionKey (e.g.
// "user_<uid>_coordinator"). We need the unscoped registry id to resolve
// the agent, then re-scope for streaming. The systemNote pattern mirrors
// scheduler.mjs's [SCHEDULED RUN] note — same constraint (no human present).
async function executeOnFire(record) {
  const cfg = record.onFire;
  if (!cfg || cfg.type !== 'agent') return;

  const { getAgent } = await import('../agents.mjs');
  const { streamChat } = await import('../chat.mjs');
  const { appendToSession } = await import('../sessions.mjs');
  const { getAgentsForUser, getUser } = await import('../routes/_helpers.mjs');
  const { runAgentWithRetry } = await import('../lib/run-agent-with-retry.mjs');

  const userId = record.userId;
  const scoped = record.agentId || '';
  const rawAgentId = scoped.startsWith(`${userId}_`) ? scoped.slice(userId.length + 1) : scoped;
  if (!rawAgentId) {
    log.warn('watchers', 'on_fire: no agent id on record', { id: record.id });
    return;
  }

  const isChild = getUser(userId)?.role === 'child';
  const resolved = getAgentsForUser(userId).find(a => a.id === rawAgentId)
    ?? (isChild ? null : getAgent(rawAgentId));
  if (!resolved) {
    log.warn('watchers', 'on_fire: agent not resolvable', { id: record.id, agentId: rawAgentId });
    return;
  }

  const sessionKey = `${userId}_${resolved.id}`;
  const scopedAgent = { ...resolved, id: sessionKey };

  const fireText = record.lastStatusText || `Watch "${record.label}" fired.`;
  const userPrompt = (cfg.prompt && String(cfg.prompt).trim())
    || `The watch you set ("${record.label}") just fired: ${fireText}. Act on this now.`;

  appendToSession(sessionKey, {
    role: 'system',
    content: `[Watcher fired] ${record.label} — ${fireText}`,
    watcherId: record.id,
    ts: Date.now(),
  });

  const watcherNote =
    `[WATCHER FIRED] You are reacting to a condition-triggered monitor that just fired. ` +
    `The user is NOT present. The watch label is "${record.label}" and its result is: ${fireText}. ` +
    `Use any ask_agent / tools needed and complete the action directly — do NOT show a draft, ask "are you sure?", or wait for confirmation. ` +
    `Report what you did in your final message.`;

  log.info('watchers', 'on_fire agent run', { id: record.id, agentId: sessionKey });

  // Retry on stream errors, fetch throws, and LoopGuard stalls — all surfaced
  // through the shared helper. Single attempt by default keeps the previous
  // single-shot behavior; bump if a watcher class proves to need more.
  const { succeeded, lastError } = await runAgentWithRetry({
    scopedAgent, userText: userPrompt, systemNote: watcherNote, userId, streamChat,
    maxAttempts: 1,
    context: 'watchers',
  });

  if (!succeeded) {
    log.warn('watchers', 'on_fire run failed', { id: record.id, err: lastError });
    // Append a visible message to the session so the user sees something under
    // the [Watcher fired] header instead of a bare trigger with no follow-up.
    // Same role:'assistant' shape the scheduler uses for failed scheduled tasks.
    try {
      appendToSession(sessionKey, {
        role: 'assistant',
        content: `⚠️ Watcher fired but the agent's response failed: ${lastError || 'unknown error'}.`,
        watcherId: record.id,
        watcherFailed: true,
        ts: Date.now(),
      });
    } catch (e) {
      log.warn('watchers', 'on_fire failure-message append threw', { id: record.id, err: e.message });
    }
    // Surface as a status bubble too — the watcher itself already finalized
    // 'done' (predicate hit), so the user has a green check next to a failed
    // chained run unless we say otherwise.
    _sendStatusFn?.(record.userId, {
      type: 'status',
      agent: record.agentId,
      watcherId: record.id,
      kind: record.kind,
      label: record.label,
      text: `⚠️ Agent run after watcher fired failed: ${lastError || 'unknown error'}`,
      ts: Date.now(),
      onFireFailed: true,
    });
  }

  // Tell the user's connected client to reload the agent session so the
  // streamed turns become visible. Without this, the UI keeps showing the
  // pre-fire state and the user sees the trigger bubble but not the agent
  // response — same shape as scheduled tasks broadcasting task_complete.
  // Fires on both success and failure so the failure message above renders.
  _sendStatusFn?.(record.userId, {
    type: 'task_complete',
    taskId: `watcher_${record.id}`,
    agent: resolved.id,
  });
}

// Bulk-cancel watchers matching a predicate. Returns the count cancelled.
// Used by skills that explicitly tear down the resource a watcher polls
// (e.g. runpod_terminate_pod) so the chat doesn't keep showing "still
// rendering" for a job the user just killed.
export function unregisterMatchingWatchers(userId, predicate, reason = 'cancelled') {
  if (!userId || typeof predicate !== 'function') return 0;
  const data = loadUserWatchers(userId);
  const remaining = [];
  let cancelled = 0;
  for (const w of data.active) {
    let match = false;
    try { match = !!predicate(w); } catch { match = false; }
    if (match) {
      if (w.kind === 'event_subscription') unsubscribeFromEvent(w);
      w.status = reason;
      w.endedAt = Date.now();
      data.recent.unshift(w);
      cancelled++;
    } else {
      remaining.push(w);
    }
  }
  if (cancelled === 0) return 0;
  data.active = remaining;
  data.recent = data.recent.slice(0, 20);
  persistUser(userId);
  return cancelled;
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
    // Send a real notification (toast + persisted in agent session). Use for
    // events that warrant the user's attention NOW even with the chat closed —
    // a service going down, a deploy failing, a deadline missed. Routine
    // progress updates should use postStatus instead.
    notify: (content, opts = {}) => {
      const ts = Date.now();
      const fromName = opts.from || record.label || record.kind;
      _sendNotificationFn?.(record.userId, {
        type: 'agent_notification',
        agent: record.agentId,
        content,
        from: { userName: fromName },
        event: opts.event || record.kind,
        data: opts.data || {},
        ts,
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
export function startWatcherSupervisor({ sendStatus, sendNotification, showImage, showVideo } = {}) {
  if (_running) return;
  _sendStatusFn = sendStatus || null;
  _sendNotificationFn = sendNotification || null;
  _showImageFn = showImage || null;
  _showVideoFn = showVideo || null;
  loadAllUsersFromDisk();
  // Re-subscribe persisted event_subscription watchers to the in-process bus.
  // The bus lives only in memory, so a restart that doesn't replay this leaves
  // events firing into the void even though the watcher record on disk says
  // it's listening.
  for (const [, data] of _byUser) {
    for (const w of data.active) {
      if (w.kind === 'event_subscription') subscribeToEvent(w);
    }
  }
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
