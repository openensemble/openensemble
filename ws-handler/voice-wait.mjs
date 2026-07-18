/**
 * Voice background-wait ring + spoken announcement drain.
 * Extracted from ws-handler.mjs — pure move.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { log } from '../logger.mjs';
import { getMainWss } from './main-wss.mjs';
import { sendToDevice, armFollowupAfterDrain } from './delivery.mjs';
import { hasVoiceAnnouncements, nextVoiceAnnouncement } from '../lib/voice-announcements.mjs';
import { getDevice } from '../lib/voice-devices.mjs';
import { loadConfig } from '../routes/_helpers.mjs';
import { getVoiceRef } from '../lib/voice-refs.mjs';
import { createVoiceTtsStreamer } from '../lib/voice-tts-stream.mjs';
import { isVoiceOutputSuppressed } from './voice-stt.mjs';

const OE_DEFAULT_VOICE_STATE = path.join(os.homedir(), '.openensemble', 'models', 'tts', 'pocket-tts', 'default-voice.safetensors');

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

export function reassertWaitHints() {
  const now = Date.now();
  for (const [deviceId, st] of _bgWaitHints) {
    if (now - st.lastSentAt < 10_000) continue;
    st.lastSentAt = now;
    sendToDevice(deviceId, { type: 'ui_wait', on: true });
  }
}

export function drainVoiceAnnouncements() {
  if (!getMainWss()) return;
  for (const ws of getMainWss().clients) {
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

export function speakAnnouncement(ws, devicePrefs, entry) {
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
      // The turnless PCM stream carries no text; attach it to the first
      // tts_audio_begin so the TV can render the announcement card (the ESP
      // speakers ignore the extra field). Without this, pocket-tts announcements
      // play audio but show no on-screen card.
      beginText: entry.text,
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
