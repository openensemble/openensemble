/**
 * Route handler for voice devices (XVF3800 + ESP32-S3 family).
 *
 * Voice-device tokens authenticate on the main /ws like browser tabs do, so
 * this module only owns metadata: pairing codes (forwarded to
 * routes/devices/pairing.mjs), per-device prefs (name, default agent, TTS
 * voice, wake-word slot, speak-replies), and revocation.
 */

import { requireAuth, readBody, revokeSessionByPrefix, clearUserVoiceDeviceSessions, isChildRequest } from './_helpers.mjs';
import { listDevices, getDevice, updateDevice, removeDevice, findIncomingSlots, clearSlotAssignment } from '../lib/voice-devices.mjs';
import { handlePairingRoutes } from './devices/pairing.mjs';
import { sendToDevice, isDeviceOnline } from '../ws-handler.mjs';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import {
  listAmbientFiles, saveAmbientFile, deleteAmbientFile, ambientFilePath,
  probeAmbientDuration,
} from '../lib/routines.mjs';
import { playAmbientOnDevice, stopAmbientOnDevice } from '../lib/ambient-playback.mjs';

// Per-user custom alarm chime: stored as a transcoded MP3 on disk so it
// survives server restart AND so future-paired devices can be pushed the
// chime on first connect (not yet wired — currently only broadcasts to
// devices paired right now). Missing file means the device uses its
// built-in procedural chime.
function userChimePath(userId) {
  return path.join(USERS_DIR, userId, 'alarm-chime.mp3');
}

// In-memory cache of one-shot MP3 buffers keyed by marker token. The /api/tts
// route reads from this when the device echoes the marker in its TTS request;
// the entry is deleted on read so each marker plays exactly once. Cached MP3
// is already in device-ready encoding (ffmpeg-resampled by whoever cached it),
// so the TTS handler can stream it without another transcode round-trip.
// Originally added for /play-mp3 audio-quality testing; also used by the
// reminder voice-channel (chime + TTS) to inject pre-rendered MP3s into the
// device's existing TTS pipeline without firmware changes.
const _oneShotMp3Cache = new Map();
export function takeTestMp3(marker) {
  const buf = _oneShotMp3Cache.get(marker);
  if (buf) _oneShotMp3Cache.delete(marker);
  return buf || null;
}

/**
 * Stash an MP3 under a fresh one-shot marker; returns the marker text the
 * caller pushes to the device as a TTS token. /api/tts intercepts the marker
 * and returns this buffer (then drops it from the cache). Entries expire
 * after 60s if never claimed (offline device, dropped WS frame).
 */
export function cacheOneShotMp3(mp3Buf) {
  const marker = `__test_audio_${randomBytes(4).toString('hex')}__`;
  _oneShotMp3Cache.set(marker, mp3Buf);
  setTimeout(() => _oneShotMp3Cache.delete(marker), 60_000);
  return marker;
}

// Ambient (looped) playback: register a source file + loop flag against a
// fresh marker. The /api/tts handler matches the marker and spawns ffmpeg
// with `-stream_loop -1` so the response is ONE continuous MP3 stream with
// zero silence at seams. Lifecycle is bounded by:
//   - explicit stop_ambient (stopAmbientOnDevice → dropAmbientMp3)
//   - a 4-hour orphan-cleanup TTL for markers that never got picked up
// The TTL is CANCELLED once an HTTP stream is actually attached via
// pinAmbientMp3() — an active stream must keep playing forever, the
// 4h TTL only existed to clean up dead markers registered but never
// streamed. Without the pin we ended actively-streaming sessions at
// the 4h mark and the device's HTTP retry would 500 because the
// marker cache was gone by then.
const _ambientStreamCache = new Map();        // marker → { userId, file, loop }
const _ambientByDevice    = new Map();        // deviceId → marker
const _ambientTimers      = new Map();        // marker → setTimeout handle (cleared when pinned)
const _ambientResponses   = new Map();        // marker → in-flight res (so stop can end it)
const AMBIENT_TTL_MS = 4 * 60 * 60 * 1000;

export function takeAmbientStream(marker) {
  return _ambientStreamCache.get(marker) || null;
}

export function registerAmbientResponse(marker, res, killFn) {
  _ambientResponses.set(marker, { res, killFn });
}

