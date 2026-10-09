import { createVoiceTtsStreamer } from './voice-tts-stream.mjs';
import { mobilePocketVoice } from './mobile-voice-settings.mjs';

// Opt-in browser-authenticated mobile audio. Never grant hardware identity or
// wake-slot cross-account routing to a phone; text continues its normal fanout.
export function startMobileVoiceStream(ws, msg, cfg, log) {
  const validID = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
  if (!ws._userId || ws._deviceId || msg.client !== 'ios-app' || msg.source !== 'voice-device'
      || msg.tts_stream !== true || !validID(msg.attempt_id) || !validID(msg.message_id)) return null;
  ws._mobileVoice?.abort();
  const tags = { attempt_id: msg.attempt_id, message_id: msg.message_id };
  const send = frame => {
    if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify({ ...frame, ...tags })); } catch {} }
  };
  if (cfg.ttsProvider !== 'pocket-tts') {
    send({ type: 'voice_stream', mode: 'file' });
    return null;
  }
  const voice = mobilePocketVoice(ws._userId, cfg);
  let terminal = false;
  let textFinished = false;
  let intentional = false;
  const streamer = createVoiceTtsStreamer({
    cfg, ...voice, log,
    // Mobile IDs are not hardware journal IDs.
    isOpen: () => ws.readyState === ws.OPEN,
    bufferedAmount: () => ws.bufferedAmount ?? 0,
    send: frame => {
      if (!terminal && frame.type === 'tts_audio') {
        send({ type: 'voice_audio', seq: frame.seq, pcm_b64: frame.pcm_b64 });
      }
      // Hardware burst begin/end and its no-audio `done` are not text terminals.
      // onClosed is the sole terminal; it includes synthesis failures.
    },
  });
  const api = {
    attemptId: msg.attempt_id,
    get finished() { return terminal || streamer.finished; },
    get textFinished() { return textFinished; },
    abort() { intentional = true; streamer.abort(); },
    onEvent(e) {
      if (e.attempt_id && e.attempt_id !== msg.attempt_id) return;
      if (e.type === 'done' || e.type === 'error') textFinished = true;
      if (terminal) return;
      if (e.type === 'token' && typeof e.text === 'string') streamer.pushText(e.text);
      else if (e.type === 'replace') {
        // Already-spoken text cannot be retracted. Stop audio on corrections.
        if (streamer.hasContent) api.abort();
        else if (typeof e.text === 'string') streamer.pushText(e.text);
      } else if (e.type === 'done') {
        if (e.silent) api.abort(); else streamer.finish();
      } else if (e.type === 'error') api.abort();
    },
  };
  ws._mobileVoice = api;
  send({ type: 'voice_stream', mode: 'pcm', sr: 16000, channels: 2, encoding: 's16le' });
  streamer.onClosed(clean => {
    if (terminal) return;
    terminal = true;
    send({ type: 'voice_end', ok: (clean && !streamer.hadSynthesisError) || intentional, cancelled: intentional });
    if (ws._mobileVoice === api) ws._mobileVoice = null;
  });
  return api;
}

export function stopMobileVoiceStream(ws, attemptId) {
  if (!ws._deviceId && typeof attemptId === 'string' && ws._mobileVoice?.attemptId === attemptId) {
    ws._mobileVoice.abort();
    return true;
  }
  return false;
}
