/**
 * Per-user voice configuration: the single source of truth for which OE
 * user each wake-word slot routes to on this user's voice devices. ONE
 * config per OE-install user; every voice device paired to that user
 * inherits it. No per-device slot config — that lived on the device
 * record up through 2026-05-13 and got pulled out so a household with
 * multiple voice devices (kitchen + bedroom etc.) configures slots once.
 *
 * Schema: users/<userId>/voice-config.json
 *   {
 *     "version": <integer, bumped on every save>,
 *     "updated_at": <epoch ms>,
 *     "slot_assignments": {
 *       "<slot index 0..5>": {
 *         "ownerUserId": <OE user id; required>,
 *         "ttsVoice":    <string|null>,
 *         "wakewordId":  <"ww_<hex>"|"stock_<slug>"|null>,
 *         "agentId":     <string|null — reserved, UI no longer sets it>
 *       }
 *     }
 *   }
 *
 * Routing flow at wake time (lib/voice-devices.mjs#getSlotAssignment):
 *   1. WS auth'd voice-device fires wake_slot=N for chat msg
 *   2. Server looks up the device's paired user → that user's voice-config
 *   3. slot_assignments[N] resolves to { ownerUserId, agentId, ttsVoice, wakewordId }
 *   4. Chat dispatches as ownerUserId (which may differ from paired-user for
 *      cross-user household sharing — e.g. shawn's device routes "Hey Wife"
 *      to wife's account, but wife's coordinator agent is what answers)
 *
 * Push flow (auto):
 *   - On config PUT: routes/voice-config.mjs walks every online device paired
 *     to this user and pushes the wake-word .tflite+.json for each slot.
 *   - On WS connect: ws-handler.mjs pushes the current voice-config to the
 *     newly-connected device. Tracked via the device's voice_config_version
 *     so we don't re-push on every reconnect.
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { readLibraryWakeword } from './wakeword-library.mjs';
import { sendToDevice } from '../ws-handler.mjs';

function configPath(userId) {
  return path.join(USERS_DIR, userId, 'voice-config.json');
}

const EMPTY = Object.freeze({ version: 0, updated_at: 0, slot_assignments: {} });

export function readVoiceConfig(userId) {
  const p = configPath(userId);
  if (!fs.existsSync(p)) return { ...EMPTY };
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      version: Number.isInteger(obj.version) ? obj.version : 0,
      updated_at: Number.isInteger(obj.updated_at) ? obj.updated_at : 0,
      slot_assignments: obj.slot_assignments && typeof obj.slot_assignments === 'object' ? obj.slot_assignments : {},
    };
  } catch (e) {
    console.warn(`[voice-config] read failed for ${userId}: ${e.message}`);
    return { ...EMPTY };
  }
}

/**
 * Validate + persist a voice-config. Drops any slot whose ownerUserId
 * doesn't pass the caller-supplied user-exists check (caller passes in
 * a function so we don't depend on a heavy users module here). Returns
 * the saved config including its new version.
 */
export function writeVoiceConfig(userId, slot_assignments, { userExists = () => true } = {}) {
  const prev = readVoiceConfig(userId);
  const clean = {};
  // Cap at slot 0..5 to match firmware WW_NUM_SLOTS=6. Server-side
  // accepting higher indexes would silently route to a slot the device
  // can't fire, which is a bad failure mode.
  for (const [slotKey, a] of Object.entries(slot_assignments || {})) {
    const n = Number(slotKey);
    if (!Number.isInteger(n) || n < 0 || n > 5) continue;
    if (!a || typeof a !== 'object') continue;
    const ownerUserId = typeof a.ownerUserId === 'string' ? a.ownerUserId.slice(0, 64) : null;
    if (!ownerUserId || !userExists(ownerUserId)) continue;
    const agentId   = typeof a.agentId   === 'string' ? a.agentId.slice(0, 64)   : null;
    const ttsVoice  = typeof a.ttsVoice  === 'string' ? a.ttsVoice.slice(0, 32)  : null;
    // Wake-word id: same dual-form validation as lib/voice-devices.mjs —
    // accept either a user-uploaded library id or a stock-library id.
    const wwRaw = typeof a.wakewordId === 'string' ? a.wakewordId : null;
    const wakewordId = wwRaw && (/^ww_[a-f0-9]+$/.test(wwRaw) || /^stock_[a-z0-9_]+$/.test(wwRaw)) ? wwRaw : null;
    clean[n] = { ownerUserId, agentId, ttsVoice, wakewordId };
  }
  // If the cleaned assignments are identical to what's already on disk,
  // don't bump the version or rewrite the file. Stops idle re-PUTs (UI
  // re-saves, CLI scripts) from triggering wake-word OTA fan-outs to
  // every device. JSON.stringify is fine here — both sides go through
  // the same key cleanup so order is consistent.
  if (JSON.stringify(prev.slot_assignments) === JSON.stringify(clean)) {
    return prev;
  }
  const next = {
    version: prev.version + 1,
    updated_at: Date.now(),
    slot_assignments: clean,
  };
  const p = configPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(next, null, 2));
  return next;
}

/**
 * Resolve a single slot to its assignment, or null if unassigned. Used by
 * the wake-word dispatcher to find the routing target for an incoming
 * wake event from a voice device.
 */
export function getConfiguredSlot(userId, slot) {
  if (!Number.isInteger(slot)) return null;
  const cfg = readVoiceConfig(userId);
  return cfg.slot_assignments[slot] ?? cfg.slot_assignments[String(slot)] ?? null;
}

