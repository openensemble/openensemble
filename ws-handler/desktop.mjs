/**
 * Desktop app WebSocket server (local sandbox tool execution).
 * Extracted from ws-handler.mjs — pure move.
 */

import { WebSocketServer } from 'ws';
import { log } from '../logger.mjs';
import { getSessionMeta } from '../routes/_helpers/auth-sessions.mjs';

export function initDesktopWss({
  maxPayload = 2 * 1024 * 1024,
  pingInterval = 15_000,
  maxMissedPongs = 3,
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayload });
  wss.on('connection', async (ws, req) => {
    ws._missedPongs = 0;
    ws._authenticated = false;
    ws._desktopClientId = null;
    ws.on('pong', () => { ws._missedPongs = 0; });

    const { registerDesktop, dropDesktop, handleDesktopResult, updateDesktopStatus } = await import('../lib/desktop-bus.mjs');

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (!ws._authenticated) {
        if (msg.type !== 'auth' || typeof msg.token !== 'string') {
          try { ws.send(JSON.stringify({ type: 'error', message: 'first message must be {type:"auth", token}' })); } catch {}
          ws.close(4001, 'auth required');
          return;
        }
        const meta = getSessionMeta(msg.token);
        if (!meta?.userId) {
          try { ws.send(JSON.stringify({ type: 'error', message: 'invalid token' })); } catch {}
          ws.close(4002, 'invalid token');
          return;
        }
        ws._authenticated = true;
        ws._userId = meta.userId;
        try {
          const clientId = registerDesktop(ws, {
            userId: meta.userId,
            clientId: msg.clientId,
            name: msg.name,
            version: msg.version,
            platform: msg.platform,
            sandboxes: msg.sandboxes,
            capabilities: msg.capabilities,
          });
          ws.send(JSON.stringify({ type: 'auth_ok', clientId, userId: meta.userId }));
        } catch (e) {
          try { ws.send(JSON.stringify({ type: 'error', message: String(e?.message || e) })); } catch {}
          ws.close(4003, 'register failed');
        }
        return;
      }

      if (msg.type === 'result') {
        handleDesktopResult(msg);
        return;
      }
      if (msg.type === 'status') {
        updateDesktopStatus(ws, msg);
        return;
      }
      if (msg.type === 'ping') {
        updateDesktopStatus(ws, msg);
        try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch {}
        return;
      }
      log.warn('desktop', 'unknown frame type', { type: msg.type, userId: ws._userId, clientId: ws._desktopClientId });
    });

    ws.on('close', () => { dropDesktop(ws); });
    ws.on('error', () => { dropDesktop(ws); });
  });

  const hb = setInterval(() => {
    for (const c of wss.clients) {
      c._missedPongs = (c._missedPongs || 0) + 1;
      if (c._missedPongs >= maxMissedPongs) { c.terminate(); continue; }
      try { c.ping(); } catch {}
    }
  }, pingInterval);
  wss.on('close', () => clearInterval(hb));

  return wss;
}

// Browser extension WS lifecycle. Authentication is browser-bound only:
// device-code pairing registers a P-256 public key, then each connection
// proves possession of the private key with a one-time server challenge.
// General OE web-session bearer tokens are never accepted on this surface.
