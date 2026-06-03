/**
 * MCP server management API.
 *
 *   GET    /api/mcp/servers                       — list, with live status
 *   POST   /api/mcp/servers                       — add a server
 *   DELETE /api/mcp/servers/:id                   — remove
 *   POST   /api/mcp/servers/:id/assign            — add an agent_id
 *   POST   /api/mcp/servers/:id/unassign          — remove an agent_id
 *   POST   /api/mcp/refresh                       — re-read + reconnect
 *
 * Mutations require non-child accounts (same rationale as the mcp-admin
 * skill's MUTATION_TOOLS gate — MCP servers spawn subprocesses with user
 * credentials in env). Reads are open to any authenticated session.
 */

import { requireAuth, readBody, getUserRole, safeError } from './_helpers.mjs';
import {
  getServersForUser, addServer, removeServer, assignServer, unassignServer,
  updateServer,
} from '../lib/mcp-config.mjs';
import { refreshUserMcpTools, reconnectServer } from '../lib/mcp-tools.mjs';
import { getServerStatus } from '../lib/mcp-client.mjs';
import { getCatalog } from '../lib/mcp-catalog.mjs';
import { OeOAuthProvider, registerPendingState, consumePendingState } from '../lib/mcp-oauth.mjs';
import { auth as runOAuth } from '@modelcontextprotocol/sdk/client/auth.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function redactEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const out = {};
  for (const k of Object.keys(env)) out[k] = '<redacted>';
  return out;
}

function summarize(s, status) {
  return {
    id: s.id,
    displayName: s.displayName ?? s.id,
    transport: s.transport ?? 'stdio',
    command: s.command,
    args: s.args ?? [],
    env: redactEnv(s.env),
    url: s.url,
    headers: redactEnv(s.headers),
    auth: s.auth,
    oauthScope: s.oauthScope,
    assignedToAgents: s.assignedToAgents ?? [],
    status: status?.state ?? 'unknown',
    lastError: status?.lastError ?? null,
    toolCount: status?.toolCount ?? null,
    lastConnectedAt: status?.lastConnectedAt ?? null,
  };
}

function requireAdult(req, res, userId) {
  if (getUserRole(userId) === 'child') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Child accounts cannot manage MCP servers.' }));
    return false;
  }
  return true;
}

/** Compute the origin (scheme://host:port) the BROWSER is talking to, so
 * the OAuth redirect_uri matches the user's session. Honors X-Forwarded-*
 * headers when set by a reverse proxy. */
function browserOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http')).toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').toString().split(',')[0].trim();
  return `${proto}://${host}`;
}

