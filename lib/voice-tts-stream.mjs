/**
 * Server-side voice TTS streaming for voice devices.
 *
 * Replaces the fragile device-side path (firmware accumulates tokens into
 * sentences, pulls /api/tts per sentence, and races on end-of-reply). Here the
 * SERVER owns the whole pipeline:
 *
 *   LLM tokens → segment into sentences (server) → synthesize each (Pocket TTS)
 *   → 16 kHz mono PCM → push to the device over the WS in paced frames →
 *   send `tts_audio_end` when the reply is fully sent.
 *
 * The device becomes a dumb player: it writes incoming PCM straight to its I²S
 * ring and only idles on `tts_audio_end` + drained buffer. No on-device
 * segmentation, no per-sentence HTTP, no drain race — and Pocket synthesizing
 * faster than playback is fine because the server paces delivery.
 *
 * WS protocol (server → device):
 *   { type:'tts_audio_begin', sr:16000 }
 *   { type:'tts_audio', seq:<n>, pcm_b64:<base64 s16le mono 16k> }   (repeated)
 *   { type:'tts_audio_end' }
 * Device → server: existing `stop` (barge-in / mute) halts the stream.
 *
 * Gated per-device on firmware capability — old firmware still gets the legacy
 * `token` path (see ws-handler).
 */
import { spawn } from 'child_process';

const SAMPLE_RATE = 16000;                 // device TTS source rate (audio_io upsamples to bus)
const CHANNELS = 2;                         // device audio_io_write_pcm expects STEREO interleaved
const BYTES_PER_SAMPLE = 2;                 // s16le
const FRAME_BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE; // 64000
// 50 ms/frame → 3200 stereo bytes. MUST stay under the firmware's decode buffer
// (s_pcm_frame[4096] in main.c); a larger frame fails base64 decode → silence.
const FRAME_MS = 50;
const FRAME_BYTES = (FRAME_BYTES_PER_SEC * FRAME_MS) / 1000; // 3200 (≤ 4096 device buffer)
const LEAD_MS = 1500;                       // keep up to this much audio ahead of realtime
// Bundle short fragments with the next sentence (done safely server-side now —
// this is the "short sentence sounds clipped" fix, with no firmware race).
const MIN_SENTENCE_CHARS = 16;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Synthesize one sentence to 16 kHz mono s16le PCM via the local Pocket TTS
 * service + ffmpeg. Returns a Buffer of raw PCM (no WAV header).
 */
async function synthToPcm(text, { pocketUrl, refPath, voice }) {
  const body = { text };
  if (refPath) body.ref_path = refPath;
  else if (voice) body.voice = voice;
  const res = await fetch(pocketUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Pocket TTS ${res.status}`);
  const wav = Buffer.from(await res.arrayBuffer());
  // wav → raw s16le mono 16k
  // Stereo (-ac 2): the device's audio_io_write_pcm expects interleaved L/R.
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0',
    '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1']);
  const out = [];
  ff.stdout.on('data', c => out.push(c));
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
  });
  ff.stdin.on('error', () => {});
  ff.stdin.end(wav);
  await done;
  return Buffer.concat(out);
}

/**
 * Create a per-turn streamer. Feed it token text with pushText(); call finish()
 * when the LLM reply is complete. It segments, synthesizes, and paces PCM frames
 * to the device. Call abort() on barge-in/stop.
 */
export function createVoiceTtsStreamer({ send, isOpen, cfg, refPath, voice, log }) {
  const pocketUrl = cfg.pocketTtsUrl || 'http://127.0.0.1:5155/';
  log?.info?.('voice-tts', 'streamer created', { pocketUrl, cloned: !!refPath, voice: voice || null });
  let textBuf = '';
  const sentences = [];
  let finished = false, aborted = false, pumping = false, beganAudio = false, seq = 0;

  function drainSentences(flushAll) {
    // Emit complete sentences (boundary . ! ? followed by space/newline). Hold a
    // trailing fragment shorter than MIN_SENTENCE_CHARS to bundle with the next.
    const re = /[\s\S]*?[.!?]+(?=\s|$)/g;
    let m, lastEnd = 0;
    let pending = '';
    while ((m = re.exec(textBuf)) !== null) {
      const candidate = (pending + textBuf.slice(lastEnd, m.index) + m[0]).trim();
      lastEnd = re.lastIndex;
      if (candidate.length >= MIN_SENTENCE_CHARS) { sentences.push(candidate); pending = ''; }
      else pending = candidate + ' ';
    }
    textBuf = pending + textBuf.slice(lastEnd);
    if (flushAll && textBuf.trim()) { sentences.push(textBuf.trim()); textBuf = ''; }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      let playedMs = 0;
      const startedAt = Date.now();
      while (!aborted && (sentences.length || (finished && textBuf))) {
        if (!sentences.length) break;
        const sentence = sentences.shift();
        let pcm;
        const t0 = Date.now();
        try { pcm = await synthToPcm(sentence, { pocketUrl, refPath, voice }); }
        catch (e) { log?.warn?.('voice-tts', 'synth failed', { error: e.message, sentence: sentence.slice(0, 60) }); continue; }
        if (aborted || !isOpen()) break;
        const durMs = Math.round((pcm.length / FRAME_BYTES_PER_SEC) * 1000);
        const nFrames = Math.ceil(pcm.length / FRAME_BYTES);
        log?.info?.('voice-tts', 'sentence synthesized', {
          chars: sentence.length, pcmBytes: pcm.length, durMs, frames: nFrames, synthMs: Date.now() - t0,
        });
        if (!beganAudio) { send({ type: 'tts_audio_begin', sr: SAMPLE_RATE }); beganAudio = true; log?.info?.('voice-tts', 'tts_audio_begin sent'); }
        for (let off = 0; off < pcm.length && !aborted && isOpen(); off += FRAME_BYTES) {
          const frame = pcm.subarray(off, off + FRAME_BYTES);
          send({ type: 'tts_audio', seq: seq++, pcm_b64: frame.toString('base64') });
          playedMs += (frame.length / FRAME_BYTES_PER_SEC) * 1000;
          // Pace: keep at most LEAD_MS of audio ahead of realtime so the device
          // ring never overruns. (Pocket synthesizes faster than playback.)
          const ahead = playedMs - (Date.now() - startedAt);
          if (ahead > LEAD_MS) await sleep(ahead - LEAD_MS);
        }
      }
      if (!aborted && finished && isOpen()) {
        if (beganAudio) { send({ type: 'tts_audio_end' }); log?.info?.('voice-tts', 'tts_audio_end sent', { totalFrames: seq }); }
        else log?.info?.('voice-tts', 'finished with no audio (empty reply?)');
      }
    } finally {
      pumping = false;
      if (!aborted && (sentences.length)) pump();
    }
  }

  return {
    pushText(text) { if (aborted) return; textBuf += text; drainSentences(false); pump(); },
    finish() { if (aborted) return; finished = true; drainSentences(true); pump(); },
    abort() { aborted = true; },
    get beganAudio() { return beganAudio; },
  };
}
