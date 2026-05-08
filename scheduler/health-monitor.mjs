/**
 * Profile health-signal watchers — register ONE watcher per (node, service)
 * profile. The handler runs every signal in the profile on each tick (honoring
 * each signal's own cadence), aggregates transitions, and emits one combined
 * status update. Healthy → unhealthy fires the troubleshooting loop and opens
 * an incident; unhealthy → healthy closes it.
 *
 * Watcher kind: 'profile_health' (system-handler).
 * Watcher state shape (current):
 *   {
 *     node_id, service_id, endpoint,
 *     signals: [
 *       {
 *         kind, check, expect, severity, cadence_sec,
 *         last_state: 'healthy'|'unhealthy'|'unknown',
 *         last_checked_at: number|null,
 *         current_incident_id: string|null,
 *       },
 *       ...
 *     ],
 *   }
 *
 * Older single-signal records (state.signal_kind, state.signal_check, …)
 * still tick correctly via a back-compat branch; they get replaced with the
 * coalesced shape on the next profile_set_trust_state toggle.
 *
 * Check mechanisms supported: http (direct fetch). cli is deferred until
 * node_exec is wrapped in a callable; calls report 'unknown' so the watcher
 * doesn't false-positive when CLI checks can't run.
 *
 * Wiring: server boot calls `startHealthMonitorHandlers()` to register the
 * handler with the watcher supervisor. Per-profile registration happens via
 * `registerProfileHealthWatchers(userId, nodeId, serviceId)` after a profile
 * is saved/reviewed.
 */

import fs from 'fs';
import path from 'path';
import {
  registerWatcher,
  unregisterMatchingWatchers,
  registerSystemWatcherHandler,
} from './watchers.mjs';
import { USERS_DIR } from '../lib/paths.mjs';
import { log } from '../logger.mjs';
import { loadProfile, substituteTemplate } from '../lib/service-profile.mjs';
import {
  openIncident,
  appendIncidentEvent,
  closeIncident,
  loadIncident,
  listIncidents,
} from '../lib/incident.mjs';
import { runTroubleshootingLoop } from '../lib/troubleshooting-loop.mjs';

const DEFAULT_CADENCE_SEC = 60;

// Pluggable for tests — production wires fetchFn/execFn through a default
// resolved at startHealthMonitorHandlers() time.
let _ctxResolver = () => ({});

export function setHealthMonitorCtxResolver(fn) {
  _ctxResolver = fn || (() => ({}));
}

// Evaluate `expect` against a value. Supports:
//   string                 → strict equality (or substring for contains-style)
//   { contains: '...' }    → substring
//   { matches: 'regex' }   → regex test
//   { gte | lte | gt | lt | eq | neq: n } → numeric/string compare
function matchesExpected(value, expect) {
  if (expect == null) return true;
  if (typeof expect === 'string') return String(value) === expect;
  if (typeof expect === 'object') {
    if ('contains' in expect)  return String(value).includes(String(expect.contains));
    if ('matches' in expect)   return new RegExp(expect.matches).test(String(value));
    if ('gte' in expect)       return Number(value) >= Number(expect.gte);
    if ('lte' in expect)       return Number(value) <= Number(expect.lte);
    if ('gt'  in expect)       return Number(value) >  Number(expect.gt);
    if ('lt'  in expect)       return Number(value) <  Number(expect.lt);
    if ('eq'  in expect)       return String(value) === String(expect.eq);
    if ('neq' in expect)       return String(value) !== String(expect.neq);
  }
  return false;
}

function jsonGet(obj, jsonPath) {
  if (!jsonPath || jsonPath === '$') return obj;
  let cur = obj;
  const tokens = jsonPath.replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) || [];
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = t.startsWith('[') ? cur[Number(t.slice(1, -1))] : cur[t];
  }
  return cur;
}

// Exported for tests only — the public API is the system handler that the
// watcher supervisor invokes via tick().
export async function _runSignalCheckForTest(state, signal, helpers) {
  return runSignalCheck(state, signal, helpers);
}

