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
import { randomBytes } from 'crypto';
import { getAgentScope } from './agents.mjs';

// Boot identity — fresh random value every server start. Sent to clients on
// pong + agent_list so they can detect server restart unambiguously even
// when their TCP socket appears healthy. Required for the voice-device:
// esp_websocket_client_is_connected() returns cached state and doesn't
// notice a server restart on its own.
const BOOT_ID = randomBytes(8).toString('hex');
console.log(`[ws] boot_id: ${BOOT_ID}`);
import { handleChatMessage, abortChat, getActiveStreams } from './chat-dispatch.mjs';
import { getActiveTasks as getActiveBgTasks } from './background-tasks.mjs';
import { loadSession, clearSession, appendToSession, getStreamBuffer } from './sessions.mjs';
import { markAlarmFired, markAlarmAcked } from './lib/alarms.mjs';
import { initNodeWss, initTerminalWss } from './routes/nodes.mjs';
import {
  getAgentsForUser, agentToWire, getUser, getUserCoordinatorAgentId,
  getSessionUserId, getAuthToken, resolveShareGroup,
} from './routes/_helpers.mjs';
import { getSessionMeta, setSessionDeviceId } from './routes/_helpers/auth-sessions.mjs';
import { getSlotAssignment, findDeviceByTokenPrefix, getDeviceVoiceConfigVersion, markVoiceConfigPushed, touchDevice } from './lib/voice-devices.mjs';
import { getAmbientForDevice } from './routes/devices.mjs';
import { readVoiceConfig, pushConfigToDevice, handleWwUploadAck } from './lib/voice-config.mjs';
import { submitCredential, cancelCredential, setCredentialEmitter } from './lib/credentials.mjs';

// Backfill ws._deviceId for voice-device sessions that were created before
// the deviceId was stored on the session record (pre-2026-05-12). Looks up
// the device by 8-char token prefix and writes the result back into the
// session so subsequent auths skip this. Returns the deviceId or null.
function resolveDeviceId(token, meta) {
  if (!meta || meta.kind !== 'voice-device') return null;
  if (meta.deviceId) return meta.deviceId;
  if (!token) return null;
  const dev = findDeviceByTokenPrefix(meta.userId, token.slice(0, 8));
  if (!dev) return null;
  setSessionDeviceId(token, dev.id);
  return dev.id;
}
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
let _browserExtWss = null;

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
  _browserExtWss = initBrowserExtWss();

  attachWsUpgrade(httpServer);

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

  // Wire the credential primitive so server-side tools can emit
  // `credential_prompt` frames via the per-user broadcast helper.
  setCredentialEmitter(sendToUser);
}

/**
 * Attach the WS upgrade handler to a second (HTTP or HTTPS) server, sharing
 * the WebSocketServer instances created in initWs(). Used by server.mjs to
 * wire the HTTPS listener (port 3739, self-signed cert) into the same WS
 * routing as the HTTP listener (3737). Call initWs() first, then call this
 * for each additional server you want to share WS routing.
 */
export function attachWsUpgrade(httpServer) {
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    // Browser extensions and node agents are NOT same-origin (extension
    // origin is chrome-extension://<id>; node-agent has no Origin). Auth
    // for both paths happens via the first-message token instead — so we
    // skip the same-origin gate for those paths only.
    const isExternalClientPath =
      pathname === '/ws/nodes' ||
      pathname === '/ws/nodes/terminal' ||
      pathname === '/ws/browser-ext';
    if (!isExternalClientPath && !isSameOriginWs(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (pathname === '/ws/nodes') {
      _nodeWss.handleUpgrade(req, socket, head, ws => _nodeWss.emit('connection', ws, req));
    } else if (pathname === '/ws/nodes/terminal') {
      _termWss.handleUpgrade(req, socket, head, ws => _termWss.emit('connection', ws, req));
    } else if (pathname === '/ws/browser-ext') {
      _browserExtWss.handleUpgrade(req, socket, head, ws => _browserExtWss.emit('connection', ws, req));
    } else {
      _wss.handleUpgrade(req, socket, head, ws => _wss.emit('connection', ws, req));
    }
  });
}

