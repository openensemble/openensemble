// @ts-check
/**
 * MCP tool injection layer.
 *
 * Agent-resolver runs synchronously — call sites all over the codebase
 * expect getAgentsForUser to return immediately. MCP tool discovery is
 * inherently async (we have to talk to each server's stdio process). To
 * bridge those, this module keeps a synchronous cache that the resolver
 * reads at agent-build time and a separate async refresher that talks to
 * the servers.
 *
 * Cache lifecycle:
 *   - Empty at boot.
 *   - server.mjs calls warmAllUsersAtBoot() during startup — that walks
 *     users/ for mcp.json files and refreshes each user's cache before
 *     accepting WS connections. So the first chat ALREADY sees MCP tools.
 *   - When a user edits their mcp.json (or assigns/unassigns to an agent),
 *     they should call refreshUserMcpTools(userId) — currently triggered
 *     manually; future Settings UI will wire this.
 *   - Server idle-timeout (5min) doesn't affect the tool list cache — the
 *     tools belong to the server contract, not the connection. We
 *     refresh only on explicit mcp.json change.
 */
import { getServersForUser, getServersAssignedToAgent, getServerById } from './mcp-config.mjs';
import { listTools, disconnect } from './mcp-client.mjs';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

/** @type {Map<string, any[]>} */ // key = `${userId}::${agentId}` → OE tool defs
const _cache = new Map();

function cacheKey(userId, agentId) {
  return `${userId}::${agentId}`;
}

/**
 * Convert one MCP server's tools to OE's OpenAI-style tool format with the
 * namespace prefix applied. Returns ToolDef[].
 */
function toOeToolDefs(serverId, mcpTools) {
  // Namespace: `mcp_<serverId>__<bareTool>` with DOUBLE-underscore separator.
  // Single-underscore would collide with bare tool names that have
  // underscores in them (e.g. filesystem's `read_file`, github's
  // `create_issue`). Double-underscore is unambiguous on both ends — the
  // dispatcher splits on the first `__` to recover serverId and bareTool.
  // Constraint enforced at load time: serverId may NOT contain `__`.
  return (mcpTools ?? []).map(t => ({
    type: 'function',
    function: {
      name: `mcp_${serverId}__${t.name}`,
      description: t.description ?? `MCP tool ${t.name} from server ${serverId}`,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

/**
 * Refresh the cached tool list for a single agent. Walks the user's
 * own MCP servers whose assignedToAgents includes this agent.
 * Best-effort per server — a failing server doesn't break the agent;
 * its tools just won't be available this refresh cycle.
 */
export async function refreshAgentMcpTools(userId, agentId) {
  if (!userId || !agentId) return;
  const servers = getServersAssignedToAgent(userId, agentId);
  if (!servers.length) {
    _cache.delete(cacheKey(userId, agentId));
    return;
  }
  const allTools = [];
  for (const cfg of servers) {
    try {
      const mcpTools = await listTools(userId, cfg);
      allTools.push(...toOeToolDefs(cfg.id, mcpTools));
    } catch (e) {
      console.warn(`[mcp-tools] listTools failed for user=${userId} server=${cfg.id}:`, e.message);
    }
  }
  _cache.set(cacheKey(userId, agentId), allTools);
}

/**
 * Refresh this user's MCP tool caches. Two phases:
 *   1. Connect to EVERY server in the user's mcp.json and prime its tools
 *      cache + status. This runs regardless of agent assignment so the
 *      Settings UI shows accurate connection status as soon as a server is
 *      added, even before it's assigned to any agent.
 *   2. Refresh the per-agent tool-def caches for every agent referenced by
 *      any server's assignedToAgents. Drives what agent.tools sees.
 */
export async function refreshUserMcpTools(userId) {
  if (!userId) return;
  const servers = getServersForUser(userId);
  // Phase 1: warm a connection to every registered server (drives status).
  await Promise.all(servers.map(async (cfg) => {
    try { await listTools(userId, cfg); }
    catch (e) { console.warn(`[mcp-tools] phase-1 connect failed for ${cfg.id}:`, e.message); }
  }));
  // Phase 2: rebuild per-agent tool caches for agents that have any of
  // these servers assigned.
  const agentIds = new Set();
  for (const s of servers) {
    for (const a of (s.assignedToAgents ?? [])) agentIds.add(a);
  }
  await Promise.all([...agentIds].map(a => refreshAgentMcpTools(userId, a)));
}

/**
 * Sync getter used by agent-resolver. Returns the last-refreshed tool defs
 * for this (user, agent) pair, or an empty array if we haven't warmed yet.
 */
export function getCachedMcpToolDefsForAgent(userId, agentId) {
  return _cache.get(cacheKey(userId, agentId)) ?? [];
}

/**
 * Reconnect one server: close any existing pool entry, then re-list tools
 * (which respawns the connection under the user's credentials). Also
 * refreshes per-agent tool caches for any agent assigned to this server.
 * Returns the new server status so the caller can surface it.
 */
export async function reconnectServer(userId, serverId) {
  const cfg = getServerById(userId, serverId);
  if (!cfg) throw new Error(`server "${serverId}" not found for this user`);
  await disconnect(userId, serverId);
  try { await listTools(userId, cfg); }
  catch (e) { /* status will be 'error' with lastError already set */ }
  // Refresh tool caches for agents this server is assigned to so a stale
  // cache doesn't keep using the old tool list after the server changed.
  for (const a of (cfg.assignedToAgents ?? [])) {
    try { await refreshAgentMcpTools(userId, a); } catch {}
  }
}

/**
 * Walk users/ at boot, find users with mcp.json, refresh their tool
 * caches before WS accepts. Failures are logged and skipped — one bad
 * user's MCP config shouldn't block the whole server's startup.
 */
export async function warmAllUsersAtBoot() {
  if (!fs.existsSync(USERS_DIR)) return;
  const userDirs = fs.readdirSync(USERS_DIR).filter(d => d.startsWith('user_'));
  const startedAt = Date.now();
  let warmed = 0;
  await Promise.all(userDirs.map(async (uid) => {
    try {
      if (!fs.existsSync(path.join(USERS_DIR, uid, 'mcp.json'))) return;
      await refreshUserMcpTools(uid);
      warmed++;
    } catch (e) {
      console.warn(`[mcp-tools] warm failed for ${uid}:`, e.message);
    }
  }));
  if (warmed > 0) {
    console.log(`[mcp-tools] warmed ${warmed} user(s) in ${Date.now() - startedAt}ms`);
  }
}
