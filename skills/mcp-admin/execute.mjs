// @ts-check
/**
 * MCP server management — conversational CRUD for the user's mcp.json.
 *
 * Every mutation triggers refreshUserMcpTools(userId) so the agent's
 * toolset reflects the new state on the very next turn — no restart.
 */
import {
  getServersForUser, addServer, removeServer, assignServer, unassignServer,
} from '../../lib/mcp-config.mjs';
import { refreshUserMcpTools } from '../../lib/mcp-tools.mjs';
import { getServerStatus } from '../../lib/mcp-client.mjs';
import { getUserRole } from '../../routes/_helpers.mjs';

// MCP servers spawn arbitrary subprocesses on the OE host with the caller's
// credentials in env. Child accounts shouldn't be able to do that — same
// reasoning as why oe-admin requires `isPrivileged`. Adults can manage
// their own servers (per-user scope means there's no cross-user blast
// radius from a user adding a server with their own creds).
const MUTATION_TOOLS = new Set([
  'mcp_add_server', 'mcp_remove_server',
  'mcp_assign_server', 'mcp_unassign_server',
  'mcp_refresh',
]);

function redactEnv(env) {
  // Show env keys but never values — these are typically secrets.
  if (!env || typeof env !== 'object') return {};
  const out = {};
  for (const k of Object.keys(env)) out[k] = '<redacted>';
  return out;
}

// Translate common connection failure messages into a one-line next-step
// the LLM can read off to {{USER_NAME}}. Pattern → hint. Order matters
// (first match wins). The raw lastError is still returned alongside so
// the LLM can include it verbatim if asked.
const ERROR_HINTS = [
  { re: /handshake timed out/i,            hint: 'Server connection timed out. If using `npx -y`, the package may be downloading on first run — call `mcp_refresh` after ~30s. Otherwise check the command/URL is correct.' },
  { re: /fetch failed|ECONNREFUSED|ENOTFOUND/i, hint: 'Remote server URL is unreachable. Verify the server is running, the URL is correct, and (for localhost) the port is open. Call `mcp_refresh` after fixing.' },
  { re: /ENOENT|command not found/i,       hint: 'The `command` couldn\'t be found on PATH. Verify it\'s installed (e.g. `npx` requires Node.js, `python` requires Python). Fix the command and call `mcp_refresh`.' },
  { re: /EACCES|permission denied/i,       hint: 'OE doesn\'t have permission to run the command. Check file perms or try a different binary path.' },
  { re: /401|unauthor/i,                   hint: 'The server rejected our auth. For PAT auth, regenerate or re-paste the token in the `headers` (Authorization: Bearer ...). For OAuth, click Re-authorize in Settings.' },
  { re: /403|forbidden/i,                  hint: 'The server accepted auth but the credential doesn\'t have the required scopes. Generate a token with broader scopes and re-add the server.' },
  { re: /404/i,                            hint: 'The server endpoint returned 404 — the URL path is likely wrong. Check the server\'s documentation for the exact path (often `/mcp` or `/sse`).' },
];

function hintFor(state, lastError) {
  if (state !== 'error') return null;
  if (!lastError) return 'The server is in an error state — call `mcp_refresh` to retry, or check the Settings panel for details.';
  for (const { re, hint } of ERROR_HINTS) {
    if (re.test(lastError)) return hint;
  }
  return 'Call `mcp_refresh` after fixing the issue. If it keeps failing, the user may need to inspect the server logs.';
}

function summarizeServer(s, status) {
  const state = status?.state ?? 'unknown';
  const lastError = status?.lastError ?? null;
  return {
    id: s.id,
    displayName: s.displayName ?? s.id,
    transport: s.transport ?? 'stdio',
    command: s.command,
    args: s.args ?? [],
    env: redactEnv(s.env),
    url: s.url,
    headers: redactEnv(s.headers),
    assignedToAgents: s.assignedToAgents ?? [],
    status: state,
    lastError,
    hint: hintFor(state, lastError),
    toolCount: status?.toolCount ?? null,
    lastConnectedAt: status?.lastConnectedAt ?? null,
  };
}

