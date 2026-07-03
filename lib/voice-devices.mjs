// @ts-check
/**
 * Voice-device registry.
 *
 * Per-user JSON file at users/<uid>/voice-devices.json. Each entry is a paired
 * speaker / mic device (XVF3800 + ESP32-S3, etc.) that authenticates over the
 * shared /ws with `kind: 'voice-device'` tokens. No WS handling lives here —
 * unlike nodes, voice devices don't have a server-driven command channel;
 * they just open a chat WS the same way a browser tab does, and we use this
 * registry only for metadata + per-device user prefs.
 *
 * Shape per entry:
 *   { id, name, paired_at, last_seen, token_prefix,
 *     default_agent_id, speak_replies, mute_state,
 *     fw_version, tts_voice, wake_word_slot }
 */

import fs from 'fs';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { USERS_DIR } from './paths.mjs';

// sha256 of a session token — stored per device so an expired/pruned token can
// be verified (and the device's session auto-recovered) without ever keeping
// the raw token at rest. See findDeviceByTokenAnyUser / recordTokenSecret.
function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { getConfiguredSlot, readVoiceConfig, writeVoiceConfig, findUsersSharingTo } from './voice-config.mjs';

function userFile(userId) {
  return path.join(USERS_DIR, userId, 'voice-devices.json');
}

function readFile(userId) {
  const file = userFile(userId);
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.warn(`[voice-devices] read failed for ${userId}: ${e.message}`);
    return [];
  }
}

function writeFile(userId, devices) {
  const file = userFile(userId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteSync(file, JSON.stringify(devices, null, 2));
  } catch (e) {
    console.warn(`[voice-devices] write failed for ${userId}: ${e.message}`);
  }
}

// Public shape returned to the UI; token_prefix is included so the user can
// recognize a device's session row, but the full token is never echoed back.
function toWire(d) {
  return {
    id: d.id,
    name: d.name,
    paired_at: d.paired_at,
    last_seen: d.last_seen ?? null,
    token_prefix: d.token_prefix ?? null,
    default_agent_id: d.default_agent_id ?? null,
    speak_replies: d.speak_replies !== false,
    mute_state: !!d.mute_state,
    fw_version: d.fw_version ?? null,
    ota_status: d.ota_status ?? null,
    tts_voice: d.tts_voice ?? 'alloy',
    wake_word_slot: typeof d.wake_word_slot === 'number' ? d.wake_word_slot : 0,
    // Slot routing moved to per-user voice-config (lib/voice-config.mjs) as
    // of 2026-05-13. Every voice device paired to a user inherits the same
    // config so a household configures slots once across kitchen / bedroom
    // / etc. devices instead of per-device.
    voice_config_pushed_version: Number.isInteger(d.voice_config_pushed_version) ? d.voice_config_pushed_version : 0,
    headphone_mode: !!d.headphone_mode,
  };
}

export function listDevices(userId) {
  return readFile(userId).map(toWire);
}

export function getDevice(userId, id) {
  const d = readFile(userId).find(x => x.id === id);
  return d ? toWire(d) : null;
}

/**
 * Register a freshly-paired device. Called from /api/devices/redeem after
 * createSession mints a token. Caller supplies the token so we can store its
 * 8-char prefix for UI display + revoke-by-id lookup. `info` is optional
 * client-supplied metadata (name, fw_version).
 *
 * @param {string} userId
 * @param {{token?: string, info?: {name?: string, fw_version?: string}}} [opts]
 */
export function registerDevice(userId, { token, info = {} } = {}) {
  const devices = readFile(userId);
  const id = `vdev_${randomBytes(4).toString('hex')}`;
  const now = Date.now();
  const entry = {
    id,
    name: (info.name && String(info.name).slice(0, 64)) || 'Voice device',
    paired_at: now,
    last_seen: now,
    token_prefix: token ? token.slice(0, 8) : null,
    token_hash: token ? hashToken(token) : null,
    default_agent_id: null,
    speak_replies: true,
    mute_state: false,
    fw_version: info.fw_version ? String(info.fw_version).slice(0, 64) : null,
    tts_voice: 'alloy',
    wake_word_slot: 0,
    // Tracks the last voice-config version pushed to this device, so we
    // only OTA-resend wake words when the user's config has changed since
    // we last spoke to this device (avoids flash wear on every reconnect).
    voice_config_pushed_version: 0,
  };
  devices.push(entry);
  writeFile(userId, devices);
  return toWire(entry);
}

// Allowed fields for PATCH /api/devices/:id. Everything else is rejected so a
// compromised device or stale UI can't mutate paired_at / token_prefix / etc.
// slot_assignments is no longer device-scoped (see voice-config) so PATCH
// can't set it; the routes/voice-config.mjs PUT handler owns slot routing.
const PATCHABLE = new Set([
  'name', 'default_agent_id', 'speak_replies',
  'tts_voice', 'wake_word_slot', 'headphone_mode',
]);

