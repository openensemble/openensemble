/**
 * OpenAI Codex (ChatGPT) OAuth routes — per-user token management.
 *
 * OpenAI's Codex CLIENT_ID is pre-registered with `http://localhost:1455/auth/callback`
 * as its only allowed redirect URI. We therefore run a tiny ephemeral HTTP listener
 * on port 1455 that captures the authorization code, exchanges it for tokens,
 * writes them under the correct userId, then bounces the browser back to the
 * main app at :3737.
 *
 * Main-server routes (port 3737):
 *   GET    /api/oauth/openai/connect   — start OAuth flow (Bearer auth)
 *   GET    /api/oauth/openai/status    — connection status for current user
 *   DELETE /api/oauth/openai           — disconnect (delete token)
 */

import http from 'http';
import { requireAuth, readBody } from './_helpers.mjs';
import {
  generatePkce, generateState, buildAuthorizeUrl, exchangeCode,
  writeToken, readToken, deleteToken, isConnected,
  CALLBACK_PORT, CALLBACK_PATH,
} from '../lib/openai-codex-auth.mjs';

const MAIN_APP_URL = 'http://localhost:3737';
const STATE_TTL_MS = 10 * 60 * 1000;

// Pending state: state → { userId, verifier, expires }
const pendingStates = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates) if (v.expires < now) pendingStates.delete(k);
}, 60_000).unref?.();

// ── Ephemeral :1455 callback listener ────────────────────────────────────────
// Single shared instance; started lazily on the first /connect, idle forever
// after that (closes itself if it fails to bind — e.g., port collision).

let callbackServer = null;
let callbackStarting = null;

function startCallbackServer() {
  if (callbackServer) return Promise.resolve();
  if (callbackStarting) return callbackStarting;
  callbackStarting = new Promise((resolve, reject) => {
    const srv = http.createServer(handleCallbackRequest);
    srv.once('error', err => {
      callbackStarting = null;
      if (err.code === 'EADDRINUSE') {
        console.warn(`[openai-oauth] port ${CALLBACK_PORT} is already in use — assuming another instance is serving the callback`);
        resolve(); // Treat as soft-success so /connect doesn't fail; the other listener will handle it if it's ours.
      } else {
        reject(err);
      }
    });
    srv.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log(`[openai-oauth] callback listener bound on 127.0.0.1:${CALLBACK_PORT}`);
      callbackServer = srv;
      callbackStarting = null;
      resolve();
    });
  });
  return callbackStarting;
}

function htmlResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function redirectResponse(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function handleCallbackRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
  if (url.pathname === '/cancel') {
    htmlResponse(res, 200, '<html><body>Cancelled. You can close this tab.</body></html>');
    return;
  }
  if (url.pathname !== CALLBACK_PATH) {
    htmlResponse(res, 404, 'Not found');
    return;
  }

  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    redirectResponse(res, `${MAIN_APP_URL}/?oauth=error&reason=${encodeURIComponent(error)}`);
    return;
  }

  const entry = state && pendingStates.get(state);
  if (!entry || entry.expires < Date.now()) {
    redirectResponse(res, `${MAIN_APP_URL}/?oauth=error&reason=expired`);
    return;
  }
  pendingStates.delete(state);

  try {
    const token = await exchangeCode({ code, verifier: entry.verifier });
    writeToken(entry.userId, token);
    console.log(`[openai-oauth] stored token for user=${entry.userId} account=${token.account_id} plan=${token.plan_type}`);
    redirectResponse(res, `${MAIN_APP_URL}/?oauth=success&service=openai-codex`);
  } catch (e) {
    console.error('[openai-oauth] callback error:', e.message);
    redirectResponse(res, `${MAIN_APP_URL}/?oauth=error&reason=token_exchange_failed`);
  }
}

// ── Main-server routes (port 3737) ───────────────────────────────────────────

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/oauth/openai/connect' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      await startCallbackServer();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to bind callback listener on :${CALLBACK_PORT}: ${e.message}` }));
      return true;
    }
    const state = generateState();
    const { verifier, challenge } = generatePkce();
    pendingStates.set(state, { userId, verifier, expires: Date.now() + STATE_TTL_MS });
    const authUrl = buildAuthorizeUrl({ state, challenge });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: authUrl }));
    return true;
  }

  if (url.pathname === '/api/oauth/openai/status' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const token = readToken(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: isConnected(userId),
      accountId: token?.account_id ?? null,
      plan:      token?.plan_type ?? null,
      expiresAt: token?.expires_at ?? null,
    }));
    return true;
  }

  // ── Paste-callback-URL fallback ────────────────────────────────────────────
  // When the browser is on a different machine than the server (LXC,
  // headless VPS, etc.), OpenAI's hardcoded `http://localhost:1455` redirect
  // dumps the auth code into the user's own computer — not ours. They copy
  // the full callback URL (or just the ?code=...&state=... query) from the
  // failed page's address bar and paste it here so we can complete the
  // exchange server-side.
  if (url.pathname === '/api/oauth/openai/complete' && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return true; }

    // Accept either a full URL, just the query string, or explicit { code, state }.
    let code = body.code;
    let state = body.state;
    if (!code && body.url) {
      try {
        const s = String(body.url).trim();
        const qs = s.includes('?') ? s.slice(s.indexOf('?') + 1) : s.startsWith('code=') || s.includes('&code=') ? s : '';
        const p = new URLSearchParams(qs);
        code = p.get('code');
        state = p.get('state');
      } catch {}
    }
    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Paste the full callback URL (must include code= and state=)' }));
      return true;
    }

    const entry = pendingStates.get(state);
    if (!entry || entry.expires < Date.now()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This authorization request has expired. Click Connect again and paste the new URL within 10 minutes.' }));
      return true;
    }
    if (entry.userId !== userId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This authorization belongs to a different user.' }));
      return true;
    }

    try {
      const token = await exchangeCode({ code, verifier: entry.verifier });
      pendingStates.delete(state);
      writeToken(entry.userId, token);
      console.log(`[openai-oauth] stored token (paste) for user=${entry.userId} account=${token.account_id} plan=${token.plan_type}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plan: token.plan_type, accountId: token.account_id }));
    } catch (e) {
      // Leave state intact so the user can retry with a corrected URL without
      // having to hit Connect again. It self-expires after STATE_TTL_MS.
      console.error('[openai-oauth] paste-exchange error:', e?.message || e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Token exchange failed: ${e?.message || e}` }));
    }
    return true;
  }

  if (url.pathname === '/api/oauth/openai' && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const removed = deleteToken(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ disconnected: removed }));
    return true;
  }

  return false;
}
