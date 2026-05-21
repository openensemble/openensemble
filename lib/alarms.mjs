/**
 * Server-side alarm registry. The actual ring loop (chime + TTS + cadence)
 * lives on the device firmware as of 2026-05-21 (see project_device_side_
 * alarms_todo.md). This module is the server's view of "what alarms exist":
 *
 *   - Disk-persisted per-user registry so a restart preserves state +
 *     ack-timeout watchdog resumes.
 *   - Pre-synthesizes the announcement TTS at registerAlarm time and caches
 *     it in RAM so sendAlarmArm can hand the device a marker to fetch.
 *   - Watchdog: if the device doesn't ack alarm_fired within 120s of the
 *     trigger, sends an email/Telegram fallback so the user isn't left
 *     wondering (device probably offline).
 *   - Senders: sendAlarmArm / sendAlarmDisarm / broadcastAlarmStop push
 *     typed WS messages to the firmware.
 *   - Receive handlers: markAlarmFired / markAlarmAcked are called from
 *     ws-handler.mjs when the device sends alarm_fired / alarm_acked.
 */
import fs from 'fs';
import path from 'path';
import { synthesizeTts } from './voice-reminder.mjs';
import { sendToDevice } from '../ws-handler.mjs';
import { cacheOneShotMp3 } from '../routes/devices.mjs';
import { USERS_DIR } from './paths.mjs';

const ACK_TIMEOUT_MS   = 120 * 1000;      // 2 minutes after triggerAtMs before
                                          // declaring the device unreachable
const WATCHDOG_TICK_MS = 30 * 1000;       // watchdog scan cadence

// userId → [{ id, label, type, triggerAtMs, createdAt, firedAtMs, ackedAtMs,
//             state, deviceIds[], awaitingFireAck, ackFallbackSentAt,
//             startedAt (legacy alias for createdAt) }]
const _activeAlarms = new Map();
let _alarmIdCounter = 0;

function genAlarmId() {
  return `alarm_${Date.now()}_${++_alarmIdCounter}`;
}

// ── Disk persistence ──────────────────────────────────────────────────────────
// One file per user at users/<id>/alarms.json. Written on every mutation;
// removed when the user has zero active alarms. Read at module init so a
// restart resumes any in-flight alarms (the loop re-fires, hard-cap is still
// calculated from createdAt so an alarm 9 minutes deep into its 10-min cap
// only re-rings for one more minute).

function alarmsFile(userId) {
  return path.join(USERS_DIR, userId, 'alarms.json');
}

function _saveUserAlarms(userId) {
  const list = _activeAlarms.get(userId);
  const p = alarmsFile(userId);
  try {
    if (!list || !list.length) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return;
    }
    // Ensure user dir exists — the user record itself almost certainly exists
    // by the time an alarm fires, but mkdirSync recursive is harmless.
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(list, null, 2));
  } catch (e) {
    console.warn(`[alarms] failed to persist alarms for ${userId}: ${e.message}`);
  }
}

