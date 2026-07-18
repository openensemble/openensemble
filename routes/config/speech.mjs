/**
 * TTS/STT config routes + ambient stream state.
 * Extracted from routes/config.mjs — pure move.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  requireAuth, loadConfig, readBody, readBodyBuffer, safeError,
} from '../_helpers.mjs';
import { getSlotAssignment } from '../../lib/voice-devices.mjs';
import { getVoiceRef } from '../../lib/voice-refs.mjs';
import {
  takeTestMp3,
  takeAmbientStream, registerAmbientResponse, unregisterAmbientResponse,
  pinAmbientMp3, rearmAmbientTtl,
} from '../devices.mjs';
import { ambientFilePath } from '../../lib/routines.mjs';
import {
  probePiperAvailable,
  probeKittenttsAvailable,
  probePocketTtsAvailable,
  probeFasterWhisperAvailable,
  probeFfmpegAvailable,
  getTtsAvailability,
} from '../../lib/voice-deps.mjs';
import { log } from '../../logger.mjs';

// Live ffmpeg processes for ambient streams keyed by marker. Lets the
// /api/tts handler reattach a new HTTP response to an existing ffmpeg
// when the device reconnects after a wake (no cold ffmpeg restart, no
// PassThrough warmup, no decode-error burst on resume). Entries are
// removed on explicit stop (forceKill) or grace timeout.
//   marker → { ff, ff_buf, killTimer, forceKill }
const _ambientStreams = new Map();
const STREAM_GRACE_MS = 10_000;

// Start the grace timer when the current ambient response closes. ffmpeg
// keeps encoding into ff_buf until the buffer fills (then it back-pressures
// and pauses). If the device re-requests this marker within the window,
// the /api/tts handler clears the timer and pipes ff_buf to the new res.
function startAmbientGrace(streamEntry, marker, res) {
  if (streamEntry.killTimer) return; // already in grace from a prior close
  try { streamEntry.ff_buf.unpipe(res); } catch {}
  streamEntry.killTimer = setTimeout(() => {
    if (streamEntry.killTimer) streamEntry.forceKill?.();
    console.log(`[tts] ambient stream EXPIRED after ${STREAM_GRACE_MS / 1000}s grace marker=${marker}`);
  }, STREAM_GRACE_MS);
  console.log(`[tts] ambient stream PAUSED (grace ${STREAM_GRACE_MS / 1000}s) marker=${marker}`);
}

// KittenTTS nano-0.2 ships 8 preset voices (no cloning). Listed here so the
// UI dropdown and /api/tts/info can surface them without round-tripping to
// the kittentts subprocess.
const KITTENTTS_VOICES = [
  'expr-voice-2-m', 'expr-voice-2-f',
  'expr-voice-3-m', 'expr-voice-3-f',
  'expr-voice-4-m', 'expr-voice-4-f',
  'expr-voice-5-m', 'expr-voice-5-f',
];
const KITTENTTS_DEFAULT_VOICE = 'expr-voice-2-f';

// Piper voice catalog — what the Settings/Providers UI offers users to
// download once the Piper service is installed. Each entry is downloadable
// independently (POST /api/provider-config/install-piper-voice). The
// multivoice server in scripts/piper-multivoice-server.py picks up new files
// automatically (no service restart needed). `source: 'openensemble'` voices
// live in our own HF repo; everything else falls back to rhasspy/piper-voices.
const PIPER_VOICE_CATALOG = [
  { id: 'en_AU-OE_custom-medium',      label: 'OE Custom AU (Australian female)',    lang: 'en_AU', gender: 'female', quality: 'medium', size_mb: 61,  multi_speaker: false, source: 'openensemble' },
  { id: 'en_US-amy-medium',            label: 'Amy (American female)',                lang: 'en_US', gender: 'female', quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_US-lessac-medium',         label: 'Lessac (American female)',             lang: 'en_US', gender: 'female', quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_US-ryan-medium',           label: 'Ryan (American male)',                 lang: 'en_US', gender: 'male',   quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_US-libritts_r-medium',     label: 'LibriTTS-R (904-speaker multi)',       lang: 'en_US', gender: 'mixed',  quality: 'medium', size_mb: 75,  multi_speaker: true,  source: 'rhasspy' },
  { id: 'en_GB-alba-medium',           label: 'Alba (Scottish female)',               lang: 'en_GB', gender: 'female', quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_GB-jenny_dioco-medium',    label: 'Jenny (British RP female)',            lang: 'en_GB', gender: 'female', quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_GB-cori-high',             label: 'Cori (British female, high quality)',  lang: 'en_GB', gender: 'female', quality: 'high',   size_mb: 109, multi_speaker: false, source: 'rhasspy' },
];

// Derive the HF base URL for a voice id (mirrors install-piper.sh URL logic).
function piperVoiceUrlBase(voiceId) {
  const repo = voiceId.startsWith('en_AU-OE_custom-')
    ? 'https://huggingface.co/openensemble/piper-voices/resolve/main'
    : 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
  // Convention: <lang_REGION>-<name>-<quality> → /<lang>/<lang_REGION>/<name>/<quality>/
  const [langRegion, ...rest] = voiceId.split('-');
  const quality = rest[rest.length - 1];
  const name = rest.slice(0, -1).join('-');
  const lang = langRegion.split('_')[0];
  return `${repo}/${lang}/${langRegion}/${name}/${quality}`;
}

/**
 * @returns {Promise<boolean>} true if this module handled the request
 */
