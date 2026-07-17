/**
 * xAI SuperGrok / X Premium+ OAuth — RFC 8628 device-code flow against auth.x.ai.
 *
 * Mirrors the public Grok Build / Grok CLI client (same pattern as OE's Codex OAuth):
 * public client_id, no client_secret, refresh_token rotation, per-user token file.
 *
 * Subscription tokens are intended for the Grok CLI chat proxy
 * (cli-chat-proxy.grok.com), not the developer api.x.ai surface (which often
 * returns 402/403 for subscription bearers). See lib/xai-oauth-models.mjs and
 * chat/providers/openai-responses.mjs.
 *
 * Tokens: {userDir}/xai-oauth-token.json
 *   { access_token, refresh_token, id_token?, expires_at, last_refresh, email?, sub? }
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getUserDir, withLock } from '../routes/_helpers.mjs';
import { USERS_DIR } from './paths.mjs';

// Public Grok CLI / Grok Build OAuth client (no secret). Same id used by Hermes,
// OpenClaw, and other SuperGrok OAuth clients.
export const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const ISSUER = 'https://auth.x.ai';
export const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
export const TOKEN_URL = `${ISSUER}/oauth2/token`;
export const REVOKE_URL = `${ISSUER}/oauth2/revoke`;

// conversations:* required by the CLI chat proxy; grok-cli:access + api:access
// are the core SuperGrok API scopes.
export const SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'grok-cli:access', 'api:access',
  'conversations:read', 'conversations:write',
].join(' ');

// Grok CLI proxy identity — required when calling cli-chat-proxy.grok.com with
// a subscription OAuth bearer (live-verified by peer agents mid-2026).
export const GROK_CLI_PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1';
export const GROK_CLI_HEADERS = Object.freeze({
  'x-xai-token-auth': 'xai-grok-cli',
  'x-grok-client-identifier': 'grok-shell',
  'x-grok-client-version': process.env.OE_GROK_CLI_VERSION || '0.2.93',
});

const DEFAULT_TTL_MS = 15 * 60 * 1000; // device-code access tokens tend to be short
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// ── JWT helpers ──────────────────────────────────────────────────────────────

function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return {};
  const parts = jwt.split('.');
  if (parts.length < 2) return {};
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function computeExpiresAt(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  if (typeof claims.exp === 'number') return claims.exp * 1000;
  return Date.now() + DEFAULT_TTL_MS;
}

function profileFromTokens({ access_token, id_token }) {
  const fromId = decodeJwtPayload(id_token);
  const fromAccess = decodeJwtPayload(access_token);
  return {
    email: fromId.email || fromAccess.email || null,
    sub: fromId.sub || fromAccess.sub || null,
    name: fromId.name || fromAccess.name || null,
  };
}

// ── Device code ──────────────────────────────────────────────────────────────

/**
 * Start an RFC 8628 device authorization.
 * @returns {Promise<{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}>}
 */
export async function requestDeviceCode() {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPES,
  });
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`xAI device code failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.device_code || !json.user_code) {
    throw new Error('xAI device code response missing device_code/user_code');
  }
  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri
      || json.verification_url
      || 'https://accounts.x.ai/oauth2/device',
    verification_uri_complete: json.verification_uri_complete
      || json.verification_url_complete
      || null,
    expires_in: Number(json.expires_in) || 900,
    interval: Math.max(1, Number(json.interval) || 5),
  };
}

/**
 * One poll of the token endpoint for a pending device code.
 * @returns {Promise<{status:'pending'|'slow_down'|'denied'|'expired'|'error'|'ok', token?, intervalBump?, message?}>}
 */
export async function pollDeviceToken(deviceCode) {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: CLIENT_ID,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  });
  const text = await res.text().catch(() => '');
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }

  if (res.ok && json.access_token) {
    if (!json.refresh_token) {
      return { status: 'error', message: 'Token response missing refresh_token' };
    }
    return { status: 'ok', token: normalizeTokens(json) };
  }

  const err = String(json.error || '');
  if (err === 'authorization_pending') return { status: 'pending' };
  // Defensive: some stacks return bare 400 while the grant is still pending.
  if (res.status === 400 && !err) return { status: 'pending' };
  if (err === 'slow_down') return { status: 'slow_down', intervalBump: 5 };
  if (err === 'access_denied' || err === 'authorization_denied') {
    return { status: 'denied', message: 'Authorization was denied in the browser.' };
  }
  if (err === 'expired_token') {
    return { status: 'expired', message: 'Device code expired. Start Connect again.' };
  }
  return {
    status: 'error',
    message: `Token poll failed (${res.status}): ${text.slice(0, 300) || err || 'unknown'}`,
  };
}

/** Refresh using the stored refresh_token. Refresh tokens rotate — always persist the new pair. */
export async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`xAI token refresh failed (${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    // 403 often means tier/entitlement, not a dead refresh token.
    err.entitlement = res.status === 403;
    throw err;
  }
  let json;
  try { json = JSON.parse(text); }
  catch {
    throw new Error('xAI token refresh returned non-JSON');
  }
  if (!json.access_token) throw new Error('xAI refresh response missing access_token');
  // Refresh-token rotation: a success that omits refresh_token is unsafe to
  // persist (the old one may already be consumed).
  if (!json.refresh_token) {
    throw new Error('xAI refresh response missing rotated refresh_token');
  }
  return normalizeTokens(json);
}

