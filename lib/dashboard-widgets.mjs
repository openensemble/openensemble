// @ts-check
/**
 * Shared contracts for declarative custom-skill dashboard widgets.
 *
 * Skills never provide dashboard HTML or JavaScript. A manifest may expose a
 * bounded descriptor tied to one exact read-only tool, and the runtime reduces
 * that tool's result to the text-only payload accepted below.
 */

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SIZES = new Set(['compact', 'standard', 'wide']);
const ACCENTS = new Set(['lime', 'sky', 'violet', 'amber', 'rose', 'cyan']);
const TONES = new Set(['neutral', 'good', 'warn', 'bad', 'info']);
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const SECRET_KEY_SEGMENTS = new Set([
  'auth', 'authorization', 'bearer', 'cookie', 'cookies', 'credential',
  'credentials', 'csrf', 'cvc', 'cvv', 'jwt', 'otp', 'passcode', 'passwd',
  'password', 'pwd', 'secret', 'token', 'xsrf',
]);
const SECRET_KEY_QUALIFIERS = new Set([
  'access', 'api', 'client', 'encryption', 'private', 'signing',
]);
const SCHEMA_ANNOTATIONS = new Set([
  '$comment', '$id', '$schema', 'default', 'deprecated', 'description',
  'examples', 'readOnly', 'title', 'writeOnly',
]);
const SCHEMA_KEYWORDS = new Set([
  'additionalProperties', 'allOf', 'anyOf', 'const', 'dependentRequired',
  'else', 'enum', 'exclusiveMaximum', 'exclusiveMinimum', 'format', 'if',
  'items', 'maxItems', 'maxLength', 'maxProperties', 'maximum', 'minItems',
  'minLength', 'minProperties', 'minimum', 'multipleOf', 'not', 'nullable',
  'oneOf', 'pattern', 'properties', 'required', 'then', 'type', 'uniqueItems',
]);

export const MAX_SKILL_WIDGETS = 8;
export const MIN_WIDGET_REFRESH_SECONDS = 30;
export const MAX_WIDGET_REFRESH_SECONDS = 3_600;
// dashboard-view.html ships a deliberately small inline SVG sprite so the
// public display never needs to load executable icon assets. Keep authoring
// validation in lockstep with that sprite: accepting an arbitrary Lucide name
// here would make a valid manifest silently render the generic fallback.
export const SKILL_DASHBOARD_WIDGET_ICONS = Object.freeze([
  'activity', 'calendar', 'clock', 'cloud', 'cloud-sun',
  'gauge', 'grid', 'house', 'light', 'mail', 'package',
  'shield', 'sparkles', 'thermometer', 'wifi',
]);
const SKILL_DASHBOARD_WIDGET_ICON_SET = new Set(SKILL_DASHBOARD_WIDGET_ICONS);

/** @param {unknown} value @returns {value is Record<string, any>} */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function cleanText(value, max, { required = false } = {}) {
  if (typeof value !== 'string') return required ? null : '';
  const text = value.replace(UNSAFE_TEXT_CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  if ((required && !text) || text.length > max) return null;
  return text;
}

function normalizedSecretScannerText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(UNSAFE_TEXT_CONTROLS, '')
    : '';
}

/**
 * Secret-bearing field names arrive in snake_case, kebab-case, and camelCase.
 * Normalize them into semantic segments so `auth`, `accessKey`, `api_key`, and
 * similar spellings cannot bypass a substring regex.
 */
