/**
 * Route handler for remote nodes.
 *
 * This file is the REST dispatcher (+ static asset endpoints). The bulk of the
 * logic lives in three submodules:
 *
 *   routes/nodes/pairing.mjs    — pairing code issue/redeem
 *   routes/nodes/websocket.mjs  — /ws/nodes — node agent WS server
 *   routes/nodes/terminal.mjs   — /ws/nodes/terminal + /nodes/terminal HTML
 *
 * `initNodeWss` / `initTerminalWss` are re-exported so server.mjs can keep
 * importing them from this file.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  removeNode, pushUpdate, pushUninstall, getNodes, getNode,
  sendCommand, sendCommandStreaming,
} from '../skills/nodes/node-registry.mjs';
import { requireAuth, readBody, getUser, getSessionUserId, getAuthToken } from './_helpers.mjs';
import { getLanAddress } from '../discovery.mjs';
import { handlePairingRoutes } from './nodes/pairing.mjs';
import { initNodeWss, getNodeWss } from './nodes/websocket.mjs';
import { initTerminalWss, getTerminalWss, handleTerminalPage, handleTerminalTicket } from './nodes/terminal.mjs';

export { initNodeWss, getNodeWss, initTerminalWss, getTerminalWss };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REMOTE_DIR = path.join(__dirname, '..', 'remote');

// ── Latest agent version (read from remote/oe-node-agent.mjs on demand) ─────
let _cachedAgentVersion = null;
let _cachedAgentMtime = 0;
function getLatestAgentVersion() {
  try {
    const agentPath = path.join(REMOTE_DIR, 'oe-node-agent.mjs');
    const stat = fs.statSync(agentPath);
    if (stat.mtimeMs === _cachedAgentMtime && _cachedAgentVersion) return _cachedAgentVersion;
    const src = fs.readFileSync(agentPath, 'utf8');
    const m = src.match(/const AGENT_VERSION\s*=\s*['"]([^'"]+)['"]/);
    _cachedAgentVersion = m ? m[1] : 'unknown';
    _cachedAgentMtime = stat.mtimeMs;
    return _cachedAgentVersion;
  } catch {
    return 'unknown';
  }
}

// ── REST API for the web UI ──────────────────────────────────────────────────
export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Hard block: child accounts cannot touch any authenticated /api/nodes or
  // /nodes/terminal endpoint. The unauthenticated bootstrap endpoints
  // (/nodes/install.sh, /nodes/agent) are static script assets and fine.
  if ((p.startsWith('/api/nodes') || p === '/nodes/terminal')) {
    const callerId = getSessionUserId(getAuthToken(req));
    if (callerId && getUser(callerId)?.role === 'child') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not permitted for this account' }));
      return true;
    }
  }

  // GET /nodes/install.sh — bootstrap installer (unauthenticated)
  if (p === '/nodes/install.sh' && req.method === 'GET') {
    try {
      const scriptPath = path.join(REMOTE_DIR, 'install.sh');
      let script = fs.readFileSync(scriptPath, 'utf8');
      // Inject the server's own URL so the script knows where to fetch the agent.
      // If the incoming Host header is localhost (e.g. install.sh was fetched
      // by the user's browser on the same machine), swap in the LAN IP so the
      // remote node can reach it.
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const hostHeader = req.headers.host || 'localhost:3737';
      const isLocalhost = /^(localhost|127\.|0\.0\.0\.0)/.test(hostHeader.split(':')[0]);
      const port = hostHeader.split(':')[1] || '3737';
      const serverHost = isLocalhost ? `${getLanAddress()}:${port}` : hostHeader;
      const downloadUrl = `${proto}://${serverHost}`;
      script = `#!/usr/bin/env bash\nexport OE_DOWNLOAD_URL="${downloadUrl}"\n${script.replace(/^#!.*\n/, '')}`;
      res.writeHead(200, {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(script);
    } catch (e) {
      res.writeHead(500); res.end('Failed to load install script');
    }
    return true;
  }

  // GET /nodes/agent — raw agent script (unauthenticated)
  if (p === '/nodes/agent' && req.method === 'GET') {
    try {
      const agentPath = path.join(REMOTE_DIR, 'oe-node-agent.mjs');
      const script = fs.readFileSync(agentPath);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(script);
    } catch (e) {
      res.writeHead(500); res.end('Failed to load agent script');
    }
    return true;
  }

  // GET /nodes/terminal — popout xterm.js terminal page
  if (p === '/nodes/terminal' && req.method === 'GET') {
    return handleTerminalPage(req, res, url);
  }

  // POST /api/nodes/terminal-ticket — mint a single-use page ticket
  if (p === '/api/nodes/terminal-ticket' && req.method === 'POST') {
    return handleTerminalTicket(req, res);
  }

  // GET /api/nodes — list connected nodes
  if (p === '/api/nodes' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeList = getNodes(userId);
    const latestVersion = getLatestAgentVersion();
    // Annotate each node with whether it's outdated
    const annotated = nodeList.map(n => ({
      ...n,
      latestVersion,
      outdated: n.version && n.version !== 'unknown' && n.version !== latestVersion,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(annotated));
    return true;
  }

  // GET /api/nodes/latest-version — current server-side agent version
  if (p === '/api/nodes/latest-version' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: getLatestAgentVersion() }));
    return true;
  }

  // DELETE /api/nodes/:nodeId — tell the agent to uninstall, then revoke it
  const deleteMatch = p.match(/^\/api\/nodes\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(deleteMatch[1]);

    // Step 1: ask the agent to run its self-destruct script (best-effort — if
    // the node is offline, we still proceed to revoke).
    pushUninstall(nodeId, userId);

    // Step 2: give the agent a moment to spawn the detached self-destruct
    // process before we close its WS in removeNode().
    setTimeout(() => {
      const result = removeNode(nodeId, userId);
      if (!result.removed) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.reason || 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ removed: true, uninstallRequested: true }));
    }, 1000);
    return true;
  }

  // POST /api/nodes/:nodeId/update — push an update to a connected agent
  const updateMatch = p.match(/^\/api\/nodes\/([^/]+)\/update$/);
  if (updateMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(updateMatch[1]);
    const result = pushUpdate(nodeId, userId);
    if (!result.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pushed: true, nodeId }));
    return true;
  }

  // POST /api/nodes/update-all — push updates to every node owned by the user
  if (p === '/api/nodes/update-all' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeList = getNodes(userId);
    const results = nodeList.map(n => ({ nodeId: n.nodeId, ...pushUpdate(n.nodeId, userId) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pushed: results.length, results }));
    return true;
  }

  // GET /api/nodes/:nodeId/status — get detailed node status
  const statusMatch = p.match(/^\/api\/nodes\/([^/]+)\/status$/);
  if (statusMatch && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(statusMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    try {
      const result = await sendCommand(nodeId, userId, { type: 'status' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...node, liveStatus: result }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...node, liveStatus: null, statusError: e.message }));
    }
    return true;
  }

  // POST /api/nodes/:nodeId/exec — execute command, return full result
  const execMatch = p.match(/^\/api\/nodes\/([^/]+)\/exec$/);
  if (execMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(execMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (!body.command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'command is required' }));
      return true;
    }
    try {
      const result = await sendCommand(nodeId, userId, {
        type: 'exec',
        command: body.command,
        timeout: Math.min(body.timeout || 60, 300),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // POST /api/nodes/:nodeId/exec/stream — SSE streaming command output
  const streamMatch = p.match(/^\/api\/nodes\/([^/]+)\/exec\/stream$/);
  if (streamMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(streamMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (!body.command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'command is required' }));
      return true;
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      const result = await sendCommandStreaming(nodeId, userId, {
        type: 'exec',
        command: body.command,
        timeout: Math.min(body.timeout || 60, 300),
      }, (stream, data) => {
        // Send each chunk as an SSE event
        res.write(`data: ${JSON.stringify({ stream, data })}\n\n`);
      });

      // Send final result
      res.write(`data: ${JSON.stringify({ type: 'done', ...result })}\n\n`);
      res.end();
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
      res.end();
    }
    return true;
  }

  // Pairing: /api/nodes/pair and /api/nodes/redeem
  if (await handlePairingRoutes(req, res, p)) return true;

  return false;
}
