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

function sessionCreatedAt(s) {
  return s.createdAt ?? (s.expires - 7 * 24 * 60 * 60 * 1000);
}

function sessionHardCap(s) {
  return sessionCreatedAt(s) + NODE_SESSION_HARD_CAP_MS;
}

function shouldPruneSession(s, now = Date.now()) {
  if (isPersistentDeviceKind(s?.kind)) {
    return now >= sessionHardCap(s);
  }
  return !s || s.expires < now;
}

// Sweep expired sessions hourly so abandoned tokens don't accumulate in memory
// or active-sessions.json. Without this, expired sessions are pruned only on
// access — a token that expires but is never retried lingers for weeks.
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [token, s] of sessions) if (shouldPruneSession(s, now)) { sessions.delete(token); removed++; }
  if (removed) persistSessions();
}, 60 * 60_000).unref?.();

export function loadPersistedSessions() {
  try {
    if (fs.existsSync(SESSIONS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
      const now = Date.now();
      for (const [token, s] of Object.entries(data))
        if (!shouldPruneSession(s, now)) sessions.set(token, s);
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

// Hard ceiling on persistent-device session lifetime (nodes, voice devices).
// The sliding 7-day expiry below extends these sessions every time they
// authenticate, which means a stolen token would otherwise be valid forever.
// Capping at 90 days from initial mint forces re-pairing periodically.
const NODE_SESSION_HARD_CAP_MS = 90 * 24 * 60 * 60 * 1000;

// getSessionUserId runs on EVERY request and, for persistent-device kinds,
// slides the 7-day expiry forward each call. Persisting the whole session map
// (JSON.stringify + atomicWriteSync) on every one of those blocks the event
// loop — twice per /api/tts for a voice device. The slide only needs coarse
// durability: skip the write unless the expiry advanced by at least this much
// since the last persisted value. A crash loses at most this window of slide,
// which the very next request re-applies — harmless.
const SESSION_PERSIST_MIN_ADVANCE_MS = 10 * 60 * 1000;

// Long-lived device kinds that get sliding-expiry renewal, survive password
// changes, and aren't shown on the user's active-sessions list. Each has its
// own UI surface (Nodes page, Voice Devices page) where the user revokes
// them explicitly — the generic session-management flows must not touch them.
export function isPersistentDeviceKind(kind) {
  return kind === 'node' || kind === 'voice-device';
}

// Truncate a request's User-Agent for storage on the session record. Kept as
// a shared helper (rather than `.slice(0, 120)` repeated at every call site)
// so all five createSession callers truncate identically. Not a security
// boundary — just a display-length cap for the sessions list.
const UA_MAX_LEN = 120;
export function uaFromReq(req) {
  const ua = req?.headers?.['user-agent'];
  return typeof ua === 'string' && ua.trim() ? ua.trim().slice(0, UA_MAX_LEN) : null;
}

export function createSession(userId, { kind = 'browser', deviceId = null, ua = null, label = null } = {}) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const expires = now + 7 * 24 * 60 * 60 * 1000;
  // deviceId is captured for voice-device + node sessions so the WS handler
  // can route per-device behavior (e.g. slot_agent_map lookup on wake events)
  // without re-querying the device registry by token prefix every message.
  // ua/label are display-only metadata for the sessions list (richer than a
  // bare token prefix) — never used for auth decisions. Sessions created
  // before this field existed simply read back as null (see getUserSessions).
  sessions.set(token, { userId, expires, lastActivity: now, kind, createdAt: now, deviceId, ua: ua || null, label: label || null });
  persistSessions();
  return token;
}

/**
 * Revive an EXISTING token as a live session. Used by voice-device auto-recovery:
 * a paired device's session token expired and was pruned, but the device proved
 * possession of it (verified against the device registry's stored token hash),
 * so we re-admit that exact token instead of forcing a re-pair. The device keeps
 * using the token already in its NVS — no firmware change, no new token to push.
 * Caller is responsible for verifying the token's owner before calling this.
 */
export function adoptSession(token, { userId, deviceId = null, kind = 'voice-device', ua = null, label = null } = {}) {
  if (!token || !userId) return false;
  const now = Date.now();
  const expires = now + 7 * 24 * 60 * 60 * 1000;
  sessions.set(token, { userId, expires, lastActivity: now, kind, createdAt: now, deviceId, ua: ua || null, label: label || null });
  persistSessions();
  return true;
}

/**
 * Bind a deviceId onto an already-created session. Used by the device-pairing
 * route after registerDevice() generates the id — we want the deviceId in the
 * session so the WS handler can resolve it cheaply, but we also need the
 * device record to know its token_prefix, so the two-step creation is
 * unavoidable. No-op if the token doesn't exist (expired or never created).
 */
export function setSessionDeviceId(token, deviceId) {
  const s = sessions.get(token);
  if (!s) return;
  s.deviceId = deviceId;
  persistSessions();
}

/**
 * Returns the session's userId + kind + deviceId (or null if invalid/expired).
 * Used by the WS handler to attach device context at auth time. The expiry
 * + sliding-window logic mirrors getSessionUserId — call this when you need
 * more than just the userId so we touch the session exactly once.
 */
export function getSessionMeta(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const userId = getSessionUserId(token);  // also bumps lastActivity + handles expiry
  if (!userId) return null;
  return { userId, kind: s.kind || 'browser', deviceId: s.deviceId || null };
}

export function getSessionUserId(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  // Sliding expiry for persistent-device sessions (nodes + voice devices):
  // each successful auth pushes the hard 7-day expiry forward so long-lived
  // devices don't die after a week. Capped at NODE_SESSION_HARD_CAP_MS from
  // createdAt so a stolen device token cannot stay valid indefinitely.
  // Browser sessions keep their fixed expiry.
  if (isPersistentDeviceKind(s.kind)) {
    const hardCap = sessionHardCap(s);
    if (now >= hardCap) {
      sessions.delete(token); persistSessions();
      console.log(`[sessions] ${s.kind} session hit 90-day hard cap, revoking. User must re-pair.`);
      return null;
    }
    s.lastActivity = now;
    s.expires = Math.min(now + 7 * 24 * 60 * 60 * 1000, hardCap);
    // Persist only when the expiry has advanced meaningfully SINCE WE LAST
    // PERSISTED it — not since the previous call. Comparing against the previous
    // call meant a high-frequency device (auth < the threshold apart, e.g. a
    // voice device on every /api/tts) never crossed the bar and never persisted
    // its slide at all; comparing against the last-persisted value bounds the
    // write rate while still writing at least every SESSION_PERSIST_MIN_ADVANCE_MS
    // of accumulated advance.
    const lastPersisted = s.persistedExpires ?? 0;
    if (s.expires - lastPersisted >= SESSION_PERSIST_MIN_ADVANCE_MS) {
      s.persistedExpires = s.expires;
      persistSessions();
    }
    return s.userId;
  }
  if (s.expires < now) { sessions.delete(token); persistSessions(); return null; }
  try {
    const cfg = loadConfig();
    const idleHours = cfg.sessionExpiryHours ?? 0;
    if (idleHours > 0 && s.lastActivity) {
      if ((now - s.lastActivity) > idleHours * 3600000) {
        sessions.delete(token); persistSessions(); return null;
      }
    }
  } catch (e) { console.warn('[sessions] Idle check error:', e.message); }
  s.lastActivity = now;
  return s.userId;
}

export function hasSessionToken(token) {
  return !!(token && sessions.has(token));
}

export function persistSessionStoreForTests() {
  persistSessions();
}

export function renewSessionForTests(token, patch) {
  const s = sessions.get(token);
  if (!s) return false;
  Object.assign(s, patch);
  persistSessions();
  return true;
}

export function getSessionForTests(token) {
  const s = sessions.get(token);
  return s ? { ...s } : null;
}

export function clearSessionStoreForTests() {
  sessions.clear();
  persistSessions();
}

export function deleteSession(token) { sessions.delete(token); persistSessions(); }
/**
 * Clear all browser sessions for a user. Persistent-device sessions (nodes,
 * voice devices) are preserved — they represent long-lived hardware
 * registrations and should only be revoked by their explicit per-device
 * remove flows, not by browser-session management (password change, role
 * change, lock, etc.).
 */
export function clearUserSessions(userId) {
  for (const [token, s] of sessions) {
    if (s.userId === userId && !isPersistentDeviceKind(s.kind)) sessions.delete(token);
  }
  persistSessions();
}
/**
 * Revoke every node-agent session this user owns. Caller (e.g. the
 * "revoke all paired nodes" UI action) must also call removeNode for each
 * registered node so reconnects are rejected — the session token alone is
 * not sufficient to unauthenticate without that, since the agent could
 * still try to redeem a fresh pairing code.
 */
export function clearUserNodeSessions(userId) {
  let removed = 0;
  for (const [token, s] of sessions) {
    if (s.userId === userId && s.kind === 'node') {
      sessions.delete(token);
      removed++;
    }
  }
  if (removed) persistSessions();
  return removed;
}
/**
 * Revoke every voice-device session this user owns. Parallel to
 * clearUserNodeSessions — kept strict (only kind === 'voice-device') so that
 * "revoke all voice devices" doesn't accidentally nuke node-agent sessions.
 * Caller is also responsible for removing the device from voice-devices.json
 * so re-pairing requires a fresh code.
 */
export function clearUserVoiceDeviceSessions(userId) {
  let removed = 0;
  for (const [token, s] of sessions) {
    if (s.userId === userId && s.kind === 'voice-device') {
      sessions.delete(token);
      removed++;
    }
  }
  if (removed) persistSessions();
  return removed;
}
/**
 * Revoke a single persistent-device session by token. Used by per-device
 * remove flows (DELETE /api/devices/:id, DELETE /api/nodes/:id) to drop just
 * that one token without affecting the user's other devices.
 */
export function deleteSessionByToken(token) {
  if (!token || !sessions.has(token)) return false;
  sessions.delete(token);
  persistSessions();
  return true;
}
/**
 * Clear all sessions for a user except the given token.
 * Used on self-initiated password change so the acting browser stays logged in.
 * Persistent-device sessions (nodes, voice devices) are preserved — see
 * clearUserSessions.
 */
export function clearUserSessionsExcept(userId, exceptToken) {
  let removed = 0;
  for (const [token, s] of sessions) {
    if (s.userId === userId && token !== exceptToken && !isPersistentDeviceKind(s.kind)) { sessions.delete(token); removed++; }
  }
  persistSessions();
  return removed;
}

export function getUserSessions(userId) {
  const result = [];
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.userId !== userId || s.expires < now) continue;
    result.push({
      tokenPrefix: token.slice(0, 8) + '…',
      kind: s.kind || 'browser',
      // deviceId/ua/label are null-guarded: sessions persisted before these
      // fields existed (active-sessions.json survives across deploys) won't
      // have them, so every reader must tolerate undefined here.
      deviceId: s.deviceId ?? null,
      ua: s.ua ?? null,
      label: s.label ?? null,
      createdAt: new Date(sessionCreatedAt(s)).toISOString(),
      lastActivity: s.lastActivity ? new Date(s.lastActivity).toISOString() : null,
      expiresAt: new Date(s.expires).toISOString(),
    });
  }
  return result;
}

/**
 * Internal-only: full tokens (not prefixes) for this user's node-agent
 * sessions. getUserSessions() deliberately redacts to tokenPrefix for
 * anything that reaches the client — this exists so a caller that needs to
 * resolve node identity server-side (GET /api/sessions?includeDevices=1
 * mapping a session to its node-registry display name via
 * skills/nodes/node-registry.mjs findNodeByToken) can do the prefix→token
 * lookup without ever putting a full token in an HTTP response. Do not wire
 * this into any route response body directly.
 */
export function getUserNodeSessionTokens(userId) {
  const tokens = [];
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.userId === userId && s.kind === 'node' && s.expires >= now) tokens.push(token);
  }
  return tokens;
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

