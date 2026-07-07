/**
 * skills/role_tv_control/execute.mjs — voice/chat tool surface over the
 * Android TV command channel (see oe-tv-assistant/PROTOCOL-TV.md
 * and lib/tv-commands.mjs for the underlying tv_command / tv_command_result
 * wire protocol).
 *
 * Target resolution: every tool accepts an optional `device` name. If the
 * turn didn't specify one, we use the TV the user is speaking through
 * (getVoiceContext()/getTurnContext() deviceId) when that device IS a TV;
 * otherwise we fall back to the user's online TVs, disambiguating by name
 * when more than one is online. Mirrors the shared-connection pattern of
 * skills/role_home_assistant/execute.mjs (single executeSkillTool(name,
 * args, userId) switch), but this skill is per-user (each user's own paired
 * TVs) rather than one shared household connection.
 *
 * Error convention: never throw out of executeSkillTool — every branch
 * returns a plain, speakable string (matches role_home_assistant's
 * `return 'Error: ...'` convention). A top-level try/catch is a last-resort
 * net for anything unexpected.
 */

import { sendTvCommand, getTvState } from '../../lib/tv-commands.mjs';
import { listTvDevices } from '../../lib/voice-devices.mjs';
import { isDeviceOnline } from '../../ws-handler.mjs';
import { getVoiceContext } from '../../lib/voice-context.mjs';
import { getTurnContext } from '../../lib/turn-abort-context.mjs';
import { getHaConfig } from '../../lib/ha-client.mjs';
import { normalize, listCameras } from '../../lib/ha-cache.mjs';

const MEDIA_KEYS = new Set(['play_pause', 'play', 'pause', 'stop', 'next', 'previous', 'rewind', 'fast_forward']);
const DEFAULT_SHOW_SECONDS = 15;
const MIN_SHOW_SECONDS = 3;
const MAX_SHOW_SECONDS = 120;
const STATE_FRESH_MS = 60_000;
const WAKE_TIMEOUT_MS = 3000;

// The originating device for this turn, whether or not it's a TV. Checks
// getVoiceContext() (set for voice-device-origin turns) first, then
// getTurnContext() (set for the wider tool-execution async tree, including
// specialist delegations) — same two sources the study step called out.
function originDeviceId() {
  return getVoiceContext()?.deviceId ?? getTurnContext()?.deviceId ?? null;
}

/**
 * Resolve which TV a tool call should target.
 * @returns {{deviceId: string, deviceName: string} | {error: string}}
 */
function resolveTvTarget(userId, args) {
  const tvDevices = listTvDevices(userId);
  if (!tvDevices.length) {
    return { error: 'No TVs are paired to this account yet. Pair the OE TV app from Settings → Devices first.' };
  }

  // An explicit `device` arg names a specific TV — honor it against every
  // paired TV (not just the currently-online ones) BEFORE the origin
  // shortcut and the online-count resolution below. "Pause the bedroom TV"
  // spoken THROUGH the living-room TV must target the bedroom TV, and
  // naming an unknown or offline TV must be an error, never silently
  // control whichever TV happens to be online or in front of the speaker.
  const want = typeof args?.device === 'string' ? args.device.trim().toLowerCase() : '';
  if (want) {
    const named = tvDevices.filter(d => d.name.toLowerCase().includes(want));
    if (named.length === 1) {
      const match = named[0];
      if (!isDeviceOnline(match.id)) {
        return { error: `${match.name} isn't online right now.` };
      }
      return { deviceId: match.id, deviceName: match.name };
    }
    if (named.length > 1) {
      return { error: `Multiple TVs match "${args.device}": ${named.map(d => d.name).join(', ')}. Say the full name.` };
    }
    return { error: `No paired TV matches "${args.device}". Paired TVs: ${tvDevices.map(d => d.name).join(', ')}.` };
  }

  const originId = originDeviceId();
  const origin = originId ? tvDevices.find(d => d.id === originId) : null;
  if (origin) return { deviceId: origin.id, deviceName: origin.name };

  const online = tvDevices.filter(d => isDeviceOnline(d.id));
  if (!online.length) {
    return { error: `No TVs are online right now (have: ${tvDevices.map(d => d.name).join(', ')}).` };
  }
  if (online.length === 1) return { deviceId: online[0].id, deviceName: online[0].name };

  return { error: `Multiple TVs are online: ${online.map(d => d.name).join(', ')}. Say which one, e.g. "on the ${online[0].name}".` };
}