async function runSignalCheck(state, signal, helpers) {
  // Resolver needs node_id + service_id (at the watcher state level) to look
  // up the profile + auth token. signal-level fields are passed alongside for
  // resolvers that key off signal kind/severity. If the resolver throws (e.g.
  // profile JSON deleted under us), surface it as unknown so the signal stays
  // silent rather than spam-firing the troubleshooting loop.
  let ctx;
  try {
    ctx = _ctxResolver({ ...state, signal_kind: signal.kind, signal_check: signal.check, severity: signal.severity }, helpers) || {};
  } catch (e) {
    log.warn('health-monitor', 'ctxResolver threw', { service_id: state.service_id, node_id: state.node_id, signal_kind: signal.kind, helpersUserId: helpers?.userId, err: e.message, stack: (e.stack || '').slice(0, 300) });
    return { ok: false, value: null, raw: e.message, unknown: true };
  }
  const tplCtx = { endpoint: state.endpoint || '', auth: ctx.auth_override ?? '' };
  const check = signal.check;

  if (check?.mechanism === 'http') {
    const url = substituteTemplate(check.url, tplCtx);
    const fetchFn = ctx.fetchFn || globalThis.fetch;
    const res = await fetchFn(url, { method: 'GET' });
    const text = await res.text();
    let parsed = text;
    if (check.parse_jsonpath) {
      try { parsed = jsonGet(JSON.parse(text), check.parse_jsonpath); }
      catch { parsed = text; }
    }
    return { ok: res.ok, value: parsed, raw: text.slice(0, 500), httpStatus: res.status };
  }

  // 'cli' is the canonical mechanism; 'exec' is accepted as an alias because
  // some saved profiles use it (LLM-coined name; the prompt now teaches 'cli').
  if (check?.mechanism === 'cli' || check?.mechanism === 'exec') {
    if (!ctx.execFn) return { ok: false, value: null, raw: null, unknown: true };
    const cmd = substituteTemplate(check.command, tplCtx);
    let out;
    try { out = await ctx.execFn(cmd); }
    catch (e) { return { ok: false, value: null, raw: e.message, unknown: true }; }
    // Distinguish "node unreachable" from "command says service is down" — a
    // disconnected node should not flip every signal unhealthy and spam the
    // troubleshooting loop on every network blip.
    const stderr = String(out.stderr || '');
    if (out.exitCode !== 0 && /not connected|offline|not found|busy|timed out/i.test(stderr) && !out.stdout) {
      return { ok: false, value: null, raw: stderr.slice(0, 500), unknown: true };
    }
    const value = (out.stdout || '').trim();
    return { ok: out.exitCode === 0, value, raw: value.slice(0, 500) };
  }

  return { ok: false, value: null, raw: null, unknown: true };
}

