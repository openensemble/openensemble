/**
 * OpenAI Codex OAuth — PKCE flow against auth.openai.com.
 *
 * Mirrors the Codex CLI login flow (openai/codex, codex-rs/login/src/auth/manager.rs)
 * so a ChatGPT Plus/Pro subscriber can authorize OpenEnsemble to call the Responses
 * API on their behalf at chatgpt.com/backend-api/codex.
 *
 * Tokens are stored per-user at {userDir}/openai-codex-token.json as:
 *   { id_token, access_token, refresh_token, account_id, expires_at, last_refresh }
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getUserDir, withLock } from '../routes/_helpers.mjs';

// Constants matching the public Codex CLI (manager.rs:830).
export const CLIENT_ID    = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const ISSUER       = 'https://auth.openai.com';
// The Codex client_id is registered against this exact redirect URI at OpenAI.
// It cannot be changed, so we run a tiny ephemeral listener on :1455 when the
// OAuth flow is active (see routes/openai-oauth.mjs).
export const REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = '/auth/callback';
// The connectors scopes are what Codex requests; non-connector use only needs the first three.
export const SCOPES = 'openid profile email offline_access';

// Codex access tokens are long-lived (weeks), but we proactively refresh when
// < 5 minutes remain on the stored expires_at. If the JWT lacks an `exp` claim
// we default to 28 days from issue.
const DEFAULT_TTL_MS  = 28 * 24 * 60 * 60 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function base64urlNoPad(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce() {
  const verifier  = base64urlNoPad(crypto.randomBytes(64));
  const challenge = base64urlNoPad(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState() {
  return base64urlNoPad(crypto.randomBytes(32));
}

// ── JWT claim extraction ─────────────────────────────────────────────────────

function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return {};
  const parts = jwt.split('.');
  if (parts.length < 2) return {};
  try {
    // JWT uses base64url; pad for Buffer.from
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/** Pull chatgpt_account_id out of the nested "https://api.openai.com/auth" claim. */
export function parseAccountIdFromIdToken(idToken) {
  const claims = decodeJwtPayload(idToken);
  const authClaims = claims['https://api.openai.com/auth'] || {};
  return authClaims.chatgpt_account_id || null;
}

/** Best-effort plan type ("plus" | "pro" | "free" | ...) from the access token. */
export function parsePlanTypeFromAccessToken(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  const authClaims = claims['https://api.openai.com/auth'] || {};
  return authClaims.chatgpt_plan_type || null;
}

function computeExpiresAt(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  if (typeof claims.exp === 'number') return claims.exp * 1000;
  return Date.now() + DEFAULT_TTL_MS;
}

// ── Authorize URL ────────────────────────────────────────────────────────────

export function buildAuthorizeUrl({ state, challenge }) {
  const params = new URLSearchParams({
    response_type:              'code',
    client_id:                  CLIENT_ID,
    redirect_uri:               REDIRECT_URI,
    scope:                      SCOPES,
    code_challenge:             challenge,
    code_challenge_method:      'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow:  'true',
    state,
  });
  return `${ISSUER}/oauth/authorize?${params}`;
}

// ── Token endpoint ───────────────────────────────────────────────────────────

/** Exchange an authorization code for tokens. Returns normalized token record. */
export async function exchangeCode({ code, verifier }) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  REDIRECT_URI,
    client_id:     CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('Token response missing access_token');
  return normalizeTokens(json);
}

/** Refresh using the stored refresh_token. Body is JSON per Codex impl. */
export async function refreshTokens(refreshToken) {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_id:     CLIENT_ID,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Token refresh failed (${res.status}): ${text}`);
    err.status = res.status;
    err.body   = text;
    throw err;
  }
  const json = await res.json();
  return normalizeTokens({
    id_token:      json.id_token,
    access_token:  json.access_token,
    refresh_token: json.refresh_token ?? refreshToken,
  });
}

function normalizeTokens({ id_token, access_token, refresh_token }) {
  return {
    id_token,
    access_token,
    refresh_token,
    account_id:   parseAccountIdFromIdToken(id_token),
    plan_type:    parsePlanTypeFromAccessToken(access_token),
    expires_at:   computeExpiresAt(access_token),
    last_refresh: Date.now(),
  };
}

// ── Per-user token file I/O ──────────────────────────────────────────────────

export function tokenPath(userId) {
  return path.join(getUserDir(userId), 'openai-codex-token.json');
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
  fs.writeFileSync(tp, JSON.stringify(token, null, 2));
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
 * Returns { access_token, account_id } ready for an API call,
 * auto-refreshing under a per-user file lock when near expiry.
 */
export async function ensureFreshToken(userId) {
  const tp = tokenPath(userId);
  return withLock(tp, async () => {
    const current = readToken(userId);
    if (!current?.access_token) throw new Error('OpenAI Codex not connected for this user');
    const expiresIn = (current.expires_at ?? 0) - Date.now();
    if (expiresIn > REFRESH_SKEW_MS) {
      return { access_token: current.access_token, account_id: current.account_id };
    }
    if (!current.refresh_token) {
      throw new Error('OpenAI Codex token expired and no refresh_token available; please reconnect.');
    }
    const refreshed = await refreshTokens(current.refresh_token);
    // Preserve account_id from prior token if the refresh response didn't include an id_token.
    if (!refreshed.account_id && current.account_id) refreshed.account_id = current.account_id;
    writeToken(userId, refreshed);
    return { access_token: refreshed.access_token, account_id: refreshed.account_id };
  });
}
