/**
 * lib/tv-dashboard.mjs — builds the `dashboard_data` payload for the Android
 * TV screensaver/dashboard (see oe-tv-assistant/PROTOCOL-TV.md,
 * "Dashboard"). Device sends `{"type":"dashboard_get"}` on its persistent
 * socket; ws-handler.mjs calls buildDashboardData() and replies with
 * `{"type":"dashboard_data", ...}` on the same socket.
 *
 * Every section is independently best-effort: a failure in one (HA down,
 * disk hiccup) degrades that field to null/[] rather than failing the whole
 * payload — the device renders whatever it gets (protocol: "Missing
 * sections must be null/[] — device renders what it gets").
 */

import { getUser } from '../routes/_helpers.mjs';
import { getActiveAlarms } from './alarms.mjs';
import { peekVoiceAnnouncements } from './voice-announcements.mjs';
import { getTvState } from './tv-commands.mjs';
import { listWeatherStates } from './ha-cache.mjs';

function timeOfDayGreeting(displayName) {
  // Server-local hour — assumes the TV and the OE server share a timezone
  // (true for a same-house deployment). A TV in another timezone gets the
  // wrong lead word; fixing that properly means composing the greeting
  // device-side from the owner's name (oe-tv-assistant protocol change),
  // not growing per-device TZ config here.
  const hour = new Date().getHours();
  const lead = hour < 5 ? 'Good night'
    : hour < 12 ? 'Good morning'
    : hour < 17 ? 'Good afternoon'
    : hour < 21 ? 'Good evening'
    : 'Good night';
  return displayName ? `${lead}, ${displayName}` : lead;
}

async function getWeather() {
  try {
    // Served from ha-cache's side index — rides the /states fetch the HA
    // fast-path cache already makes (≤5 min stale, stale-while-revalidate),
    // so a dashboard_get never blocks on HA and costs no extra HA calls.
    const candidates = await listWeatherStates();
    if (!candidates.length) return null;
    // Deterministic pick when HA has several weather integrations: prefer
    // entities that actually report a temperature, tie-break on entity_id —
    // never "whatever /states happened to list first".
    const entity = [...candidates].sort((a, b) =>
      (b.temperature != null) - (a.temperature != null) || a.entity_id.localeCompare(b.entity_id)
    )[0];
    if (entity.temperature == null && !entity.state) return null;
    return {
      temp: entity.temperature != null ? String(entity.temperature) : null,
      summary: entity.state,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} userId - the device-owner user (ws._userId of the authed socket)
 * @param {string} deviceId - the TV's device id (ws._deviceId)
 * @returns {Promise<{greeting:string, alarms:Array, announcements:Array, now_playing:object|null, weather:object|null}>}
 */
export async function buildDashboardData(userId, deviceId) {
  let greeting = timeOfDayGreeting(null);
  try {
    const user = userId ? getUser(userId) : null;
    greeting = timeOfDayGreeting(typeof user?.name === 'string' ? user.name : null);
  } catch { /* keep the name-less greeting */ }

  let alarms = [];
  try {
    alarms = userId
      ? getActiveAlarms(userId).map(a => ({ label: a.label, at: new Date(a.triggerAtMs).toISOString() }))
      : [];
  } catch { alarms = []; }

  let announcements = [];
  try {
    announcements = deviceId ? peekVoiceAnnouncements(deviceId) : [];
  } catch { announcements = []; }

  let now_playing = null;
  try {
    now_playing = deviceId ? (getTvState(deviceId)?.nowPlaying ?? null) : null;
  } catch { now_playing = null; }

  const weather = await getWeather();

  return { greeting, alarms, announcements, now_playing, weather };
}
