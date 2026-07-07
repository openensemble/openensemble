/**
 * routes/tv.mjs — Android TV HTTP surface (see oe-tv-assistant/
 * PROTOCOL-TV.md). Structured like routes/wakewords.mjs: a single
 * `handle(req, res)` returning true once it has written a response, mounted
 * into server.mjs's routeHandlers list.
 *
 *   GET /api/tv/camera/:entityId   — proxy a Home Assistant camera snapshot (binary)
 *   GET /api/tv-app/manifest       — self-update manifest (404 cleanly if absent)
 *   GET /api/tv-app/apk            — self-update APK bytes (404 cleanly if absent)
 *   GET /api/tv/wakeword/:id       — stock wake-word .tflite download
 *   GET /api/wakewords/stock/:id.tflite — documented alias of the above
 *                                    (PROTOCOL-TV.md's canonical path /
 *                                    the Android client's fallback URL)
 *
 * Auth: every route uses requireAuth() — the same helper /api/stt and
 * /api/tts (routes/config.mjs) use. It accepts either the browser session
 * cookie or an `Authorization: Bearer <token>` header, and a paired
 * device's token (voice device or Android TV) is just an ordinary session
 * from the server's point of view (lib/voice-devices.mjs / routes/devices/
 * pairing.mjs), so no separate device-only auth path exists or is needed
 * here — reusing requireAuth() keeps this route module consistent with the
 * rest of the device-facing HTTP surface.
 */

import fs from 'fs';
import path from 'path';
import { requireAuth, getSessionMeta, getAuthToken, isPrivileged, BASE_DIR } from './_helpers.mjs';
import { getHaConfig, haRequestBinary } from '../lib/ha-client.mjs';
import { log } from '../logger.mjs';

const CAMERA_ENTITY_RE = /^camera\.[a-z0-9_]+$/i;
const WAKEWORD_ID_RE = /^[a-z0-9_]+$/;
const CAMERA_TIMEOUT_MS = 10_000;

const TV_APP_DIR = path.join(BASE_DIR, 'tv-app');
const WAKEWORD_STOCK_DIR = path.join(BASE_DIR, 'wakewords', 'stock');

export async function handle(req, res) {
  const url = req.url.split('?')[0];

  // GET /api/tv/camera/:entityId — snapshot proxy, binary passthrough.
  const cameraMatch = url.match(/^\/api\/tv\/camera\/([^/]+)$/);
  if (cameraMatch && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    // Camera snapshots are the most privacy-sensitive HA surface, so unlike
    // the rest of this module (app/wakeword downloads) plain requireAuth()
    // isn't enough — that would let ANY household session pull ANY camera.
    // The only product path to this endpoint is a paired device rendering an
    // image_url the tv_show_camera tool sent it, so gate to device-bound
    // sessions (session meta carries deviceId — set at pairing redeem /
    // adoptSession) plus privileged users for browser-side debugging.
    const meta = getSessionMeta(getAuthToken(req));
    if (!meta?.deviceId && !isPrivileged(userId)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'camera snapshots are limited to paired devices and admins' }));
      return true;
    }
    const entityId = decodeURIComponent(cameraMatch[1]);
    if (!CAMERA_ENTITY_RE.test(entityId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid camera entity id' }));
      return true;
    }
    const haCfg = getHaConfig();
    if (!haCfg) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Home Assistant not configured' }));
      return true;
    }
    try {
      const result = await haRequestBinary(haCfg, `/camera_proxy/${entityId}`, { timeoutMs: CAMERA_TIMEOUT_MS });
      if (result.__err) {
        // Detail stays server-side: __err carries connection internals
        // ("connect ECONNREFUSED <ip>:8123") that don't belong in a client
        // response body.
        log.warn('tv', 'camera proxy failed', { entityId, error: result.__err });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'camera unavailable' }));
        return true;
      }
      res.writeHead(200, {
        'Content-Type': result.contentType || 'image/jpeg',
        'Content-Length': result.body.length,
        'Cache-Control': 'no-store',
      });
      res.end(result.body);
    } catch (e) {
      log.warn('tv', 'camera proxy failed', { entityId, error: e?.message });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'camera unavailable' }));
    }
    return true;
  }

  // GET /api/tv-app/manifest — self-update check. Absent file means "no
  // update offered" (404), not an error — the TV app treats 404 as "up to
  // date" / "nothing published yet".
  if (url === '/api/tv-app/manifest' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const manifestPath = path.join(TV_APP_DIR, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no manifest available' }));
      return true;
    }
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      JSON.parse(raw); // validate before serving — don't hand the device malformed JSON as a 200
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(raw);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'manifest.json is not valid JSON' }));
    }
    return true;
  }

  // GET /api/tv-app/apk — self-update APK bytes.
  if (url === '/api/tv-app/apk' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const apkPath = path.join(TV_APP_DIR, 'oe-assistant.apk');
    if (!fs.existsSync(apkPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no apk available' }));
      return true;
    }
    try {
      const stat = fs.statSync(apkPath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="oe-assistant.apk"',
      });
      fs.createReadStream(apkPath).pipe(res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'failed to read apk' }));
    }
    return true;
  }

  // GET /api/tv/wakeword/:id — stock wake-word .tflite download. No
  // equivalent exists in routes/wakewords.mjs today: that module is JSON+
  // base64 upload/list/delete for the per-user library (see its header
  // comment), with no plain-binary GET for the built-in stock/*.tflite
  // files. The TV needs a plain byte GET to fetch its default wake word
  // (e.g. "jarvis"), so this is a small standalone addition, not a
  // duplicate of anything wakewords.mjs already exposes.
  const wwMatch = url.match(/^\/api\/tv\/wakeword\/([^/]+)$/);
  if (wwMatch && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    serveStockWakeword(decodeURIComponent(wwMatch[1]), res);
    return true;
  }

  // GET /api/wakewords/stock/<id>.tflite — the path PROTOCOL-TV.md documents
  // and the Android client's fallback download URL actually requests. This
  // is an alias of the handler above, same file, same auth, same id
  // validation (just stripping the .tflite suffix first). Safe to serve
  // from here: routes/wakewords.mjs (mounted earlier in server.mjs) only
  // matches the exact `/api/wakewords` path (GET/POST) and `/api/wakewords/
  // :id` for DELETE — it falls through (returns false) for this GET path,
  // so it never intercepts or 404s it before reaching this handler.
  const wwStockMatch = url.match(/^\/api\/wakewords\/stock\/([^/]+)\.tflite$/);
  if (wwStockMatch && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    serveStockWakeword(decodeURIComponent(wwStockMatch[1]), res);
    return true;
  }

  return false;
}

// Shared by /api/tv/wakeword/:id and its documented alias
// /api/wakewords/stock/:id.tflite — validates the id, then serves the
// matching wakewords/stock/<id>.tflite file as raw bytes (404 if missing).
function serveStockWakeword(id, res) {
  if (!WAKEWORD_ID_RE.test(id)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid wake word id' }));
    return;
  }
  const tflitePath = path.join(WAKEWORD_STOCK_DIR, `${id}.tflite`);
  if (!fs.existsSync(tflitePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  try {
    const data = fs.readFileSync(tflitePath);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'failed to read wake word file' }));
  }
}
