// @ts-check
/**
 * MCP client — connection pool + tool dispatch.
 *
 * Multi-user shape:
 *   - One process per (userId, serverId) pair. Credentials live in each
 *     user's stdio process env, never shared with another user's process.
 *     A misbehaving server can't see another user's tokens because it can't
 *     see another user's process.
 *   - Lazily spawned on first call. An idle timer shuts the process down
 *     after IDLE_MS of no use to reclaim memory; the next call respawns.
 *   - Crash recovery: if the process exits unexpectedly, the pool entry is
 *     cleared. The next caller respawns transparently.
 *
 * Transports supported here:
 *   - stdio (phase 1) — spawn a subprocess, talk JSON-RPC over its
 *     stdin/stdout. Most reference MCP servers ship as stdio.
 *
 * Transports for later phases:
 *   - http / sse — remote MCP servers reachable over the network. The
 *     SDK supports it; we just need to plumb it through getOrCreateClient.
 *
 * NOT handled here (lives in skills/mcp/execute.mjs):
 *   - Mapping from `mcp_<server>_<tool>` namespaced tool name back to the
 *     bare tool name the server expects. The dispatcher splits the prefix
 *     and passes the bare name to callTool.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const IDLE_MS = 5 * 60 * 1000;  // 5 min — close idle servers
// 60s handshake to cover `npx -y` package downloads on first run. The
// previous 15s was tight enough that any first-time install (which downloads
// ~30-100 MB of node_modules for some servers) would spuriously fail the
// warmup. Subsequent calls use the cached npm cache and are nearly instant.
const HANDSHAKE_TIMEOUT_MS = 60 * 1000;

/** @type {Map<string, ConnectionEntry>} */
const _pool = new Map();

/**
 * Per-server connection status, separate from the pool entry so it survives
 * idle-eviction and gives the Settings UI something to render even when no
 * connection is currently held.
 *
 * @typedef {Object} ServerStatus
 * @property {'connecting'|'ready'|'error'|'idle'|'unknown'} state
 * @property {string|null} lastError
 * @property {number|null} lastConnectedAt   epoch ms of last successful connect
 * @property {number|null} toolCount         tool count from last successful listTools
 *
 * @type {Map<string, ServerStatus>}
 */
const _status = new Map();

function setStatus(ownerId, serverId, patch) {
  const key = poolKey(ownerId, serverId);
  const prev = _status.get(key) ?? { state: 'unknown', lastError: null, lastConnectedAt: null, toolCount: null };
  _status.set(key, { ...prev, ...patch });
}

/** Read the cached status for one server. Keyed by user (each user has
 * their own server processes — no sharing). */
export function getServerStatus(ownerId, serverId) {
  return _status.get(poolKey(ownerId, serverId))
    ?? { state: 'unknown', lastError: null, lastConnectedAt: null, toolCount: null };
}

/**
 * @typedef {Object} ServerConfig
 * @property {string} id              short unique id within the user's mcp.json
 * @property {'stdio'|'http'} transport
 * @property {string} [command]       stdio: program to spawn (e.g. "npx")
 * @property {string[]} [args]        stdio: args
 * @property {Record<string,string>} [env]  stdio: env passed to the subprocess
 * @property {string} [url]           http (later)
 * @property {string} [displayName]
 */

/**
 * @typedef {Object} ConnectionEntry
 * @property {import('@modelcontextprotocol/sdk/client/index.js').Client} client
 * @property {import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport
 *           | import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport} transport
 * @property {NodeJS.Timeout|null} idleTimer
 * @property {any[]|null} toolsCache
 * @property {number} lastUsed
 */

function poolKey(ownerId, serverId) {
  return `${ownerId}::${serverId}`;
}

async function spawnClient(ownerId, cfg) {
  let transport;
  if (cfg.transport === 'stdio' || !cfg.transport) {
    if (!cfg.command) throw new Error('stdio MCP server config missing `command`');
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) },
    });
  } else if (cfg.transport === 'http') {
    if (!cfg.url) throw new Error('http MCP server config missing `url`');
    // headers may include auth (Authorization: Bearer ...), API keys, or
    // custom values per server. Stored encrypted in users/<id>/mcp.json.
    const headers = (cfg.headers && typeof cfg.headers === 'object') ? { ...cfg.headers } : {};
    const opts = { requestInit: { headers } };
    // OAuth: when the server config asks for it, hand the SDK an
    // OAuthClientProvider keyed on the OWNER (whose tokens we read/write).
    // The SDK injects Bearer <access_token>, handles 401 → refresh, and
    // on a full re-auth need will call provider.redirectToAuthorization()
    // — but at runtime that's a dead-end (the user isn't here). The
    // /api/mcp/servers/:id/oauth/start route is the only entry point that
    // expects redirectToAuthorization to fire.
    if (cfg.auth === 'oauth') {
      const { OeOAuthProvider } = await import('./mcp-oauth.mjs');
      opts.authProvider = new OeOAuthProvider({
        ownerUserId: ownerId,
        serverId: cfg.id,
        redirectOrigin: cfg.oauthRedirectOrigin || '',
        scope: cfg.oauthScope || '',
      });
    }
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), opts);
  } else {
    throw new Error(`MCP transport "${cfg.transport}" not recognized — use "stdio" or "http"`);
  }
  const client = new Client(
    { name: 'openensemble', version: '1.0.0' },
    { capabilities: {} },
  );
  // Race connect against a timeout. A misconfigured server (wrong command,
  // unreachable URL, slow npx download) otherwise hangs forever.
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`MCP server "${cfg.id}" handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`)),
      HANDSHAKE_TIMEOUT_MS,
    )),
  ]);
  return { client, transport };
}

