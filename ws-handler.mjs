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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// OE Default Pocket TTS voice — bundled offline voice-state (.safetensors)
// fetched by install-pocket-tts.sh. Used when a slot has no cloned voice and
// no global default is set, so new users get a working voice with no HF/network.
const OE_DEFAULT_VOICE_STATE = path.join(os.homedir(), '.openensemble', 'models', 'tts', 'pocket-tts', 'default-voice.safetensors');
import { getAgentScope } from './agents.mjs';

// Boot identity — fresh random value every server start. Sent to browser
// clients on agent_list and to any client on pong so they can detect a
// server restart unambiguously even when their TCP socket appears healthy.
// Voice devices don't receive agent_list (they only need to connect and
// run wake words); if firmware ever wants restart detection, the pong
// path carries boot_id.
const BOOT_ID = randomBytes(8).toString('hex');
console.log(`[ws] boot_id: ${BOOT_ID}`);
import { handleChatMessage, abortChat, getActiveStreams } from './chat-dispatch.mjs';
import { getActiveTasks as getActiveBgTasks } from './background-tasks.mjs';
import { loadSession, clearSession, appendToSession, getStreamBuffer } from './sessions.mjs';
import { markAlarmFired, markAlarmAcked } from './lib/alarms.mjs';
import { initNodeWss, initTerminalWss } from './routes/nodes.mjs';
import {
  getAgentsForUser, agentToWire, getUser, getUserCoordinatorAgentId,
  getSessionUserId, getAuthToken, resolveShareGroup, loadConfig,
} from './routes/_helpers.mjs';
import { getVoiceRef } from './lib/voice-refs.mjs';
import { createVoiceTtsStreamer } from './lib/voice-tts-stream.mjs';
import { getSessionMeta, setSessionDeviceId, adoptSession } from './routes/_helpers/auth-sessions.mjs';
import { getSlotAssignment, findDeviceByTokenPrefix, findDeviceByTokenAnyUser, recordTokenSecret, getDeviceVoiceConfigVersion, markVoiceConfigPushed, touchDevice, getDevice, recordDeviceOtaProgress } from './lib/voice-devices.mjs';
import { getAmbientForDevice, dropAmbientForDevice } from './routes/devices.mjs';
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

// Auto-recover a paired voice device whose session token expired. A voice device
// stores its token in NVS and just keeps presenting it; the server prunes the
// session after the inactivity window, so a device powered off for a while comes
// back unable to authenticate. Rather than force a re-pair, verify the presented
// token against the device registry (full sha256 hash, or a one-time legacy
// 8-char-prefix fallback for pre-hash devices) and revive the exact token. The
// rate limiter bounds brute-forcing the legacy 32-bit prefix path.
const RECOVER_WINDOW_MS = 60_000;
const RECOVER_MAX_PER_WINDOW = 30;
let _recoverWindowStart = 0;
let _recoverCount = 0;
function tryRecoverDeviceSession(token) {
  if (!token) return null;
  const now = Date.now();
  if (now - _recoverWindowStart > RECOVER_WINDOW_MS) { _recoverWindowStart = now; _recoverCount = 0; }
  if (_recoverCount >= RECOVER_MAX_PER_WINDOW) return null; // throttle — fail closed
  _recoverCount++;
  const match = findDeviceByTokenAnyUser(token);
  if (!match) return null;
  adoptSession(token, { userId: match.userId, deviceId: match.device.id, kind: 'voice-device' });
  recordTokenSecret(match.userId, match.device.id, token); // backfill hash → strong from here on
  return match;
}
import { log } from './logger.mjs';

// maxPayload: cap each frame at 2 MiB so a malicious client can't force the
// server to buffer arbitrarily large messages. 2 MiB still fits large chat
// messages, base64 screenshots, and attachments we expect in normal use.
const WS_MAX_PAYLOAD = 2 * 1024 * 1024;
const WS_PING_INTERVAL = 15000; // 15s — aggressive enough for mobile carriers
// Tolerate this many consecutive missed pongs before terminating. Terminating
// after a SINGLE missed pong (the old behavior) kills voice-device sockets on a
// transient 2.4 GHz Wi-Fi hiccup, causing constant reconnect flapping. 3 misses
// ≈ 45 s grace — still reaps truly-dead connections, but rides out brief loss.
const WS_MAX_MISSED_PONGS = 3;
// Debounce window for re-pushing an UNCHANGED voice-config to a device that
// reconnects. A same-version push makes the device run esp_spiffs_gc + rewrite
// ~62 KB/slot + wakeword_load_slot (which tears down + rebuilds the model, and
// esp_restart()s the device if the reload fails — see main.c apply_ww_upload).
// Doing that on EVERY reconnect turns a flapping Wi-Fi link into an all-night
// reboot/reconnect storm (observed 2026-06-22: ambient streaming → WS drop →
// reconnect → re-push → reload-fail → reboot → repeat, leaving the device deaf
// to the wake phrase. A real config change (version bump) is never debounced —
// only identical re-pushes whose sole purpose is "in case NVS was reset" are.
const VOICE_CONFIG_REPUSH_DEBOUNCE_MS = 10 * 60 * 1000; // 10 min
// key `${userId}:${deviceId}` -> { at, version } of the last actual push.
const _lastVoiceConfigPush = new Map();
const VOICE_CONFIG_PUSH_CONNECT_DELAY_MS = 1500;
// Per-user concurrent WebSocket cap. A compromised account (or a buggy
// reconnect loop) shouldn't be able to hoard server sockets — each open
// connection costs a heartbeat timer slot and keepalive memory.
const MAX_WS_PER_USER = 20;
const VOICE_STOP_SUPPRESS_MS = 30_000;
const VOICE_ERROR_FALLBACK = 'Something went wrong.';