// Browser extension WS lifecycle. Auth happens via first-message token —
// the extension stores the user's OE auth token at setup time and sends it
// as the first frame. Subsequent frames are bus messages (register, result,
// tabs_update, ping). See lib/browser-bus.mjs.
function initBrowserExtWss() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  wss.on('connection', async (ws, req) => {
    ws._alive = true;
    ws._authenticated = false;
    ws._extId = null;
    ws.on('pong', () => { ws._alive = true; });

    // Lazy imports — browser-bus + getSessionMeta are not needed unless an
    // extension actually connects.
    const { registerBrowser, dropBrowser, handleResult, updateTabs, getExtensionSourceVersion } = await import('./lib/browser-bus.mjs');

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      // First message MUST be auth. Reject anything else until authed.
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
          const extId = registerBrowser(ws, {
            userId: meta.userId,
            name: msg.name,
            version: msg.version,
            tabs: msg.tabs,
          });
          ws.send(JSON.stringify({
            type: 'auth_ok',
            extId,
            userId: meta.userId,
            sourceVersion: getExtensionSourceVersion(),
          }));
        } catch (e) {
          try { ws.send(JSON.stringify({ type: 'error', message: String(e?.message || e) })); } catch {}
          ws.close(4003, 'register failed');
        }
        return;
      }

      if (msg.type === 'result') {
        handleResult(msg);
        return;
      }
      if (msg.type === 'tabs_update') {
        updateTabs(ws, msg.tabs);
        return;
      }
      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch {}
        return;
      }
      // Chat from the extension popup — runs the user's coordinator
      // through the normal chat-dispatch path and streams the events back
      // over this WS so the popup can render Sydney's reply without the
      // user opening the OE web UI. Lets Shawn ask "what's on this page"
      // from any browser tab.
      if (msg.type === 'chat' && typeof msg.text === 'string') {
        const requestId = String(msg.requestId || Date.now());
        try {
          const { handleChatMessage } = await import('./chat-dispatch.mjs');
          await handleChatMessage({
            userId: ws._userId,
            agentId: getUserCoordinatorAgentId(ws._userId),
            text: msg.text,
            source: 'browser-ext',
            onEvent: (ev) => {
              try {
                ws.send(JSON.stringify({ type: 'chat_event', requestId, event: ev }));
              } catch {}
            },
          });
          try { ws.send(JSON.stringify({ type: 'chat_done', requestId })); } catch {}
        } catch (e) {
          try { ws.send(JSON.stringify({ type: 'chat_error', requestId, message: e?.message || String(e) })); } catch {}
        }
        return;
      }
      // Unknown frame — log + drop.
      log.warn('browser-ext', 'unknown frame type', { type: msg.type, userId: ws._userId });
    });

    ws.on('close', () => { dropBrowser(ws); });
    ws.on('error', () => { dropBrowser(ws); });
  });

  // Heartbeat to keep mobile / suspended browsers responsive. Same cadence
  // as the main WS heartbeat — terminate after one missed pong cycle.
  const hb = setInterval(() => {
    for (const c of wss.clients) {
      if (c._alive === false) { c.terminate(); continue; }
      c._alive = false;
      try { c.ping(); } catch {}
    }
  }, WS_PING_INTERVAL);
  wss.on('close', () => clearInterval(hb));

  return wss;
}

export function getBrowserExtClientCount() { return _browserExtWss?.clients?.size ?? 0; }

