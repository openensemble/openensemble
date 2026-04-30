/**
 * Microsoft OAuth routes — per-user Outlook/Office 365 token management.
 *
 * Routes:
 *   GET  /api/oauth/microsoft/connect?accountId=acct_xxx  — start OAuth flow (Bearer auth)
 *   GET  /api/oauth/microsoft/callback?code=...&state=... — callback from Microsoft
 */

import fs   from 'fs';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { requireAuth, loadConfig, safeError } from './_helpers.mjs';
import { msTokenPath } from '../lib/ms-graph.mjs';

const BASE_DIR   = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CREDS_FILE = path.join(BASE_DIR, 'microsoft-credentials.json');
// Mail.ReadWrite covers list/read/delete/mark; Mail.Send covers compose+reply.
// Mail.ReadWrite is a superset of Mail.Read so we drop the latter.
const SCOPES = 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access';

// OE's built-in multi-tenant Azure app (public client, no secret).
// Registered at portal.azure.com under the project owner's account, marked
// "Allow public client flows" + redirect URI http://localhost. Any Microsoft
// user (commercial 365, GoDaddy 365, personal MSA) can OAuth without their
// own Azure registration. Authentication uses PKCE — no client secret is
// ever sent or required to be stored on disk.
const BUILTIN_MS_CLIENT_ID = '4aaf644d-82b3-444f-94d3-dc106a7a59cf';

// Microsoft's loopback rule lets http://localhost:<any-port> match a single
// registered http://localhost redirect URI. Anything non-loopback (a LAN IP,
// or a public host via cfg.externalUrl) does NOT match — those installs must
// either access OE via localhost or register their own Azure app.
function isLoopback(redirectUri) {
  try {
    const u = new URL(redirectUri);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  } catch { return false; }
}

// Resolve the redirect URI for this request (see oauth.mjs for rationale).
// The URL must be registered in Azure as a redirect URI for the app.
function getRedirectUri(req) {
  const cfg = loadConfig();
  if (cfg.externalUrl) return `${String(cfg.externalUrl).replace(/\/$/, '')}/api/oauth/microsoft/callback`;
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http';
  const host = req.headers.host || `localhost:${process.env.PORT || 3737}`;
  return `${proto}://${host}/api/oauth/microsoft/callback`;
}

function loadMsCreds(redirectUri) {
  // Prefer user-configured Azure app (confidential client, has secret). Falls
  // back to OE's built-in multi-tenant public client when no user creds are
  // configured AND the redirect URI is loopback (Microsoft's localhost rule).
  const cfg = loadConfig();
  if (cfg.msClientId && cfg.msClientSecret) {
    return { client_id: cfg.msClientId, client_secret: cfg.msClientSecret, tenant: cfg.msTenant || 'common', builtin: false };
  }
  if (fs.existsSync(CREDS_FILE)) {
    const f = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    return { ...f, tenant: f.tenant ?? 'common', builtin: false };
  }
  // No user creds — use built-in if redirect is loopback, otherwise null
  // (caller surfaces a clear error).
  if (redirectUri && isLoopback(redirectUri)) {
    return { client_id: BUILTIN_MS_CLIENT_ID, client_secret: null, tenant: 'common', builtin: true };
  }
  return null;
}

function makePkce() {
  // 32 random bytes → 43-char base64url string (no padding). Microsoft's spec
  // accepts 43-128 chars from the unreserved character set; base64url fits.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Pending state nonces: nonce → { userId, accountId, expires }
const pendingStates = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v.expires < now) pendingStates.delete(k);
  }
}, 60_000);

function buildAuthUrl(creds, nonce, redirectUri, codeChallenge) {
  const params = new URLSearchParams({
    client_id:     creds.client_id,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES,
    response_mode: 'query',
    state:         nonce,
  });
  if (creds.builtin) {
    // PKCE for the public-client built-in path (no secret available).
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
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
      const creds = loadMsCreds(redirectUri);
      if (!creds) {
        throw new Error(
          'Microsoft OAuth not configured. To use OpenEnsemble\'s built-in app, ' +
          'access OE via http://localhost:<port>. For LAN-IP or external access, ' +
          'register your own Azure app in Settings → Providers → "Configure credentials".'
        );
      }
      const { verifier, challenge } = makePkce();
      pendingStates.set(nonce, {
        userId, accountId, redirectUri,
        clientId: creds.client_id,
        builtin:  creds.builtin,
        tenant:   creds.tenant,
        codeVerifier: verifier,
        expires: Date.now() + 10 * 60 * 1000,
      });
      const authUrl = buildAuthUrl(creds, nonce, redirectUri, challenge);
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
    const { userId, accountId, redirectUri, clientId, builtin, tenant, codeVerifier } = entry;

    try {
      // Build token request — PKCE (code_verifier, no secret) for the built-in
      // public client; classic client-secret auth for user-configured apps.
      const body = new URLSearchParams({
        code,
        client_id:     clientId,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
        scope:         SCOPES,
      });
      if (builtin) {
        body.set('code_verifier', codeVerifier);
      } else {
        const creds = loadMsCreds(redirectUri);
        if (!creds || !creds.client_secret) throw new Error('User-configured Microsoft credentials missing on callback');
        body.set('client_secret', creds.client_secret);
      }
      const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) throw new Error(tokens.error_description ?? tokens.error ?? 'Token exchange failed');
      tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
      // Persist auth metadata so the refresh path can pick the right strategy
      // (PKCE-public vs secret-confidential) without re-resolving creds, which
      // can drift if the user later configures their own app or vice versa.
      tokens.client_id = clientId;
      tokens.tenant    = tenant;
      tokens.builtin   = !!builtin;
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
