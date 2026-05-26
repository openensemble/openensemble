// @ts-check
/**
 * chat-dispatch.mjs
 * Platform-agnostic chat handler — used by WebSocket (server.mjs) and Telegram (routes/telegram.mjs).
 *
 * Type-checked via `// @ts-check` above. JSDoc on the public surface
 * (`handleChatMessage`) is the canonical signature; everything internal
 * relies on inference plus `@type` casts at native-binding boundaries
 * (provider streams, skill manifests with dynamic shapes). To opt other
 * files in, add `// @ts-check` and run `npm run typecheck`.
 */

import { getAgent, updateCustomAgent, loadCustomAgents } from './agents.mjs';
import { streamChat } from './chat.mjs';
import { appendToSession, writeStreamBuffer, clearStreamBuffer, loadSession } from './sessions.mjs';
import { extractTransactions, getPendingDelete, clearPendingDelete, executePendingDelete } from './skills/expenses/execute.mjs';
import { getPendingEmail, clearPendingEmail, executePendingEmail } from './skills/email/execute.mjs';
import { getPendingProven, clearPendingProven, executePendingProven } from './skills/profiles/execute.mjs';
import { getRoleManifest, getRoleAssignments, setRoleAssignment, listRoles, getRoleTools } from './roles.mjs';
import { interceptScheduling } from './lib/scheduler-intent.mjs';
import {
  classifyTimerIntent, createVoiceTimer,
  classifyTimerCancelIntent, cancelVoiceTimer,
  classifyTimerExtendIntent, extendVoiceTimer,
  resolveTimerDisambig,
} from './lib/voice-timer.mjs';
import { getSlotAssignment } from './lib/voice-devices.mjs';
import { sendToDevice } from './ws-handler.mjs';
import { broadcastAlarmStop, hasActiveAlarms } from './lib/alarms.mjs';
import { classifyRoutineIntent, executeRoutine, resolveRoutineDeviceId } from './lib/routines.mjs';
import { speakReminder } from './lib/voice-reminder.mjs';
import { stopAmbientOnDevice } from './lib/ambient-playback.mjs';
import { log } from './logger.mjs';
import {
  loadConfig, modifyUser, getAgentsForUser, detectNewsPref, detectRenameCommand,
  saveUserAgentOverride, getUser, getUserCoordinatorAgentId, recordActivity, recordTokenUsage,
  isUserTimeBlocked,
} from './routes/_helpers.mjs';

// Track active AbortControllers so in-progress runs can be cancelled.
// Keyed by `${userId}_${agentId}` so one user's chat can't abort another user's
// concurrent chat on the same agent id (cross-user DoS).
const abortControllers = new Map();

// Track which agents are actively streaming, so reconnecting clients can be told.
// Same scoped key as abortControllers.
const activeStreams = new Map(); // `${userId}_${agentId}` → { userId, agentId, startTs }

// Track in-flight work per agent (WS *and* delegate) so ask_agent can queue
// behind an active run instead of colliding with it.
const busyPromises = new Map(); // agentId → Promise (resolves when current run ends)

export function isAgentBusy(agentId) {
  return busyPromises.has(agentId);
}

export function waitForAgentIdle(agentId) {
  return busyPromises.get(agentId) ?? Promise.resolve();
}

/**
 * Register an in-flight run. Returns a `release()` fn the caller MUST
 * invoke on finish — otherwise the next call to markAgentBusy(agentId)
 * waits forever. waitTurn() resolves when the previous slot for this
 * agent (if any) completes.
 *
 * @param {string} agentId  scoped session key — `${userId}_${agentId}` at call sites.
 * @returns {{waitTurn: () => Promise<unknown>, release: () => void}}
 */
export function markAgentBusy(agentId) {
  // Serialize: if something is already in flight, chain onto it.
  const prev = busyPromises.get(agentId) ?? Promise.resolve();
  /** @type {() => void} */
  let release = () => {};
  const slot = new Promise(res => { release = /** @type {() => void} */ (res); });
  const chained = prev.then(() => slot);
  busyPromises.set(agentId, chained);
  chained.finally(() => {
    if (busyPromises.get(agentId) === chained) busyPromises.delete(agentId);
  });
  return { waitTurn: () => prev, release };
}

export function getActiveStreams(userId) {
  const result = [];
  for (const info of activeStreams.values()) {
    if (info.userId === userId) result.push({ agentId: info.agentId, startTs: info.startTs });
  }
  return result;
}

export function abortChat(userId, agentId) {
  if (!userId || !agentId) return;
  const key = `${userId}_${agentId}`;
  abortControllers.get(key)?.abort();
  abortControllers.delete(key);
  activeStreams.delete(key);
}

export function abortAllChats() {
  for (const [id, ac] of abortControllers) {
    ac.abort();
    abortControllers.delete(id);
  }
  activeStreams.clear();
}

/**
 * Handle an incoming chat message from any transport.
 *
 * @param {object} opts
 * @param {string} opts.userId        - OpenEnsemble user ID
 * @param {string} [opts.agentId]     - Target agent ID (defaults to coordinator)
 * @param {string} [opts.text]        - User message text
 * @param {object} [opts.attachment]  - File attachment object
 * @param {function} opts.onEvent     - Callback(event) for all chat events
 * @param {function} [opts.onBroadcast] - Called when agent list may have changed (e.g. rename)
 * @param {function} [opts.onNotify]  - Called for __notify cross-user events
 */
// Slim tool subset used when source === 'voice-device'. The voice-device
// firmware (XVF3800 + ESP32-S3) chats over WS and waits synchronously for
// the agent reply — with the full ~80-tool web role catalog and gpt-5.5,
// a "what time is it" round-trip takes 60+ seconds because the model
// reasons through every tool. Voice queries are short and shouldn't need
// the full surface, so we clamp to a minimal allowlist: web search, memory
// recall, agent delegation, basic notes.
//
// LONGER-TERM REPLACEMENT (see project_smart_tool_selection memory):
// run the Cortex plan classifier on rawText, map intent → tool subset, and
// drop this hardcoded allowlist. Until then, voice-device chats use this
// to stay snappy.
const VOICE_DEVICE_TOOL_ALLOWLIST = new Set([
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_save',
  'ask_agent',
  // Scheduler family — actual tool names per skills/tasks/manifest.json.
  // The previous entry "create_task" was wrong (no such tool exists), which
  // is why Sydney told users "the alarm tool isn't available to me in this
  // turn" on voice-device requests like "set an alarm for 11:22 AM today".
  'set_reminder',
  'set_alarm',
  'schedule_task',
  'list_tasks',
  'list_reminders',
  'delete_task',
  'cancel_reminder',
  'ha_list_devices',
  'ha_get_state',
  'ha_call_service',
  'ha_list_areas',
  'ha_list_services',
  // Voice routines — let users bind/edit/delete routines by speaking
  // ("Sydney, when I say goodnight, turn off the lights and play
  // thunderstorm sounds"). Fast-path executes matched routines pre-LLM;
  // these tools are the AUTHORING path that lands on the same store.
  'create_routine',
  'list_routines',
  'delete_routine',
  'list_ambient_files',
]);

/**
 * Fast-path regex router for voice-device control intents. Runs BEFORE the
 * full LLM dispatch so common commands like "volume up" / "pause" / "stop"
 * complete in ~1 ms with no token cost.
 *
 * Returns null when nothing matches → caller falls through to the normal
 * chat pipeline. Returns an intent object on match; the executor below
 * acts on it and tells the caller whether to `replaces` the in-flight
 * agent reply (stop) or leave it alone (volume / pause / resume).
 *
 * Keep the regex set small and obvious — if natural-phrasing misses
 * become a real problem, layer a tiny LLM classifier on top, don't
 * inflate the regex set into something unreadable.
 */
