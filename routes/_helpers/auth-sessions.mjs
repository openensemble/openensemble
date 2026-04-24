/**
 * Auth primitives: password hashing, session tokens, short-lived media tokens,
 * single-use scoped tickets, and request-level auth helpers.
 *
 * Imports from '../_helpers.mjs' are function-scoped (loadConfig, isPrivileged)
 * to avoid circular-import TDZ at module init.
 */

import fs from 'fs';
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { SESSIONS_PATH } from './paths.mjs';
import { atomicWriteSync } from './io-lock.mjs';
import { loadConfig, isPrivileged } from '../_helpers.mjs';

// ── Password validation & hashing ────────────────────────────────────────────
const MIN_PASSWORD_LENGTH = 8;
export function validatePassword(pw) {
  if (!pw || typeof pw !== 'string') return 'Password is required';
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return null; // valid
}

export async function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return new Promise((res, rej) =>
    scrypt(pw, salt, 64, (err, key) =>
      err ? rej(err) : res(salt + ':' + key.toString('hex'))));
}

export async function verifyPassword(pw, stored) {
  const [salt, hash] = (stored ?? '').split(':');
  if (!salt || !hash) return false;
  return new Promise((res, rej) =>
    scrypt(pw, salt, 64, (err, key) => {
      if (err) return rej(err);
      try { res(timingSafeEqual(key, Buffer.from(hash, 'hex'))); }
      catch (e) { console.warn('[auth] Password verify error:', e.message); res(false); }
    }));
}

// ── Session tokens ───────────────────────────────────────────────────────────
const sessions = new Map();

// Sweep expired sessions hourly so abandoned tokens don't accumulate in memory
// or active-sessions.json. Without this, expired sessions are pruned only on
// access — a token that expires but is never retried lingers for weeks.
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [token, s] of sessions) if (s.expires < now) { sessions.delete(token); removed++; }
  if (removed) persistSessions();
}, 60 * 60_000).unref?.();

export function loadPersistedSessions() {
  try {
    if (fs.existsSync(SESSIONS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
      const now = Date.now();
      for (const [token, s] of Object.entries(data))
        if (s.expires > now) sessions.set(token, s);
    }
  } catch (e) { console.warn('[sessions] Failed to load persisted sessions:', e.message); }
}

function persistSessions() {
  const obj = {};
  for (const [k, v] of sessions) obj[k] = v;
  try {
    atomicWriteSync(SESSIONS_PATH, JSON.stringify(obj), { mode: 0o600 });
    // writeFileSync's `mode` only applies when the file is newly created.
    // Re-chmod on every write so permissions don't drift after restore/rsync.
    try { fs.chmodSync(SESSIONS_PATH, 0o600); } catch {}
  } catch (e) { console.warn('[sessions] Failed to persist sessions:', e.message); }
}

export function createSession(userId, { kind = 'browser' } = {}) {
  const token = randomBytes(32).toString('hex');
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  sessions.set(token, { userId, expires, lastActivity: Date.now(), kind });
  persistSessions();
  return token;
}

export function getSessionUserId(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); persistSessions(); return null; }
  try {
    const cfg = loadConfig();
    const idleHours = cfg.sessionExpiryHours ?? 0;
    if (idleHours > 0 && s.lastActivity) {
      if ((Date.now() - s.lastActivity) > idleHours * 3600000) {
        sessions.delete(token); persistSessions(); return null;
      }
    }
  } catch (e) { console.warn('[sessions] Idle check error:', e.message); }
  s.lastActivity = Date.now();
  // Sliding expiry for node-agent sessions: each successful auth pushes the
  // hard 7-day expiry forward so long-lived agents don't die after a week.
  // Browser sessions keep their fixed expiry.
  if (s.kind === 'node') {
    s.expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
    persistSessions();
  }
  return s.userId;
}

export function deleteSession(token) { sessions.delete(token); persistSessions(); }
/**
 * Clear all browser sessions for a user. Node-agent sessions (kind: 'node')
 * are preserved — they represent long-lived remote machine registrations and
 * should only be revoked by the explicit DELETE /api/nodes/:nodeId flow, not
 * by browser-session management (password change, role change, lock, etc.).
 */
export function clearUserSessions(userId) {
  for (const [token, s] of sessions) {
    if (s.userId === userId && s.kind !== 'node') sessions.delete(token);
  }
  persistSessions();
}
/**
 * Clear all sessions for a user except the given token.
 * Used on self-initiated password change so the acting browser stays logged in.
 * Node-agent sessions (kind: 'node') are preserved — see clearUserSessions.
 */