export function unregisterAmbientResponse(marker) {
  _ambientResponses.delete(marker);
}

// Cancel the orphan-cleanup TTL on a marker once an HTTP stream is attached.
// Called by routes/config.mjs as soon as it starts (or warm-reattaches to)
// the ffmpeg pipe. The marker cache survives for the lifetime of the stream;
// dropAmbientMp3 (explicit stop or device-removal) is the only thing that
// can clean it up after pinning.
export function pinAmbientMp3(marker) {
  const t = _ambientTimers.get(marker);
  if (t) { clearTimeout(t); _ambientTimers.delete(marker); }
}

// Re-arm the orphan-cleanup TTL after a pinned stream dies (ffmpeg exit /
// grace expiry → forceKill in routes/config.mjs). Pinning cancels the 4h TTL
// while the stream is live; without re-arming, the marker survived forever —
// getAmbientForDevice() reported phantom ambient (arming the loose-stop
// matcher and disabling the wake avg-prob gate) and the next wake resurrected
// the loop hours later. The short window still lets the device's HTTP retry
// re-attach (the cold-start path re-pins, cancelling this timer again).
export function rearmAmbientTtl(marker, ms = 10 * 60 * 1000) {
  if (!_ambientStreamCache.has(marker)) return;
  const t = _ambientTimers.get(marker);
  if (t) clearTimeout(t);
  _ambientTimers.set(marker, setTimeout(() => dropAmbientMp3(marker), ms));
}

export function cacheAmbientStream(deviceId, meta) {
  // Drop any prior ambient marker for this device so we don't leak entries
  // when the user fires a second routine while the first is still playing.
  const prev = _ambientByDevice.get(deviceId);
  if (prev) dropAmbientMp3(prev);
  const marker = `__ambient_${randomBytes(4).toString('hex')}__`;
  _ambientStreamCache.set(marker, meta);
  _ambientByDevice.set(deviceId, marker);
  _ambientTimers.set(marker, setTimeout(() => dropAmbientMp3(marker), AMBIENT_TTL_MS));
  return marker;
}

export function dropAmbientMp3(marker) {
  _ambientStreamCache.delete(marker);
  const t = _ambientTimers.get(marker);
  if (t) { clearTimeout(t); _ambientTimers.delete(marker); }
  // Close any in-flight HTTP response + kill its ffmpeg so the connection
  // doesn't dangle. The device's mp3 decoder sees EOF and exits.
  const inFlight = _ambientResponses.get(marker);
  if (inFlight) {
    try { inFlight.killFn?.(); } catch {}
    try { inFlight.res?.end(); } catch {}
    _ambientResponses.delete(marker);
  }
}

export function dropAmbientForDevice(deviceId) {
  const m = _ambientByDevice.get(deviceId);
  if (m) {
    dropAmbientMp3(m);
    _ambientByDevice.delete(deviceId);
  }
}

/**
 * Inspect the per-device ambient state. Returns the active marker + meta
 * (userId/file/loop) or null. Used by chat-dispatch to detect "wake fired
 * mid-ambient, never restarted" and resend play_ambient so the device picks
 * the stream back up.
 */
export function getAmbientForDevice(deviceId) {
  const marker = _ambientByDevice.get(deviceId);
  if (!marker) return null;
  const meta = _ambientStreamCache.get(marker);
  if (!meta) return null;
  return { marker, meta };
}

