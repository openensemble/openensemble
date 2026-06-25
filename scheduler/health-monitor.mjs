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
// @ts-check

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
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

/**
 * @typedef {object} HealthCtx
 * @property {Function} [fetchFn]      defaults to globalThis.fetch
 * @property {(cmd: string) => Promise<{stdout: string, stderr: string, exitCode: number}>} [execFn]
 * @property {string} [auth_override]  per-service auth token override
 *
 * @typedef {(state: any, helpers: any) => HealthCtx} HealthCtxResolver
 */

// Pluggable for tests — production wires fetchFn/execFn through a default
// resolved at startHealthMonitorHandlers() time.
/** @type {HealthCtxResolver} */
let _ctxResolver = () => ({});

/** @param {HealthCtxResolver | null} fn */
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
    if ('exit_code' in expect && value && typeof value === 'object') {
      return Number(value.exitCode) === Number(expect.exit_code);
    }
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
    return interpretCliOutput(out);
  }

  return { ok: false, value: null, raw: null, unknown: true };
}

// Shared post-processing for CLI exec results — same logic whether the
// command came from a per-signal execFn call or was demultiplexed out of a
// bundled batch. Reasons for the unknown/deferred branches documented at the
// per-signal call site.
function interpretCliOutput(out) {
  const stderr = String(out.stderr || '');
  if (out.exitCode !== 0 && /\bis busy\b/i.test(stderr) && !out.stdout) {
    return { ok: false, value: null, raw: stderr.slice(0, 500), deferred: true };
  }
  if (out.exitCode !== 0 && /not connected|offline|not found|timed out/i.test(stderr) && !out.stdout) {
    return { ok: false, value: null, raw: stderr.slice(0, 500), unknown: true };
  }
  const value = (out.stdout || '').trim();
  return {
    ok: out.exitCode === 0,
    value,
    raw: value.slice(0, 500),
    exitCode: out.exitCode,
    stderr: stderr.slice(0, 500),
  };
}

// Build one composite bash invocation for an ordered list of {cmd} entries.
// Each subcommand is wrapped in `timeout 15s` so one slow check doesn't stall
// the whole batch, and bracketed by nonce-delimited markers so the server can
// split the combined output back into per-signal stdout/stderr/exitCode. The
// nonce is fresh per tick to defend against output-bleed (a signal whose
// command happens to print the marker string can't poison the next tick).
//
// Markers are deliberately weird ASCII so a typical service banner can't
// produce them by accident. Each block emits:
//   <BEGIN>i<NL>
//   <stdout for cmd i>
//   <BEGIN>i:err<NL>
//   <stderr for cmd i>
//   <BEGIN>i:rc<NL>
//   <exit code for cmd i>
//   <END>i<NL>
//
// Exported for tests.
export function buildBundleScript(commands, nonce) {
  const open = `__OE_SIG_${nonce}_BEGIN__`;
  const close = `__OE_SIG_${nonce}_END__`;
  const parts = commands.map((c, i) => {
    // The user's command might already redirect stderr — that's fine, our
    // wrapper captures whatever is left on stderr after they're done. We
    // suppress the wrapper's own "timeout" stderr by running the inner cmd
    // in a subshell and redirecting timeout's own diagnostic.
    const wrapped = `timeout 15s bash -c ${shellSingleQuote(c.cmd)}`;
    return [
      `printf '%s%d\\n' '${open}' ${i}`,
      `${wrapped} 2> /tmp/.oe_sig_${nonce}_${i}.err`,
      `__rc=$?`,
      `printf '%s%d:err\\n' '${open}' ${i}`,
      `cat /tmp/.oe_sig_${nonce}_${i}.err 2>/dev/null; rm -f /tmp/.oe_sig_${nonce}_${i}.err`,
      `printf '%s%d:rc\\n%d\\n' '${open}' ${i} "$__rc"`,
      `printf '%s%d\\n' '${close}' ${i}`,
    ].join('; ');
  });
  return parts.join('; ');
}

