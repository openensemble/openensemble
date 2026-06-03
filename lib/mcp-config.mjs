// @ts-check
/**
 * MCP server registry — per-user storage and lookup.
 *
 * Storage shape, on disk:
 *   users/<id>/mcp.json :: { servers: Array<ServerEntry> }
 *
 * @typedef {Object} ServerEntry
 * @property {string} id                  unique within this user's mcp.json
 * @property {string} [displayName]
 * @property {'stdio'|'http'} transport
 * @property {string} [command]           stdio: e.g. "npx"
 * @property {string[]} [args]            stdio: e.g. ["-y","@modelcontextprotocol/server-everything"]
 * @property {Record<string,string>} [env]      stdio: subprocess env
 * @property {string} [url]               http: server endpoint URL
 * @property {Record<string,string>} [headers]  http: request headers (auth, custom — encrypted at rest)
 * @property {'oauth'} [auth]             http: opt-in OAuth flow (vs static-header auth via `headers`)
 * @property {string} [oauthScope]        http+oauth: requested scope string
 * @property {string[]} [assignedToAgents] agent ids that get this server's tools merged into their toolset
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { readEncryptedJsonFile, writeEncryptedJsonFile } from './encrypted-file.mjs';

function userMcpPath(userId) {
  return path.join(USERS_DIR, userId, 'mcp.json');
}


/**
 * Load the user's MCP config. Returns the empty shape when the file
 * doesn't exist yet (most users won't have one).
 *
 * Encryption: mcp.json may contain API tokens in the `env` field of each
 * server (e.g. GITHUB_PERSONAL_ACCESS_TOKEN). readEncryptedJsonFile reads
 * both the encrypted envelope shape and legacy plaintext JSON unchanged,
 * so old files keep working until their next write — at which point they
 * get rewritten as the envelope by writeEncryptedJsonFile.
 *
 * @returns {{ servers: ServerEntry[] }}
 */
export function loadUserMcp(userId) {
  if (!userId || userId === 'default') return { servers: [] };
  const p = userMcpPath(userId);
  if (!fs.existsSync(p)) return { servers: [] };
  try {
    const data = readEncryptedJsonFile(p);
    return { servers: Array.isArray(data?.servers) ? data.servers : [] };
  } catch (e) {
    console.warn('[mcp-config] read failed:', e.message);
    return { servers: [] };
  }
}

/** All servers the user has registered. */
export function getServersForUser(userId) {
  return loadUserMcp(userId).servers;
}

/** Servers whose assignedToAgents list includes this agent id. */
export function getServersAssignedToAgent(userId, agentId) {
  if (!userId || !agentId) return [];
  return loadUserMcp(userId).servers.filter(
    s => Array.isArray(s.assignedToAgents) && s.assignedToAgents.includes(agentId)
  );
}

/** Look up a single server by id in this user's mcp.json. Returns null
 * if missing. MCP servers are per-user — no cross-user sharing. */
export function getServerById(userId, serverId) {
  return loadUserMcp(userId).servers.find(s => s.id === serverId) ?? null;
}

function writeUserMcp(userId, data) {
  const p = userMcpPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 0o600 so the file is only readable by the OE service user, defense
  // in depth alongside the at-rest encryption envelope.
  writeEncryptedJsonFile(p, data, { mode: 0o600 });
}

/** Add a server. Throws on id collision (caller should pick a unique id). */
export function addServer(userId, entry) {
  if (!userId) throw new Error('userId required');
  if (!entry?.id) throw new Error('server entry missing id');
  if (entry.id.includes('__')) throw new Error('server id may not contain "__" (reserved as namespace separator)');
  const data = loadUserMcp(userId);
  if (data.servers.some(s => s.id === entry.id)) {
    throw new Error(`server id "${entry.id}" already exists for this user`);
  }
  const transport = entry.transport ?? 'stdio';
  if (transport === 'stdio' && !entry.command) {
    throw new Error('stdio transport requires a `command`');
  }
  if (transport === 'http' && !entry.url) {
    throw new Error('http transport requires a `url`');
  }
  data.servers.push({
    id: entry.id,
    displayName: entry.displayName ?? entry.id,
    transport,
    // stdio fields
    command: entry.command,
    args: entry.args ?? [],
    env: entry.env ?? {},
    // http fields
    url: entry.url,
    headers: entry.headers ?? {},
    // optional OAuth opt-in: when auth='oauth', the StreamableHTTP transport
    // attaches the OeOAuthProvider; user runs the flow via Settings.
    auth: entry.auth,
    oauthScope: entry.oauthScope,
    // assignment
    assignedToAgents: entry.assignedToAgents ?? [],
  });
  writeUserMcp(userId, data);
}

/**
 * Update an existing server entry. The patch can include any of the
 * mutable fields (displayName, transport, command, args, env, url,
 * headers, auth, oauthScope, assignedToAgents). Fields not present in the
 * patch are left unchanged. Throws if the server id doesn't exist.
 *
 * Note: callers should disconnect + reconnect after editing if the
 * patch touched anything that affects how the server is reached
 * (transport/command/args/env/url/headers/auth).
 */
export function updateServer(userId, serverId, patch) {
  const data = loadUserMcp(userId);
  const idx = data.servers.findIndex(s => s.id === serverId);
  if (idx < 0) throw new Error(`server "${serverId}" not found`);
  const cur = data.servers[idx];
  const next = { ...cur };
  // Allowlist of editable fields — the id stays constant; assignedToAgents
  // has its own assign/unassign endpoints so we accept it here too as a
  // bulk-set convenience.
  for (const k of [
    'displayName', 'transport',
    'command', 'args', 'env',
    'url', 'headers',
    'auth', 'oauthScope',
    'assignedToAgents',
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  }
  const transport = next.transport ?? 'stdio';
  if (transport === 'stdio' && !next.command) throw new Error('stdio transport requires a `command`');
  if (transport === 'http' && !next.url) throw new Error('http transport requires a `url`');
  data.servers[idx] = next;
  writeUserMcp(userId, data);
}

/** Remove a server by id. No-op if missing. */
export function removeServer(userId, serverId) {
  const data = loadUserMcp(userId);
  const next = data.servers.filter(s => s.id !== serverId);
  if (next.length === data.servers.length) return false;
  writeUserMcp(userId, { ...data, servers: next });
  return true;
}

/** Add an agent id to a server's assignedToAgents (idempotent). */
export function assignServer(userId, serverId, agentId) {
  const data = loadUserMcp(userId);
  const srv = data.servers.find(s => s.id === serverId);
  if (!srv) throw new Error(`server "${serverId}" not found`);
  srv.assignedToAgents = srv.assignedToAgents ?? [];
  if (!srv.assignedToAgents.includes(agentId)) srv.assignedToAgents.push(agentId);
  writeUserMcp(userId, data);
}

/** Remove an agent id from a server's assignedToAgents (idempotent). */
export function unassignServer(userId, serverId, agentId) {
  const data = loadUserMcp(userId);
  const srv = data.servers.find(s => s.id === serverId);
  if (!srv) throw new Error(`server "${serverId}" not found`);
  srv.assignedToAgents = (srv.assignedToAgents ?? []).filter(a => a !== agentId);
  writeUserMcp(userId, data);
}