let _wss = null;
let _nodeWss = null;
let _termWss = null;
let _browserExtWss = null;
let _desktopWss = null;

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

function wsClientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null;
}

function enforceWsCap(ws) {
  if (!ws._userId) return true;
  let count = 0;
  for (const c of _wss.clients) {
    if (c === ws) continue;
    if (c.readyState !== c.OPEN && c.readyState !== c.CONNECTING) continue;
    if (c._userId === ws._userId) count++;
  }
  if (count >= MAX_WS_PER_USER) {
    ws.send(JSON.stringify({ type: 'error', message: 'Too many concurrent connections' }));
    ws.close(4008, 'Connection cap reached');
    return false;
  }
  return true;
}

function closeOlderDeviceSockets(ws) {
  if (!_wss || !ws?._deviceId) return 0;
  let closed = 0;
  for (const c of _wss.clients) {
    if (c === ws) continue;
    if (c._deviceId !== ws._deviceId) continue;
    if (c.readyState !== c.OPEN && c.readyState !== c.CONNECTING) continue;
    try { c.close(4009, 'Superseded by newer device connection'); } catch {}
    setTimeout(() => {
      try {
        if (c.readyState !== c.CLOSED) c.terminate();
      } catch {}
    }, 1000).unref?.();
    closed++;
  }
  if (closed) log.info('ws', 'closed older voice-device socket(s)', { userId: ws._userId, deviceId: ws._deviceId, closed });
  return closed;
}

function reconcileVoiceDeviceState(ws) {
  if (!ws?._deviceId || !ws?._userId) return;
  const d = getDevice(ws._userId, ws._deviceId);
  if (!d) return;
  try {
    if (d.name) sendToDevice(ws._deviceId, { type: 'set_device_name', name: d.name });
    sendToDevice(ws._deviceId, { type: 'set_headphone_mode', enabled: !!d.headphone_mode });
  } catch (e) {
    console.warn(`[ws] device-state reconcile failed for ${ws._deviceId}: ${e.message}`);
  }
}

function scheduleVoiceConfigPush(ws) {
  if (!ws?._deviceId || !ws?._userId) return;
  if (ws._voiceConfigPushTimer) clearTimeout(ws._voiceConfigPushTimer);
  ws._voiceConfigPushTimer = setTimeout(() => {
    ws._voiceConfigPushTimer = null;
    if (ws.readyState !== ws.OPEN || !ws._authenticated || !ws._deviceId) return;
    maybePushVoiceConfig(ws);
  }, VOICE_CONFIG_PUSH_CONNECT_DELAY_MS);
  ws._voiceConfigPushTimer.unref?.();
}

const sessionKey = (userId, agentId) => `${userId}_${agentId}`;

function makeVoiceTurn({ ws, effectiveUserId, agentId, wakeSlot }) {
  if (!ws?._deviceId) return null;
  return {
    id: randomBytes(4).toString('hex'),
    deviceId: ws._deviceId,
    authUserId: ws._userId,
    effectiveUserId,
    agentId,
    wakeSlot,
    startedAt: Date.now(),
  };
}

function suppressVoiceOutput(ws, reason, { sendDone = false } = {}) {
  if (!ws?._deviceId) return null;
  const active = ws._activeVoiceTurn ?? null;
  const streamer = ws._ttsStreamer ?? null;
  const hadStreamer = !!streamer;
  try { streamer?.abort?.({ close: true, sendDone }); } catch {
    try { streamer?.abort?.(); } catch {}
  }
  ws._ttsStreamer = null;
  ws._voiceOutputSuppression = {
    turnId: active?.id ?? null,
    until: Date.now() + VOICE_STOP_SUPPRESS_MS,
    reason,
  };

  let abortedChat = false;
  if (active?.effectiveUserId && active?.agentId) {
    abortChat(active.effectiveUserId, active.agentId);
    abortedChat = true;
  }

  if (sendDone && !hadStreamer && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify({ type: 'done', agent: active?.agentId ?? 'system' })); } catch {}
  }

  log.info('voice', 'voice output suppressed', {
    reason,
    deviceId: ws._deviceId,
    turnId: active?.id ?? null,
    authUserId: active?.authUserId ?? ws._userId ?? null,
    effectiveUserId: active?.effectiveUserId ?? null,
    agentId: active?.agentId ?? null,
    wakeSlot: active?.wakeSlot ?? null,
    hadStreamer,
    abortedChat,
    sentDone: !!sendDone,
  });
  return active;
}