// sendTvCommand() rejects with Error (.code OFFLINE|TIMEOUT|INVALID) instead
// of resolving an {ok:false} result on transport failure. Normalize both
// shapes into one {ok, data, error} so callers never have to try/catch.
async function runTvCommand(deviceId, action, args, opts) {
  try {
    return await sendTvCommand(deviceId, action, args, opts);
  } catch (e) {
    if (e?.code === 'OFFLINE') return { ok: false, data: null, error: 'offline' };
    if (e?.code === 'TIMEOUT') return { ok: false, data: null, error: 'timeout' };
    return { ok: false, data: null, error: e?.message || 'invalid request' };
  }
}

function tvErrorMessage(res, deviceName, actionDesc) {
  if (res.error === 'offline') return `${deviceName} isn't reachable right now — it may be off or disconnected from the network.`;
  if (res.error === 'timeout') return `${deviceName} didn't respond in time. Try again in a moment.`;
  return `Couldn't ${actionDesc} on ${deviceName}${res.error ? `: ${res.error}` : ''}.`;
}

function formatNowPlaying(foregroundApp, nowPlaying, screenOn, deviceName) {
  if (screenOn === false) return `${deviceName}'s screen is off right now.`;
  let out = foregroundApp ? `${deviceName} is on ${foregroundApp}` : `${deviceName} is on`;
  if (nowPlaying && typeof nowPlaying === 'object' && (nowPlaying.title || nowPlaying.state)) {
    const state = nowPlaying.state || 'playing';
    out += nowPlaying.title ? `, ${state} "${nowPlaying.title}"` : `, ${state}`;
  } else {
    out += ', nothing is playing';
  }
  return `${out}.`;
}

