/**
 * WebSocket lifecycle: upgrade routing, auth, heartbeat, per-user cap,
 * message dispatch (auth, ping, chat, clear, load, stop), cross-user
 * agent notifications, and broadcast helpers.
 *
 * Owns the main wss (browser clients) plus the node-agent and terminal
 * WebSocketServers that share the same HTTP port. server.mjs calls
 * initWs(httpServer) once at startup; everything else routes through
 * the exported helpers.
 */

import { WebSocketServer } from 'ws';
import { getAgentScope } from './agents.mjs';
import { handleChatMessage, abortChat, getActiveStreams } from './chat-dispatch.mjs';
import { getActiveTasks as getActiveBgTasks } from './background-tasks.mjs';
import { loadSession, clearSession, appendToSession, getStreamBuffer } from './sessions.mjs';
import { initNodeWss, initTerminalWss } from './routes/nodes.mjs';
import {
  getAgentsForUser, agentToWire, getUser, getUserCoordinatorAgentId,
  getSessionUserId, resolveShareGroup,
} from './routes/_helpers.mjs';
import { log } from './logger.mjs';

// maxPayload: cap each frame at 2 MiB so a malicious client can't force the
// server to buffer arbitrarily large messages. 2 MiB still fits large chat
// messages, base64 screenshots, and attachments we expect in normal use.
const WS_MAX_PAYLOAD = 2 * 1024 * 1024;
const WS_PING_INTERVAL = 15000; // 15s — aggressive enough for mobile carriers
// Per-user concurrent WebSocket cap. A compromised account (or a buggy
// reconnect loop) shouldn't be able to hoard server sockets — each open
// connection costs a heartbeat timer slot and keepalive memory.
const MAX_WS_PER_USER = 20;

let _wss = null;
let _nodeWss = null;
let _termWss = null;

// Same-origin check for browser-initiated WebSocket upgrades. Browsers send
// Origin automatically; native clients (mobile apps, node agents, curl) do
// not, so missing Origin is allowed (they still need a valid auth token).
function isSameOriginWs(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const reqHost = req.headers.host || '';
    return originHost === reqHost
      || originHost.replace(/^127\.0\.0\.1/, 'localhost') === reqHost.replace(/^127\.0\.0\.1/, 'localhost')
      || originHost.replace(/^localhost/, '127.0.0.1') === reqHost.replace(/^localhost/, '127.0.0.1');
  } catch { return false; }
}

function enforceWsCap(ws) {
  if (!ws._userId) return true;
  let count = 0;
  for (const c of _wss.clients) if (c._userId === ws._userId && c !== ws) count++;
  if (count >= MAX_WS_PER_USER) {
    ws.send(JSON.stringify({ type: 'error', message: 'Too many concurrent connections' }));
    ws.close(4008, 'Connection cap reached');
    return false;
  }
  return true;
}

const sessionKey = (userId, agentId) => `${userId}_${agentId}`;

