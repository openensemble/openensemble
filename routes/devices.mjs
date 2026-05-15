/**
 * Route handler for voice devices (XVF3800 + ESP32-S3 family).
 *
 * Voice-device tokens authenticate on the main /ws like browser tabs do, so
 * this module only owns metadata: pairing codes (forwarded to
 * routes/devices/pairing.mjs), per-device prefs (name, default agent, TTS
 * voice, wake-word slot, speak-replies), and revocation.
 */

import { requireAuth, readBody, revokeSessionByPrefix, clearUserVoiceDeviceSessions } from './_helpers.mjs';
import { listDevices, getDevice, updateDevice, removeDevice, findIncomingSlots, clearSlotAssignment } from '../lib/voice-devices.mjs';
import { handlePairingRoutes } from './devices/pairing.mjs';
import { sendToDevice, isDeviceOnline } from '../ws-handler.mjs';
import { randomBytes } from 'crypto';

// In-memory cache of one-shot test MP3s keyed by marker token. The /api/tts
// route reads from this when the device echoes the marker in its TTS
// request; the entry is deleted on read so each marker plays exactly once.
// Cached MP3 is the *post-ffmpeg* 16 kHz buffer (already resampled), so the
// TTS handler can return it without another transcode round-trip.
const _testMp3Cache = new Map();
export function takeTestMp3(marker) {
  const buf = _testMp3Cache.get(marker);
  if (buf) _testMp3Cache.delete(marker);
  return buf || null;
}

