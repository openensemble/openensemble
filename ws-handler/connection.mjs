/**
 * Main browser/voice WebSocket connection handler.
 * Extracted from ws-handler.mjs — pure move.
 */

import { randomBytes } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getActiveTasks as getActiveBgTasks } from '../background-tasks.mjs';
import { projectActiveTasksForWire } from '../lib/background-task-wire.mjs';
import { loadSession, clearSession, appendToSession, getStreamBuffer, getSessionEpoch } from '../sessions.mjs';
import {
  getAgentsForUser, agentToWire, getUser, getUserCoordinatorAgentId,
  getSessionUserId, getAuthToken, resolveShareGroup, loadConfig,
  resolveRuntimeAgentId,
} from '../routes/_helpers.mjs';
import { getVoiceRef } from '../lib/voice-refs.mjs';
import { createVoiceTtsStreamer } from '../lib/voice-tts-stream.mjs';
import { getSessionMeta, setSessionDeviceId, adoptSession } from '../routes/_helpers/auth-sessions.mjs';
import {
  submitCredential, cancelCredential, cancelPendingCredentialPrompts,
  setCredentialEmitter, getPendingCredentialPrompts,
} from '../lib/credentials.mjs';
import { normalizeDocumentRequest } from '../lib/document-artifacts.mjs';
import { getProfileFilePath } from '../lib/profile-files.mjs';
import { getOrchestrationPolicy, getRequestedOrchestrationPolicy } from '../lib/orchestration-policy.mjs';
import { log } from '../logger.mjs';
import { getMainWss } from './main-wss.mjs';
import {
  broadcast,
  sendToUser,
  sendToDevice,
  closeDeviceSockets,
  armFollowupAfterDrain,
  stampChatEvent,
  getChatRevision,
  nextSessionSnapshotSeq,
  orchestrationPolicyForClient,
} from './delivery.mjs';
const OE_DEFAULT_VOICE_STATE = path.join(os.homedir(), '.openensemble', 'models', 'tts', 'pocket-tts', 'default-voice.safetensors');

// Bound from parent: boot id, caps, device recovery, voice config timing
let BOOT_ID = '';
let MAX_WS_PER_USER = 20;
let WS_PING_INTERVAL = 15_000;
let VOICE_CONFIG_PUSH_CONNECT_DELAY_MS = 1500;
let VOICE_ERROR_FALLBACK = 'Something went wrong.';
let _voiceConfigPushInFlight = new Map();
let broadcastAgentList = () => {};
let resolveDeviceId = () => null;
let tryRecoverDeviceSession = () => null;
let enforceWsCap = () => {};
let closeOlderDeviceSockets = () => {};
let reconcileVoiceDeviceState = () => {};
let scheduleVoiceConfigPush = () => {};
let isSameOriginWs = () => true;
let wsClientIp = () => '';
let rehydrateChatAttachments = async (u, a) => a;
let getAgentScope = (id) => id;
let emitAgentNotification = () => {};
let handleChatMessage = async () => {};
let abortChat = () => {};
let getActiveStreams = () => [];
let getActiveStream = () => null;
let markAlarmFired = () => {};
let markAlarmAcked = () => {};
let handleTvCommandResult = () => {};
let handleTvState = () => {};
let buildDashboardData = async () => ({});
let getSlotAssignment = () => null;
let recordTokenSecret = () => {};
let getDeviceVoiceConfigVersion = () => null;
let markVoiceConfigPushed = () => {};
let touchDevice = () => {};
let getDevice = () => null;
let recordDeviceOtaProgress = () => {};
let getAmbientForDevice = () => null;
let dropAmbientForDevice = () => {};
let readVoiceConfig = () => ({});
let pushConfigToDevice = async () => ({ ok: false });
let handleWwUploadAck = () => {};
let dropSttSession = () => {};
let handleSttBinaryFrame = () => {};
let makeVoiceTurn = () => null;
let suppressVoiceOutput = () => null;
let isVoiceOutputSuppressed = () => false;
let sessionKey = (userId, agentId) => `${userId}_${agentId}`;
let _activeVoiceTurnByKey = new Map();
let STT_SESSION_TTL_MS = 30_000;