function normalizeTokens({ id_token, access_token, refresh_token }) {
  const profile = profileFromTokens({ access_token, id_token });
  return {
    id_token: id_token || null,
    access_token,
    refresh_token,
    expires_at: computeExpiresAt(access_token),
    last_refresh: Date.now(),
    email: profile.email,
    sub: profile.sub,
    name: profile.name,
  };
}

// ── Per-user token file I/O ──────────────────────────────────────────────────

export function tokenPath(userId) {
  return path.join(getUserDir(userId), 'xai-oauth-token.json');
}

export function readToken(userId) {
  const tp = tokenPath(userId);
  if (!fs.existsSync(tp)) return null;
  try { return JSON.parse(fs.readFileSync(tp, 'utf8')); }
  catch { return null; }
}

export function writeToken(userId, token) {
  const tp = tokenPath(userId);
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  fs.writeFileSync(tp, JSON.stringify(token, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tp, 0o600); } catch { /* best-effort */ }
}

export function deleteToken(userId) {
  const tp = tokenPath(userId);
  if (fs.existsSync(tp)) { fs.unlinkSync(tp); return true; }
  return false;
}

export function isConnected(userId) {
  return !!readToken(userId)?.access_token;
}

/**
 * Returns { access_token } ready for an API call, auto-refreshing under a
 * per-user file lock when near expiry. Refresh tokens rotate — always rewrite.
 */
export async function ensureFreshToken(userId) {
  const tp = tokenPath(userId);
  return withLock(tp, async () => {
    const current = readToken(userId);
    if (!current?.access_token) throw new Error('xAI Grok OAuth not connected for this user');
    const expiresIn = (current.expires_at ?? 0) - Date.now();
    if (expiresIn > REFRESH_SKEW_MS) {
      return { access_token: current.access_token };
    }
    if (!current.refresh_token) {
      throw new Error('xAI Grok OAuth token expired and no refresh_token available; please reconnect.');
    }
    try {
      const refreshed = await refreshTokens(current.refresh_token);
      // Preserve profile fields if refresh id_token is sparse.
      if (!refreshed.email && current.email) refreshed.email = current.email;
      if (!refreshed.sub && current.sub) refreshed.sub = current.sub;
      if (!refreshed.name && current.name) refreshed.name = current.name;
      writeToken(userId, refreshed);
      return { access_token: refreshed.access_token };
    } catch (e) {
      if (e.entitlement) {
        const err = new Error(
          'xAI rejected this SuperGrok login for API access (tier/entitlement). '
          + 'Use a console API key under Settings → Providers → xAI Grok, or upgrade the subscription.',
        );
        err.entitlement = true;
        throw err;
      }
      throw e;
    }
  });
}

/** Force refresh even when local expires_at is still in the future (e.g. after 401). */
export async function forceRefreshToken(userId) {
  const tp = tokenPath(userId);
  return withLock(tp, async () => {
    const current = readToken(userId);
    if (!current?.refresh_token) {
      throw new Error('xAI Grok OAuth token revoked and no refresh_token available; please reconnect.');
    }
    const refreshed = await refreshTokens(current.refresh_token);
    if (!refreshed.email && current.email) refreshed.email = current.email;
    if (!refreshed.sub && current.sub) refreshed.sub = current.sub;
    if (!refreshed.name && current.name) refreshed.name = current.name;
    writeToken(userId, refreshed);
    return { access_token: refreshed.access_token };
  });
}

/**
 * Proactively refresh every connected user's xAI OAuth token near expiry.
 * Same rationale as Codex keep-alive: idle accounts must not let refresh tokens lapse.
 */
export async function refreshExpiringXaiTokens({ withinMs = 48 * 60 * 60 * 1000 } = {}) {
  const summary = { checked: 0, refreshed: 0, failed: 0, skipped: 0 };
  let dirs = [];
  try { dirs = fs.readdirSync(USERS_DIR); } catch { return summary; }
  const now = Date.now();
  for (const userId of dirs) {
    if (!userId.startsWith('user_')) continue;
    const current = readToken(userId);
    if (!current?.access_token || !current?.refresh_token) continue;
    summary.checked++;
    // Device-code access tokens are short (~15m). Keep-alive should roll any
    // token expiring within withinMs; default 48h still covers daily runs for
    // longer SuperGrok sessions if xAI lengthens them later.
    if ((current.expires_at ?? 0) - now > withinMs) { summary.skipped++; continue; }
    try { await forceRefreshToken(userId); summary.refreshed++; }
    catch (e) {
      summary.failed++;
      console.warn(`[xai-oauth] keep-alive refresh failed for ${userId}: ${e.message}`);
    }
  }
  return summary;
}

/** Best-effort revoke of the refresh token (logout hygiene). */
export async function revokeToken(userId) {
  const current = readToken(userId);
  deleteToken(userId);
  if (!current?.refresh_token && !current?.access_token) return;
  const token = current.refresh_token || current.access_token;
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        client_id: CLIENT_ID,
      }),
    });
  } catch { /* ignore */ }
}

/** Opaque id for pending device sessions (not the raw device_code). */
export function generatePendingId() {
  return crypto.randomBytes(16).toString('hex');
}