// Evaluate one signal: returns { newSignal, transitionText? }.
// transitionText is non-null only on healthy↔unhealthy transitions.
async function evalSignal(state, signal, helpers, now) {
  let result;
  try {
    result = await runSignalCheck(state, signal, helpers);
  } catch (e) {
    return {
      newSignal: { ...signal, last_state: 'unknown', last_checked_at: now },
      transitionText: null,
      _checkErr: e.message,
    };
  }

  if (result.unknown) {
    // CLI unsupported until node_exec is wired; don't transition. Stay silent.
    return {
      newSignal: { ...signal, last_state: 'unknown', last_checked_at: now },
      transitionText: null,
    };
  }

  // For http signals with `expect: { status: N }`, compare against the actual
  // HTTP status code, not the body. The body is in `result.value`; the status
  // is on `result.httpStatus`. Without this special-case, matchesExpected has
  // no branch for `status` and falls through to undefined → always unhealthy.
  let isHealthy;
  if (signal.expect && typeof signal.expect === 'object' && 'status' in signal.expect && result.httpStatus !== undefined) {
    isHealthy = Number(result.httpStatus) === Number(signal.expect.status);
  } else {
    isHealthy = matchesExpected(result.value, signal.expect);
  }
  const prev = signal.last_state;
  const next = isHealthy ? 'healthy' : 'unhealthy';

  if (prev === next) {
    // If we still claim an active incident but the underlying record was
    // already closed (manually via incident_resolve, or auto-reaped), drop
    // the dangling reference. Without this, the signal can stay
    // unhealthy-pointing-at-resolved-incident forever — and the next
    // healthy→unhealthy transition would try to attach to a closed record.
    let currentIncidentId = signal.current_incident_id || null;
    if (next === 'unhealthy' && currentIncidentId) {
      try {
        const inc = loadIncident(helpers.userId, state.node_id, currentIncidentId);
        if (!inc || inc.ts_closed) currentIncidentId = null;
      } catch { currentIncidentId = null; }
    }
    return {
      newSignal: { ...signal, last_state: next, last_checked_at: now, current_incident_id: currentIncidentId },
      transitionText: null,
    };
  }

  // healthy → unhealthy: open incident via troubleshooting loop.
  if (next === 'unhealthy') {
    // Fire a real notification (toast + chat inline) — service-down events
    // need to break through even when the user isn't on the chat tab.
    helpers.notify?.(
      `🔴 ${state.service_id} on ${state.node_id}: signal "${signal.kind}" went unhealthy.`,
      { from: 'Health Monitor', event: 'profile_health_unhealthy', data: { service_id: state.service_id, node_id: state.node_id, signal_kind: signal.kind, severity: signal.severity, value: result.value, expected: signal.expect } },
    );

    let loopCtx = {};
    try {
      loopCtx = _ctxResolver({ ...state, signal_kind: signal.kind, signal_check: signal.check, severity: signal.severity }, helpers) || {};
    } catch (e) {
      log.warn('health-monitor', 'ctxResolver threw before troubleshooting loop', { service_id: state.service_id, node_id: state.node_id, signal_kind: signal.kind, err: e.message });
      // Skip the troubleshooting loop but still record the transition so the
      // signal moves out of unknown — better than letting the whole handler crash.
      return {
        newSignal: { ...signal, last_state: 'unhealthy', last_checked_at: now, current_incident_id: null },
        transitionText: `${signal.kind}: unhealthy (troubleshooting unavailable: ${e.message})`,
      };
    }
    const summary = await runTroubleshootingLoop({
      userId: helpers.userId,
      nodeId: state.node_id,
      serviceId: state.service_id,
      signal: { kind: signal.kind, value: result.value, expected: signal.expect, fired_at: new Date(now).toISOString() },
      ctx: loopCtx,
    });
    return {
      newSignal: {
        ...signal,
        last_state: 'unhealthy',
        last_checked_at: now,
        current_incident_id: summary.incident_id,
      },
      transitionText: summary.summary || `${signal.kind}: unhealthy — opened ${summary.incident_id}`,
    };
  }

  // unhealthy → healthy: close incident if we have one.
  if (signal.current_incident_id) {
    try {
      const inc = loadIncident(helpers.userId, state.node_id, signal.current_incident_id);
      if (inc && !inc.ts_closed) {
        closeIncident(helpers.userId, state.node_id, signal.current_incident_id, 'health signal recovered');
      }
    } catch {}
  }
  helpers.notify?.(
    `🟢 ${state.service_id} on ${state.node_id}: signal "${signal.kind}" recovered.`,
    { from: 'Health Monitor', event: 'profile_health_recovered', data: { service_id: state.service_id, node_id: state.node_id, signal_kind: signal.kind } },
  );
  return {
    newSignal: {
      ...signal,
      last_state: 'healthy',
      last_checked_at: now,
      current_incident_id: null,
    },
    transitionText: `${signal.kind}: recovered`,
  };
}

