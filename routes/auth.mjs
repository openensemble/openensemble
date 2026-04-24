/**
 * Auth routes: /api/me, /api/login, /api/logout, /api/email/action
 */

import {
  requireAuth, getAuthToken, getSessionUserId, getUser,
  createSession, createMediaToken, deleteSession, verifyPassword, readBody, isTimeBlocked,
} from './_helpers.mjs';
import { log } from '../logger.mjs';

// ── Rate limiting for login ──────────────────────────────────────────────────
// Two buckets: (ip+userId) caps targeted brute-force; (ip alone) caps raw
// username-rotation attempts so an attacker can't bypass the per-user cap by
// trying a different username each request.
const loginAttempts = new Map(); // key → { count, firstAttempt }
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 5;         // per (ip, userId)
const RATE_LIMIT_IP_MAX = 20;     // per ip across all userIds

function isRateLimited(key, max) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttempt > RATE_LIMIT_WINDOW) {
    loginAttempts.set(key, { count: 1, firstAttempt: now });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

// Prune expired entries so distributed IPs can't balloon the map indefinitely.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  for (const [k, v] of loginAttempts) if (v.firstAttempt < cutoff) loginAttempts.delete(k);
}, 5 * 60_000).unref?.();

// Dummy scrypt used when the requested user doesn't exist, so the server
// spends ~the same wall-clock time as a real failed verify. Without this,
// a 30ms response says "user exists" and a 1ms response says "user doesn't."
const DUMMY_HASH = 'a'.repeat(32) + ':' + 'b'.repeat(128);
async function constantTimeMiss(password) {
  try { await verifyPassword(password ?? '', DUMMY_HASH); } catch {}
}

export async function handle(req, res) {
  if (req.url === '/api/me' && req.method === 'GET') {
    const userId = getSessionUserId(getAuthToken(req));
    if (!userId) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return true; }
    const user = getUser(userId);
    if (!user) { res.writeHead(404); res.end(JSON.stringify({ error: 'User not found' })); return true; }
    const { passwordHash: _ph, ...safe } = user;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(safe)); return true;
  }

  if (req.url === '/api/login' && req.method === 'POST') {
    try {
      const { userId, password } = JSON.parse(await readBody(req));
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
      if (isRateLimited(`${ip}:${userId ?? ''}`, RATE_LIMIT_MAX) || isRateLimited(`ip:${ip}`, RATE_LIMIT_IP_MAX)) {
        log.warn('auth', 'login rate-limited', { ip, userId });
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many login attempts. Try again in a minute.' }));
        return true;
      }
      const user = getUser(userId);
      if (!user || !user.passwordHash) {
        await constantTimeMiss(password);
        log.warn('auth', 'login failed (unknown user)', { ip, userId });
        res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid credentials' })); return true;
      }
      if (!(await verifyPassword(password, user.passwordHash))) {
        log.warn('auth', 'login failed (bad password)', { ip, userId });
        res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid credentials' })); return true;
      }
      if (user.locked) {
        log.warn('auth', 'login blocked (account locked)', { ip, userId });
        res.writeHead(403); res.end(JSON.stringify({ error: 'Account is locked' })); return true;
      }
      if (isTimeBlocked(user.accessSchedule)) {
        log.warn('auth', 'login blocked (time-restricted)', { ip, userId });
        res.writeHead(403); res.end(JSON.stringify({ error: 'Access is restricted at this time' })); return true;
      }
      const token = createSession(userId);
      const { passwordHash: _ph, ...safe } = user;
      log.info('auth', 'login ok', { ip, userId, role: user.role });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ token, user: safe }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  if (req.url === '/api/media-token' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const { token, expiresIn } = createMediaToken(authId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token, expiresIn }));
    return true;
  }

  if (req.url === '/api/logout' && req.method === 'POST') {
    const token = getAuthToken(req);
    const userId = token ? getSessionUserId(token) : null;
    if (token) deleteSession(token);
    if (userId) log.info('auth', 'logout', { userId });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return true;
  }

  if (req.url === '/api/email/action' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { tool, args } = JSON.parse(await readBody(req));
      if (!tool || typeof tool !== 'string') throw new Error('tool required');
      const ALLOWED_EMAIL_TOOLS = ['email_trash', 'email_mark_read', 'email_reply', 'email_compose', 'email_batch_label'];
      if (!ALLOWED_EMAIL_TOOLS.includes(tool)) throw new Error(`Tool not allowed: ${tool}`);
      const { executeTool } = await import('../roles.mjs');
      const result = await executeTool(tool, args ?? {}, authId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  return false;
}