function classifyVoiceIntent(text) {
  if (typeof text !== 'string') return null;
  const t = text.toLowerCase().trim().replace(/[.,!?]+$/, '');
  if (!t) return null;

  // Absolute "volume N%" / "set volume to N" — match before the bare
  // up/down regex so "volume 50" doesn't get swallowed as "volume … up".
  const setM = t.match(/^(?:set\s+)?volume(?:\s+to)?\s+(\d{1,3})\s*%?$/);
  if (setM) {
    const pct = Math.max(0, Math.min(100, Number(setM[1])));
    return { type: 'volume_set', pct };
  }
  if (/^(volume\s+up|louder|turn\s+(it\s+)?up)\b/.test(t))   return { type: 'volume_up' };
  if (/^(volume\s+down|quieter|softer|turn\s+(it\s+)?down)\b/.test(t)) return { type: 'volume_down' };

  if (/^(mute|be\s+quiet)\b/.test(t))     return { type: 'mute' };
  if (/^unmute\b/.test(t))                return { type: 'unmute' };

  if (/^pause\b/.test(t))                 return { type: 'pause' };
  if (/^(resume|continue|unpause)\b/.test(t)) return { type: 'resume' };

  // Stop / cancel — barge-in firmware has already killed local audio; we
  // mark this `replaces` so the chat pipeline doesn't generate a reply.
  if (/^(stop|cancel|never\s*mind|shut\s+up|that('s|s)\s+enough)\b/.test(t)) {
    return { type: 'stop' };
  }

  return null;
}

/**
 * Execute a matched voice intent against the device. Returns
 * { replaces: bool } — true means short-circuit the chat pipeline (don't
 * run the LLM, don't generate a reply); false means we already handled
 * the side effect but the caller can continue if desired (in practice
 * we still short-circuit for all of these because they're terminal).
 */
function executeVoiceIntent(intent, deviceId, userId) {
  if (!deviceId) return { replaces: false };
  switch (intent.type) {
    case 'volume_up':
      sendToDevice(deviceId, { type: 'set_volume', delta: 10 });
      return { replaces: true };
    case 'volume_down':
      sendToDevice(deviceId, { type: 'set_volume', delta: -10 });
      return { replaces: true };
    case 'volume_set':
      sendToDevice(deviceId, { type: 'set_volume', pct: intent.pct });
      return { replaces: true };
    case 'mute':
      sendToDevice(deviceId, { type: 'set_volume', pct: 0 });
      return { replaces: true };
    case 'unmute':
      // 80% matches the firmware default; if the user had a custom level
      // before muting we lose it. Acceptable for v1 — next iteration
      // could track pre-mute volume per device.
      sendToDevice(deviceId, { type: 'set_volume', pct: 80 });
      return { replaces: true };
    case 'pause':
      sendToDevice(deviceId, { type: 'pause_playback' });
      return { replaces: true };
    case 'resume':
      sendToDevice(deviceId, { type: 'resume_playback' });
      return { replaces: true };
    case 'stop':
      // Local audio was already stopped by the barge-in handler in
      // firmware when the wake fired. Also broadcast alarm_stop to every
      // device holding an active alarm for this user — devices halt their
      // ring loops and send alarm_acked back, which cleans up the server
      // registry. The firmware's wake-while-alarm-firing path already
      // dismisses locally without an STT roundtrip, so this catches the
      // typed/UI-driven stops that don't go through the device's wake.
      if (userId && hasActiveAlarms(userId)) {
        const n = broadcastAlarmStop(userId);
        console.log(`[chat] voice-stop broadcasted alarm_stop to ${n} device(s) for ${userId}`);
      }
      // Also cancel any looped ambient playback on the originating device.
      // The firmware's wake-during-ambient path stops the loop locally, but
      // a typed/UI "stop" goes through here without that signal — so we
      // mirror it server-side.
      if (deviceId) stopAmbientOnDevice(deviceId);
      return { replaces: true };
  }
  return { replaces: false };
}

// ── HA fast-path (pre-LLM) ────────────────────────────────────────────────────
// Resolution order for "<verb> <phrase>" commands:
//   1. user phrase alias (users/<id>/ha-aliases.json) — instant, learned from
//      prior Helen turns or set manually via the Phrase aliases UI
//   2. HA entity-name cache (light.kitchen_lights friendly name match)
//   3. multi-match / miss → null → fall through to specialist router / LLM
//
// Supported verbs: turn on/off/toggle, activate/run (scenes/scripts), lock/
// unlock, open/close, "set X to N%" (light brightness, fan percentage),
// "set X to N degrees" (climate temperature). Each maps to a domain-aware
// service call below. New verbs go in classifyHaIntent → executeHaIntent.

const HA_VERB_RE      = /^(turn\s+on|turn\s+off|toggle|activate|run|lock|unlock|open|close)\s+(.+?)\s*$/i;
const HA_SET_PCT_RE   = /^set\s+(.+?)\s+to\s+(\d+)\s*(?:%|percent)\s*$/i;
const HA_SET_DEG_RE   = /^set\s+(.+?)\s+to\s+(\d+)\s*(?:degrees?|deg)\s*$/i;

async function resolvePhrase(phrase, userId) {
  const { resolveAlias } = await import('./lib/ha-aliases.mjs');
  const aliased = resolveAlias(userId, phrase);
  if (aliased) {
    const domain = aliased.split('.', 1)[0];
    // The friendly name shown in the spoken confirmation — derive from the
    // entity_id when we don't have a cached one (alias may point at an entity
    // the cache hasn't picked up yet on a fresh install).
    const { ensureCache } = await import('./lib/ha-cache.mjs');
    let friendly_name = null;
    try {
      const idx = await ensureCache();
      if (idx) for (const v of idx.values()) if (v.entity_id === aliased) { friendly_name = v.friendly_name; break; }
    } catch { /* best-effort */ }
    if (!friendly_name) {
      const tail = aliased.split('.', 2)[1] || aliased;
      friendly_name = tail.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    }
    return { entity_id: aliased, domain, friendly_name, strategy: 'alias' };
  }
  const { lookupEntity } = await import('./lib/ha-cache.mjs');
  return await lookupEntity(phrase);
}

async function classifyHaIntent(text, userId) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/[.,!?]+$/, '');

  // Verb-prefix path: "turn on X", "lock X", "open X", "activate X", etc.
  const vm = trimmed.match(HA_VERB_RE);
  if (vm) {
    const verb = vm[1].toLowerCase().replace(/\s+/g, ' ');
    const phrase = vm[2];
    const hit = await resolvePhrase(phrase, userId);
    if (!hit) return null;
    const { entity_id, domain, friendly_name } = hit;

    // activate/run are scene/script-only by intent (user said "run pomodoro"
    // expecting a script, not a light named "pomodoro").
    if ((verb === 'activate' || verb === 'run') && domain !== 'scene' && domain !== 'script') return null;

    let serviceDomain, service, data;
    if (verb === 'turn on' || verb === 'activate' || verb === 'run') {
      if (domain === 'scene' || domain === 'script') { serviceDomain = domain; service = 'turn_on'; }
      else { serviceDomain = 'homeassistant'; service = 'turn_on'; }
    } else if (verb === 'turn off') {
      serviceDomain = 'homeassistant'; service = 'turn_off';
    } else if (verb === 'toggle') {
      serviceDomain = 'homeassistant'; service = 'toggle';
    } else if (verb === 'lock' || verb === 'unlock') {
      if (domain !== 'lock') return null;
      serviceDomain = 'lock'; service = verb;
    } else if (verb === 'open' || verb === 'close') {
      if (domain !== 'cover') return null;
      serviceDomain = 'cover'; service = verb === 'open' ? 'open_cover' : 'close_cover';
    } else {
      return null;
    }
    return { entity_id, domain, friendly_name, verb, serviceDomain, service, data };
  }

  // "set X to N%" — light brightness or fan percentage.
  const pm = trimmed.match(HA_SET_PCT_RE);
  if (pm) {
    const phrase = pm[1];
    const pct = Math.max(0, Math.min(100, Number(pm[2])));
    const hit = await resolvePhrase(phrase, userId);
    if (!hit) return null;
    const { entity_id, domain, friendly_name } = hit;
    let serviceDomain, service, data;
    if (domain === 'light') {
      serviceDomain = 'light'; service = 'turn_on'; data = { brightness_pct: pct };
    } else if (domain === 'fan') {
      serviceDomain = 'fan'; service = 'set_percentage'; data = { percentage: pct };
    } else if (domain === 'media_player') {
      serviceDomain = 'media_player'; service = 'volume_set'; data = { volume_level: pct / 100 };
    } else {
      return null;  // % doesn't map cleanly to other domains; fall through to LLM
    }
    return { entity_id, domain, friendly_name, verb: `set to ${pct}%`, serviceDomain, service, data };
  }

  // "set X to N degrees" — thermostat temperature.
  const dm = trimmed.match(HA_SET_DEG_RE);
  if (dm) {
    const phrase = dm[1];
    const temp = Number(dm[2]);
    const hit = await resolvePhrase(phrase, userId);
    if (!hit) return null;
    const { entity_id, domain, friendly_name } = hit;
    if (domain !== 'climate') return null;
    return {
      entity_id, domain, friendly_name, verb: `set to ${temp}°`,
      serviceDomain: 'climate', service: 'set_temperature', data: { temperature: temp },
    };
  }

  return null;
}

