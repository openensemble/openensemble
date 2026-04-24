/**
 * Google OAuth routes — per-user Gmail and Google Calendar token management.
 *
 * Routes:
 *   GET  /api/oauth/google/connect?service=gmail|gcal  — start OAuth flow (Bearer auth)
 *   GET  /api/oauth/google/go?state=NONCE              — browser redirect to Google (stateful, no auth needed)
 *   GET  /api/oauth/google/callback?code=...&state=... — callback from Google
 *   GET  /api/oauth/status                             — connection status for current user
 *   DELETE /api/oauth/google?service=gmail|gcal        — disconnect (delete token)
 */

import fs   from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { requireAuth, readBody, getUserDir, loadConfig } from './_helpers.mjs';
import { seedGmailAccount } from './email-accounts.mjs';
import { ensureFreshToken, resolveTokenPath, getClientCredentials, CREDS_PATH, GOOGLE_AUTH_BASE_DIR as BASE_DIR } from '../lib/google-auth.mjs';

// Resolve the redirect URI for this request. Preference order:
//   1. config.json `externalUrl` (e.g. "https://oe.example.com") — for reverse-proxy deployments
//   2. request Host + X-Forwarded-Proto — auto-detect when behind a proxy that sets them
//   3. fallback to http://localhost:PORT for local-only installs
// Whichever URL is returned MUST be registered in Google Cloud Console as an
// authorized redirect URI for the OAuth client. Google rejects mismatches.
function getRedirectUri(req) {
  const cfg = loadConfig();
  if (cfg.externalUrl) return `${String(cfg.externalUrl).replace(/\/$/, '')}/api/oauth/google/callback`;
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http';
  const host = req.headers.host || `localhost:${process.env.PORT || 3737}`;
  return `${proto}://${host}/api/oauth/google/callback`;
}

const SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
  gcal:  'https://www.googleapis.com/auth/calendar',
};

// Pending state nonces: nonce → { userId, service, expires }
const pendingStates = new Map();

// Clean up expired states periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v.expires < now) pendingStates.delete(k);
  }
}, 60_000);

