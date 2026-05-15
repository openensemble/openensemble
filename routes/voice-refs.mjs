/**
 * Voice reference library API for F5-TTS zero-shot cloning.
 *
 *   GET    /api/voice-refs          — list this user's references
 *   POST   /api/voice-refs          — upload a WAV + label + transcript
 *   DELETE /api/voice-refs/:id      — remove an entry
 *
 * Upload uses JSON+base64 (matches /api/wakewords for consistency). The
 * accompanying transcript is required — F5-TTS clones much better when
 * told what the reference clip is saying.
 */

import { requireAuth, readBody } from './_helpers.mjs';
import {
  validateUpload, addVoiceRef, listVoiceRefs, deleteVoiceRef,
} from '../lib/voice-refs.mjs';

export async function handle(req, res) {
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
    if (typeof body?.wav_b64 !== 'string' || !body.label || !body.transcript) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'wav_b64 + label + transcript required' }));
      return true;
    }
    let wavBuffer;
    try { wavBuffer = Buffer.from(body.wav_b64, 'base64'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'wav_b64 is not valid base64' }));
      return true;
    }
    const err = validateUpload(wavBuffer, body.label, body.transcript);
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err }));
      return true;
    }
    try {
      const id = addVoiceRef(userId, {
        wavBuffer,
        label: body.label,
        transcript: body.transcript,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
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