export async function* executeSkillTool(name, args, userId, agentId) {
  if (!userId) { yield { type: 'result', text: 'No user context.' }; return; }

  // Gate mutations on role. Read-only tools (list / status) are open so a
  // child-account agent can still tell the user what's registered.
  if (MUTATION_TOOLS.has(name) && getUserRole(userId) === 'child') {
    yield { type: 'result', text: 'Registering or modifying MCP servers requires an adult account on this OpenEnsemble install.' };
    return;
  }

  if (name === 'mcp_list_servers') {
    const servers = getServersForUser(userId);
    if (!servers.length) {
      yield { type: 'result', text: 'No MCP servers registered. Use `mcp_add_server` to register one.' };
      return;
    }
    const summary = servers.map(s => summarizeServer(s, getServerStatus(userId, s.id)));
    yield { type: 'result', text: JSON.stringify(summary, null, 2) };
    return;
  }

  if (name === 'mcp_add_server') {
    const { id, displayName, transport = 'stdio', command, args: cmdArgs = [], env = {}, assignedToAgents = [] } = args ?? {};
    if (!id || !command) {
      yield { type: 'result', text: 'mcp_add_server requires both `id` and `command`.' };
      return;
    }
    try {
      addServer(userId, { id, displayName, transport, command, args: cmdArgs, env, assignedToAgents });
    } catch (e) {
      yield { type: 'result', text: `Could not add server: ${e.message}` };
      return;
    }
    let warmErr = null;
    try { await refreshUserMcpTools(userId); }
    catch (e) { warmErr = e.message; }
    const tail = warmErr
      ? `\nNote: the server is saved but the first connection attempt failed (${warmErr}). Fix the command/env and call mcp_refresh to retry.`
      : '';
    yield { type: 'result', text: `Added MCP server "${id}"${assignedToAgents.length ? ` and assigned it to ${assignedToAgents.join(', ')}` : ''}. The tools are live on the next turn.${tail}` };
    return;
  }

  if (name === 'mcp_remove_server') {
    const { id } = args ?? {};
    if (!id) { yield { type: 'result', text: 'mcp_remove_server requires `id`.' }; return; }
    const removed = removeServer(userId, id);
    if (!removed) {
      yield { type: 'result', text: `No MCP server with id "${id}" was registered.` };
      return;
    }
    try { await refreshUserMcpTools(userId); } catch (e) { console.warn('[mcp-admin] refresh after remove failed:', e.message); }
    yield { type: 'result', text: `Removed MCP server "${id}". Its tools are gone from any agent that had it assigned.` };
    return;
  }

  if (name === 'mcp_assign_server' || name === 'mcp_unassign_server') {
    const { server_id, agent_id } = args ?? {};
    if (!server_id || !agent_id) {
      yield { type: 'result', text: `${name} requires both server_id and agent_id.` };
      return;
    }
    try {
      if (name === 'mcp_assign_server') assignServer(userId, server_id, agent_id);
      else                              unassignServer(userId, server_id, agent_id);
    } catch (e) {
      yield { type: 'result', text: `Could not ${name === 'mcp_assign_server' ? 'assign' : 'unassign'}: ${e.message}` };
      return;
    }
    try { await refreshUserMcpTools(userId); } catch (e) { console.warn('[mcp-admin] refresh after assign failed:', e.message); }
    yield { type: 'result', text: `${name === 'mcp_assign_server' ? 'Assigned' : 'Unassigned'} server "${server_id}" ${name === 'mcp_assign_server' ? 'to' : 'from'} agent "${agent_id}".` };
    return;
  }

  if (name === 'mcp_refresh') {
    try {
      await refreshUserMcpTools(userId);
      yield { type: 'result', text: 'MCP tool cache refreshed for this user.' };
    } catch (e) {
      yield { type: 'result', text: `Refresh failed: ${e.message}` };
    }
    return;
  }

  yield { type: 'result', text: `Unknown MCP admin tool: ${name}` };
}