// ── Cookie helpers ──────────────────────────────────────────────────────────
// Browser sessions ride on an HttpOnly cookie so injected JS (XSS) cannot
// read the token. Non-browser clients (oe-node-agent, CLI, scripts, the WS
// first-message auth) continue to use Authorization: Bearer.
const SESSION_COOKIE = 'oe_session';

export function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  const out = {};
  for (const part of String(header).split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function isRequestSecure(req) {
  if (req.socket?.encrypted) return true;
  const xfp = req.headers?.['x-forwarded-proto'];
  if (typeof xfp === 'string' && xfp.split(',')[0].trim() === 'https') return true;
  return false;
}

/** Set the HttpOnly session cookie on a response. Call alongside the JSON body
 *  on /api/login + invite-redeem + switch-user paths. Mirrors the server-side
 *  session expiry (7 days; node sessions slide so don't set a fixed expiry on
 *  those — but only browser sessions ever get this cookie). */
export function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + (7 * 24 * 60 * 60),
  ];
  if (isRequestSecure(req)) parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
}

export function clearSessionCookie(req, res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isRequestSecure(req)) parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
}

function appendSetCookie(res, value) {
  // Coexist with any Set-Cookie the route may have already added (none today,
  // but be safe — replacing would silently drop them).
  const existing = res.getHeader?.('Set-Cookie');
  if (!existing) { res.setHeader('Set-Cookie', value); return; }
  const arr = Array.isArray(existing) ? existing.slice() : [String(existing)];
  arr.push(value);
  res.setHeader('Set-Cookie', arr);
}

