// @ts-check
/**
 * Speak scheduled reminders aloud on paired voice devices.
 *
 * Two-step playback per device, riding the existing TTS pipeline:
 *   1. short chime (pre-generated MP3, regenerated at first use)
 *   2. spoken "Reminder: <label>" via the user's configured TTS provider
 *
 * Both clips are pushed as separate `token` + `done` pairs. The firmware's
 * tts_worker_task queues sentences and plays them sequentially, so chime then
 * TTS plays in order without any timing race. Each clip is stashed under a
 * one-shot marker the device echoes back to /api/tts; the route's marker
 * short-circuit returns our pre-rendered MP3 without invoking any provider.
 *
 * Provider synthesis is intentionally duplicated from /api/tts (openai /
 * elevenlabs / piper branches) rather than refactored out — the hot route
 * has extra responsibilities (auth, voice-slot resolution, response writing)
 * and the synthesis surface is small enough that drift is unlikely to bite.
 */
import { spawn } from 'child_process';
import { loadConfig } from '../routes/_helpers.mjs';
import { sendToDevice, isDeviceOnline } from '../ws-handler.mjs';
import { listDevices } from './voice-devices.mjs';
import { readVoiceConfig } from './voice-config.mjs';
import { cacheOneShotMp3 } from '../routes/devices.mjs';

let _chimeMp3 = null;

async function buildChimeMp3() {
  // Two-tone alert (B5 → E6, 110 ms each with a 30 ms gap), softened to 40%
  // amplitude so it's a notification cue not an alarm. Output 16 kHz mono MP3
  // matching the TTS pipeline's resample target — audio_io.c upsamples to the
  // 48 kHz bus on the device.
  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=988:duration=0.11:sample_rate=16000',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=16000:duration=0.03',
    '-f', 'lavfi', '-i', 'sine=frequency=1318:duration=0.13:sample_rate=16000',
    '-filter_complex',
    '[0][1][2]concat=n=3:v=0:a=1,volume=0.4,afade=t=in:d=0.01,afade=t=out:st=0.25:d=0.02',
    '-ac', '1', '-ar', '16000', '-b:a', '48k',
    '-f', 'mp3', 'pipe:1',
  ]);
  const chunks = [];
  ff.stdout.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
  await done;
  return Buffer.concat(chunks);
}

async function getChimeMp3() {
  if (_chimeMp3) return _chimeMp3;
  try {
    _chimeMp3 = await buildChimeMp3();
  } catch (e) {
    // ffmpeg missing or filter syntax broken — fall back to TTS-only so the
    // reminder still gets delivered, just without the alert tone.
    console.warn('[reminder-voice] chime synthesis failed:', e.message);
    _chimeMp3 = Buffer.alloc(0);
  }
  return _chimeMp3;
}

async function ffmpegToDeviceMp3(buf, inputFmt) {
  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', inputFmt, '-i', 'pipe:0',
    '-ac', '1', '-ar', '16000', '-b:a', '48k',
    '-f', 'mp3', 'pipe:1',
  ]);
  const chunks = [];
  ff.stdout.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
  ff.stdin.end(buf);
  await done;
  return Buffer.concat(chunks);
}

/**
 * Pick a TTS voice that's actually valid for the configured provider.
 * cfg.ttsVoice is a global stash and frequently holds a value left over from
 * a different provider (e.g. 'default-en' from F5-TTS, 'alloy' from OpenAI).
 * Normal chat replies dodge this because they resolve via per-slot
 * ttsVoice in the voice-config, but the reminder path has no slot context.
 *
 * Resolution order:
 *   1. The first slot the user owns whose ttsVoice "fits" the provider
 *      (UUID-ish for elevenlabs, integer for piper, named voice for openai)
 *   2. Provider's hard-coded default if nothing valid was configured
 *
 * cfg.ttsVoice itself is intentionally NOT consulted — too unreliable.
 */
function pickReminderVoice(userId, provider) {
  const defaultVoice =
    // Empty string for piper = let the multivoice server pick its own default
    // (PIPER_DEFAULT_VOICE from systemd unit, falling back to first installed).
    provider === 'piper' ? '' :
    provider === 'elevenlabs' ? '21m00Tcm4TlvDq8ikWAM' :
    'alloy';
  const looksValid = (v) => {
    if (typeof v !== 'string' || !v) return false;
    if (provider === 'elevenlabs') return /^[A-Za-z0-9]{15,}$/.test(v);
    if (provider === 'piper') {
      // Three accepted shapes after the multivoice migration:
      //   bare integer (legacy libritts_r speaker id)
      //   "<voice-id>"               single-speaker voice
      //   "<voice-id>:<speaker_id>"  multi-speaker voice
      return /^\d+$/.test(v) || /^[a-zA-Z0-9_-]+(:\d+)?$/.test(v);
    }
    // openai: any plausibly-named voice (skip the F5-TTS 'default-en' legacy)
    return /^[a-z]+$/.test(v);
  };
  try {
    const cfg = readVoiceConfig(userId);
    for (const a of Object.values(cfg.slot_assignments || {})) {
      if (a?.ownerUserId === userId && looksValid(a.ttsVoice)) return a.ttsVoice;
    }
  } catch {}
  return defaultVoice;
}

// Exposed for callers that want the raw MP3 buffer (alarms cache it
// per-alarm so the device-side architecture in Phase C can fetch it once).
export async function synthesizeTts(text, userId) {
  return synthesizeReminderTts(text, userId);
}

