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
import { loadSession, clearSession, appendToSession, getStreamBuffer, getSessionEpoch } from './sessions.mjs';
import { markAlarmFired, markAlarmAcked } from './lib/alarms.mjs';
import { handleTvCommandResult, handleTvState } from './lib/tv-commands.mjs';
import { buildDashboardData } from './lib/tv-dashboard.mjs';
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
import {
  submitCredential, cancelCredential, cancelPendingCredentialPrompts,
  setCredentialEmitter, getPendingCredentialPrompts,
} from './lib/credentials.mjs';
import { hasVoiceAnnouncements, nextVoiceAnnouncement } from './lib/voice-announcements.mjs';
import { normalizeDocumentRequest } from './lib/document-artifacts.mjs';
import { getProfileFilePath } from './lib/profile-files.mjs';

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
const VOICE_CONFIG_PUSH_CONNECT_DELAY_MS = 1500;
// key `${userId}:${deviceId}` -> { version, promise } for the currently running
// stale-version voice-config push. pushConfigToDevice serializes per device, but
// this avoids queuing duplicate full slot rewrites for the same target version.
const _voiceConfigPushInFlight = new Map();
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

// Monotonic per-user/per-agent watermark for live chat/session events. A
// session load captures this value BEFORE its async disk read; if the browser
// has already reduced a larger value by the time that response arrives, it
// knows the snapshot is older and must merge rather than erase those live rows.
const _chatRevisions = new Map();
let _sessionSnapshotSeq = 0;

function rawChatAgentId(userId, agentId) {
  const value = typeof agentId === 'string' ? agentId : '';
  const prefix = `${userId}_`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function chatRevisionKey(userId, agentId) {
  return `${userId}:${rawChatAgentId(userId, agentId)}`;
}

function getChatRevision(userId, agentId) {
  return _chatRevisions.get(chatRevisionKey(userId, agentId)) ?? 0;
}

function stampChatEvent(userId, event) {
  if (!event || typeof event !== 'object' || !event.agent) return event;
  if (Number.isFinite(event.chat_revision)) return event;
  const key = chatRevisionKey(userId, event.agent);
  const revision = (_chatRevisions.get(key) ?? 0) + 1;
  _chatRevisions.set(key, revision);
  return { ...event, chat_revision: revision };
}

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

// ── Streaming STT (fw ≥ 0.2.65, gated on server_caps.stt_stream) ────────────
// The device streams 16 kHz mono s16le PCM as binary WS frames during capture
// instead of buffering the whole utterance for one HTTP POST — upload overlaps
// speech, and the drive task never blocks on a 30 s HTTP call. Frame layout:
// 'OEA1' magic + u32(LE) seq + PCM payload. stt_begin opens a per-socket
// session; stt_end transcribes + dispatches through the normal chat path;
// stt_abort (no-speech capture) drops it. Sessions are size-capped and TTL'd
// so a device that dies mid-utterance can't leak buffers.
const STT_SESSION_MAX_BYTES = 512 * 1024;   // 16 s @ 16 kHz mono s16 = fw capture ceiling
const STT_SESSION_TTL_MS = 25_000;
const STT_FRAME_MAGIC = Buffer.from('OEA1');

function dropSttSession(ws, reason) {
  const s = ws._sttSession;
  if (!s) return;
  clearTimeout(s.ttl);
  ws._sttSession = null;
  if (reason) {
    log.info('voice', 'stt session dropped', {
      deviceId: ws._deviceId ?? null, turnId: s.turnId, reason, bytes: s.bytes,
    });
  }
}

function handleSttBinaryFrame(ws, raw) {
  if (!ws._authenticated || !ws._deviceId) return;
  const s = ws._sttSession;
  if (!s) return; // no open session (late frames after abort/ttl) — drop
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length <= 8 || !buf.subarray(0, 4).equals(STT_FRAME_MAGIC)) return;
  const seq = buf.readUInt32LE(4);
  // Frames ride ordered TCP; a seq gap means the device's send failed mid-
  // utterance (it flips to its HTTP fallback and this session just TTLs out).
  if (s.nextSeq !== null && seq !== s.nextSeq) s.gaps++;
  s.nextSeq = seq + 1;
  s.chunks.push(buf.subarray(8));
  s.bytes += buf.length - 8;
  if (s.bytes > STT_SESSION_MAX_BYTES) dropSttSession(ws, 'overflow');
}

const sessionKey = (userId, agentId) => `${userId}_${agentId}`;

// Most-recently-started voice turn id per `${effectiveUserId}_${agentId}`
// scope. abortChat() is keyed on user+agent ALONE (no turn id), so a device
// socket that drops after its turn already ended (or was superseded by a newer
// turn on a reconnected socket) must NOT blanket-abort whatever is now running
// under that key. The close handler consults this to abort only the turn the
// closing socket actually still owns.
const _activeVoiceTurnByKey = new Map();