/** Build the Google authorization URL for the given nonce/state. */
function buildAuthUrl(nonce, service, redirectUri) {
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  } catch (e) {
    // Missing or malformed creds file — surface a clean error so the route
    // handler can return a 500 instead of crashing the server.
    const msg = e?.code === 'ENOENT'
      ? `Google OAuth is not configured on this server: ${CREDS_PATH} is missing. Upload your OAuth client credentials JSON from Google Cloud Console.`
      : `Failed to read ${CREDS_PATH}: ${e?.message || e}`;
    const err = new Error(msg);
    err.userFacing = true;
    throw err;
  }
  const c = creds.installed || creds.web;
  const params = new URLSearchParams({
    client_id:     c.client_id,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES[service],
    access_type:   'offline',
    prompt:        'consent',
    state:         nonce,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function tokenPath(userId, service, accountId) {
  const dir = getUserDir(userId);
  const base = service === 'gcal' ? 'gcal-token' : 'gmail-token';
  if (accountId) return path.join(dir, `${base}-${accountId}.json`);
  return path.join(dir, `${base}.json`);
}

function isConnected(userId, service) {
  return fs.existsSync(tokenPath(userId, service));
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');

  // ── Start OAuth flow (API call from settings UI) ──────────────────────────
  if (url.pathname === '/api/oauth/google/connect' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const service = url.searchParams.get('service');
    if (!SCOPES[service]) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid service' })); return true; }
    const accountId = url.searchParams.get('accountId') || null;
    const nonce = randomBytes(16).toString('hex');
    const redirectUri = getRedirectUri(req);
    // Store the redirect URI with the state — Google verifies that the URI used
    // at the /token exchange matches the one used at /auth, so we must reuse
    // exactly the same URI even if the request arrives on a different origin.
    pendingStates.set(nonce, { userId, service, accountId, redirectUri, expires: Date.now() + 10 * 60 * 1000 });
    let authUrl;
    try {
      authUrl = buildAuthUrl(nonce, service, redirectUri);
    } catch (e) {
      console.error('[oauth] connect failed:', e?.message || e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e?.userFacing ? e.message : 'Failed to start OAuth flow' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: authUrl }));
    return true;
  }

  // ── Browser redirect to Google (used for chat-generated links) ──────────
  if (url.pathname === '/api/oauth/google/go' && req.method === 'GET') {
    const nonce = url.searchParams.get('state');
    const entry = nonce && pendingStates.get(nonce);
    if (!entry || entry.expires < Date.now()) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>This link has expired. Please request a new one.</h2></body></html>');
      return true;
    }
    // Redirect browser directly to Google
    let authUrl;
    try {
      authUrl = buildAuthUrl(nonce, entry.service, entry.redirectUri);
    } catch (e) {
      console.error('[oauth] go failed:', e?.message || e);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h2>OAuth not configured</h2><p>${e?.userFacing ? e.message : 'Server error'}</p></body></html>`);
      return true;
    }
    res.writeHead(302, { Location: authUrl });
    res.end();
    return true;
  }

  // ── OAuth callback from Google ────────────────────────────────────────────
  if (url.pathname === '/api/oauth/google/callback' && req.method === 'GET') {
    const code  = url.searchParams.get('code');
    const nonce = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(302, { Location: `/?oauth=error&reason=${encodeURIComponent(error)}` });
      res.end();
      return true;
    }

    const entry = nonce && pendingStates.get(nonce);
    if (!entry || entry.expires < Date.now()) {
      res.writeHead(302, { Location: '/?oauth=error&reason=expired' });
      res.end();
      return true;
    }

    pendingStates.delete(nonce);
    const { userId, service, accountId, redirectUri } = entry;

    try {
      const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
      const c = creds.installed || creds.web;
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     c.client_id,
          client_secret: c.client_secret,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) throw new Error(tokens.error_description ?? 'Token exchange failed');
      tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
      fs.writeFileSync(tokenPath(userId, service, accountId), JSON.stringify(tokens, null, 2));
      if (service === 'gmail') { try { await seedGmailAccount(userId, accountId); } catch (_) {} }
      res.writeHead(302, { Location: `/?oauth=success&service=${service}` });
    } catch (e) {
      console.error('[oauth] callback error:', e);
      res.writeHead(302, { Location: '/?oauth=error&reason=token_exchange_failed' });
    }
    res.end();
    return true;
  }

  // ── Connection status ─────────────────────────────────────────────────────
  if (url.pathname === '/api/oauth/status' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    // Check per-account Gmail token health
    const gmailHealth = {};
    try {
      const accountsPath = path.join(getUserDir(userId), 'email-accounts.json');
      if (fs.existsSync(accountsPath)) {
        const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
        for (const a of accounts.filter(a => a.provider === 'gmail')) {
          const tp = tokenPath(userId, 'gmail', a.id);
          if (!fs.existsSync(tp)) { gmailHealth[a.id] = 'missing'; continue; }
          try {
            const tokens = JSON.parse(fs.readFileSync(tp, 'utf8'));
            if (!tokens.refresh_token) { gmailHealth[a.id] = 'no_refresh'; continue; }
            await ensureFreshToken(tp);
            gmailHealth[a.id] = 'ok';
          } catch { gmailHealth[a.id] = 'error'; }
        }
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      gmail: isConnected(userId, 'gmail'),
      gcal:  isConnected(userId, 'gcal'),
      gmailHealth,
    }));
    return true;
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  if (url.pathname === '/api/oauth/google' && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const service = url.searchParams.get('service');
    if (!SCOPES[service]) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid service' })); return true; }
    const tp = tokenPath(userId, service);
    if (fs.existsSync(tp)) fs.unlinkSync(tp);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ disconnected: true, service }));
    return true;
  }

  return false;
}
