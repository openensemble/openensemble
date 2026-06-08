/**
 * Voice-stack availability probes.
 *
 * Cheap detection for runtime deps that the voice-device TTS pipeline
 * relies on but the OE installer treats as optional. Used by
 * /api/tts/info, /api/provider-config, and the /api/tts pre-flight so
 * the UI can hide/disable options and the device gets a structured 503
 * instead of a generic crash when something isn't installed.
 *
 * Results are cached for CACHE_MS so the probe doesn't fire on every
 * request — ffmpeg detection via spawn is ~10 ms, Piper HTTP probe is
 * up to 500 ms; both add up over the drawer's parallel fetches.
 */
import { spawn } from 'child_process';

const CACHE_MS = 60_000;

let _ffmpegCache    = { val: null, ts: 0 };
let _piperCache     = { url: null, val: null, ts: 0 };
let _kittenttsCache = { url: null, val: null, ts: 0 };
let _pocketTtsCache = { url: null, val: null, ts: 0 };
let _fasterWhisperCache = { url: null, val: null, ts: 0 };

/**
 * Returns true if `ffmpeg` is on PATH and runnable. Spawns
 * `ffmpeg -version` (cheap; exits immediately) rather than shelling out
 * to `which` so we don't depend on coreutils layout. Result cached for
 * 60 s — uninstalling/installing ffmpeg mid-server-run is rare enough
 * that we'd rather not pay the spawn on every TTS call.
 */
export async function probeFfmpegAvailable() {
  const now = Date.now();
  if (_ffmpegCache.val !== null && now - _ffmpegCache.ts < CACHE_MS) {
    return _ffmpegCache.val;
  }
  const ok = await new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    try {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.once('error', () => done(false));      // ENOENT → not on PATH
      p.once('exit',  code => done(code === 0));
      setTimeout(() => { try { p.kill(); } catch {} done(false); }, 1500);
    } catch { done(false); }
  });
  _ffmpegCache = { val: ok, ts: now };
  return ok;
}

/**
 * Quick liveness probe for the local Piper TTS service. Caches per
 * (url, 60 s) — flipping the configured `piperUrl` invalidates. Piper's
 * http_server returns 405 on GET / and 2xx on /v1/info; anything in
 * 200-599 means *something* is listening. Connection-refused throws and
 * resolves to false.
 */
export async function probePiperAvailable(cfg) {
  const url = cfg.piperUrl || 'http://127.0.0.1:5151/';
  const now = Date.now();
  if (_piperCache.url === url && _piperCache.val !== null && now - _piperCache.ts < CACHE_MS) {
    return _piperCache.val;
  }
  let ok = false;
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(500) });
    ok = r.status >= 200 && r.status < 600;
  } catch { ok = false; }
  _piperCache = { url, val: ok, ts: now };
  return ok;
}

/**
 * Quick liveness probe for the local KittenTTS service. Same shape as the
 * Piper probe — KittenTTS server exposes GET / returning "kittentts" on
 * the configured port (default 5153).
 */
export async function probeKittenttsAvailable(cfg) {
  const url = cfg.kittenttsUrl || 'http://127.0.0.1:5153/';
  const now = Date.now();
  if (_kittenttsCache.url === url && _kittenttsCache.val !== null && now - _kittenttsCache.ts < CACHE_MS) {
    return _kittenttsCache.val;
  }
  let ok = false;
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(500) });
    ok = r.status >= 200 && r.status < 600;
  } catch { ok = false; }
  _kittenttsCache = { url, val: ok, ts: now };
  return ok;
}

/**
 * Quick liveness probe for the local Pocket TTS service. Same shape as the
 * KittenTTS probe — the pocket-tts server exposes GET / returning "pocket-tts"
 * on the configured port (default 5155).
 */
export async function probePocketTtsAvailable(cfg) {
  const url = cfg.pocketTtsUrl || 'http://127.0.0.1:5155/';
  const now = Date.now();
  if (_pocketTtsCache.url === url && _pocketTtsCache.val !== null && now - _pocketTtsCache.ts < CACHE_MS) {
    return _pocketTtsCache.val;
  }
  let ok = false;
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(500) });
    ok = r.status >= 200 && r.status < 600;
  } catch { ok = false; }
  _pocketTtsCache = { url, val: ok, ts: now };
  return ok;
}

/**
 * Quick liveness probe for the local Faster-Whisper STT service. Returns
 * true if 127.0.0.1:5154 responds within 500 ms — model load on cold start
 * is up to 15 s but that happens once at service boot, not per request.
 * Configurable via cfg.fasterWhisperUrl if the user runs it on a different
 * host/port (e.g. on a separate GPU box).
 */
export async function probeFasterWhisperAvailable(cfg) {
  const url = cfg.fasterWhisperUrl || 'http://127.0.0.1:5154/';
  const now = Date.now();
  if (_fasterWhisperCache.url === url && _fasterWhisperCache.val !== null && now - _fasterWhisperCache.ts < CACHE_MS) {
    return _fasterWhisperCache.val;
  }
  let ok = false;
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(500) });
    ok = r.status >= 200 && r.status < 600;
  } catch { ok = false; }
  _fasterWhisperCache = { url, val: ok, ts: now };
  return ok;
}

/**
 * Aggregated availability snapshot for the TTS pipeline. Each provider
 * branch needs ffmpeg (for resampling to 16 kHz / encoding to MP3), so a
 * provider is only `available` if BOTH its credentials/service AND
 * ffmpeg are present. Used by /api/tts/info + the Settings → Providers
 * dropdown to disable unusable options.
 *
 * Note: openai-compat needs both URL and key; elevenlabs needs only a
 * key (URL is fixed); piper and kittentts need the local service running.
 */
export async function getTtsAvailability(cfg) {
  const [ffmpeg, piper, kittentts, pocketTts] = await Promise.all([
    probeFfmpegAvailable(),
    probePiperAvailable(cfg),
    probeKittenttsAvailable(cfg),
    probePocketTtsAvailable(cfg),
  ]);
  return {
    ffmpeg,
    piper:      ffmpeg && piper,
    kittentts:  ffmpeg && kittentts,
    'pocket-tts': ffmpeg && pocketTts,
    openai:     ffmpeg && !!cfg.ttsApiKey && !!cfg.ttsApiUrl,
    elevenlabs: ffmpeg && !!cfg.elevenlabsApiKey,
  };
}

/** Force the next probe to re-run. Useful after install-piper / install-kittentts /
 *  install-faster-whisper SSE. */
export function invalidateVoiceDepsCache() {
  _ffmpegCache        = { val: null, ts: 0 };
  _piperCache         = { url: null, val: null, ts: 0 };
  _kittenttsCache     = { url: null, val: null, ts: 0 };
  _fasterWhisperCache = { url: null, val: null, ts: 0 };
}
