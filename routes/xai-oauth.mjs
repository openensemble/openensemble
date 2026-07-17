/**
 * xAI SuperGrok / X Premium+ OAuth routes — per-user device-code login.
 *
 *   GET    /api/oauth/xai/connect   — start device-code flow (Bearer auth)
 *   GET    /api/oauth/xai/status    — connection status for current user
 *   GET    /api/oauth/xai/pending   — pending device-code status (user_code, etc.)
 *   POST   /api/oauth/xai/refresh   — force token refresh
 *   DELETE /api/oauth/xai           — disconnect (delete + best-effort revoke)
 *
 * After /connect the server polls xAI in the background until the user
 * approves (or the code expires). The UI polls /status until connected.
 */

import { requireAuth, getUser, isPrivileged } from './_helpers.mjs';
import {
  requestDeviceCode, pollDeviceToken, writeToken, readToken, deleteToken,
  isConnected, forceRefreshToken, revokeToken, generatePendingId,
} from '../lib/xai-oauth-auth.mjs';

function isOAuthAllowed(userId, providerId) {
  if (isPrivileged(userId)) return true;
  const u = getUser(userId);
  const list = u?.allowedOAuthProviders;
  if (list == null) return false;
  return Array.isArray(list) && list.includes(providerId);
}

/** Secret-free connection metadata for the settings UI. */
export function buildXaiOAuthStatus(token, connected) {
  return {
    connected: connected === true,
    email: token?.email ?? null,
    name: token?.name ?? null,
    sub: token?.sub ?? null,
    expiresAt: token?.expires_at ?? null,
    autoRenews: Boolean(token?.refresh_token),
  };
}

// pendingId → { userId, deviceCode, userCode, verificationUri, verificationUriComplete,
//               intervalMs, expiresAt, status, message, startedAt }
const pendingById = new Map();
// userId → pendingId (at most one active device flow per user)
const pendingByUser = new Map();

const POLLERS = new Map(); // pendingId → timeout handle

function clearPending(pendingId) {
  const entry = pendingById.get(pendingId);
  if (entry) {
    pendingById.delete(pendingId);
    if (pendingByUser.get(entry.userId) === pendingId) pendingByUser.delete(entry.userId);
  }
  const t = POLLERS.get(pendingId);
  if (t) { clearTimeout(t); POLLERS.delete(pendingId); }
}

function schedulePoll(pendingId, delayMs) {
  const prev = POLLERS.get(pendingId);
  if (prev) clearTimeout(prev);
  const handle = setTimeout(() => { runPoll(pendingId).catch(() => {}); }, delayMs);
  handle.unref?.();
  POLLERS.set(pendingId, handle);
}

async function runPoll(pendingId) {
  const entry = pendingById.get(pendingId);
  if (!entry) return;
  if (Date.now() > entry.expiresAt) {
    entry.status = 'expired';
    entry.message = 'Device code expired. Click Connect again.';
    return;
  }

  let result;
  try {
    result = await pollDeviceToken(entry.deviceCode);
  } catch (e) {
    entry.status = 'error';
    entry.message = e?.message || 'Poll failed';
    return;
  }

  if (result.status === 'ok' && result.token) {
    writeToken(entry.userId, result.token);
    console.log(`[xai-oauth] stored token for user=${entry.userId} email=${result.token.email || '?'}`);
    entry.status = 'connected';
    entry.message = null;
    // Keep a brief window so a racing status poll still sees connected via
    // isConnected(); then drop the pending record.
    setTimeout(() => clearPending(pendingId), 30_000).unref?.();
    return;
  }
  if (result.status === 'pending') {
    entry.status = 'pending';
    schedulePoll(pendingId, entry.intervalMs);
    return;
  }
  if (result.status === 'slow_down') {
    entry.intervalMs = Math.min(30_000, entry.intervalMs + (result.intervalBump || 5) * 1000);
    entry.status = 'pending';
    schedulePoll(pendingId, entry.intervalMs);
    return;
  }
  // Terminal
  entry.status = result.status;
  entry.message = result.message || result.status;
}

