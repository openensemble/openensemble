/**
 * Microsoft OAuth routes — per-user Outlook/Office 365 token management.
 *
 * Routes:
 *   GET  /api/oauth/microsoft/connect?accountId=acct_xxx  — start OAuth flow (Bearer auth)
 *   GET  /api/oauth/microsoft/callback?code=...&state=... — callback from Microsoft
 */

import fs   from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { requireAuth, loadConfig, safeError } from './_helpers.mjs';
import { msTokenPath } from '../lib/ms-graph.mjs';

const BASE_DIR   = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CREDS_FILE = path.join(BASE_DIR, 'microsoft-credentials.json');
const SCOPES = 'https://graph.microsoft.com/Mail.Read offline_access';

// Resolve the redirect URI for this request (see oauth.mjs for rationale).
// The URL must be registered in Azure as a redirect URI for the app.
function getRedirectUri(req) {
  const cfg = loadConfig();
  if (cfg.externalUrl) return `${String(cfg.externalUrl).replace(/\/$/, '')}/api/oauth/microsoft/callback`;
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http';
  const host = req.headers.host || `localhost:${process.env.PORT || 3737}`;
  return `${proto}://${host}/api/oauth/microsoft/callback`;
}

function loadMsCreds() {
  // Prefer config.json; fall back to legacy microsoft-credentials.json
  const cfg = loadConfig();
  if (cfg.msClientId && cfg.msClientSecret) {
    return { client_id: cfg.msClientId, client_secret: cfg.msClientSecret, tenant: cfg.msTenant || 'common' };
  }
  if (fs.existsSync(CREDS_FILE)) {
    const f = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    return { ...f, tenant: f.tenant ?? 'common' };
  }
  return null;
}

// Pending state nonces: nonce → { userId, accountId, expires }
const pendingStates = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v.expires < now) pendingStates.delete(k);
  }
}, 60_000);

function buildAuthUrl(nonce, redirectUri) {
  const creds = loadMsCreds();
  if (!creds) throw new Error('Microsoft credentials not configured. Add your Azure app Client ID and Secret in Settings → Providers.');
  const params = new URLSearchParams({
    client_id:     creds.client_id,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES,
    response_mode: 'query',
    state:         nonce,
  });
  return `https://login.microsoftonline.com/${creds.tenant}/oauth2/v2.0/authorize?${params}`;
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');

  // ── Start OAuth flow ──────────────────────────────────────────────────────
  if (url.pathname === '/api/oauth/microsoft/connect' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const accountId = url.searchParams.get('accountId');
    if (!accountId) { res.writeHead(400); res.end(JSON.stringify({ error: 'accountId required' })); return true; }

    try {
      const nonce = randomBytes(16).toString('hex');
      const redirectUri = getRedirectUri(req);
      pendingStates.set(nonce, { userId, accountId, redirectUri, expires: Date.now() + 10 * 60 * 1000 });
      const authUrl = buildAuthUrl(nonce, redirectUri);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: authUrl }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // ── OAuth callback from Microsoft ─────────────────────────────────────────
  if (url.pathname === '/api/oauth/microsoft/callback' && req.method === 'GET') {
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
    const { userId, accountId, redirectUri } = entry;

    try {
      const creds = loadMsCreds();
      if (!creds) throw new Error('Microsoft credentials not configured');
      const tokenRes = await fetch(`https://login.microsoftonline.com/${creds.tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     creds.client_id,
          client_secret: creds.client_secret,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
          scope:         SCOPES,
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) throw new Error(tokens.error_description ?? tokens.error ?? 'Token exchange failed');
      tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
      fs.writeFileSync(msTokenPath(userId, accountId), JSON.stringify(tokens, null, 2));
      res.writeHead(302, { Location: '/?oauth=success&service=microsoft' });
    } catch (e) {
      console.error('[ms-oauth] callback error:', e);
      res.writeHead(302, { Location: '/?oauth=error&reason=token_exchange_failed' });
    }
    res.end();
    return true;
  }

  return false;
}
