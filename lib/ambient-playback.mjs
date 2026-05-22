/**
 * Server-side helper for kicking off ambient audio playback on a voice device.
 *
 * Looped playback is delivered as ONE continuous HTTP/MP3 stream: the /api/tts
 * handler in routes/config.mjs spawns ffmpeg with `-stream_loop -1` and pipes
 * the never-ending output into the response. The device's libhelix decoder
 * sees no EOF until the response is closed (stop_ambient WS message → server
 * kills ffmpeg → connection ends). Zero silence at loop seams.
 *
 * That means we don't transcode at register-time — registering an ambient
 * stream just stashes the source file path + loop flag against a marker.
 * The device echoes the marker through /api/tts, the handler resolves it
 * back to the source file, and ffmpeg streams from there.
 */

import fs from 'fs';
import { sendToDevice } from '../ws-handler.mjs';
import { ambientFilePath } from './routines.mjs';

let _cacheAmbientStream = null;
let _dropAmbientForDevice = null;
async function getCache() {
  if (_cacheAmbientStream) return _cacheAmbientStream;
  const mod = await import('../routes/devices.mjs');
  _cacheAmbientStream = mod.cacheAmbientStream;
  _dropAmbientForDevice = mod.dropAmbientForDevice;
  return _cacheAmbientStream;
}

/**
 * Start ambient playback on `deviceId`. Returns once the WS message has been
 * dispatched; the actual ffmpeg stream is established on the device's next
 * /api/tts request (driven by the firmware's ambient_worker_task).
 */
export async function playAmbientOnDevice({ userId, deviceId, file, loop = true, volume = null }) {
  const full = ambientFilePath(userId, file);
  if (!full || !fs.existsSync(full)) {
    throw new Error(`Ambient file not found: ${file}`);
  }
  const cacheAmbientStream = await getCache();
  const marker = cacheAmbientStream(deviceId, { userId, file, loop: loop !== false });
  const sent = sendToDevice(deviceId, {
    type: 'play_ambient',
    audioMarker: marker,
    loop: !!loop,
    ...(Number.isFinite(volume) ? { volume: Math.max(0, Math.min(100, Math.round(volume))) } : {}),
  });
  if (!sent) {
    // Cache leak guard: device dropped between our send-check and now.
    if (_dropAmbientForDevice) _dropAmbientForDevice(deviceId);
    throw new Error('Device offline');
  }
  return { marker };
}

/**
 * Stop any active ambient playback on `deviceId`. Sends stop_ambient over WS,
 * drops the server-side cache entry, and kills the in-flight ffmpeg pipe so
 * the HTTP response on the device closes cleanly (libhelix sees EOF, the
 * firmware ambient worker exits, audio_io stops).
 */
export async function stopAmbientOnDevice(deviceId) {
  const sent = sendToDevice(deviceId, { type: 'stop_ambient' });
  await getCache();
  if (_dropAmbientForDevice) _dropAmbientForDevice(deviceId);
  return sent;
}