export async function tryHandleSpeechRoutes(req, res) {

  // Lightweight read-only info about the configured TTS provider. Used by
  // the Voice devices drawer to render the right voice-picker control
  // (numeric speaker ID for piper, named voice for openai). No secrets
  // returned; cheaper than re-fetching the full /api/config blob.
  if (req.url === '/api/tts/info' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const ALLOWED = ['openai', 'piper', 'kittentts', 'elevenlabs', 'pocket-tts'];
    const provider = ALLOWED.includes(cfg.ttsProvider) ? cfg.ttsProvider : 'openai';
    // Runtime availability snapshot — lets the devices drawer show a
    // banner when the configured provider can't actually fulfill TTS
    // (missing ffmpeg, Piper service down, key cleared, etc.) instead
    // of letting the device hang in THINKING on the next wake.
    const available = await getTtsAvailability(cfg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      provider,
      defaultVoice: cfg.ttsVoice ?? null,
      available,
      ...(provider === 'piper' ? { speakerCount: 904 } : {}),
      ...(provider === 'kittentts' ? { voices: KITTENTTS_VOICES } : {}),
      ...(provider === 'elevenlabs' ? { keySet: !!cfg.elevenlabsApiKey } : {}),
    }));
    return true;
  }

  // Lightweight read-only info about the configured STT path. Used by the
  // Voice devices drawer to show whether wake-capture can actually become a
  // transcript before the user discovers it through a silent device turn.
  if (req.url === '/api/stt/info' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const mode = cfg.sttMode === 'local' ? 'local' : 'remote';
    const localAvailable = await probeFasterWhisperAvailable(cfg);
    const remoteConfigured = !!(cfg.sttApiUrl && cfg.sttApiKey);
    const available = mode === 'local' ? localAvailable : remoteConfigured;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mode,
      available,
      localAvailable,
      remoteConfigured,
      installed: cfg.integrations?.faster_whisper?.installed === true,
      profile: cfg.integrations?.faster_whisper?.profile ?? null,
      apiUrl: mode === 'remote' ? (cfg.sttApiUrl ?? '') : 'http://127.0.0.1:5154/v1/audio/transcriptions',
      model: cfg.sttModel || (mode === 'local' ? 'large-v3-turbo' : 'whisper-1'),
      language: cfg.sttLanguage || 'en',
      keySet: !!cfg.sttApiKey,
    }));
    return true;
  }

  // List ElevenLabs voices (pre-made + user-cloned). Proxies the EL
  // /v1/voices endpoint so the API key stays server-side; UI populates
  // its per-slot dropdown from the response. Cached in-memory for 60 s
  // to avoid hammering EL on every drawer reopen.
  if (req.url === '/api/tts/elevenlabs/voices' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (!cfg.elevenlabsApiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ElevenLabs API key not configured' }));
      return true;
    }
    try {
      const elRes = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': cfg.elevenlabsApiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!elRes.ok) throw new Error(`ElevenLabs returned ${elRes.status}`);
      const data = await elRes.json();
      const voices = (data.voices || []).map(v => ({
        id: v.voice_id,
        label: v.name,
        category: v.category,  // 'premade' / 'cloned' / 'generated' / 'professional'
        description: v.description ?? null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // GET /api/tts/piper/catalog
  // Static list of Piper voices the UI offers for download. Anyone authed
  // can read it; the install action below is admin-only.
  if (req.url === '/api/tts/piper/catalog' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ voices: PIPER_VOICE_CATALOG }));
    return true;
  }

  // GET /api/tts/piper/voices
  // Proxy to the multivoice server's /voices endpoint — list what's *installed*
  // on this box right now. Voice Devices uses this to populate slot dropdowns.
  if (req.url === '/api/tts/piper/voices' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const base = (cfg.piperUrl || 'http://127.0.0.1:5151/').replace(/\/+$/, '');
    try {
      const pr = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(3000) });
      if (!pr.ok) throw new Error(`piper service returned ${pr.status}`);
      const installed = await pr.json();
      // Enrich each installed entry with catalog label/gender/etc when known.
      const catIndex = Object.fromEntries(PIPER_VOICE_CATALOG.map(v => [v.id, v]));
      const voices = installed.map(v => ({ ...v, ...(catIndex[v.id] ?? {}) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices }));
    } catch (e) {
      // Piper service down → return empty list rather than 500, so UI degrades
      // to "no voices installed" instead of breaking the Voice Devices panel.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices: [], error: e.message }));
    }
    return true;
  }

  // POST /api/provider-config/install-piper-voice  body: { voice: "<voice-id>" }
  // Downloads one Piper voice (onnx + onnx.json) into models/tts/. The
  // multivoice server hot-picks it up on the next /voices request — no
  // systemd restart needed. Admin-only because it writes shared system state.
  if (req.url === '/api/provider-config/install-piper-voice' && req.method === 'POST') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    try {
      const { voice } = JSON.parse(await readBody(req));
      const entry = PIPER_VOICE_CATALOG.find(v => v.id === voice);
      if (!entry) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown voice id: ${voice}` }));
        return true;
      }
      const modelDir = path.join(os.homedir(), '.openensemble', 'models', 'tts');
      fs.mkdirSync(modelDir, { recursive: true });
      const base = piperVoiceUrlBase(voice);
      const targets = [
        { url: `${base}/${voice}.onnx`,      dest: path.join(modelDir, `${voice}.onnx`) },
        { url: `${base}/${voice}.onnx.json`, dest: path.join(modelDir, `${voice}.onnx.json`) },
      ];
      const { pipeline } = await import('node:stream/promises');
      const { Readable } = await import('node:stream');
      for (const { url, dest } of targets) {
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue; // resumable
        const dl = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!dl.ok) throw new Error(`download failed (${dl.status}) for ${url}`);
        await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(dest));
      }
      invalidateVoiceDepsCache();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, voice }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // TTS endpoint — generates audio from text using configured TTS provider
  if (req.url === '/api/tts' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    // Three providers supported (f5-tts was removed 2026-05-15 — kept as
    // dead-code branch below for revert convenience; selecting it is no
    // longer possible from the UI and the config validator rejects it):
    //   'openai'      — remote OpenAI-compatible (named voice)
    //   'elevenlabs'  — remote ElevenLabs (voice_id, including user-cloned)
    //   'piper'       — local libritts_r multi-speaker via piper-tts.service:5151
    //   'kittentts'   — local 25M-param ONNX (CPU) via kittentts.service:5153
    const ALLOWED = ['openai', 'piper', 'kittentts', 'elevenlabs', 'pocket-tts'];
    const provider = ALLOWED.includes(cfg.ttsProvider) ? cfg.ttsProvider : 'openai';
    if (provider === 'openai' && (!cfg.ttsApiKey || !cfg.ttsApiUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TTS provider not configured' }));
      return true;
    }
    if (provider === 'elevenlabs' && !cfg.elevenlabsApiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ElevenLabs API key not configured' }));
      return true;
    }
    try {
      const { text, lang, wake_slot, voice: explicitVoice } = JSON.parse(await readBody(req));
      if (!text) throw new Error('text is required');
      // Test-audio short-circuit: when the device echoes back a
      // `__test_audio_XXX__` marker (planted by POST /api/devices/<id>/play-mp3),
      // we return the cached MP3 directly without going through any TTS
      // provider. The cache entry is one-shot (deleted on first read).
      const trimmedText = text.trim();
      if (/^__test_audio_[a-f0-9]+__$/.test(trimmedText)) {
        const cached = takeTestMp3(trimmedText);
        if (cached) {
          console.log(`[tts] test-audio hit marker=${trimmedText} bytes=${cached.length}`);
          // Stream raw audio/mpeg — libhelix on the device decodes chunks
          // as they arrive over the wire. No JSON wrap, no base64 in
          // either direction; firmware oe_tts feeds HTTP_EVENT_ON_DATA
          // bytes straight into mp3_dec.
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': cached.length });
          res.end(cached);
          return true;
        }
        console.warn(`[tts] test-audio marker=${trimmedText} missed cache, falling through to TTS`);
        // Marker recognized but cache miss (expired or already consumed) —
        // fall through to normal TTS so the device still gets something
        // rather than hanging.
      }
      // Pre-flight: every code path below this point shells out to ffmpeg
      // (ambient stream loop, resample to 16 kHz, WAV→MP3 encode). If
      // ffmpeg isn't on PATH, fail fast with a structured 503 so the
      // device firmware can log the install hint and exit THINKING
      // instead of hanging on a dead socket. Cached probe → ~free.
      if (!(await probeFfmpegAvailable())) {
        console.warn('[tts] ffmpeg not installed — refusing TTS request');
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'ffmpeg not installed',
          install: 'sudo apt install ffmpeg (or your distro equivalent), then restart OE',
        }));
        return true;
      }
      // Ambient marker — server streams ONE continuous MP3 via ffmpeg
      // `-stream_loop -1` so the device gets zero silence at loop seams.
      // The response holds open until either the device closes the socket
      // (wake fire / stop) OR a server-side dropAmbientForDevice ends it.
      if (/^__ambient_[a-f0-9]+__$/.test(trimmedText)) {
        const meta = takeAmbientStream(trimmedText);
        if (meta) {
          // Two flavours of source:
          //   meta.file — relative filename in the user's ambient-library dir
          //               (the existing "user uploaded an MP3" flow)
          //   meta.url  — direct http/https URL (skills calling
          //               ctx.device.playStream pass these; ffmpeg pulls
          //               the bytes itself and transcodes inline)
          let sourcePath = null;
          if (meta.url && /^https?:\/\//i.test(meta.url)) {
            sourcePath = meta.url;
          } else if (meta.file) {
            sourcePath = ambientFilePath(meta.userId, meta.file);
          }
          if (!sourcePath) {
            console.warn(`[tts] ambient marker=${trimmedText} resolved no source (file=${meta.file ?? '-'} url=${meta.url ?? '-'})`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ambient source missing' }));
            return true;
          }
          // Grace-period stream reattach: when a wake fires during ambient,
          // the device closes the HTTP response, but we DON'T tear down ffmpeg
          // immediately — we hold it warm in `_ambientStreams` for
          // STREAM_GRACE_MS. If the device re-requests the SAME marker within
          // the grace window (auto-restore after wake), we re-pipe the same
          // ff_buf to the new response — no ffmpeg cold start, no buffer
          // warmup, no decode-error burst at resume. Only explicit stop
          // (dropAmbientMp3 → forceKill) or grace expiry kills ffmpeg.
          const existing = _ambientStreams.get(trimmedText);
          if (existing) {
            if (existing.killTimer) {
              clearTimeout(existing.killTimer);
              existing.killTimer = null;
            }
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
            existing.ff_buf.pipe(res);
            const onResClose = () => startAmbientGrace(existing, trimmedText, res);
            res.on('close', onResClose);
            res.on('error', onResClose);
            registerAmbientResponse(trimmedText, res, existing.forceKill);
            pinAmbientMp3(trimmedText);  // cancel the orphan-cleanup TTL — stream is live
            console.log(`[tts] ambient stream RESUMED (warm reattach) marker=${trimmedText}`);
            return true;
          }
          const { spawn } = await import('child_process');
          const { PassThrough } = await import('stream');
          // Bumped from 'error' → 'warning' so encoder issues surface in
          // server logs. libhelix decode errors on device come from frame
          // issues; ffmpeg's own warnings often correlate. Drop back to
          // 'error' once we're confident the stream is clean.
          const args = ['-loglevel', 'warning'];
          if (meta.loop !== false) args.push('-stream_loop', '-1');
          // Strict CBR + bit-reservoir disabled. libhelix on the device
          // chokes on:
          //   - bit reservoir: frames borrowing bits from prior frames
          //     (errors -2 MAINDATA_UNDERFLOW) — any TCP hiccup loses the
          //     borrowed bits and the decoder can't reassemble the frame.
          //   - VBR / ABR: even within "CBR target" mode libmp3lame varies
          //     frame sizes to maintain quality. Forcing min/max equal to
          //     target makes every frame the same size, eliminating
          //     reservoir trickery entirely.
          //   - bufsize: 16k VBV window matches a tight per-frame budget so
          //     no rate-shaping juggling happens.
          // Cost: marginal audio quality loss vs ABR, fine for ambient
          // thunderstorm / sleep sounds.
          args.push('-i', sourcePath,
                    '-ac', '2', '-ar', '48000',
                    '-c:a', 'libmp3lame',
                    '-b:a', '160k',
                    '-minrate', '160k', '-maxrate', '160k', '-bufsize', '16k',
                    '-reservoir', '0',
                    '-f', 'mp3', 'pipe:1');
          const ff = spawn('ffmpeg', args);
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
          // 1 MB buffer between ffmpeg stdout and the HTTP response. Without
          // this, transient network slowness fills the kernel TCP send buffer,
          // backpressures the response stream, and stalls ff.stdout — ffmpeg
          // pauses encoding mid-frame. When the network catches up ffmpeg
          // bursts the backlog and the device sees byte-rate spikes that
          // libhelix mis-decodes as INVALID_HUFFCODES / FRAMEHEADER errors.
          // Holds ~50s of 160k stereo (1MB ÷ 20 KB/s), enough to absorb
          // realistic Wi-Fi hiccups. During grace this also lets ffmpeg keep
          // encoding without a consumer until full, after which it pauses via
          // backpressure — bytes are preserved for the reattach on resume.
          const ff_buf = new PassThrough({ highWaterMark: 1024 * 1024 });
          ff.stdout.pipe(ff_buf).pipe(res);
          ff.stderr.on('data', d => console.warn(`[tts] ambient ffmpeg: ${d.toString().trim()}`));
          const streamEntry = { ff, ff_buf, killTimer: null, forceKill: null };
          const forceKill = () => {
            if (streamEntry.killTimer) {
              clearTimeout(streamEntry.killTimer);
              streamEntry.killTimer = null;
            }
            try { ff.kill('SIGKILL'); } catch {}
            _ambientStreams.delete(trimmedText);
            unregisterAmbientResponse(trimmedText);
            // The stream is dead — re-arm the orphan TTL so the pinned marker
            // can't live forever as phantom ambient (zombie resurrect on next
            // wake). A prompt device HTTP retry re-attaches and re-pins.
            rearmAmbientTtl(trimmedText);
          };
          streamEntry.forceKill = forceKill;
          _ambientStreams.set(trimmedText, streamEntry);
          const onResClose = () => startAmbientGrace(streamEntry, trimmedText, res);
          ff.on('error', forceKill);
          ff.on('exit', forceKill);
          res.on('close', onResClose);
          res.on('error', onResClose);
          registerAmbientResponse(trimmedText, res, forceKill);
          pinAmbientMp3(trimmedText);  // cancel the orphan-cleanup TTL — stream is live
          console.log(`[tts] ambient stream started (cold) marker=${trimmedText} src=${meta.url ?? meta.file ?? '?'} loop=${meta.loop !== false}`);
          return true;
        }
        console.warn(`[tts] ambient marker=${trimmedText} missed cache (TTL expired or never cached)`);
      }
      // Voice resolution order:
      //   1. explicit `voice` body param (used by Settings → voice preview
      //      to audition an unsaved value before committing it)
      //   2. slot_assignments[wake_slot].ttsVoice for the device making
      //      the request (voice-device + slot in body)
      //   3. cfg.ttsVoice (server-global default)
      //   4. 'alloy' for openai / '0' for piper (hardcoded fallback)
      const defaultVoice =
        provider === 'piper' ? '0' :
        provider === 'kittentts' ? KITTENTTS_DEFAULT_VOICE :
        provider === 'pocket-tts' ? '' : // empty → OE Default voice-state (offline); cloned voices are ref_<hex>; presets are catalog names
        provider === 'elevenlabs' ? '21m00Tcm4TlvDq8ikWAM' : // Rachel — EL stock voice id
        'alloy';
      let voice = cfg.ttsVoice || defaultVoice;
      if (Number.isInteger(wake_slot)) {
        const meta = getSessionMeta(getAuthToken(req));
        if (meta?.deviceId) {
          const a = getSlotAssignment(authId, meta.deviceId, wake_slot);
          if (a?.ttsVoice) voice = a.ttsVoice;
        }
      }
      if (typeof explicitVoice === 'string' && explicitVoice) voice = explicitVoice;
      if (provider === 'elevenlabs') {
        // ElevenLabs returns MP3 directly — no conversion step. voice is a
        // voice_id (UUID-ish string). Default model 'eleven_turbo_v2_5' is
        // their low-latency option; users can override via cfg.elevenlabsModel.
        const elModel = cfg.elevenlabsModel || 'eleven_turbo_v2_5';
        // eleven_turbo_v2_5 ships a brisk default cadence (~25% faster than
        // natural — the "chipmunk" reports). `speed` (0.7-1.2) on voice_settings
        // slows it; `style: 0` keeps pacing stable. Configurable via
        // cfg.elevenlabsSpeed; default 0.85 lands near natural for short replies.
        const elSpeed = Number.isFinite(cfg.elevenlabsSpeed)
          ? Math.min(1.2, Math.max(0.7, cfg.elevenlabsSpeed)) : 0.85;
        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
          method: 'POST',
          headers: {
            'xi-api-key': cfg.elevenlabsApiKey,
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: elModel,
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, speed: elSpeed },
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!elRes.ok) {
          const errBody = await elRes.text().catch(() => '');
          throw new Error(`ElevenLabs ${elRes.status}: ${errBody.slice(0, 200)}`);
        }
        const elMp3 = Buffer.from(await elRes.arrayBuffer());
        // ElevenLabs returns MP3 at 22050 or 44100 Hz. The device's I²S
        // playback runs at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE), so
        // anything higher plays slow + pitched-down. Resample via ffmpeg
        // before sending. Browser-side previews don't suffer this because
        // <audio> handles arbitrary sample rates; only the on-device
        // playback path needs the conversion. Could short-circuit when
        // the request is from a browser-auth session, but the savings
        // (~30 ms ffmpeg pass) aren't worth the branching.
        const { spawn: spawnEl } = await import('child_process');
        const ffEl = spawnEl('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'mp3', '-i', 'pipe:0',
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const elChunks = [];
        ffEl.stdout.on('data', c => elChunks.push(c));
        const ffElPromise = new Promise((resolve, reject) => {
          ffEl.on('error', reject);
          ffEl.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ffEl.stdin.end(elMp3);
        await ffElPromise;
        const elMp3_16k = Buffer.concat(elChunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': elMp3_16k.length });
        res.end(elMp3_16k);
        return true;
      }
      if (provider === 'pocket-tts') {
        // Pocket TTS speaks {text, ref_path} (zero-shot clone from a user's
        // uploaded reference) or {text, voice} (a preset catalog name). A
        // cloned voice is a voice-ref id (ref_<hex>) owned by the AUTH user —
        // the device-paired user manages all voices for their device. No
        // transcript needed (unlike F5): Pocket TTS is fully zero-shot.
        const pocketBody = { text };
        const isRef = typeof voice === 'string' && voice.startsWith('ref_');
        const pref = isRef ? getVoiceRef(authId, voice) : null;
        const oeDefaultState = path.join(os.homedir(), '.openensemble', 'models', 'tts', 'pocket-tts', 'default-voice.safetensors');
        if (pref) pocketBody.ref_path = pref.wavPath;
        else if (voice && !isRef && voice !== 'default-en' && voice !== 'default') pocketBody.voice = voice; // explicit preset
        // OE Default (empty/legacy/deleted-ref) → bundled offline voice-state; else a catalog preset.
        else if (fs.existsSync(oeDefaultState)) pocketBody.ref_path = oeDefaultState;
        else pocketBody.voice = 'george';
        const pocketUrl = cfg.pocketTtsUrl || 'http://127.0.0.1:5155/';
        const pRes = await fetch(pocketUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pocketBody),
          signal: AbortSignal.timeout(60000),
        });
        if (!pRes.ok) throw new Error(`Pocket TTS returned ${pRes.status}`);
        const wavBuf = Buffer.from(await pRes.arrayBuffer());
        const { spawn } = await import('child_process');
        const ff = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'wav', '-i', 'pipe:0',
          // Device I²S is fixed at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE).
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const chunks = [];
        ff.stdout.on('data', c => chunks.push(c));
        const ffPromise = new Promise((resolve, reject) => {
          ff.on('error', reject);
          ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ff.stdin.end(wavBuf);
        await ffPromise;
        const mp3Buf = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3Buf.length });
        res.end(mp3Buf);
        return true;
      }
      if (provider === 'kittentts') {
        // KittenTTS HTTP server speaks {text, voice} → WAV (24 kHz mono).
        // Voice is a preset name from the 8 baked-in choices; we let the
        // server fall back to its default if the caller passes something
        // unrecognized. ffmpeg resamples to the device's 16 kHz I²S bus.
        const kittenttsUrl = cfg.kittenttsUrl || 'http://127.0.0.1:5153/';
        const kRes = await fetch(kittenttsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice }),
          signal: AbortSignal.timeout(30000),
        });
        if (!kRes.ok) throw new Error(`KittenTTS returned ${kRes.status}`);
        const wavBuf = Buffer.from(await kRes.arrayBuffer());
        const { spawn } = await import('child_process');
        const ff = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'wav', '-i', 'pipe:0',
          // Device I²S is fixed at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE).
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const chunks = [];
        ff.stdout.on('data', c => chunks.push(c));
        const ffPromise = new Promise((resolve, reject) => {
          ff.on('error', reject);
          ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ff.stdin.end(wavBuf);
        await ffPromise;
        const mp3Buf = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3Buf.length });
        res.end(mp3Buf);
        return true;
      }
      if (provider === 'piper') {
        // Piper multivoice server speaks {text, voice, speaker_id?} → WAV.
        // We translate OpenAI-shape, run through ffmpeg to get MP3 (matches
        // the device's existing decode path), and return audio/mpeg.
        //
        // The stored slot voice has three shapes:
        //   "en_AU-OE_custom-medium"     → single-speaker voice, no speaker_id
        //   "en_US-libritts_r-medium:42" → multi-speaker voice + speaker_id
        //   "42"                         → legacy bare-numeric, maps to libritts_r:42
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
        // length_scale > 1.0 slows speech; 1.1 takes ~10% longer (Piper VITS
        // voices ship a touch fast for most listeners). Override via
        // cfg.piperLengthScale in config.json.
        const lengthScale = Number.isFinite(cfg.piperLengthScale) ? cfg.piperLengthScale : 1.1;
        const pRes = await fetch(piperBase + '/', {
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
        if (!pRes.ok) throw new Error(`Piper returned ${pRes.status}`);
        const wavBuf = Buffer.from(await pRes.arrayBuffer());
        // WAV → MP3 via ffmpeg subprocess. Pipe in, pipe out. Avoids any
        // disk I/O. 64 kbps mono is fine for speech and keeps the base64
        // payload roughly the same size as OpenAI's tts-1 output.
        const { spawn } = await import('child_process');
        const ff = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'wav', '-i', 'pipe:0',
          // Device I²S is fixed at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE).
          // Sending higher-rate MP3 → libhelix decodes at source rate →
          // played into a 16 kHz I²S pipeline → audio is slower + pitched
          // down. Resample server-side to match the bus.
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const chunks = [];
        ff.stdout.on('data', c => chunks.push(c));
        const ffPromise = new Promise((resolve, reject) => {
          ff.on('error', reject);
          ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ff.stdin.end(wavBuf);
        await ffPromise;
        const mp3Buf = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3Buf.length });
        res.end(mp3Buf);
        return true;
      }
      // OpenAI provider (default / legacy)
      const ttsRes = await fetch(cfg.ttsApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.ttsApiKey}`,
        },
        body: JSON.stringify({
          model: cfg.ttsModel || 'tts-1',
          voice,
          input: text,
          ...(lang ? { language: lang } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!ttsRes.ok) throw new Error(`TTS API returned ${ttsRes.status}`);
      const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
      const mimeType = ttsRes.headers.get('content-type') || 'audio/mpeg';
      res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': audioBuffer.length });
      res.end(audioBuffer);
    } catch (e) { safeError(res, e); }
    return true;
  }

  if (req.url === '/api/stt' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const isLocal = cfg.sttMode === 'local';
    if (!isLocal && (!cfg.sttApiKey || !cfg.sttApiUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'STT provider not configured', configured: false }));
      return true;
    }
    try {
      const ctype = req.headers['content-type'] || '';
      const match = ctype.match(/boundary=(?:"?)([^";]+)/);
      if (!match) throw new Error('Expected multipart/form-data with a boundary');
      // Binary-safe read — readBody() would UTF-8-mangle the WAV bytes.
      const raw = await readBodyBuffer(req);
      // Walk parts, pick the first file part named audio/* or the first audio part
      const boundary = match[1];
      const sep = Buffer.from('--' + boundary);
      let audioBuf = null, audioName = 'speech.webm', audioMime = 'audio/webm';
      let lang = '';
      let cursor = 0;
      while (cursor < raw.length) {
        const sepIdx = raw.indexOf(sep, cursor);
        if (sepIdx === -1) break;
        const nextSep = raw.indexOf(sep, sepIdx + sep.length);
        const part = raw.slice(sepIdx + sep.length, nextSep === -1 ? raw.length : nextSep);
        cursor = sepIdx + sep.length;
        if (part.length < 4) continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4, part.length - 2);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const name = nameMatch?.[1];
        if (!name) continue;
        if (headers.includes('filename=')) {
          if (!audioBuf) {
            audioBuf = body;
            audioName = (headers.match(/filename="([^"]+)"/) ?? [])[1] ?? audioName;
            audioMime = (headers.match(/Content-Type:\s*([^\r\n]+)/) ?? [])[1]?.trim() ?? audioMime;
          }
        } else if (name === 'lang') {
          lang = body.toString().trim();
        }
      }
      if (!audioBuf) throw new Error('No audio part in request');

      // Debug dump — OPT-IN via config.sttDebugDump. The old always-on dump
      // wrote every user's voice audio to world-readable /tmp on the hot
      // path; now it's off by default and lands under the install's logs/.
      if (loadConfig()?.sttDebugDump === true) {
        try {
          const fs = await import('fs');
          const pathMod = await import('path');
          const { BASE_DIR } = await import('../../lib/paths.mjs');
          const dumpPath = pathMod.join(BASE_DIR, 'logs', `stt-last-${audioName.replace(/[^\w.-]/g, '_')}`);
          fs.mkdirSync(pathMod.dirname(dumpPath), { recursive: true });
          fs.writeFileSync(dumpPath, audioBuf, { mode: 0o600 });
          console.log(`[stt] dump: ${audioBuf.length} bytes (${audioMime}) → ${dumpPath}`);
        } catch (e) { console.warn('[stt] dump failed:', e.message); }
      }

      // Provider call shared with the streaming-STT WS path — see lib/stt.mjs.
      const { transcribeAudio } = await import('../../lib/stt.mjs');
      const { transcript, raw: sttRaw } = await transcribeAudio(audioBuf, {
        mime: audioMime, name: audioName, lang,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transcript, raw: sttRaw }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  return false;

}
