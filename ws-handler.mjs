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
import { handleChatMessage, abortChat, getActiveStreams, getActiveStream } from './chat-dispatch.mjs';
import { getActiveTasks as getActiveBgTasks } from './background-tasks.mjs';
import { projectActiveTasksForWire } from './lib/background-task-wire.mjs';
import { loadSession, clearSession, appendToSession, getStreamBuffer, getSessionEpoch } from './sessions.mjs';
import { markAlarmFired, markAlarmAcked } from './lib/alarms.mjs';
import { handleTvCommandResult, handleTvState } from './lib/tv-commands.mjs';
import { buildDashboardData } from './lib/tv-dashboard.mjs';
import { initNodeWss, initTerminalWss } from './routes/nodes.mjs';
import {
  getAgentsForUser, agentToWire, getUser, getUserCoordinatorAgentId,
  getSessionUserId, getAuthToken, resolveShareGroup, loadConfig,
  resolveRuntimeAgentId,
} from './routes/_helpers.mjs';
import { getVoiceRef } from './lib/voice-refs.mjs';
import { createVoiceTtsStreamer } from './lib/voice-tts-stream.mjs';
import { getSessionMeta, setSessionDeviceId, adoptSession } from './routes/_helpers/auth-sessions.mjs';
import { getSlotAssignment, findDeviceByTokenPrefix, findDeviceByTokenAnyUser, recordTokenSecret, getDeviceVoiceConfigVersion, markVoiceConfigPushed, touchDevice, getDevice, recordDeviceOtaProgress } from './lib/voice-devices.mjs';
import { getAmbientForDevice, dropAmbientForDevice } from './routes/devices.mjs';
import { readVoiceConfig, pushConfigToDevice, handleWwUploadAck } from './lib/voice-config.mjs';
import {
  submitCredential, cancelCredential, cancelPendingCredentialPrompts,
  setCredentialEmitter, getPendingCredentialPrompts,
} from './lib/credentials.mjs';
import { hasVoiceAnnouncements, nextVoiceAnnouncement } from './lib/voice-announcements.mjs';
import { normalizeDocumentRequest } from './lib/document-artifacts.mjs';
import { getProfileFilePath } from './lib/profile-files.mjs';
import { getOrchestrationPolicy, getRequestedOrchestrationPolicy } from './lib/orchestration-policy.mjs';


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
import { getMainWss, setMainWss } from './ws-handler/main-wss.mjs';
import { initDesktopWss } from './ws-handler/desktop.mjs';
import { initBrowserExtWss } from './ws-handler/browser-ext.mjs';
import {
  dropSttSession,
  handleSttBinaryFrame,
  makeVoiceTurn,
  suppressVoiceOutput,
  isVoiceOutputSuppressed,
  sessionKey,
  _activeVoiceTurnByKey,
  STT_SESSION_TTL_MS,
  STT_SESSION_MAX_BYTES,
  STT_FRAME_MAGIC,
} from './ws-handler/voice-stt.mjs';
import {
  noteDeviceBackgroundWork,
  kickVoiceAnnouncementDrain,
  reassertWaitHints,
  drainVoiceAnnouncements,
} from './ws-handler/voice-wait.mjs';
export { noteDeviceBackgroundWork, kickVoiceAnnouncementDrain } from './ws-handler/voice-wait.mjs';
import {
  bindConnectionDeps,
  onConnection,
  maybePushVoiceConfig,
  pushVoiceConfigVersion,
} from './ws-handler/connection.mjs';
import {
  broadcast,
  broadcastToUsers,
  sendToUser,
  sendToDevice,
  closeDeviceSockets,
  armFollowupAfterDrain,
  isDeviceOnline,
  getDeviceIdForIp,
  stampChatEvent,
  getChatRevision,
  nextSessionSnapshotSeq,
  orchestrationPolicyForClient,
} from './ws-handler/delivery.mjs';
export {
  broadcast,
  broadcastToUsers,
  sendToUser,
  sendToDevice,
  closeDeviceSockets,
  armFollowupAfterDrain,
  isDeviceOnline,
  getDeviceIdForIp,
} from './ws-handler/delivery.mjs';

/** Sync agent_list push to all browser clients (kept here to use routes/_helpers without a cycle). */
export function broadcastAgentList() {
  if (!getMainWss()) return;
  const cache = new Map();
  for (const client of getMainWss().clients) {
    if (client.readyState !== client.OPEN) continue;
    if (client._deviceId) continue;
    const uid = client._userId;
    let data = cache.get(uid);
    if (!data) {
      data = JSON.stringify({
        type: 'agent_list',
        agents: getAgentsForUser(uid).map(agentToWire),
        orchestration: orchestrationPolicyForClient(uid),
      });
      cache.set(uid, data);
    }
    try { client.send(data); } catch {}
  }
}



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
const VOICE_CONFIG_PUSH_CONNECT_DELAY_MS = 1500;
// key `${userId}:${deviceId}` -> { version, promise } for the currently running
// stale-version voice-config push. pushConfigToDevice serializes per device, but
// this avoids queuing duplicate full slot rewrites for the same target version.
const _voiceConfigPushInFlight = new Map();
// Per-user concurrent WebSocket cap. A compromised account (or a buggy
// reconnect loop) shouldn't be able to hoard server sockets — each open
// connection costs a heartbeat timer slot and keepalive memory.
const MAX_WS_PER_USER = 20;
const VOICE_ERROR_FALLBACK = 'Something went wrong.';

let _nodeWss = null;
let _termWss = null;
let _browserExtWss = null;
let _desktopWss = null;
let _auxiliaryWsEnabled = true;

