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
 *         "agentId":     <string|null — reserved, UI no longer sets it>,
 *         "probability_cutoff": <float 0.5..0.99 | null — per-slot override
 *                                of the wake-word manifest's default cutoff;
 *                                pushed to the device, compared against the
 *                                model's per-frame peak probability>,
 *         "avg_prob_cutoff":    <float 0.5..0.99 | null — server-side gate
 *                                on the firmware's reported sliding-window
 *                                avg probability (msg.wake_avg_prob/255).
 *                                Drops wakes whose avg falls below this
 *                                even when the peak passed the firmware
 *                                cutoff — useful for filtering TTS-playback
 *                                cross-fires that spike one frame then dip>
 *       }
 *     }
 *   }
 *
 * Routing flow at wake time (lib/voice-devices.mjs#getSlotAssignment):
 *   1. WS auth'd voice-device fires wake_slot=N for chat msg
 *   2. Server looks up the device's paired user → that user's voice-config
 *   3. slot_assignments[N] resolves to { ownerUserId, agentId, ttsVoice, wakewordId }
 *   4. Chat dispatches as ownerUserId (which may differ from paired-user for
 *      cross-user household sharing — e.g. one user's device routes "Hey Roommate"
 *      to the roommate's account, but the roommate's coordinator agent is what answers)
 *
 * Push flow:
 *   - POST /api/voice-config/push walks every online device paired to this user
 *     and pushes the wake-word .tflite+.json for each slot.
 *   - On WS connect: ws-handler.mjs pushes only when the device's tracked
 *     voice_config_version is stale, so reconnects don't rewrite slots.
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { readLibraryWakeword } from './wakeword-library.mjs';
import { sendToDevice } from '../ws-handler.mjs';

// Mirror of the firmware's `#define WW_NUM_SLOTS` (main/main.c). The device
// loads slot files /ww/slot0..slot5 at boot; any slot in this range that the
// voice-config doesn't populate must be explicitly cleared on the device, or
// a stale wake word lingers in SPIFFS and keeps firing. Keep in lockstep with
// the firmware constant and the 0..5 cap in writeVoiceConfig.
const WW_NUM_SLOTS = 6;

function configPath(userId) {
  return path.join(USERS_DIR, userId, 'voice-config.json');
}

const EMPTY = Object.freeze({ version: 0, updated_at: 0, slot_assignments: {} });

// mtime-keyed parse cache. readVoiceConfig sits on the wake→dispatch hot path
// (getSlotAssignment) and was a fresh readFileSync+parse on every call, ≥2×
// per voice turn. Callers treat the result as read-only; writeVoiceConfig
// refreshes the entry after persisting.
const _configCache = new Map(); // userId -> { mtimeMs, cfg }

export function readVoiceConfig(userId) {
  const p = configPath(userId);
  let mtimeMs;
  try { mtimeMs = fs.statSync(p).mtimeMs; }
  catch { _configCache.delete(userId); return { ...EMPTY }; }
  const hit = _configCache.get(userId);
  if (hit && hit.mtimeMs === mtimeMs) return hit.cfg;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cfg = {
      version: Number.isInteger(obj.version) ? obj.version : 0,
      updated_at: Number.isInteger(obj.updated_at) ? obj.updated_at : 0,
      slot_assignments: obj.slot_assignments && typeof obj.slot_assignments === 'object' ? obj.slot_assignments : {},
    };
    _configCache.set(userId, { mtimeMs, cfg });
    return cfg;
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
    // 64 chars accommodates Piper voice ids like "en_GB-southern_english_female-low"
    // (33 chars on its own) plus a ":<speaker_id>" suffix for multi-speaker voices.
    const ttsVoice  = typeof a.ttsVoice  === 'string' ? a.ttsVoice.slice(0, 64)  : null;
    // Wake-word id: same dual-form validation as lib/voice-devices.mjs —
    // accept either a user-uploaded library id or a stock-library id.
    const wwRaw = typeof a.wakewordId === 'string' ? a.wakewordId : null;
    const wakewordId = wwRaw && (/^ww_[a-f0-9]+$/.test(wwRaw) || /^stock_[a-z0-9_]+$/.test(wwRaw)) ? wwRaw : null;
    // Per-slot cutoff override. Float in [0.5, 0.99]. Values outside the
    // range are dropped (clamping would silently hide a bad UI value).
    let probability_cutoff = null;
    if (typeof a.probability_cutoff === 'number' && Number.isFinite(a.probability_cutoff)
        && a.probability_cutoff >= 0.5 && a.probability_cutoff <= 0.99) {
      probability_cutoff = Math.round(a.probability_cutoff * 100) / 100;
    }
    // Server-only gate: drops a wake when the firmware-reported avg
    // probability (rolling window) is below this. Validated to the same
    // [0.5, 0.99] range — null = no avg gate.
    let avg_prob_cutoff = null;
    if (typeof a.avg_prob_cutoff === 'number' && Number.isFinite(a.avg_prob_cutoff)
        && a.avg_prob_cutoff >= 0.5 && a.avg_prob_cutoff <= 0.99) {
      avg_prob_cutoff = Math.round(a.avg_prob_cutoff * 100) / 100;
    }
    clean[n] = { ownerUserId, agentId, ttsVoice, wakewordId, probability_cutoff, avg_prob_cutoff };
  }
  // Repack to contiguous slot indices 0..N-1 in ascending order. A device
  // loads wake words BY slot index, so the slots ARE the user list in order;
  // a gap (e.g. a user removed by an older client that just deleted the slot
  // instead of repacking, or any hand-edited/CLI config) would otherwise push
  // wake words to slot 0 + slot 2 and leave slot 1 dead — exactly the "loaded
  // slot 0 and slot 2 when it should be 0 and 1" symptom. Normalizing here is
  // the server-side guarantee that the stored config, the OTA push, and
  // wake-time routing (getConfiguredSlot reads the same indices) all agree.
  // The UI repacks too; this backstops every other write path.
  const packed = {};
  Object.keys(clean)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((oldSlot, i) => { packed[i] = clean[oldSlot]; });
  // If the repacked assignments are identical to what's already on disk,
  // don't bump the version or rewrite the file. Stops idle re-PUTs (UI
  // re-saves, CLI scripts) from triggering wake-word OTA fan-outs to
  // every device. JSON.stringify is fine here — both sides go through
  // the same key cleanup + repack so order is consistent.
  if (JSON.stringify(prev.slot_assignments) === JSON.stringify(packed)) {
    return prev;
  }
  const next = {
    version: prev.version + 1,
    updated_at: Date.now(),
    slot_assignments: packed,
  };
  const p = configPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(next, null, 2));
  // Refresh the read cache immediately — the mtime check would also catch it,
  // but same-millisecond write-then-read is a real pattern in tests.
  try { _configCache.set(userId, { mtimeMs: fs.statSync(p).mtimeMs, cfg: next }); }
  catch { _configCache.delete(userId); }
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

