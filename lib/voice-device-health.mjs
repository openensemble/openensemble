/**
 * Voice-device health loop — catches "online but broken".
 *
 * The offline monitor (voice-device-monitor.mjs) covers *gone*; this covers
 * the failure classes where the device keeps heartbeating but can't do its
 * job — both debugged by hand before this existed:
 *
 *  - Deaf device: fw 0.2.60 tore down the I²S RX channel on playback, so the
 *    device answered pings forever but never heard another wake word. Since
 *    fw 0.2.61 every [hb] line carries cap_sps= (16 kHz mono samples/sec
 *    entering the capture ringbuffer; ~16000 = mic alive, 0 = dead). The
 *    counter increments inside audio_io's capture task, below the mute
 *    button's gates (mute drops wake processing + TTS, not the I²S read),
 *    so a zero is a real capture-path failure, not a muted user.
 *  - Reboot storm: the 2026-06-22 ambient re-push loop (SPIFFS GC + model
 *    rebuild + esp_restart on every reconnect) kept a device dark overnight.
 *    [boot] lines betray this class directly, reset reason included.
 *
 * Feed: the UDP diag sink (voice-udplog.mjs) hands every datagram to
 * recordDeviceDiag(ip, line). Everything is event-driven off those lines —
 * no timers. Storm recovery rides the [hb] tick counter (one tick = 10 s of
 * uptime), so "it stayed up" needs no clock of its own.
 *
 * Self-heal: when firmware grows a WS `reboot` command (REBOOT_FW_MIN), a
 * dead mic gets one automatic reboot before anyone is notified; the owner
 * only hears about it if the reboot didn't fix it. No current firmware has
 * the command, so today every confirmed episode notifies with plain-language
 * guidance (power-cycle). The hook activates by fw_version gate alone —
 * no server change needed when the firmware release lands.
 *
 * Attribution: UDP datagrams only carry the sender's LAN IP. We resolve
 * IP → device via the live WS client set, and keep a sticky binding so
 * [boot] lines still attribute mid-storm while the WS is down (a crash-
 * looping device is offline for most of its own storm).
 *
 * Config (config.json):
 *   voiceDeviceHealthAlerts — set false to disable notifications
 *                             (detection + logging still run).
 *
 * State is in-memory by design: detection needs a live stream of heartbeats,
 * so a restart just re-detects a still-broken device within ~a minute.
 */
import { getDeviceIdForIp, isDeviceOnline, sendToDevice } from '../ws-handler.mjs';
import { getDevice } from './voice-devices.mjs';
import { sendUserNotification } from './user-notify.mjs';
import { loadConfig } from '../routes/_helpers.mjs';
import { log } from '../logger.mjs';

// ── Tuning ───────────────────────────────────────────────────────────────────
// Heartbeats arrive every ~10 s, so ticks ≈ tens of seconds.
const MIC_DEAD_TICKS = 6;      // ~60 s of cap_sps≈0 while WS-online → episode
const MIC_HEALTHY_TICKS = 3;   // ~30 s of healthy capture → episode closed
const CAP_SPS_DEAD_BELOW = 1000; // healthy is ~16000; near-zero = dead
const STORM_BOOTS = 4;           // this many boots…
const STORM_WINDOW_MS = 10 * 60_000; // …inside this window → storm
const STORM_RECOVERED_TICK = 60; // hb tick 60 = up 10 min → storm over
// First firmware release that understands {type:'reboot'}. Nothing ships it
// yet — bump-checked here so the self-heal path switches on automatically
// the moment a device reports a capable version.
const REBOOT_FW_MIN = '0.2.62';

