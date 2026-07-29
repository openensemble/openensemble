/**
 * User/device WebSocket delivery helpers (broadcast, sendTo*, online probes).
 * Extracted from ws-handler.mjs — pure move. Main connection setup stays there.
 */

import { getOrchestrationPolicy, getRequestedOrchestrationPolicy } from '../lib/orchestration-policy.mjs';
import { getMainWss } from './main-wss.mjs';
import { log } from '../logger.mjs';
import { fleetSpeechActiveElsewhere, isVoicePolicyEnabled } from '../lib/voice-policy.mjs';

// Monotonic per-user/per-agent watermark for live chat/session events. A
// session load captures this value BEFORE its async disk read; if the browser
// has already reduced a larger value by the time that response arrives, it
// knows the snapshot is older and must merge rather than erase those live rows.
const _chatRevisions = new Map();
let _sessionSnapshotSeq = 0;
export function nextSessionSnapshotSeq() { return ++_sessionSnapshotSeq; }

function rawChatAgentId(userId, agentId) {
  const value = typeof agentId === 'string' ? agentId : '';
  const prefix = `${userId}_`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function chatRevisionKey(userId, agentId) {
  return `${userId}:${rawChatAgentId(userId, agentId)}`;
}

export function getChatRevision(userId, agentId) {
  return _chatRevisions.get(chatRevisionKey(userId, agentId)) ?? 0;
}

export function stampChatEvent(userId, event) {
  if (!event || typeof event !== 'object' || !event.agent) return event;
  if (Number.isFinite(event.chat_revision)) return event;
  const key = chatRevisionKey(userId, event.agent);
  const revision = (_chatRevisions.get(key) ?? 0) + 1;
  _chatRevisions.set(key, revision);
  return { ...event, chat_revision: revision };
}


export function orchestrationPolicyForClient(userId) {
  const requested = getRequestedOrchestrationPolicy(userId);
  if (requested.pendingPrimary) return { mode: 'single', pendingPrimary: true };
  const effective = getOrchestrationPolicy(userId);
  return {
    mode: effective.mode,
    ...(effective.primaryAgentId ? { primaryAgentId: effective.primaryAgentId } : {}),
  };
}

// ── Broadcast helpers ────────────────────────────────────────────────────────
export function broadcast(msg) {
  if (!getMainWss()) return;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of getMainWss().clients)
    if (client.readyState === client.OPEN && !client._deviceId) try { client.send(data); } catch {}
}


export function broadcastToUsers(userIds, msg) {
  if (!getMainWss()) return;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const idSet = new Set(userIds);
  for (const client of getMainWss().clients)
    if (client.readyState === client.OPEN && !client._deviceId && idSet.has(client._userId)) try { client.send(data); } catch {}
}

/** Send a message to every tab the given user has open. Returns delivery count. */
export function sendToUser(userId, msg) {
  if (!getMainWss()) return 0;
  const stamped = typeof msg === 'string' ? msg : stampChatEvent(userId, msg);
  const data = typeof stamped === 'string' ? stamped : JSON.stringify(stamped);
  let delivered = 0;
  for (const client of getMainWss().clients) {
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
  if (!getMainWss() || !deviceId) return 0;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  let delivered = 0;
  let sendError = null;
  for (const client of getMainWss().clients) {
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
  if (!getMainWss() || !deviceId) return 0;
  let closed = 0;
  for (const client of getMainWss().clients) {
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
export function armFollowupAfterDrain(deviceId, { windowMs = 5000, conversation = false, disposition = null, chainTail = false } = {}) {
  if (!getMainWss() || !deviceId) return false;
  for (const client of getMainWss().clients) {
    if (client.readyState !== client.OPEN || client._deviceId !== deviceId) continue;
    // Tag with the turn the window belongs to (resolved at SEND time — the
    // firmware drops a window whose turn it has already moved past). Older
    // firmware ignores the extra `disposition` field and uses windowMs alone.
    const payload = () => ({
      type: 'await_followup', windowMs,
      ...(conversation ? { conversation: true } : {}),
      ...(disposition ? { disposition } : {}),
      ...(client._activeVoiceTurn?.id ? { turn_id: client._activeVoiceTurn.id } : {}),
    });
    // Resolved at SEND time like the turn tag: window bookkeeping for the
    // dispatch-side gate (chain tail / continuation check), plus the two
    // fleet-policy telemetry signals the design doc tunes on — windows
    // suppressed because another device is speaking, and windows that expired
    // with nothing captured (the harmless case that should dominate).
    const armNow = () => {
      // `required` windows are exempt: the assistant asked the user a
      // question (timer disambig, pending clarification) and the exchange
      // hangs if the window never opens — another device talking is a worse
      // reason to strand it than the risk of capturing that device's audio,
      // which the transcript self-audio check still covers.
      if (isVoicePolicyEnabled() && disposition !== 'required') {
        const speakingDevice = fleetSpeechActiveElsewhere(client._userId, deviceId);
        if (speakingDevice) {
          log.info('voice', 'followup window suppressed (fleet tts active)', {
            deviceId, speakingDevice, disposition: disposition ?? null, windowMs,
          });
          return;
        }
      }
      const armedAt = Date.now();
      client._followupArmedUntil = armedAt + windowMs + 1000;
      client._followupWindow = {
        disposition: disposition ?? null,
        chainTail: !!chainTail,
        windowMs,
        armedAt,
        until: armedAt + windowMs + 1500,
        captured: false,
      };
      log.info('voice', 'followup window armed', {
        deviceId, disposition: disposition ?? null, windowMs, chainTail: !!chainTail,
        conversation: !!conversation,
      });
      const expiry = setTimeout(() => {
        const w = client._followupWindow;
        if (w && w.armedAt === armedAt && !w.captured) {
          log.info('voice', 'followup window expired unused', {
            deviceId, disposition: disposition ?? null, windowMs, chainTail: !!chainTail,
          });
        }
      }, windowMs + 2500);
      expiry.unref?.();
      sendToDevice(deviceId, payload());
    };
    const streamer = client._ttsStreamer;
    if (streamer && !streamer.closed && !streamer.aborted) {
      streamer.onClosed((clean) => {
        if (!clean) return;
        if (client.readyState === client.OPEN) armNow();
      });
      return true;
    }
    armNow();
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
  if (!getMainWss() || !deviceId) return false;
  for (const client of getMainWss().clients) {
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
  if (!getMainWss() || !ip) return null;
  const want = String(ip).replace(/^::ffff:/, '');
  for (const client of getMainWss().clients) {
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