export function getAuthToken(req) {
  // Cookie first (browser path), then Authorization: Bearer (non-browser:
  // oe-node-agent, CLI, scripts, WebSocket first-message auth).
  // Previously we also accepted ?token= here for <img>/<video>/<iframe>,
  // but session tokens in URLs leak via Referer, browser history, and access
  // logs — URL callers should mint a short-lived media token instead.
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE]) return cookies[SESSION_COOKIE];
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

export function requireAuth(req, res, { allowMediaToken = true } = {}) {
  // Primary path: cookie / Authorization: Bearer <session-token>
  let userId = getSessionUserId(getAuthToken(req));
  // Fallback for browser-native media: ?token=<short-lived-media-token>.
  // Only honored for safe methods — accepting it on POST/PUT/DELETE turns
  // any leaked media URL into a CSRF write vector. Media tokens exist for
  // <img>/<video>/<iframe> which never need anything beyond GET/HEAD.
  // Suppressed entirely for privileged endpoints (allowMediaToken=false, see
  // requirePrivileged): a leaked media URL must never reach admin surfaces
  // like backup/export/logs.
  if (!userId && allowMediaToken && (req.method === 'GET' || req.method === 'HEAD')) {
    userId = consumeMediaToken(getUrlToken(req));
  }
  if (!userId) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return null; }
  return userId;
}

export function requirePrivileged(req, res) {
  const userId = requireAuth(req, res, { allowMediaToken: false });
  if (!userId) return null;
  if (!isPrivileged(userId)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin only' }));
    return null;
  }
  return userId;
}
