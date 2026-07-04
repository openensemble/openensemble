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
// Keep up to this much audio ahead of realtime. MUST stay under the
// firmware's playback ring capacity: PLAYBACK_RB_BYTES 256 KB ≈ 1.36 s at
// the 48 kHz stereo bus rate (audio_io.c). A ring-full write_pcm blocks the
// device's websocket_task — delaying pong replies and stop/barge-in
// handling — so leave headroom for playback-start latency on top of the
// nominal capacity. 1500 ms overran the ring; 1100 ms leaves ~250 ms slack.
const LEAD_MS = 1100;
// Bundle short fragments with the next sentence (done safely server-side now —
// this is the "short sentence sounds clipped" fix, with no firmware race).
const MIN_SENTENCE_CHARS = 16;
// Don't let list-style / punctuation-light replies become one huge Pocket TTS
// request. A ~100 char first chunk usually starts speaking in 1-2 seconds;
// 250+ char chunks can take 10+ seconds on cloned voices.
const SOFT_SEGMENT_CHARS = 90;
const MAX_SEGMENT_CHARS = 120;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeSegmentText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)[-*•]\s+/g, '$1')
    .replace(/[ \t]*\n+[ \t]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldEmitSegment(s) {
  if (!s || s.length < MIN_SENTENCE_CHARS) return false;
  // Avoid speaking headings like "Springfield, IL 62704:" by themselves when a
  // bullet/list item is about to follow.
  if (s.length < 50 && /:\s*$/.test(s)) return false;
  return true;
}

function consumeWhitespaceAfter(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function boundaryCandidates(text) {
  const out = [];
  const sentenceRe = /[.!?]+(?=\s|$)/g;
  let m;
  while ((m = sentenceRe.exec(text)) !== null) {
    const splitEnd = m.index + m[0].length;
    out.push({ splitEnd, consumeEnd: consumeWhitespaceAfter(text, splitEnd), kind: 'sentence' });
  }

  const newlineRe = /\n+/g;
  while ((m = newlineRe.exec(text)) !== null) {
    out.push({ splitEnd: m.index, consumeEnd: consumeWhitespaceAfter(text, m.index + m[0].length), kind: 'newline' });
  }

  // Markdown bullets often arrive as either "\n- item" or inline " - item"
  // after UI/log rendering. Treat a marker as the start of the NEXT segment.
  const bulletRe = /(^|\s)[-*•]\s+/g;
  while ((m = bulletRe.exec(text)) !== null) {
    const splitEnd = m[1] ? m.index : 0;
    if (splitEnd > 0) out.push({ splitEnd, consumeEnd: splitEnd, kind: 'bullet' });
  }
  return out.sort((a, b) => a.splitEnd - b.splitEnd);
}

function findHardBoundary(text) {
  for (const b of boundaryCandidates(text)) {
    const segment = normalizeSegmentText(text.slice(0, b.splitEnd));
    if (shouldEmitSegment(segment)) return b;
  }
  return null;
}

function findSoftBoundary(text) {
  if (text.length < MAX_SEGMENT_CHARS) return null;
  const limit = Math.min(MAX_SEGMENT_CHARS, text.length);
  for (let i = Math.min(limit, text.length - 1); i >= SOFT_SEGMENT_CHARS; --i) {
    const ch = text[i - 1];
    const next = text[i] || '';
    if ((ch === ',' || ch === ';' || ch === ':') && /\s/.test(next)) return { splitEnd: i, consumeEnd: consumeWhitespaceAfter(text, i), kind: 'soft-punct' };
  }
  for (let i = limit; i >= SOFT_SEGMENT_CHARS; --i) {
    if (/\s/.test(text[i - 1])) return { splitEnd: i, consumeEnd: consumeWhitespaceAfter(text, i), kind: 'soft-length' };
  }
  for (let i = limit; i >= MIN_SENTENCE_CHARS; --i) {
    if (/\s/.test(text[i - 1])) return { splitEnd: i, consumeEnd: consumeWhitespaceAfter(text, i), kind: 'soft-length' };
  }
  return { splitEnd: limit, consumeEnd: limit, kind: 'soft-length' };
}

export function splitVoiceTtsSegments(text, { flushAll = false } = {}) {
  let rest = String(text || '').replace(/^\s+/, '');
  const segments = [];

  while (rest) {
    const boundary = findHardBoundary(rest) || findSoftBoundary(rest);
    if (!boundary) break;
    const segment = normalizeSegmentText(rest.slice(0, boundary.splitEnd));
    if (!shouldEmitSegment(segment)) break;
    segments.push(segment);
    rest = rest.slice(boundary.consumeEnd).replace(/^\s+/, '');
  }

  if (flushAll) {
    while (rest.length >= MAX_SEGMENT_CHARS) {
      const boundary = findSoftBoundary(rest);
      if (!boundary) break;
      const segment = normalizeSegmentText(rest.slice(0, boundary.splitEnd));
      if (segment) segments.push(segment);
      rest = rest.slice(boundary.consumeEnd).replace(/^\s+/, '');
    }
    const tail = normalizeSegmentText(rest);
    if (tail) segments.push(tail);
    rest = '';
  }

  return { segments, rest };
}

function makeTimeoutSignal(parentSignal, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), ms);
  const onAbort = () => ac.abort(parentSignal?.reason ?? new Error('aborted'));
  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ac.signal,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Synthesize one sentence to 16 kHz mono s16le PCM via the local Pocket TTS
 * service + ffmpeg. Returns a Buffer of raw PCM (no WAV header).
 */
async function synthToPcm(text, { pocketUrl, refPath, voice, signal }) {
  const body = { text };
  if (refPath) body.ref_path = refPath;
  else if (voice) body.voice = voice;
  const sig = makeTimeoutSignal(signal, 60000);
  let res;
  let wav;
  try {
    res = await fetch(pocketUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: sig.signal,
    });
    if (!res.ok) throw new Error(`Pocket TTS ${res.status}`);
    wav = Buffer.from(await res.arrayBuffer());
  } finally {
    sig.cleanup();
  }
  // wav → raw s16le mono 16k
  // Stereo (-ac 2): the device's audio_io_write_pcm expects interleaved L/R.
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0',
    '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1']);
  const out = [];
  ff.stdout.on('data', c => out.push(c));
  const done = new Promise((resolve, reject) => {
    const onAbort = () => {
      try { ff.kill('SIGKILL'); } catch {}
      reject(new Error('aborted'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    ff.on('error', reject);
    ff.on('close', code => {
      signal?.removeEventListener?.('abort', onAbort);
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`));
    });
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
export function createVoiceTtsStreamer({ send, isOpen, cfg, refPath, voice, log, bufferedAmount, turnId = null }) {
  const pocketUrl = cfg.pocketTtsUrl || 'http://127.0.0.1:5155/';
  log?.info?.('voice-tts', 'streamer created', { pocketUrl, cloned: !!refPath, voice: voice || null, turnId });
  // Echoed on every frame so fw ≥ 0.2.65 can drop stale-turn audio. ~15 bytes
  // per 3200-byte frame; omitted entirely for legacy turns (turnId null).
  const turnTag = turnId ? { turn_id: turnId } : {};
  let textBuf = '';
  const sentences = [];
  let finished = false, aborted = false, failed = false, pumping = false, beganAudio = false, closed = false, seq = 0;
  let activeSynth = null;
  // Device-driven flow control (speech barge-in verify): while paused, the
  // pacer emits nothing and the pacing clock is later shifted by the paused
  // duration so resume doesn't burst-flood the device ring. A pause with no
  // resume auto-aborts after PAUSE_ABORT_MS — the device has its own local
  // deadlines, so a stall this long means the resume frame was lost.
  const PAUSE_ABORT_MS = 20_000;
  let paused = false, pausedAt = 0, pauseAbortTimer = null;
  // Pacing clock — hoisted from pump() so resume() can adjust it.
  let paceStartedAt = 0;
  // onClosed(clean) observers — registered by armFollowupAfterDrain so a
  // follow-up window opens when the device actually stops speaking, not when
  // the LLM stops streaming. clean=false on abort/synth-failure: an
  // interrupted or half-delivered reply must not arm a listen window.
  const closedCbs = [];
  let closedResult = null; // set once, {clean} — late registrants fire immediately
  function notifyClosed(clean) {
    if (closedResult) return;
    closedResult = { clean };
    for (const cb of closedCbs.splice(0)) { try { cb(clean); } catch {} }
  }
  // Don't let a slow/lossy device link turn the pacer into unbounded kernel
  // send-buffer growth: past this backlog we stall (abort-aware) instead of
  // stacking frames the socket can't drain. Also protects the device's pong
  // path — a device drowning in frames misses server heartbeats.
  const BUFFERED_MAX = 256 * 1024;

  function drainSentences(flushAll) {
    const split = splitVoiceTtsSegments(textBuf, { flushAll });
    for (const segment of split.segments) sentences.push(segment);
    textBuf = split.rest;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      let playedMs = 0;
      // Pacer clock (paceStartedAt) starts at the FIRST FRAME, not at pump
      // entry — otherwise first-sentence synth latency counts as "already
      // played" and up to synthMs+LEAD_MS of audio ships in one burst,
      // overrunning the device ring (blocking its websocket_task) before
      // pacing kicks in. Hoisted to streamer scope so resume() can shift it.
      paceStartedAt = 0;
      // 1-deep synth prefetch: sentence n+1 synthesizes (Pocket + its ffmpeg
      // resample) WHILE sentence n paces out to the device. The old serial
      // synth→pace→synth→pace loop left an audible mid-reply gap whenever a
      // sentence's synth latency exceeded the pacing slack. One-ahead is
      // enough to hide synth latency, and peak Pocket/ffmpeg concurrency
      // stays at 1 since the pacer is the bottleneck by design. Errors are
      // captured into the result (never thrown) so an in-flight prefetch
      // discarded on abort can't become an unhandled rejection.
      const synthNext = () => {
        if (aborted || failed || !sentences.length) return null;
        const sentence = sentences.shift();
        const t0 = Date.now();
        const ac = new AbortController();
        activeSynth = ac;
        return synthToPcm(sentence, { pocketUrl, refPath, voice, signal: ac.signal })
          .then(pcm => ({ pcm, sentence, synthMs: Date.now() - t0 }),
                err => ({ err, sentence, synthMs: Date.now() - t0 }))
          .finally(() => { if (activeSynth === ac) activeSynth = null; });
      };
      let inFlight = synthNext();
      while (!aborted && inFlight) {
        const r = await inFlight;
        inFlight = synthNext(); // start the next synth before pacing this one
        if (r.err) {
          // A malformed sentence failing is worth skipping; a dead/unreachable
          // Pocket service is not — every remaining sentence would burn up to
          // the 60 s fetch timeout while the device sits in THINKING. Treat
          // network-shaped errors as fatal: drop the rest of the reply and let
          // the close-out below unblock the device. (The already-in-flight
          // prefetch is simply discarded — its error is captured, not thrown.)
          const fatal = /timed? ?out|timeout|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i
            .test(String(r.err?.message ?? r.err));
          log?.warn?.('voice-tts', 'synth failed', { error: r.err.message, fatal, sentence: r.sentence.slice(0, 60) });
          if (fatal) { failed = true; sentences.length = 0; textBuf = ''; break; }
          continue;
        }
        if (aborted || !isOpen()) break;
        const pcm = r.pcm;
        const durMs = Math.round((pcm.length / FRAME_BYTES_PER_SEC) * 1000);
        const nFrames = Math.ceil(pcm.length / FRAME_BYTES);
        log?.info?.('voice-tts', 'sentence synthesized', {
          chars: r.sentence.length, pcmBytes: pcm.length, durMs, frames: nFrames, synthMs: r.synthMs,
        });
        if (!beganAudio) { send({ type: 'tts_audio_begin', sr: SAMPLE_RATE, ...turnTag }); beganAudio = true; log?.info?.('voice-tts', 'tts_audio_begin sent'); }
        for (let off = 0; off < pcm.length && !aborted && isOpen(); off += FRAME_BYTES) {
          // Device-requested pause (barge-in verify): emit nothing until
          // resume()/abort(). resume() shifts paceStartedAt by the paused
          // duration so pacing picks up where it left off, burst-free.
          while (paused && !aborted && isOpen()) await sleep(50);
          // Backpressure: stall while the socket's send backlog is deep. The
          // wall-clock pacer alone kept queueing frames into the kernel buffer
          // when the link couldn't drain at realtime.
          while (!paused && !aborted && isOpen() && bufferedAmount && bufferedAmount() > BUFFERED_MAX) {
            await sleep(50);
          }
          if (paused) { off -= FRAME_BYTES; continue; }  // re-check pause gate
          if (aborted || !isOpen()) break;
          if (!paceStartedAt) paceStartedAt = Date.now();
          const frame = pcm.subarray(off, off + FRAME_BYTES);
          send({ type: 'tts_audio', seq: seq++, pcm_b64: frame.toString('base64'), ...turnTag });
          playedMs += (frame.length / FRAME_BYTES_PER_SEC) * 1000;
          // Pace: keep at most LEAD_MS of audio ahead of realtime so the device
          // ring never overruns. (Pocket synthesizes faster than playback.)
          const ahead = playedMs - (Date.now() - paceStartedAt);
          if (ahead > LEAD_MS) await sleep(ahead - LEAD_MS);
        }
        // Tokens may have segmented into new sentences while this one paced.
        if (!inFlight) inFlight = synthNext();
      }
      if (!aborted && (finished || failed) && isOpen() && !closed) {
        closed = true;
        if (beganAudio) { send({ type: 'tts_audio_end', ...turnTag }); log?.info?.('voice-tts', 'tts_audio_end sent', { totalFrames: seq, failed }); }
        else {
          // Nothing was synthesized (empty reply, or synth failed before any
          // audio). On the streaming path the device never sees token/done, so
          // without a frame here it sits in THINKING until its 90 s
          // awaiting-reply watchdog. A bare `done` drops it straight back to
          // IDLE — firmware handles `done` in streaming mode (main.c
          // CHAT_DONE with an empty sentence queue).
          send({ type: 'done', agent: 'system', ...turnTag });
          log?.info?.('voice-tts', 'finished with no audio — sent done fallback', { failed });
        }
        notifyClosed(!failed);
      }
    } finally {
      pumping = false;
      if (!aborted && !failed && (sentences.length)) pump();
    }
  }

  const api = {
    pushText(text) {
      // finished guard: a stray token after finish() must not restart synth
      // and emit frames after the terminal event already went out.
      if (aborted || failed || finished) return;
      textBuf += text; drainSentences(false); pump();
    },
    finish() { if (aborted) return; finished = true; if (failed) return; drainSentences(true); pump(); },
    // Device barge-in verify flow control. pause() stalls the pacer (frames
    // stop); a pause never followed by resume() self-aborts after
    // PAUSE_ABORT_MS so a lost resume frame can't wedge the pump forever.
    pause() {
      if (paused || aborted || closed) return;
      paused = true;
      pausedAt = Date.now();
      log?.info?.('voice-tts', 'paused (barge verify)', { turnId });
      pauseAbortTimer = setTimeout(() => {
        if (!paused || aborted || closed) return;
        log?.warn?.('voice-tts', 'pause never resumed — aborting stream', { turnId });
        try { api.abort({ close: true }); } catch {}
      }, PAUSE_ABORT_MS);
      pauseAbortTimer.unref?.();
    },
    resume() {
      if (!paused) return;
      paused = false;
      if (pauseAbortTimer) { clearTimeout(pauseAbortTimer); pauseAbortTimer = null; }
      // Exclude the paused span from the pacing clock, else the pacer sees
      // itself "behind" and burst-floods the device ring on resume.
      if (paceStartedAt && pausedAt) paceStartedAt += Date.now() - pausedAt;
      pausedAt = 0;
      log?.info?.('voice-tts', 'resumed', { turnId });
    },
    abort({ close = false, sendDone = false } = {}) {
      aborted = true;
      paused = false;
      if (pauseAbortTimer) { clearTimeout(pauseAbortTimer); pauseAbortTimer = null; }
      try { activeSynth?.abort(new Error('aborted')); } catch {}
      if (close && isOpen() && !closed) {
        closed = true;
        if (beganAudio) {
          send({ type: 'tts_audio_end', ...turnTag });
          log?.info?.('voice-tts', 'tts_audio_end sent on abort', { totalFrames: seq });
        } else if (sendDone) {
          send({ type: 'done', agent: 'system', ...turnTag });
          log?.info?.('voice-tts', 'done sent on abort before audio');
        }
      }
      notifyClosed(false);
    },
    // Register cb(clean). clean=true only when the reply fully delivered
    // (tts_audio_end after all frames, or the no-audio done fallback with no
    // synth failure). Fires immediately if the streamer already closed.
    onClosed(cb) {
      if (typeof cb !== 'function') return;
      if (closedResult) { try { cb(closedResult.clean); } catch {} return; }
      closedCbs.push(cb);
    },
    get beganAudio() { return beganAudio; },
    get finished() { return finished; },
    get aborted() { return aborted; },
    get closed() { return closed; },
  };
  return api;
}