export function updateDevice(userId, id, patch) {
  const devices = readFile(userId);
  const idx = devices.findIndex(x => x.id === id);
  if (idx < 0) return null;
  const entry = devices[idx];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!PATCHABLE.has(k)) continue;
    if (k === 'name') entry.name = String(v || '').slice(0, 64) || entry.name;
    else if (k === 'speak_replies') entry.speak_replies = !!v;
    else if (k === 'headphone_mode') entry.headphone_mode = !!v;
    else if (k === 'wake_word_slot') {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0 && n <= 5) entry.wake_word_slot = n;
    }
    else if (k === 'tts_voice') {
      // Server-side allowlist would belong in /api/devices PATCH route once
      // a provider voice list is wired; here we just trim + length-cap.
      entry.tts_voice = String(v || 'alloy').slice(0, 64);
    }
    else entry[k] = v;
  }
  devices[idx] = entry;
  writeFile(userId, devices);
  return toWire(entry);
}

/**
 * Update last_seen + optional fw_version. Called from WS auth/heartbeat when
 * a voice-device token connects. Idempotent — silently no-ops if the id has
 * been removed.
 *
 * @param {string} userId
 * @param {string} id
 * @param {{fw_version?: string, mute_state?: boolean}} [opts]
 */
export function touchDevice(userId, id, { fw_version, mute_state } = {}) {
  const devices = readFile(userId);
  const idx = devices.findIndex(x => x.id === id);
  if (idx < 0) return;
  const now = Date.now();
  devices[idx].last_seen = Date.now();
  if (fw_version) {
    const fw = String(fw_version).slice(0, 64);
    devices[idx].fw_version = fw;
    const ota = devices[idx].ota_status;
    if (ota?.target_version && fw === ota.target_version && ota.outcome !== 'success') {
      devices[idx].ota_status = {
        ...ota,
        phase: 'confirmed',
        outcome: 'success',
        confirmed_at: now,
        updated_at: now,
      };
    } else if (ota?.target_version && ota.outcome == null && ota.phase !== 'up_to_date') {
      const reconnects = Array.isArray(ota.reconnects) ? ota.reconnects.filter(t => now - t < 10 * 60_000) : [];
      reconnects.push(now);
      devices[idx].ota_status = {
        ...ota,
        reconnects,
        updated_at: now,
        ...(reconnects.length >= 4 ? { outcome: 'suspect_boot_loop', phase: 'suspect_boot_loop' } : {}),
      };
    }
  }
  if (typeof mute_state === 'boolean') devices[idx].mute_state = mute_state;
  writeFile(userId, devices);
}

export function recordDeviceOtaProgress(userId, id, progress = {}) {
  const devices = readFile(userId);
  const idx = devices.findIndex(x => x.id === id);
  if (idx < 0) return null;
  const now = Date.now();
  const phase = typeof progress.phase === 'string' ? progress.phase.slice(0, 64) : '';
  const target = typeof progress.target_version === 'string' ? progress.target_version.slice(0, 64) : null;
  const prev = devices[idx].ota_status && typeof devices[idx].ota_status === 'object'
    ? devices[idx].ota_status
    : {};
  const next = {
    ...prev,
    phase,
    target_version: target ?? prev.target_version ?? null,
    bytes_done: Number.isFinite(progress.bytes_done) ? progress.bytes_done : (prev.bytes_done ?? 0),
    total: Number.isFinite(progress.total) ? progress.total : (prev.total ?? 0),
    err: typeof progress.err === 'string' ? progress.err.slice(0, 256) : null,
    updated_at: now,
  };
  if (!prev.requested_at) next.requested_at = now;
  if (phase === 'error') next.outcome = 'error';
  else if (phase === 'up_to_date') next.outcome = 'up_to_date';
  else if (phase === 'confirmed') next.outcome = 'success';
  else if (phase) delete next.outcome;
  devices[idx].ota_status = next;
  writeFile(userId, devices);
  return toWire(devices[idx]);
}

/**
 * Record that the voice-config at `version` has been OTA-pushed to this
 * device. Called after the push succeeds so we don't re-push the same
 * config on every WS reconnect (avoidable SPIFFS write wear).
 */
export function markVoiceConfigPushed(userId, id, version) {
  const devices = readFile(userId);
  const idx = devices.findIndex(x => x.id === id);
  if (idx < 0) return;
  devices[idx].voice_config_pushed_version = Number.isInteger(version) ? version : 0;
  writeFile(userId, devices);
}

/**
 * Return the voice-config version this device was last pushed (0 if
 * never). Caller compares against readVoiceConfig().version to decide
 * whether to OTA-resend the wake words on a fresh WS connect.
 */
export function getDeviceVoiceConfigVersion(userId, id) {
  const d = readFile(userId).find(x => x.id === id);
  if (!d) return null;
  return Number.isInteger(d.voice_config_pushed_version) ? d.voice_config_pushed_version : 0;
}

export function removeDevice(userId, id) {
  const devices = readFile(userId);
  const idx = devices.findIndex(x => x.id === id);
  if (idx < 0) return null;
  const [removed] = devices.splice(idx, 1);
  writeFile(userId, devices);
  return toWire(removed);
}