// The ww_clear WS command landed in firmware 0.2.48-slotclear. Older firmware
// has no handler for it: the message falls through the type dispatch and is
// silently dropped WITHOUT a ww_upload_ack, so the server's per-slot ack wait
// would time out (15s) on every clear and falsely mark the device offline.
// Gate the clear pass on the device's reported version so we only send clears
// to firmware that will ack them. fw_version looks like "0.2.48-slotclear" —
// compare the numeric x.y.z prefix as a tuple. Unknown/unparseable → false.
const FW_CLEAR_MIN = [0, 2, 48];
function fwSupportsClear(fwVersion) {
  if (typeof fwVersion !== 'string') return false;
  const m = fwVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const cur = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (cur[i] > FW_CLEAR_MIN[i]) return true;
    if (cur[i] < FW_CLEAR_MIN[i]) return false;
  }
  return true; // exactly equal
}

/**
 * Called by ws-handler.mjs when a `{type:'ww_upload_ack', slot, ok, err?}`
 * message arrives from a voice device. Resolves the corresponding pending
 * promise so pushConfigToDevice can send the next slot.
 */
export function handleWwUploadAck(deviceId, slot, ok, err) {
  let k = ackKey(deviceId, slot);
  let entry = PENDING_ACKS.get(k);
  if (!entry && slot === -1) {
    for (const [candidate, pending] of PENDING_ACKS) {
      if (candidate.startsWith(`${deviceId}:`)) {
        k = candidate;
        entry = pending;
        break;
      }
    }
  }
  if (!entry) return false;
  PENDING_ACKS.delete(k);
  clearTimeout(entry.timer);
  entry.resolve({ ok: !!ok, err: typeof err === 'string' ? err : null });
  return true;
}