export function isSensitiveDashboardKey(value) {
  if (typeof value !== 'string' || !value) return false;
  const segments = normalizedSecretScannerText(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (segments.some(segment => SECRET_KEY_SEGMENTS.has(segment))) return true;
  if (segments.includes('session') && segments.some(segment => ['id', 'key'].includes(segment))) {
    return true;
  }
  if (segments.includes('key')) {
    return segments.length === 1
      || segments.some(segment => SECRET_KEY_QUALIFIERS.has(segment));
  }
  const compact = segments.join('');
  return /(?:authorization|accesstoken|refreshtoken|clientsecret|apikey|accesskey|privatekey|password|passwd)/.test(compact);
}

/** Reject recognizable plaintext credential material even under an innocuous key. */
export function isSensitiveDashboardString(value) {
  if (typeof value !== 'string') return false;
  const text = normalizedSecretScannerText(value).trim();
  if (!text) return false;
  const bearer = /\bbearer\s+([A-Za-z0-9._~+/-]{12,}={0,2})(?=\s|$|[,;])/i.exec(text);
  if (bearer) {
    const token = bearer[1].replace(/=+$/, '');
    if (token.length >= 20 || /[0-9._~+/-]/.test(token)) return true;
  }
  const basic = /\bbasic\s+([A-Za-z0-9+/]+={0,2})(?:\s|$)/i.exec(text);
  if (basic) {
    try {
      const encoded = basic[1];
      const bytes = Buffer.from(encoded, 'base64');
      const canonical = bytes.toString('base64').replace(/=+$/, '');
      if (canonical !== encoded.replace(/=+$/, '')) throw new Error('non-canonical base64');
      const decoded = bytes.toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) return true;
    } catch { /* malformed Basic-looking prose is not credential material */ }
  }
  if (/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) return true;
  if (/\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/i.test(text)
      || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i.test(text)
      || /\b(?:ya29\.|AIza)[A-Za-z0-9_-]{20,}\b/.test(text)) return true;
  // Parse assignment/prose field names through the same segmented-key policy
  // as JSON objects. A zero-width scan finds query parameters even when an
  // earlier URL-shaped candidate spans over them.
  const assignments = text.matchAll(/(?=\b((?:my\s+)?[A-Za-z][A-Za-z0-9_.-]*(?:\s+[A-Za-z][A-Za-z0-9_.-]*){0,2})\s*(?:=|:|\bis\b)\s*([^\s&,;]+))/gi);
  for (const match of assignments) {
    const key = match[1].replace(/^my\s+/i, '');
    if (isSensitiveDashboardKey(key)) return true;
  }
  if (/\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@/i.test(text)) return true;
  return false;
}

function safeStaticValue(value, depth = 0, seen = { nodes: 0 }) {
  seen.nodes += 1;
  if (seen.nodes > 128 || depth > 4) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    return value.length <= 1_000 && !isSensitiveDashboardString(value);
  }
  if (Array.isArray(value)) {
    return value.length <= 24 && value.every(item => safeStaticValue(item, depth + 1, seen));
  }
  if (!record(value) || Object.keys(value).length > 24) return false;
  return Object.entries(value).every(([key, item]) => (
    key.length <= 64
    && key !== '__proto__'
    && key !== 'prototype'
    && key !== 'constructor'
    && !isSensitiveDashboardKey(key)
    && safeStaticValue(item, depth + 1, seen)
  ));
}

