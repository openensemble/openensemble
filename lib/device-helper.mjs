// @ts-check
/**
 * ctx.device — primitive surface for skills that want to drive the user's
 * voice device(s). Mirrors the shape of ctx.browser and ctx.collection:
 * bound to a userId at ctx-construction time, lazy-imports the heavier
 * device + ambient + WS modules so skills don't pull them on import.
 *
 * v1 surface (what Ada knows to compose into a skill):
 *   ctx.device.id()                              — current device the user
 *                                                  is talking through, or null
 *                                                  for web/text chat
 *   ctx.device.list()                            — every registered device
 *   ctx.device.playStream(deviceId, url, opts)   — start an MP3-transcoded
 *                                                  stream from a URL; loops if
 *                                                  opts.loop === true
 *   ctx.device.stop(deviceId)                    — stop any current stream
 *   ctx.device.speak(deviceId, text)             — TTS something through the
 *                                                  device's speaker
 *   ctx.device.notify(deviceId, text)            — v1 = same as speak; chime
 *                                                  + criticality + quiet-hours
 *                                                  arrive in v2
 *
 * Things this surface intentionally hides from the skill author:
 *   - The marker-cache + ffmpeg pipeline that streams MP3 CBR 160 kbps to
 *     the firmware. The device only decodes that exact format, but the skill
 *     doesn't need to know — playStream takes any URL ffmpeg can read.
 *   - The WS send-to-device plumbing. Skills must never touch sendToDevice
 *     directly; they call ctx.device.* and let it handle marker registration
 *     and cleanup.
 *
 * Deferred to project_voice_device_skill_api_todo.md:
 *   multi-turn handoff, LED control, recording capture, broadcast,
 *   per-device profiles, quiet hours, notification budget.
 */

import { randomBytes } from 'crypto';

export function buildDeviceHelpers({ userId }) {
  return {
    id() {
      // Returns the device the current chat turn is coming through, null if
      // text/web chat. Uses the AsyncLocalStorage that chat-dispatch enters
      // on every voice-origin turn.
      try {
        const { getVoiceContext } = require('./voice-context.mjs');
        return getVoiceContext()?.deviceId ?? null;
      } catch {
        // Dynamic import path for ESM contexts.
        return _voiceCtxIdSync();
      }
    },

    async list() {
      const { listDevices } = await import('./voice-devices.mjs');
      return listDevices(userId);
    },

    /**
     * Start streaming an audio URL to the device. ffmpeg pulls from the URL
     * and transcodes to MP3 CBR 160 kbps stereo at 48 kHz (the only format
     * the firmware decodes). On loop:true the stream restarts seamlessly at
     * end-of-file. Returns the marker — caller can pass it to stop() later
     * or just call stop(deviceId) which kills whatever is playing.
     */
    async playStream(deviceId, url, opts = {}) {
      if (!deviceId) throw new Error('ctx.device.playStream: deviceId required');
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        throw new Error('ctx.device.playStream: url must be http:// or https://');
      }
      const loop = opts.loop === true;
      const { cacheAmbientStream } = await import('../routes/devices.mjs');
      const { sendToDevice } = await import('../ws-handler.mjs');
      // Register a marker tagged with the URL — routes/config.mjs ambient
      // handler picks it up via takeAmbientStream(), sees meta.url, and feeds
      // it to ffmpeg's -i. Same pinning behavior as ambient-library streams.
      const marker = cacheAmbientStream(deviceId, { userId, url, loop });
      const delivered = sendToDevice(deviceId, {
        type: 'play_ambient',
        audioMarker: marker,
        loop,
      });
      if (!delivered) throw new Error(`ctx.device.playStream: device ${deviceId} offline`);
      return marker;
    },

    async stop(deviceId) {
      if (!deviceId) throw new Error('ctx.device.stop: deviceId required');
      const { stopAmbientOnDevice } = await import('./ambient-playback.mjs');
      return stopAmbientOnDevice(deviceId);
    },

    /**
     * Speak text through the device's speaker. Sends a `token` event with the
     * text + a `done` event so the firmware's TTS pipeline plays it. If the
     * device is mid-conversation with another agent, this WILL interrupt that
     * agent's reply — be mindful when calling from a background skill.
     */
    async speak(deviceId, text) {
      if (!deviceId) throw new Error('ctx.device.speak: deviceId required');
      const safe = String(text || '').trim();
      if (!safe) throw new Error('ctx.device.speak: text required');
      const { sendToDevice } = await import('../ws-handler.mjs');
      sendToDevice(deviceId, { type: 'token', text: safe, agent: 'system' });
      sendToDevice(deviceId, { type: 'done', agent: 'system' });
      return { ok: true };
    },

    /**
     * Push notification. v1 = just speak the text. v2 adds a chime, a
     * criticality axis, quiet-hours gating, per-skill rate limits, and an
     * optional "want to respond?" prompt. See
     * project_voice_device_skill_api_todo.md for the design.
     */
    async notify(deviceId, text) {
      return this.speak(deviceId, text);
    },
  };
}

// Sync helper for ctx.device.id() — the require() path above only works in
// CJS environments. In ESM we have to await dynamic import, but id() needs
// to be sync for ergonomic skill code. Workaround: keep a cached reference
// to getVoiceContext once it's been resolved once.
let _vctxFn = null;
function _voiceCtxIdSync() {
  // Best-effort sync read; if we haven't resolved the module yet just return
  // null. Skills that need certainty can `await ctx.device.list()` first or
  // check `ctx.device.id() ?? <default>`.
  return _vctxFn ? (_vctxFn()?.deviceId ?? null) : null;
}
// Lazily resolve on first roles.mjs:buildCtx call (handled there).
export function _registerVoiceContextResolver(getVoiceContext) {
  _vctxFn = getVoiceContext;
}
