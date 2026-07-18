/**
 * Voice streaming STT + turn/suppress helpers.
 * Extracted from ws-handler.mjs — pure move.
 */

import { randomBytes } from 'crypto';
import { log } from '../logger.mjs';
import { abortChat } from '../chat-dispatch.mjs';

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
// under that key. The close handler consults this to abort only the turn the
// closing socket actually still owns.
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

export function suppressVoiceOutput(ws, reason, { sendDone = false } = {}) {
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

export function isVoiceOutputSuppressed(ws, turn) {
  if (!ws?._deviceId) return false;
  const s = ws._voiceOutputSuppression;
  if (!s) return false;
  if (turn?.id && s.turnId === turn.id) return true;
  return !s.turnId && Date.now() < s.until;
}

