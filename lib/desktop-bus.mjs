// @ts-check
/**
 * Server-side registry of connected OpenEnsemble desktop clients.
 *
 * Desktop clients connect outbound to /ws/desktop, authenticate with a normal
 * OE session token, and answer local sandbox/file tool commands.
 */

import { randomBytes } from 'crypto';
import log from '../logger.mjs';

const COMMAND_TIMEOUT_MS = 60_000;

const _byUser = new Map(); // userId -> Map(clientId -> entry)
const _pending = new Map();

function _genId() { return randomBytes(8).toString('hex'); }

export function registerDesktop(ws, { userId, clientId, name, version, platform, sandboxes, capabilities }) {
  if (!userId) throw new Error('registerDesktop: userId required');
  const id = String(clientId || _genId()).slice(0, 80);
  if (!_byUser.has(userId)) _byUser.set(userId, new Map());

  const existing = _byUser.get(userId).get(id);
  if (existing?.ws && existing.ws !== ws) {
    try { existing.ws.close(4000, 'replaced by newer desktop connection'); } catch {}
  }

  const entry = {
    ws,
    clientId: id,
    name: String(name || 'desktop').slice(0, 100),
    version: String(version || ''),
    platform: String(platform || ''),
    sandboxes: Array.isArray(sandboxes) ? sandboxes : [],
    capabilities: Array.isArray(capabilities) ? capabilities : [],
    registeredAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  _byUser.get(userId).set(id, entry);
  ws._desktopClientId = id;
  ws._userId = userId;
  log.info('desktop', 'registered', { userId, clientId: id, name: entry.name, sandboxCount: entry.sandboxes.length });
  return id;
}

export function dropDesktop(ws) {
  const userId = ws._userId;
  const clientId = ws._desktopClientId;
  if (!userId || !clientId) return;
  const map = _byUser.get(userId);
  if (!map) return;
  map.delete(clientId);
  if (!map.size) _byUser.delete(userId);
  for (const [cmdId, p] of _pending) {
    if (p.clientId === clientId) {
      clearTimeout(p.timer);
      _pending.delete(cmdId);
      try { p.reject(new Error('desktop client disconnected')); } catch {}
    }
  }
  log.info('desktop', 'dropped', { userId, clientId });
}

export function listDesktops(userId) {
  const map = _byUser.get(userId);
  if (!map) return [];
  return [...map.values()].map(e => ({
    clientId: e.clientId,
    name: e.name,
    version: e.version,
    platform: e.platform,
    registeredAt: e.registeredAt,
    lastSeenAt: e.lastSeenAt,
    sandboxes: e.sandboxes,
    capabilities: e.capabilities,
  }));
}

function _firstDesktop(userId) {
  const map = _byUser.get(userId);
  if (!map || !map.size) return null;
  return map.entries().next().value;
}

export function sendDesktopCommand(userId, action, args = {}, opts = {}) {
  const map = _byUser.get(userId);
  if (!map || !map.size) return Promise.reject(new Error('no OE desktop client connected for this user'));
  let pair = null;
  if (opts.clientId && map.has(opts.clientId)) pair = [opts.clientId, map.get(opts.clientId)];
  else pair = _firstDesktop(userId);
  if (!pair) return Promise.reject(new Error('no OE desktop client connected'));

  const [clientId, entry] = pair;
  const cmdId = _genId();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1000, Number(opts.timeoutMs)) : COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(cmdId);
      reject(new Error(`desktop command "${action}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    _pending.set(cmdId, { resolve, reject, timer, clientId });
    try {
      entry.ws.send(JSON.stringify({ type: 'cmd', cmdId, action, args }));
    } catch (e) {
      clearTimeout(timer);
      _pending.delete(cmdId);
      reject(e);
    }
  });
}

export function handleDesktopResult(msg) {
  const { cmdId, ok, data, error } = msg || {};
  if (!cmdId) return;
  const p = _pending.get(cmdId);
  if (!p) return;
  clearTimeout(p.timer);
  _pending.delete(cmdId);
  if (ok === false) p.reject(new Error(String(error || 'desktop command failed')));
  else p.resolve(data ?? null);
}

export function updateDesktopStatus(ws, msg = {}) {
  const userId = ws._userId;
  const clientId = ws._desktopClientId;
  const entry = userId && clientId ? _byUser.get(userId)?.get(clientId) : null;
  if (!entry) return;
  entry.lastSeenAt = Date.now();
  if (Array.isArray(msg.sandboxes)) entry.sandboxes = msg.sandboxes;
  if (Array.isArray(msg.capabilities)) entry.capabilities = msg.capabilities;
}
