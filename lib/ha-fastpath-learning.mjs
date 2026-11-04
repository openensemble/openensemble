// Learn the completed call, never a model's suggested action or cached answer.
import { bindHaFastpath } from './learned-intents.mjs';
import { findSavedHaFastpath, normalizeHaFastpathArgs } from './saved-fastpaths.mjs';
import { classifyRoutineIntent, normalizePhrase } from './routines.mjs';
import { learningEnabled } from './local-label.mjs';
import { listLearningPolicy } from './learning-policy.mjs';

const SUPPORT_TOOLS = new Set([
  'ha_list_areas', 'ha_list_devices', 'ha_list_services', 'ha_get_state',
  'request_tools', 'recall_facts',
]);
const COMMAND_RE = /^(?:(?:can|could|would) you )?(?:turn|switch|set|dim|brighten|toggle|activate|run|lock|unlock|open|close|start|stop|pause|resume|mute|unmute)\s+(.+)$/;
const SHORT_SETTING_RE = /^(.+?)\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*(%|percent|degrees?)?$/;
// These need conversational context, a future condition, or additional work.
const CONTEXT_RE = /\b(?:it|its|them|their|this|that|these|those|there|here|same|again|previous|last|other|another|instead|back|and|or|then|also|all|both|each|everything|after|before|when|if|unless|until|tomorrow|later|tonight|noon|midnight|every|daily|schedule|remind|remember|save|forget|dont|do not|never|not|more|less|brighter|dimmer|warmer|cooler|seconds?|minutes?|hours?|days?)\b|\b(?:in|for)\s+\d|\bat\s+\d|[;\n?]/;
const SENSITIVE_KEY_RE = /code|pin|token|secret|password|auth|bearer|(?:^|_)key$/i;

function hasSensitiveData(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => SENSITIVE_KEY_RE.test(key) || hasSensitiveData(child));
}

async function matchesShortSetting(match, fixedArgs, userId) {
  const value = Number(match[2]);
  const { domain, service, entity_id, data = {} } = fixedArgs;
  let executedValue;
  if (domain === 'light' && service === 'turn_on') {
    executedValue = data.brightness_pct ?? (Number.isFinite(data.brightness) ? data.brightness / 255 * 100 : undefined);
  } else if (domain === 'fan' && service === 'set_percentage') executedValue = data.percentage;
  else if (domain === 'media_player' && service === 'volume_set') executedValue = Number.isFinite(data.volume_level) ? data.volume_level * 100 : undefined;
  else if (domain === 'cover' && service === 'set_cover_position') executedValue = data.position;
  else if (domain === 'climate' && service === 'set_temperature') executedValue = data.temperature;
  else return false;
  if (!Number.isFinite(executedValue) || Math.abs(executedValue - value) > 0.2) return false;
  if (domain === 'climate' ? /^(?:%|percent)$/.test(match[3] || '') : value > 100 || /^degree/.test(match[3] || '')) return false;

  // A bare setting must name the actual resolved target. Use only existing
  // aliases/state metadata; learning must not add another HA discovery call.
  const { resolveAlias, normalizeAliasPhrase } = await import('./ha-aliases.mjs');
  const target = normalizeAliasPhrase(match[1]);
  const alias = resolveAlias(userId, target, { suppressLearning: true });
  if (alias) return alias === entity_id;
  const { getCachedHaState } = await import('./ha-websocket.mjs');
  const name = getCachedHaState(entity_id)?.attributes?.friendly_name;
  return [entity_id, entity_id.split('.')[1], name].filter(Boolean)
    .some(candidate => normalizeAliasPhrase(candidate) === target);
}

export async function learnHaFastpathFromTurn({ userId, userMessage, toolsUsed = [] }) {
  if (!userId || typeof userMessage !== 'string' || userMessage.length > 200) return false;
  const calls = toolsUsed.filter(tool => tool?.name === 'ha_call_service');
  if (calls.length !== 1 || toolsUsed.some(tool => tool?.name !== 'ha_call_service' && !SUPPORT_TOOLS.has(tool?.name))) return false;
  const phrase = normalizePhrase(userMessage.trim());
  const shortSetting = COMMAND_RE.test(phrase) ? null : phrase.match(SHORT_SETTING_RE);
  if ((!COMMAND_RE.test(phrase) && !shortSetting) || CONTEXT_RE.test(phrase) || /\b(?:increase|decrease|raise|lower|up|down|by)\b/.test(phrase)) return false;
  if (/\b(?:dim|brighten)\b/.test(phrase) && !/\bto\s+(?:\d|full\b|max\b|minimum\b)/.test(phrase)) return false;
  try {
    if (!learningEnabled()) return false;
    const policy = listLearningPolicy(userId);
    if (policy.enabled === false || policy.kinds?.learned_intent?.enabled === false) return false;
    const { isSkillRuntimeEnabledForUser } = await import('../roles.mjs');
    const { getHiddenTools } = await import('./skill-overrides.mjs');
    if (!isSkillRuntimeEnabledForUser('role_home_assistant', userId)
        || getHiddenTools(userId, 'role_home_assistant').includes('ha_call_service')) return false;
    if (findSavedHaFastpath(userId, phrase)) return true;
    if (classifyRoutineIntent(phrase, userId)) return false;
    const call = calls[0];
    const fixedArgs = normalizeHaFastpathArgs(call.args);
    if (hasSensitiveData(fixedArgs.data)) return false;
    const text = String(call.text || '');
    // The HA executor emits these receipts only after the shared confirmation
    // helper succeeds. Accepted-and-pending and errors deliberately do not match.
    const completed = call.completed === true
      || text.startsWith(`Done. ${fixedArgs.entity_id} is now `)
      || text === `Home Assistant accepted ${fixedArgs.domain}.${fixedArgs.service} for ${fixedArgs.entity_id}.`;
    if (!completed) return false;
    if (shortSetting && !await matchesShortSetting(shortSetting, fixedArgs, userId)) return false;
    // The call already succeeded, so discovery/another HA request is unnecessary.
    // Keep the saved binding in place if another turn taught it while we waited.
    const result = await bindHaFastpath(userId, userMessage.trim(), fixedArgs, { onlyIfAbsent: true });
    if (result.added) console.log('[ha-fastpath] learned completed command', JSON.stringify({ userId, phrase, entityId: fixedArgs.entity_id }));
    return result.ok;
  } catch (e) {
    console.warn('[ha-fastpath] learning failed:', e.message);
    return false;
  }
}