/**
 * Send one slot-scoped WS message (ww_upload or ww_clear) and await the
 * device's ww_upload_ack for that slot. Shared by the push and clear passes
 * so both go through the same {deviceId, slot} pending-ack throttle. Returns
 * { ok, err }: err is 'offline' (send hit no socket), 'timeout' (no reply in
 * WW_ACK_TIMEOUT_MS), a device-reported reason, or null on success.
 *
 * The pending entry is registered BEFORE the send — a very-fast device could
 * otherwise ack before the resolver is installed and we'd miss the reply.
 */
function sendSlotMessageAwaitAck(deviceId, slot, msg) {
  const k = ackKey(deviceId, slot);
  const ackPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      PENDING_ACKS.delete(k);
      resolve({ ok: false, err: 'timeout' });
    }, WW_ACK_TIMEOUT_MS);
    PENDING_ACKS.set(k, { resolve, timer });
  });
  const sent = sendToDevice(deviceId, msg);
  if (sent === 0) {
    // No socket — resolve immediately instead of waiting out the 15s timeout.
    const entry = PENDING_ACKS.get(k);
    if (entry) { clearTimeout(entry.timer); PENDING_ACKS.delete(k); entry.resolve({ ok: false, err: 'offline' }); }
  }
  return ackPromise;
}

/**
 * Bring one device's wake-word slots fully in sync with `ownerUserId`'s
 * voice-config, ONE SLOT AT A TIME, awaiting the device's ww_upload_ack
 * between sends. Sequential because back-to-back ~85KB JSON frames overran
 * the firmware's WS recv path and killed the socket; the device's ack is the
 * throttle.
 *
 * Two passes:
 *   1. PUSH — for every slot the config assigns a (resolvable) wake word to,
 *      send ww_upload with the tflite + manifest.
 *   2. CLEAR — for every slot index in [0, WW_NUM_SLOTS) the config does NOT
 *      assign a wake word to, send ww_clear so the device deletes any stale
 *      slot file from SPIFFS and unloads the live detector. This is what makes
 *      removing a user actually stop their wake word firing: the remaining
 *      users repack into lower slots (pushed above) and the orphaned tail slot
 *      gets wiped here. Idempotent — clearing an already-empty slot is a no-op
 *      on the device, so this self-heals a device whose NVS/SPIFFS drifted.
 *
 * Returns { pushedSlots, ackedSlots, failedSlots, offlineSlots, clearedSlots,
 *           version, budgetError }:
 *  - pushedSlots:  every slot we attempted a ww_upload for
 *  - ackedSlots:   subset of pushes the device acked ok=true
 *  - failedSlots:  subset of pushes the device acked ok=false (reason logged)
 *  - offlineSlots: pushes where send returned 0 or ack timed out (no reply)
 *  - clearedSlots: slots the device acked a ww_clear ok=true
 *  - budgetError:  non-null when the push was refused up front because the
 *                  assigned wake words exceed the device's 512 KB SPIFFS
 *                  wake-word partition (all planned slots are then also
 *                  listed in failedSlots with err 'partition budget')
 *
 * `ownerUserId` is the OE user that owns the device (paired user). User-
 * library wake-word ids are scoped to that user; stock ids resolve globally.
 *
 * `opts.fwVersion` is the device's reported firmware version. The clear pass
 * only runs on firmware that knows ww_clear (>= 0.2.48); older devices skip it
 * (they'd never ack a clear, hanging the per-slot wait). They get clears once
 * they OTA up and report the new version on reconnect.
 */