async function synthesizeReminderTts(text, userId) {
  const cfg = loadConfig();
  const ALLOWED = ['openai', 'piper', 'elevenlabs'];
  const provider = ALLOWED.includes(cfg.ttsProvider) ? cfg.ttsProvider : 'openai';
  const voice = pickReminderVoice(userId, provider);

  if (provider === 'elevenlabs') {
    if (!cfg.elevenlabsApiKey) throw new Error('ElevenLabs API key not configured');
    const elModel = cfg.elevenlabsModel || 'eleven_turbo_v2_5';
    // Match /api/tts: slow the turbo model's brisk default cadence via `speed`
    // (cfg.elevenlabsSpeed, default 0.85) and pin style:0 for stable pacing.
    const elSpeed = Number.isFinite(cfg.elevenlabsSpeed)
      ? Math.min(1.2, Math.max(0.7, cfg.elevenlabsSpeed)) : 0.85;
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
      method: 'POST',
      headers: { 'xi-api-key': cfg.elevenlabsApiKey, 'Accept': 'audio/mpeg', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: elModel, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, speed: elSpeed } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`ElevenLabs ${r.status} (voice=${voice}): ${body.slice(0, 200)}`);
    }
    return ffmpegToDeviceMp3(Buffer.from(await r.arrayBuffer()), 'mp3');
  }

  if (provider === 'piper') {
    // Parse the same three shapes accepted in /api/tts:
    //   "42"                            → libritts_r:42 (legacy)
    //   "en_AU-OE_custom-medium"        → single-speaker
    //   "en_US-libritts_r-medium:42"    → multi-speaker
    let voiceId = '', speakerId = null;
    if (voice) {
      if (/^\d+$/.test(voice)) {
        voiceId = 'en_US-libritts_r-medium';
        speakerId = Number.parseInt(voice, 10);
      } else if (voice.includes(':')) {
        const [v, s] = voice.split(':', 2);
        voiceId = v;
        const n = Number.parseInt(s, 10);
        if (Number.isFinite(n)) speakerId = n;
      } else {
        voiceId = voice;
      }
    }
    const piperBase = (cfg.piperUrl || 'http://127.0.0.1:5151/').replace(/\/+$/, '');
    // Matches /api/tts piper branch — cfg.piperLengthScale (default 1.1)
    // slows Piper voices ~10% for a more natural read.
    const lengthScale = Number.isFinite(cfg.piperLengthScale) ? cfg.piperLengthScale : 1.1;
    const r = await fetch(piperBase + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        ...(voiceId ? { voice: voiceId } : {}),
        ...(Number.isFinite(speakerId) ? { speaker_id: speakerId } : {}),
        length_scale: lengthScale,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Piper returned ${r.status}`);
    return ffmpegToDeviceMp3(Buffer.from(await r.arrayBuffer()), 'wav');
  }

  if (!cfg.ttsApiKey || !cfg.ttsApiUrl) throw new Error('TTS provider not configured');
  const r = await fetch(cfg.ttsApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.ttsApiKey}` },
    body: JSON.stringify({ model: cfg.ttsModel || 'tts-1', voice, input: text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`TTS API returned ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Decide which devices a reminder should fire on, given a user-wide channel,
 * an optional per-task override, and the user's stored preferred device.
 *
 *   - taskDeviceId set  → that device only (per-task override wins)
 *   - channel='voice'   → user.reminderVoiceDeviceId only
 *   - channel='all'     → every paired device
 *
 * Returned list is unfiltered (caller filters for online).
 */
export function pickReminderDevices({ user, channel, taskDeviceId }) {
  if (!user) return [];
  if (taskDeviceId) return [taskDeviceId];
  if (channel === 'all') return listDevices(user.id).map(d => d.id);
  if (channel === 'voice' && user.reminderVoiceDeviceId) return [user.reminderVoiceDeviceId];
  return [];
}

/**
 * Speak `text` (by default prefixed with "Reminder: ") on `deviceIds` paired
 * to userId. Synthesizes the announcement once, then pushes chime + TTS as
 * one-shot audio markers — firmware fetches each from /api/tts and queues
 * for playback. Skips offline devices silently (they can't fetch a marker).
 *
 * Options:
 *   prefix — text prepended to `text` before synthesis (default "Reminder: ").
 *            Pass '' for routine TTS or any other server-initiated speech
 *            where "Reminder:" would be wrong.
 *   chime  — whether to play the two-tone alert before the TTS (default true).
 *
 * Alarms no longer route through here; they use sendAlarmArm in
 * lib/alarms.mjs and the device-side ring loop owns playback.
 */
export async function speakReminder({ userId, deviceIds, text, prefix = 'Reminder: ', chime = true }) {
  const ids = Array.isArray(deviceIds) ? deviceIds : (deviceIds ? [deviceIds] : []);
  if (!ids.length || !text) return [];
  const owned = new Set(listDevices(userId).map(d => d.id));
  const targets = ids.filter(id => owned.has(id) && isDeviceOnline(id));
  if (!targets.length) return [];

  let ttsMp3;
  try {
    ttsMp3 = await synthesizeReminderTts(`${prefix}${text}`, userId);
  } catch (e) {
    console.warn(`[reminder-voice] TTS synthesis failed: ${e.message}`);
    return [];
  }
  const chimeMp3 = chime ? await getChimeMp3() : Buffer.alloc(0);

  const delivered = [];
  for (const deviceId of targets) {
    if (chimeMp3.length) {
      const m1 = cacheOneShotMp3(chimeMp3);
      sendToDevice(deviceId, { type: 'token', text: m1, agent: 'system' });
      sendToDevice(deviceId, { type: 'done', agent: 'system' });
    }
    const m2 = cacheOneShotMp3(ttsMp3);
    sendToDevice(deviceId, { type: 'token', text: m2, agent: 'system' });
    sendToDevice(deviceId, { type: 'done', agent: 'system' });
    delivered.push(deviceId);
  }
  return delivered;
}