function isVoiceOutputSuppressed(ws, turn) {
  if (!ws?._deviceId) return false;
  const s = ws._voiceOutputSuppression;
  if (!s) return false;
  if (turn?.id && s.turnId === turn.id) return true;
  return !s.turnId && Date.now() < s.until;
}

export function initWs(httpServer) {
  _wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  _nodeWss = initNodeWss();
  _termWss = initTerminalWss();
  _browserExtWss = initBrowserExtWss();
  _desktopWss = initDesktopWss();

  attachWsUpgrade(httpServer);

  // Server-side heartbeat — keeps mobile connections alive across NAT/proxy
  const heartbeat = setInterval(() => {
    for (const client of _wss.clients) {
      client._missedPongs = (client._missedPongs || 0) + 1;
      if (client._missedPongs >= WS_MAX_MISSED_PONGS) {
        // Server-initiated termination — logged distinctly from a client-side
        // close so we can tell whether OE's heartbeat is dropping a device vs.
        // the device dropping itself.
        log.info('ws', 'terminating unresponsive client', { userId: client._userId, deviceId: client._deviceId ?? null, missedPongs: client._missedPongs, intervalMs: WS_PING_INTERVAL });
        client.terminate();
        continue;
      }
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
    // Browser extensions, desktop apps, and node agents are NOT same-origin
    // (extension origin is chrome-extension://<id>; native clients usually
    // have no Origin). Auth for these paths happens via the first-message
    // token instead, so they skip the same-origin gate.
    const isExternalClientPath =
      pathname === '/ws/nodes' ||
      pathname === '/ws/nodes/terminal' ||
      pathname === '/ws/browser-ext' ||
      pathname === '/ws/desktop';
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
    } else if (pathname === '/ws/desktop') {
      _desktopWss.handleUpgrade(req, socket, head, ws => _desktopWss.emit('connection', ws, req));
    } else {
      _wss.handleUpgrade(req, socket, head, ws => _wss.emit('connection', ws, req));
    }
  });
}

// Desktop app WS lifecycle. Desktop clients connect outbound from the user's
// computer and execute local sandbox tools on behalf of OE agents.
function initDesktopWss() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  wss.on('connection', async (ws, req) => {
    ws._missedPongs = 0;
    ws._authenticated = false;
    ws._desktopClientId = null;
    ws.on('pong', () => { ws._missedPongs = 0; });

    const { registerDesktop, dropDesktop, handleDesktopResult, updateDesktopStatus } = await import('./lib/desktop-bus.mjs');

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
      if (c._missedPongs >= WS_MAX_MISSED_PONGS) { c.terminate(); continue; }
      try { c.ping(); } catch {}
    }
  }, WS_PING_INTERVAL);
  wss.on('close', () => clearInterval(hb));

  return wss;
}

// Browser extension WS lifecycle. Auth happens via first-message token —
// the extension stores the user's OE auth token at setup time and sends it
// as the first frame. Subsequent frames are bus messages (register, result,
// tabs_update, ping). See lib/browser-bus.mjs.
function initBrowserExtWss() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  wss.on('connection', async (ws, req) => {
    ws._missedPongs = 0;
    ws._authenticated = false;
    ws._extId = null;
    ws.on('pong', () => { ws._missedPongs = 0; });

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
      // Clear the chat session for the Browser Tutor (or coordinator
      // fallback). Lets the side panel "Clear" button wipe BOTH the local
      // rendered chat AND the server-side session, so the LLM starts
      // fresh — important because the Tutor's reasoning otherwise
      // pattern-matches off the running thread ("still no events
      // captured") instead of actually re-querying browser_observe.
      if (msg.type === 'chat_clear_session') {
        try {
          const { getRoleAssignments } = await import('./roles.mjs');
          const tutorAgentId = getRoleAssignments(ws._userId)?.['role_browser_tutor'] || null;
          const rawAgentId = tutorAgentId || getUserCoordinatorAgentId(ws._userId);
          const { clearSession } = await import('./sessions.mjs');
          clearSession(`${ws._userId}_${rawAgentId}`);
          try { ws.send(JSON.stringify({ type: 'chat_session_cleared', agentId: rawAgentId })); } catch {}
        } catch (e) {
          try { ws.send(JSON.stringify({ type: 'error', message: 'session clear failed: ' + (e?.message || String(e)) })); } catch {}
        }
        return;
      }
      // Chat from the extension popup / side panel — routes to the user's
      // **Browser Tutor** if they've assigned the role_browser_tutor
      // role to an agent. Otherwise falls back to the coordinator. The
      // Browser Tutor exists specifically to keep teach-mode chats fast
      // — only browser primitives, no specialist tool clutter, no
      // ask_agent delegation. If unassigned, the coordinator handles it
      // with the full toolset (slower but always available).
      if (msg.type === 'chat' && typeof msg.text === 'string') {
        const requestId = String(msg.requestId || Date.now());
        try {
          const { getRoleAssignments } = await import('./roles.mjs');
          const tutorAgentId =
            getRoleAssignments(ws._userId)?.['role_browser_tutor'] ||
            null;
          const targetAgentId = tutorAgentId || getUserCoordinatorAgentId(ws._userId);
          const { handleChatMessage } = await import('./chat-dispatch.mjs');
          await handleChatMessage({
            userId: ws._userId,
            agentId: targetAgentId,
            text: msg.text,
            source: 'browser-ext',
            onEvent: (ev) => {
              try {
                ws.send(JSON.stringify({ type: 'chat_event', requestId, event: ev }));
              } catch {}
            },
          });
          try { ws.send(JSON.stringify({ type: 'chat_done', requestId, agentId: targetAgentId })); } catch {}
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
      c._missedPongs = (c._missedPongs || 0) + 1;
      if (c._missedPongs >= WS_MAX_MISSED_PONGS) { c.terminate(); continue; }
      try { c.ping(); } catch {}
    }
  }, WS_PING_INTERVAL);
  wss.on('close', () => clearInterval(hb));

  return wss;
}