function onConnection(ws, req) {
  // Auth precedence:
  //   1. Cookie via getAuthToken (browser path — cookie rides on the upgrade
  //      request automatically same-origin). Preferred.
  //   2. First-message auth — used by clients that can't carry the cookie
  //      (oe-node-agent, scripts).
  // The legacy `?token=` query-string upgrade path was removed: tokens in
  // upgrade URLs leak via Referer headers, browser history, and reverse-proxy
  // access logs. Browser WS opens at `/` (no token) so the cookie path works;
  // node-agent / CLI / scripts must use first-message auth.
  const cookieOrHeaderToken = getAuthToken(req);
  const cookieMeta = cookieOrHeaderToken ? getSessionMeta(cookieOrHeaderToken) : null;
  const cookieUserId = cookieMeta?.userId ?? null;

  if (cookieUserId) {
    ws._userId = cookieUserId;
    // Voice-device sessions stash the source device-id so chat messages can
    // resolve slot_assignments[wake_slot] without a per-message token lookup.
    // Backfilled for pre-2026-05-12 voice-device sessions that didn't capture
    // deviceId at creation time. Null for browser sessions.
    ws._deviceId = resolveDeviceId(cookieOrHeaderToken, cookieMeta);
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
    ws.send(JSON.stringify({ type: 'agent_list', agents: userAgents.map(agentToWire), boot_id: BOOT_ID }));
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

  if (ws._authenticated) {
    sendInitialData();
    maybePushVoiceConfig(ws);
    if (ws._deviceId) touchDevice(ws._userId, ws._deviceId);
  }

  ws.on('message', async (raw) => {
   try {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // Handle auth message (first message for new-style auth)
    if (msg.type === 'auth') {
      // Already cookie-authed at upgrade time — accept the first-message auth
      // as a redundant idempotent re-auth and skip re-running sendInitialData.
      // The client always sends this; we just ignore when the cookie already
      // did the job.
      if (ws._authenticated) {
        const sameUserId = getSessionUserId(msg.token);
        if (sameUserId && sameUserId !== ws._userId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
          ws.close(4001, 'Unauthorized');
        }
        return;
      }
      const meta = getSessionMeta(msg.token);
      const userId = meta?.userId ?? null;
      if (!userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        ws.close(4001, 'Unauthorized');
        return;
      }
      ws._userId = userId;
      ws._deviceId = resolveDeviceId(msg.token, meta);
      ws._authenticated = true;
      if (!enforceWsCap(ws)) return;
      sendInitialData();
      maybePushVoiceConfig(ws);
      if (ws._deviceId) {
        // Firmware reports its running version on auth (since 0.2.3). Store
        // it on the device record so the UI can show "Update available"
        // when manifest.version > device.fw_version.
        const fwReported = typeof msg.firmware_version === 'string' &&
          msg.firmware_version.length > 0 && msg.firmware_version.length < 32
            ? msg.firmware_version : null;
        touchDevice(ws._userId, ws._deviceId, fwReported ? { fw_version: fwReported } : {});
      }
      return;
    }

    // Reject all other messages until authenticated
    if (!ws._authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', boot_id: BOOT_ID }));
      return;
    }

    // Voice-device ack for a server-pushed ww_upload. Routed by deviceId
    // because slot indexes aren't unique across devices. handleWwUploadAck
    // resolves the matching pending entry in lib/voice-config.mjs so
    // pushConfigToDevice can proceed to the next slot.
    if (msg.type === 'ww_upload_ack') {
      if (ws._deviceId && Number.isInteger(msg.slot)) {
        handleWwUploadAck(ws._deviceId, msg.slot, !!msg.ok, msg.err);
      }
      return;
    }

    // Voice-device OTA progress stream. Fan out to the device-owner's other
    // open WSes so any open Settings → Voice devices tab can show a progress
    // bar without polling. The originating WS is the device itself; we don't
    // echo it back. Phase strings come from oe_ota.c: "checking" |
    // "downloading" | "applying" | "rebooting" | "up_to_date" | "error".
    if (msg.type === 'ota_progress') {
      if (!ws._deviceId) return;
      const payload = {
        type: 'ota_progress',
        device_id: ws._deviceId,
        phase: typeof msg.phase === 'string' ? msg.phase : '',
        bytes_done: Number.isFinite(msg.bytes_done) ? msg.bytes_done : 0,
        total: Number.isFinite(msg.total) ? msg.total : 0,
        target_version: typeof msg.target_version === 'string' ? msg.target_version : null,
        err: typeof msg.err === 'string' ? msg.err : null,
      };
      const wire = JSON.stringify(payload);
      for (const client of _wss.clients) {
        if (client === ws) continue;
        if (client.readyState !== client.OPEN) continue;
        if (client._userId !== ws._userId) continue;
        // Skip other voice devices — they don't need each other's OTA status.
        if (client._deviceId) continue;
        try { client.send(wire); } catch {}
      }
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

    // Protected credential input — admin (or any tool) requested a secret
    // via the chat-protocol widget. The value never enters the LLM message
    // history; the server stores it (encrypted, for kind=api_key) or holds
    // it in RAM (sudo/confirm) and only the credentialId reaches the tool.
    if (msg.type === 'submit_credential') {
      const credentialId = typeof msg.credentialId === 'string' ? msg.credentialId : '';
      const value = typeof msg.value === 'string' ? msg.value : '';
      if (!credentialId || !value) {
        ws.send(JSON.stringify({ type: 'credential_error', credentialId, error: 'invalid_payload' }));
        return;
      }
      const result = await submitCredential({ credentialId, value, userId: ws._userId });
      if (!result.ok) {
        ws.send(JSON.stringify({ type: 'credential_error', credentialId, error: result.error }));
      }
      return;
    }
    if (msg.type === 'cancel_credential') {
      const credentialId = typeof msg.credentialId === 'string' ? msg.credentialId : '';
      if (credentialId) cancelCredential({ credentialId, userId: ws._userId });
      return;
    }

    if (msg.type === 'stop') {
      const stopAgent = typeof msg.agent === 'string' ? msg.agent : getUserCoordinatorAgentId(ws._userId);
      if (stopAgent) abortChat(ws._userId, stopAgent);
      return;
    }

    if (msg.type === 'alarm_fired') {
      // Device reports it started ringing. State transition: armed → firing.
      // Phase A4: this also cancels the ack-timeout watchdog (no fallback
      // email/telegram needed since device clearly received the arm).
      const id = typeof msg.id === 'string' ? msg.id : null;
      if (id) {
        const ok = markAlarmFired(ws._userId, id);
        console.log(`[alarm] fired ack from device=${ws._deviceId ?? '?'} id=${id} known=${ok}`);
      }
      return;
    }

    if (msg.type === 'alarm_acked') {
      // Device reports user-dismissed. Remove from registry.
      const id = typeof msg.id === 'string' ? msg.id : null;
      if (id) {
        const ok = markAlarmAcked(ws._userId, id);
        console.log(`[alarm] acked from device=${ws._deviceId ?? '?'} id=${id} known=${ok}`);
      }
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
      const wakeSlot = Number.isInteger(msg.wake_slot) ? msg.wake_slot : null;
      // wake_avg_prob is uint8 (0..255), 255 = ~1.0. Logged so app.log can be
      // grep'd for marginal-vs-confident wake fires when tuning per-slot cutoffs.
      if (ws._deviceId && wakeSlot !== null && Number.isInteger(msg.wake_avg_prob)) {
        log.info('voice', 'wake fired', {
          userId: ws._userId,
          deviceId: ws._deviceId,
          slot: wakeSlot,
          avgProb255: msg.wake_avg_prob,
          avgProb: Math.round((msg.wake_avg_prob / 255) * 1000) / 1000,
          textLen: typeof msg.text === 'string' ? msg.text.length : 0,
        });
      }
      // Resolve the effective user upfront so onEvent can broadcast chat
      // events to that user's WS connections (their browser tabs). Without
      // this, a wake-slot bound to user B routes the chat through B's
      // account server-side but the events still go only to A's WSes,
      // leaving B's UI silently empty.
      let effectiveUserId = ws._userId;
      let slotAssignment = null;
      if (ws._deviceId && wakeSlot !== null) {
        slotAssignment = getSlotAssignment(ws._userId, ws._deviceId, wakeSlot);
        if (slotAssignment) effectiveUserId = slotAssignment.ownerUserId;
      }
      // Avg-prob gate: drops wakes whose sliding-window avg probability
      // falls below the slot's `avg_prob_cutoff`. Firmware fires on PEAK
      // (its own `probability_cutoff`), so a single 0.96 frame followed by
      // lower frames can pass firmware but still be a brief cross-fire
      // (e.g. TTS playback). The avg metric catches those.
      //
      // Ambient-active BYPASS (NOT just relaxation): when the device has an
      // in-flight ambient stream, the user's own speaker is sustained-bleeding
      // into the mic. AEC catches most of it but the rolling avg sits in
      // the 0.80-0.90 range for the entire ambient duration. The original
      // 0.05 relaxation was way too timid — sustained ambient noise drags
      // the avg down for the FULL window the gate inspects, not just
      // briefly. Stop / volume commands during ambient are exactly when
      // the user needs the device to listen, and missed-stop is the worst
      // possible UX (the noise blocks the user from stopping the noise).
      //
      // Trust the firmware peak gate during ambient. False positives during
      // an actively-playing ambient stream are bounded — the user can
      // re-issue the command. False negatives are silent and catastrophic.
      if (slotAssignment
          && typeof slotAssignment.avg_prob_cutoff === 'number'
          && Number.isInteger(msg.wake_avg_prob)) {
        const ambientActive = ws._deviceId ? !!getAmbientForDevice(ws._deviceId) : false;
        const avg = msg.wake_avg_prob / 255;
        if (ambientActive) {
          // Log the pass for telemetry, but DON'T enforce the cutoff.
          log.info('voice', 'wake passed (ambient bypass)', {
            userId: ws._userId,
            deviceId: ws._deviceId,
            slot: wakeSlot,
            avgProb: Math.round(avg * 1000) / 1000,
            avgCutoff: slotAssignment.avg_prob_cutoff,
          });
        } else if (avg < slotAssignment.avg_prob_cutoff) {
          log.info('voice', 'wake gated (avg below cutoff)', {
            userId: ws._userId,
            deviceId: ws._deviceId,
            slot: wakeSlot,
            avgProb: Math.round(avg * 1000) / 1000,
            avgCutoff: slotAssignment.avg_prob_cutoff,
          });
          // Send a done event back so the device unblocks its chat UI even
          // though no LLM turn ran. agent name isn't critical — use 'system'.
          try { ws.send(JSON.stringify({ type: 'done', agent: 'system' })); } catch {}
          return;
        }
      }
      await handleChatMessage({
        userId:     ws._userId,
        agentId:    msg.agent,
        text:       msg.text,
        attachment: msg.attachment,
        // Source hint — voice-device chats get a slim tool subset for low
        // latency. See chat-dispatch.mjs VOICE_DEVICE_TOOL_ALLOWLIST.
        source:     typeof msg.source === 'string' ? msg.source : null,
        // Voice-device routing context: deviceId comes from the auth session;
        // wakeSlot is set on the chat message by the firmware when a wake
        // word fires. chat-dispatch resolves slot_assignments and dispatches
        // as the slot's owner user (running their cortex memory + agents).
        deviceId:   ws._deviceId,
        wakeSlot:   wakeSlot,
        // Chat events fan out two ways:
        //   (1) Back to the originating ws — the device gets TTS chunks,
        //       status updates, etc. regardless of whose user is "acting."
        //   (2) Broadcast to all of the EFFECTIVE user's other WSes so the
        //       chat history shows up in their browser tabs.
        // When effectiveUserId == ws._userId (single-user case), step (2)
        // delivers to admin's other browser tabs the same way as before.
        onEvent: (e) => {
          // Voice-device fan-out: the firmware only TTS's `token` events
          // (oe_ws.c emits OE_WS_EVT_CHAT_TOKEN → speak). Plain `error`
          // events arrive but are silently dropped, so a turn that errors
          // out (e.g. ChatGPT 401 token_invalidated → "please reconnect")
          // leaves the device blinking with no audible feedback. Convert
          // error → token + done for the originating voice device so the
          // message is actually spoken. Other tabs/clients still see the
          // raw `error` so the UI can render it appropriately.
          const isVoiceOrigin = !!ws._deviceId;
          if (ws.readyState === ws.OPEN) {
            try {
              if (isVoiceOrigin && e?.type === 'error' && typeof e.message === 'string' && e.message.trim()) {
                ws.send(JSON.stringify({ type: 'token', text: e.message, agent: e.agent ?? 'system' }));
                ws.send(JSON.stringify({ type: 'done', agent: e.agent ?? 'system' }));
              } else {
                ws.send(JSON.stringify(e));
              }
            } catch {}
          }
          for (const client of _wss.clients) {
            if (client === ws) continue;
            if (client._userId !== effectiveUserId) continue;
            if (client.readyState !== client.OPEN) continue;
            // Never fan chat events out to a voice device that didn't
            // originate the chat. Without this, typing into a browser tab
            // streams tokens to every paired speaker, which accumulates
            // them into sentences and plays TTS — see 2026-05-15 report.
            // Voice devices only speak replies to their own wake-triggered
            // chats; the originating device already received the event via
            // the ws.send above.
            if (client._deviceId) continue;
            try { client.send(typeof e === 'string' ? e : JSON.stringify(e)); } catch {}
          }
        },
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

/**
 * Send a message to a specific voice-device's WS connection. Returns
 * the count of frames sent — 0 means the device is offline or unknown.
 * Used for OTA wake-word delivery (ww_upload) and any future device-
 * scoped pushes.
 */
export function sendToDevice(deviceId, msg) {
  if (!_wss || !deviceId) return 0;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  let delivered = 0;
  let sendError = null;
  for (const client of _wss.clients) {
    if (client.readyState === client.OPEN && client._deviceId === deviceId) {
      try { client.send(data); delivered++; }
      catch (e) { sendError = e.message; }
    }
  }
  // Trace every voice-device send so silent failures (device offline,
  // WS write threw, deviceId typo) are visible. Always-on — these are
  // event-driven control messages, not chatty enough to log-spam.
  const type = (typeof msg === 'object' && msg && typeof msg.type === 'string') ? msg.type : 'string-msg';
  const tail = sendError ? ` error=${sendError}` : '';
  console.log(`[ws-send] device=${deviceId} type=${type} delivered=${delivered} bytes=${data.length}${tail}`);
  return delivered;
}

/**
 * True if this voice-device id has at least one OPEN WS client right now.
 * Source of truth for the live "connected" indicator in the Voice Devices UI.
 * Cheap — iterates the WS client set, no per-call DB read.
 */
export function isDeviceOnline(deviceId) {
  if (!_wss || !deviceId) return false;
  for (const client of _wss.clients) {
    if (client.readyState === client.OPEN && client._deviceId === deviceId) return true;
  }
  return false;
}

/**
 * If this client is a voice-device WS and the user's voice-config has
 * advanced since the last push to this device, OTA-resend the wake words
 * for every configured slot. Skips silently for browser sessions and for
 * voice devices already on the current version (avoids unnecessary
 * SPIFFS writes on every reconnect).
 *
 * Async because pushConfigToDevice serializes per-slot sends and awaits
 * the device's ww_upload_ack between them. Only marks the version pushed
 * if EVERY configured slot acked ok — a single offline/timeout/failure
 * leaves the version stale so the next reconnect retries the rest.
 */
async function maybePushVoiceConfig(ws) {
  if (!ws?._deviceId || !ws?._userId) return;
  try {
    const cfg = readVoiceConfig(ws._userId);
    const lastPushed = getDeviceVoiceConfigVersion(ws._userId, ws._deviceId);
    // Always push on every WS (re)connect — a boot can wipe NVS without the
    // server knowing, so the version-match optimization was misleading us
    // into skipping pushes after real device reboots. Bandwidth cost is
    // amortized across rare-event boots; the device's per-slot ack throttle
    // already keeps the push from overrunning the firmware's WS recv path.
    const isSameVersion = lastPushed === cfg.version;
    if (isSameVersion) {
      console.log(`[ws] voice-config push to ${ws._deviceId}: version unchanged (v${cfg.version}) but pushing anyway in case device NVS was reset`);
    }
    const r = await pushConfigToDevice(ws._deviceId, ws._userId);
    const fullySucceeded =
      r.pushedSlots.length > 0 &&
      r.offlineSlots.length === 0 &&
      r.failedSlots.length === 0 &&
      r.ackedSlots.length === r.pushedSlots.length;
    if (fullySucceeded) {
      markVoiceConfigPushed(ws._userId, ws._deviceId, cfg.version);
      console.log(`[ws] voice-config v${cfg.version} pushed+acked by ${ws._deviceId} (slots ${r.ackedSlots.join(',')})`);
    } else if (r.pushedSlots.length > 0) {
      console.warn(`[ws] voice-config v${cfg.version} partial push to ${ws._deviceId}: acked=${r.ackedSlots.join(',') || '-'} failed=${r.failedSlots.map(f=>f.slot+':'+f.err).join(',') || '-'} offline=${r.offlineSlots.join(',') || '-'}`);
    }
  } catch (e) {
    console.warn(`[ws] voice-config push to ${ws._deviceId} failed: ${e.message}`);
  }
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
