/**
 * Voice streaming STT + turn/suppress helpers.
 * Extracted from ws-handler.mjs — pure move.
 */

import { randomBytes } from 'crypto';
import { log } from '../logger.mjs';
import { abortChat } from '../chat-dispatch.mjs';
import { endTurn } from '../lib/voice-turn-journal.mjs';

export const STT_SESSION_MAX_BYTES = 512 * 1024;   // 16 s @ 16 kHz mono s16 = fw capture ceiling
export const STT_SESSION_TTL_MS = 25_000;
export const STT_FRAME_MAGIC = Buffer.from('OEA1');
const VOICE_STOP_SUPPRESS_MS = 30_000;

export function dropSttSession(ws, reason) {
  const s = ws._sttSession;
  if (!s) return;
  clearTimeout(s.ttl);
  ws._sttSession = null;
  if (reason) {
    log.info('voice', 'stt session dropped', {
      deviceId: ws._deviceId ?? null, turnId: s.turnId, reason, bytes: s.bytes,
    });
    // A dropped capture is a turn the user experienced as "it ignored me".
    // 'device abort (no speech)' is the benign one — the device heard nothing
    // after the wake — so it gets its own outcome rather than being lumped in
    // with TTL expiry and overflow, which are genuine losses.
    endTurn(s.turnId,
      reason === 'device abort (no speech)' ? 'no_speech' : 'stt_dropped',
      { failStage: 'capture', error: reason, sttBytes: s.bytes });
  }
}

export function handleSttBinaryFrame(ws, raw) {
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

export const sessionKey = (userId, agentId) => `${userId}_${agentId}`;

// Most-recently-started voice turn id per `${effectiveUserId}_${agentId}`
// scope. abortChat() is keyed on user+agent ALONE (no turn id), so a device
// socket that drops after its turn already ended (or was superseded by a newer
// turn on a reconnected socket) must NOT blanket-abort whatever is now running
// under that key. Teardown paths consult this to abort only the turn that
// socket actually still owns.
export const _activeVoiceTurnByKey = new Map();

export function makeVoiceTurn({ ws, effectiveUserId, agentId, wakeSlot, turnId }) {
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

export function suppressVoiceOutput(
  ws,
  reason,
  { sendDone = false, abortTurn = true, allowTurnId = null } = {},
) {
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
    // A hold promotion can have no prior active turn (first wake while a
    // turnless announcement is held). Keep suppressing late untagged output,
    // but never let that broad fallback suppress the exact accepted turn.
    allowTurnId:
      !active?.id && typeof allowTurnId === 'string' && allowTurnId
        ? allowTurnId
        : null,
    until: Date.now() + VOICE_STOP_SUPPRESS_MS,
    reason,
  };

  let abortedChat = false;
  if (abortTurn &&
      active?.id && active?.effectiveUserId && active?.agentId) {
    const key = sessionKey(active.effectiveUserId, active.agentId);
    // abortChat is scoped only by user+agent. A stale device socket may still
    // retain an older voice turn after a newer socket claimed that same scope,
    // so suppress its streamer without aborting the newer chat.
    if (_activeVoiceTurnByKey.get(key) === active.id) {
      abortChat(active.effectiveUserId, active.agentId);
      abortedChat = true;
      // Abort listeners are synchronous; do not erase a claim they replaced.
      if (_activeVoiceTurnByKey.get(key) === active.id) {
        _activeVoiceTurnByKey.delete(key);
      }
    }
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
    abortTurn,
    allowTurnId: ws._voiceOutputSuppression.allowTurnId,
    sentDone: !!sendDone,
  });
  return active;
}

function readDeviceTurnScope(msg) {
  const scoped =
    Object.prototype.hasOwnProperty.call(msg ?? {}, 'turn_id') &&
    msg.turn_id !== undefined &&
    msg.turn_id !== null &&
    msg.turn_id !== '';
  return {
    scoped,
    turnId: typeof msg?.turn_id === 'string' ? msg.turn_id : null,
  };
}

function readDeviceHoldScope(msg) {
  const scoped =
    Object.prototype.hasOwnProperty.call(msg ?? {}, 'hold_id') &&
    msg.hold_id !== undefined &&
    msg.hold_id !== null &&
    msg.hold_id !== '';
  const holdId =
    typeof msg?.hold_id === 'string' &&
    msg.hold_id.length > 0 &&
    msg.hold_id.length <= 80
      ? msg.hold_id
      : null;
  return { scoped, holdId };
}