export function getBrowserExtClientCount() { return _browserExtWss?.clients?.size ?? 0; }

function onConnection(ws, req) {
  try { ws._socket?.setKeepAlive?.(true, WS_PING_INTERVAL); } catch {}
  ws._clientIp = wsClientIp(req);
  const desktopHeader = String(req.headers['x-openensemble-desktop-app'] || '').trim() === '1';
  const desktopUa = /\bOpenEnsembleDesktop\b/i.test(String(req.headers['user-agent'] || ''));
  ws._clientSource = desktopHeader || desktopUa ? 'desktop-app' : null;
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
    if (ws._deviceId) closeOlderDeviceSockets(ws);
    if (!enforceWsCap(ws)) return;
  } else {
    // New path: require auth via first message
    ws._authenticated = false;
  }

  ws._missedPongs = 0;
  ws.on('pong', () => { ws._missedPongs = 0; });

  // Send initial data once authenticated. We log only user id — never the
  // raw request URL, which may contain a legacy ?token= that would otherwise
  // land in logs / ship to log aggregators in plaintext.
  async function sendInitialData() {
    console.log('[ws] client connected, user:', ws._userId, 'device:', ws._deviceId ?? '-', 'source:', ws._clientSource ?? '-');
    log.info('ws', 'client connected', { userId: ws._userId, deviceId: ws._deviceId ?? null, source: ws._clientSource ?? null });
    // Voice devices get nothing here. They only upstream wake-word/STT
    // chats and consume control + TTS frames (firmware oe_client/oe_ws.c
    // handle_message; main.c has no agent_list handler and never reads
    // boot_id — restart detection, if ever needed, rides on pong). Shipping
    // agent_list + every agent's last-60 messages (~1 MB measured on a
    // 16-agent user) on every reconnect forced the ESP32 to grow a
    // never-shrinking heap accumulator per fragmented frame and burned
    // marginal-Wi-Fi airtime exactly when the link was already flapping.
    if (ws._deviceId) return;
    const userAgents = getAgentsForUser(ws._userId);
    ws.send(JSON.stringify({ type: 'agent_list', agents: userAgents.map(agentToWire), boot_id: BOOT_ID }));
    // Load every agent's session in parallel — loadSession is async since
    // the previous commit; the prior serial sync version was 5+ blocking
    // reads at WS connect time. Parallel async makes total wall time =
    // the slowest single read, not the sum.
    const sessionLoads = await Promise.all(userAgents.map(async (agent) => {
      const key = sessionKey(ws._userId, agent.id);
      return { agent, messages: await loadSession(key, 60), pendingStream: getStreamBuffer(key) };
    }));
    for (const { agent, messages, pendingStream } of sessionLoads) {
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
    if (ws._deviceId) {
      touchDevice(ws._userId, ws._deviceId);
      reconcileVoiceDeviceState(ws);
      scheduleVoiceConfigPush(ws);
    }
  }

  ws.on('message', async (raw) => {
   // Hoisted above the try so the catch below can tell chat failures apart
   // from other frame types when picking the device-spoken fallback.
   let msg;
   let messageVoiceTurn = null;
   try {
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
      let meta = getSessionMeta(msg.token);
      let userId = meta?.userId ?? null;
      let recoveredDeviceId = null;
      if (!userId) {
        // Expired voice-device token? Verify against the device registry and
        // revive it instead of dropping the device (which then can't reconnect
        // without a manual re-pair).
        try {
          const match = tryRecoverDeviceSession(msg.token);
          if (match) {
            userId = match.userId;
            recoveredDeviceId = match.device.id;
            meta = getSessionMeta(msg.token); // now resolves to the revived session
            console.log(`[ws] auto-recovered voice device ${match.device.id} (user ${match.userId}, ${match.strong ? 'hash' : 'legacy-prefix'} match) — revived expired session`);
            log.info('ws', 'voice device session auto-recovered', { userId: match.userId, deviceId: match.device.id, match: match.strong ? 'hash' : 'prefix' });
          }
        } catch (e) { console.warn('[ws] device auto-recover failed:', e.message); }
      }
      if (!userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        ws.close(4001, 'Unauthorized');
        return;
      }
      ws._userId = userId;
      ws._deviceId = recoveredDeviceId ?? resolveDeviceId(msg.token, meta);
      ws._authenticated = true;
      if (ws._deviceId) closeOlderDeviceSockets(ws);
      if (!enforceWsCap(ws)) return;
      sendInitialData();
      if (ws._deviceId) {
        // Firmware reports its running version on auth (since 0.2.3). Store
        // it on the device record so the UI can show "Update available"
        // when manifest.version > device.fw_version. Persist it BEFORE the
        // voice-config push so the push's clear-pass gate (fwSupportsClear)
        // sees the just-reported version — otherwise the first reconnect
        // after an OTA up to 0.2.48 would still read the stale older version
        // and skip clears for one extra round-trip.
        const fwReported = typeof msg.firmware_version === 'string' && msg.firmware_version.length > 0
            ? msg.firmware_version.slice(0, 64) : null;
        const muteReported = typeof msg.mute_state === 'boolean' ? msg.mute_state : undefined;
        if (typeof muteReported === 'boolean') ws._voiceMuteState = muteReported;
        touchDevice(ws._userId, ws._deviceId, {
          ...(fwReported ? { fw_version: fwReported } : {}),
          ...(typeof muteReported === 'boolean' ? { mute_state: muteReported } : {}),
        });
        // Backfill the token's sha256 so a future expiry can be auto-recovered by
        // strong hash match. Idempotent — only writes when the token changes.
        recordTokenSecret(ws._userId, ws._deviceId, msg.token);
        reconcileVoiceDeviceState(ws);
      }
      scheduleVoiceConfigPush(ws);
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

    // Device tore down ambient on its own (fw >= 0.2.62 sends this on
    // physical mute). Drop the server-side session — marker, TTL timer, and
    // in-flight ffmpeg pipe — or getAmbientForDevice keeps reporting it
    // active and the wake-mid-ambient resume logic resurrects the "muted
    // away" ambient after the next turn (the zombie-ambient bug).
    if (msg.type === 'ambient_stopped') {
      if (!ws._deviceId) return;
      const had = !!getAmbientForDevice(ws._deviceId);
      dropAmbientForDevice(ws._deviceId);
      const reason = typeof msg.reason === 'string' ? msg.reason : null;
      const active = ws._activeVoiceTurn ?? null;
      if (active) suppressVoiceOutput(ws, reason || 'ambient_stopped', { sendDone: true });
      log.info('voice', 'device stopped ambient', {
        deviceId: ws._deviceId,
        reason,
        hadServerSession: had,
        activeTurnId: active?.id ?? null,
      });
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
      recordDeviceOtaProgress(ws._userId, ws._deviceId, payload);
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

    if (msg.type === 'tool_plan_remember') {
      try {
        const { rememberToolPlan } = await import('./lib/tool-plan-memory.mjs');
        const r = rememberToolPlan(ws._userId, {
          agentId: msg.agentId || msg.agent,
          phrase: msg.phrase,
          selectedTools: msg.selectedTools,
          mode: msg.mode,
          source: msg.source || 'chat-ui',
        });
        ws.send(JSON.stringify({ type: 'tool_plan_remembered', ok: !!r.ok, error: r.error || null, recipeId: r.recipe?.id || null }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'tool_plan_remembered', ok: false, error: e.message || String(e) }));
      }
      return;
    }

    if (msg.type === 'stop') {
      // Barge-in / mute: halt any in-flight server-side TTS push immediately so
      // the device stops getting audio frames, then abort the LLM turn.
      if (ws._deviceId) {
        const stoppedTurn = suppressVoiceOutput(ws, 'stop', { sendDone: true });
        if (!stoppedTurn) {
          const stopAgent = typeof msg.agent === 'string' ? msg.agent : getUserCoordinatorAgentId(ws._userId);
          if (stopAgent) abortChat(ws._userId, stopAgent);
        }
      } else {
        const stopAgent = typeof msg.agent === 'string' ? msg.agent : getUserCoordinatorAgentId(ws._userId);
        if (stopAgent) abortChat(ws._userId, stopAgent);
      }
      return;
    }

    if (msg.type === 'alarm_fired') {
      // Device reports it started ringing. State transition: armed → firing.
      // Phase A4: this also cancels the ack-timeout watchdog (no fallback
      // email/telegram needed since device clearly received the arm).
      const id = typeof msg.id === 'string' ? msg.id : null;
      if (id) {
        const ok = markAlarmFired(ws._userId, id, ws._deviceId ?? null);
        console.log(`[alarm] fired ack from device=${ws._deviceId ?? '?'} id=${id} known=${ok}`);
      }
      return;
    }

    if (msg.type === 'alarm_acked') {
      // Device reports user-dismissed. Remove from registry.
      const id = typeof msg.id === 'string' ? msg.id : null;
      if (id) {
        const ok = markAlarmAcked(ws._userId, id, ws._deviceId ?? null);
        console.log(`[alarm] acked from device=${ws._deviceId ?? '?'} id=${id} known=${ok}`);
      }
      return;
    }

    if (msg.type === 'load_session') {
      const agentId = msg.agent;
      if (agentId) {
        const messages = await loadSession(sessionKey(ws._userId, agentId), 60);
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
      const devicePrefs = ws._deviceId ? getDevice(ws._userId, ws._deviceId) : null;
      const deviceSpeakReplies = !ws._deviceId || devicePrefs?.speak_replies !== false;
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
      const routedAgentId = slotAssignment
        ? (slotAssignment.agentId || getUserCoordinatorAgentId(effectiveUserId))
        : (msg.agent || devicePrefs?.default_agent_id || getUserCoordinatorAgentId(effectiveUserId));
      const voiceTurn = makeVoiceTurn({ ws, effectiveUserId, agentId: routedAgentId, wakeSlot });
      if (voiceTurn) {
        messageVoiceTurn = voiceTurn;
        ws._activeVoiceTurn = voiceTurn;
        // A new wake = a fresh turn whose output must play. Clear any stale
        // suppression from a prior stop/barge-in — otherwise a suppression
        // recorded with a null turnId (stop on a socket with no active turn,
        // e.g. after reconnect) blanket-drops this turn's audio for 30s.
        ws._voiceOutputSuppression = null;
        log.info('voice', 'voice turn started', {
          deviceId: voiceTurn.deviceId,
          turnId: voiceTurn.id,
          authUserId: voiceTurn.authUserId,
          effectiveUserId: voiceTurn.effectiveUserId,
          agentId: voiceTurn.agentId,
          wakeSlot: voiceTurn.wakeSlot,
        });
      }
      // Server-side voice TTS streaming: when the device advertises the
      // capability (msg.tts_stream) and the provider is Pocket TTS, the server
      // segments + synthesizes + pushes PCM audio frames itself (see
      // lib/voice-tts-stream.mjs). The device plays them as a dumb stream — no
      // on-device sentence accumulation / per-sentence pull / drain race. Old
      // firmware omits msg.tts_stream and keeps the legacy `token` path.
      let ttsStreamer = null;
      // A device plays exactly one reply at a time. If a previous turn's
      // streamer is still pumping (a barge-in chat that raced the stop
      // frame, or an overlapping announcement), kill it before wiring a
      // new one — two live pumps interleave frames into the same I²S ring.
      if (ws._deviceId) { try { ws._ttsStreamer?.abort({ close: true, sendDone: true }); } catch {} ws._ttsStreamer = null; }
      try {
        const _cfg = loadConfig();
        if (deviceSpeakReplies && msg.tts_stream === true && ws._deviceId && _cfg.ttsProvider === 'pocket-tts') {
          const deviceVoice = devicePrefs?.tts_voice && devicePrefs.tts_voice !== 'alloy' ? devicePrefs.tts_voice : null;
          let v = (slotAssignment?.ttsVoice) || deviceVoice || _cfg.ttsVoice || '';
          let refPath = null, presetVoice = null;
          if (typeof v === 'string' && v.startsWith('ref_')) {
            const ref = getVoiceRef(ws._userId, v);   // refs owned by the auth (device-paired) user
            if (ref) refPath = ref.wavPath;
          }
          if (!refPath && (!v || v === 'default-en' || v === 'default')) {
            // OE Default — bundled offline voice-state. Covers a slot with no
            // cloned voice, an empty global default, or the legacy F5 'default-en'.
            if (fs.existsSync(OE_DEFAULT_VOICE_STATE)) refPath = OE_DEFAULT_VOICE_STATE;
          }
          if (!refPath && !presetVoice) {
            // A real preset name → use it; otherwise OE Default if present, else a catalog preset.
            if (v && !v.startsWith('ref_')) presetVoice = v;
            else if (fs.existsSync(OE_DEFAULT_VOICE_STATE)) refPath = OE_DEFAULT_VOICE_STATE;
            else presetVoice = 'george';
          }
          ttsStreamer = createVoiceTtsStreamer({
            send: (m) => { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(m)); } catch {} } },
            isOpen: () => ws.readyState === ws.OPEN,
            cfg: _cfg, refPath, voice: presetVoice, log,
          });
          ws._ttsStreamer = ttsStreamer;
        }
      } catch (e) { log.warn('voice-tts', 'streamer setup failed', { error: e.message }); ttsStreamer = null; }

      await handleChatMessage({
        userId:     ws._userId,
        // Empty string → undefined so chat-dispatch's coordinator fallback
        // kicks in (?? only catches nullish). Voice devices with no default
        // agent configured send no agent field at all (fw >= 0.2.62), but an
        // explicit "" from any client should mean "coordinator" too.
        agentId:    msg.agent || undefined,
        text:       msg.text,
        attachment: msg.attachment,
        toolPlan:   msg.toolPlan,
        // Source hint — voice-device chats get a slim tool subset for low
        // latency (chat-dispatch.mjs VOICE_DEVICE_TOOL_ALLOWLIST); desktop-app
        // origin keeps the desktop_* tools past the router. The desktop app's
        // shell reuses the web UI, whose every message says source:'chat-ui' —
        // the connection-level desktop-app tag (set from the
        // x-openensemble-desktop-app header at upgrade) must win over that
        // generic value or the desktop origin is masked.
        source:     ws._clientSource === 'desktop-app' && (typeof msg.source !== 'string' || msg.source === 'chat-ui')
                      ? 'desktop-app'
                      : (typeof msg.source === 'string' ? msg.source : (ws._clientSource ?? null)),
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
          // events arrive but are silently dropped. Keep voice errors short
          // and generic, and never speak them after physical stop/mute.
          // Other tabs/clients still see the raw `error` so the UI can
          // render it appropriately.
          const isVoiceOrigin = !!ws._deviceId;
          const voiceSuppressed = isVoiceOrigin && isVoiceOutputSuppressed(ws, voiceTurn);
          const staleVoiceTurn = isVoiceOrigin && voiceTurn && ws._activeVoiceTurn?.id !== voiceTurn.id;
          const voiceSilent = isVoiceOrigin && !deviceSpeakReplies;
          if (ttsStreamer && isVoiceOrigin) {
            // Streaming path: the server synthesizes + pushes tts_audio frames;
            // the device never receives raw token/done. Route the text through
            // the streamer; pass status/other events through unchanged.
            if (voiceSuppressed || staleVoiceTurn || voiceSilent) {
              try { ttsStreamer.abort(); } catch {}
            } else if (e?.type === 'token' && typeof e.text === 'string') ttsStreamer.pushText(e.text);
            else if (e?.type === 'done') ttsStreamer.finish();
            else if (e?.type === 'error' && typeof e.message === 'string' && e.message.trim()) { ttsStreamer.pushText(VOICE_ERROR_FALLBACK); ttsStreamer.finish(); }
            else if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(e)); } catch {} }
          } else if (ws.readyState === ws.OPEN) {
            try {
              if (isVoiceOrigin && (voiceSuppressed || staleVoiceTurn)) {
                // Stop/mute already sent `done`; old-turn events must not
                // leak into the device after a new wake has started.
              } else if (voiceSilent) {
                if (e?.type === 'done' || e?.type === 'error') {
                  ws.send(JSON.stringify({ type: 'done', agent: e.agent ?? 'system' }));
                }
              } else if (isVoiceOrigin && e?.type === 'error' && typeof e.message === 'string' && e.message.trim()) {
                ws.send(JSON.stringify({ type: 'token', text: VOICE_ERROR_FALLBACK, agent: e.agent ?? 'system' }));
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
    try {
      if (ws._deviceId && msg?.type === 'chat') {
        // Voice devices drop bare `error` frames (firmware only speaks
        // token/done), so a throw during a chat turn would leave the device
        // in THINKING until its 90 s awaiting-reply watchdog. After a
        // physical stop/mute, unblock with `done` only.
        const staleVoiceTurn = messageVoiceTurn && ws._activeVoiceTurn?.id !== messageVoiceTurn.id;
        const suppressed = isVoiceOutputSuppressed(ws, messageVoiceTurn ?? ws._activeVoiceTurn ?? null);
        if (!staleVoiceTurn) {
          const streamer = ws._ttsStreamer ?? null;
          try { streamer?.abort?.({ close: true, sendDone: true }); } catch {
            try { streamer?.abort?.(); } catch {}
          }
          ws._ttsStreamer = null;
          if (!streamer && !suppressed) ws.send(JSON.stringify({ type: 'token', text: VOICE_ERROR_FALLBACK, agent: 'system' }));
          if (!streamer) ws.send(JSON.stringify({ type: 'done', agent: 'system' }));
        }
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Server error processing message', agent: 'system' }));
      }
    } catch {}
   }
  });

  ws.on('close', (code, reason) => {
    if (ws._voiceConfigPushTimer) {
      clearTimeout(ws._voiceConfigPushTimer);
      ws._voiceConfigPushTimer = null;
    }
    const r = reason ? reason.toString().slice(0, 80) : '';
    // code 1006 = abnormal (no close frame: network drop / TCP RST); 1000/1001 = clean.
    console.log(`[ws] client disconnected device=${ws._deviceId ?? '-'} user=${ws._userId} code=${code ?? '?'}${r ? ' reason=' + r : ''}`);
    log.info('ws', 'client disconnected', { userId: ws._userId, deviceId: ws._deviceId ?? null, code: code ?? null, reason: r || null });
    // A device socket dropping mid-turn used to orphan the LLM turn — tokens
    // streamed to nobody while tools kept executing. Abort it; the device
    // starts a fresh turn on its next wake after reconnecting. abortChat is
    // a no-op when the turn already finished.
    const turn = ws._activeVoiceTurn;
    if (turn?.effectiveUserId && turn?.agentId) {
      try {
        abortChat(turn.effectiveUserId, turn.agentId);
        log.info('voice', 'aborted turn on device disconnect', { deviceId: turn.deviceId, turnId: turn.id, agentId: turn.agentId });
      } catch { /* best-effort */ }
      ws._activeVoiceTurn = null;
    }
  });
  ws.on('error', e => {
    console.error('[ws] error:', e.message, 'device=' + (ws._deviceId ?? '-'));
    log.warn('ws', 'client error', { userId: ws._userId, deviceId: ws._deviceId ?? null, error: e?.message || String(e) });
  });
}

// ── Broadcast helpers ────────────────────────────────────────────────────────
export function broadcast(msg) {
  if (!_wss) return;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of _wss.clients)
    if (client.readyState === client.OPEN && !client._deviceId) try { client.send(data); } catch {}
}