export async function handle(req, res) {
  // GET /api/mcp/catalog — curated server templates
  if (req.url === '/api/mcp/catalog' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ catalog: getCatalog() }));
    return true;
  }

  // GET /api/mcp/servers — list this user's own servers with status.
  if (req.url === '/api/mcp/servers' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const servers = getServersForUser(userId)
      .map(s => summarize(s, getServerStatus(userId, s.id)));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ servers }));
    return true;
  }

  // POST /api/mcp/servers — add
  if (req.url === '/api/mcp/servers' && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!requireAdult(req, res, userId)) return true;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (!body?.id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'id is required' }));
      return true;
    }
    const transport = body.transport ?? 'stdio';
    if (transport === 'stdio' && !body.command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stdio transport requires `command`' }));
      return true;
    }
    if (transport === 'http' && !body.url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'http transport requires `url`' }));
      return true;
    }
    try {
      addServer(userId, {
        id: body.id,
        displayName: body.displayName ?? body.id,
        transport,
        // stdio fields
        command: body.command,
        args: Array.isArray(body.args) ? body.args : [],
        env: (body.env && typeof body.env === 'object') ? body.env : {},
        // http fields
        url: body.url,
        headers: (body.headers && typeof body.headers === 'object') ? body.headers : {},
        // http+oauth opt-in
        auth: body.auth === 'oauth' ? 'oauth' : undefined,
        oauthScope: typeof body.oauthScope === 'string' ? body.oauthScope : undefined,
        assignedToAgents: Array.isArray(body.assignedToAgents) ? body.assignedToAgents : [],
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
    // Fire-and-forget refresh — the response returns immediately. The UI
    // polls /api/mcp/servers to watch status flip connecting → ready.
    refreshUserMcpTools(userId).catch(e => console.warn('[mcp] refresh after add failed:', e.message));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: body.id }));
    return true;
  }

  // PUT /api/mcp/servers/:id — edit an existing server in place.
  // Body shape mirrors the POST create form but only fields the caller
  // sends are updated. After save, reconnect so the new config takes
  // effect — old subprocess/connection is replaced.
  const putMatch = req.url.match(/^\/api\/mcp\/servers\/([^/]+)$/);
  if (putMatch && req.method === 'PUT') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!requireAdult(req, res, userId)) return true;
    const serverId = decodeURIComponent(putMatch[1]);
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' })); return true;
    }
    try {
      updateServer(userId, serverId, body ?? {});
    } catch (e) {
      const code = /not found/i.test(e.message) ? 404 : 400;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message })); return true;
    }
    // Reconnect — the patch likely changed how we reach the server.
    reconnectServer(userId, serverId).catch(e => console.warn('[mcp] reconnect after edit failed:', e.message));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // DELETE /api/mcp/servers/:id
  const delMatch = req.url.match(/^\/api\/mcp\/servers\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!requireAdult(req, res, userId)) return true;
    const id = decodeURIComponent(delMatch[1]);
    const removed = removeServer(userId, id);
    if (removed) {
      refreshUserMcpTools(userId).catch(e => console.warn('[mcp] refresh after remove failed:', e.message));
    }
    res.writeHead(removed ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(removed ? { ok: true } : { error: 'not found' }));
    return true;
  }

  // POST /api/mcp/servers/:id/assign + /unassign
  const assignMatch = req.url.match(/^\/api\/mcp\/servers\/([^/]+)\/(assign|unassign)$/);
  if (assignMatch && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!requireAdult(req, res, userId)) return true;
    const serverId = decodeURIComponent(assignMatch[1]);
    const action = assignMatch[2];
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (!body?.agent_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent_id is required' }));
      return true;
    }
    try {
      if (action === 'assign') assignServer(userId, serverId, body.agent_id);
      else                     unassignServer(userId, serverId, body.agent_id);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
    refreshUserMcpTools(userId).catch(e => console.warn(`[mcp] refresh after ${action} failed:`, e.message));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // POST /api/mcp/servers/:id/oauth/start — initiates an OAuth flow for
  // a server configured with auth='oauth'. Returns { authUrl } for the UI
  // to open in a popup. Only the owner of the server may initiate.
  const oauthStartMatch = req.url.match(/^\/api\/mcp\/servers\/([^/]+)\/oauth\/start$/);
  if (oauthStartMatch && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!requireAdult(req, res, userId)) return true;
    const serverId = decodeURIComponent(oauthStartMatch[1]);
    const own = getServersForUser(userId).find(s => s.id === serverId);
    if (!own) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'You don\'t own a server with that id.' })); return true;
    }
    if (own.transport !== 'http' || own.auth !== 'oauth') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OAuth is only supported on http-transport servers with auth=oauth.' })); return true;
    }
    if (!own.url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server has no url configured.' })); return true;
    }
    const provider = new OeOAuthProvider({
      ownerUserId: userId,
      serverId,
      redirectOrigin: browserOrigin(req),
      scope: own.oauthScope || '',
    });
    try {
      // First call discovers metadata, registers client if needed, generates
      // PKCE, and calls provider.redirectToAuthorization with the auth URL.
      const result = await runOAuth(provider, { serverUrl: own.url });
      if (result === 'AUTHORIZED') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, alreadyAuthorized: true })); return true;
      }
      if (!provider.lastAuthorizationUrl) {
        throw new Error('OAuth discovery returned REDIRECT but no authorization URL was captured');
      }
      // Pull the state token out of the URL and stash a mapping so the
      // callback knows which (user, server) is completing the flow.
      const authUrl = provider.lastAuthorizationUrl;
      const state = authUrl.searchParams.get('state');
      if (!state) throw new Error('Authorization URL missing required state parameter');
      registerPendingState(state, { ownerUserId: userId, serverId, serverUrl: own.url, redirectOrigin: browserOrigin(req) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authUrl: authUrl.toString() }));
    } catch (e) {
      console.warn(`[mcp-oauth] start failed for ${serverId}:`, e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // GET /api/mcp/oauth/callback — landing for the OAuth provider's redirect.
  // The user's browser arrives here with ?code= and &state=. We look up
  // the pending-state entry, complete the token exchange, and render a
  // tiny "you can close this window" page (or postMessage back to opener).
  if (req.url.startsWith('/api/mcp/oauth/callback') && req.method === 'GET') {
    // Auth-required so a randomly-discovered callback URL can't be abused.
    const userId = requireAuth(req, res); if (!userId) return true;
    const u = new URL(req.url, browserOrigin(req));
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const err = u.searchParams.get('error');
    const failHtml = (msg) => `<!doctype html><meta charset=utf-8><title>Authorization failed</title>
      <body style="font-family:sans-serif;padding:30px;max-width:600px">
      <h2>Authorization failed</h2><p style="color:#c33">${escapeHtml(msg)}</p>
      <p>You can close this window and try again from Settings → MCP.</p></body>`;
    if (err) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(failHtml(`${err}: ${u.searchParams.get('error_description') ?? ''}`)); return true; }
    if (!code || !state) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(failHtml('Missing code or state.')); return true; }
    const pending = consumePendingState(state);
    if (!pending) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(failHtml('State expired or unknown — start the flow again.')); return true; }
    if (pending.ownerUserId !== userId) { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end(failHtml('The authenticated user does not match the user that started this flow.')); return true; }
    try {
      const provider = new OeOAuthProvider({
        ownerUserId: pending.ownerUserId,
        serverId: pending.serverId,
        redirectOrigin: pending.redirectOrigin,
      });
      const result = await runOAuth(provider, { serverUrl: pending.serverUrl, authorizationCode: code });
      if (result !== 'AUTHORIZED') throw new Error(`unexpected auth result: ${result}`);
    } catch (e) {
      console.warn(`[mcp-oauth] callback failed for ${pending.serverId}:`, e.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(failHtml(`Token exchange failed: ${e.message}`));
      return true;
    }
    // Re-warm so the agent's toolset reflects the new auth state.
    refreshUserMcpTools(pending.ownerUserId).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset=utf-8><title>Authorized</title>
      <body style="font-family:sans-serif;padding:30px;max-width:600px;text-align:center">
      <h2>✓ Authorized</h2>
      <p>You can close this window. Your MCP server is connected and the tools are now live.</p>
      <script>setTimeout(() => { try { window.opener?.postMessage({ type: 'mcp-oauth-done', serverId: ${JSON.stringify(pending.serverId)} }, '*'); } catch {} window.close(); }, 600);</script>
      </body>`);
    return true;
  }

  // POST /api/mcp/servers/:id/reconnect — close + respawn one server.
  // Used by the per-card Reconnect button after the user edits a server's
  // command/url or fixes an env var.
  const reconnectMatch = req.url.match(/^\/api\/mcp\/servers\/([^/]+)\/reconnect$/);
  if (reconnectMatch && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!requireAdult(req, res, userId)) return true;
    const serverId = decodeURIComponent(reconnectMatch[1]);
    try {
      await reconnectServer(userId, serverId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      const status = /not found/i.test(e.message) ? 404 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // POST /api/mcp/refresh
  if (req.url === '/api/mcp/refresh' && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!requireAdult(req, res, userId)) return true;
    try {
      await refreshUserMcpTools(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  return false;
}
