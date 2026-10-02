// One account's saved HA bindings, device aliases and learned tool phrases.
import { createHash } from 'node:crypto';
import { loadLearnedIntents, removeLearnedUtterance, bindHaFastpath } from './learned-intents.mjs';
import { loadAliases, deleteAlias, normalizeAliasPhrase } from './ha-aliases.mjs';
import { classifyRoutineIntent, normalizePhrase, loadRoutines } from './routines.mjs';

const HA_SKILL = 'role_home_assistant';
const HA_TOOL = 'ha_call_service';
const rowId = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const validUser = userId => typeof userId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(userId);

export function findSavedHaFastpath(userId, text) {
  if (!validUser(userId)) return null;
  const entries = Object.values(loadLearnedIntents(userId)[HA_SKILL] || {})
    .filter(entry => entry?.tool === HA_TOOL && entry.fixedArgs && Array.isArray(entry.utterances));
  if (!entries.length) return null;
  const phrase = normalizePhrase(text);
  return entries.find(entry => entry.utterances.some(value => normalizePhrase(value) === phrase)) || null;
}

export async function teachHaFastpath(userId, phrase, input) {
  if (!validUser(userId)) throw new RangeError('A logged-in account is required.');
  if (typeof phrase !== 'string' || phrase.trim().length < 3 || phrase.length > 200 || !normalizePhrase(phrase)) {
    throw new RangeError('phrase must be 3-200 characters.');
  }
  const { isSkillRuntimeEnabledForUser } = await import('../roles.mjs');
  const { getHiddenTools } = await import('./skill-overrides.mjs');
  if (!isSkillRuntimeEnabledForUser(HA_SKILL, userId) || getHiddenTools(userId, HA_SKILL).includes(HA_TOOL)) {
    throw new RangeError('Home Assistant device control is not enabled for your account.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RangeError('Provide tool_args with the exact entity_id and service. Discover the device first; ask which device if ambiguous.');
  }
  const entity_id = input.entity_id;
  const parts = String(input.service || '').split('.');
  let domain = parts.length === 2 ? parts[0] : input.domain || String(entity_id || '').split('.')[0];
  const service = parts.at(-1);
  if (parts.length > 2 || !/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(entity_id || '')
      || !/^[a-z][a-z0-9_]*$/.test(domain || '') || !/^[a-z][a-z0-9_]*$/.test(service)) {
    throw new RangeError('Provide one exact HA entity_id and a valid service.');
  }
  if (input.data != null && (typeof input.data !== 'object' || Array.isArray(input.data))) throw new RangeError('data must be an object.');
  const data = input.data || {};
  if (Object.keys(data).some(key => ['entity_id', 'device_id', 'area_id', 'target', '__proto__', 'constructor', 'prototype'].includes(key))) {
    throw new RangeError('Set the target only in entity_id, outside data.');
  }
  const { getHaConfig, haRequest } = await import('./ha-client.mjs');
  const { readHaState } = await import('./ha-service.mjs');
  const config = getHaConfig();
  if (!config) throw new RangeError('Home Assistant is not configured.');
  const state = await readHaState(config, entity_id);
  if (state?.__err || state?.entity_id !== entity_id) throw new RangeError('That HA entity could not be found. Discover the device before saving.');
  const { getHaDeviceCatalog, validateHaDeviceAction } = await import('./ha-device-catalog.mjs');
  const catalog = await getHaDeviceCatalog();
  const device = catalog.devices.find(device => device.controls.some(control => control.entity_id === entity_id));
  if (device) {
    if (domain === 'homeassistant' && ['turn_on', 'turn_off', 'toggle'].includes(service)) domain = entity_id.split('.')[0];
    validateHaDeviceAction({ ha_device_id: device.id, domain, service, data: { ...data, entity_id } }, catalog.devices);
  } else {
    // HA helpers/scenes need not belong to a physical device. Validate their
    // service without inventing a physical registry entry or sending a call.
    const services = await haRequest(config, '/services');
    const definition = Array.isArray(services) && services.find(item => item.domain === domain)?.services?.[service];
    if (!definition || ![entity_id.split('.')[0], 'homeassistant'].includes(domain)) throw new RangeError('Choose an available HA service for this entity.');
    if (!['scene', 'script', 'group', 'input_boolean', 'light', 'switch'].includes(entity_id.split('.')[0])
        || Object.keys(data).length || !['turn_on', 'turn_off', 'toggle'].includes(service)) {
      throw new RangeError('Use an exposed physical-device control for a fast path with settings, or create a routine.');
    }
  }
  const fixedArgs = { domain, service, entity_id, ...(Object.keys(data).length ? { data } : {}) };
  await bindHaFastpath(userId, phrase, fixedArgs);
  const routine = classifyRoutineIntent(phrase, userId);
  return { fixedArgs, deviceName: state.attributes?.friendly_name || entity_id, routine: routine?.trigger || null };
}

export async function listSavedFastpaths(userId) {
  if (!validUser(userId)) return [];
  const { listRoles, isSkillRuntimeEnabledForUser } = await import('../roles.mjs');
  const { getHiddenTools } = await import('./skill-overrides.mjs');
  const { localTierEnabled, learningEnabled } = await import('./local-label.mjs');
  const roles = listRoles(userId);
  const enabled = (skillId, tool) => isSkillRuntimeEnabledForUser(skillId, userId) && !getHiddenTools(userId, skillId).includes(tool);
  const rows = [];
  for (const [skillId, intents] of Object.entries(loadLearnedIntents(userId))) {
    for (const [intentId, entry] of Object.entries(intents || {})) {
      for (const phrase of Array.isArray(entry?.utterances) ? entry.utterances : []) {
        if (typeof phrase !== 'string') continue;
        const bound = skillId === HA_SKILL && entry.tool === HA_TOOL && !!entry.fixedArgs;
        const routine = classifyRoutineIntent(phrase, userId);
        rows.push({ id: rowId(['learned', skillId, intentId, phrase]), kind: bound ? 'device' : 'learned',
          phrase, skillId, intentId, tool: entry.tool, skillName: roles.find(role => role.id === skillId)?.name || skillId,
          ...(bound ? { args: entry.fixedArgs } : {}),
          active: enabled(skillId, entry.tool) && (bound || (localTierEnabled() && learningEnabled())),
          routines: routine ? [routine.trigger] : [] });
      }
    }
  }
  const routines = loadRoutines(userId).routines;
  for (const [phrase, entityId] of Object.entries(loadAliases(userId))) {
    if (typeof entityId !== 'string') continue;
    const overlaps = routines.filter(routine => [routine.trigger, ...routine.aliases].some(trigger => {
      const noun = normalizePhrase(trigger).match(/^(?:turn on|turn off|toggle|lock|unlock|open|close|activate|run)\s+(.+)$/)?.[1]
        || normalizePhrase(trigger).match(/^set\s+(.+?)\s+to\s+/)?.[1];
      return noun && normalizeAliasPhrase(noun) === normalizeAliasPhrase(phrase);
    }));
    rows.push({ id: rowId(['alias', phrase]), kind: 'alias', phrase, entityId,
      active: enabled(HA_SKILL, HA_TOOL), routines: overlaps.map(routine => routine.trigger) });
  }
  return rows.sort((a, b) => a.phrase.localeCompare(b.phrase));
}

export async function removeSavedFastpath(userId, id) {
  const row = (await listSavedFastpaths(userId)).find(row => row.id === id);
  if (!row) return false;
  if (row.kind === 'alias') return deleteAlias(userId, row.phrase);
  return (await removeLearnedUtterance(userId, row.skillId, row.intentId, row.phrase)).ok;
}
