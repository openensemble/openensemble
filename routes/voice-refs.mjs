/**
 * Voice reference library API for Pocket TTS zero-shot cloning.
 *
 *   GET    /api/voice-refs          — list this user's references
 *   POST   /api/voice-refs          — upload a WAV + label (transcript optional)
 *   DELETE /api/voice-refs/:id      — remove an entry
 *
 * Upload uses JSON+base64 (matches /api/wakewords for consistency).
 * Transcript is optional: Pocket TTS is fully zero-shot (legacy callers may
 * still pass one; it's just stored).
 */

import { spawn } from 'child_process';
import { requireAuth, readBody, isChildRequest } from './_helpers.mjs';
import {
  validateUpload, addVoiceRef, listVoiceRefs, deleteVoiceRef, getVoiceRef,
} from '../lib/voice-refs.mjs';

// Best-effort: ask the local Pocket TTS service to pre-compute + persist the
// speaker state (<ref>.safetensors) right after upload, so the first real
// reply for a new voice isn't slow. No-op if the service isn't running.
function warmPocketVoice(wavPath) {
  fetch('http://127.0.0.1:5155/warm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref_path: wavPath }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => {});
}

// Transcode an arbitrary audio buffer (mp3, m4a, ogg, …) to mono 24 kHz
// 16-bit PCM WAV via ffmpeg, so non-WAV uploads work with the WAV-based
// voice-refs store + Pocket TTS reference loader. Resolves to a WAV Buffer
// (or rejects on ffmpeg error). ffmpeg is a hard dependency of the TTS path.
function transcodeToWav(inputBuf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error', '-i', 'pipe:0',
      '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
    ]);
    const out = [];
    let errBuf = '';
    ff.stdout.on('data', c => out.push(c));
    // Drain stderr — an undrained pipe fills its buffer and deadlocks ffmpeg;
    // keep the tail for the error message.
    ff.stderr.on('data', c => { if (errBuf.length < 8192) errBuf += c; });
    // A wedged ffmpeg (malformed container that stalls the demuxer) used to
    // hang the upload request forever.
    const killer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } }, 30_000);
    ff.on('error', (e) => { clearTimeout(killer); reject(e); });
    ff.on('close', code => {
      clearTimeout(killer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}${errBuf ? `: ${errBuf.trim().slice(0, 300)}` : ''}`));
    });
    ff.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg bails early
    ff.stdin.end(inputBuf);
  });
}

export async function handle(req, res) {
  // Child accounts cannot change voice references — an admin manages voice devices.
  if (/^(POST|PUT|DELETE|PATCH)$/.test(req.method)
      && req.url.startsWith('/api/voice-refs') && isChildRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Voice devices are managed by an admin for this account.' }));
    return true;
  }
  if (req.url === '/api/voice-refs' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ refs: listVoiceRefs(userId) }));
    return true;
  }

  if (req.url === '/api/voice-refs' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (typeof body?.wav_b64 !== 'string' || !body.label) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'wav_b64 + label required' }));
      return true;
    }
    let wavBuffer;
    try { wavBuffer = Buffer.from(body.wav_b64, 'base64'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'wav_b64 is not valid base64' }));
      return true;
    }
    // Accept non-WAV uploads (mp3, m4a, ogg, …) by transcoding to WAV first —
    // both the voice-refs store and the Pocket TTS reference loader expect WAV.
    const isWav = wavBuffer.length >= 12
      && wavBuffer.slice(0, 4).toString('ascii') === 'RIFF'
      && wavBuffer.slice(8, 12).toString('ascii') === 'WAVE';
    if (!isWav) {
      try { wavBuffer = await transcodeToWav(wavBuffer); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `could not decode that audio file (use WAV or MP3): ${e.message}` }));
        return true;
      }
    }
    // transcript is optional (Pocket TTS is zero-shot); default to '' so the
    // validator's type check passes and legacy F5 callers still work.
    const err = validateUpload(wavBuffer, body.label, body.transcript || '');
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err }));
      return true;
    }
    try {
      const id = addVoiceRef(userId, {
        wavBuffer,
        label: body.label,
        transcript: body.transcript || '',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      // Fire-and-forget pre-warm so <ref>.safetensors exists before first use.
      try { const ref = getVoiceRef(userId, id); if (ref?.wavPath) warmPocketVoice(ref.wavPath); } catch {}
    } catch (e) {
      const status = e.code === 'LIBRARY_FULL' ? 409 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  const idMatch = req.url.match(/^\/api\/voice-refs\/([\w-]+)$/);
  if (idMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const ok = deleteVoiceRef(userId, idMatch[1]);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { removed: true } : { error: 'not found' }));
    return true;
  }

  return false;
}