export function initWs(httpServer) {
  _wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  _nodeWss = initNodeWss();
  _termWss = initTerminalWss();

  httpServer.on('upgrade', (req, socket, head) => {
    if (!isSameOriginWs(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/ws/nodes') {
      _nodeWss.handleUpgrade(req, socket, head, ws => _nodeWss.emit('connection', ws, req));
    } else if (pathname === '/ws/nodes/terminal') {
      _termWss.handleUpgrade(req, socket, head, ws => _termWss.emit('connection', ws, req));
    } else {
      _wss.handleUpgrade(req, socket, head, ws => _wss.emit('connection', ws, req));
    }
  });

  // Server-side heartbeat — keeps mobile connections alive across NAT/proxy
  const heartbeat = setInterval(() => {
    for (const client of _wss.clients) {
      if (client._alive === false) { client.terminate(); continue; }
      client._alive = false;
      client.ping();
    }
  }, WS_PING_INTERVAL);
  _wss.on('close', () => clearInterval(heartbeat));

  _wss.on('connection', onConnection);
}

function onConnection(ws, req) {
  // Support both first-message auth (preferred) and legacy URL token auth
  const wsUrl = new URL(req.url, 'http://x');
  const legacyToken = wsUrl.searchParams.get('token');
  const legacyUserId = legacyToken ? getSessionUserId(legacyToken) : null;

  if (legacyUserId) {
    // Legacy path: token in URL (still supported for backwards compat)
    ws._userId = legacyUserId;
    ws._authenticated = true;
    if (!enforceWsCap(ws)) return;
  } else {
    // New path: require auth via first message
    ws._authenticated = false;
  }

  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });

  // Send initial data once authenticated. We log only user id — never the
  // raw request URL, which may contain a legacy ?token= that would otherwise
  // land in logs / ship to log aggregators in plaintext.
  function sendInitialData() {
    console.log('[ws] client connected, user:', ws._userId);
    log.info('ws', 'client connected', { userId: ws._userId });
    const userAgents = getAgentsForUser(ws._userId);
    ws.send(JSON.stringify({ type: 'agent_list', agents: userAgents.map(agentToWire) }));
    for (const agent of userAgents) {
      const messages = loadSession(sessionKey(ws._userId, agent.id), 60);
      const pendingStream = getStreamBuffer(sessionKey(ws._userId, agent.id));
      ws.send(JSON.stringify({ type: 'session_loaded', agent: agent.id, messages, pendingStream }));
    }
    // Tell the client which agents are actively streaming and which background tasks are running
    const active = getActiveStreams(ws._userId);
    const tasks = getActiveBgTasks().filter(t => t.userId === ws._userId);
    if (active.length || tasks.length) {
      ws.send(JSON.stringify({ type: 'active_streams', agents: active, tasks }));
    }
  }

  if (ws._authenticated) sendInitialData();

  ws.on('message', async (raw) => {
   try {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // Handle auth message (first message for new-style auth)
    if (msg.type === 'auth') {
      const userId = getSessionUserId(msg.token);
      if (!userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        ws.close(4001, 'Unauthorized');
        return;
      }
      ws._userId = userId;
      ws._authenticated = true;
      if (!enforceWsCap(ws)) return;
      sendInitialData();
      return;
    }

    // Reject all other messages until authenticated
    if (!ws._authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'clear_session') {
      const agentId = msg.agent;
      if (agentId) {
        clearSession(sessionKey(ws._userId, agentId));
        ws.send(JSON.stringify({ type: 'session_loaded', agent: agentId, messages: [] }));
      }
      return;
    }

    if (msg.type === 'stop') {
      const stopAgent = typeof msg.agent === 'string' ? msg.agent : getUserCoordinatorAgentId(ws._userId);
      if (stopAgent) abortChat(ws._userId, stopAgent);
      return;
    }

    if (msg.type === 'load_session') {
      const agentId = msg.agent;
      if (agentId) {
        const messages = loadSession(sessionKey(ws._userId, agentId), 60);
        const pendingStream = getStreamBuffer(sessionKey(ws._userId, agentId));
        ws.send(JSON.stringify({ type: 'session_loaded', agent: agentId, messages, pendingStream }));
      }
      return;
    }

    if (msg.type === 'chat') {
      // Reject non-string text/agent at the boundary so downstream code can assume strings.
      if (msg.text != null && typeof msg.text !== 'string') {
        ws.send(JSON.stringify({ type: 'error', message: 'chat.text must be a string', agent: typeof msg.agent === 'string' ? msg.agent : 'system' }));
        return;
      }
      if (msg.agent != null && typeof msg.agent !== 'string') {
        ws.send(JSON.stringify({ type: 'error', message: 'chat.agent must be a string', agent: 'system' }));
        return;
      }
      const textPreview = typeof msg.text === 'string' ? msg.text.slice(0, 50) : '(no text)';
      console.log('[chat] received, agent:', msg.agent, 'user:', ws._userId, 'text:', textPreview);
      await handleChatMessage({
        userId:     ws._userId,
        agentId:    msg.agent,
        text:       msg.text,
        attachment: msg.attachment,
        onEvent: (e) => sendToUser(ws._userId, e),
        onBroadcast: broadcastAgentList,
        onNotify: (fromUserId, agentId, notify) => {
          if (ws.readyState === ws.OPEN) emitAgentNotification(fromUserId, agentId, notify);
        },
      });
      return;
    }
   } catch (e) {
    // Never let a malformed message kill the process. Log and notify the client.
    console.error('[ws] handler error:', e?.stack ?? e?.message ?? e);
    try { ws.send(JSON.stringify({ type: 'error', message: 'Server error processing message', agent: 'system' })); } catch {}
   }
  });

  ws.on('close', () => {
    console.log('[ws] client disconnected');
    log.info('ws', 'client disconnected', { userId: ws._userId });
  });
  ws.on('error', e => console.error('[ws] error:', e.message));
}