// Slot wake-word push moved to routes/voice-config.mjs as of 2026-05-13:
// slot routing is now per-user (voice-config), not per-device. The save
// path there pushes wake words to every device paired to the user.

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Pairing endpoints first so /api/devices/pair and /api/devices/redeem
  // don't fall through to the generic /api/devices/:id handlers below.
  if (await handlePairingRoutes(req, res, p)) return true;

  // GET /api/devices — list this user's voice devices
  // `online` is computed live from open WS connections (not persisted), so a
  // device that's been paired for days but offline right now shows online=false.
  if (p === '/api/devices' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const devices = listDevices(userId).map(d => ({ ...d, online: isDeviceOnline(d.id) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ devices }));
    return true;
  }

  // GET /api/devices/incoming-slots — wake-slots on other users' devices
  // that are assigned to the auth user. Used by Settings → Voice devices to
  // show "Shared with you" entries so a non-admin can see (and opt out of)
  // bindings the device-owner set up against their account.
  if (p === '/api/devices/incoming-slots' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ slots: findIncomingSlots(userId) }));
    return true;
  }

  // POST /api/devices/:id/play-mp3 — push an arbitrary MP3 to the device
  // for audio-quality testing. Hijacks the existing TTS playback path: the
  // server caches the MP3 under a one-shot marker, sends a synthetic TTS
  // event to the device's WS, the device calls /api/tts with the marker
  // text, and /api/tts returns the cached MP3 (ffmpeg-resampled to 16 kHz
  // so the playback rate matches the device's expectations). No firmware
  // change required.
  const playMatch = p.match(/^\/api\/devices\/([^/]+)\/play-mp3$/);
  if (playMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const deviceId = decodeURIComponent(playMatch[1]);
    if (!getDevice(userId, deviceId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'device not found' }));
      return true;
    }
    // Raw binary MP3 upload. Inline reader with a 15 MB cap — the shared
    // readBodyBuffer uses the global 512 KB BODY_LIMIT which is way under
    // any reasonable MP3 size. We don't widen the global because it'd
    // weaken every other API endpoint; this route has its own cap matched
    // to the UI's 10 MB file picker.
    const PLAY_MP3_CAP = 15 * 1024 * 1024;
    let mp3In;
    try {
      mp3In = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
          size += chunk.length;
          if (size > PLAY_MP3_CAP) {
            req.destroy();
            reject(new Error(`MP3 too large (>${PLAY_MP3_CAP} bytes)`));
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
    } catch (e) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Request body too large' }));
      return true;
    }
    if (!mp3In || mp3In.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty body' }));
      return true;
    }
    // Transcode to 48 kHz STEREO MP3 — full bus-rate, true L/R preserved
    // end-to-end so the 3.5 mm jack outputs real stereo. The device's
    // libhelix decoder passes interleaved L/R straight through to the
    // I²S bus (no downmix). Internal speaker still hears the XVF's L+R
    // sum since it's a mono driver. Bitrate 160k stereo ≈ 80k/channel,
    // good for music; raise to 192/256 if mid-quality MP3 sources need
    // more headroom.
    const { spawn } = await import('child_process');
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', '2', '-ar', '48000', '-b:a', '160k',
      '-f', 'mp3', 'pipe:1',
    ]);
    const chunks = [];
    ff.stdout.on('data', c => chunks.push(c));
    const ffDone = new Promise((resolve, reject) => {
      ff.on('error', reject);
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    });
    ff.stdin.end(mp3In);
    try { await ffDone; } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `ffmpeg failed: ${e.message}` }));
      return true;
    }
    const mp3Out = Buffer.concat(chunks);
    // Marker text the device will echo back. We use a punctuation-free
    // string so libhelix-bound sentence chunking doesn't split it weirdly.
    const marker = `__test_audio_${randomBytes(4).toString('hex')}__`;
    _testMp3Cache.set(marker, mp3Out);
    // Expire entries after 60s so the cache doesn't grow if a marker
    // is never claimed (e.g. device offline).
    setTimeout(() => _testMp3Cache.delete(marker), 60_000);

    // Push a synthetic TTS event sequence to the device. The firmware
    // accumulates 'token' events into a sentence buffer, flushes on 'done',
    // then calls /api/tts with the accumulated text. By emitting a single
    // token + done, we trigger one TTS playback with our marker as the
    // text. /api/tts will intercept the marker and return our MP3.
    sendToDevice(deviceId, { type: 'token', text: marker, agent: 'system' });
    sendToDevice(deviceId, { type: 'done', agent: 'system' });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, marker, bytes: mp3Out.length }));
    return true;
  }

  // DELETE /api/devices/incoming-slots/:ownerUserId/:deviceId/:slot
  // Opt-out: the auth user clears a slot binding from someone else's device
  // that points at them. Safe to call even on slots that don't actually
  // target the caller — the lookup will just no-op.
  const incomingMatch = p.match(/^\/api\/devices\/incoming-slots\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (incomingMatch && req.method === 'DELETE') {
    const authUserId = requireAuth(req, res);
    if (!authUserId) return true;
    const ownerUserId = decodeURIComponent(incomingMatch[1]);
    const deviceId    = decodeURIComponent(incomingMatch[2]);
    const slot        = Number(incomingMatch[3]);
    // Guard: only let the caller clear assignments that actually point at
    // them. Without this, anyone with a valid session could wipe any slot
    // on any device on the install.
    const incoming = findIncomingSlots(authUserId);
    const match = incoming.find(s => s.ownerUserId === ownerUserId && s.deviceId === deviceId && s.slot === slot);
    if (!match) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not your slot to clear' }));
      return true;
    }
    const cleared = clearSlotAssignment(ownerUserId, deviceId, slot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared }));
    return true;
  }

  // POST /api/devices/revoke-all — revoke every paired voice device + every
  // voice-device session. Mirrors /api/nodes/revoke-all. Idempotent.
  if (p === '/api/devices/revoke-all' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const devices = listDevices(userId);
    for (const d of devices) removeDevice(userId, d.id);
    const sessionsRevoked = clearUserVoiceDeviceSessions(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ removed: devices.length, sessionsRevoked, total: devices.length }));
    return true;
  }

  // PATCH /api/devices/:id — update mutable fields (name, default_agent_id,
  // tts_voice, wake_word_slot, speak_replies).
  const idMatch = p.match(/^\/api\/devices\/([^/]+)$/);
  if (idMatch && req.method === 'PATCH') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = decodeURIComponent(idMatch[1]);
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    const updated = updateDevice(userId, id, body);
    if (!updated) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    // Per-device PATCH no longer mutates slot routing — slot_assignments
    // is per-user (voice-config) since 2026-05-13. push is always empty
    // here; the voice-config PUT handler is where wake-word OTA fires.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ device: updated, push: { pushed: [], offline: [] } }));
    return true;
  }

  // DELETE /api/devices/:id — drop from registry + revoke its session token
  if (idMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = decodeURIComponent(idMatch[1]);
    const existing = getDevice(userId, id);
    if (!existing) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    removeDevice(userId, id);
    // Drop the device's session token so a stolen token can't keep talking
    // after the user clicks Revoke. Token-prefix is the only handle we kept.
    let sessionRevoked = false;
    if (existing.token_prefix) {
      sessionRevoked = revokeSessionByPrefix(userId, existing.token_prefix);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ removed: true, sessionRevoked }));
    return true;
  }

  return false;
}