export function broadcastAgentList() {
  if (!_wss) return;
  const cache = new Map();
  for (const client of _wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    if (client._deviceId) continue;
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
    if (client.readyState === client.OPEN && !client._deviceId && idSet.has(client._userId)) try { client.send(data); } catch {}
}

/** Send a message to every tab the given user has open. Returns delivery count. */
export function sendToUser(userId, msg) {
  if (!_wss) return 0;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  let delivered = 0;
  for (const client of _wss.clients) {
    if (client.readyState === client.OPEN && !client._deviceId && client._userId === userId) {
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
 * Resolve a LAN IP to the voice device currently connected from it, or null.
 * Used by the health loop to attribute UDP diag datagrams ([hb]/[boot]),
 * which carry only their sender address. LAN-scoped by nature: devices talk
 * to OE directly on the local network, so remoteAddress is the device's own
 * IP (the WAN-NAT ambiguity that makes IP monitoring useless does not apply).
 */
export function getDeviceIdForIp(ip) {
  if (!_wss || !ip) return null;
  const want = String(ip).replace(/^::ffff:/, '');
  for (const client of _wss.clients) {
    if (client.readyState !== client.OPEN || !client._deviceId) continue;
    const addr = (client._clientIp || client._socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (addr === want) return { deviceId: client._deviceId, userId: client._userId };
  }
  return null;
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
    // A version bump means real config change → always push (handled below).
    // A version MATCH means we're only re-pushing "in case NVS was reset".
    // That re-push is expensive on the device (SPIFFS GC + ~62 KB/slot rewrite
    // + model rebuild, and esp_restart() on reload failure), so debounce it:
    // doing it on every reconnect drives a flapping device into a reboot loop
    // (see VOICE_CONFIG_REPUSH_DEBOUNCE_MS). The first reconnect still pushes
    // (recovers a genuinely-wiped device); rapid follow-on reconnects skip.
    const isSameVersion = lastPushed === cfg.version;
    const pushKey = `${ws._userId}:${ws._deviceId}`;
    if (isSameVersion) {
      const prev = _lastVoiceConfigPush.get(pushKey);
      if (prev && prev.version === cfg.version &&
          (Date.now() - prev.at) < VOICE_CONFIG_REPUSH_DEBOUNCE_MS) {
        const agoS = Math.round((Date.now() - prev.at) / 1000);
        console.log(`[ws] voice-config re-push to ${ws._deviceId} debounced (v${cfg.version}, last push ${agoS}s ago) — flapping guard`);
        return;
      }
      console.log(`[ws] voice-config push to ${ws._deviceId}: version unchanged (v${cfg.version}) but pushing anyway in case device NVS was reset`);
    }
    // Record the attempt now so a storm of reconnects during the (awaited)
    // push below collapses to one in-flight push, not N stacked ones.
    _lastVoiceConfigPush.set(pushKey, { at: Date.now(), version: cfg.version });
    // Read the device's last-reported firmware version so the clear pass only
    // runs on firmware that knows ww_clear (>= 0.2.48). The auth handler stores
    // the freshly-reported version before calling us, so this is current.
    const fwVersion = getDevice(ws._userId, ws._deviceId)?.fw_version ?? null;
    const r = await pushConfigToDevice(ws._deviceId, ws._userId, { fwVersion });
    // Device is in sync when every push acked and nothing dropped/failed —
    // across BOTH the wake-word push pass and the clear pass for unassigned
    // slots. No pushedSlots>0 gate: a config with only clears (e.g. every user
    // removed) is still a valid in-sync state to mark.
    const fullySucceeded =
      r.offlineSlots.length === 0 &&
      r.failedSlots.length === 0 &&
      r.ackedSlots.length === r.pushedSlots.length;
    if (fullySucceeded) {
      markVoiceConfigPushed(ws._userId, ws._deviceId, cfg.version);
      console.log(`[ws] voice-config v${cfg.version} synced by ${ws._deviceId} (pushed ${r.ackedSlots.join(',') || '-'}, cleared ${r.clearedSlots.join(',') || '-'})`);
    } else {
      console.warn(`[ws] voice-config v${cfg.version} partial sync to ${ws._deviceId}: acked=${r.ackedSlots.join(',') || '-'} cleared=${r.clearedSlots.join(',') || '-'} failed=${r.failedSlots.map(f=>f.slot+':'+f.err).join(',') || '-'} offline=${r.offlineSlots.join(',') || '-'}`);
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