function shellSingleQuote(s) {
  // Wrap in single quotes for bash, escaping any embedded single quotes by
  // closing the quote, escaping the apostrophe, and reopening.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Split a bundled-bash combined output into per-signal {stdout, stderr,
// exitCode} structs in the order the commands were submitted. Returns
// `null` if the output doesn't contain any expected markers (caller should
// fall back to per-signal exec). Exported for tests.
export function parseBundleOutput(combined, count, nonce) {
  if (typeof combined !== 'string' || !combined) return null;
  const open = `__OE_SIG_${nonce}_BEGIN__`;
  const close = `__OE_SIG_${nonce}_END__`;
  // If no markers landed at all, treat as a total parse failure so caller
  // can fall back to per-signal execs — better than guessing.
  if (!combined.includes(open)) return null;
  const results = [];
  for (let i = 0; i < count; i++) {
    const stdoutStart = combined.indexOf(`${open}${i}\n`);
    const stderrStart = combined.indexOf(`${open}${i}:err\n`);
    const rcStart = combined.indexOf(`${open}${i}:rc\n`);
    const endMarker = combined.indexOf(`${close}${i}\n`);
    if (stdoutStart < 0 || stderrStart < 0 || rcStart < 0 || endMarker < 0) {
      // Partial: this signal's block is missing pieces (process killed mid-
      // run, output truncated). Mark unknown so the signal stays silent
      // rather than flapping to unhealthy on transient noise.
      results.push(null);
      continue;
    }
    const stdout = combined.slice(stdoutStart + `${open}${i}\n`.length, stderrStart);
    const stderr = combined.slice(stderrStart + `${open}${i}:err\n`.length, rcStart);
    const rcStr = combined.slice(rcStart + `${open}${i}:rc\n`.length, endMarker).trim();
    const exitCode = Number.parseInt(rcStr, 10);
    // `timeout` returns 124 when it kills the subprocess. Surface that as a
    // distinct stderr hint so interpretCliOutput's "unknown" branch can pick
    // it up via the same /timed out/ regex. The timeout binary itself doesn't
    // print to stderr on its own, so we add a marker.
    const stderrFinal = Number.isFinite(exitCode) && exitCode === 124
      ? (stderr ? stderr + '\ntimed out after 15s' : 'timed out after 15s')
      : stderr;
    results.push({
      stdout: stdout.replace(/\n$/, ''),
      stderr: stderrFinal.replace(/\n$/, ''),
      exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    });
  }
  return results;
}

// Evaluate one signal: returns { newSignal, transitionText? }.
// transitionText is non-null only on healthy↔unhealthy transitions.
// `precomputedResult` short-circuits runSignalCheck — used by the bundled
// CLI path so we don't re-run the exec.
async function evalSignal(state, signal, helpers, now, precomputedResult) {
  let result;
  if (precomputedResult !== undefined) {
    result = precomputedResult;
  } else {
    try {
      result = await runSignalCheck(state, signal, helpers);
    } catch (e) {
      return {
        newSignal: { ...signal, last_state: 'unknown', last_checked_at: now },
        transitionText: null,
        _checkErr: e.message,
      };
    }
  }

  if (result.deferred) {
    // Couldn't actually run the check (node was busy with other commands).
    // Keep last_state and current_incident_id as-is — we have no new info.
    // Bump last_checked_at so the next attempt is in ~30s rather than on
    // every 5s supervisor sweep, but don't wait the full cadence either.
    const cadenceMs = (signal.cadence_sec || DEFAULT_CADENCE_SEC) * 1000;
    return {
      newSignal: { ...signal, last_checked_at: now - cadenceMs + 30_000 },
      transitionText: null,
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
  } else if (signal.expect && typeof signal.expect === 'object' && 'exit_code' in signal.expect && result.exitCode !== undefined) {
    isHealthy = Number(result.exitCode) === Number(signal.expect.exit_code);
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
  // First pass: partition signals into (a) not-due-yet (kept as-is),
  // (b) due CLI signals (batched into one bash invocation below), and
  // (c) due non-CLI signals (HTTP — still per-signal because they're
  // server-side fetches that don't ride the node WS).
  const cliBatch = [];  // {index, signal, cmd}
  const httpDue = [];   // {index, signal}
  const skipped = new Array(state.signals.length).fill(false);
  for (let i = 0; i < state.signals.length; i++) {
    const sig = state.signals[i];
    const cadenceMs = (sig.cadence_sec || DEFAULT_CADENCE_SEC) * 1000;
    if (sig.last_checked_at && now - sig.last_checked_at < cadenceMs) {
      skipped[i] = true;
      continue;
    }
    const mech = sig.check?.mechanism;
    if (mech === 'cli' || mech === 'exec') {
      const tplCtx = { endpoint: state.endpoint || '', auth: '' };
      const cmd = substituteTemplate(sig.check?.command || '', tplCtx);
      if (cmd) cliBatch.push({ index: i, signal: sig, cmd });
      else httpDue.push({ index: i, signal: sig });  // empty cmd → fall through (will return unknown)
    } else {
      httpDue.push({ index: i, signal: sig });
    }
  }

  // Pre-compute CLI results in one bundled exec. Skip the batch (and let
  // each CLI signal fall through to per-signal exec via the runSignalCheck
  // path) if execFn is missing or the parser couldn't make sense of the
  // combined output — defense in depth so a malformed batch never silently
  // marks every signal unhealthy.
  const cliResults = new Map(); // index → precomputedResult
  if (cliBatch.length > 0) {
    let ctx;
    try {
      ctx = _ctxResolver({ ...state, signal_kind: 'batch', signal_check: null, severity: 'info' }, helpers) || {};
    } catch (e) {
      log.warn('health-monitor', 'ctxResolver threw for batch', { service_id: state.service_id, node_id: state.node_id, err: e.message });
      ctx = {};
    }
    if (ctx.execFn) {
      const nonce = randomBytes(6).toString('hex');
      const script = buildBundleScript(cliBatch.map(b => ({ cmd: b.cmd })), nonce);
      let combined;
      try {
        const out = await ctx.execFn(script);
        // If the whole batch was rejected (node busy / disconnected), surface
        // that to every signal — none of them ran.
        if (out.exitCode !== 0 && !out.stdout) {
          const interpreted = interpretCliOutput(out);
          for (const b of cliBatch) cliResults.set(b.index, interpreted);
        } else {
          combined = String(out.stdout || '');
        }
      } catch (e) {
        log.warn('health-monitor', 'bundled exec threw, falling back to per-signal', { err: e.message });
      }
      if (combined !== undefined) {
        const parsed = parseBundleOutput(combined, cliBatch.length, nonce);
        if (parsed) {
          log.info('health-monitor', `batched ${cliBatch.length} CLI signal(s)`, { node_id: state.node_id, service_id: state.service_id });
          for (let i = 0; i < cliBatch.length; i++) {
            const piece = parsed[i];
            if (piece === null) {
              cliResults.set(cliBatch[i].index, { ok: false, value: null, raw: null, unknown: true });
            } else {
              cliResults.set(cliBatch[i].index, interpretCliOutput(piece));
            }
          }
        } else {
          log.warn('health-monitor', `bundle parse failed — falling back to per-signal exec`, { node_id: state.node_id, service_id: state.service_id, signalCount: cliBatch.length });
        }
        // If parser returned null, leave cliResults empty for these signals —
        // evalSignal will fall back to its own per-signal runSignalCheck path.
      }
    }
  }

  const newSignals = [];
  const transitions = [];
  for (let i = 0; i < state.signals.length; i++) {
    if (skipped[i]) {
      newSignals.push(state.signals[i]);
      continue;
    }
    const sig = state.signals[i];
    const precomputed = cliResults.get(i);
    const { newSignal, transitionText } = await evalSignal(state, sig, helpers, now, precomputed);
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
