// @ts-check
/**
 * chat-dispatch/fastpaths.mjs
 *
 * Pre-LLM fast-paths that handle a user turn end-to-end without invoking the
 * model. Each emits its reply to the WS chat stream, appends the turn to the
 * session, and returns `{handled: true}` so the caller can finalize the slot
 * and return. The caller still owns finalizeTurn() because the cleanup tuple
 * lives next to the abortController / busy-slot that's set up in handleChatMessage.
 *
 *   1. Home Assistant — "turn on/off X", "lock X", "set X to N%", etc.
 *   2. Routine        — user-defined trigger → ordered action list
 *                       (voice-device only; may return a `followupPrompt`
 *                       that re-enters handleChatMessage)
 *   3. Trivia (clock) — "what time is it", "what's the date", etc.
 */

import { appendToSession } from '../sessions.mjs';
import { classifyRoutineIntent, executeRoutine, resolveRoutineDeviceId } from '../lib/routines.mjs';
import { speakReminder } from '../lib/voice-reminder.mjs';

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
  const { resolveAlias } = await import('../lib/ha-aliases.mjs');
  const aliased = resolveAlias(userId, phrase);
  if (aliased) {
    const domain = aliased.split('.', 1)[0];
    // The friendly name shown in the spoken confirmation — derive from the
    // entity_id when we don't have a cached one (alias may point at an entity
    // the cache hasn't picked up yet on a fresh install).
    const { ensureCache } = await import('../lib/ha-cache.mjs');
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
  const { lookupEntity } = await import('../lib/ha-cache.mjs');
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

async function executeHaIntent(intent) {
  const { getHaConfig, haRequest } = await import('../lib/ha-client.mjs');
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
 * Try the HA fast-path. Returns {handled: true} after emit + persist on a
 * successful HA service call; null on miss OR on tool-error (LLM gets a
 * chance to recover, e.g. by calling list_devices to find the right entity).
 *
 * @returns {Promise<{ handled: true } | null>}
 */
export async function tryHaFastpath({ userText, userId, agentId, onEvent }) {
  if (!userText) return null;
  try {
    const haIntent = await classifyHaIntent(userText, userId);
    if (!haIntent) return null;
    const result = await executeHaIntent(haIntent);
    if (result.error) {
      console.log(`[chat] ha-fastpath miss-then-error: ${result.error} — falling through to LLM`);
      return null;
    }
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: result.text, ts: Date.now() }
    );
    onEvent({ type: 'token', text: result.text, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    console.log(`[chat] ha-fastpath: ${haIntent.verb} ${haIntent.entity_id}`);
    return { handled: true };
  } catch (e) {
    console.warn('[chat] ha-fastpath threw, falling through:', e.message);
    return null;
  }
}

/**
 * Try the routine fast-path. Voice-device only. On match, executes the routine
 * (lights, ambient, etc.) and emits the spoken reply. If the routine contains
 * a `run_prompt` action, returns `{handled: true, followupPrompt, targetDeviceId}`
 * so the caller can re-enter handleChatMessage with that prompt as the new
 * user message.
 *
 * @returns {Promise<{ handled: true, followupPrompt?: string, targetDeviceId?: string } | null>}
 */
export async function tryRoutineFastpath({ source, userText, userId, agentId, deviceId, _isRoutineFollowup, onEvent }) {
  if (!(source === 'voice-device' && userText && deviceId && !_isRoutineFollowup)) return null;
  try {
    const routine = classifyRoutineIntent(userText, userId);
    if (!routine) return null;
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
    // If a run_prompt action is in the routine, the trigger phrase becomes a
    // setup step — speak the routine's collected text first, then signal the
    // caller to hand the prompt off to the user's coordinator agent.
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
      return { handled: true, followupPrompt: result.followupPrompt, targetDeviceId };
    }
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: reply || '(routine executed silently)', ts: Date.now() }
    );
    // Only stream the spoken reply over the originating WS when the routine
    // fires on that same device — otherwise speakReminder above has already
    // pushed it to the target device.
    if (reply && !targetDiffers) onEvent({ type: 'token', text: reply, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    console.log(`[chat] routine-fastpath: ${routine.id} actions=${routine.actions.length} errors=${result.errors.length}`);
    return { handled: true };
  } catch (e) {
    console.warn('[chat] routine-fastpath threw, falling through:', e.message);
    return null;
  }
}

/**
 * Try the trivia (clock) fast-path: "what time is it", "what's the date",
 * "what day is it" — answered straight from the user-local clock with no
 * LLM round-trip. Strict end-anchored regex set in lib/trivia-fastpath.mjs,
 * so "what time is it in tokyo" falls through.
 *
 * @returns {Promise<{ handled: true } | null>}
 */
export async function tryTriviaFastpath({ userText, userId, agentId, onEvent }) {
  if (!userText) return null;
  try {
    const { classifyTriviaIntent, executeTriviaIntent } = await import('../lib/trivia-fastpath.mjs');
    const triviaIntent = classifyTriviaIntent(userText);
    if (!triviaIntent) return null;
    const result = executeTriviaIntent(triviaIntent, userId);
    if (!result?.text) return null;
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: result.text, ts: Date.now() }
    );
    onEvent({ type: 'token', text: result.text, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    console.log(`[chat] trivia-fastpath: ${triviaIntent.kind}`);
    return { handled: true };
  } catch (e) {
    console.warn('[chat] trivia-fastpath threw, falling through:', e.message);
    return null;
  }
}
