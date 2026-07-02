/**
 * Voice-device offline alerting.
 *
 * A voice device that drops off Wi-Fi fails silently: the WS heartbeat reaps
 * the socket server-side, the device stops answering wakes, and nobody finds
 * out until someone talks at it or opens Settings → Voice devices (observed
 * 2026-07-02: both devices dark for hours overnight with zero signal).
 *
 * This monitor ticks once a minute, tracks per-device online state via the
 * live WS client set (isDeviceOnline — the same source of truth as the UI
 * indicator), and notifies the owner through their configured channels
 * (Telegram + email, lib/user-notify.mjs) when a device has been offline
 * past the threshold. One alert per offline episode, plus a recovery note
 * when the device comes back so the episode has closure.
 *
 * Restart-storm guard: a device is only eligible for alerts after it has
 * been seen online at least once since server boot. Otherwise every server
 * restart while a device is deliberately unplugged would fire a fresh alert.
 *
 * Config (config.json):
 *   voiceDeviceOfflineAlertMin — minutes offline before alerting.
 *                                Default 10; set 0/false to disable.
 */
import { loadUsers, loadConfig } from '../routes/_helpers.mjs';
import { listDevices } from './voice-devices.mjs';
import { isDeviceOnline } from '../ws-handler.mjs';
import { sendUserNotification } from './user-notify.mjs';
import { log } from '../logger.mjs';

const TICK_MS = 60_000;
const DEFAULT_OFFLINE_ALERT_MIN = 10;

// deviceId -> { seenOnline, offlineSince, alerted }
const _state = new Map();
let _timer = null;

export function startVoiceDeviceMonitor() {
  if (_timer) return;
  _timer = setInterval(() => { _tick().catch(e => console.warn('[voice-monitor] tick failed:', e.message)); }, TICK_MS);
  if (_timer.unref) _timer.unref();
  console.log('[voice-monitor] offline alerting started (threshold default ' + DEFAULT_OFFLINE_ALERT_MIN + ' min)');
}

export function stopVoiceDeviceMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function thresholdMs() {
  let raw;
  try { raw = loadConfig().voiceDeviceOfflineAlertMin; } catch { raw = undefined; }
  if (raw === 0 || raw === false) return null; // disabled
  return (Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OFFLINE_ALERT_MIN) * 60_000;
}

async function _tick() {
  const threshold = thresholdMs();
  if (threshold === null) return;

  let users;
  try { users = loadUsers(); } catch { return; }

  for (const user of users) {
    let devices;
    try { devices = listDevices(user.id); } catch { continue; }
    for (const dev of devices) {
      let st = _state.get(dev.id);
      if (!st) { st = { seenOnline: false, offlineSince: null, alerted: false }; _state.set(dev.id, st); }

      if (isDeviceOnline(dev.id)) {
        if (st.alerted) {
          const mins = Math.max(1, Math.round((Date.now() - st.offlineSince) / 60_000));
          log.info('voice-monitor', 'device recovered', { userId: user.id, deviceId: dev.id, name: dev.name, offlineMins: mins });
          await notify(user.id, {
            subject: `Voice device back online: ${dev.name}`,
            body: `"${dev.name}" reconnected after roughly ${mins} minute(s) offline.`,
          });
        }
        st.seenOnline = true;
        st.offlineSince = null;
        st.alerted = false;
        continue;
      }

      if (!st.seenOnline) continue; // never online this boot — no baseline, no alert
      if (st.offlineSince === null) { st.offlineSince = Date.now(); continue; }
      if (st.alerted || Date.now() - st.offlineSince < threshold) continue;

      st.alerted = true;
      const mins = Math.round(threshold / 60_000);
      const lastSeen = dev.last_seen ? new Date(dev.last_seen).toISOString() : 'unknown';
      log.warn('voice-monitor', 'device offline past threshold', { userId: user.id, deviceId: dev.id, name: dev.name, thresholdMins: mins, lastSeen });
      await notify(user.id, {
        subject: `Voice device offline: ${dev.name}`,
        body: `"${dev.name}" has been unreachable for over ${mins} minute(s) (last seen ${lastSeen}). ` +
              `It reconnects on its own once power and Wi-Fi are back — check those if this is unexpected. ` +
              `You'll get a follow-up when it's back online.`,
      });
    }
  }
}

async function notify(userId, { subject, body }) {
  try {
    const res = await sendUserNotification(userId, { subject, body });
    if (!res.telegram && !res.email) {
      // Best-effort by design, but a silent no-channel drop would defeat the
      // whole point of the monitor — leave a visible trail in app.log.
      log.warn('voice-monitor', 'no notification channel delivered', { userId, subject });
    }
  } catch (e) {
    console.warn(`[voice-monitor] notify failed for ${userId}: ${e.message}`);
  }
}