function _loadAllFromDisk() {
  if (!fs.existsSync(USERS_DIR)) return;
  try {
    for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(USERS_DIR, entry.name, 'alarms.json');
      if (!fs.existsSync(p)) continue;
      try {
        const list = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(list) && list.length) {
          _activeAlarms.set(entry.name, list);
          ensureWatchdog();
          console.log(`[alarms] resumed ${list.length} alarm(s) for ${entry.name} after restart`);
        }
      } catch (e) {
        console.warn(`[alarms] failed to load ${p}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`[alarms] _loadAllFromDisk failed: ${e.message}`);
  }
}

_loadAllFromDisk();

// ── Per-alarm TTS cache (RAM only) ────────────────────────────────────────────
// Server-side cache for the pre-synthesized "Your X minute alarm has gone
// off." MP3, keyed by alarmId. Synthesized once on registerAlarm; reused
// when Phase B/C ships the alarm_arm WS message so the device gets one copy
// instead of the server re-synthesizing every cycle. Lost on restart by
// design — the device already has its copy of any already-armed alarm.

const _ttsCache = new Map();  // alarmId → Buffer

export function getCachedAlarmTts(alarmId) {
  return _ttsCache.get(alarmId) ?? null;
}

function alarmAnnouncementText(label) {
  return `Your ${label} alarm has gone off.`;
}

// Synthesize and cache the announcement for an alarm. Async — fires the
// synth and returns immediately so registerAlarm doesn't block on an
// HTTPS call to OpenAI/ElevenLabs. Errors are logged, not thrown: a missing
// cache entry falls back to the existing speakOnDevices path which
// synthesizes on the fly.
function kickOffTtsSynth(alarmId, userId, label) {
  const text = alarmAnnouncementText(label);
  synthesizeTts(text, userId)
    .then(buf => {
      if (buf?.length) _ttsCache.set(alarmId, buf);
    })
    .catch(e => console.warn(`[alarms] TTS pre-synth for ${alarmId} failed: ${e.message}`));
}

// ── Device protocol (Phase B/C — server → device + device → server) ──────────
// Senders generate one-shot audio markers (device fetches the MP3 from
// /api/tts?marker=X using the existing TTS-stash pattern) and push typed
// WS messages. Receivers are wired in ws-handler.mjs and call the mark*
// functions below to update registry state.

export function sendAlarmArm(deviceId, { id, label, triggerAtMs, audioMp3, type = 'timer' }) {
  if (!deviceId || !id) return false;
  const audioMarker = audioMp3?.length ? cacheOneShotMp3(audioMp3) : null;
  return sendToDevice(deviceId, {
    type: 'alarm_arm',
    id,
    label,
    triggerAtMs,
    alarmType: type,        // not `type` to avoid colliding with WS envelope `type`
    audioMarker,
  });
}

export function sendAlarmDisarm(deviceId, { id }) {
  if (!deviceId || !id) return false;
  return sendToDevice(deviceId, { type: 'alarm_disarm', id });
}

// Broadcast a stop to every device currently holding an active alarm for
// this user. Used by the dismiss path (chat-dispatch.mjs 'stop' intent) in
// Phase C; pre-wired so the firmware side can be developed against it.
export function broadcastAlarmStop(userId, { ids = null } = {}) {
  const list = _activeAlarms.get(userId);
  if (!list || !list.length) return 0;
  const deviceIds = new Set();
  for (const a of list) for (const d of a.deviceIds) deviceIds.add(d);
  let n = 0;
  for (const d of deviceIds) {
    if (sendToDevice(d, { type: 'alarm_stop', ids })) n++;
  }
  return n;
}

// Called by ws-handler.mjs when device reports alarm_fired. Updates state
// so the A4 ack-timeout watchdog knows the device acknowledged the fire.
export function markAlarmFired(userId, alarmId) {
  const list = _activeAlarms.get(userId);
  if (!list) return false;
  const entry = list.find(a => a.id === alarmId);
  if (!entry) return false;
  entry.firedAtMs = Date.now();
  entry.state = 'firing';
  entry.awaitingFireAck = false;  // device confirmed it received the arm
  _saveUserAlarms(userId);
  return true;
}

// Called by ws-handler.mjs when device reports user-dismissed. Removes
// the alarm entirely (registry + TTS cache + on-disk record).
export function markAlarmAcked(userId, alarmId) {
  const list = _activeAlarms.get(userId);
  if (!list) return false;
  const idx = list.findIndex(a => a.id === alarmId);
  if (idx < 0) return false;
  _ttsCache.delete(alarmId);
  list.splice(idx, 1);
  if (list.length === 0) _activeAlarms.delete(userId);
  _saveUserAlarms(userId);
  return true;
}

/**
 * Register an alarm for a device-managed ring. Pre-synthesizes the
 * announcement TTS (cached for sendAlarmArm), records the entry in the
 * disk-persisted registry, and starts the ack-timeout watchdog. Caller is
 * responsible for following up with sendAlarmArm() to push to the device.
 *
 * `awaitingFireAck` defaults to false for legacy callers, but the device-
 * managed flow used by server.mjs:fireReminder always passes true so the
 * watchdog tracks whether the device confirmed it received the arm.
 *
 * `label` is the duration phrase used in the spoken announcement
 * ("5 minute", "1 hour 30 minute"). `deviceIds` is the device(s) to ring on.
 */
export function registerAlarm({
  userId,
  label,
  deviceIds,
  type = 'timer',
  triggerAtMs = null,
  awaitingFireAck = false,
}) {
  if (!userId || !label) throw new Error('registerAlarm: userId + label required');
  const now = Date.now();
  const id = genAlarmId();
  const trigger = triggerAtMs ?? now;
  // Device-managed flow: state='armed' until the device sends alarm_fired
  // (which transitions it to 'firing' via markAlarmFired). awaitingFireAck
  // controls the ack-timeout watchdog. `awaitingFireAck: false` is a legacy
  // call shape — current callers (server.mjs fireReminder) always pass true.
  const entry = {
    id,
    label,
    type,
    triggerAtMs: trigger,
    createdAt: now,
    firedAtMs: awaitingFireAck ? null : now,
    ackedAtMs: null,
    state: awaitingFireAck ? 'armed' : 'firing',
    awaitingFireAck: !!awaitingFireAck,
    ackFallbackSentAt: null,
    deviceIds: Array.isArray(deviceIds) ? deviceIds.slice() : [],
    // Legacy field — existing readers reference `startedAt` for the hard-cap
    // calculation. Kept as an alias of createdAt for back-compat.
    startedAt: now,
  };
  if (!_activeAlarms.has(userId)) _activeAlarms.set(userId, []);
  _activeAlarms.get(userId).push(entry);
  _saveUserAlarms(userId);
  // TTS pre-synth was here, used to ship a spoken announcement with each
  // alarm_arm. Chime-only behavior shipped — no synth needed on the alarm
  // path. kickOffTtsSynth + getCachedAlarmTts are kept exported for any
  // future caller that wants announcement audio.
  ensureWatchdog();
  return id;
}

export function hasActiveAlarms(userId) {
  const list = _activeAlarms.get(userId);
  return !!(list && list.length);
}

export function getActiveAlarms(userId) {
  return (_activeAlarms.get(userId) || []).slice();
}

// ── Ack-timeout watchdog ──────────────────────────────────────────────────────
// Scans armed alarms; if triggerAtMs + ACK_TIMEOUT_MS has passed and the
// device never reported alarm_fired, sends a fallback notification (email +
// Telegram) so the user isn't left wondering. `ackFallbackSentAt` is set so
// we only nag once per alarm, even across server restarts.
let _watchdogTimer = null;

function ensureWatchdog() {
  if (_watchdogTimer) return;
  _watchdogTimer = setInterval(_watchdogTick, WATCHDOG_TICK_MS);
  if (_watchdogTimer.unref) _watchdogTimer.unref();
}

function _watchdogTick() {
  const now = Date.now();
  for (const [userId, list] of _activeAlarms) {
    for (const entry of list) {
      if (!entry.awaitingFireAck) continue;
      if (entry.ackFallbackSentAt) continue;
      if (now - entry.triggerAtMs < ACK_TIMEOUT_MS) continue;
      entry.ackFallbackSentAt = now;
      _saveUserAlarms(userId);
      sendDeviceOfflineFallback(userId, entry).catch(e =>
        console.warn(`[alarms] ack-timeout fallback for ${entry.id} failed: ${e.message}`)
      );
    }
  }
}

async function sendDeviceOfflineFallback(userId, entry) {
  const { sendUserNotification } = await import('./user-notify.mjs');
  const time = new Date(entry.triggerAtMs).toLocaleString();
  const res = await sendUserNotification(userId, {
    subject: `Alarm not acknowledged: ${entry.label}`,
    body: `Your ${entry.label} alarm was scheduled to fire at ${time} but the voice device didn't acknowledge it. The device may be offline.`,
  });
  console.log(`[alarms] ack-timeout fallback for ${entry.id} (user=${userId}) telegram=${res.telegram} email=${res.email}`);
}

