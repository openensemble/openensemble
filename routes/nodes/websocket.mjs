/**
 * WebSocket server for node agents.
 *
 * Node agents connect to /ws/nodes?token=..., register themselves, and then
 * exchange command/result/pty messages over the same socket.
 */

import { WebSocketServer } from 'ws';
import {
  registerNode, unregisterNode, handleNodeMessage,
  injectDeps, startHeartbeat, stopHeartbeat, loadPersistedNodes,
} from '../../skills/nodes/node-registry.mjs';
import {
  getSessionUserId, broadcastToUsers, getUserCoordinatorAgentId, getUser,
} from '../_helpers.mjs';
import { appendToSession } from '../../sessions.mjs';

let _nodeWss = null;

export function initNodeWss() {
  // Restore previously-registered nodes (all marked disconnected) before the
  // WSS starts accepting connections so live reconnects can replace their
  // entries in place instead of racing with an empty registry.
  loadPersistedNodes();

  _nodeWss = new WebSocketServer({ noServer: true });

  // Inject dependencies into the registry so it can broadcast events
  injectDeps({
    broadcastToUser: (userId, msg) => broadcastToUsers([userId], msg),
    appendToSession,
    getCoordinator: (userId) => {
      try { return getUserCoordinatorAgentId(userId); }
      catch { return null; }
    },
  });

  _nodeWss.on('connection', (ws, req) => {
    // Auth via query string token
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    const userId = token ? getSessionUserId(token) : null;

    if (!userId) {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket.remoteAddress || 'unknown';
      const tokenPrefix = token ? `${token.slice(0, 8)}…` : '(missing)';
      console.warn(
        `[nodes] WS rejected 4001 Unauthorized (ip=${ip}, token=${tokenPrefix}). ` +
        `Agent needs re-pairing — session token is invalid or expired.`
      );
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Child accounts cannot register or run node agents under any circumstances.
    if (getUser(userId)?.role === 'child') { ws.close(4005, 'Not permitted'); return; }

    ws._userId = userId;
    ws._authenticated = false;
    ws._alive = true;
    ws._nodeId = null;

    // WS-level keepalive
    ws.on('pong', () => { ws._alive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // First message must be register
      if (msg.type === 'register' && !ws._authenticated) {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || req.socket.remoteAddress || null;

        console.log(`[nodes] register from ${msg.hostname}: version=${msg.version || 'MISSING'} accessLevel=${msg.accessLevel || 'MISSING'}`);

        const nodeId = registerNode(ws, userId, {
          hostname: msg.hostname,
          platform: msg.platform,
          distro: msg.distro,
          arch: msg.arch,
          shell: msg.shell,
          packageManager: msg.packageManager,
          nodeId: msg.nodeId,
          capabilities: msg.capabilities ?? [],
          accessLevel: msg.accessLevel || 'unknown',
          accessLocked: !!msg.accessLocked,
          version: msg.version || 'unknown',
          ip,
        });

        ws._nodeId = nodeId;
        ws._authenticated = true;
        ws.send(JSON.stringify({ type: 'registered', nodeId }));
        return;
      }

      if (!ws._authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Must register first' }));
        return;
      }

      handleNodeMessage(ws._nodeId, msg);
    });

    ws.on('close', () => {
      if (ws._nodeId) {
        unregisterNode(ws._nodeId);
      }
    });

    ws.on('error', (err) => {
      console.warn(`[nodes] WS error for ${ws._nodeId || 'unknown'}:`, err.message);
    });
  });

  // Start the application-level heartbeat (30s interval)
  startHeartbeat(30000);

  // WS-level ping/pong for TCP keepalive (15s)
  const wsHeartbeat = setInterval(() => {
    for (const client of _nodeWss.clients) {
      if (!client._alive) { client.terminate(); continue; }
      client._alive = false;
      client.ping();
    }
  }, 15000);
  _nodeWss.on('close', () => {
    clearInterval(wsHeartbeat);
    stopHeartbeat();
  });

  return _nodeWss;
}

export function getNodeWss() { return _nodeWss; }