function schemaTypeMatches(value, type) {
  if (Array.isArray(type)) return type.some(candidate => schemaTypeMatches(value, candidate));
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return record(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function jsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (record(left) && record(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
        && jsonEqual(left[key], right[key]));
  }
  return false;
}

function validateSupportedSchema(schema, path = '$', depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 256 || depth > 8) return `${path} is too complex.`;
  if (typeof schema === 'boolean') return null;
  if (!record(schema)) return `${path} must be an object or boolean schema.`;
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_ANNOTATIONS.has(key) && !SCHEMA_KEYWORDS.has(key) && !key.startsWith('x-')) {
      return `${path}.${key} is not supported for dashboard widget binding.`;
    }
  }
  const recurse = (child, suffix) => validateSupportedSchema(child, `${path}${suffix}`, depth + 1, budget);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || !schema[key].length) return `${path}.${key} must be a nonempty array.`;
      for (let index = 0; index < schema[key].length; index += 1) {
        const error = recurse(schema[key][index], `.${key}[${index}]`);
        if (error) return error;
      }
    }
  }
  for (const key of ['not', 'if', 'then', 'else', 'items', 'additionalProperties']) {
    if (schema[key] === undefined || (key === 'additionalProperties' && typeof schema[key] === 'boolean')) continue;
    const error = recurse(schema[key], `.${key}`);
    if (error) return error;
  }
  if (schema.properties !== undefined) {
    if (!record(schema.properties)) return `${path}.properties must be an object.`;
    for (const [key, child] of Object.entries(schema.properties)) {
      const error = recurse(child, `.properties.${key}`);
      if (error) return error;
    }
  }
  // JavaScript RegExp evaluation has no deadline. Even a bounded string and
  // pattern can trigger catastrophic backtracking, so dashboard binding
  // rejects `pattern` explicitly rather than pretending it was evaluated.
  if (schema.pattern !== undefined) {
    return `${path}.pattern is not supported for dashboard widget binding.`;
  }
  // JSON Schema treats `format` inconsistently across validators. This
  // contract must never claim args satisfy a constraint it did not enforce,
  // so format-bearing widget tools are rejected for the MVP.
  if (schema.format !== undefined) {
    return `${path}.format is not supported for dashboard widget binding.`;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const allowedTypes = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
    if (!types.length || types.some(type => typeof type !== 'string' || !allowedTypes.has(type))) {
      return `${path}.type is invalid.`;
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) {
    return `${path}.enum must be a nonempty array.`;
  }
  if (schema.nullable !== undefined && typeof schema.nullable !== 'boolean') {
    return `${path}.nullable must be a boolean.`;
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) {
      return `${path}.${key} must be a nonnegative integer.`;
    }
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) {
      return `${path}.${key} must be a finite number.`;
    }
  }
  if (schema.multipleOf !== undefined
      && (typeof schema.multipleOf !== 'number' || !Number.isFinite(schema.multipleOf)
        || schema.multipleOf <= 0)) {
    return `${path}.multipleOf must be a positive finite number.`;
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') {
    return `${path}.uniqueItems must be a boolean.`;
  }
  if (schema.required !== undefined
      && (!Array.isArray(schema.required)
        || new Set(schema.required).size !== schema.required.length
        || schema.required.some(key => typeof key !== 'string'))) {
    return `${path}.required must be an array of unique strings.`;
  }
  if (schema.dependentRequired !== undefined) {
    if (!record(schema.dependentRequired)) return `${path}.dependentRequired must be an object.`;
    for (const dependencies of Object.values(schema.dependentRequired)) {
      if (!Array.isArray(dependencies)
          || new Set(dependencies).size !== dependencies.length
          || dependencies.some(key => typeof key !== 'string')) {
        return `${path}.dependentRequired values must be arrays of unique strings.`;
      }
    }
  }
  return null;
}