function holdTurnScopeMatches(hold, turnScope) {
  if (!hold) return false;
  return hold.turnScoped === turnScope.scoped &&
    (!turnScope.scoped || hold.turnId === turnScope.turnId);
}

// A hold is socket-scoped, not streamer-scoped. An announcement or reply can
// be installed after PAUSE reached OE; inherit the latch before it can emit
// PCM so a false wake can still RESUME it and an accepted wake can STOP it.
export function applyVoiceDeviceTtsHold(ws, streamer = ws?._ttsStreamer) {
  if (!ws?._deviceId || !streamer || !ws._ttsHold?.holdId) return streamer;
  try { streamer.pause?.(); } catch {}
  return streamer;
}

export function clearVoiceDeviceTtsHold(ws) {
  if (ws) ws._ttsHold = null;
}

// A verified device chat reuses its provisional hold id as the promoted turn
// id. Treat that exact match as the ACCEPT boundary even if the preceding
// hold-scoped STOP never reached OE: clear the latch and suppress the held old
// socket output before connection.mjs publishes/installs the new turn.
export function promoteVoiceDeviceTtsHold(ws, newTurnId) {
  const hold = ws?._ttsHold ?? null;
  if (!ws?._deviceId || !hold?.holdId ||
      typeof newTurnId !== 'string' || newTurnId !== hold.holdId) {
    return false;
  }

  ws._ttsHold = null;
  const activeTurnId =
    typeof ws._activeVoiceTurn?.id === 'string'
      ? ws._activeVoiceTurn.id
      : null;
  const ownsStoredTurn =
    hold.turnScoped && hold.turnId && hold.turnId === activeTurnId;
  const hadHeldOutput = !!(ws._ttsStreamer || ws._activeVoiceTurn);
  if (hadHeldOutput) {
    suppressVoiceOutput(ws, 'verified_hold_promoted', {
      sendDone: true,
      // A first-wake hold has no prior turn ownership. It may abort its held
      // turnless streamer, but must never turn that into an unscoped abortChat.
      // A scoped hold aborts the old chat only while this socket still owns it.
      abortTurn: !!ownsStoredTurn,
      allowTurnId: newTurnId,
    });
  } else {
    // There is no old output to suppress. Creating the generic turnless
    // suppression window here would unnecessarily hide later announcements;
    // the exact promoted turn supersedes any older no-owner stop window.
    ws._voiceOutputSuppression = null;
  }
  log.info('voice', 'verified tts hold promoted', {
    deviceId: ws._deviceId,
    holdId: hold.holdId,
    oldTurnId: hold.turnScoped ? hold.turnId : null,
    oldTurnOwned: !!ownsStoredTurn,
    hadHeldOutput,
    newTurnId,
  });
  return true;
}

export function handleVoiceDeviceTtsFlow(ws, msg) {
  if (!ws?._deviceId ||
      (msg?.type !== 'tts_pause' && msg?.type !== 'tts_resume')) {
    return false;
  }

  const turnScope = readDeviceTurnScope(msg);
  const holdScope = readDeviceHoldScope(msg);
  const streamer = ws._ttsStreamer ?? null;

  if (holdScope.scoped) {
    if (!holdScope.holdId) {
      log.info('voice', 'invalid tts hold id ignored', {
        deviceId: ws._deviceId,
        type: msg.type,
      });
      return true;
    }

    if (msg.type === 'tts_pause') {
      // A nonempty turn id remains an ownership proof. An empty turn id is
      // valid for the first wake after boot and may hold a turnless
      // announcement, but it never proves ownership of an LLM turn.
      if (turnScope.scoped) {
        const activeTurnId =
          typeof ws._activeVoiceTurn?.id === 'string'
            ? ws._activeVoiceTurn.id
            : null;
        if (!turnScope.turnId || turnScope.turnId !== activeTurnId) {
          log.info('voice', 'scoped tts hold ignored (socket does not own turn)', {
            deviceId: ws._deviceId,
            type: msg.type,
            holdId: holdScope.holdId,
            turnId: turnScope.turnId,
            activeTurnId,
          });
          return true;
        }
      }
      ws._ttsHold = {
        holdId: holdScope.holdId,
        turnScoped: turnScope.scoped,
        turnId: turnScope.scoped ? turnScope.turnId : null,
      };
      applyVoiceDeviceTtsHold(ws, streamer);
      return true;
    }

    const activeHold = ws._ttsHold ?? null;
    if (activeHold?.holdId !== holdScope.holdId ||
        !holdTurnScopeMatches(activeHold, turnScope)) {
      log.info('voice', 'stale tts hold resume ignored', {
        deviceId: ws._deviceId,
        holdId: holdScope.holdId,
        activeHoldId: activeHold?.holdId ?? null,
      });
      return true;
    }
    ws._ttsHold = null;
    try { streamer?.resume?.(); } catch {}
    return true;
  }

  // Legacy firmware did not send hold_id. Preserve its turn/stream ownership
  // behavior exactly and do not create a socket-level latch.
  if (!streamer) return true;

  const scope = turnScope;
  if (scope.scoped) {
    const activeTurnId =
      typeof ws._activeVoiceTurn?.id === 'string'
        ? ws._activeVoiceTurn.id
        : null;
    const streamerTurnId =
      typeof streamer.turnId === 'string'
        ? streamer.turnId
        : null;
    if (!scope.turnId ||
        scope.turnId !== activeTurnId ||
        scope.turnId !== streamerTurnId) {
      log.info('voice', 'scoped tts flow-control ignored (socket does not own turn)', {
        deviceId: ws._deviceId,
        type: msg.type,
        turnId: scope.turnId,
        activeTurnId,
        streamerTurnId,
      });
      return true;
    }
  }

  if (msg.type === 'tts_pause') {
    try { streamer.pause?.(); } catch {}
  } else {
    try { streamer.resume?.(); } catch {}
  }
  return true;
}