/**
 * Walk every user's voice-config, find slots whose ownerUserId matches
 * the queried user. Powers "Shared with you" UI so a non-admin can see
 * what's routing to their account on other people's devices. Replaces
 * the pre-2026-05-13 per-device findIncomingSlots that walked devices.
 */
// Pending ww_upload acks. Keyed by `${deviceId}:${slot}` → { resolve, timer }.
// pushConfigToDevice registers a pending entry before sending each slot and
// awaits its resolution before sending the next; handleWwUploadAck (called by
// ws-handler when the device replies) resolves it. Per-slot timeout below.
// Each slot's resolve receives { ok, err } so the caller can distinguish a
// real failure from a no-reply timeout.
const PENDING_ACKS = new Map();
const WW_ACK_TIMEOUT_MS = 15000;

function ackKey(deviceId, slot) { return `${deviceId}:${slot}`; }

/**
 * Called by ws-handler.mjs when a `{type:'ww_upload_ack', slot, ok, err?}`
 * message arrives from a voice device. Resolves the corresponding pending
 * promise so pushConfigToDevice can send the next slot.
 */
export function handleWwUploadAck(deviceId, slot, ok, err) {
  const k = ackKey(deviceId, slot);
  const entry = PENDING_ACKS.get(k);
  if (!entry) return false;
  PENDING_ACKS.delete(k);
  clearTimeout(entry.timer);
  entry.resolve({ ok: !!ok, err: typeof err === 'string' ? err : null });
  return true;
}

/**
 * Push the wake-word .tflite+.json for every populated slot of `ownerUserId`'s
 * voice-config to one device, ONE SLOT AT A TIME, awaiting the device's
 * ww_upload_ack between sends. Sequential because back-to-back ~85KB JSON
 * frames overran the firmware's WS recv path and killed the socket; the
 * device's ack is the throttle.
 *
 * Returns { pushedSlots, ackedSlots, failedSlots, offlineSlots, version }:
 *  - pushedSlots:  every slot we attempted to send
 *  - ackedSlots:   subset that the device acked ok=true
 *  - failedSlots:  subset that the device acked ok=false (with reason logged)
 *  - offlineSlots: subset where send returned 0 or ack timed out (no reply)
 *
 * `ownerUserId` is the OE user that owns the device (paired user). User-
 * library wake-word ids are scoped to that user; stock ids resolve globally.
 */
export async function pushConfigToDevice(deviceId, ownerUserId) {
  const cfg = readVoiceConfig(ownerUserId);
  const pushedSlots = [];
  const ackedSlots = [];
  const failedSlots = [];
  const offlineSlots = [];
  for (const [slotKey, a] of Object.entries(cfg.slot_assignments || {})) {
    if (!a?.wakewordId) continue;
    const slot = Number(slotKey);
    const ww = readLibraryWakeword(ownerUserId, a.wakewordId);
    if (!ww) {
      console.warn(`[voice-config] slot ${slot} wakeword ${a.wakewordId} not found for ${ownerUserId}`);
      continue;
    }

    // Register the pending ack BEFORE sending — otherwise a very-fast device
    // could ack before we've installed the resolver and we'd miss the reply.
    const k = ackKey(deviceId, slot);
    const ackPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        PENDING_ACKS.delete(k);
        resolve({ ok: false, err: 'timeout' });
      }, WW_ACK_TIMEOUT_MS);
      PENDING_ACKS.set(k, { resolve, timer });
    });

    const sent = sendToDevice(deviceId, {
      type: 'ww_upload',
      slot,
      tflite_b64: ww.tflite.toString('base64'),
      manifest: ww.manifestJson,
    });
    pushedSlots.push(slot);

    if (sent === 0) {
      // Device went offline between auth and our send — clear the pending
      // promise immediately rather than waiting 15s for it to time out.
      const entry = PENDING_ACKS.get(k);
      if (entry) { clearTimeout(entry.timer); PENDING_ACKS.delete(k); entry.resolve({ ok: false, err: 'offline' }); }
      offlineSlots.push(slot);
      // Bail on remaining slots; nothing to ack against. Caller decides
      // whether to retry on next reconnect.
      break;
    }

    const result = await ackPromise;
    if (result.ok) {
      ackedSlots.push(slot);
    } else if (result.err === 'timeout' || result.err === 'offline') {
      offlineSlots.push(slot);
      // Likely the device dropped — don't keep firing slots into a dead socket.
      break;
    } else {
      failedSlots.push({ slot, err: result.err });
      // Device is alive (it acked), just couldn't land this slot. Continue
      // with the next so a single bad slot doesn't block the rest.
    }
  }
  return { pushedSlots, ackedSlots, failedSlots, offlineSlots, version: cfg.version };
}

export function findUsersSharingTo(targetUserId, { devicesByUser } = {}) {
  if (!fs.existsSync(USERS_DIR)) return [];
  const out = [];
  for (const userDir of fs.readdirSync(USERS_DIR)) {
    if (userDir === targetUserId) continue;   // own config doesn't count as "shared"
    if (userDir.startsWith('_')) continue;     // _system, etc.
    const cfg = readVoiceConfig(userDir);
    for (const [slotKey, a] of Object.entries(cfg.slot_assignments || {})) {
      if (a?.ownerUserId === targetUserId) {
        const slot = Number(slotKey);
        const devices = (devicesByUser?.(userDir) ?? []).map(d => ({ id: d.id, name: d.name }));
        out.push({ slot, ownerUserId: userDir, devices, assignment: a });
      }
    }
  }
  return out;
}
