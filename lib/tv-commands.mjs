/**
 * Android TV command channel — server-side half of the tv_command /
 * tv_command_result protocol (see oe-tv-assistant/
 * PROTOCOL-TV.md, "Wire protocol"). Same shape as the persistent-socket
 * push helpers in lib/alarms.mjs / lib/ambient-playback.mjs (sendToDevice)
 * and the pending-map + timeout pattern in lib/credentials.mjs
 * (requestCredential/submitCredential).
 *
 * sendTvCommand() pushes a `tv_command` frame to the device's WS and awaits
 * a matching `tv_command_result`; handleTvCommandResult() (wired from
 * ws-handler.mjs onWsMessage) resolves the pending entry. Playback reporting
 * has been removed; legacy state frames are discarded.
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
    data: entry.action === 'get_state' ? deviceStatus(msg.data) : (msg.data ?? null),
    error: typeof msg.error === 'string' ? msg.error : null,
  });
}

// Older clients may still include playback fields in command replies. Only
// expose device status and installed app names from get_state.
function deviceStatus(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const result = {};
  if (typeof data.screen_on === 'boolean') result.screen_on = data.screen_on;
  if (Array.isArray(data.installed_apps)) {
    result.installed_apps = data.installed_apps.filter(app => typeof app === 'string');
  }
  return result;
}

// Compatibility exports for older protocol callers. No playback state is kept.
export function handleTvState() {}
export function getTvState() { return null; }