// Runtime toggle for the specialist router's tool-surface trim.
// Default OFF: A/B testing on 2026-05-16 ("give me my last 10 emails") showed
// no measurable speedup from trimming 85 → 13 tools (22.4s vs 22.8s). The
// bottleneck is reasoning/output, not tool-schema overhead — at least for
// gpt-5.5 on typical specialist queries. Kept toggleable via `/trim on|off`
// so future experiments (different models, simpler queries) can re-test.
let _specialistTrimEnabled = false;

// ── Specialist router (pre-LLM) ───────────────────────────────────────────────
// Skip the coordinator's reasoning turn when the user's message clearly
// belongs to one specialist. Each skill manifest can declare `intent_patterns`
// (array of regex strings, case-insensitive); a single unique match against an
// ASSIGNED role triggers a direct delegation to that specialist's agent.
// Multi-match or no-match → null → falls through to the normal LLM pipeline so
// the coordinator can disambiguate or handle general queries.
//
// Only fires when the user is chatting with their coordinator. If they
// intentionally opened a specialist chat, leave them alone — they want that
// specific agent to handle everything in that session.
function classifySpecialistIntent(text, userId, currentAgentId) {
  if (!text) return null;
  // Normalize for matching: lowercase, strip apostrophes, collapse whitespace.
  // Lets patterns be written once for "what's"/"whats"/"what is" rather than
  // every author re-encoding the apostrophe variants in every regex.
  const t = String(text).trim().toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/\s+/g, ' ');
  if (!t) return null;
  const assignments = getRoleAssignments(userId);
  const coordAgentId = assignments?.coordinator;
  if (!coordAgentId || currentAgentId !== coordAgentId) return null;
  const matches = [];
  for (const m of listRoles(userId)) {
    if (!m.service || !Array.isArray(m.intent_patterns) || m.intent_patterns.length === 0) continue;
    const rawOwner = assignments[m.id];
    if (!rawOwner) continue;
    // The literal "coordinator" string is an alias meaning "whoever holds the
    // coordinator role" — resolve it before comparing so we don't try to
    // delegate to a phantom agentId nor accidentally bypass the
    // self-delegation guard below.
    const owner = rawOwner === 'coordinator' ? coordAgentId : rawOwner;
    if (owner === coordAgentId) continue;
    for (const pat of m.intent_patterns) {
      try {
        if (new RegExp(pat, 'i').test(t)) {
          matches.push({ skillId: m.id, agentId: owner, name: m.name });
          break; // one pattern per skill is enough
        }
      } catch (e) {
        console.warn(`[router] bad regex in ${m.id}: ${pat} — ${e.message}`);
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

async function executeHaIntent(intent) {
  const { getHaConfig, haRequest } = await import('./lib/ha-client.mjs');
  const haCfg = getHaConfig();
  if (!haCfg) return { error: 'Home Assistant is not configured.' };
  // serviceDomain may differ from the entity's domain (e.g. group entity
  // controlled via homeassistant.turn_off). intent.data is optional.
  const serviceDomain = intent.serviceDomain || intent.domain;
  const payload = { entity_id: intent.entity_id, ...(intent.data || {}) };
  const res = await haRequest(haCfg, `/services/${serviceDomain}/${intent.service}`, 'POST', payload);
  if (res?.__err) return { error: res.__err };
  let confirm;
  if (intent.service === 'turn_on'  && !intent.data) confirm = `${intent.friendly_name} on.`;
  else if (intent.service === 'turn_off')             confirm = `${intent.friendly_name} off.`;
  else if (intent.service === 'toggle')               confirm = `${intent.friendly_name} toggled.`;
  else if (intent.service === 'lock')                 confirm = `${intent.friendly_name} locked.`;
  else if (intent.service === 'unlock')               confirm = `${intent.friendly_name} unlocked.`;
  else if (intent.service === 'open_cover')           confirm = `Opening ${intent.friendly_name}.`;
  else if (intent.service === 'close_cover')          confirm = `Closing ${intent.friendly_name}.`;
  else if (intent.data?.brightness_pct != null)       confirm = `${intent.friendly_name} at ${intent.data.brightness_pct}%.`;
  else if (intent.data?.percentage != null)           confirm = `${intent.friendly_name} at ${intent.data.percentage}%.`;
  else if (intent.data?.volume_level != null)         confirm = `${intent.friendly_name} volume ${Math.round(intent.data.volume_level * 100)}%.`;
  else if (intent.data?.temperature != null)          confirm = `${intent.friendly_name} set to ${intent.data.temperature}°.`;
  else                                                confirm = `Done.`;
  return { text: confirm };
}

/**
 * Platform-agnostic chat entrypoint. WS (server.mjs) and Telegram
 * (routes/telegram.mjs) both call this with a small adapter for their
 * own event surface — onEvent for token/done/error pushes, onBroadcast
 * for "agent list changed" fan-out, onNotify for toasts.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.agentId
 * @param {string} opts.text
 * @param {object|null} [opts.attachment]
 * @param {'voice-device'|'web'|'telegram'|null} [opts.source]
 * @param {string|null} [opts.deviceId]              voice-device id if applicable
 * @param {number|null} [opts.wakeSlot]              voice-device slot index (0–5)
 * @param {(ev: {type: string, [k: string]: any}) => void} opts.onEvent
 * @param {() => void} [opts.onBroadcast]
 * @param {(fromUserId: string, agentId: string, notify: object) => void} [opts.onNotify]
 * @param {boolean} [opts._isRoutineFollowup]        internal recursion guard
 * @returns {Promise<void>}
 */
export async function handleChatMessage({
  userId,
  agentId: rawAgentId,
  text: rawText,
  attachment: rawAttachment,
  source = null,
  deviceId = null,
  wakeSlot = null,
  onEvent,
  onBroadcast = () => {},
  onNotify    = () => {},
  _isRoutineFollowup = false,
}) {
  // Wake-slot routing — household-shared voice device.
  //
  // When a voice device fires a wake word, the slot index identifies which
  // *user* the resulting chat belongs to. slot 0 might be the admin saying
  // "Sydney" → admin's coordinator; slot 1 might be a roommate saying
  // "Hey Ensemble" → roommate's coordinator. Per-user data isolation comes
  // for free because every downstream call (memory, sessions, agents,
  // persist) is keyed off `userId`, so swapping it here is enough.
  //
  // Security: the assignment is set by the device-owner (admin) and lives
  // in their voice-devices.json. ownerUserId in the assignment can be any
  // user on this OE install. Trust model: same-install household admin.
  //
  // Fallback: when the slot is unassigned, run as the WS-authed user (the
  // device's pairing user) and use the message's agent field.
  let effectiveUserId = userId;
  let agentId = rawAgentId ?? null;
  if (deviceId && Number.isInteger(wakeSlot)) {
    const assignment = getSlotAssignment(userId, deviceId, wakeSlot);
    if (assignment) {
      effectiveUserId = assignment.ownerUserId;
      agentId = assignment.agentId ?? null;
      console.log(`[chat] voice-device slot=${wakeSlot} device=${deviceId} auth_user=${userId} acting_as=${effectiveUserId} agent=${agentId ?? '(coordinator)'}`);
    }
  }
  userId = effectiveUserId;
  agentId = agentId ?? getUserCoordinatorAgentId(userId);

  // Voice proposal yes/no — if the prior turn spoke a proposal ("Want me to
  // remember that 'kitchen' means light.kitchen_group?") and the user is
  // now answering, accept or dismiss directly without going through any
  // LLM/router. Anything that ISN'T yes/no on a pending proposal clears
  // the pending state and continues into the normal pipeline.
  if (source === 'voice-device' && deviceId && typeof rawText === 'string') {
    try {
      const { peekPendingVoiceProposal, clearPendingVoiceProposal } =
        await import('./lib/voice-proposal-queue.mjs');
      const pending = peekPendingVoiceProposal(deviceId);
      if (pending) {
        const t = rawText.trim().toLowerCase().replace(/[.,!?]+$/, '');
        const YES = /^(yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|sounds good|sure thing)\b/;
        const NO  = /^(no|nope|nah|don't|dont|cancel|skip|not now|never mind|nevermind)\b/;
        if (YES.test(t)) {
          clearPendingVoiceProposal(deviceId);
          const { acceptProposal } = await import('./lib/proposals.mjs');
          await acceptProposal(pending.proposalId);
          console.log(`[chat] voice-proposal accept: ${pending.proposalId}`);
          onEvent({ type: 'token', text: 'Saved.', agent: agentId });
          onEvent({ type: 'done', agent: agentId });
          return;
        }
        if (NO.test(t)) {
          clearPendingVoiceProposal(deviceId);
          const { dismissProposal } = await import('./lib/proposals.mjs');
          await dismissProposal(pending.proposalId);
          console.log(`[chat] voice-proposal dismiss: ${pending.proposalId}`);
          onEvent({ type: 'token', text: 'Okay.', agent: agentId });
          onEvent({ type: 'done', agent: agentId });
          return;
        }
        // Not yes/no — clear pending state so a later unrelated "yes" doesn't
        // get attributed to this proposal, then fall through to normal flow.
        clearPendingVoiceProposal(deviceId);
        console.log(`[chat] voice-proposal cleared (non-yes/no follow-up): ${pending.proposalId}`);
      }
    } catch (e) {
      console.warn('[chat] voice-proposal check threw, falling through:', e.message);
    }
  }

  // Fast-path: voice-device control intents bypass the LLM entirely.
  // "sydney, volume up" / "pause" / "stop" → regex match → WS message
  // sent to the device, no chat dispatched. Runs only for source ===
  // 'voice-device' so a typed "stop" in a browser chat is still treated
  // as a normal message. Returns immediately on match.
  // Fast-path: voice-device countdown timers ("set a 5 minute timer") bypass
  // both the LLM and the scheduler-intent plan model. Targets the originating
  // device so the chime + "Your X timer is done" TTS fires there, not on
  // whatever the user's reminderVoiceDeviceId default happens to be.
  // Cancel ("cancel the timer") shares the block — it must precede the
  // generic 'stop'/'cancel' voice intent below, which would otherwise eat
  // any cancellation that starts with 'stop'/'cancel'.
  if (source === 'voice-device' && deviceId && typeof rawText === 'string') {
    // Disambig response first: if we asked "the 5 or 10 minute one?" and
    // the user just said "5 minute", treat that as the pick — before the
    // create regex sees "5 minute timer"-shaped text and starts a new one.
    // Works for both pending-cancel and pending-extend prompts.
    try {
      const resolved = await resolveTimerDisambig(rawText, { deviceId });
      if (resolved) {
        console.log(`[chat] voice-timer disambig resolved device=${deviceId}`);
        onEvent({ type: 'token', text: resolved.confirmation, agent: agentId });
        onEvent({ type: 'done', agent: agentId });
        return;
      }
    } catch (e) {
      console.warn(`[chat] voice-timer disambig failed: ${e.message}`);
    }
    const extend = classifyTimerExtendIntent(rawText);
    if (extend) {
      try {
        const confirmation = await extendVoiceTimer({ userId, deviceId, addSeconds: extend.addSeconds, targetSeconds: extend.targetSeconds });
        console.log(`[chat] voice-timer extend: +${extend.addSeconds}s target=${extend.targetSeconds ?? '?'} device=${deviceId}`);
        onEvent({ type: 'token', text: confirmation, agent: agentId });
        onEvent({ type: 'done', agent: agentId });
        return;
      } catch (e) {
        console.warn(`[chat] voice-timer extend failed: ${e.message}`);
      }
    }
    const cancel = classifyTimerCancelIntent(rawText);
    if (cancel) {
      try {
        const confirmation = cancelVoiceTimer({ userId, deviceId, all: cancel.all, seconds: cancel.seconds });
        console.log(`[chat] voice-timer cancel: all=${cancel.all} seconds=${cancel.seconds ?? '?'} userId=${userId}`);
        onEvent({ type: 'token', text: confirmation, agent: agentId });
        onEvent({ type: 'done', agent: agentId });
        return;
      } catch (e) {
        console.warn(`[chat] voice-timer cancel failed: ${e.message}`);
      }
    }
    const timer = classifyTimerIntent(rawText);
    if (timer) {
      try {
        const confirmation = await createVoiceTimer({ userId, deviceId, seconds: timer.seconds });
        console.log(`[chat] voice-timer: ${timer.spoken} device=${deviceId}`);
        onEvent({ type: 'token', text: confirmation, agent: agentId });
        onEvent({ type: 'done', agent: agentId });
        return;
      } catch (e) {
        console.warn(`[chat] voice-timer failed: ${e.message}`);
      }
    }
  }

  if (source === 'voice-device' && typeof rawText === 'string') {
    const intent = classifyVoiceIntent(rawText);
    if (intent) {
      const { replaces } = executeVoiceIntent(intent, deviceId, userId);
      console.log(`[chat] voice-intent: ${intent.type}${intent.pct != null ? `=${intent.pct}` : ''} device=${deviceId ?? '?'} replaces=${replaces}`);
      if (replaces) {
        // Short audible confirmation so the user hears that the device
        // got it. Without this, "sydney stop" / "sydney volume 50" applies
        // silently and the user can't tell if anything happened. Routes
        // through the standard chat-event path → accumulator → sentence
        // queue → tts_worker_task → MP3 over the same /api/tts pipeline
        // a normal reply uses.
        //
        // Pause is the one place this is slightly awkward: the pause WS
        // message arrives at the device on a separate path and may apply
        // before the "okay" TTS finishes — accept the rough edge for v1
        // rather than reordering or per-intent confirmation strings.
        const confirmation = intent.type === 'pause' || intent.type === 'resume'
          ? null  // self-evident audio cue — no spoken confirmation needed
          : 'okay.';
        if (confirmation) {
          onEvent({ type: 'token', text: confirmation, agent: agentId });
        }
        onEvent({ type: 'done', agent: agentId });
        return;
      }
    }
  }

  const chatUser = getUser(userId);
  const isChild = chatUser?.role === 'child';

  // Honor accessSchedule on every incoming message — a session opened during
  // allowed hours cannot keep chatting past curfew.
  if (isUserTimeBlocked(userId)) {
    onEvent({ type: 'error', message: 'Access is restricted at this time. Please try again later.', agent: agentId ?? 'system' });
    return;
  }

  // Strict: the target agent must be in the caller's roster. No global-registry
  // fallback — that path let any authed user chat with another user's agents so
  // long as the model passed their allowedModels gate, consuming the agent
  // owner's API credits. getAgentsForUser is the canonical visibility list.
  let agent = getAgentsForUser(userId).find(a => a.id === agentId);
  if (!agent) {
    onEvent({ type: 'error', message: `Unknown agent: ${agentId}`, agent: agentId });
    return;
  }

  // Voice-device source → slim tool subset. Reasoning effort kept at the
  // agent default (typically 'high' for gpt-5.x — required for reliable
  // custom tool calling). The tool reduction alone trimmed a "what time
  // is it" round-trip from 61 s to ~3 s on sydney; dropping reasoning to
  // low was tested but caused the model to skip useful tool calls.
  if (source === 'voice-device' && Array.isArray(agent.tools) && agent.tools.length) {
    const originalCount = agent.tools.length;
    const slim = agent.tools.filter(t => VOICE_DEVICE_TOOL_ALLOWLIST.has(t.function?.name));
    agent = { ...agent, tools: slim };
    console.log(`[chat] voice-device source: tools ${originalCount} → ${slim.length}`);
  }

  // Model restriction check
  if (chatUser?.allowedModels != null && agent.model && !chatUser.allowedModels.includes(agent.model)) {
    onEvent({ type: 'error', message: `Model "${agent.model}" is not available for your account. Ask your admin to grant access.`, agent: agentId });
    return;
  }

  if (!rawText?.trim() && !rawAttachment) return;
  recordActivity(userId, agentId, { message: true });

  // Detect news preference commands
  const newsPrefIdx = detectNewsPref(rawText);
  if (newsPrefIdx !== null) {
    try {
      // Surgical: write just this user's profile.json. Don't bulk-rewrite
      // every user — saveUsers does directory garbage-collection that has
      // bitten us before (see feedback_master_key_never_overwrite).
      modifyUser(userId, u => { u.newsDefaultTopic = newsPrefIdx; });
    } catch (e) { console.warn('[chat] Failed to save news preference:', e.message); }
    onEvent({ type: 'news_pref_saved', topic: newsPrefIdx });
  }

  // Detect rename/re-emoji commands
  const rename = detectRenameCommand(rawText);
  if (rename) {
    // Strip null values so we only update what was actually specified
    const changes = Object.fromEntries(Object.entries(rename).filter(([, v]) => v != null));
    // If this is a custom agent owned by the user, update the agent itself
    const customAgent = loadCustomAgents().find(a => a.id === agentId && a.ownerId === userId);
    if (customAgent) {
      updateCustomAgent(agentId, changes);
      // Clear any stale per-user overrides for fields now canonical on the agent.
      // Surgical write — same reason as the news-pref site above.
      try {
        modifyUser(userId, u => {
          if (u.agentOverrides?.[agentId]) {
            for (const k of Object.keys(changes)) delete u.agentOverrides[agentId][k];
          }
        });
      } catch (e) { console.warn('[chat] Failed to clear agent overrides:', e.message); }
    } else {
      saveUserAgentOverride(userId, agentId, changes);
    }
    onBroadcast();
    const newName  = changes.name  ?? agent.name;
    const newEmoji = changes.emoji ?? agent.emoji ?? '';
    const reply = `Got it — I'll go by **${newName}**${newEmoji ? ` ${newEmoji}` : ''} from now on.`;
    onEvent({ type: 'token', text: reply, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: rawText, ts: Date.now() },
      { role: 'assistant', content: reply, ts: Date.now() }
    );
    return;
  }

  const scopedSessionKey = `${userId}_${agentId}`;
  abortControllers.get(scopedSessionKey)?.abort();
  const ac = new AbortController();
  abortControllers.set(scopedSessionKey, ac);
  activeStreams.set(scopedSessionKey, { userId, agentId, startTs: Date.now() });
  // Register this WS run so concurrent delegate calls queue behind it.
  // Key matches the scopedAgent.id used in streamChat (userId-scoped).
  const busySlot = markAgentBusy(scopedSessionKey);

  const scopedAgent = { ...agent, id: `${userId}_${agentId}` };
  {
    const now = new Date();
    const todayStr   = now.toISOString().slice(0, 10);
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const yearStart  = `${now.getFullYear()}-01-01`;
    const financeExtra = agent.skillCategory === 'finance'
      ? `\nUser ID: ${userId ?? 'default'}\nAlways pass this exact User ID to every expense tool call.`
      : '';
    // Voice-device chats: instruct the LLM to ALWAYS end clarification
    // replies with a question mark. The firmware uses that as the signal
    // to open a follow-up listen window so the user can answer without
    // saying the wake word again. Phrase deliberately as a hard rule —
    // without it we'd be sniffing reply text for "?" anywhere, which
    // false-positives on quoted questions.
    const voiceExtra = source === 'voice-device'
      ? `\n\n## Voice device follow-up\nThis chat is coming from a voice device with a microphone. When you need ANY clarification, confirmation, or further info from the user — ALWAYS phrase the LAST sentence of your reply as a direct question ending with "?". Don't trail off with imperative "say X" or "let me know" without a closing "?". The device uses this trailing "?" as the signal to keep listening for the user's answer; without it they have to say the wake word again to respond.`
      : '';
    scopedAgent.systemPrompt = `${agent.systemPrompt}\n\n## Current Date\nToday: ${todayStr}\nThis month: ${monthStart} to ${todayStr}\nThis year: ${yearStart} to ${todayStr}${financeExtra}${voiceExtra}`;
  }

  let userText   = rawText?.trim() ?? '';
  let attachment = rawAttachment ?? null;

  // Intercept "CONFIRM DELETION" — execute staged delete without hitting the model
  if (userText.toUpperCase() === 'CONFIRM DELETION' && getPendingDelete(userId)) {
    const result = await executePendingDelete(userId);
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: result, ts: Date.now() }
    );
    onEvent({ type: 'token', text: result, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    return;
  }
  if (getPendingDelete(userId)) clearPendingDelete(userId);

  // Intercept "APPROVE PURGE" — execute staged destructive email op
  if (userText.toUpperCase() === 'APPROVE PURGE' && getPendingEmail(userId)) {
    const result = await executePendingEmail(userId);
    const text = typeof result === 'string' ? result : (result?.text ?? String(result));
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: text, ts: Date.now() }
    );
    onEvent({ type: 'token', text, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    return;
  }
  if (getPendingEmail(userId)) clearPendingEmail(userId);

  // Intercept "APPROVE PROVEN" — execute staged trust-state promotion to proven
  if (userText.toUpperCase() === 'APPROVE PROVEN' && getPendingProven(userId)) {
    // executePendingProven returns either a string or whatever
    // execProfileSetTrustState yields (currently an object with optional
    // .text). Cast widens for the union-narrowing branch below.
    const result = /** @type {string | { text?: string }} */ (await executePendingProven(userId));
    const text = typeof result === 'string' ? result : (result?.text ?? String(result));
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: text, ts: Date.now() }
    );
    onEvent({ type: 'token', text, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    return;
  }
  if (getPendingProven(userId)) clearPendingProven(userId);

  // /trim on|off|status — runtime toggle of specialist-router tool trimming.
  // Lets you A/B latency the same query without restarting the server.
  const trimMatch = userText.match(/^\/trim(?:\s+(on|off|status))?\s*$/i);
  if (trimMatch) {
    const arg = (trimMatch[1] || 'status').toLowerCase();
    if (arg === 'on')  _specialistTrimEnabled = true;
    if (arg === 'off') _specialistTrimEnabled = false;
    console.log(`[chat] /trim ${arg} → enabled=${_specialistTrimEnabled}`);
    const state = _specialistTrimEnabled
      ? 'Tool-trim ON — router-fired turns use role-only tools (~5-13 each).'
      : 'Tool-trim OFF — router-fired turns use the specialist\'s full tool surface (~70-85 each).';
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: state, ts: Date.now() }
    );
    onEvent({ type: 'token', text: state, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    abortControllers.delete(scopedSessionKey);
    activeStreams.delete(scopedSessionKey);
    clearStreamBuffer(scopedSessionKey);
    busySlot.release();
    return;
  }

  // /threshold N — tune the embed-router cosine threshold live (default 0.72).
  // Higher = stricter (fewer paraphrases routed); lower = more permissive.
  // /threshold alone reports the current value.
  const thrMatch = userText.match(/^\/threshold(?:\s+(\d+(?:\.\d+)?))?\s*$/i);
  if (thrMatch) {
    const { getEmbedThreshold, setEmbedThreshold } = await import('./lib/specialist-embed-router.mjs');
    let reply;
    if (thrMatch[1] !== undefined) {
      const n = Number(thrMatch[1]);
      if (setEmbedThreshold(n)) reply = `Embed-router threshold set to ${n.toFixed(3)} (cosine similarity).`;
      else reply = 'Threshold must be a number between 0 and 1.';
    } else {
      reply = `Embed-router threshold is ${getEmbedThreshold().toFixed(3)} (cosine similarity). Use /threshold 0.7 to change.`;
    }
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: reply, ts: Date.now() }
    );
    onEvent({ type: 'token', text: reply, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    abortControllers.delete(scopedSessionKey);
    activeStreams.delete(scopedSessionKey);
    clearStreamBuffer(scopedSessionKey);
    busySlot.release();
    return;
  }

  // /claim <skillId> and /release <skillId>
  const claimMatch = userText.match(/^\/?(claim|release)\s+(\S+)/i);
  if (claimMatch) {
    const action  = claimMatch[1].toLowerCase();
    const skillId = claimMatch[2].toLowerCase();
    const manifest = getRoleManifest(skillId, userId);
    let result;
    if (!manifest) {
      const available = listRoles(userId).filter(m => m.category !== 'delegate' && !m.hidden).map(m => m.id).join(', ');
      result = `No role found with id "${skillId}". Available roles: ${available}`;
    } else if (manifest.category === 'delegate') {
      result = `${manifest.name} is a system role and cannot be assigned.`;
    } else if (action === 'release') {
      const assignments = getRoleAssignments(userId);
      if (assignments[skillId] !== agentId) {
        result = assignments[skillId]
          ? `${manifest.name} is owned by "${assignments[skillId]}", not this agent.`
          : `${manifest.name} isn't assigned to anyone.`;
      } else {
        setRoleAssignment(skillId, null, userId);
        result = `✓ Released **${manifest.name}** — now available to all agents.`;
      }
    } else {
      const assignments = getRoleAssignments(userId);
      const current = assignments[skillId];
      if (current === agentId) {
        result = `${manifest.name} is already assigned to this agent.`;
      } else {
        if (current) result = `✓ **${manifest.name}** transferred from "${current}" to **${agent.name}**.`;
        else result = `✓ **${manifest.name}** is now assigned to **${agent.name}**.`;
        setRoleAssignment(skillId, agentId, userId);
        // Add the skill to this user's enabled list — surgical write of just
        // this profile.json. Using saveUsers here would trigger a full users/
        // directory GC sweep (historical root cause of the master-key wipe;
        // see feedback_master_key_never_overwrite).
        try {
          modifyUser(userId, u => {
            if (u.skills && !u.skills.includes(skillId)) u.skills.push(skillId);
          });
        } catch {}
      }
    }
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: result, ts: Date.now() }
    );
    onEvent({ type: 'token', text: result, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    return;
  }

  // Finance file upload pre-processing
  const financeAgentId = getRoleAssignments(userId)?.['expenses'];
  if (financeAgentId && agentId === financeAgentId && attachment?.isFinanceFile) {
    try {
      const cfg  = loadConfig();
      const txns = (await extractTransactions(cfg, attachment)).filter(t => parseFloat(t.amount) > 0);
      const block = txns.length ? JSON.stringify(txns, null, 2) : '[]';
      userText = (userText || 'I uploaded a financial statement.') +
        `\n\n<uploaded_statement filename="${attachment.name}">\n${block}\n</uploaded_statement>`;
      const wantsSave = /\b(save|add|store|import|record|put)\b/i.test(userText);
      userText += wantsSave
        ? `\n\n${txns.length} transaction(s) were extracted. The user wants them saved — call expense_add_batch NOW with all transactions, then show a summary table.`
        : `\n\n${txns.length} transaction(s) were extracted. Show them in a table and ask the user if they'd like to save them.`;
    } catch (e) {
      userText = (userText || '') + `\n\n[File upload: ${attachment.name} — extraction failed: ${e.message}]`;
    }
    attachment = null;
  }

  // ── Home Assistant fast-path ─────────────────────────────────────────────
  // Runs before the LLM regardless of agent assignment. Matches "turn on/off
  // X", "toggle X", "activate/run <scene/script>" against the cached HA
  // entity-name index and executes the HA service directly. Multi-match or
  // miss → null → falls through to the LLM so "turn off all lights" etc.
  // still benefit from disambiguation. Recorded to the session like any
  // other reply so the chat UI shows it.
  if (userText) {
    try {
      const haIntent = await classifyHaIntent(userText, userId);
      if (haIntent) {
        const result = await executeHaIntent(haIntent);
        if (!result.error) {
          appendToSession(`${userId}_${agentId}`,
            { role: 'user', content: userText, ts: Date.now() },
            { role: 'assistant', content: result.text, ts: Date.now() }
          );
          onEvent({ type: 'token', text: result.text, agent: agentId });
          onEvent({ type: 'done', agent: agentId });
          console.log(`[chat] ha-fastpath: ${haIntent.verb} ${haIntent.entity_id}`);
          // Release the busy slot / abort / active-stream tracking so the
          // next message doesn't queue behind this turn forever.
          abortControllers.delete(scopedSessionKey);
          activeStreams.delete(scopedSessionKey);
          clearStreamBuffer(scopedSessionKey);
          busySlot.release();
          return;
        }
        // Tool errored — log and fall through to LLM, which can try a
        // different approach (list_devices to find the right entity, etc.)
        console.log(`[chat] ha-fastpath miss-then-error: ${result.error} — falling through to LLM`);
      }
    } catch (e) {
      console.warn('[chat] ha-fastpath threw, falling through:', e.message);
    }
  }

  // ── Routine fast-path (voice device only) ────────────────────────────────
  // User-defined "trigger phrase → ordered action list" — e.g. "goodnight"
  // dims lights via HA and starts a looped ambient sound on the originating
  // device. Strict equality match against the normalized trigger/aliases,
  // executed in lib/routines.mjs. Runs only on voice-device source so that
  // typing "goodnight" in a browser chat falls through to the normal LLM.
  if (source === 'voice-device' && userText && deviceId && !_isRoutineFollowup) {
    try {
      const routine = classifyRoutineIntent(userText, userId);
      if (routine) {
        // routine.device_id, if set, overrides the originating device for
        // play_ambient + tts_say. Example: "goodnight" on the kitchen mic
        // can still play sounds in the bedroom. The originating device's WS
        // still gets the `done` event so its chat stream closes cleanly.
        const targetDeviceId = resolveRoutineDeviceId(routine, deviceId);
        const targetDiffers = targetDeviceId && targetDeviceId !== deviceId;
        const result = await executeRoutine(routine, { userId, deviceId: targetDeviceId });
        const reply = result.text || '';
        // When the routine targets a different device, push the spoken reply
        // to THAT device via the MP3-marker path. Don't stream it over the
        // originating device's WS (that'd speak the reply in the wrong room).
        if (reply && targetDiffers) {
          try {
            await speakReminder({ userId, deviceIds: [targetDeviceId], text: reply, prefix: '', chime: false });
          } catch (e) {
            console.warn(`[chat] routine cross-device tts push failed: ${e.message}`);
          }
        }
        // If a run_prompt action is in the routine, the trigger phrase
        // becomes a setup step — speak the routine's collected text first,
        // then hand the prompt off to the user's coordinator agent. The
        // coordinator's reply streams to TTS on the same device via the
        // normal chat pipeline.
        if (result.followupPrompt) {
          appendToSession(`${userId}_${agentId}`,
            { role: 'user', content: userText, ts: Date.now() },
          );
          if (reply) {
            appendToSession(`${userId}_${agentId}`,
              { role: 'assistant', content: reply, ts: Date.now() },
            );
            // Skip the WS token push when the routine is bound to a different
            // device — speakReminder above already spoke it in the right room.
            if (!targetDiffers) onEvent({ type: 'token', text: reply, agent: agentId });
          }
          console.log(`[chat] routine-fastpath: ${routine.id} → followup prompt`);
          // Release the busy slot BEFORE recursing so the followup can claim
          // its own slot via markAgentBusy. Cleanup the abortController for
          // the trigger turn — the followup gets a fresh one.
          abortControllers.delete(scopedSessionKey);
          activeStreams.delete(scopedSessionKey);
          clearStreamBuffer(scopedSessionKey);
          busySlot.release();
          // Re-enter with the followup prompt as the new user message.
          // _isRoutineFollowup is a defensive bypass so a prompt that
          // accidentally matches another routine trigger doesn't loop. The
          // followup goes to the routine's target device so its LLM reply
          // streams to the same room as the routine's spoken bits.
          await handleChatMessage({
            userId, agentId, text: result.followupPrompt,
            attachment: null, source, deviceId: targetDeviceId, wakeSlot,
            onEvent, onBroadcast, onNotify,
            _isRoutineFollowup: true,
          });
          return;
        }
        appendToSession(`${userId}_${agentId}`,
          { role: 'user', content: userText, ts: Date.now() },
          { role: 'assistant', content: reply || '(routine executed silently)', ts: Date.now() }
        );
        // Only stream the spoken reply over the originating WS when the
        // routine fires on that same device — otherwise speakReminder above
        // has already pushed it to the target device.
        if (reply && !targetDiffers) onEvent({ type: 'token', text: reply, agent: agentId });
        onEvent({ type: 'done', agent: agentId });
        console.log(`[chat] routine-fastpath: ${routine.id} actions=${routine.actions.length} errors=${result.errors.length}`);
        abortControllers.delete(scopedSessionKey);
        activeStreams.delete(scopedSessionKey);
        clearStreamBuffer(scopedSessionKey);
        busySlot.release();
        return;
      }
    } catch (e) {
      console.warn('[chat] routine-fastpath threw, falling through:', e.message);
    }
  }

  // ── Trivia fast-path (clock) ─────────────────────────────────────────────
  // "what time is it", "what's the date", "what day is it" — answered
  // straight from the user-local clock with no LLM round-trip. Strict
  // end-anchored regex set, so "what time is it in tokyo" falls through.
  if (userText) {
    try {
      const { classifyTriviaIntent, executeTriviaIntent } = await import('./lib/trivia-fastpath.mjs');
      const triviaIntent = classifyTriviaIntent(userText);
      if (triviaIntent) {
        const result = executeTriviaIntent(triviaIntent, userId);
        if (result?.text) {
          appendToSession(`${userId}_${agentId}`,
            { role: 'user', content: userText, ts: Date.now() },
            { role: 'assistant', content: result.text, ts: Date.now() }
          );
          onEvent({ type: 'token', text: result.text, agent: agentId });
          onEvent({ type: 'done', agent: agentId });
          console.log(`[chat] trivia-fastpath: ${triviaIntent.kind}`);
          abortControllers.delete(scopedSessionKey);
          activeStreams.delete(scopedSessionKey);
          clearStreamBuffer(scopedSessionKey);
          busySlot.release();
          return;
        }
      }
    } catch (e) {
      console.warn('[chat] trivia-fastpath threw, falling through:', e.message);
    }
  }

  // ── Specialist router (pre-LLM) ──────────────────────────────────────────
  // When the user is on their coordinator and the message clearly belongs to
  // one specialist (via that role's intent_patterns), run the specialist
  // directly and skip the coordinator's reasoning turns. Saves ~3-5s per
  // turn vs Sydney's "decide → call list_roles → call ask_agent" path.
  if (userText) {
    try {
      /** @type {{ skillId: string, agentId: string, name: string, strategy?: string, sim?: number, phrase?: string } | null} */
      let route = classifySpecialistIntent(userText, userId, agentId);
      // Embedding fallback: when regex misses, try semantic similarity against
      // the loaded intent_examples. Catches paraphrases regex can't enumerate.
      // ~20ms added cost only when we'd otherwise fall through to Sydney.
      if (!route && userText.length >= 6) {
        try {
          const { classifyByEmbedding } = await import('./lib/specialist-embed-router.mjs');
          const emb = await classifyByEmbedding(userText, userId, agentId);
          if (emb) {
            route = { skillId: emb.skillId, agentId: emb.agentId, name: emb.name, strategy: 'embed', sim: emb.sim };
            console.log(`[chat] embed-router: → ${emb.name} (${emb.skillId}) sim=${emb.sim.toFixed(3)} via "${emb.phrase}"`);
          }
        } catch (e) {
          console.warn('[chat] embed-router threw, falling through:', e.message);
        }
      }
      if (route) {
        const target = getAgentsForUser(userId).find(a => a.id === route.agentId);
        if (target) {
          // Ephemeral scoped agent for the specialist run — same pattern as
          // skills/delegate/execute.mjs so the specialist's own persistent
          // session isn't polluted with a one-shot coordinator delegation.
          const delegId = `ephemeral_router_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${route.agentId}`;
          const scopedSpec = { ...target, id: delegId, ephemeral: true };
          // Tool-surface reduction: a router-fired turn is a single intent
          // matched to one specialist — we know which skill should answer.
          // Trim the specialist's tool surface to that skill's own tools so
          // gpt-5.x doesn't reason through 70-80 unrelated tools per turn.
          // Toggleable at runtime via `/trim on|off` for A/B latency tests.
          const fullToolCount = target.tools?.length ?? 0;
          let usedToolCount = fullToolCount;
          if (_specialistTrimEnabled) {
            const skillTools = getRoleTools(route.skillId, userId);
            if (skillTools.length) {
              scopedSpec.tools = skillTools;
              usedToolCount = skillTools.length;
            }
          }
          console.log(`[chat] specialist-router: trim=${_specialistTrimEnabled ? 'on' : 'off'} tools=${usedToolCount} (full=${fullToolCount})`);
          const routerStart = Date.now();
          {
            const now = new Date();
            const todayStr   = now.toISOString().slice(0, 10);
            const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const yearStart  = `${now.getFullYear()}-01-01`;
            scopedSpec.systemPrompt = `${target.systemPrompt}\n\n## Current Date\nToday: ${todayStr}\nThis month: ${monthStart} to ${todayStr}\nThis year: ${yearStart} to ${todayStr}`;
          }
          console.log(`[chat] specialist-router: → ${route.name} (${route.skillId}) agent=${route.agentId}`);
          let routerBuf = '';
          try {
            for await (const event of streamChat(scopedSpec, userText, ac.signal, (e) => {
              onEvent({ ...e, agent: agentId });
            }, userId, attachment, null, false, { source, deviceId })) {
              if (event.type === '__notify') { onNotify(userId, agentId, event); continue; }
              if (event.type === '__usage')  { recordTokenUsage(userId, event.inputTokens, event.outputTokens, event.provider, event.model); continue; }
              if (event.type === 'token')    routerBuf += event.text;
              if (event.type === 'replace')  routerBuf = event.text;
              onEvent({ ...event, agent: agentId });
            }
            // Persist the turn under the coordinator's session so the user
            // sees it in the chat they actually typed into. The specialist
            // ran ephemerally, so this is the only durable record.
            appendToSession(`${userId}_${agentId}`,
              { role: 'user', content: userText, ts: Date.now() },
              { role: 'assistant', content: routerBuf, ts: Date.now() }
            );
            console.log(`[chat] specialist-router done: skill=${route.skillId} trim=${_specialistTrimEnabled ? 'on' : 'off'} tools=${usedToolCount} durationMs=${Date.now() - routerStart} bytes=${routerBuf.length}`);
          } catch (e) {
            if (e.name !== 'AbortError') {
              console.error('[chat] specialist-router stream failed:', e.message);
              onEvent({ type: 'error', message: e.message, agent: agentId });
            }
          } finally {
            // Mirror the main dispatch finally so the busy slot / abort /
            // active-stream tracking doesn't leak just because we took the
            // fast-path.
            recordActivity(userId, agentId, { apiCall: true });
            abortControllers.delete(scopedSessionKey);
            activeStreams.delete(scopedSessionKey);
            clearStreamBuffer(scopedSessionKey);
            busySlot.release();
          }
          return;
        }
      }
    } catch (e) {
      console.warn('[chat] specialist-router threw, falling through:', e.message);
    }
  }

  // ── Scheduler-intent interceptor ─────────────────────────────────────────
  // Runs before the LLM on every chat regardless of which agent the user is
  // talking to, so scheduling works system-wide without needing the tasks
  // skill assigned. Matches are routed through the fine-tuned plan model;
  // misses fall through unchanged. The outcome line is prepended as a
  // system note so the agent can narrate success/failure in its reply
  // rather than us sending a canned message.
  let schedulerNote = null;
  if (userText) {
    try {
       const recentHistory = loadSession(`${userId}_${agentId}`, 6);
       const intercept = await interceptScheduling({ userId, agentId, text: userText, history: recentHistory });
      if (intercept.matched) {
        schedulerNote = `<scheduler_result>\n${intercept.outcome}\n</scheduler_result>`;
      }
    } catch (e) {
      console.warn('[chat-dispatch] scheduler intercept threw:', e.message);
    }
  }

  {
    const _now = new Date();
    const _timeNote = `<current_time>${_now.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</current_time>`;
    schedulerNote = schedulerNote ? `${_timeNote}\n${schedulerNote}` : _timeNote;
  }

  // ── Retriable error patterns for provider failover ──────────────────────
  const RETRIABLE_RE = /\b(5\d{2}|timeout|timed out|rate limit|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed)\b/i;

  let _streamBuf = '';
  async function runStream(agentObj) {
    for await (const event of streamChat(agentObj, userText, ac.signal, (e) => {
      onEvent({ ...e, agent: agentId });
    }, userId ?? 'default', attachment, schedulerNote, false, { source, deviceId })) {
      if (event.type === '__notify') { onNotify(userId, agentId, event); continue; }
      if (event.type === '__usage')  { recordTokenUsage(userId, event.inputTokens, event.outputTokens, event.provider, event.model); continue; }
      // Check if this error is retriable — return it instead of emitting
      if (event.type === 'error' && RETRIABLE_RE.test(event.message ?? '')) {
        return event; // signal caller to attempt failover
      }
      // Accumulate stream content for persistence buffer
      if (event.type === 'token')   _streamBuf += event.text;
      if (event.type === 'replace') _streamBuf = event.text;
      if (_streamBuf) writeStreamBuffer(scopedSessionKey, _streamBuf);
      onEvent({ ...event, agent: agentId });
    }
    return null; // success
  }

  try {
    const failoverError = await runStream(scopedAgent);

    // ── Provider failover ──────────────────────────────────────────────────
    if (failoverError) {
      const cfg = loadConfig();
      const fo = cfg.providerFailover;
      if (fo?.enabled && fo?.fallbackProvider && fo?.fallbackModel) {
        console.log(`[failover] Primary ${scopedAgent.provider}/${scopedAgent.model} failed: ${failoverError.message} — trying ${fo.fallbackProvider}/${fo.fallbackModel}`);
        onEvent({ type: 'token', text: `_Retrying with ${fo.fallbackProvider}/${fo.fallbackModel}…_\n\n`, agent: agentId });

        const fallbackAgent = {
          ...scopedAgent,
          provider: fo.fallbackProvider,
          model: fo.fallbackModel,
        };
        const fallbackError = await runStream(fallbackAgent);
        if (fallbackError) {
          onEvent({ ...fallbackError, agent: agentId });
        }
      } else {
        // No failover configured — emit the original error
        onEvent({ ...failoverError, agent: agentId });
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      // Surface the underlying network reason when present — bare "fetch failed"
      // is useless to debug; "fetch failed (ECONNRESET)" is actionable.
      const causeTag = e?.cause?.code || e?.cause?.message;
      const enrichedMessage = causeTag && !e.message?.includes(causeTag)
        ? `${e.message} (${causeTag})`
        : e.message;
      log.error('chat', 'turn threw', {
        userId, agentId,
        provider: scopedAgent.provider,
        model: scopedAgent.model,
        err: enrichedMessage,
        causeCode: e?.cause?.code,
      });

      // Attempt failover on thrown errors too (e.g. fetch failures)
      const cfg = loadConfig();
      const fo = cfg.providerFailover;
      if (fo?.enabled && fo?.fallbackProvider && fo?.fallbackModel && RETRIABLE_RE.test(e.message ?? '')) {
        console.log(`[failover] Primary threw: ${enrichedMessage} — trying ${fo.fallbackProvider}/${fo.fallbackModel}`);
        onEvent({ type: 'token', text: `_Retrying with ${fo.fallbackProvider}/${fo.fallbackModel}…_\n\n`, agent: agentId });
        try {
          const fallbackAgent = { ...scopedAgent, provider: fo.fallbackProvider, model: fo.fallbackModel };
          const fallbackError = await runStream(fallbackAgent);
          if (fallbackError) onEvent({ ...fallbackError, agent: agentId });
        } catch (e2) {
          if (e2.name !== 'AbortError') {
            const cause2 = e2?.cause?.code || e2?.cause?.message;
            const msg2 = cause2 && !e2.message?.includes(cause2) ? `${e2.message} (${cause2})` : e2.message;
            onEvent({ type: 'error', message: msg2, agent: agentId });
          }
        }
      } else {
        onEvent({ type: 'error', message: enrichedMessage, agent: agentId });
      }
    }
  } finally {
    // Follow-up listening: if the reply contains a question OR an
    // imperative asking the user to say/tell/respond, open a short listen
    // window so the user can answer without saying the wake word again.
    // The system prompt instructs the LLM to use a trailing "?" — these
    // imperatives are a safety net for when it doesn't. Only sends for
    // voice-device sources.
    if (source === 'voice-device' && deviceId) {
      const reply = (_streamBuf || '').trim();
      const HAS_QUESTION = /[?？]/;
      // Patterns: "please say X", "say 'X'", "tell me X", "let me know",
      // "do you mean", "did you mean" — common LLM hedges that ask for
      // user input without a literal "?".
      const ASKS_FOR_REPLY = /\b(please\s+(say|tell|repeat)|say\s+["'“]|tell\s+me|let\s+me\s+know|d(o|id)\s+you\s+mean)\b/i;
      if (HAS_QUESTION.test(reply) || ASKS_FOR_REPLY.test(reply)) {
        sendToDevice(deviceId, { type: 'await_followup', windowMs: 5000 });
      }
    }
    recordActivity(userId, agentId, { apiCall: true });
    abortControllers.delete(scopedSessionKey);
    activeStreams.delete(scopedSessionKey);
    clearStreamBuffer(scopedSessionKey);
    busySlot.release();
  }
}