// Reap abandoned pending flows every minute.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingById) {
    if (now > entry.expiresAt + 60_000) clearPending(id);
  }
}, 60_000).unref?.();

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/oauth/xai/connect' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!isOAuthAllowed(userId, 'xai-oauth')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'xAI SuperGrok login is not enabled for your account. Ask an admin to enable it.',
      }));
      return true;
    }

    // Cancel any prior in-flight device flow for this user.
    const oldId = pendingByUser.get(userId);
    if (oldId) clearPending(oldId);

    try {
      const device = await requestDeviceCode();
      const pendingId = generatePendingId();
      const intervalMs = Math.max(1000, (device.interval || 5) * 1000);
      const expiresAt = Date.now() + (device.expires_in || 900) * 1000;
      const entry = {
        userId,
        deviceCode: device.device_code,
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        verificationUriComplete: device.verification_uri_complete
          || `${device.verification_uri}?user_code=${encodeURIComponent(device.user_code)}`,
        intervalMs,
        expiresAt,
        status: 'pending',
        message: null,
        startedAt: Date.now(),
      };
      pendingById.set(pendingId, entry);
      pendingByUser.set(userId, pendingId);
      // First poll after one interval so the user has time to open the URL.
      schedulePoll(pendingId, intervalMs);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        pendingId,
        userCode: entry.userCode,
        verificationUri: entry.verificationUri,
        verificationUriComplete: entry.verificationUriComplete,
        expiresAt: entry.expiresAt,
        intervalMs: entry.intervalMs,
      }));
    } catch (e) {
      console.error('[xai-oauth] connect failed:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Could not start SuperGrok login: ${e.message}` }));
    }
    return true;
  }

  if (url.pathname === '/api/oauth/xai/pending' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const pendingId = pendingByUser.get(userId);
    const entry = pendingId ? pendingById.get(pendingId) : null;
    if (!entry) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending: false, connected: isConnected(userId) }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pending: entry.status === 'pending',
      status: entry.status,
      message: entry.message,
      userCode: entry.userCode,
      verificationUri: entry.verificationUri,
      verificationUriComplete: entry.verificationUriComplete,
      expiresAt: entry.expiresAt,
      connected: entry.status === 'connected' || isConnected(userId),
    }));
    return true;
  }

  if (url.pathname === '/api/oauth/xai/status' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const token = readToken(userId);
    const connected = isConnected(userId);
    const body = buildXaiOAuthStatus(token, connected);
    // Surface in-progress device flow so the UI can keep showing the code.
    const pendingId = pendingByUser.get(userId);
    const entry = pendingId ? pendingById.get(pendingId) : null;
    if (entry && entry.status === 'pending') {
      body.pending = true;
      body.userCode = entry.userCode;
      body.verificationUriComplete = entry.verificationUriComplete;
      body.expiresAtDevice = entry.expiresAt;
    } else if (entry && entry.status !== 'connected') {
      body.pending = false;
      body.pendingError = entry.message || entry.status;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  }

  if (url.pathname === '/api/oauth/xai/refresh' && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!isConnected(userId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not connected — nothing to refresh.' }));
      return true;
    }
    try {
      await forceRefreshToken(userId);
      const token = readToken(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        email: token?.email ?? null,
        expiresAt: token?.expires_at ?? null,
      }));
    } catch (e) {
      console.warn(`[xai-oauth] manual refresh failed for user=${userId}: ${e.message}`);
      const entitlement = e.entitlement === true;
      res.writeHead(entitlement ? 403 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: entitlement
          ? e.message
          : 'Could not refresh the login — it may have been revoked. Please reconnect.',
        needsReconnect: !entitlement,
        entitlement,
      }));
    }
    return true;
  }

  if (url.pathname === '/api/oauth/xai' && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const oldId = pendingByUser.get(userId);
    if (oldId) clearPending(oldId);
    await revokeToken(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ disconnected: true }));
    return true;
  }

  return false;
}
