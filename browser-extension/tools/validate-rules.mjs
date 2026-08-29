// @ts-check
/**
 * Validate the generated declarativeNetRequest rulesets.
 *
 * Chrome rejects an entire static ruleset when any rule in it is malformed, so
 * a silent schema slip here would turn ad blocking off wholesale rather than
 * degrade it. Run this directly after a filter rebuild and from CI.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TIERS = ['ads', 'trackers', 'annoyances'];

/** Chrome guarantees 30,000 rules across enabled static rulesets. */
export const MAX_ENABLED_STATIC_RULES = 30_000;
export const MAX_REGEX_RULES = 1_000;

const VALID_RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other',
]);
const VALID_ACTIONS = new Set(['block', 'allow', 'allowAllRequests', 'redirect', 'upgradeScheme']);
const VALID_DOMAIN_TYPES = new Set(['firstParty', 'thirdParty']);
const CONDITION_KEYS = new Set([
  'urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive', 'resourceTypes',
  'excludedResourceTypes', 'domainType', 'initiatorDomains',
  'excludedInitiatorDomains', 'requestDomains', 'excludedRequestDomains',
  'requestMethods', 'excludedRequestMethods', 'tabIds', 'excludedTabIds',
]);

function checkUrlFilter(value, errors, label) {
  if (typeof value !== 'string' || !value) {
    errors.push(`${label}: urlFilter must be a non-empty string`);
    return;
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(value)) errors.push(`${label}: urlFilter has non-ASCII characters`);
  if (value !== value.toLowerCase()) {
    errors.push(`${label}: urlFilter must be lowercase for case-insensitive matching`);
  }
  const anchorless = value.replace(/^\|\|?/, '').replace(/\|$/, '');
  if (anchorless.includes('|')) errors.push(`${label}: urlFilter has an embedded '|'`);
}

/**
 * @param {any[]} rules
 * @param {string} tier
 * @returns {{errors: string[], regexCount: number}}
 */
export function validateRuleset(rules, tier) {
  const errors = [];
  const ids = new Set();
  let regexCount = 0;

  if (!Array.isArray(rules)) return { errors: [`${tier}: ruleset is not an array`], regexCount: 0 };

  for (const rule of rules) {
    const label = `${tier}#${rule?.id}`;
    if (!Number.isInteger(rule?.id) || rule.id < 1) { errors.push(`${label}: invalid id`); continue; }
    if (ids.has(rule.id)) errors.push(`${label}: duplicate id`);
    ids.add(rule.id);

    if (!Number.isInteger(rule.priority) || rule.priority < 1) errors.push(`${label}: invalid priority`);
    if (!VALID_ACTIONS.has(rule.action?.type)) errors.push(`${label}: invalid action`);

    const condition = rule.condition;
    if (!condition || typeof condition !== 'object') { errors.push(`${label}: missing condition`); continue; }
    for (const key of Object.keys(condition)) {
      if (!CONDITION_KEYS.has(key)) errors.push(`${label}: unknown condition key '${key}'`);
    }
    if (!condition.urlFilter && !condition.regexFilter) errors.push(`${label}: no url or regex filter`);
    if (condition.urlFilter && condition.regexFilter) errors.push(`${label}: both url and regex filter`);
    if (condition.urlFilter && !condition.isUrlFilterCaseSensitive) {
      checkUrlFilter(condition.urlFilter, errors, label);
    }
    if (condition.regexFilter) {
      regexCount++;
      try { new RegExp(condition.regexFilter); } catch { errors.push(`${label}: unparseable regexFilter`); }
    }
    if (condition.domainType && !VALID_DOMAIN_TYPES.has(condition.domainType)) {
      errors.push(`${label}: invalid domainType`);
    }

    const types = condition.resourceTypes;
    if (!Array.isArray(types) || !types.length) {
      errors.push(`${label}: resourceTypes must be a non-empty array`);
    } else {
      for (const type of types) {
        if (!VALID_RESOURCE_TYPES.has(type)) errors.push(`${label}: invalid resourceType '${type}'`);
      }
      // The core safety property: OE never blocks a top-level navigation.
      if (rule.action.type === 'block' && types.includes('main_frame')) {
        errors.push(`${label}: block rule targets main_frame`);
      }
    }

    for (const key of ['initiatorDomains', 'excludedInitiatorDomains', 'requestDomains', 'excludedRequestDomains']) {
      const list = condition[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.length) { errors.push(`${label}: ${key} must be a non-empty array`); continue; }
      for (const host of list) {
        if (typeof host !== 'string' || !host || host !== host.toLowerCase()) {
          errors.push(`${label}: ${key} has an invalid host '${host}'`);
        }
      }
    }
  }
  return { errors, regexCount };
}

export function validateAll(extDir = EXT_DIR) {
  const errors = [];
  let total = 0;
  let regexTotal = 0;
  const perTier = {};

  for (const tier of TIERS) {
    const file = path.join(extDir, 'rules', `${tier}.json`);
    if (!fs.existsSync(file)) { errors.push(`missing ruleset: rules/${tier}.json`); continue; }
    const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = validateRuleset(rules, tier);
    errors.push(...result.errors);
    perTier[tier] = rules.length;
    total += rules.length;
    regexTotal += result.regexCount;
  }

  if (total > MAX_ENABLED_STATIC_RULES) {
    errors.push(`all tiers enabled would use ${total} static rules, over the ${MAX_ENABLED_STATIC_RULES} guarantee`);
  }
  if (regexTotal > MAX_REGEX_RULES) {
    errors.push(`${regexTotal} regex rules exceeds the ${MAX_REGEX_RULES} limit`);
  }
  return { errors, total, regexTotal, perTier };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validateAll();
  process.stdout.write(`${JSON.stringify({
    perTier: result.perTier,
    total: result.total,
    regex: result.regexTotal,
    errors: result.errors.length,
    sample: result.errors.slice(0, 25),
  }, null, 2)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}