export async function executeSkillTool(name, args, userId) {
  if (args?.__validate) return '';
  if (!userId) return 'Error: no user context for this TV command.';

  try {
    if (name === 'tv_launch_app') {
      if (!args?.app || typeof args.app !== 'string') return 'Error: app is required.';
      const target = resolveTvTarget(userId, args);
      if (target.error) return target.error;
      const res = await runTvCommand(target.deviceId, 'launch_app', { app: args.app });
      if (!res.ok) {
        if (res.error === 'app_not_found') {
          const installed = Array.isArray(res.data?.installed_apps) ? res.data.installed_apps : [];
          return installed.length
            ? `Couldn't find "${args.app}" on ${target.deviceName}. Installed apps: ${installed.join(', ')}.`
            : `Couldn't find "${args.app}" on ${target.deviceName}, and no installed-app list was reported.`;
        }
        return tvErrorMessage(res, target.deviceName, `launch "${args.app}"`);
      }
      return `Launched ${args.app} on ${target.deviceName}.`;
    }

    if (name === 'tv_media_control') {
      const key = args?.key;
      if (!MEDIA_KEYS.has(key)) return `Error: key must be one of ${[...MEDIA_KEYS].join(', ')}.`;
      const target = resolveTvTarget(userId, args);
      if (target.error) return target.error;
      const res = await runTvCommand(target.deviceId, 'media_key', { key });
      if (!res.ok) return tvErrorMessage(res, target.deviceName, `send "${key}"`);
      return `Sent ${key.replace(/_/g, ' ')} to ${target.deviceName}.`;
    }

    if (name === 'tv_set_volume') {
      const provided = ['pct', 'delta', 'mute'].filter(k => args?.[k] !== undefined && args?.[k] !== null);
      if (provided.length !== 1) return 'Error: provide exactly one of pct, delta, or mute.';
      const target = resolveTvTarget(userId, args);
      if (target.error) return target.error;

      const payload = {};
      let confirmation;
      if (provided[0] === 'pct') {
        const pct = Number(args.pct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 'Error: pct must be a number between 0 and 100.';
        payload.pct = Math.round(pct);
        confirmation = `Set the volume to ${payload.pct}% on ${target.deviceName}.`;
      } else if (provided[0] === 'delta') {
        const delta = Number(args.delta);
        if (!Number.isFinite(delta)) return 'Error: delta must be a number.';
        payload.delta = Math.round(delta);
        confirmation = `Turned the volume ${delta >= 0 ? 'up' : 'down'} by ${Math.abs(payload.delta)} on ${target.deviceName}.`;
      } else {
        payload.mute = !!args.mute;
        confirmation = payload.mute ? `Muted ${target.deviceName}.` : `Unmuted ${target.deviceName}.`;
      }
      const res = await runTvCommand(target.deviceId, 'set_volume', payload);
      if (!res.ok) return tvErrorMessage(res, target.deviceName, 'change the volume');
      return confirmation;
    }

    if (name === 'tv_search') {
      if (!args?.query || typeof args.query !== 'string') return 'Error: query is required.';
      const target = resolveTvTarget(userId, args);
      if (target.error) return target.error;
      const payload = { query: args.query };
      if (args.app) payload.app = String(args.app);
      const res = await runTvCommand(target.deviceId, 'search', payload);
      if (!res.ok) return tvErrorMessage(res, target.deviceName, `search for "${args.query}"`);
      return `Searching${args.app ? ` in ${args.app}` : ''} for "${args.query}" on ${target.deviceName}.`;
    }

    if (name === 'tv_show_on_tv') {
      if (!args?.title && !args?.body && !args?.image_url) {
        return 'Error: provide at least one of title, body, or image_url.';
      }
      const target = resolveTvTarget(userId, args);
      if (target.error) return target.error;
      // Fire-and-forget wake — runTvCommand never rejects, and message order
      // over the device's single WS is preserved without awaiting the ack,
      // so the 'show' frame right below still arrives after this one.
      runTvCommand(target.deviceId, 'wake_screen', {}, { timeoutMs: WAKE_TIMEOUT_MS });

      let imageUrl = null;
      if (args.image_url) {
        const raw = String(args.image_url).trim();
        // The device fetches image_url with its own bearer token attached
        // (see OeHttp.getBytes), so an attacker-supplied URL here would leak
        // that token to an arbitrary external host. Allowlist, don't
        // denylist: require an /api/... path built from URL-safe characters.
        // The character class excludes "\" on purpose — WHATWG-style
        // resolvers (OkHttp's HttpUrl mimics browsers) treat "\" as "/", so
        // "/\evil.com/x" would resolve protocol-relative to evil.com and a
        // startsWith('//') check alone would not catch it. It also excludes
        // whitespace/control chars and a second leading slash by
        // construction.
        if (!/^\/api\/[A-Za-z0-9_\-./%?=&+]*$/.test(raw)) {
          return 'Error: image_url must be an OE-server API path (e.g. "/api/tv/camera/camera.front_door") — external image URLs are not supported, only /api/... paths on this OE server.';
        }
        imageUrl = raw;
      }

      const kind = imageUrl ? 'image' : 'text';
      const rawSeconds = Number(args.duration_seconds);
      const seconds = Math.max(MIN_SHOW_SECONDS, Math.min(MAX_SHOW_SECONDS, Number.isFinite(rawSeconds) ? rawSeconds : DEFAULT_SHOW_SECONDS));
      const payload = { kind, duration_ms: Math.round(seconds * 1000) };
      if (args.title) payload.title = String(args.title);
      if (args.body) payload.body = String(args.body);
      if (imageUrl) payload.image_url = imageUrl;

      const res = await runTvCommand(target.deviceId, 'show', payload);
      if (!res.ok) return tvErrorMessage(res, target.deviceName, 'show that');
      return `Showing it on ${target.deviceName}.`;
    }

    if (name === 'tv_show_camera') {
      if (!args?.camera || typeof args.camera !== 'string') return 'Error: camera is required.';
      const haCfg = getHaConfig();
      if (!haCfg) {
        return "Home Assistant is not configured, so there's no camera to show. An administrator needs to set the URL and access token in Settings → Providers → Home Assistant.";
      }
      const target = resolveTvTarget(userId, args);
      if (target.error) return target.error;

      // Resolved from ha-cache's side index (rides the one /states fetch the
      // HA fast-path cache already makes, ≤5 min stale) instead of pulling
      // the full /states dump on every call — on a large HA install that
      // dump is hundreds of KB of JSON inside a voice turn. Staleness only
      // affects NAME resolution; the snapshot itself is always fetched live
      // by the device via /api/tv/camera/<entity_id>.
      const cameras = await listCameras();
      if (!cameras.length) {
        return 'No Home Assistant cameras found — either none are configured or Home Assistant is unreachable right now.';
      }

      const raw = args.camera.trim();
      let match = null;
      if (raw.startsWith('camera.')) {
        match = cameras.find(e => e.entity_id === raw) || null;
        if (!match) return `No camera entity named "${raw}" exists.`;
      } else {
        const norm = normalize(raw);
        const scored = cameras.map(e => ({ entity: e, norm: normalize(e.friendly_name) }));
        let hits = scored.filter(s => s.norm === norm);
        if (!hits.length) hits = scored.filter(s => s.norm.includes(norm));
        if (!hits.length) {
          const tokens = norm.split(' ').filter(Boolean);
          if (tokens.length) {
            hits = scored.filter(s => {
              const kTokens = new Set(s.norm.split(' '));
              return tokens.every(t => kTokens.has(t));
            });
          }
        }
        if (hits.length === 1) {
          match = hits[0].entity;
        } else if (hits.length > 1) {
          const names = hits.map(h => h.entity.friendly_name).join(', ');
          return `More than one camera matches "${raw}": ${names}. Say the full name.`;
        } else {
          const names = cameras.map(e => e.friendly_name).join(', ');
          return `No camera matches "${raw}". Available cameras: ${names}.`;
        }
      }

      const entityId = match.entity_id;
      const friendly = match.friendly_name || entityId;
      runTvCommand(target.deviceId, 'wake_screen', {}, { timeoutMs: WAKE_TIMEOUT_MS });
      const res = await runTvCommand(target.deviceId, 'show', {
        kind: 'image',
        title: friendly,
        image_url: `/api/tv/camera/${encodeURIComponent(entityId)}`,
        duration_ms: DEFAULT_SHOW_SECONDS * 1000,
      });
      if (!res.ok) return tvErrorMessage(res, target.deviceName, 'show that camera');
      return `Showing ${friendly} on ${target.deviceName}.`;
    }

    if (name === 'tv_now_playing') {
      const target = resolveTvTarget(userId, args);
      if (target.error) return target.error;
      const cached = getTvState(target.deviceId);
      if (cached && (Date.now() - cached.updatedAt) < STATE_FRESH_MS) {
        return formatNowPlaying(cached.foregroundApp, cached.nowPlaying, cached.screenOn, target.deviceName);
      }
      const res = await runTvCommand(target.deviceId, 'get_state', {});
      if (!res.ok) return tvErrorMessage(res, target.deviceName, "check what's playing");
      const d = res.data || {};
      return formatNowPlaying(d.foreground_app, d.now_playing, d.screen_on, target.deviceName);
    }

    return null;
  } catch (e) {
    return `Error: TV control failed unexpectedly (${e?.message || 'unknown error'}).`;
  }
}

export default executeSkillTool;