// Profile-level handler. Walks every signal in state.signals, only running
// each signal's check when its cadence is due. Aggregates transitions into
// one combined textUpdate.
async function profileHealthHandler(state, helpers) {
  // Back-compat: old single-signal records (state.signal_kind set, no signals[]).
  // Adapt them inline so existing on-disk watchers keep working until the next
  // profile_set_trust_state toggle replaces them with a coalesced record.
  if (!Array.isArray(state.signals) && state.signal_kind) {
    const adapted = {
      node_id: state.node_id,
      service_id: state.service_id,
      endpoint: state.endpoint,
      signals: [{
        kind: state.signal_kind,
        check: state.signal_check,
        expect: state.signal_expect,
        severity: state.severity,
        cadence_sec: DEFAULT_CADENCE_SEC,
        last_state: state.last_state || 'unknown',
        last_checked_at: null,
        current_incident_id: state.current_incident_id || null,
      }],
    };
    return profileHealthHandler(adapted, helpers);
  }

  if (!Array.isArray(state.signals) || state.signals.length === 0) {
    return { newState: state };
  }

  const now = Date.now();
  const newSignals = [];
  const transitions = [];

  for (const sig of state.signals) {
    // Skip signals not yet due for their next check.
    const cadenceMs = (sig.cadence_sec || DEFAULT_CADENCE_SEC) * 1000;
    if (sig.last_checked_at && now - sig.last_checked_at < cadenceMs) {
      newSignals.push(sig);
      continue;
    }
    const { newSignal, transitionText } = await evalSignal(state, sig, helpers, now);
    newSignals.push(newSignal);
    if (transitionText) transitions.push(transitionText);
  }

  const newState = { ...state, signals: newSignals };
  if (transitions.length === 0) return { newState };

  const prefix = `${state.service_id}@${state.node_id}`;
  return {
    newState,
    textUpdate: `${prefix}: ${transitions.join('; ')}`,
  };
}

// One-shot cleanup of pre-coalescence per-signal watcher records (kind=
// 'profile_health' with state.signal_kind and no state.signals[]). Those used
// a stale check shape and never actually polled correctly. Purging frees the
// per-user watcher cap; users re-create fresh coalesced watchers via
// profile_set_trust_state when they want monitoring back on.
function purgeLegacyProfileHealthWatchers() {
  if (!fs.existsSync(USERS_DIR)) return;
  let totalRemoved = 0;
  for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const wpath = path.join(USERS_DIR, entry.name, 'watchers.json');
    if (!fs.existsSync(wpath)) continue;
    const removed = unregisterMatchingWatchers(
      entry.name,
      w => w.kind === 'profile_health' && !Array.isArray(w.state?.signals) && w.state?.signal_kind,
      'legacy-shape-purged',
    );
    totalRemoved += removed;
  }
  if (totalRemoved > 0) {
    log.info('health-monitor', `Purged ${totalRemoved} legacy per-signal profile_health watcher(s); re-review profiles to restart monitoring`);
  }
}

// Register the system handler. Idempotent; safe to call multiple times.
let _registered = false;
export function startHealthMonitorHandlers(opts = {}) {
  if (_registered) return;
  if (opts.ctxResolver) setHealthMonitorCtxResolver(opts.ctxResolver);
  registerSystemWatcherHandler('profile_health', profileHealthHandler);
  purgeLegacyProfileHealthWatchers();
  _registered = true;
}