function valueMatchesSchema(value, schema, depth = 0) {
  if (schema === true) return true;
  if (schema === false || !record(schema) || depth > 8) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => jsonEqual(candidate, value))) return false;
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !jsonEqual(schema.const, value)) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(item => valueMatchesSchema(value, item, depth + 1))) return false;
  if (Array.isArray(schema.oneOf)
      && schema.oneOf.filter(item => valueMatchesSchema(value, item, depth + 1)).length !== 1) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every(item => valueMatchesSchema(value, item, depth + 1))) return false;
  if (schema.not !== undefined && valueMatchesSchema(value, schema.not, depth + 1)) return false;
  if (schema.if !== undefined) {
    const branch = valueMatchesSchema(value, schema.if, depth + 1) ? schema.then : schema.else;
    if (branch !== undefined && !valueMatchesSchema(value, branch, depth + 1)) return false;
  }
  if (schema.type !== undefined
      && !(schema.nullable === true && value === null)
      && !schemaTypeMatches(value, schema.type)) return false;
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) return false;
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return false;
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return false;
    if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) return false;
    if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) return false;
    if (Number.isFinite(schema.multipleOf) && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return false;
    }
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) return false;
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true
        && value.some((item, index) => value.slice(0, index).some(previous => jsonEqual(previous, item)))) return false;
    if (schema.items !== undefined
        && !value.every(item => valueMatchesSchema(item, schema.items, depth + 1))) return false;
  }
  if (record(value)) {
    const properties = record(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some(key => typeof key !== 'string'
        || !Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schema.additionalProperties === false
        && Object.keys(value).some(key => !Object.prototype.hasOwnProperty.call(properties, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)
          && !valueMatchesSchema(item, properties[key], depth + 1)) return false;
      if (!Object.prototype.hasOwnProperty.call(properties, key)
          && schema.additionalProperties !== undefined
          && schema.additionalProperties !== true
          && schema.additionalProperties !== false
          && !valueMatchesSchema(item, schema.additionalProperties, depth + 1)) return false;
    }
    if (Number.isFinite(schema.minProperties) && Object.keys(value).length < schema.minProperties) return false;
    if (Number.isFinite(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) return false;
    if (record(schema.dependentRequired)) {
      for (const [key, dependencies] of Object.entries(schema.dependentRequired)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (!Array.isArray(dependencies)
            || dependencies.some(dependency => typeof dependency !== 'string'
              || !Object.prototype.hasOwnProperty.call(value, dependency))) return false;
      }
    }
  }
  return true;
}

export function validateSkillDashboardToolInvocation(tool, args, config = {}) {
  const parameters = tool?.function?.parameters;
  if (!record(parameters)) {
    return { ok: false, schemaError: '$ tool parameters must be an object schema for dashboard widget binding.' };
  }
  const schemaError = validateSupportedSchema(parameters);
  if (schemaError) return { ok: false, schemaError };
  const runtimeArgs = { ...args, config };
  return valueMatchesSchema(runtimeArgs, parameters)
    ? { ok: true }
    : { ok: false, schemaError: null };
}

/**
 * Validate and clone a manifest's optional dashboardWidgets declaration.
 * Every widget must bind a declared, non-destructive, explicitly read-only
 * tool from the same manifest.
 *
 * @param {unknown} value
 * @param {unknown[]} tools
 * @returns {{ok:true, widgets:object[]} | {ok:false, error:string}}
 */
export function validateSkillDashboardWidgets(value, tools = []) {
  if (value === undefined) return { ok: true, widgets: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: 'dashboardWidgets must be an array.' };
  }
  if (value.length > MAX_SKILL_WIDGETS) {
    return { ok: false, error: `dashboardWidgets supports at most ${MAX_SKILL_WIDGETS} entries per skill.` };
  }

  /** @type {Map<string, any>} */
  const declaredTools = new Map();
  for (const tool of /** @type {any[]} */ (Array.isArray(tools) ? tools : [])) {
    const name = tool?.function?.name;
    if (typeof name === 'string' && name) declaredTools.set(name, tool);
  }
  const ids = new Set();
  const widgets = [];
  const allowed = new Set([
    'id', 'title', 'description', 'icon', 'tool', 'args',
    'refreshSeconds', 'size', 'accent',
  ]);

  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const label = `dashboardWidgets[${index}]`;
    if (!record(candidate) || !exactKeys(candidate, allowed)) {
      return { ok: false, error: `${label} contains unsupported fields.` };
    }
    const id = cleanText(candidate.id, 64, { required: true });
    if (!id || !SAFE_ID.test(id)) {
      return { ok: false, error: `${label}.id must be a safe lowercase kebab-case id.` };
    }
    if (ids.has(id)) return { ok: false, error: `Duplicate dashboard widget id: ${id}.` };
    ids.add(id);

    const title = cleanText(candidate.title, 80, { required: true });
    const description = cleanText(candidate.description ?? '', 240);
    const toolName = cleanText(candidate.tool, 128, { required: true });
    if (!title) return { ok: false, error: `${label}.title is required and must be at most 80 characters.` };
    if (description === null) return { ok: false, error: `${label}.description must be at most 240 characters.` };
    if (!toolName || !declaredTools.has(toolName)) {
      return { ok: false, error: `${label}.tool must name a tool declared by this skill.` };
    }
    const tool = declaredTools.get(toolName);
    if (tool?.destructive === true || tool?.readOnly !== true) {
      return { ok: false, error: `${label}.tool must be declared readOnly:true and must not be destructive.` };
    }

    const icon = candidate.icon === undefined ? 'sparkles' : cleanText(candidate.icon, 48, { required: true });
    if (!icon || !SKILL_DASHBOARD_WIDGET_ICON_SET.has(icon)) {
      return {
        ok: false,
        error: `${label}.icon must be one of: ${SKILL_DASHBOARD_WIDGET_ICONS.join(', ')}.`,
      };
    }
    const size = candidate.size ?? 'standard';
    const accent = candidate.accent ?? 'violet';
    if (!SIZES.has(size)) return { ok: false, error: `${label}.size is invalid.` };
    if (!ACCENTS.has(accent)) return { ok: false, error: `${label}.accent is invalid.` };

    const refreshSeconds = candidate.refreshSeconds ?? 300;
    if (!Number.isInteger(refreshSeconds)
      || refreshSeconds < MIN_WIDGET_REFRESH_SECONDS
      || refreshSeconds > MAX_WIDGET_REFRESH_SECONDS) {
      return {
        ok: false,
        error: `${label}.refreshSeconds must be an integer from ${MIN_WIDGET_REFRESH_SECONDS} to ${MAX_WIDGET_REFRESH_SECONDS}.`,
      };
    }
    const args = candidate.args ?? {};
    if (!record(args) || !safeStaticValue(args)) {
      return { ok: false, error: `${label}.args must be bounded JSON and may not contain credential-like fields.` };
    }
    if (Object.prototype.hasOwnProperty.call(args, 'config')) {
      return { ok: false, error: `${label}.args must not define config; OE supplies the card config separately.` };
    }
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 4_096) {
      return { ok: false, error: `${label}.args must be at most 4 KiB.` };
    }
    const schemaMatch = validateSkillDashboardToolInvocation(tool, args, {});
    if (!schemaMatch.ok && schemaMatch.schemaError) {
      return {
        ok: false,
        error: `${label}.tool uses an unsupported dashboard widget parameter schema: ${schemaMatch.schemaError}`,
      };
    }
    if (!schemaMatch.ok) {
      return { ok: false, error: `${label}.args plus the OE-supplied config do not satisfy the bound tool's parameter schema.` };
    }

    widgets.push({ id, title, description, icon, tool: toolName, args, refreshSeconds, size, accent });
  }
  return { ok: true, widgets };
}

