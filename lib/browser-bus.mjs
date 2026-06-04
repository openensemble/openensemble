// @ts-check
/**
 * Server-side registry of connected browser extensions.
 *
 * Phase 1 is LAN-only — the extension opens a WS to `/ws/browser-ext` on
 * its user's OE server (typically `ws://<lan-ip>:3737` or `ws://localhost`),
 * authenticates with the user's auth token via first-message auth, then
 * registers itself. We hold the WS in a per-user Map and expose
 * `sendCommand(userId, action, args)` so skills + introspection tools can
 * issue commands and await responses.
 *
 * Commands are keyed by a 64-bit-random commandId; responses come back as
 * `{type:'result', commandId, ok, data, error?}` and resolve a stashed
 * Promise. A 30s timeout rejects stale commands.
 *
 * Phase 2 will add per-skill site permissions on top — this module just
 * runs the wire protocol.
 */

import { randomBytes } from 'crypto';
import log from '../logger.mjs';

const COMMAND_TIMEOUT_MS = 30_000;

// userId → Map(extId → { ws, name, version, tabs, registeredAt })
const _byUser = new Map();
// commandId → { resolve, reject, timer, extId }
const _pending = new Map();

function _genId() { return randomBytes(8).toString('hex'); }

/**
 * Register a freshly-authenticated extension's WS connection. Returns the
 * stable extId that subsequent commands key on.
 */
export function registerBrowser(ws, { userId, name, version, tabs = [] }) {
  if (!userId) throw new Error('registerBrowser: userId required');
  const extId = _genId();
  if (!_byUser.has(userId)) _byUser.set(userId, new Map());
  const entry = { ws, name: String(name || 'browser').slice(0, 64), version: String(version || ''), tabs: Array.isArray(tabs) ? tabs : [], registeredAt: Date.now() };
  _byUser.get(userId).set(extId, entry);
  ws._extId = extId;
  ws._userId = userId;
  log.info('browser-ext', 'registered', { userId, extId, name: entry.name, tabCount: entry.tabs.length });
  return extId;
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
    tabCount: e.tabs.length,
    tabs: e.tabs.map(t => ({ tabId: t.tabId, url: t.url, title: t.title, active: !!t.active })),
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
      // Stale extId — extension restarted and got a new id. The LLM might
      // have cached the old one from a prior browser_list call across an
      // OE restart. Fall through to the first available connection rather
      // than rejecting; the action surface is small and per-user-isolated
      // so this can't accidentally hit the wrong browser.
      pair = _firstBrowser(userId);
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

/**
 * The extension periodically pushes its current tab list so the server
 * snapshot stays fresh without a round-trip. Merge into the entry.
 */
export function updateTabs(ws, tabs) {
  const userId = ws._userId;
  const extId = ws._extId;
  if (!userId || !extId) return;
  const map = _byUser.get(userId);
  const entry = map?.get(extId);
  if (!entry) return;
  entry.tabs = Array.isArray(tabs) ? tabs : [];
}

export function getBrowserCount() {
  let n = 0;
  for (const m of _byUser.values()) n += m.size;
  return n;
}