function makeVoiceTurn({ ws, effectiveUserId, agentId, wakeSlot, turnId }) {
  if (!ws?._deviceId) return null;
  return {
    // Adopt the device-minted turn_id when present (fw ≥ 0.2.65 sends one in
    // `chat`) so both sides share the same correlation id and the firmware
    // can drop events from aborted turns. Server-minted fallback for old fw.
    id: turnId || randomBytes(4).toString('hex'),
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
  // A stop that killed a live reply: the user's NEXT utterance ("that's
  // enough", "stop") almost certainly targets that reply, not whatever
  // ambient/AirPlay bed is underneath — the stop intent spares the bed then.
  if (hadStreamer && !streamer.closed && !streamer.aborted) ws._replyStoppedAt = Date.now();
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
    // Carry the STOPPED turn's id: a device that already moved on to a new
    // turn (or is mid-utterance) drops this instead of treating it as the
    // new turn's terminal (the airplay-resume-mid-dictation bug).
    try { ws.send(JSON.stringify({ type: 'done', agent: active?.agentId ?? 'system', ...(active?.id ? { turn_id: active.id } : {}) })); } catch {}
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
  _wss.on('close', () => clearInterval(annDrain));

  // Wire the credential primitive so server-side tools can emit
  // `credential_prompt` frames via the per-user broadcast helper.
  setCredentialEmitter(sendToUser);
}

/**
 * Event-driven drain kick — called by enqueueVoiceAnnouncement (lazy import)
 * so a fresh completion speaks as soon as the idle gates allow instead of
 * waiting for the next timer tick. The tick remains the retry path for
 * entries the gates deferred.
 */
export function kickVoiceAnnouncementDrain() {
  try { drainVoiceAnnouncements(); } catch { /* tick retries */ }
}

// ── Background-work wait hints ────────────────────────────────────────────────
// While ≥1 voice-origin background task is running for a device, keep its
// rainbow WAITING ring lit so "I've asked the specialist — I'll tell you when
// it's back" doesn't look like the device died (field 07-04: LEDs went dark
// the moment the ack reply finished; user read it as "something went wrong").
// fw ≥ 0.2.73 handles { type:'ui_wait', on } — LED-only, mic untouched, never
// stomps an active turn's UI; older firmware drops unknown types silently.
// Re-asserted every 10s while work is outstanding because any wake/turn on
// the device clears its wait state locally.
const _bgWaitHints = new Map(); // deviceId -> { count, lastSentAt }

export function noteDeviceBackgroundWork(deviceId, delta) {
  if (!deviceId) return;
  const st = _bgWaitHints.get(deviceId) ?? { count: 0, lastSentAt: 0 };
  st.count = Math.max(0, st.count + delta);
  if (st.count === 0) {
    _bgWaitHints.delete(deviceId);
    sendToDevice(deviceId, { type: 'ui_wait', on: false });
  } else {
    st.lastSentAt = Date.now();
    _bgWaitHints.set(deviceId, st);
    sendToDevice(deviceId, { type: 'ui_wait', on: true });
  }
}

function reassertWaitHints() {
  const now = Date.now();
  for (const [deviceId, st] of _bgWaitHints) {
    if (now - st.lastSentAt < 10_000) continue;
    st.lastSentAt = now;
    sendToDevice(deviceId, { type: 'ui_wait', on: true });
  }
}

function drainVoiceAnnouncements() {
  if (!_wss) return;
  for (const ws of _wss.clients) {
    if (ws.readyState !== ws.OPEN || !ws._deviceId || !ws._authenticated) continue;
    if (!hasVoiceAnnouncements(ws._deviceId)) continue;
    // Idle gate.
    const st = ws._ttsStreamer;
    if (st && !st.closed && !st.aborted) continue;              // something is (or may be) speaking
    if (ws._sttSession) continue;                               // user is mid-utterance (streaming STT)
    if (Date.now() - (ws._lastVoiceActivityAt ?? 0) < 2500) continue;
    // NOTE: an armed-but-silent follow-up window does NOT block delivery
    // (changed 07-04, field decision): after "I've asked the specialist…" the
    // user is sitting in that window WAITING for exactly this result —
    // holding it until expiry read as dead air. The _sttSession + quiet gates above
    // still keep announcements off actual speech, and speakAnnouncement's
    // onClosed re-arms a fresh window for conversation devices, so the
    // exchange survives the interjection.
    if (isVoiceOutputSuppressed(ws, null)) continue;            // user recently said stop — hold
    const d = getDevice(ws._userId, ws._deviceId);
    if (!d || d.speak_replies === false) continue;
    const entry = nextVoiceAnnouncement(ws._deviceId);
    if (!entry) continue;
    speakAnnouncement(ws, d, entry);
  }
}

function speakAnnouncement(ws, devicePrefs, entry) {
  try {
    const cfg = loadConfig();
    ws._lastVoiceActivityAt = Date.now();
    if (cfg.ttsProvider !== 'pocket-tts') {
      // Legacy path: device accumulates the token and pulls /api/tts itself.
      sendToDevice(ws._deviceId, { type: 'token', text: entry.text, agent: 'system' });
      sendToDevice(ws._deviceId, { type: 'done', agent: 'system' });
      return;
    }
    // Same voice resolution as a turn, minus the wake-slot override.
    const deviceVoice = devicePrefs?.tts_voice && devicePrefs.tts_voice !== 'alloy' ? devicePrefs.tts_voice : null;
    const v = deviceVoice || cfg.ttsVoice || '';
    let refPath = null, presetVoice = null;
    if (typeof v === 'string' && v.startsWith('ref_')) {
      const ref = getVoiceRef(ws._userId, v);
      if (ref) refPath = ref.wavPath;
    }
    if (!refPath && (!v || v === 'default-en' || v === 'default')) {
      if (fs.existsSync(OE_DEFAULT_VOICE_STATE)) refPath = OE_DEFAULT_VOICE_STATE;
    }
    if (!refPath && !presetVoice) {
      if (v && !v.startsWith('ref_')) presetVoice = v;
      else if (fs.existsSync(OE_DEFAULT_VOICE_STATE)) refPath = OE_DEFAULT_VOICE_STATE;
      else presetVoice = 'george';
    }
    const streamer = createVoiceTtsStreamer({
      send: (m) => { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(m)); } catch {} } },
      isOpen: () => ws.readyState === ws.OPEN,
      bufferedAmount: () => ws.bufferedAmount ?? 0,
      cfg, refPath, voice: presetVoice, log,
      turnId: null,   // announcements belong to no turn; fw accepts untagged
    });
    // Own the slot while speaking so a wake/stop during the announcement
    // interacts with it exactly like a reply (new chat aborts it, etc.).
    ws._ttsStreamer = streamer;
    streamer.onClosed((clean) => {
      ws._lastVoiceActivityAt = Date.now();
      if (clean && devicePrefs?.conversation_mode) {
        // Conversation devices get a short window after an announcement —
        // "make another one" / "show it on the TV" flows naturally.
        armFollowupAfterDrain(ws._deviceId, { windowMs: 8000, conversation: true });
      }
    });
    log.info('voice', 'speaking announcement', { deviceId: ws._deviceId, kind: entry.kind, chars: entry.text.length });
    streamer.pushText(entry.text.endsWith('.') || entry.text.endsWith('!') || entry.text.endsWith('?') ? `${entry.text} ` : `${entry.text}. `);
    streamer.finish();
  } catch (e) {
    log.warn('voice', 'announcement speak failed', { deviceId: ws._deviceId, error: e.message });
  }
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
          abortChat(ws._userId, rawAgentId);
          cancelPendingCredentialPrompts(ws._userId, { agentId: rawAgentId });
          const sessionEpoch = await clearSession(`${ws._userId}_${rawAgentId}`);
          const cleared = stampChatEvent(ws._userId, { type: 'session_cleared', agent: rawAgentId, sessionEpoch });
          for (const client of _wss.clients) {
            if (client._userId !== ws._userId || client._deviceId || client.readyState !== client.OPEN) continue;
            try { client.send(JSON.stringify(cleared)); } catch {}
          }
          try { ws.send(JSON.stringify({ type: 'chat_session_cleared', agentId: rawAgentId, sessionEpoch })); } catch {}
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
      const sessionRevision = getChatRevision(ws._userId, agent.id);
      const snapshotGeneration = ++_sessionSnapshotSeq;
      return {
        agent,
        messages: await loadSession(key, 60),
        pendingStream: getStreamBuffer(key),
        sessionEpoch: getSessionEpoch(key),
        sessionRevision,
        snapshotGeneration,
        credentialPrompts: getPendingCredentialPrompts(ws._userId, agent.id),
      };
    }));
    // Capture active streams only AFTER the async history reads. Capturing
    // before them allowed a turn accepted during those reads to be erased by
    // the later, stale active_streams frame.
    const activeSnapshotRevisions = Object.fromEntries(userAgents.map(agent => [
      agent.id, getChatRevision(ws._userId, agent.id),
    ]));
    const active = getActiveStreams(ws._userId).map(stream => ({
      ...stream,
      chatRevision: activeSnapshotRevisions[stream.agentId] ?? 0,
    }));
    const activeByAgent = new Map(active.map(s => [s.agentId, s]));
    for (const { agent, messages, pendingStream, sessionEpoch, sessionRevision, snapshotGeneration, credentialPrompts } of sessionLoads) {
      ws.send(JSON.stringify({
        type: 'session_loaded', agent: agent.id, messages, pendingStream,
        activeStream: activeByAgent.get(agent.id) ?? null,
        activeSnapshotRevision: activeSnapshotRevisions[agent.id] ?? 0,
        sessionEpoch, sessionRevision, snapshotGeneration, credentialPrompts,
      }));
    }
    // Tell the client which agents are actively streaming and which background tasks are running
    const tasks = getActiveBgTasks().filter(t => t.userId === ws._userId);
    ws.send(JSON.stringify({ type: 'active_streams', agents: active, tasks, snapshotRevisions: activeSnapshotRevisions }));
  }

  if (ws._authenticated) {
    sendInitialData();
    if (ws._deviceId) {
      touchDevice(ws._userId, ws._deviceId);
      reconcileVoiceDeviceState(ws);
      scheduleVoiceConfigPush(ws);
    }
  }

  // Named (not inline) so the streaming-STT path can re-enter it with a
  // synthesized `chat` frame — the transcript then takes the EXACT same road
  // a device-side transcription would (interceptors, fastpaths, streamer).
  const onWsMessage = async (raw, isBinary = false) => {
   // Hoisted above the try so the catch below can tell chat failures apart
   // from other frame types when picking the device-spoken fallback.
   let msg;
   let messageVoiceTurn = null;
   let messageDocumentRequest = null;
   try {
    // Binary frames are streaming-STT PCM from a voice device; everything
    // else on this socket is JSON text.
    if (isBinary) { handleSttBinaryFrame(ws, raw); return; }
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
        // Android TV client (2026-07): auth optionally reports platform +
        // a capability list so the server can route tv_command/tv_state
        // traffic to this socket and the tv-control tool can find a TV
        // target. Absent for every existing ESP32 device and browser tab —
        // strictly additive, same shape as the fw_version handling above.
        const platformReported = typeof msg.platform === 'string' && msg.platform.length > 0
            ? msg.platform.slice(0, 32) : null;
        const capsReported = Array.isArray(msg.caps)
            ? msg.caps.filter(c => typeof c === 'string' && c).slice(0, 20).map(c => c.slice(0, 32))
            : null;
        if (platformReported) ws._platform = platformReported;
        if (capsReported) ws._caps = capsReported;
        touchDevice(ws._userId, ws._deviceId, {
          ...(fwReported ? { fw_version: fwReported } : {}),
          ...(typeof muteReported === 'boolean' ? { mute_state: muteReported } : {}),
          ...(platformReported ? { platform: platformReported } : {}),
          ...(capsReported ? { caps: capsReported } : {}),
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

    // ── Streaming STT session control (fw ≥ 0.2.65) ─────────────────────
    if (msg.type === 'stt_begin') {
      if (!ws._deviceId) return;
      dropSttSession(ws, ws._sttSession ? 'superseded' : null);
      const ttl = setTimeout(() => dropSttSession(ws, 'ttl'), STT_SESSION_TTL_MS);
      ttl.unref?.();
      ws._lastVoiceActivityAt = Date.now();
      ws._sttSession = {
        turnId: (typeof msg.turn_id === 'string' && msg.turn_id.length > 0 && msg.turn_id.length <= 24) ? msg.turn_id : null,
        wakeSlot: Number.isInteger(msg.wake_slot) ? msg.wake_slot : null,
        wakeAvgProb: Number.isInteger(msg.wake_avg_prob) ? msg.wake_avg_prob : null,
        agent: typeof msg.agent === 'string' && msg.agent ? msg.agent.slice(0, 64) : null,
        chunks: [], bytes: 0, gaps: 0, nextSeq: null, startedAt: Date.now(), ttl,
      };
      return;
    }
    if (msg.type === 'stt_abort') {
      // Device VAD saw no speech after the wake — nothing to transcribe.
      if (ws._deviceId) dropSttSession(ws, 'device abort (no speech)');
      return;
    }
    if (msg.type === 'stt_end') {
      if (!ws._deviceId) return;
      const s = ws._sttSession;
      // Terminal keyed to whatever turn the DEVICE thinks it's ending — it's
      // sitting in THINKING waiting on this turn_id and hangs ~90s if we send
      // nothing. Same spoken fallback + `done` the stt-failure path below uses.
      const endTurnTag = (typeof msg.turn_id === 'string' && msg.turn_id) ? { turn_id: msg.turn_id } : {};
      const unblockMic = () => {
        try {
          ws.send(JSON.stringify({ type: 'token', text: VOICE_ERROR_FALLBACK, agent: 'system', ...endTurnTag }));
          ws.send(JSON.stringify({ type: 'done', agent: 'system', ...endTurnTag }));
        } catch {}
      };
      if (!s) {
        // Session already gone before the end frame (25s TTL / 512KB overflow /
        // superseded). Un-gate the device's mic instead of leaving it stuck.
        unblockMic();
        return;
      }
      if (typeof msg.turn_id === 'string' && msg.turn_id && s.turnId && msg.turn_id !== s.turnId) {
        dropSttSession(ws, 'turn mismatch at end');
        unblockMic();
        return;
      }
      clearTimeout(s.ttl);
      ws._sttSession = null;
      const pcm = Buffer.concat(s.chunks);
      log.info('voice', 'stt stream complete', {
        deviceId: ws._deviceId, turnId: s.turnId, bytes: s.bytes, gaps: s.gaps,
        ms: Date.now() - s.startedAt,
      });
      // TODO(remove, added 2026-07-05): manual wake-phrase capture —
      // temporary tooling for the v9 wake-word data harvest; delete this
      // block once that collection round is done. While
      // wake-captures-manual/ENABLE exists, save the raw turn audio for
      // wake-word training data and end the turn with a short spoken ack
      // instead of dispatching to the assistant — NOTE: that means every
      // voice turn on every device answers "Saved." while the flag file
      // exists. Recording protocol and harvest pipeline:
      // wakeword-train/V9_PLAN.md §6.3.
      try {
        const { BASE_DIR } = await import('./lib/paths.mjs');
        const capRoot = path.join(BASE_DIR, 'wake-captures-manual');
        if (fs.existsSync(path.join(capRoot, 'ENABLE'))) {
          const { wavWrapPcm16kMono } = await import('./lib/stt.mjs');
          const dir = path.join(capRoot, ws._deviceId);
          await fs.promises.mkdir(dir, { recursive: true });
          const file = path.join(dir, `turn_${Date.now()}_${s.turnId || 'noid'}.wav`);
          // async write — a multi-hundred-KB sync write here would block the
          // event loop under every other socket's traffic
          await fs.promises.writeFile(file, wavWrapPcm16kMono(pcm));
          log.info('voice', 'manual wake capture saved', {
            deviceId: ws._deviceId, file, bytes: s.bytes,
          });
          const turnTag = s.turnId ? { turn_id: s.turnId } : {};
          ws.send(JSON.stringify({ type: 'token', text: 'Saved.', agent: 'system', ...turnTag }));
          ws.send(JSON.stringify({ type: 'done', agent: 'system', ...turnTag }));
          // Continuous-capture loop: re-open the mic with a no-wake follow-up
          // window so the speaker can keep dictating phrases hands-free. The
          // loop ends after 15s of silence (or when the ENABLE flag is
          // deleted); each pause-separated utterance lands as its own file.
          armFollowupAfterDrain(ws._deviceId, { windowMs: 15000, conversation: true });
          return;
        }
      } catch (e) {
        log.warn('voice', 'manual wake capture failed', { error: e.message });
      }
      let transcript = '';
      try {
        const { transcribeAudio, wavWrapPcm16kMono } = await import('./lib/stt.mjs');
        ({ transcript } = await transcribeAudio(wavWrapPcm16kMono(pcm), {}));
      } catch (e) {
        log.warn('voice', 'stream stt failed', { deviceId: ws._deviceId, turnId: s.turnId, error: e.message });
        // The device is in THINKING awaiting this turn — unblock it with the
        // same spoken fallback + terminal the chat error path uses.
        try {
          const turnTag = s.turnId ? { turn_id: s.turnId } : {};
          ws.send(JSON.stringify({ type: 'token', text: VOICE_ERROR_FALLBACK, agent: 'system', ...turnTag }));
          ws.send(JSON.stringify({ type: 'done', agent: 'system', ...turnTag }));
        } catch {}
        return;
      }
      // Re-enter this handler as a synthesized chat frame: the transcript
      // takes the exact same path as a device-side transcription — empty-
      // transcript apology fastpath, control intents, streamer, turn wiring.
      await onWsMessage(JSON.stringify({
        type: 'chat',
        text: transcript,
        source: 'voice-device',
        tts_stream: true,
        ...(s.agent ? { agent: s.agent } : {}),
        ...(s.wakeSlot !== null ? { wake_slot: s.wakeSlot } : {}),
        ...(s.wakeAvgProb !== null ? { wake_avg_prob: s.wakeAvgProb } : {}),
        ...(s.turnId ? { turn_id: s.turnId } : {}),
      }), false);
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

    // Browser-only control frames. A voice-device (ESP32) / TV token must not
    // be able to dump chat history, wipe sessions, or inject credentials — its
    // legit vocabulary is auth/ping/stt_*/chat/stop/acks/tts-flow-control + the
    // tv_* frames handled above. Gate the whole browser-widget family on the
    // absence of a device id (browser tabs auth with a user session, no
    // _deviceId). MUST sit before the individual handlers below — clear_session,
    // submit_credential, cancel_credential, and tool_plan_remember each return
    // on their own, so a gate placed after them would never run for those four.
    if (ws._deviceId && (
      msg.type === 'load_session' || msg.type === 'clear_session' ||
      msg.type === 'submit_credential' || msg.type === 'cancel_credential' ||
      msg.type === 'tool_plan_remember')) {
      return;
    }

    if (msg.type === 'clear_session') {
      const agentId = msg.agent;
      if (agentId) {
        abortChat(ws._userId, agentId);
        cancelPendingCredentialPrompts(ws._userId, { agentId });
        const sessionEpoch = await clearSession(sessionKey(ws._userId, agentId));
        const cleared = stampChatEvent(ws._userId, { type: 'session_cleared', agent: agentId, sessionEpoch });
        for (const client of _wss.clients) {
          if (client._userId !== ws._userId || client._deviceId || client.readyState !== client.OPEN) continue;
          try { client.send(JSON.stringify(cleared)); } catch {}
        }
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
        ws.send(JSON.stringify(stampChatEvent(ws._userId, {
          type: 'credential_error', credentialId, error: result.error,
          ...(result.prompt || {}),
        })));
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

    // Speech-barge flow control (fw ≥ 0.2.65, conversation mode): the device
    // paused its local playback to verify a barge-in candidate; stall the
    // pacer so its ring doesn't overflow, and resume on the all-clear. Turn-id
    // checked so a stale pause can't stall a newer turn's stream. A pause
    // with no resume self-aborts in the streamer (PAUSE_ABORT_MS).
    if (msg.type === 'tts_pause' || msg.type === 'tts_resume') {
      if (!ws._deviceId) return;
      const st = ws._ttsStreamer;
      if (!st) return;
      if (typeof msg.turn_id === 'string' && msg.turn_id &&
          ws._activeVoiceTurn?.id && msg.turn_id !== ws._activeVoiceTurn.id) {
        log.info('voice', 'stale tts flow-control ignored', {
          deviceId: ws._deviceId, type: msg.type, turnId: msg.turn_id, activeTurnId: ws._activeVoiceTurn.id,
        });
        return;
      }
      if (msg.type === 'tts_pause') { try { st.pause?.(); } catch {} }
      else { try { st.resume?.(); } catch {} }
      return;
    }

    if (msg.type === 'stop') {
      // Barge-in / mute: halt any in-flight server-side TTS push immediately so
      // the device stops getting audio frames, then abort the LLM turn.
      if (ws._deviceId) {
        // Stale stop: the device names the turn it is stopping (fw ≥ 0.2.65).
        // If a newer turn is already active on this socket, the stop raced it
        // — honoring it would kill the wrong (new) turn.
        if (typeof msg.turn_id === 'string' && msg.turn_id &&
            ws._activeVoiceTurn?.id && msg.turn_id !== ws._activeVoiceTurn.id) {
          log.info('voice', 'stale stop ignored', {
            deviceId: ws._deviceId, stopTurnId: msg.turn_id, activeTurnId: ws._activeVoiceTurn.id,
          });
          return;
        }
        const stoppedTurn = suppressVoiceOutput(ws, 'stop', { sendDone: true });
        if (!stoppedTurn) {
          // No active turn — fall back to the last voice turn this socket
          // ran. Aborting ws._userId's coordinator here was wrong for
          // slot-routed turns: the LLM turn runs as the slot's OWNER user.
          const last = ws._lastVoiceTurn;
          const stopAgent = typeof msg.agent === 'string' ? msg.agent
            : (last?.agentId ?? getUserCoordinatorAgentId(ws._userId));
          const stopUser = last?.effectiveUserId ?? ws._userId;
          if (stopAgent) abortChat(stopUser, stopAgent);
        }
      } else {
        const stopAgent = typeof msg.agent === 'string' ? msg.agent : getUserCoordinatorAgentId(ws._userId);
        if (stopAgent) {
          const requestedTurnId = typeof msg.turn_id === 'string' && msg.turn_id.length <= 80
            ? msg.turn_id : null;
          const active = getActiveStream(ws._userId, stopAgent);
          // Browser Stop targets the turn visible when the button was clicked.
          // Another tab may have barged in with a newer turn before this frame
          // is processed; never abort that replacement.
          if (requestedTurnId && (!active || (active.turnId && active.turnId !== requestedTurnId))) {
            ws.send(JSON.stringify({
              type: 'stop_ignored', agent: stopAgent,
              requested_turn_id: requestedTurnId,
              activeStream: active ? {
                ...active,
                chatRevision: getChatRevision(ws._userId, stopAgent),
              } : null,
            }));
          } else {
            abortChat(ws._userId, stopAgent);
            cancelPendingCredentialPrompts(ws._userId, {
              agentId: stopAgent,
              ...(requestedTurnId ? { turnId: requestedTurnId } : {}),
            });
          }
        }
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

    // Android TV protocol (2026-07): device → server result/state frames for
    // the tv_command channel (lib/tv-commands.mjs). Only meaningful for authed
    // device sockets — a browser tab or non-TV voice device would never send
    // these, but the ws._deviceId guard keeps it strictly a no-op if one did.
    if (msg.type === 'tv_command_result') {
      // Sender's own deviceId goes along so tv-commands can verify the
      // result came from the device the command was actually addressed to.
      if (ws._deviceId) handleTvCommandResult(ws._deviceId, msg);
      return;
    }

    if (msg.type === 'tv_state') {
      if (ws._deviceId) handleTvState(ws._deviceId, msg);
      return;
    }

    // Android TV dashboard (2026-07): idle-screen/screensaver data pull —
    // see lib/tv-dashboard.mjs and PROTOCOL-TV.md "Dashboard". Reply on the
    // SAME socket. buildDashboardData() already isolates each section in
    // its own try/catch, but this local try/catch is a second net so a
    // dashboard failure (HA down, disk hiccup) can never bubble into the
    // outer handler's generic `error` frame — the device just gets an
    // all-null/empty payload it can render nothing from.
    if (msg.type === 'dashboard_get') {
      if (ws._deviceId && ws._userId) {
        try {
          const payload = await buildDashboardData(ws._userId, ws._deviceId);
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'dashboard_data', ...payload }));
        } catch (e) {
          log.warn('voice', 'dashboard_get failed', { deviceId: ws._deviceId, error: e?.message });
          try {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'dashboard_data',
                greeting: null, alarms: [], announcements: [], now_playing: null, weather: null,
              }));
            }
          } catch {}
        }
      }
      return;
    }

    if (msg.type === 'load_session') {
      const agentId = msg.agent;
      if (agentId) {
        const key = sessionKey(ws._userId, agentId);
        const sessionRevision = getChatRevision(ws._userId, agentId);
        const snapshotGeneration = ++_sessionSnapshotSeq;
        const messages = await loadSession(key, 60);
        const pendingStream = getStreamBuffer(key);
        const activeStream = getActiveStream(ws._userId, agentId);
        const activeSnapshotRevision = getChatRevision(ws._userId, agentId);
        const sessionEpoch = getSessionEpoch(key);
        const requestId = typeof msg.request_id === 'string' && msg.request_id.length <= 80
          ? msg.request_id : null;
        ws.send(JSON.stringify({
          type: 'session_loaded', agent: agentId, messages, pendingStream,
          activeStream: activeStream ? {
            ...activeStream,
            chatRevision: activeSnapshotRevision,
          } : null,
          activeSnapshotRevision,
          sessionEpoch, sessionRevision, snapshotGeneration, request_id: requestId,
          credentialPrompts: getPendingCredentialPrompts(ws._userId, agentId),
        }));
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
      const incomingDocumentRequest = normalizeDocumentRequest(msg.documentRequest);
      messageDocumentRequest = incomingDocumentRequest;
      console.log('[chat] received, agent:', msg.agent, 'user:', ws._userId, 'text:', textPreview);
      const wakeSlot = Number.isInteger(msg.wake_slot) ? msg.wake_slot : null;
      // Device-minted turn correlation id (fw ≥ 0.2.65). Bounded; echoed on
      // every event of this turn so the firmware can drop stale-turn events.
      const deviceTurnId = (typeof msg.turn_id === 'string' && msg.turn_id.length > 0 && msg.turn_id.length <= 24)
        ? msg.turn_id : null;
      // Browser chat uses a logical message id plus a per-execution attempt id.
      // Re-sending the SAME attempt after a lost ACK is idempotent; pressing the
      // explicit Retry button keeps message_id but mints a new attempt_id.
      const validBrowserId = value => typeof value === 'string'
        && value.length > 0 && value.length <= 80
        && /^[A-Za-z0-9_-]+$/.test(value);
      if (!ws._deviceId && ((msg.message_id != null && !validBrowserId(msg.message_id))
          || (msg.attempt_id != null && !validBrowserId(msg.attempt_id)))) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid chat correlation id', agent: msg.agent || 'system', retryable: false }));
        return;
      }
      const browserMessageId = !ws._deviceId && validBrowserId(msg.message_id) ? msg.message_id : null;
      const browserAttemptId = !ws._deviceId && validBrowserId(msg.attempt_id) ? msg.attempt_id : null;
      // Speech-barge turn (fw ≥ 0.2.66): the barge pre-roll may prefix the
      // transcript with a sliver of the interrupted reply's audio, so intent
      // matchers relax their bare-word anchors ("…Paris. Stop." still stops).
      const bargeIn = msg.barge === true;
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
          try { ws.send(JSON.stringify({ type: 'done', agent: 'system', ...(deviceTurnId ? { turn_id: deviceTurnId } : {}) })); } catch {}
          return;
        }
      }
      const routedAgentId = slotAssignment
        ? (slotAssignment.agentId || getUserCoordinatorAgentId(effectiveUserId))
        : (msg.agent || devicePrefs?.default_agent_id || getUserCoordinatorAgentId(effectiveUserId));
      const voiceTurn = makeVoiceTurn({ ws, effectiveUserId, agentId: routedAgentId, wakeSlot, turnId: deviceTurnId });
      if (voiceTurn) {
        messageVoiceTurn = voiceTurn;
        ws._activeVoiceTurn = voiceTurn;
        // Claim the abort key for this turn so a later close on a stale socket
        // (or a superseded turn) can't abort whatever runs here next.
        _activeVoiceTurnByKey.set(`${voiceTurn.effectiveUserId}_${voiceTurn.agentId}`, voiceTurn.id);
        ws._lastVoiceActivityAt = Date.now();
        // Retained past turn end (never nulled) so a later `stop` with no
        // active turn can abort the RIGHT user's agent — the slot-routed
        // effective user, not the device-auth user's coordinator.
        ws._lastVoiceTurn = voiceTurn;
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
      // Once-per-turn guard for the spoken delegation ack (see onEvent).
      let voiceDelegationAckSpoken = false;
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
            bufferedAmount: () => ws.bufferedAmount ?? 0,
            cfg: _cfg, refPath, voice: presetVoice, log,
            turnId: voiceTurn?.id ?? null,
          });
          ws._ttsStreamer = ttsStreamer;
          ttsStreamer.onClosed(() => { ws._lastVoiceActivityAt = Date.now(); });
        }
      } catch (e) { log.warn('voice-tts', 'streamer setup failed', { error: e.message }); ttsStreamer = null; }

      // Silent-turn ack: if NOTHING speakable has materialized shortly after
      // dispatch, say so — otherwise the device sits in THINKING with
      // flashing LEDs and a gated mic for however long the silence lasts
      // (field data: a 53 s provider-hosted image generation inside the
      // model's own span, zero local events to hook). Time-based on purpose:
      // event-based triggers (ask_agent etc.) miss hosted tools and pure
      // reasoning burns. Once the ack plays, the idle burst-close drops the
      // device back to listening for the remainder of the wait.
      let silentAckTimer = null;
      if (ttsStreamer) {
        const ackStreamer = ttsStreamer;
        silentAckTimer = setTimeout(() => {
          try {
            if (ws._ttsStreamer !== ackStreamer) return;      // superseded turn
            if (ackStreamer.aborted || ackStreamer.finished || ackStreamer.hasContent) return;
            if (isVoiceOutputSuppressed(ws, voiceTurn)) return;
            voiceDelegationAckSpoken = true;                   // no double-ack
            log.info('voice', 'silent-turn ack spoken', { deviceId: ws._deviceId, turnId: voiceTurn?.id ?? null });
            ackStreamer.pushText('On it — give me a moment. ');
          } catch { /* ack is best-effort */ }
        }, 3000);
        silentAckTimer.unref?.();
      }

      let chatAttachments = msg.attachments;
      try {
        // A browser outbox deliberately stores only the durable file_id (plus
        // bounded extracted text), never multi-megabyte image base64. Restore
        // image bytes from the user's profile file before an idempotent replay.
        chatAttachments = await rehydrateChatAttachments(effectiveUserId, msg.attachments);
      } catch (e) {
        sendToUser(effectiveUserId, {
          type: 'error', agent: msg.agent || getUserCoordinatorAgentId(effectiveUserId),
          ...(browserAttemptId ? { turn_id: browserAttemptId, attempt_id: browserAttemptId } : {}),
          ...(browserMessageId ? { message_id: browserMessageId } : {}),
          code: 'attachment_rehydrate_failed', retryable: false,
          message: 'The uploaded file is no longer available, so this message was not executed. Please attach it again.',
        });
        log.warn('chat', 'attachment replay rehydrate failed', { userId: effectiveUserId, err: e?.message || String(e) });
        return;
      }

      await handleChatMessage({
        userId:     ws._userId,
        // Empty string → undefined so chat-dispatch's coordinator fallback
        // kicks in (?? only catches nullish). Voice devices with no default
        // agent configured send no agent field at all (fw >= 0.2.62), but an
        // explicit "" from any client should mean "coordinator" too.
        agentId:    msg.agent || undefined,
        text:       msg.text,
        // Both shapes pass straight through raw — chat-dispatch.mjs's
        // handleChatMessage is the single normalization point (see
        // normalizeAttachments in chat/providers/_shared.mjs). msg.attachment
        // (legacy singular) keeps working for older clients / public/docs.js's
        // "ask about this doc" send; msg.attachments (new array) is what the
        // composer's multi-file tray sends. Voice-device 'chat' frames never
        // set either field, so this is a no-op for that path.
        attachment:  msg.attachment,
        attachments: chatAttachments,
        toolPlan:   msg.toolPlan,
        documentRequest: incomingDocumentRequest,
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
        conversationMode: !!(ws._deviceId && devicePrefs?.conversation_mode),
        turnId: deviceTurnId,
        messageId: browserMessageId,
        attemptId: browserAttemptId,
        bargeIn,
        // "stop"/"that's enough" arriving as a speech barge OR shortly after
        // a reply was cut by a wake-barge is aimed at the REPLY — the stop
        // intent must not also kill the ambient/AirPlay bed underneath.
        recentReplyStop: bargeIn || (Date.now() - (ws._replyStoppedAt ?? 0) < 8000),
        // Chat events fan out two ways:
        //   (1) Back to the originating ws — the device gets TTS chunks,
        //       status updates, etc. regardless of whose user is "acting."
        //   (2) Broadcast to all of the EFFECTIVE user's other WSes so the
        //       chat history shows up in their browser tabs.
        // When effectiveUserId == ws._userId (single-user case), step (2)
        // delivers to admin's other browser tabs the same way as before.
        onEvent: (e) => {
          if (incomingDocumentRequest && e && typeof e === 'object' && !e.documentRequest) {
            e = { ...e, documentRequest: incomingDocumentRequest, documentTurn: true };
          }
          // One revision shared by every tab receiving this event. Session
          // snapshots capture the pre-read revision, so clients can prove that
          // an older response must not erase this already-rendered event.
          e = stampChatEvent(effectiveUserId, e);
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
            else if (e?.type === 'tool_call' && e.name === 'ask_agent' && !voiceDelegationAckSpoken) {
              // Sync delegation starting — could grind for a minute with zero
              // tokens. Speak a short ack so the user isn't staring at
              // flashing LEDs wondering if anything is happening; the
              // streamer's idle burst-close then re-opens the mic for the
              // wait. Once per turn.
              voiceDelegationAckSpoken = true;
              ttsStreamer.pushText('On it — give me a moment. ');
            }
            else if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(e)); } catch {} }
          } else if (ws.readyState === ws.OPEN) {
            try {
              // Legacy (non-streamer) voice path: tag device-bound events
              // with this turn's id so fw ≥ 0.2.65 can drop stale-turn ones.
              const turnTag = isVoiceOrigin && voiceTurn?.id ? { turn_id: voiceTurn.id } : {};
              if (isVoiceOrigin && (voiceSuppressed || staleVoiceTurn)) {
                // Stop/mute already sent `done`; old-turn events must not
                // leak into the device after a new wake has started.
              } else if (voiceSilent) {
                if (e?.type === 'done' || e?.type === 'error') {
                  ws.send(JSON.stringify({ type: 'done', agent: e.agent ?? 'system', ...turnTag }));
                }
              } else if (isVoiceOrigin && e?.type === 'error' && typeof e.message === 'string' && e.message.trim()) {
                ws.send(JSON.stringify({ type: 'token', text: VOICE_ERROR_FALLBACK, agent: e.agent ?? 'system', ...turnTag }));
                ws.send(JSON.stringify({ type: 'done', agent: e.agent ?? 'system', ...turnTag }));
              } else {
                ws.send(JSON.stringify(isVoiceOrigin && voiceTurn?.id ? { ...e, ...turnTag } : e));
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
      if (silentAckTimer) clearTimeout(silentAckTimer);
      // Release this turn's abort-key claim now that it's over, so a later
      // socket close can't abort a NEWER turn started under the same
      // user+agent key after this one finished (the reason the claim was
      // scoped in the first place). Only clear if it's still ours — a
      // superseding turn may have already re-claimed the key.
      if (messageVoiceTurn) {
        const _vk = `${messageVoiceTurn.effectiveUserId}_${messageVoiceTurn.agentId}`;
        if (_activeVoiceTurnByKey.get(_vk) === messageVoiceTurn.id) _activeVoiceTurnByKey.delete(_vk);
      }
      // Terminal-event guarantee: handleChatMessage has returned, so the LLM
      // turn is over — but an abort that didn't come from THIS device's own
      // `stop` (browser-tab stop, shutdown, cross-agent abort) emits neither
      // `done` nor an error event (llm-loop swallows AbortError), leaving the
      // streamer open and the device in THINKING until its 90 s watchdog.
      // If the streamer was neither finished nor aborted by now, no terminal
      // is coming from anywhere else — close it out ourselves.
      if (ttsStreamer && ws._ttsStreamer === ttsStreamer &&
          !ttsStreamer.finished && !ttsStreamer.aborted) {
        log.info('voice', 'turn ended without terminal — closing streamer', {
          deviceId: ws._deviceId, turnId: voiceTurn?.id ?? null,
        });
        try { ttsStreamer.abort({ close: true, sendDone: true }); } catch {}
        ws._ttsStreamer = null;
      }
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
          const turnTag = messageVoiceTurn?.id ? { turn_id: messageVoiceTurn.id } : {};
          if (!streamer && !suppressed) ws.send(JSON.stringify({ type: 'token', text: VOICE_ERROR_FALLBACK, agent: 'system', ...turnTag }));
          if (!streamer) ws.send(JSON.stringify({ type: 'done', agent: 'system', ...turnTag }));
        }
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Server error processing message',
          agent: typeof msg?.agent === 'string' ? msg.agent : 'system',
          ...(messageDocumentRequest ? { documentRequest: messageDocumentRequest, documentTurn: true } : {}),
        }));
      }
    } catch {}
   }
  };
  ws.on('message', onWsMessage);

  ws.on('close', (code, reason) => {
    if (ws._voiceConfigPushTimer) {
      clearTimeout(ws._voiceConfigPushTimer);
      ws._voiceConfigPushTimer = null;
    }
    const r = reason ? reason.toString().slice(0, 80) : '';
    // code 1006 = abnormal (no close frame: network drop / TCP RST); 1000/1001 = clean.
    console.log(`[ws] client disconnected device=${ws._deviceId ?? '-'} user=${ws._userId} code=${code ?? '?'}${r ? ' reason=' + r : ''}`);
    log.info('ws', 'client disconnected', { userId: ws._userId, deviceId: ws._deviceId ?? null, code: code ?? null, reason: r || null });
    // Kill any in-flight TTS streamer: frames were only droppable (isOpen()
    // guards), but the active Pocket fetch + ffmpeg kept running for up to
    // the 60 s synth timeout per orphaned sentence.
    if (ws._ttsStreamer) {
      try { ws._ttsStreamer.abort(); } catch {}
      ws._ttsStreamer = null;
    }
    dropSttSession(ws, ws._sttSession ? 'socket closed' : null);
    // A device socket dropping mid-turn used to orphan the LLM turn — tokens
    // streamed to nobody while tools kept executing. Abort it; the device
    // starts a fresh turn on its next wake after reconnecting. abortChat is
    // a no-op when the turn already finished.
    const turn = ws._activeVoiceTurn;
    if (turn?.effectiveUserId && turn?.agentId) {
      const key = `${turn.effectiveUserId}_${turn.agentId}`;
      // Only abort if THIS socket's turn is still the active one for this
      // user+agent. A reconnected device or a barge-in on another socket may
      // have started a newer turn under the same key; abortChat is keyed on
      // user+agent alone, so an unconditional abort here would kill that
      // newer turn's stream.
      if (_activeVoiceTurnByKey.get(key) === turn.id) {
        try {
          abortChat(turn.effectiveUserId, turn.agentId);
          _activeVoiceTurnByKey.delete(key);
          log.info('voice', 'aborted turn on device disconnect', { deviceId: turn.deviceId, turnId: turn.id, agentId: turn.agentId });
        } catch { /* best-effort */ }
      } else {
        log.info('voice', 'skipped stale turn abort on disconnect', { deviceId: turn.deviceId, turnId: turn.id, agentId: turn.agentId });
      }
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
  const stamped = typeof msg === 'string' ? msg : stampChatEvent(userId, msg);
  const data = typeof stamped === 'string' ? stamped : JSON.stringify(stamped);
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
 * Force-close every live WebSocket belonging to `deviceId`. Called after a
 * device is revoked/unpaired so a stolen or revoked device token can't keep
 * an already-established socket alive (chat, STT, TTS) until it happens to
 * disconnect on its own — deleting the registry entry + session token alone
 * doesn't touch an open connection. 4001 = the same policy-violation close
 * code the auth path uses. Returns the number of sockets closed.
 */
export function closeDeviceSockets(deviceId) {
  if (!_wss || !deviceId) return 0;
  let closed = 0;
  for (const client of _wss.clients) {
    if (client._deviceId !== deviceId) continue;
    try { client.close(4001, 'revoked'); closed++; }
    catch { try { client.terminate(); closed++; } catch {} }
  }
  if (closed) console.log(`[ws] closed ${closed} socket(s) for revoked device=${deviceId}`);
  return closed;
}

/**
 * Arm a follow-up listen window on a device AFTER its current reply has
 * actually finished playing out. The old call site (llm-loop's finally)
 * fired at LLM-done — i.e. before tts_audio_begin for short replies — so the
 * window burned down during synth + playback and could expire before the
 * user was even asked the question. Here:
 *   - live streamer → registered on its onClosed(clean); sent only for a
 *     clean close (an aborted/failed reply must not open a phantom window).
 *   - no streamer (legacy token/done path or no-audio turn) → sent now; the
 *     firmware's own deferral (reply_in_flight check) handles in-flight
 *     legacy audio.
 * Returns true if the window was sent or scheduled.
 */
export function armFollowupAfterDrain(deviceId, { windowMs = 5000, conversation = false } = {}) {
  if (!_wss || !deviceId) return false;
  for (const client of _wss.clients) {
    if (client.readyState !== client.OPEN || client._deviceId !== deviceId) continue;
    // Tag with the turn the window belongs to (resolved at SEND time — the
    // firmware drops a window whose turn it has already moved past).
    const payload = () => ({
      type: 'await_followup', windowMs,
      ...(conversation ? { conversation: true } : {}),
      ...(client._activeVoiceTurn?.id ? { turn_id: client._activeVoiceTurn.id } : {}),
    });
    const streamer = client._ttsStreamer;
    if (streamer && !streamer.closed && !streamer.aborted) {
      streamer.onClosed((clean) => {
        if (!clean) return;
        if (client.readyState === client.OPEN) {
          client._followupArmedUntil = Date.now() + windowMs + 1000;
          sendToDevice(deviceId, payload());
        }
      });
      return true;
    }
    client._followupArmedUntil = Date.now() + windowMs + 1000;
    sendToDevice(deviceId, payload());
    return true;
  }
  return false;
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
    // Without device-reported slot inventory, the server only has one safe cheap
    // signal: the config version it last pushed successfully. If it matches, do
    // not rewrite wake-word slots on reconnect; explicit Push remains the repair
    // path for a device whose local storage was wiped.
    if (lastPushed === cfg.version) return;

    const pushKey = `${ws._userId}:${ws._deviceId}`;
    const existing = _voiceConfigPushInFlight.get(pushKey);
    if (existing?.version === cfg.version) {
      console.log(`[ws] voice-config v${cfg.version} sync to ${ws._deviceId} already in progress`);
      return;
    }

    const syncPromise = pushVoiceConfigVersion(ws);
    _voiceConfigPushInFlight.set(pushKey, { version: cfg.version, promise: syncPromise });
    try {
      await syncPromise;
    } finally {
      const current = _voiceConfigPushInFlight.get(pushKey);
      if (current?.promise === syncPromise) _voiceConfigPushInFlight.delete(pushKey);
    }
  } catch (e) {
    console.warn(`[ws] voice-config push to ${ws._deviceId} failed: ${e.message}`);
  }
}

async function pushVoiceConfigVersion(ws) {
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
    markVoiceConfigPushed(ws._userId, ws._deviceId, r.version, r.assignments);
    console.log(`[ws] voice-config v${r.version} synced by ${ws._deviceId} (pushed ${r.ackedSlots.join(',') || '-'}, cleared ${r.clearedSlots.join(',') || '-'})`);
  } else {
    console.warn(`[ws] voice-config v${r.version} partial sync to ${ws._deviceId}: acked=${r.ackedSlots.join(',') || '-'} cleared=${r.clearedSlots.join(',') || '-'} failed=${r.failedSlots.map(f=>f.slot+':'+f.err).join(',') || '-'} offline=${r.offlineSlots.join(',') || '-'}`);
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
