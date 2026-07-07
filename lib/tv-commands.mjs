/**
 * Android TV command channel — server-side half of the tv_command /
 * tv_command_result / tv_state protocol (see oe-tv-assistant/
 * PROTOCOL-TV.md, "Wire protocol"). Same shape as the persistent-socket
 * push helpers in lib/alarms.mjs / lib/ambient-playback.mjs (sendToDevice)
 * and the pending-map + timeout pattern in lib/credentials.mjs
 * (requestCredential/submitCredential).
 *
 * sendTvCommand() pushes a `tv_command` frame to the device's WS and awaits
 * a matching `tv_command_result`; handleTvCommandResult() (wired from
 * ws-handler.mjs onWsMessage) resolves the pending entry. handleTvState()/
 * getTvState() keep a small bounded last-known-state cache per device for
 * the dashboard/tool layers a later agent builds on top of this.
 */

import { randomBytes } from 'crypto';
import { sendToDevice, isDeviceOnline } from '../ws-handler.mjs';

const DEFAULT_TIMEOUT_MS = 6000;

// id -> { resolve, reject, timer, deviceId, action }
const _pending = new Map();

function newCommandId() {
  return `tvc_${randomBytes(6).toString('hex')}`;
}

/**
 * Send a `tv_command` to `deviceId` and await its `tv_command_result`.
 *
 * @param {string} deviceId
 * @param {string} action - launch_app | media_key | set_volume | search | get_state | show | wake_screen
 * @param {object} [args] - action-specific args, spread into the wire frame verbatim
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, data: any, error: string|null}>} Resolves with
 *   the device's tv_command_result payload. Rejects with an Error (`.code` =
 *   'OFFLINE' | 'TIMEOUT' | 'INVALID') if the device is offline (checked up
 *   front via isDeviceOnline, and again via sendToDevice's delivery count to
 *   close the race where the device drops between the two checks), or if no
 *   result arrives within `timeoutMs` (default 6000).
 */
export function sendTvCommand(deviceId, action, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!deviceId) {
    const e = new Error('sendTvCommand: deviceId required');
    e.code = 'INVALID';
    return Promise.reject(e);
  }
  if (!action || typeof action !== 'string') {
    const e = new Error('sendTvCommand: action required');
    e.code = 'INVALID';
    return Promise.reject(e);
  }
  if (!isDeviceOnline(deviceId)) {
    const e = new Error(`tv device offline: ${deviceId}`);
    e.code = 'OFFLINE';
    return Promise.reject(e);
  }

  const id = newCommandId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      const e = new Error(`tv_command timed out (${timeoutMs}ms): ${action}`);
      e.code = 'TIMEOUT';
      reject(e);
    }, timeoutMs);
    timer.unref?.();
    _pending.set(id, { resolve, reject, timer, deviceId, action });

    const delivered = sendToDevice(deviceId, { type: 'tv_command', id, action, ...args });
    if (!delivered) {
      // Device disconnected between the isDeviceOnline check above and this
      // send — sendToDevice's delivery count is the authoritative signal.
      clearTimeout(timer);
      _pending.delete(id);
      const e = new Error(`tv device offline: ${deviceId}`);
      e.code = 'OFFLINE';
      reject(e);
    }
  });
}

/**
 * Resolve a pending sendTvCommand() promise from the device's
 * `tv_command_result` frame. Safe to call with an unknown, duplicate, or
 * already-timed-out id — silent no-op. Wired from ws-handler.mjs
 * onWsMessage for authed device sockets only.
 *
 * `senderDeviceId` (the socket's ws._deviceId) must match the device the
 * command was sent to. Command ids are 48-bit random so cross-device
 * collisions aren't practically guessable — this check is defense-in-depth
 * so one paired device can never resolve (spoof the result of) a command
 * addressed to another, even with a leaked id.
 */
export function handleTvCommandResult(senderDeviceId, msg) {
  const id = typeof msg?.id === 'string' ? msg.id : null;
  if (!id) return;
  const entry = _pending.get(id);
  if (!entry) return; // unknown/duplicate/expired id — nothing to resolve
  if (entry.deviceId !== senderDeviceId) return; // not this sender's command
  clearTimeout(entry.timer);
  _pending.delete(id);
  entry.resolve({
    ok: msg.ok !== false,
    data: msg.data ?? null,
    error: typeof msg.error === 'string' ? msg.error : null,
  });
}

// ── Last-known TV state (in-memory, bounded) ────────────────────────────────
// Populated by unsolicited `tv_state` frames (device throttles these to
// ≥5s apart). Bounded so a churn of paired/removed TV devices can't grow
// this map forever. Update-refreshed LRU: handleTvState deletes before
// re-setting so an actively-reporting TV moves to the back of the eviction
// order — the cap only ever evicts the device that has been silent longest.

const MAX_TV_STATES = 200;
const _tvState = new Map(); // deviceId -> { nowPlaying, foregroundApp, screenOn, updatedAt }

/**
 * Record a device's `tv_state` frame. Wired from ws-handler.mjs
 * onWsMessage for authed device sockets only.
 *
 * @param {string} deviceId
 * @param {{now_playing?: object|null, foreground_app?: string, screen_on?: boolean}} msg
 */
export function handleTvState(deviceId, msg) {
  if (!deviceId || !msg || typeof msg !== 'object') return;
  if (_tvState.has(deviceId)) {
    _tvState.delete(deviceId); // re-set below moves this device to the back of the eviction order
  } else if (_tvState.size >= MAX_TV_STATES) {
    const oldestKey = _tvState.keys().next().value;
    if (oldestKey !== undefined) _tvState.delete(oldestKey);
  }
  _tvState.set(deviceId, {
    nowPlaying: msg.now_playing && typeof msg.now_playing === 'object' ? msg.now_playing : null,
    foregroundApp: typeof msg.foreground_app === 'string' ? msg.foreground_app : null,
    screenOn: typeof msg.screen_on === 'boolean' ? msg.screen_on : null,
    updatedAt: Date.now(),
  });
}

/** Return the last-known state for a TV device, or null if never reported. */
export function getTvState(deviceId) {
  return _tvState.get(deviceId) ?? null;
}