function fwAtLeast(fw, want) {
  const m = String(fw || '').match(/(\d+)\.(\d+)\.(\d+)/);
  const w = String(want).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m || !w) return false;
  for (let i = 1; i <= 3; i++) {
    const a = Number(m[i]), b = Number(w[i]);
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Build a tracker with injectable deps (tests pass fakes; production uses
 * the bound default below). All deps are call-time so config edits and WS
 * state changes are picked up live.
 */
export function createHealthTracker(deps = {}) {
  const d = {
    deviceForIp: getDeviceIdForIp,        // ip → {deviceId,userId} | null
    isOnline: isDeviceOnline,             // deviceId → bool
    send: sendToDevice,                   // (deviceId, msg) → delivered count
    deviceInfo: getDevice,                // (userId, deviceId) → record | null
    notify: sendUserNotification,         // (userId, {subject, body})
    config: loadConfig,
    now: Date.now,
    ...deps,
  };

  // deviceId -> state
  const states = new Map();
  // ip -> { deviceId, userId } — sticky, refreshed on every live WS hit
  const ipBindings = new Map();

  function stateFor(deviceId, userId) {
    let st = states.get(deviceId);
    if (!st) {
      st = {
        userId,
        lastHbAt: null, tick: null, rssi: null, capSps: null,
        deadTicks: 0, healthyTicks: 0,
        micEpisode: null,        // { since, rebootTried, notified }
        boots: [],               // timestamps inside STORM_WINDOW_MS
        lastResetReason: null,
        stormEpisode: null,      // { since, count, notified }
      };
      states.set(deviceId, st);
    }
    st.userId = userId; // re-pair safety: follow the current owner
    return st;
  }

  function resolveDevice(ip) {
    const live = d.deviceForIp(ip);
    if (live) {
      if (!ipBindings.has(ip)) {
        // One line per binding so the loop's coverage is visible in app.log.
        log.info('voice-health', 'tracking device telemetry', { deviceId: live.deviceId, userId: live.userId, ip });
      }
      ipBindings.set(ip, live);
      return live;
    }
    return ipBindings.get(ip) ?? null;
  }

  function alertsEnabled() {
    try { return d.config().voiceDeviceHealthAlerts !== false; } catch { return true; }
  }

  function deviceName(userId, deviceId) {
    try { return d.deviceInfo(userId, deviceId)?.name || deviceId; } catch { return deviceId; }
  }

  async function notify(userId, subject, body) {
    if (!alertsEnabled()) return;
    try {
      const res = await d.notify(userId, { subject, body });
      if (!res.telegram && !res.email) {
        log.warn('voice-health', 'no notification channel delivered', { userId, subject });
      }
    } catch (e) {
      console.warn(`[voice-health] notify failed for ${userId}: ${e.message}`);
    }
  }

  function minsSince(ts) { return Math.max(1, Math.round((d.now() - ts) / 60_000)); }

  function onHeartbeat(dev, st, { tick, rssi, capSps }) {
    st.lastHbAt = d.now();
    if (tick !== null) st.tick = tick;
    if (rssi !== null) st.rssi = rssi;

    // Storm closure: the tick counter is device uptime (1 tick = 10 s), so a
    // high tick proves the boots stopped without us keeping a timer.
    if (st.stormEpisode && tick !== null && tick >= STORM_RECOVERED_TICK) {
      const ep = st.stormEpisode;
      st.stormEpisode = null;
      st.boots = [];
      log.info('voice-health', 'reboot storm over', { deviceId: dev.deviceId, upMins: Math.round((tick * 10) / 60) });
      if (ep.notified) {
        const name = deviceName(dev.userId, dev.deviceId);
        notify(dev.userId,
          `Voice device stable again: ${name}`,
          `"${name}" has stayed up for ${Math.round((tick * 10) / 60)}+ minutes after restarting repeatedly.`);
      }
    }

    if (capSps === null) return; // pre-0.2.61 firmware — no mic telemetry
    st.capSps = capSps;

    if (capSps < CAP_SPS_DEAD_BELOW) {
      // Only diagnose deafness while the control WS is up: if the device is
      // fully offline the offline monitor owns the messaging, and a mid-
      // reconnect gap shouldn't count against the mic.
      if (!d.isOnline(dev.deviceId)) return;
      st.healthyTicks = 0;
      st.deadTicks++;
      if (st.deadTicks < MIC_DEAD_TICKS) return;

      if (!st.micEpisode) {
        st.micEpisode = { since: d.now(), rebootTried: false, notified: false };
        log.warn('voice-health', 'mic dead — capture stalled while online', {
          deviceId: dev.deviceId, userId: dev.userId, capSps, deadTicks: st.deadTicks,
        });
      }
      const ep = st.micEpisode;
      const fw = (() => { try { return d.deviceInfo(dev.userId, dev.deviceId)?.fw_version ?? null; } catch { return null; } })();
      if (!ep.rebootTried && fwAtLeast(fw, REBOOT_FW_MIN)) {
        ep.rebootTried = true;
        st.deadTicks = 0; // give the reboot time to land before re-judging
        d.send(dev.deviceId, { type: 'reboot', reason: 'mic_dead' });
        log.warn('voice-health', 'sent automatic reboot for dead mic', { deviceId: dev.deviceId, fw });
      } else if (!ep.notified) {
        ep.notified = true;
        const name = deviceName(dev.userId, dev.deviceId);
        notify(dev.userId,
          `Voice device mic problem: ${name}`,
          `"${name}" is connected but its microphone stopped capturing audio about ` +
          `${minsSince(ep.since)} minute(s) ago, so it can't hear wake words. ` +
          (ep.rebootTried ? `An automatic restart didn't fix it. ` : ``) +
          `Unplugging it for ~10 seconds and plugging it back in usually fixes this. ` +
          `You'll get a follow-up when the microphone recovers.`);
      }
      return;
    }

    // Healthy capture.
    st.deadTicks = 0;
    if (!st.micEpisode) { st.healthyTicks = 0; return; }
    st.healthyTicks++;
    if (st.healthyTicks < MIC_HEALTHY_TICKS) return;
    const ep = st.micEpisode;
    st.micEpisode = null;
    st.healthyTicks = 0;
    const mins = minsSince(ep.since);
    log.info('voice-health', ep.rebootTried && !ep.notified
      ? 'mic recovered after automatic reboot' : 'mic recovered', {
      deviceId: dev.deviceId, offlineMins: mins, rebootTried: ep.rebootTried,
    });
    if (ep.notified) {
      const name = deviceName(dev.userId, dev.deviceId);
      notify(dev.userId,
        `Voice device mic recovered: ${name}`,
        `"${name}" is capturing audio again after roughly ${mins} minute(s).`);
    }
  }

  function onBoot(dev, st, reason) {
    const now = d.now();
    st.lastResetReason = reason;
    // A reboot restarts the capture path — judge the mic fresh (any open
    // episode survives so a post-reboot recovery/notify still resolves it).
    st.deadTicks = 0;
    st.healthyTicks = 0;
    st.boots = st.boots.filter(t => now - t < STORM_WINDOW_MS);
    st.boots.push(now);
    if (st.boots.length < STORM_BOOTS || st.stormEpisode) return;

    st.stormEpisode = { since: st.boots[0], count: st.boots.length, notified: false };
    log.warn('voice-health', 'reboot storm detected', {
      deviceId: dev.deviceId, userId: dev.userId,
      boots: st.boots.length, windowMins: Math.round(STORM_WINDOW_MS / 60_000), reason,
    });
    st.stormEpisode.notified = true;
    const name = deviceName(dev.userId, dev.deviceId);
    const windowMins = Math.round((now - st.boots[0]) / 60_000) || 1;
    notify(dev.userId,
      `Voice device rebooting repeatedly: ${name}`,
      `"${name}" has restarted ${st.boots.length} times in the last ${windowMins} minute(s) ` +
      `(latest reset: ${reason || 'unknown'}). Check its power supply and Wi-Fi signal — ` +
      `if this keeps happening the device may need attention. ` +
      `You'll get a follow-up once it stays up.`);
  }

  return {
    /**
     * Feed one UDP diag line (already stripped of the sink's own prefix —
     * this is the raw datagram text, e.g. "[hb] alive tick=3 rssi=-47 …").
     * Never throws: the UDP sink must survive any parser bug.
     */
    recordLine(ip, text) {
      try {
        if (typeof text !== 'string') return;
        let m;
        if (text.startsWith('[hb] alive')) {
          const dev = resolveDevice(ip);
          if (!dev) return;
          const tick = (m = text.match(/\btick=(\d+)/)) ? Number(m[1]) : null;
          const rssi = (m = text.match(/\brssi=(-?\d+)/)) ? Number(m[1]) : null;
          const capSps = (m = text.match(/\bcap_sps=(\d+)/)) ? Number(m[1]) : null;
          onHeartbeat(dev, stateFor(dev.deviceId, dev.userId), { tick, rssi, capSps });
        } else if (text.startsWith('[boot]')) {
          const dev = resolveDevice(ip);
          if (!dev) return;
          const reason = (m = text.match(/\breset=(\S+)/)) ? m[1] : null;
          onBoot(dev, stateFor(dev.deviceId, dev.userId), reason);
        }
      } catch (e) {
        console.warn(`[voice-health] recordLine failed: ${e.message}`);
      }
    },

    /** Latest health snapshot for a device (for future device-card UI). */
    getHealth(deviceId) {
      const st = states.get(deviceId);
      if (!st) return null;
      return {
        lastHbAt: st.lastHbAt,
        tick: st.tick,
        rssi: st.rssi,
        capSps: st.capSps,
        micDead: !!st.micEpisode,
        micDeadSince: st.micEpisode?.since ?? null,
        rebootStorm: !!st.stormEpisode,
        bootsInWindow: st.boots.filter(t => d.now() - t < STORM_WINDOW_MS).length,
        lastResetReason: st.lastResetReason,
      };
    },
  };
}

const _defaultTracker = createHealthTracker();

/** UDP-sink hook (server.mjs wires this into startVoiceUdpLog). */
export function recordDeviceDiag(ip, text) { _defaultTracker.recordLine(ip, text); }

/** Health snapshot by device id, or null if we've seen no telemetry. */
export function getDeviceHealth(deviceId) { return _defaultTracker.getHealth(deviceId); }