/**
 * Resolve a wake-slot to its { ownerUserId, agentId, ttsVoice, wakewordId }
 * assignment by reading the device-owner's per-user voice-config. ONE
 * config per user → applies to all of their voice devices.
 *
 * - `deviceOwnerId` is the user whose voice-devices.json file holds the
 *   device record (i.e. the user who paired the device).
 * - `ownerUserId` in the returned assignment is the user the chat should
 *   *run as* (per-user data, agents, memory). May differ from
 *   `deviceOwnerId` when the slot is shared to another household account.
 *
 * Returns null when the slot is unassigned — caller should fall back to
 * the chat message's own agent field as the device-owner user.
 */
export function getSlotAssignment(deviceOwnerId, deviceId, slot) {
  if (typeof slot !== 'number') return null;
  const a = getConfiguredSlot(deviceOwnerId, slot);
  if (!a || typeof a.ownerUserId !== 'string') return null;
  return {
    ownerUserId: a.ownerUserId,
    agentId: typeof a.agentId === 'string' ? a.agentId : null,
    ttsVoice: typeof a.ttsVoice === 'string' ? a.ttsVoice : null,
    wakewordId: typeof a.wakewordId === 'string' ? a.wakewordId : null,
    avg_prob_cutoff: typeof a.avg_prob_cutoff === 'number' ? a.avg_prob_cutoff : null,
  };
}

/**
 * Walk every user's voice-config looking for slots whose ownerUserId
 * matches `userId`. Used by the "shared slots pointed at you" section in
 * Settings → Voice devices, so a non-admin can see whose voice-config
 * routes their account in to a household device and opt out if they want.
 */
export function findIncomingSlots(userId) {
  if (!userId) return [];
  return findUsersSharingTo(userId, {
    // Hand voice-config a per-user device fetcher so it can attach
    // device-id/name info to each matching slot for UI display.
    devicesByUser: (uid) => listDevices(uid),
  }).map(entry => ({
    ownerUserId: entry.ownerUserId,
    slot: entry.slot,
    agentId: entry.assignment.agentId ?? null,
    devices: entry.devices,
  }));
}

/**
 * Clear a specific slot assignment from a user's voice-config. Used by
 * the incoming-slots opt-out flow when a non-admin wants to stop being
 * routed-to by someone else's voice-config.
 */
export function clearSlotAssignment(deviceOwnerId, _deviceId, slot) {
  const cfg = readVoiceConfig(deviceOwnerId);
  const next = { ...cfg.slot_assignments };
  delete next[slot];
  delete next[String(slot)];
  writeVoiceConfig(deviceOwnerId, next);
  return true;
}

/**
 * Look up which device-id a given session token belongs to, by 8-char prefix.
 * Used by the WS handler to surface a recognizable name in chat-source UI and
 * by the per-device revoke flow to drop the right session.
 */
export function findDeviceByTokenPrefix(userId, prefix) {
  if (!prefix) return null;
  const d = readFile(userId).find(x => x.token_prefix === prefix);
  return d ? toWire(d) : null;
}

/**
 * Find the paired voice device (across ALL users) that a presented session token
 * belongs to, so an expired/pruned token can be auto-recovered without re-pairing.
 * Two tiers, strongest first:
 *   - hash match: token's sha256 equals a stored token_hash → cryptographically
 *     certain it's that device's token. Always preferred.
 *   - legacy prefix match: device has NO stored hash (paired before hashes
 *     existed) and the token's 8-char prefix matches. Only honored when EXACTLY
 *     one such device matches — the prefix is a server-only secret, but it's just
 *     32 bits, so we never let it override a hash and we never accept an
 *     ambiguous match. The first recovery backfills a hash (recordTokenSecret),
 *     so each legacy device uses this weak path at most once.
 * Returns { userId, device, strong } or null.
 */
export function findDeviceByTokenAnyUser(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  const hash = hashToken(token);
  const prefix = token.slice(0, 8);
  let legacy = null, legacyCount = 0;
  let dirs;
  try { dirs = fs.readdirSync(USERS_DIR, { withFileTypes: true }); } catch { return null; }
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const uid = ent.name;
    for (const d of readFile(uid)) {
      if (d.token_hash) {
        if (d.token_hash === hash) return { userId: uid, device: d, strong: true };
      } else if (d.token_prefix && d.token_prefix === prefix) {
        legacy = { userId: uid, device: d, strong: false };
        legacyCount++;
      }
    }
  }
  return (legacy && legacyCount === 1) ? legacy : null;
}

/**
 * Backfill/refresh the stored token secret (hash + prefix) for a device from the
 * token it just authenticated with. Idempotent: only writes when the hash
 * changes (first backfill, or after a re-pair mints a new token), so it's free
 * to call on every successful auth. Migrates pre-hash devices to strong
 * verification the first time they connect.
 */
export function recordTokenSecret(userId, deviceId, token) {
  if (!token || !deviceId) return;
  const devices = readFile(userId);
  const idx = devices.findIndex(x => x.id === deviceId);
  if (idx < 0) return;
  const hash = hashToken(token);
  if (devices[idx].token_hash === hash) return; // already current
  devices[idx].token_hash = hash;
  devices[idx].token_prefix = token.slice(0, 8);
  writeFile(userId, devices);
}