// Slot wake-word push moved to routes/voice-config.mjs as of 2026-05-13:
// slot routing is now per-user (voice-config), not per-device. The save
// path there pushes wake words to every device paired to the user.

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  // Child accounts cannot change voice devices — an admin manages them.
  if (/^(POST|PUT|DELETE|PATCH)$/.test(req.method)
      && (p.startsWith('/api/devices') || p.startsWith('/api/voice-chime'))
      && isChildRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Voice devices are managed by an admin for this account.' }));
    return true;
  }

  // Pairing endpoints first so /api/devices/pair and /api/devices/redeem
  // don't fall through to the generic /api/devices/:id handlers below.
  if (await handlePairingRoutes(req, res, p)) return true;

  // GET /api/voice-chime — report whether this user has a custom chime
  // installed and how big it is. UI uses this to decide between
  // "Built-in chime" and "Custom chime (NN KB)" labels.
  if (p === '/api/voice-chime' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const cp = userChimePath(userId);
    let hasCustom = false, sizeBytes = 0;
    try {
      const st = fs.statSync(cp);
      if (st.isFile()) { hasCustom = true; sizeBytes = st.size; }
    } catch (_) { /* file doesn't exist — built-in */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasCustom, sizeBytes }));
    return true;
  }

  // POST /api/voice-chime — upload a custom alarm chime that applies to
  // every voice device paired to this user. Server transcodes (mono 16 kHz
  // 64 kbps), persists to users/<id>/alarm-chime.mp3, then broadcasts
  // `chime_upload` over WS to every paired-and-online device. Currently-
  // offline devices won't pick it up until they reconnect AND a manual
  // re-broadcast happens; first-connect auto-push is a future iteration.
  if (p === '/api/voice-chime' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const CHIME_CAP = 2 * 1024 * 1024;
    let mp3In;
    try {
      mp3In = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
          size += chunk.length;
          if (size > CHIME_CAP) {
            req.destroy();
            reject(new Error(`MP3 too large (>${CHIME_CAP} bytes)`));
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
    // -t 10 clips to 10 s max — chime, not a song. Caps output ~80 KB
    // (mono/16k/64kbps) regardless of input duration so a "user uploads
    // a movie" mistake can't reach the device.
    const { spawn } = await import('child_process');
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-t', '10',
      '-ac', '1', '-ar', '16000', '-b:a', '64k',
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

    // Persist for future cross-server-restart use.
    const cp = userChimePath(userId);
    try {
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      fs.writeFileSync(cp, mp3Out);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `failed to persist chime: ${e.message}` }));
      return true;
    }

    // Broadcast to every paired-and-online device. Each push needs its own
    // one-shot marker because cacheOneShotMp3 markers are single-use (the
    // device consumes the cache entry when it fetches).
    const devices = listDevices(userId).filter(d => isDeviceOnline(d.id));
    let pushed = 0;
    for (const d of devices) {
      const marker = cacheOneShotMp3(mp3Out);
      if (sendToDevice(d.id, { type: 'chime_upload', audioMarker: marker })) pushed++;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bytes: mp3Out.length, pushed, devices: devices.length }));
    return true;
  }

  // DELETE /api/voice-chime — revert to the firmware's built-in procedural
  // chime. Removes the persisted MP3 and broadcasts a `chime_upload` with
  // no audioMarker; firmware treats that as "clear custom chime, fall back
  // to procedural."
  if (p === '/api/voice-chime' && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    try { fs.unlinkSync(userChimePath(userId)); } catch (_) { /* not present, ok */ }
    const devices = listDevices(userId).filter(d => isDeviceOnline(d.id));
    let pushed = 0;
    for (const d of devices) {
      if (sendToDevice(d.id, { type: 'chime_upload' })) pushed++;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pushed, devices: devices.length }));
    return true;
  }

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

  // POST /api/devices/:id/chime — replace the device's alarm chime with a
  // user-uploaded MP3. Server transcodes to mono 16 kHz (matches the
  // built-in procedural chime), caches under a one-shot marker, and sends
  // `chime_upload` over WS. The device fetches the MP3 via /api/tts,
  // decodes + persists to its `storage` SPIFFS partition, and uses that
  // as the alarm chime from then on (survives reboots).
  const chimeMatch = p.match(/^\/api\/devices\/([^/]+)\/chime$/);
  if (chimeMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const deviceId = decodeURIComponent(chimeMatch[1]);
    if (!getDevice(userId, deviceId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'device not found' }));
      return true;
    }
    // 2 MB cap — a chime is a short tone, anything bigger almost certainly
    // means the user uploaded a full song by accident.
    const CHIME_CAP = 2 * 1024 * 1024;
    let mp3In;
    try {
      mp3In = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
          size += chunk.length;
          if (size > CHIME_CAP) {
            req.destroy();
            reject(new Error(`MP3 too large (>${CHIME_CAP} bytes)`));
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
    // Normalize to mono 16 kHz 64 kbps so the SPIFFS footprint is small
    // and the format matches the procedural chime characteristics.
    // -t 10 clips anything past 10 seconds — a chime is a short tone, not
    // a song. Caps output size at ~80 KB (mono/16k/64kbps) regardless of
    // input duration, preventing a "user uploads a movie" footgun.
    const { spawn } = await import('child_process');
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-t', '10',
      '-ac', '1', '-ar', '16000', '-b:a', '64k',
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
    const marker = cacheOneShotMp3(mp3Out);
    const sent = sendToDevice(deviceId, { type: 'chime_upload', audioMarker: marker });
    if (!sent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'device offline' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bytes: mp3Out.length }));
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
    const marker = cacheOneShotMp3(mp3Out);

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

  // ── Ambient sound library ────────────────────────────────────────────────
  // Persistent MP3s the user uploads once, then references from routines (or
  // plays manually). Files live at users/<id>/ambient/<filename>.mp3; routines
  // (lib/routines.mjs) and the play-ambient route below resolve the filename
  // through ambientFilePath which guards against path traversal.

  // GET /api/devices/ambient-library — list this user's uploaded files.
  if (p === '/api/devices/ambient-library' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const files = listAmbientFiles(userId);
    // Lazy-fill missing durations so the UI can show "0:42" alongside size.
    // Fan out the probes in parallel; ffprobe on a small MP3 is ~20ms.
    await Promise.all(files.map(async (f) => {
      if (f.duration_s == null) f.duration_s = await probeAmbientDuration(userId, f.name);
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files }));
    return true;
  }

  // POST /api/devices/ambient-library/:file — upload a raw MP3 to the user's
  // ambient library. 40 MB cap (~33 min of audio at 160 kbps); the route
  // reads bytes inline because the global BODY_LIMIT (512 KB) would reject
  // any reasonable ambient sound. Exempt from the 25 MiB API_BODY_CAP in
  // server.mjs because that pre-route gate would otherwise reject anything
  // > 25 MiB before this handler even runs.
  const libUploadMatch = p.match(/^\/api\/devices\/ambient-library\/([^/]+)$/);
  if (libUploadMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const file = decodeURIComponent(libUploadMatch[1]);
    if (!ambientFilePath(userId, file)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid filename' }));
      return true;
    }
    const CAP = 40 * 1024 * 1024;
    let buf;
    try {
      buf = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
          size += chunk.length;
          if (size > CAP) {
            req.destroy();
            reject(new Error(`File too large (>${CAP} bytes)`));
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
    } catch (e) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
    if (!buf || buf.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty body' }));
      return true;
    }
    // MP3 frame-sync check: first two bytes are 0xFFEx (MPEG frame header)
    // OR an ID3v2 tag header ("ID3"). Reject anything else so the UI surfaces
    // mis-labeled uploads immediately instead of letting ffmpeg fail later
    // inside an in-flight playback request.
    const isMp3 = (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
                || (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33);
    if (!isMp3) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an MP3 file (expected MP3 frame or ID3 tag at offset 0)' }));
      return true;
    }
    try {
      saveAmbientFile(userId, file, buf);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
    const duration_s = await probeAmbientDuration(userId, file);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, file, size: buf.length, duration_s }));
    return true;
  }

  // DELETE /api/devices/ambient-library/:file
  if (libUploadMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const file = decodeURIComponent(libUploadMatch[1]);
    const removed = deleteAmbientFile(userId, file);
    res.writeHead(removed ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ removed }));
    return true;
  }

  // GET /api/devices/ambient-library/:file/preview — stream the raw stored
  // MP3 so the routines drawer can preview-play it in a browser <audio>
  // element. Range-aware to keep the file playable in browser seeking.
  const libPreviewMatch = p.match(/^\/api\/devices\/ambient-library\/([^/]+)\/preview$/);
  if (libPreviewMatch && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const file = decodeURIComponent(libPreviewMatch[1]);
    const full = ambientFilePath(userId, file);
    if (!full || !fs.existsSync(full)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    const stat = fs.statSync(full);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=60',
    });
    fs.createReadStream(full).pipe(res);
    return true;
  }

  // POST /api/devices/:id/play-ambient — start (looped) ambient playback on
  // a paired voice device. Body: { file: string, loop?: bool, volume?: 0-100 }.
  // The ffmpeg transcode + WS dispatch lives in lib/ambient-playback.mjs so
  // routines can reuse the same code path.
  const ambPlayMatch = p.match(/^\/api\/devices\/([^/]+)\/play-ambient$/);
  if (ambPlayMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const deviceId = decodeURIComponent(ambPlayMatch[1]);
    if (!getDevice(userId, deviceId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'device not found' }));
      return true;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    try {
      const result = await playAmbientOnDevice({
        userId,
        deviceId,
        file: body.file,
        loop: body.loop !== false,
        volume: body.volume,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) {
      const code = /not found/i.test(e.message) ? 404 : /offline/i.test(e.message) ? 503 : 500;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // POST /api/devices/:id/stop-ambient — stop ambient playback on the device.
  const ambStopMatch = p.match(/^\/api\/devices\/([^/]+)\/stop-ambient$/);
  if (ambStopMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const deviceId = decodeURIComponent(ambStopMatch[1]);
    if (!getDevice(userId, deviceId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'device not found' }));
      return true;
    }
    // stopAmbientOnDevice is async — without await the Promise was always
    // truthy and this route reported ok:true even for offline devices.
    const sent = await stopAmbientOnDevice(deviceId);
    res.writeHead(sent ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !!sent }));
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
    // If the user renamed the device, push the new name to the firmware so
    // it persists to NVS + live-refreshes the AirPlay mDNS instance label.
    // Fire-and-forget — offline devices won't see the rename until they
    // come back AND someone renames again (no on-reconnect re-sync yet).
    if (typeof body?.name === 'string' && body.name.trim()) {
      try { sendToDevice(updated.id, { type: 'set_device_name', name: updated.name }); } catch {}
    }
    if (typeof body?.headphone_mode === 'boolean') {
      try { sendToDevice(updated.id, { type: 'set_headphone_mode', enabled: !!body.headphone_mode }); } catch {}
    }
    // Per-device PATCH no longer mutates slot routing — slot_assignments
    // is per-user (voice-config) since 2026-05-13. push is always empty
    // here; the voice-config PUT handler is where wake-word OTA fires.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ device: updated, push: { pushed: [], offline: [] } }));
    return true;
  }

  // POST /api/devices/:id/ota — ask the device to check for + apply a
  // firmware update. Fires a single ota_check WS message; the device
  // streams ota_progress events back over the same socket which we fan
  // out to the user's browser tabs (see ws-handler.mjs). Manifest at
  // public/firmware/voice-device/manifest.json drives the version
  // decision device-side; this endpoint is just the nudge.
  const otaMatch = p.match(/^\/api\/devices\/([^/]+)\/ota$/);
  if (otaMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = decodeURIComponent(otaMatch[1]);
    const device = getDevice(userId, id);
    if (!device) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    if (!isDeviceOnline(id)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'device_offline' }));
      return true;
    }
    const sent = sendToDevice(id, { type: 'ota_check' });
    res.writeHead(sent ? 202 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ nudged: !!sent }));
    return true;
  }

  // POST /api/devices/:id/enter-ap — tell the device to wipe its Wi-Fi/pairing
  // creds and reboot into the captive-portal AP (oe-voice-XXXX) so it can be
  // moved to a different Wi-Fi network. The device must be ONLINE to receive
  // this (it's reachable on its current network); afterwards it drops off and
  // reappears as the setup AP. Wake-word models (SPIFFS) are preserved.
  const apMatch = p.match(/^\/api\/devices\/([^/]+)\/enter-ap$/);
  if (apMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = decodeURIComponent(apMatch[1]);
    const device = getDevice(userId, id);
    if (!device) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    if (!isDeviceOnline(id)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'device_offline' }));
      return true;
    }
    const sent = sendToDevice(id, { type: 'enter_ap_mode' });
    // The device wipes its pairing on reset and comes back as a brand-new
    // device (fresh pairing via the captive portal), so this registry entry is
    // now stale. Remove it + revoke its session token so it drops out of the
    // Devices drawer immediately. Send the WS command FIRST (above) so the
    // frame is buffered before we revoke.
    removeDevice(userId, id);
    let sessionRevoked = false;
    if (device.token_prefix) sessionRevoked = revokeSessionByPrefix(userId, device.token_prefix);
    res.writeHead(sent ? 202 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ nudged: !!sent, removed: true, sessionRevoked }));
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