export function bindConnectionDeps(deps) {
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined) continue;
    switch (k) {
      case 'BOOT_ID': BOOT_ID = v; break;
      case 'MAX_WS_PER_USER': MAX_WS_PER_USER = v; break;
      case 'WS_PING_INTERVAL': WS_PING_INTERVAL = v; break;
      case 'VOICE_CONFIG_PUSH_CONNECT_DELAY_MS': VOICE_CONFIG_PUSH_CONNECT_DELAY_MS = v; break;
      case 'VOICE_ERROR_FALLBACK': VOICE_ERROR_FALLBACK = v; break;
      case '_voiceConfigPushInFlight': _voiceConfigPushInFlight = v; break;
      case 'broadcastAgentList': broadcastAgentList = v; break;
      case 'resolveDeviceId': resolveDeviceId = v; break;
      case 'tryRecoverDeviceSession': tryRecoverDeviceSession = v; break;
      case 'enforceWsCap': enforceWsCap = v; break;
      case 'closeOlderDeviceSockets': closeOlderDeviceSockets = v; break;
      case 'reconcileVoiceDeviceState': reconcileVoiceDeviceState = v; break;
      case 'scheduleVoiceConfigPush': scheduleVoiceConfigPush = v; break;
      case 'isSameOriginWs': isSameOriginWs = v; break;
      case 'wsClientIp': wsClientIp = v; break;
      case 'rehydrateChatAttachments': rehydrateChatAttachments = v; break;
      case 'getAgentScope': getAgentScope = v; break;
      case 'emitAgentNotification': emitAgentNotification = v; break;
      case 'handleChatMessage': handleChatMessage = v; break;
      case 'abortChat': abortChat = v; break;
      case 'getActiveStreams': getActiveStreams = v; break;
      case 'getActiveStream': getActiveStream = v; break;
      case 'markAlarmFired': markAlarmFired = v; break;
      case 'markAlarmAcked': markAlarmAcked = v; break;
      case 'handleTvCommandResult': handleTvCommandResult = v; break;
      case 'handleTvState': handleTvState = v; break;
      case 'buildDashboardData': buildDashboardData = v; break;
      case 'getSlotAssignment': getSlotAssignment = v; break;
      case 'recordTokenSecret': recordTokenSecret = v; break;
      case 'getDeviceVoiceConfigVersion': getDeviceVoiceConfigVersion = v; break;
      case 'markVoiceConfigPushed': markVoiceConfigPushed = v; break;
      case 'touchDevice': touchDevice = v; break;
      case 'getDevice': getDevice = v; break;
      case 'recordDeviceOtaProgress': recordDeviceOtaProgress = v; break;
      case 'getAmbientForDevice': getAmbientForDevice = v; break;
      case 'dropAmbientForDevice': dropAmbientForDevice = v; break;
      case 'readVoiceConfig': readVoiceConfig = v; break;
      case 'pushConfigToDevice': pushConfigToDevice = v; break;
      case 'handleWwUploadAck': handleWwUploadAck = v; break;
      case 'dropSttSession': dropSttSession = v; break;
      case 'handleSttBinaryFrame': handleSttBinaryFrame = v; break;
      case 'makeVoiceTurn': makeVoiceTurn = v; break;
      case 'suppressVoiceOutput': suppressVoiceOutput = v; break;
      case 'isVoiceOutputSuppressed': isVoiceOutputSuppressed = v; break;
      case 'sessionKey': sessionKey = v; break;
      case '_activeVoiceTurnByKey': _activeVoiceTurnByKey = v; break;
      case 'STT_SESSION_TTL_MS': STT_SESSION_TTL_MS = v; break;
    }
  }
}