// Serialize pushes per device: PENDING_ACKS is keyed {deviceId, slot}, so two
// concurrent pushes for one device cross-resolved each other's acks (push A's
// resolver consumed push B's ww_upload_ack and vice versa). A per-device
// promise chain makes the second push wait for the first.
const _pushChains = new Map(); // deviceId → tail promise
export async function pushConfigToDevice(deviceId, ownerUserId, opts = {}) {
  const prev = _pushChains.get(deviceId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => _pushConfigToDeviceInner(deviceId, ownerUserId, opts));
  _pushChains.set(deviceId, run);
  try { return await run; }
  finally { if (_pushChains.get(deviceId) === run) _pushChains.delete(deviceId); }
}

async function _pushConfigToDeviceInner(deviceId, ownerUserId, { fwVersion = null } = {}) {
  const cfg = readVoiceConfig(ownerUserId);
  const pushedSlots = [];
  const ackedSlots = [];
  const failedSlots = [];
  const offlineSlots = [];
  const clearedSlots = [];
  // Slots the config wants a wake word in — the clear pass skips these even if
  // their push failed (the slot is still SUPPOSED to hold that word; wiping it
  // on a transient failure would be wrong). Built from the config, not from
  // ack success.
  const assignedWithWw = new Set();
  for (const [slotKey, a] of Object.entries(cfg.slot_assignments || {})) {
    if (a?.wakewordId) assignedWithWw.add(Number(slotKey));
  }

  // ── Resolve every assigned slot up front ─────────────────────────────────
  // Needed so the partition-budget check below can see the TOTAL byte load
  // before anything is sent.
  const slotPlans = [];
  for (const [slotKey, a] of Object.entries(cfg.slot_assignments || {})) {
    if (!a?.wakewordId) continue;
    const slot = Number(slotKey);
    const ww = readLibraryWakeword(ownerUserId, a.wakewordId);
    if (!ww) {
      console.warn(`[voice-config] slot ${slot} wakeword ${a.wakewordId} not found for ${ownerUserId}`);
      // Unresolvable: leave the device's slot as-is (don't clear it below).
      continue;
    }
    // Apply per-slot cutoff override by mutating the manifest JSON in
    // memory before send — the device's wakeword.cpp reads probability_cutoff
    // from micro{} at slot load time, so the on-disk stock manifest stays
    // untouched and reverts cleanly when the override is cleared.
    let manifestJson = ww.manifestJson;
    if (typeof a.probability_cutoff === 'number') {
      try {
        const m = JSON.parse(manifestJson);
        m.micro = m.micro || {};
        m.micro.probability_cutoff = a.probability_cutoff;
        manifestJson = JSON.stringify(m);
      } catch (e) {
        console.warn(`[voice-config] slot ${slot} cutoff override skipped: bad manifest JSON (${e.message})`);
      }
    }
    slotPlans.push({ slot, tflite: ww.tflite, manifestJson });
  }

  // ── SPIFFS partition budget guard ─────────────────────────────────────────
  // The device stores slot{N}.tflite + slot{N}.json in a 512 KB SPIFFS
  // partition (firmware partitions.csv, `wakewords`). Measured with esp-idf
  // spiffsgen.py at the firmware's geometry (2026-07-06): 459,364 B of slot
  // files fit, 476,034 B did not — e.g. six ~79 KB v2 models overflow, five
  // fit. Overflow is expensive on-device: the firmware's ww_upload handler
  // unlinks the OLD slot file before writing the new one, so a failed write
  // leaves that slot EMPTY (previous wake word lost). Refuse the whole push
  // up front instead of letting the device find out.
  const WW_SPIFFS_BUDGET_BYTES = 460_000;
  const totalBytes = slotPlans.reduce(
    (n, p) => n + p.tflite.length + Buffer.byteLength(p.manifestJson), 0);
  if (totalBytes > WW_SPIFFS_BUDGET_BYTES) {
    const perSlot = slotPlans
      .map(p => `slot ${p.slot}: ${Math.round((p.tflite.length + Buffer.byteLength(p.manifestJson)) / 1024)} KB`)
      .join(', ');
    const budgetError =
      `assigned wake words total ${Math.round(totalBytes / 1024)} KB — over the device's ` +
      `${Math.round(WW_SPIFFS_BUDGET_BYTES / 1024)} KB wake-word storage budget (${perSlot}). ` +
      `Unassign a wake word or use smaller models.`;
    console.warn(`[voice-config] push to ${deviceId} refused: ${budgetError}`);
    // Mark every planned slot failed so no caller reads this as a clean sync
    // (ws-handler's fullySucceeded checks failedSlots).
    for (const p of slotPlans) {
      pushedSlots.push(p.slot);
      failedSlots.push({ slot: p.slot, err: 'partition budget' });
    }
    return { pushedSlots, ackedSlots, failedSlots, offlineSlots, clearedSlots, version: cfg.version, budgetError };
  }

  // ── Pass 1: push populated slots ──────────────────────────────────────────
  let deviceGone = false;
  for (const { slot, tflite, manifestJson } of slotPlans) {
    const result = await sendSlotMessageAwaitAck(deviceId, slot, {
      type: 'ww_upload',
      slot,
      tflite_b64: tflite.toString('base64'),
      manifest: manifestJson,
    });
    pushedSlots.push(slot);

    if (result.ok) {
      ackedSlots.push(slot);
    } else if (result.err === 'timeout' || result.err === 'offline') {
      offlineSlots.push(slot);
      // Likely the device dropped — don't keep firing slots into a dead socket.
      deviceGone = true;
      break;
    } else {
      failedSlots.push({ slot, err: result.err });
      // Device is alive (it acked), just couldn't land this slot. Continue
      // with the next so a single bad slot doesn't block the rest.
    }
  }

  // ── Pass 2: clear every unassigned slot ───────────────────────────────────
  // Skip if the device dropped mid-push (clears would hit a dead socket; the
  // next reconnect re-runs the whole sync) or if its firmware predates the
  // ww_clear command (it would never ack — see fwSupportsClear).
  if (!deviceGone && fwSupportsClear(fwVersion)) {
    for (let slot = 0; slot < WW_NUM_SLOTS; slot++) {
      if (assignedWithWw.has(slot)) continue;
      const result = await sendSlotMessageAwaitAck(deviceId, slot, { type: 'ww_clear', slot });
      if (result.ok) {
        clearedSlots.push(slot);
      } else if (result.err === 'timeout' || result.err === 'offline') {
        offlineSlots.push(slot);
        break;   // device dropped — stop hammering a dead socket
      } else {
        failedSlots.push({ slot, err: result.err });
      }
    }
  }

  // `assignments` is the exact slot→owner map the device just loaded (this
  // push's cfg). The caller stores it as the device's pushed snapshot so
  // wake-time routing follows the device's actually-loaded models, not a
  // later save-without-push that repacked the live config (see
  // markVoiceConfigPushed / getSlotAssignment in lib/voice-devices.mjs).
  return { pushedSlots, ackedSlots, failedSlots, offlineSlots, clearedSlots, version: cfg.version, assignments: cfg.slot_assignments, budgetError: null };
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