async function rehydrateChatAttachments(userId, attachments) {
  if (!Array.isArray(attachments)) return attachments;
  return Promise.all(attachments.map(async attachment => {
    if (!attachment || typeof attachment !== 'object') return attachment;
    if (!attachment.isImage || attachment.base64 || !attachment.file_id) return attachment;
    const file = getProfileFilePath(userId, attachment.file_id);
    const buf = await fs.promises.readFile(file);
    return { ...attachment, base64: buf.toString('base64') };
  }));
}

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
  for (const c of getMainWss().clients) {
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
  if (!getMainWss() || !ws?._deviceId) return 0;
  let closed = 0;
  for (const c of getMainWss().clients) {
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
    // Capability handshake FIRST: the firmware gates its newer message types
    // (tts_pause/resume, streaming STT) on what this server declares, and
    // resets the flags on every disconnect. turn_ids has no firmware gate
    // (turn_id fields are harmless to old servers) but is declared anyway.
    const _capsCfg = loadConfig();
    sendToDevice(ws._deviceId, {
      type: 'server_caps',
      turn_ids: true,
      tts_pause: true,
      // Streaming STT needs a working transcription backend server-side.
      stt_stream: _capsCfg.sttMode === 'local' || !!(_capsCfg.sttApiKey && _capsCfg.sttApiUrl),
    });
    if (d.name) sendToDevice(ws._deviceId, { type: 'set_device_name', name: d.name });
    sendToDevice(ws._deviceId, { type: 'set_headphone_mode', enabled: !!d.headphone_mode });
    sendToDevice(ws._deviceId, { type: 'set_conversation_mode', enabled: !!d.conversation_mode });
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

// Voice STT/turn helpers: ws-handler/voice-stt.mjs
// Voice wait-hints + announcements: ws-handler/voice-wait.mjs
export function initWs(httpServer, { allowAuxiliary = true } = {}) {
  _auxiliaryWsEnabled = allowAuxiliary;
  const _wss = setMainWss(new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD }));
  _nodeWss = allowAuxiliary ? initNodeWss() : null;
  _termWss = allowAuxiliary ? initTerminalWss() : null;
  _browserExtWss = allowAuxiliary ? initBrowserExtWss() : null;
  _desktopWss = allowAuxiliary ? initDesktopWss() : null;

  attachWsUpgrade(httpServer);

  // Server-side heartbeat — keeps mobile connections alive across NAT/proxy
  const heartbeat = setInterval(() => {
    for (const client of getMainWss().clients) {
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
  getMainWss().on('close', () => clearInterval(heartbeat));

  getMainWss().on('connection', onConnection);

  // Voice announcement drain: every few seconds, look for devices with
  // queued completions (background/delegated work that finished after its
  // originating turn ended) and speak ONE entry — but only when the device
  // is genuinely idle: no live streamer and a couple of seconds since the
  // last voice activity, so we never talk over a reply, a capture, or the
  // user's own barge-in verify.
  const annDrain = setInterval(() => {
    try { drainVoiceAnnouncements(); } catch {}
    try { reassertWaitHints(); } catch {}
  }, 1000);
  annDrain.unref?.();
  getMainWss().on('close', () => clearInterval(annDrain));

  // Wire the credential primitive so server-side tools can emit
  // `credential_prompt` frames via the per-user broadcast helper.
  setCredentialEmitter(sendToUser);

  // The server ignores this return value. Embedders and integration tests use
  // the handles to close every noServer WebSocketServer cleanly.
  return {
    browser: getMainWss(),
    nodes: _nodeWss,
    terminal: _termWss,
    browserExtension: _browserExtWss,
    desktop: _desktopWss,
  };
}

/**
 * Event-driven drain kick — called by enqueueVoiceAnnouncement (lazy import)
 * so a fresh completion speaks as soon as the idle gates allow instead of
 * waiting for the next timer tick. The tick remains the retry path for
 * entries the gates deferred.
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
    if (isExternalClientPath && !_auxiliaryWsEnabled) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
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
      getMainWss().handleUpgrade(req, socket, head, ws => getMainWss().emit('connection', ws, req));
    }
  });
}

// Desktop app WS lifecycle. Desktop clients connect outbound from the user's
// computer and execute local sandbox tools on behalf of OE agents.
// Desktop + browser-extension WS: ws-handler/desktop.mjs, browser-ext.mjs
export function getBrowserExtClientCount() { return _browserExtWss?.clients?.size ?? 0; }

// Main connection: ws-handler/connection.mjs
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
export function getWsClientCount() { return getMainWss()?.clients?.size ?? 0; }
export function getNodeClientCount() { return _nodeWss?.clients?.size ?? 0; }

// ── Shutdown ─────────────────────────────────────────────────────────────────
export function closeAllWsClients(reason = 'Server shutting down') {
  if (!getMainWss()) return;
  for (const client of getMainWss().clients) {
    try {
      client.send(JSON.stringify({ type: 'error', message: reason }));
      client.close(1001, reason);
    } catch (e) { console.warn('[shutdown] Failed to close WebSocket client:', e.message); }
  }
}

bindConnectionDeps({
  BOOT_ID,
  MAX_WS_PER_USER,
  VOICE_CONFIG_PUSH_CONNECT_DELAY_MS,
  VOICE_ERROR_FALLBACK,
  _voiceConfigPushInFlight,
  broadcastAgentList,
  resolveDeviceId,
  tryRecoverDeviceSession,
  enforceWsCap,
  closeOlderDeviceSockets,
  reconcileVoiceDeviceState,
  scheduleVoiceConfigPush,
  isSameOriginWs,
  wsClientIp,
  rehydrateChatAttachments,
  getAgentScope,
});

