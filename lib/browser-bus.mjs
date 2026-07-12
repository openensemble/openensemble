// @ts-check
/**
 * Server-side registry of connected browser extensions.
 *
 * The extension opens a WS to `/ws/browser-ext` on its user's OE server,
 * proves its paired P-256 browser credential with a one-time signed
 * challenge, then registers itself. We hold the WS in a per-user Map and expose
 * `sendCommand(userId, action, args)` so skills + introspection tools can
 * issue commands and await responses.
 *
 * Commands are keyed by a 64-bit-random commandId; responses come back as
 * `{type:'result', commandId, ok, data, error?}` and resolve a stashed
 * Promise. A 30s timeout rejects stale commands.
 *
 * The extension-side capability broker enforces site and action permissions;
 * this module runs the authenticated command wire protocol.
 */

import { randomBytes, createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import log from '../logger.mjs';
import { BASE_DIR } from '../routes/_helpers/paths.mjs';

const COMMAND_TIMEOUT_MS = 30_000;

// Source-version tracking lets the extension detect on-disk changes and
// report them for diagnostics. Activation is deliberately manual: Vivaldi
// can orphan an MV3 service worker when it calls chrome.runtime.reload().
// We hash the on-disk source files of the extension at server startup;
// the hash is sent to the extension in auth_ok. The extension stores its
// last observed hash in chrome.storage.local so a mismatch can be logged.
// The user activates changed source with Reload on the browser's extensions
// page, which reliably re-registers the worker and re-reads the files.
//
// Limitations of this v1:
//   - We hash at startup, not on every connect. If the extension source
//     changes WITHOUT an OE restart, the version won't update. In
//     practice every extension code change is paired with a server
//     restart (we ship via systemctl restart openensemble), so this is
//     fine. Phase 2 could watch mtime to drop this assumption.
const _extSourceFiles = ['manifest.json', 'background.js', 'popup.html', 'popup.js'];
let _extSourceVersion = null;
function _computeExtSourceVersion() {
  const dir = path.join(BASE_DIR, 'browser-extension');
  if (!existsSync(dir)) return 'no-extension-dir';
  const h = createHash('sha1');
  for (const f of _extSourceFiles) {
    const p = path.join(dir, f);
    if (existsSync(p)) {
      h.update(f);
      h.update('\0');
      h.update(readFileSync(p));
      h.update('\0');
    }
  }
  return h.digest('hex').slice(0, 16);
}
export function getExtensionSourceVersion() {
  if (_extSourceVersion === null) {
    _extSourceVersion = _computeExtSourceVersion();
    log.info('browser-ext', 'computed source version', { version: _extSourceVersion });
  }
  return _extSourceVersion;
}

// userId → Map(extId → { ws, name, version, registeredAt })
const _byUser = new Map();
// commandId → { resolve, reject, timer, extId }
const _pending = new Map();

function _genId() { return randomBytes(8).toString('hex'); }

/**
 * Register a freshly-authenticated extension's WS connection. Returns the
 * stable extId that subsequent commands key on.
 */
export function registerBrowser(ws, { userId, name, version, credentialId = null }) {
  if (!userId) throw new Error('registerBrowser: userId required');
  const extId = _genId();
  if (!_byUser.has(userId)) _byUser.set(userId, new Map());
  const entry = {
    ws,
    name: String(name || 'browser').slice(0, 64),
    version: String(version || ''),
    credentialId: typeof credentialId === 'string' ? credentialId : null,
    registeredAt: Date.now(),
  };
  _byUser.get(userId).set(extId, entry);
  ws._extId = extId;
  ws._userId = userId;
  log.info('browser-ext', 'registered', { userId, extId, name: entry.name });
  return extId;
}

/** Immediately terminate every live socket authenticated by a revoked key. */
export function disconnectBrowserCredential(userId, credentialId) {
  const map = _byUser.get(userId);
  if (!map || !credentialId) return 0;
  const matches = [...map.values()].filter(entry => entry.credentialId === credentialId);
  for (const entry of matches) {
    // Drop synchronously so no command can race between durable revocation and
    // the WebSocket close event reaching this process.
    dropBrowser(entry.ws);
    try { entry.ws.close(4004, 'browser credential revoked'); } catch {
      try { entry.ws.terminate?.(); } catch {}
    }
  }
  return matches.length;
}

export function dropBrowser(ws) {
  const userId = ws._userId;
  const extId = ws._extId;
  if (!userId || !extId) return;
  const map = _byUser.get(userId);
  if (!map) return;
  map.delete(extId);
  if (!map.size) _byUser.delete(userId);
  // Reject every in-flight command bound to this extension; the extension
  // is gone, no result is coming.
  for (const [cmdId, p] of _pending) {
    if (p.extId === extId) {
      clearTimeout(p.timer);
      _pending.delete(cmdId);
      try { p.reject(new Error('extension disconnected')); } catch {}
    }
  }
  log.info('browser-ext', 'dropped', { userId, extId });
}

export function listBrowsers(userId) {
  const map = _byUser.get(userId);
  if (!map) return [];
  return [...map.entries()].map(([extId, e]) => ({
    extId, name: e.name, version: e.version,
    registeredAt: e.registeredAt,
  }));
}

function _firstBrowser(userId) {
  const map = _byUser.get(userId);
  if (!map || !map.size) return null;
  return map.entries().next().value; // [extId, entry]
}

/**
 * Dispatch a command to one of the user's connected extensions and resolve
 * with the result. If extId is omitted, the first connected extension wins
 * (Phase 1 keeps this simple — most users will only have one). Throws if
 * no extension is connected, or if the extension didn't reply within the
 * timeout, or if it returned ok:false.
 *
 * @param {string} userId
 * @param {string} action  — `open_tab` | `read_page` | `query` | `list_tabs`
 * @param {object} args
 * @param {{extId?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<any>}
 */
export function sendCommand(userId, action, args, opts = {}) {
  const map = _byUser.get(userId);
  if (!map || !map.size) {
    return Promise.reject(new Error('no browser extension connected for this user'));
  }
  let pair;
  if (opts.extId) {
    const e = map.get(opts.extId);
    if (e) {
      pair = [opts.extId, e];
    } else {
      return Promise.reject(new Error('target browser extension is no longer connected; list browsers again'));
    }
  } else {
    pair = _firstBrowser(userId);
  }
  if (!pair) return Promise.reject(new Error('no browser extension connected'));
  const [extId, entry] = pair;
  const cmdId = _genId();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1000, Number(opts.timeoutMs)) : COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(cmdId);
      reject(new Error(`browser command "${action}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    _pending.set(cmdId, { resolve, reject, timer, extId });
    try {
      entry.ws.send(JSON.stringify({ type: 'cmd', cmdId, action, args: args || {} }));
    } catch (e) {
      clearTimeout(timer);
      _pending.delete(cmdId);
      reject(e);
    }
  });
}

/**
 * Wire up a result coming back from the extension. Resolves the matching
 * pending Promise; no-ops if the cmdId is unknown (late arrival after the
 * timeout already rejected).
 */
export function handleResult(msg) {
  const { cmdId, ok, data, error } = msg || {};
  if (!cmdId) return;
  const p = _pending.get(cmdId);
  if (!p) return;
  clearTimeout(p.timer);
  _pending.delete(cmdId);
  if (ok === false) p.reject(new Error(String(error || 'browser command failed')));
  else p.resolve(data ?? null);
}

export function getBrowserCount() {
  let n = 0;
  for (const m of _byUser.values()) n += m.size;
  return n;
}
