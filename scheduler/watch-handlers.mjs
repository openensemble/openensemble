/**
 * System-level watcher handlers for the generic "watch task" predicates.
 *
 * Registered into the supervisor's _systemHandlers map at boot via
 * registerSystemWatchHandlers(). These let a watcher be created from
 * anywhere — a tasks-skill tool, a route handler — without a per-skill
 * watcherHandlers export.
 *
 * Predicate kinds:
 *   http_jsonpath  — fetch URL → walk JSON path → compare
 *   exec           — run shell command → parse stdout → compare
 *   file_stat      — fs.stat → compare attribute (size/mtime/exists)
 *
 * Each handler returns:
 *   {textUpdate?, done?, newState?, nextCadenceSec?}
 * `done: true` is one-shot — the watcher reaps after firing once.
 * `comparator: 'changed'` fires when the value differs from lastValue
 * (needs one prior tick to seed; first tick stores baseline silently).
 */
import { exec as cpExec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { registerSystemWatcherHandler } from './watchers.mjs';
import { isUrlSafe } from '../lib/url-guard.mjs';
import { log } from '../logger.mjs';

const execAsync = promisify(cpExec);

// Predicate comparators. `changed` is handled by each handler against
// state.lastValue, not here.
function compare(value, comparator, target) {
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

// JSONPath-lite: $-rooted dot path with bracket indices. "data.price.usd",
// "results[0].name", "[3].field". No filters, slicing, or recursive descent.
// Enough for the 90% of REST-API watch cases.
function jsonGet(obj, path) {
  if (!path || path === '$') return obj;
  const trimmed = path.replace(/^\$\.?/, '');
  if (!trimmed) return obj;
  let cur = obj;
  const tokens = trimmed.match(/[^.[\]]+|\[\d+\]/g) || [];
  for (const tok of tokens) {
    if (cur == null) return undefined;
    cur = tok.startsWith('[') ? cur[Number(tok.slice(1, -1))] : cur[tok];
  }
  return cur;
}

function fmtVal(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

// ── http_jsonpath ────────────────────────────────────────────────────────────
async function httpJsonpathHandler(state) {
  const { url, jsonPath = '$', headers = {}, comparator, target } = state || {};
  if (!url || !comparator) {
    return { done: true, textUpdate: '❌ http watcher misconfigured (url + comparator required)' };
  }
  // SSRF guard — refuse private/loopback/link-local hosts so a watcher
  // pointed at cloud metadata, LAN admin pages, Tailnet, or this server
  // itself can't exfiltrate content back into agent context.
  const safety = await isUrlSafe(url);
  if (!safety.ok) {
    return { done: true, textUpdate: `❌ url blocked: ${safety.reason}` };
  }
  let body;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { textUpdate: `${url}: HTTP ${res.status}` };
    body = await res.json();
  } catch (e) {
    return { textUpdate: `${url}: fetch failed (${e.message})` };
  }
  const val = jsonGet(body, jsonPath);

  if (comparator === 'changed') {
    if (state.lastValue === undefined) {
      return { newState: { ...state, lastValue: val } };
    }
    if (JSON.stringify(val) !== JSON.stringify(state.lastValue)) {
      return { done: true, textUpdate: `🔔 ${jsonPath} changed: ${fmtVal(state.lastValue)} → ${fmtVal(val)}` };
    }
    return { textUpdate: `unchanged at ${fmtVal(val)}`, newState: state };
  }

  try {
    if (compare(val, comparator, target)) {
      return { done: true, textUpdate: `🔔 ${jsonPath}=${fmtVal(val)} ${comparator} ${target}` };
    }
  } catch (e) {
    return { done: true, textUpdate: `❌ ${e.message}` };
  }
  return { textUpdate: `${jsonPath}=${fmtVal(val)} (target ${comparator} ${target})`, newState: { ...state, lastValue: val } };
}

// ── exec ─────────────────────────────────────────────────────────────────────
async function execHandler(state) {
  const { command, parse = 'string', comparator, target, _userConfirmed } = state || {};
  if (!command || !comparator) {
    return { done: true, textUpdate: '❌ exec watcher misconfigured (command + comparator required)' };
  }
  // Defense-in-depth: agent-created exec watchers are blocked at the create_watch
  // tool, but if any unconfirmed exec watcher reaches this handler (legacy
  // persisted record, future direct registration), refuse to run it. Only
  // exec watchers explicitly registered with state._userConfirmed === true
  // (via a UI/route that proves human approval) execute.
  if (_userConfirmed !== true) {
    log.warn('watchers', 'Refusing unconfirmed exec watcher', { command: String(command).slice(0, 80) });
    return { done: true, textUpdate: '❌ exec watcher blocked (no user confirmation flag set)' };
  }
  let stdout;
  try {
    const r = await execAsync(command, { timeout: 30_000, maxBuffer: 1_000_000 });
    stdout = (r.stdout || '').trim();
  } catch (e) {
    return { textUpdate: `exec failed: ${e.message}` };
  }

  let val;
  switch (parse) {
    case 'numeric':      val = Number(stdout); break;
    case 'first_number': val = Number((stdout.match(/-?\d+(\.\d+)?/) || [])[0]); break;
    case 'lines':        val = stdout.split(/\r?\n/).filter(Boolean).length; break;
    default:             val = stdout;
  }

  if (comparator === 'changed') {
    if (state.lastValue === undefined) {
      return { newState: { ...state, lastValue: val } };
    }
    if (String(val) !== String(state.lastValue)) {
      return { done: true, textUpdate: `🔔 exec output changed: ${fmtVal(state.lastValue)} → ${fmtVal(val)}` };
    }
    return { textUpdate: `unchanged at ${fmtVal(val)}`, newState: state };
  }

  try {
    if (compare(val, comparator, target)) {
      return { done: true, textUpdate: `🔔 exec → ${fmtVal(val)} ${comparator} ${target}` };
    }
  } catch (e) {
    return { done: true, textUpdate: `❌ ${e.message}` };
  }
  return { textUpdate: `value=${fmtVal(val)} (target ${comparator} ${target})`, newState: { ...state, lastValue: val } };
}

// ── file_stat ────────────────────────────────────────────────────────────────
async function fileStatHandler(state) {
  const { path: filePath, attribute = 'exists', comparator, target } = state || {};
  if (!filePath) {
    return { done: true, textUpdate: '❌ file_stat watcher misconfigured (path required)' };
  }

  // Read the requested attribute. ENOENT for `exists` resolves to false; for
  // size/mtime it surfaces as a transient failure (file may appear later).
  let val;
  try {
    if (attribute === 'exists') {
      val = fs.existsSync(filePath);
    } else if (attribute === 'content_changed') {
      const st = fs.statSync(filePath);
      val = `${st.mtimeMs}:${st.size}`;
    } else if (attribute === 'mtime') {
      val = fs.statSync(filePath).mtimeMs;
    } else if (attribute === 'size') {
      val = fs.statSync(filePath).size;
    } else {
      return { done: true, textUpdate: `❌ unknown attribute "${attribute}"` };
    }
  } catch (e) {
    if (attribute === 'exists') val = false;
    else return { textUpdate: `stat failed: ${e.message}` };
  }

  // "Wait until the file appears / disappears" — most natural shape for the
  // exists attribute, no comparator needed.
  if (attribute === 'exists' && (!comparator || comparator === 'eq')) {
    const wantTrue = target === undefined ? true : !!target;
    if (val === wantTrue) {
      return { done: true, textUpdate: `🔔 ${filePath} ${val ? 'now exists' : 'no longer exists'}` };
    }
    return { newState: state };
  }

  if (comparator === 'changed' || attribute === 'content_changed') {
    if (state.lastValue === undefined) {
      return { newState: { ...state, lastValue: val } };
    }
    if (String(val) !== String(state.lastValue)) {
      return { done: true, textUpdate: `🔔 ${filePath} ${attribute} changed: ${fmtVal(state.lastValue)} → ${fmtVal(val)}` };
    }
    return { newState: state };
  }

  try {
    if (compare(val, comparator, target)) {
      return { done: true, textUpdate: `🔔 ${filePath} ${attribute}=${fmtVal(val)} ${comparator} ${target}` };
    }
  } catch (e) {
    return { done: true, textUpdate: `❌ ${e.message}` };
  }
  return { newState: { ...state, lastValue: val } };
}

export function registerSystemWatchHandlers() {
  registerSystemWatcherHandler('http_jsonpath', httpJsonpathHandler);
  registerSystemWatcherHandler('exec',          execHandler);
  registerSystemWatcherHandler('file_stat',     fileStatHandler);
  log.info('watchers', 'System watch handlers registered', { kinds: ['http_jsonpath', 'exec', 'file_stat'] });
}
