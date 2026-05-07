/**
 * Profile health-signal watchers — register one watcher per signal in a
 * profile, fire the troubleshooting loop on healthy → unhealthy transitions,
 * close the incident on unhealthy → healthy.
 *
 * Watcher kind: 'profile_health' (system-handler).
 * Watcher state shape:
 *   {
 *     service_id, signal_kind, signal_check, signal_expect, severity,
 *     last_state: 'healthy'|'unhealthy'|'unknown',
 *     current_incident_id: string|null,
 *   }
 *
 * Check mechanisms supported: http (direct fetch). cli is deferred until
 * node_exec is wrapped in a callable; calls are reported as 'unknown' so
 * the watcher doesn't false-positive when CLI checks can't run yet.
 *
 * Wiring: server boot calls `startHealthMonitorHandlers()` to register the
 * handler with the watcher supervisor. Per-profile registration happens via
 * `registerProfileHealthWatchers(userId, nodeId, serviceId)` after a profile
 * is saved/reviewed.
 */

import {
  registerWatcher,
  unregisterMatchingWatchers,
  registerSystemWatcherHandler,
} from './watchers.mjs';
import { loadProfile, substituteTemplate } from '../lib/service-profile.mjs';
import {
  openIncident,
  appendIncidentEvent,
  closeIncident,
  loadIncident,
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

async function runHealthCheck(state, helpers) {
  const { signal_check } = state;
  const ctx = _ctxResolver(state, helpers) || {};
  const tplCtx = {
    endpoint: state.endpoint || '',
    auth: ctx.auth_override ?? '',
  };

  if (signal_check.mechanism === 'http') {
    const url = substituteTemplate(signal_check.url, tplCtx);
    const fetchFn = ctx.fetchFn || globalThis.fetch;
    const res = await fetchFn(url, { method: 'GET' });
    const text = await res.text();
    let parsed = text;
    if (signal_check.parse_jsonpath) {
      try { parsed = jsonGet(JSON.parse(text), signal_check.parse_jsonpath); }
      catch { parsed = text; }
    }
    return { ok: res.ok, value: parsed, raw: text.slice(0, 500) };
  }

  if (signal_check.mechanism === 'cli') {
    if (!ctx.execFn) return { ok: false, value: null, raw: null, unknown: true };
    const cmd = substituteTemplate(signal_check.command, tplCtx);
    const out = await ctx.execFn(cmd);
    const value = (out.stdout || '').trim();
    return { ok: out.exitCode === 0, value, raw: value.slice(0, 500) };
  }

  return { ok: false, value: null, raw: null, unknown: true };
}

// The watcher handler. Returns supervisor-shape result {textUpdate?, newState?}.
async function profileHealthHandler(state, helpers) {
  let result;
  try {
    result = await runHealthCheck(state, helpers);
  } catch (e) {
    return {
      newState: { ...state, last_state: 'unknown' },
      textUpdate: `${state.signal_kind}: check failed — ${e.message}`,
    };
  }

  if (result.unknown) {
    // CLI unsupported until node_exec is wired; don't transition. Keep silent
    // to avoid noise.
    return { newState: { ...state, last_state: 'unknown' } };
  }

  const isHealthy = matchesExpected(result.value, state.signal_expect);
  const prev = state.last_state;
  const next = isHealthy ? 'healthy' : 'unhealthy';

  // No transition → no action, just update last_state silently.
  if (prev === next) return { newState: { ...state, last_state: next } };

  // Transition: healthy → unhealthy. Open incident + run loop.
  if (next === 'unhealthy') {
    const summary = await runTroubleshootingLoop({
      userId: helpers.userId,
      nodeId: state.node_id,
      serviceId: state.service_id,
      signal: { kind: state.signal_kind, value: result.value, expected: state.signal_expect, fired_at: new Date().toISOString() },
      ctx: _ctxResolver(state, helpers),
    });
    return {
      newState: { ...state, last_state: 'unhealthy', current_incident_id: summary.incident_id },
      textUpdate: summary.summary || `${state.signal_kind}: unhealthy — opened ${summary.incident_id}`,
    };
  }

  // Transition: unhealthy → healthy. Close incident if we have one.
  if (state.current_incident_id) {
    try {
      const inc = loadIncident(helpers.userId, state.node_id, state.current_incident_id);
      if (inc && !inc.ts_closed) {
        closeIncident(helpers.userId, state.node_id, state.current_incident_id, 'health signal recovered');
      }
    } catch {}
  }
  return {
    newState: { ...state, last_state: 'healthy', current_incident_id: null },
    textUpdate: `${state.signal_kind}: recovered`,
  };
}

// Register the system handler. Idempotent; safe to call multiple times.
let _registered = false;
export function startHealthMonitorHandlers(opts = {}) {
  if (_registered) return;
  if (opts.ctxResolver) setHealthMonitorCtxResolver(opts.ctxResolver);
  registerSystemWatcherHandler('profile_health', profileHealthHandler);
  _registered = true;
}

// ── per-profile registration ────────────────────────────────────────────────

export function registerProfileHealthWatchers(userId, nodeId, serviceId, opts = {}) {
  const profile = loadProfile(userId, nodeId, serviceId);
  if (!profile) throw new Error(`no profile for ${serviceId} on ${nodeId}`);

  const created = [];
  for (const sig of profile.health_signals || []) {
    const watcherId = registerWatcher({
      userId,
      agentId: opts.agentId || `${userId}_coordinator`,
      kind: 'profile_health',
      cadenceSec: sig.cadence_sec || DEFAULT_CADENCE_SEC,
      expiresAt: null, // health signals are indefinite by intent
      label: `${serviceId}/${sig.kind}`,
      skillId: null,
      state: {
        node_id: nodeId,
        service_id: serviceId,
        signal_kind: sig.kind,
        signal_check: sig.check,
        signal_expect: sig.expect,
        severity: sig.severity || 'info',
        endpoint: profile.endpoint || '',
        last_state: 'unknown',
        current_incident_id: null,
      },
    });
    created.push({ watcher_id: watcherId, signal_kind: sig.kind });
  }
  return { registered: created.length, watchers: created };
}

export function unregisterProfileHealthWatchers(userId, nodeId, serviceId) {
  return unregisterMatchingWatchers(
    userId,
    w => w.kind === 'profile_health' && w.state?.node_id === nodeId && w.state?.service_id === serviceId,
    'profile-removed',
  );
}