export function clearUserSessionsExcept(userId, exceptToken) {
  for (const [token, s] of sessions) {
    if (s.userId === userId && token !== exceptToken && s.kind !== 'node') sessions.delete(token);
  }
  persistSessions();
}

export function getUserSessions(userId) {
  const result = [];
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.userId !== userId || s.expires < now) continue;
    result.push({
      tokenPrefix: token.slice(0, 8) + '…',
      kind: s.kind || 'browser',
      createdAt: new Date(s.expires - 7 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivity: s.lastActivity ? new Date(s.lastActivity).toISOString() : null,
      expiresAt: new Date(s.expires).toISOString(),
    });
  }
  return result;
}

export function revokeSessionByPrefix(userId, prefix) {
  for (const [token, s] of sessions) {
    if (s.userId === userId && token.startsWith(prefix)) {
      sessions.delete(token);
      persistSessions();
      return true;
    }
  }
  return false;
}

export function getAuthToken(req) {
  // Session tokens must travel in the Authorization header. Previously we
  // also accepted ?token= here for <img>/<video>/<iframe>, but session
  // tokens in URLs leak via Referer, browser history, and access logs. URL
  // callers should mint a short-lived media token (see createMediaToken /
  // POST /api/media-token) and pass that instead.
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

export function getUrlToken(req) {
  try { return new URL(req.url, 'http://x').searchParams.get('token') || null; } catch { return null; }
}

// ── Short-lived media tokens ─────────────────────────────────────────────────
// Browser-native elements (<img>, <video>, <iframe>) can't set an Authorization
// header, so URL-embedded tokens are unavoidable for those cases. These tokens
// are (a) minted only by an authenticated caller, (b) valid for a short window,
// (c) usable any number of times within that window (video range requests).
// After expiry they're useless even if leaked via Referer or logs.
const mediaTokens = new Map(); // token → { userId, expires }
// 10 minutes balances two opposing concerns:
//  - too short: a long <video> element's src URL expires mid-playback because
//    the browser bakes the URL once and reuses it for every range request
//  - too long: a URL leaked via Referer or logs stays valid longer than needed
const MEDIA_TOKEN_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mediaTokens) if (v.expires < now) mediaTokens.delete(k);
}, 60_000).unref?.();

export function createMediaToken(userId) {
  const token = randomBytes(24).toString('hex');
  mediaTokens.set(token, { userId, expires: Date.now() + MEDIA_TOKEN_TTL_MS });
  return { token, expiresIn: MEDIA_TOKEN_TTL_MS / 1000 };
}

export function consumeMediaToken(token) {
  if (!token) return null;
  const entry = mediaTokens.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) { mediaTokens.delete(token); return null; }
  return entry.userId;
}

// ── Scoped single-use ticket tokens ──────────────────────────────────────────
// Like media tokens but single-use and scope-gated. Used for /nodes/terminal,
// which can't send an Authorization header because it's opened via window.open().
// A page-scoped ticket is minted by an authenticated caller, consumed when the
// HTML is served, and the server then mints a fresh ws-scoped ticket for the
// terminal's WebSocket upgrade.
const ticketTokens = new Map(); // token → { userId, scope, meta, expires }
const TICKET_TTL_MS = 60_000;   // 60s — short: minted right before use

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ticketTokens) if (v.expires < now) ticketTokens.delete(k);
}, 60_000).unref?.();

export function createTicket(userId, scope, meta = {}, ttlMs = TICKET_TTL_MS) {
  const token = randomBytes(24).toString('hex');
  ticketTokens.set(token, { userId, scope, meta, expires: Date.now() + ttlMs });
  return { token, expiresIn: Math.round(ttlMs / 1000) };
}

export function consumeTicket(token, scope) {
  if (!token) return null;
  const entry = ticketTokens.get(token);
  if (!entry) return null;
  ticketTokens.delete(token); // single-use
  if (entry.expires < Date.now()) return null;
  if (entry.scope !== scope) return null;
  return { userId: entry.userId, meta: entry.meta };
}

export function requireAuth(req, res) {
  // Primary path: Authorization: Bearer <session-token>
  let userId = getSessionUserId(getAuthToken(req));
  // Fallback for browser-native media: ?token=<short-lived-media-token>
  if (!userId) userId = consumeMediaToken(getUrlToken(req));
  if (!userId) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return null; }
  return userId;
}

export function requirePrivileged(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return null;
  if (!isPrivileged(userId)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin only' }));
    return null;
  }
  return userId;
}