// ── Broadcast helpers ────────────────────────────────────────────────────────
export function broadcast(msg) {
  if (!_wss) return;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of _wss.clients)
    if (client.readyState === client.OPEN) try { client.send(data); } catch {}
}

export function broadcastAgentList() {
  if (!_wss) return;
  const cache = new Map();
  for (const client of _wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    const uid = client._userId;
    let data = cache.get(uid);
    if (!data) {
      data = JSON.stringify({ type: 'agent_list', agents: getAgentsForUser(uid).map(agentToWire) });
      cache.set(uid, data);
    }
    try { client.send(data); } catch {}
  }
}

export function broadcastToUsers(userIds, msg) {
  if (!_wss) return;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const idSet = new Set(userIds);
  for (const client of _wss.clients)
    if (client.readyState === client.OPEN && idSet.has(client._userId)) try { client.send(data); } catch {}
}

/** Send a message to every tab the given user has open. Returns delivery count. */
export function sendToUser(userId, msg) {
  if (!_wss) return 0;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  let delivered = 0;
  for (const client of _wss.clients) {
    if (client.readyState === client.OPEN && client._userId === userId) {
      try { client.send(data); delivered++; } catch {}
    }
  }
  return delivered;
}

// ── Cross-user agent notifications ───────────────────────────────────────────
export function emitAgentNotification(fromUserId, agentId, notify) {
  const { scope, shareGroup } = getAgentScope(agentId);
  if (scope !== 'shared' || !shareGroup) return;

  const memberIds = resolveShareGroup(shareGroup, fromUserId);
  const targetIds = memberIds.filter(id => id !== fromUserId);
  if (!targetIds.length) return;

  const fromUser = getUser(fromUserId);
  const fromName = fromUser?.name ?? 'Someone';
  const content = notify.message ?? `${fromName} triggered ${notify.event} via ${agentId}`;
  const ts = Date.now();

  const notification = {
    role: 'notification',
    content,
    ts,
    from: { userId: fromUserId, userName: fromName, agent: agentId },
    event: notify.event,
    data: notify.data ?? {},
  };

  const wsMsg = JSON.stringify({
    type: 'agent_notification',
    agent: agentId,
    content,
    from: { userId: fromUserId, userName: fromName },
    event: notify.event,
    data: notify.data ?? {},
    ts,
  });

  for (const targetId of targetIds) {
    // Persist to their session so it loads on reconnect
    appendToSession(`${targetId}_${agentId}`, notification);
    // Deliver in real-time to connected clients
    sendToUser(targetId, wsMsg);
  }

  console.log(`[notify] ${fromName}'s ${agentId} → ${targetIds.length} user(s): ${notify.event}`);
}

// ── Runtime introspection ────────────────────────────────────────────────────
export function getWsClientCount() { return _wss?.clients?.size ?? 0; }
export function getNodeClientCount() { return _nodeWss?.clients?.size ?? 0; }

// ── Shutdown ─────────────────────────────────────────────────────────────────
export function closeAllWsClients(reason = 'Server shutting down') {
  if (!_wss) return;
  for (const client of _wss.clients) {
    try {
      client.send(JSON.stringify({ type: 'error', message: reason }));
      client.close(1001, reason);
    } catch (e) { console.warn('[shutdown] Failed to close WebSocket client:', e.message); }
  }
}