export function onConnection(ws, req) {
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
    ws.send(JSON.stringify({
      type: 'agent_list',
      agents: userAgents.map(agentToWire),
      orchestration: orchestrationPolicyForClient(ws._userId),
      boot_id: BOOT_ID,
    }));
    // Load every agent's session in parallel — loadSession is async since
    // the previous commit; the prior serial sync version was 5+ blocking
    // reads at WS connect time. Parallel async makes total wall time =
    // the slowest single read, not the sum.
    const sessionLoads = await Promise.all(userAgents.map(async (agent) => {
      const key = sessionKey(ws._userId, agent.id);
      const sessionRevision = getChatRevision(ws._userId, agent.id);
      const snapshotGeneration = nextSessionSnapshotSeq();
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
    // Send a narrow, folded UI snapshot rather than serializing execution
    // callbacks, private prompts, verifier leases, or ambient contexts.
    const tasks = projectActiveTasksForWire(
      getActiveBgTasks().filter(t => t.userId === ws._userId),
    );
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
      // Explicit per-device wake-word training mode. Creating
      // wake-captures-manual/ENABLE-<deviceId> records pause-separated WAVs
      // and acknowledges each sample instead of dispatching it to chat. There
      // is deliberately no global ENABLE switch: training one device must not
      // hijack voice turns throughout the installation.
      try {
        const { BASE_DIR } = await import('../lib/paths.mjs');
        const { isManualWakeCaptureEnabled } = await import('../lib/manual-wake-capture.mjs');
        const capRoot = path.join(BASE_DIR, 'wake-captures-manual');
        if (isManualWakeCaptureEnabled(capRoot, ws._deviceId)) {
          const { wavWrapPcm16kMono } = await import('../lib/stt.mjs');
          const dir = path.join(capRoot, ws._deviceId);
          await fs.promises.mkdir(dir, { recursive: true });
          const file = path.join(dir, `turn_${Date.now()}_${s.turnId || 'noid'}.wav`);
          await fs.promises.writeFile(file, wavWrapPcm16kMono(pcm));
          log.info('voice', 'manual wake capture saved', {
            deviceId: ws._deviceId, file, bytes: s.bytes,
          });
          const turnTag = s.turnId ? { turn_id: s.turnId } : {};
          ws.send(JSON.stringify({ type: 'token', text: 'Saved.', agent: 'system', ...turnTag }));
          ws.send(JSON.stringify({ type: 'done', agent: 'system', ...turnTag }));
          armFollowupAfterDrain(ws._deviceId, { windowMs: 15000, conversation: true });
          return;
        }
      } catch (e) {
        log.warn('voice', 'manual wake capture failed', { error: e.message });
      }
      let transcript = '';
      try {
        const { transcribeAudio, wavWrapPcm16kMono } = await import('../lib/stt.mjs');
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
      for (const client of getMainWss().clients) {
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
        for (const client of getMainWss().clients) {
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
        const { rememberToolPlan } = await import('../lib/tool-plan-memory.mjs');
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
        const snapshotGeneration = nextSessionSnapshotSeq();
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
      const requestedVoiceAgentId = slotAssignment
        ? (slotAssignment.agentId || getUserCoordinatorAgentId(effectiveUserId))
        : (msg.agent || devicePrefs?.default_agent_id || getUserCoordinatorAgentId(effectiveUserId));
      // Voice preferences and wake-slot assignments remain stored unchanged so
      // switching back to ensemble restores their original targets. Resolve
      // the active turn through the current projection for abort keys, output
      // events, and session bookkeeping as well as for chat dispatch itself.
      const routedAgentId = resolveRuntimeAgentId(effectiveUserId, requestedVoiceAgentId, {
        fallbackUnknown: true,
      }) || getUserCoordinatorAgentId(effectiveUserId);
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
          for (const client of getMainWss().clients) {
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

export async function maybePushVoiceConfig(ws) {
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

export async function pushVoiceConfigVersion(ws) {
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