async function getOrCreateEntry(ownerId, cfg) {
  const key = poolKey(ownerId, cfg.id);
  const existing = _pool.get(key);
  if (existing) {
    bumpIdle(existing);
    return existing;
  }
  setStatus(ownerId, cfg.id, { state: 'connecting', lastError: null });
  let client, transport;
  try {
    ({ client, transport } = await spawnClient(ownerId, cfg));
  } catch (e) {
    setStatus(ownerId, cfg.id, { state: 'error', lastError: e.message });
    throw e;
  }
  setStatus(ownerId, cfg.id, { state: 'ready', lastConnectedAt: Date.now(), lastError: null });
  /** @type {ConnectionEntry} */
  const entry = {
    client, transport, idleTimer: null, toolsCache: null,
    lastUsed: Date.now(),
  };
  bumpIdle(entry);
  _pool.set(key, entry);
  transport.onclose = () => {
    const cur = _pool.get(key);
    if (cur === entry) {
      if (cur.idleTimer) clearTimeout(cur.idleTimer);
      _pool.delete(key);
      setStatus(ownerId, cfg.id, { state: 'idle' });
    }
  };
  return entry;
}

function bumpIdle(entry) {
  entry.lastUsed = Date.now();
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(async () => {
    try { await entry.client.close(); } catch {}
  }, IDLE_MS);
}

/**
 * List tools exposed by the server, cached for the lifetime of this
 * connection. Invalidate by closing the connection (which the idle timer
 * does automatically).
 *
 * @returns {Promise<Array<{name: string, description?: string, inputSchema?: any}>>}
 */
export async function listTools(ownerId, cfg) {
  const entry = await getOrCreateEntry(ownerId, cfg);
  if (entry.toolsCache) return entry.toolsCache;
  try {
    const res = await entry.client.listTools();
    entry.toolsCache = res.tools ?? [];
    setStatus(ownerId, cfg.id, { state: 'ready', toolCount: entry.toolsCache.length });
    return entry.toolsCache;
  } catch (e) {
    setStatus(ownerId, cfg.id, { state: 'error', lastError: e.message });
    throw e;
  }
}

/**
 * Invoke an MCP tool. The bare `toolName` is the name the server knows —
 * call sites that have the namespaced `mcp_<server>_<tool>` name must strip
 * the prefix before calling this.
 *
 * @returns {Promise<any>}
 */
export async function callTool(ownerId, cfg, toolName, args) {
  const entry = await getOrCreateEntry(ownerId, cfg);
  try {
    const result = await entry.client.callTool({ name: toolName, arguments: args });
    setStatus(ownerId, cfg.id, { state: 'ready' });
    return result;
  } catch (e) {
    setStatus(ownerId, cfg.id, { state: 'error', lastError: e.message });
    throw e;
  }
}

/**
 * Tear down all pooled connections — call on server shutdown so subprocesses
 * don't linger.
 */
export async function shutdownAll() {
  for (const [, entry] of _pool) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { await entry.client.close(); } catch {}
  }
  _pool.clear();
}

/**
 * Close one (user, server) connection so the next call respawns fresh.
 * Used by the per-server Reconnect button. Status flips to 'idle' via
 * the transport.onclose hook, then back to 'connecting'/'ready' when the
 * next listTools/callTool fires. Safe to call when no entry exists —
 * just a no-op.
 */
export async function disconnect(ownerId, serverId) {
  const key = poolKey(ownerId, serverId);
  const entry = _pool.get(key);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  try { await entry.client.close(); } catch {}
  _pool.delete(key);
}

/** Debugging surface — currently-live pool entries. */
export function poolStats() {
  const now = Date.now();
  return Array.from(_pool.entries()).map(([k, v]) => ({
    key: k,
    idleMs: now - v.lastUsed,
    toolsCached: v.toolsCache?.length ?? 0,
  }));
}