// LLM-saved profiles drift away from the canonical health_signal schema —
// the model often emits `check.type` instead of `check.mechanism`, or nests
// `expect` inside `check` rather than at the signal level, or spells the
// mechanism `'exec'` / `'shell'` instead of `'cli'`. Normalize on registration
// so the watcher state is canonical (mechanism on check, expect at signal,
// 'cli' as the canonical exec name) and the handler stays simple.
function normalizeSignal(s) {
  const rawCheck = s.check || {};
  let mechanism = rawCheck.mechanism || rawCheck.type || null;
  if (mechanism === 'exec' || mechanism === 'shell' || mechanism === 'cmd' || mechanism === 'bash') {
    mechanism = 'cli';
  }
  const command = rawCheck.command;
  const url     = rawCheck.url;
  const parse_jsonpath = rawCheck.parse_jsonpath;

  // Pull expect from the signal level first; fall back to inside check.
  const expect = s.expect !== undefined ? s.expect : rawCheck.expect;

  return {
    kind: s.kind,
    check: {
      ...(mechanism ? { mechanism } : {}),
      ...(command ? { command } : {}),
      ...(url ? { url } : {}),
      ...(parse_jsonpath ? { parse_jsonpath } : {}),
    },
    expect,
    severity: s.severity || 'info',
    cadence_sec: s.cadence_sec || DEFAULT_CADENCE_SEC,
    last_state: 'unknown',
    last_checked_at: null,
    current_incident_id: null,
  };
}

// ── per-profile registration ────────────────────────────────────────────────

export function registerProfileHealthWatchers(userId, nodeId, serviceId, opts = {}) {
  const profile = loadProfile(userId, nodeId, serviceId);
  if (!profile) throw new Error(`no profile for ${serviceId} on ${nodeId}`);

  const sigs = profile.health_signals || [];
  if (!sigs.length) {
    return { registered: 0, signal_count: 0, watcher_id: null };
  }

  // Watcher cadence = the most-frequent signal's cadence (with the 5s floor
  // the supervisor enforces). Less-frequent signals skip individual ticks
  // via per-signal last_checked_at gating in the handler.
  const watcherCadence = sigs.reduce(
    (m, s) => Math.min(m, s.cadence_sec || DEFAULT_CADENCE_SEC),
    DEFAULT_CADENCE_SEC,
  );

  // Abandon any open incidents from a previous watcher iteration for this
  // (node, service). When we re-register, the new watcher has no link to the
  // old incidents and the recovery path can never close them — they'd just
  // accumulate. The new tick cycle will re-detect any genuinely open problem
  // and open a fresh incident, so abandoning is safe. This intentionally
  // does NOT run from unregisterProfileHealthWatchers, because a tear-down
  // without re-register (trust_state→unverified, profile delete) wants those
  // incidents preserved for review.
  const orphansClosed = abandonOrphanIncidents(userId, nodeId, serviceId);

  const watcherId = registerWatcher({
    userId,
    agentId: opts.agentId || `${userId}_coordinator`,
    kind: 'profile_health',
    cadenceSec: watcherCadence,
    expiresAt: null, // health watchers are indefinite by intent
    label: `${serviceId}@${nodeId} (${sigs.length} signal${sigs.length === 1 ? '' : 's'})`,
    skillId: null,
    state: {
      node_id: nodeId,
      service_id: serviceId,
      endpoint: profile.endpoint || '',
      signals: sigs.map(normalizeSignal),
    },
  });
  return { registered: 1, signal_count: sigs.length, watcher_id: watcherId, orphans_closed: orphansClosed };
}

function abandonOrphanIncidents(userId, nodeId, serviceId) {
  let closed = 0;
  try {
    for (const inc of listIncidents(userId, nodeId, { openOnly: true })) {
      if (inc.service_id !== serviceId) continue;
      try {
        closeIncident(userId, nodeId, inc.id, 'watcher re-registered — incident orphaned from prior iteration', 'abandoned');
        closed++;
      } catch (e) {
        log.warn('health-monitor', 'failed to abandon orphan incident', { incidentId: inc.id, err: e.message });
      }
    }
  } catch (e) {
    log.warn('health-monitor', 'orphan-incident sweep failed', { err: e.message });
  }
  return closed;
}

export function unregisterProfileHealthWatchers(userId, nodeId, serviceId) {
  return unregisterMatchingWatchers(
    userId,
    w => w.kind === 'profile_health' && w.state?.node_id === nodeId && w.state?.service_id === serviceId,
    'profile-removed',
  );
}