export function handleVoiceDeviceStop(
  ws,
  msg,
  { getCoordinatorAgentId = () => null } = {},
) {
  if (!ws?._deviceId) return false;

  const holdScope = readDeviceHoldScope(msg);
  // Firmware with turn correlation sends the exact turn it intends to stop.
  // Treat that as an ownership proof, not a hint: after a reconnect this
  // socket has no active claim, and abortChat() is scoped only by user+agent.
  // Falling through in that state could abort an unrelated browser/device
  // turn. Only legacy frames that omit (or explicitly empty) turn_id retain
  // the old unscoped fallback.
  const scope = readDeviceTurnScope(msg);
  const activeTurnId =
    typeof ws._activeVoiceTurn?.id === 'string'
      ? ws._activeVoiceTurn.id
      : null;
  if (holdScope.scoped) {
    const activeHold = ws._ttsHold ?? null;
    if (!holdScope.holdId ||
        activeHold?.holdId !== holdScope.holdId ||
        !holdTurnScopeMatches(activeHold, scope)) {
      log.info('voice', 'stale scoped hold stop ignored', {
        deviceId: ws._deviceId,
        holdId: holdScope.holdId,
        activeHoldId: activeHold?.holdId ?? null,
      });
      return true;
    }
  }
  if (scope.scoped &&
      (!scope.turnId || scope.turnId !== activeTurnId)) {
    log.info('voice', 'scoped stop ignored (socket does not own turn)', {
      deviceId: ws._deviceId,
      stopTurnId: scope.turnId,
      activeTurnId,
    });
    return true;
  }

  if (holdScope.scoped) ws._ttsHold = null;
  const stoppedTurn = suppressVoiceOutput(ws, 'stop', {
    sendDone: true,
    // A matching hold id can safely target a turnless streamer on the first
    // wake, but an empty turn id must never unlock abortChat's user+agent
    // fallback or claim ownership of a lingering prior turn.
    abortTurn: !holdScope.scoped || scope.scoped,
  });
  if (holdScope.scoped && !scope.scoped) return true;
  if (!stoppedTurn) {
    // Legacy unscoped device stops predate turn ids. Preserve their fallback
    // routing through the last known slot owner/coordinator.
    const last = ws._lastVoiceTurn;
    const stopAgent = typeof msg?.agent === 'string'
      ? msg.agent
      : (last?.agentId ?? getCoordinatorAgentId(ws._userId));
    const stopUser = last?.effectiveUserId ?? ws._userId;
    if (stopAgent) abortChat(stopUser, stopAgent);
  }
  return true;
}

export function isVoiceOutputSuppressed(ws, turn) {
  if (!ws?._deviceId) return false;
  const s = ws._voiceOutputSuppression;
  if (!s) return false;
  if (turn?.id && s.allowTurnId === turn.id) return false;
  if (turn?.id && s.turnId === turn.id) return true;
  return !s.turnId && Date.now() < s.until;
}
