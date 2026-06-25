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
  rememberNodeSessionToken, reviveLegacyNodeSession, reviveNodeSessionFromToken,
} from '../../skills/nodes/node-registry.mjs';
import {
  adoptSession, getSessionUserId, broadcastToUsers, getUserCoordinatorAgentId, getUser,
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
    let userId = token ? getSessionUserId(token) : null;
    let revivedNodeId = null;

    if (!userId && token) {
      const revived = reviveNodeSessionFromToken(token);
      if (revived?.userId) {
        adoptSession(token, { userId: revived.userId, deviceId: revived.nodeId, kind: 'node' });
        userId = revived.userId;
        revivedNodeId = revived.nodeId;
        console.log(`[nodes] revived persisted node session for ${revived.nodeId} (${revived.userId})`);
      }
    }

    const rejectUnauthorized = () => {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket.remoteAddress || 'unknown';
      const tokenPrefix = token ? `${token.slice(0, 8)}…` : '(missing)';
      console.warn(
        `[nodes] WS rejected 4001 Unauthorized (ip=${ip}, token=${tokenPrefix}). ` +
        `Agent needs re-pairing — session token is invalid or expired.`
      );
      ws.close(4001, 'Unauthorized');
    };

    if (!userId && !token) {
      rejectUnauthorized();
      return;
    }

    // Child accounts cannot register or run node agents under any circumstances.
    if (userId && getUser(userId)?.role === 'child') { ws.close(4005, 'Not permitted'); return; }

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
        if (!ws._userId) {
          const legacy = reviveLegacyNodeSession(token, msg);
          if (!legacy?.userId) {
            rejectUnauthorized();
            return;
          }
          adoptSession(token, { userId: legacy.userId, deviceId: legacy.nodeId, kind: 'node' });
          ws._userId = legacy.userId;
          revivedNodeId = legacy.nodeId;
          console.log(`[nodes] revived legacy node session for ${legacy.nodeId} (${legacy.userId})`);
        }

        if (getUser(ws._userId)?.role === 'child') { ws.close(4005, 'Not permitted'); return; }

        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || req.socket.remoteAddress || null;

        console.log(`[nodes] register from ${msg.hostname}: version=${msg.version || 'MISSING'} accessLevel=${msg.accessLevel || 'MISSING'}`);

        const nodeId = registerNode(ws, ws._userId, {
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
        rememberNodeSessionToken(ws._userId, nodeId, token);
        if (revivedNodeId && revivedNodeId !== nodeId) {
          console.warn(`[nodes] revived token for ${revivedNodeId} but agent registered as ${nodeId}`);
        }
        ws.send(JSON.stringify({ type: 'registered', nodeId }));
        return;
      }

      if (!ws._authenticated) {
        if (!ws._userId) {
          rejectUnauthorized();
          return;
        }
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

  // Application-level liveness heartbeat. Stats are requested only every few
  // minutes inside node-registry so the server doesn't ingest full host stats
  // on every keepalive.
  startHeartbeat(60000);

  // WS-level ping/pong for TCP keepalive. This catches dead TCP sockets
  // without asking the agent to gather any host stats.
  const wsHeartbeat = setInterval(() => {
    for (const client of _nodeWss.clients) {
      if (!client._alive) { client.terminate(); continue; }
      client._alive = false;
      client.ping();
    }
  }, 60000);
  _nodeWss.on('close', () => {
    clearInterval(wsHeartbeat);
    stopHeartbeat();
  });

  return _nodeWss;
}

export function getNodeWss() { return _nodeWss; }