function payloadText(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const text = value.replace(UNSAFE_TEXT_CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  return text && text.length <= max ? text : null;
}

function payloadTone(value) {
  return typeof value === 'string' && TONES.has(value) ? value : 'neutral';
}

/**
 * Reduce a skill tool result to a strict, text-only dashboard payload.
 * Strings are accepted as a convenient summary-only result.
 *
 * @param {unknown} raw
 * @returns {{ok:true, data:object} | {ok:false, error:string}}
 */
export function normalizeSkillDashboardPayload(raw) {
  if (typeof raw === 'string') {
    const summary = payloadText(raw, 2_000);
    return summary
      ? { ok: true, data: { summary, metrics: [], items: [], updatedAt: null } }
      : { ok: false, error: 'Widget tool returned an empty or oversized string.' };
  }
  if (record(raw) && raw.type === 'result' && typeof raw.text === 'string') raw = raw.text;
  if (typeof raw === 'string') return normalizeSkillDashboardPayload(raw);
  if (!record(raw)) return { ok: false, error: 'Widget tool must return text or a dashboard data object.' };

  const allowed = new Set(['summary', 'metrics', 'items', 'updatedAt']);
  if (!exactKeys(raw, allowed)) {
    return { ok: false, error: 'Widget tool returned unsupported fields.' };
  }
  const summary = raw.summary === undefined ? null : payloadText(raw.summary, 2_000);
  if (raw.summary !== undefined && !summary) {
    return { ok: false, error: 'Widget summary must be nonempty text of at most 2,000 characters.' };
  }

  if (raw.metrics !== undefined && (!Array.isArray(raw.metrics) || raw.metrics.length > 12)) {
    return { ok: false, error: 'Widget metrics must be an array with at most 12 entries.' };
  }
  const metrics = [];
  for (const metric of (raw.metrics ?? [])) {
    if (!record(metric) || !exactKeys(metric, new Set(['label', 'value', 'tone']))) {
      return { ok: false, error: 'Each widget metric may contain only label, value, and tone.' };
    }
    const label = payloadText(metric.label, 80);
    const value = payloadText(metric.value, 160);
    if (!label || !value) return { ok: false, error: 'Widget metric label and value are required.' };
    metrics.push({ label, value, tone: payloadTone(metric.tone) });
  }

  if (raw.items !== undefined && (!Array.isArray(raw.items) || raw.items.length > 20)) {
    return { ok: false, error: 'Widget items must be an array with at most 20 entries.' };
  }
  const items = [];
  for (const item of (raw.items ?? [])) {
    if (!record(item) || !exactKeys(item, new Set(['title', 'subtitle', 'value', 'tone']))) {
      return { ok: false, error: 'Each widget item may contain only title, subtitle, value, and tone.' };
    }
    const title = payloadText(item.title, 160);
    const subtitle = item.subtitle === undefined ? null : payloadText(item.subtitle, 300);
    const value = item.value === undefined ? null : payloadText(item.value, 160);
    if (!title || (item.subtitle !== undefined && !subtitle) || (item.value !== undefined && !value)) {
      return { ok: false, error: 'Widget item text is missing or oversized.' };
    }
    items.push({ title, subtitle, value, tone: payloadTone(item.tone) });
  }

  let updatedAt = null;
  if (raw.updatedAt !== undefined && raw.updatedAt !== null) {
    const text = payloadText(raw.updatedAt, 40);
    if (!text || !Number.isFinite(Date.parse(text))) {
      return { ok: false, error: 'Widget updatedAt must be an ISO-compatible date string.' };
    }
    updatedAt = new Date(text).toISOString();
  }
  if (!summary && !metrics.length && !items.length) {
    return { ok: false, error: 'Widget tool returned no displayable data.' };
  }
  return { ok: true, data: { summary, metrics, items, updatedAt } };
}

/**
 * Render the same strict dashboard payload as concise plain text for ordinary
 * agent/chat execution. This is intentionally downstream of the strict
 * normalizer: it cannot turn an arbitrary object into model-visible text.
 *
 * @param {unknown} raw
 * @returns {{ok:true, text:string, data:object} | {ok:false, error:string}}
 */
export function formatSkillDashboardPayload(raw) {
  const checked = normalizeSkillDashboardPayload(raw);
  if (checked.ok === false) return checked;
  const data = /** @type {any} */ (checked.data);
  const lines = [];
  if (data.summary) lines.push(data.summary);
  for (const metric of data.metrics) lines.push(`${metric.label}: ${metric.value}`);
  for (const item of data.items) {
    const parts = [item.title, item.subtitle, item.value].filter(Boolean);
    lines.push(`- ${parts.join(' — ')}`);
  }
  if (data.updatedAt) lines.push(`Updated: ${data.updatedAt}`);
  return { ok: true, text: lines.join('\n'), data: checked.data };
}

/**
 * Format a result only when `toolName` is bound by this exact, fully-valid
 * manifest's dashboardWidgets declaration. Ordinary tools remain untouched,
 * including arbitrary object-returning tools with unrelated contracts.
 *
 * @param {any} manifest
 * @param {string} toolName
 * @param {unknown} raw
 * @returns {{matched:false} | {matched:true, ok:true, text:string, data:object} | {matched:true, ok:false, error:string}}
 */
export function formatDeclaredSkillDashboardToolResult(manifest, toolName, raw) {
  const declaration = validateSkillDashboardWidgets(
    manifest?.dashboardWidgets,
    manifest?.tools ?? [],
  );
  if (declaration.ok === false
      || !declaration.widgets.some(widget => widget.tool === toolName)) {
    return { matched: false };
  }
  const formatted = formatSkillDashboardPayload(raw);
  if (formatted.ok === false) return { matched: true, ok: false, error: formatted.error };
  return { matched: true, ...formatted };
}
