// @ts-check
/**
 * Persisted, user-owned browser routines taught through the extension.
 *
 * Teach observations are reduced into semantic, accessibility-addressed
 * steps here. Replay is deliberately transport-agnostic: callers provide the
 * existing browser command function, while this module verifies ownership,
 * the exact live origin, ordering, and fail-closed stop behavior.
 *
 * Storage: users/<userId>/browser-routines.json
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { isIP } from 'net';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';

export const BROWSER_ROUTINE_SCHEMA = 1;
export const MAX_BROWSER_ROUTINES_PER_USER = 100;
export const MAX_BROWSER_ROUTINE_STEPS = 40;

const STORE_FILE = 'browser-routines.json';
const STEP_TYPES = new Set(['navigate', 'click', 'fill', 'select', 'toggle', 'wait_for']);
const TARGET_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'spinbutton',
]);
const CLICK_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'option',
]);
const FILL_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const SELECT_ROLES = new Set(['combobox', 'listbox']);
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch']);
const WAIT_STATES = new Set(['visible', 'hidden', 'enabled', 'disabled']);

const DANGEROUS_KEY = /^(?:x|y|left|top|coordinates?|selector|css|xpath|html|script|javascript|code|expression|eval|function|cookie|headers?|authorization|credential|credentials|password|passwd|secret|token|otp|cvv|cvc)$/i;
const SENSITIVE_FIELD = /\b(?:password|passphrase|passcode|passwd|pin|one[ -]?time(?: password| code)?|otp|2fa|mfa|verification code|security code|credit card|debit card|card number|payment card|cvv|cvc|expiration date|expiry date|routing number|bank account|iban|swift|social security|ssn|medical record|patient id|member id|private key|api key|access token|auth token|secret key)\b/i;
const EXPLICIT_SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}|\b(?:password|passwd|passcode|otp|cvv|cvc|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret)\s*[:=]\s*\S+)/i;
const API_KEY_VALUE = /^(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})$/;
const JWT_VALUE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const HEX_SECRET_VALUE = /^[a-f0-9]{32,}$/i;
const OPAQUE_SECRET_VALUE = /^(?=.{32,}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9+/_=-]+$/;
const SHORT_CODE_VALUE = /^\d{4,9}$/;

/** @type {ReadonlyArray<readonly [string, RegExp]>} */
const HIGH_RISK_PATTERNS = Object.freeze([
  ['financial_action', /\b(?:buy|purchase|pay|checkout|place (?:the )?order|order now|book|reserve|transfer|send money|bid)\b/i],
  ['data_submission', /\b(?:submit|send|post|publish|share|upload)\b/i],
  ['destructive_action', /\b(?:delete|erase|remove|cancel|terminate|close (?:my |the )?account|factory reset)\b/i],
  ['account_change', /\b(?:sign[ -]?(?:in|out|up)|log[ -]?(?:in|out)|change (?:account|email|password)|reset password|subscribe|unsubscribe)\b/i],
  ['software_or_file_action', /\b(?:download|install|open externally|run)\b/i],
  ['ambiguous_commit', /^(?:confirm|continue|next|finish|done|save|accept|agree|approve)$/i],
]);

const ALLOWED_ROUTINE_INPUT_KEYS = new Set(['id', 'name', 'description', 'origin', 'steps']);
const ALLOWED_STORED_ROUTINE_KEYS = new Set([
  'id', 'name', 'description', 'origin', 'steps', 'risk', 'createdAt', 'updatedAt',
]);
const STEP_KEYS = Object.freeze({
  navigate: new Set(['type', 'origin', 'path']),
  click: new Set(['type', 'origin', 'target']),
  fill: new Set(['type', 'origin', 'target', 'value']),
  select: new Set(['type', 'origin', 'target', 'option']),
  toggle: new Set(['type', 'origin', 'target', 'checked']),
  wait_for: new Set(['type', 'origin', 'target', 'state', 'timeoutMs']),
});
const TARGET_KEYS = new Set(['role', 'name', 'label', 'ordinal', 'exact']);

export class BrowserRoutineStoreError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'BROWSER_ROUTINE_STORE_ERROR') {
    super(message);
    this.name = 'BrowserRoutineStoreError';
    this.code = code;
  }
}

export class BrowserRoutineReplayError extends Error {
  /** @param {string} message @param {string} [code] @param {object} [details] */
  constructor(message, code = 'BROWSER_ROUTINE_REPLAY_ERROR', details = {}) {
    super(message);
    this.name = 'BrowserRoutineReplayError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEY.test(key)) {
      throw new TypeError(`${label} may not contain coordinates, selectors, scripts, code, or secrets (${key})`);
    }
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
}

function validateUserId(userId) {
  const value = String(userId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError('browser routine userId is invalid');
  }
  return value;
}

function storePath(userId) {
  return path.join(USERS_DIR, validateUserId(userId), STORE_FILE);
}

function cleanText(value, label, max, { required = true } = {}) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (required && !text) throw new TypeError(`${label} is required`);
  if (text.length > max) throw new TypeError(`${label} exceeds ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${label} contains control characters`);
  }
  return text;
}

/**
 * Accept an exact HTTP(S) origin, never a path, wildcard, credentials, query,
 * or fragment. The canonical origin has no trailing slash.
 */
export function canonicalBrowserRoutineOrigin(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new TypeError('browser routine origin must be an exact HTTP(S) origin');
  }
  let url;
  try { url = new URL(value); }
  catch { throw new TypeError('browser routine origin must be a valid URL origin'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('browser routine origin must use http or https');
  }
  if (url.username || url.password) {
    throw new TypeError('browser routine origin may not contain credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('browser routine origin must not contain a path, query, or fragment');
  }
  if (!url.hostname || url.hostname.includes('*')) {
    throw new TypeError('browser routine origin must name one exact host');
  }
  if (isPrivateOrLocalHostname(url.hostname)) {
    throw new TypeError('browser routine origin must not be private, local, or intranet');
  }
  if (url.origin.length > 300) throw new TypeError('browser routine origin is too long');
  return url.origin;
}

function isPrivateOrLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) {
    return true;
  }
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) {
    return host === '::' || host === '::1' || /^(?:fc|fd|fe[89ab])/i.test(host) ||
      /^::ffff:(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(host);
  }
  return false;
}

function hasSensitiveField(target) {
  return SENSITIVE_FIELD.test(`${target.name || ''} ${target.label || ''}`);
}

function passesLuhn(value) {
  const digits = String(value).replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function assertNonSecretValue(value, target, label) {
  if (hasSensitiveField(target)) {
    throw new TypeError(`${label} may not target password, payment, OTP, token, or secret fields`);
  }
  const compact = value.trim();
  if (EXPLICIT_SECRET_VALUE.test(compact)
    || API_KEY_VALUE.test(compact)
    || JWT_VALUE.test(compact)
    || HEX_SECRET_VALUE.test(compact)
    || OPAQUE_SECRET_VALUE.test(compact)
    // A bare 4–8 digit literal is indistinguishable from a PIN or OTP once
    // persisted. Do not guess; values like postal codes must be re-entered at
    // run time rather than taught into a routine.
    || SHORT_CODE_VALUE.test(compact)
    || passesLuhn(compact)) {
    throw new TypeError(`${label} may not persist passwords, payment data, OTPs, tokens, or other secrets`);
  }
  if (/\{\{|\}\}|<%|%>|\$\{|javascript:/i.test(compact)) {
    throw new TypeError(`${label} may not contain templates or executable expressions`);
  }
}

function normalizeTarget(input, label) {
  assertPlainObject(input, label);
  assertOnlyKeys(input, TARGET_KEYS, label);
  const role = cleanText(input.role, `${label}.role`, 32).toLowerCase();
  if (!TARGET_ROLES.has(role)) throw new TypeError(`${label}.role is not an allowed semantic role`);
  const name = cleanText(input.name, `${label}.name`, 160, { required: false });
  const fieldLabel = cleanText(input.label, `${label}.label`, 160, { required: false });
  if (!name && !fieldLabel) throw new TypeError(`${label} requires an accessible name or label`);
  const ordinal = input.ordinal == null ? 1 : Number(input.ordinal);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 20) {
    throw new TypeError(`${label}.ordinal must be an integer from 1 to 20`);
  }
  if (input.exact != null && typeof input.exact !== 'boolean') {
    throw new TypeError(`${label}.exact must be boolean`);
  }
  return { role, name: name || null, label: fieldLabel || null, ordinal, exact: input.exact !== false };
}

function normalizeNavigatePath(input, origin) {
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//')) {
    throw new TypeError('navigate.path must be a same-origin absolute path');
  }
  if (input.length > 1_500) throw new TypeError('navigate.path is too long');
  let url;
  try { url = new URL(input, `${origin}/`); }
  catch { throw new TypeError('navigate.path is invalid'); }
  if (url.origin !== origin) throw new TypeError('navigate.path may not leave the routine origin');
  if (url.username || url.password) throw new TypeError('navigate.path may not contain credentials');
  const pathValue = `${url.pathname}${url.search}${url.hash}`;
  if (EXPLICIT_SECRET_VALUE.test(decodeURIComponentSafe(pathValue))
    || JWT_VALUE.test(pathValue.replace(/^.*[?&#=/]/, ''))
    || /(?:password|passwd|passcode|otp|token|secret|api[_-]?key)=/i.test(pathValue)) {
    throw new TypeError('navigate.path may not persist credentials or secrets');
  }
  return pathValue;
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalizeStep(input, origin, index, { stored = false } = {}) {
  const label = `browser routine step ${index + 1}`;
  assertPlainObject(input, label);
  const type = typeof input.type === 'string' ? input.type : '';
  if (!STEP_TYPES.has(type)) throw new TypeError(`${label} has unsupported semantic type: ${type || '(missing)'}`);
  assertOnlyKeys(input, STEP_KEYS[type], label);
  if (input.origin != null && canonicalBrowserRoutineOrigin(input.origin) !== origin) {
    throw new TypeError(`${label} origin does not match the routine origin`);
  }
  if (stored && input.origin == null) throw new TypeError(`${label} is missing its persisted origin binding`);

  if (type === 'navigate') {
    return { type, origin, path: normalizeNavigatePath(input.path, origin) };
  }

  const target = normalizeTarget(input.target, `${label}.target`);
  if (hasSensitiveField(target)) {
    throw new TypeError(`${label} may not target password, payment, OTP, token, or secret fields`);
  }

  if (type === 'click') {
    if (!CLICK_ROLES.has(target.role)) throw new TypeError(`${label} click target role is not actionable`);
    return { type, origin, target };
  }
  if (type === 'fill') {
    if (!FILL_ROLES.has(target.role)) throw new TypeError(`${label} fill target must be an editable semantic role`);
    const value = cleanText(input.value, `${label}.value`, 500);
    assertNonSecretValue(value, target, label);
    return { type, origin, target, value };
  }
  if (type === 'select') {
    if (!SELECT_ROLES.has(target.role)) throw new TypeError(`${label} select target must be a combobox or listbox`);
    const option = cleanText(input.option, `${label}.option`, 160);
    assertNonSecretValue(option, target, label);
    return { type, origin, target, option };
  }
  if (type === 'toggle') {
    if (!TOGGLE_ROLES.has(target.role)) throw new TypeError(`${label} toggle target is not toggleable`);
    if (typeof input.checked !== 'boolean') throw new TypeError(`${label}.checked must be boolean`);
    return { type, origin, target, checked: input.checked };
  }
  const state = cleanText(input.state, `${label}.state`, 16).toLowerCase();
  if (!WAIT_STATES.has(state)) throw new TypeError(`${label}.state is unsupported`);
  const timeoutMs = input.timeoutMs == null ? 5_000 : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) {
    throw new TypeError(`${label}.timeoutMs must be between 100 and 15000`);
  }
  return { type, origin, target, state, timeoutMs };
}

function targetRiskText(step) {
  if (!step?.target) return '';
  return `${step.target.name || ''} ${step.target.label || ''}`.trim();
}

/**
 * Deterministically classify already-semantic routine steps. This describes
 * risk for a future confirmation policy; it does not authorize execution.
 */
export function classifyBrowserRoutineRisk(routineOrSteps) {
  const steps = Array.isArray(routineOrSteps) ? routineOrSteps : routineOrSteps?.steps;
  if (!Array.isArray(steps)) throw new TypeError('risk classification requires routine steps');
  const reasons = new Set();
  let rank = 0;
  for (const step of steps) {
    const type = String(step?.type || '');
    if (type === 'click') {
      rank = Math.max(rank, 1);
      reasons.add('interactive_click');
      const text = targetRiskText(step);
      for (const [reason, pattern] of HIGH_RISK_PATTERNS) {
        if (pattern.test(text)) {
          rank = 2;
          reasons.add(reason);
        }
      }
    } else if (type === 'fill') {
      rank = Math.max(rank, 1);
      reasons.add('form_input');
    } else if (type === 'select' || type === 'toggle') {
      rank = Math.max(rank, 1);
      reasons.add('form_choice');
      const text = `${targetRiskText(step)} ${step?.option || ''}`.trim();
      for (const [reason, pattern] of HIGH_RISK_PATTERNS) {
        if (pattern.test(text)) {
          rank = 2;
          reasons.add(reason);
        }
      }
    } else if (type !== 'navigate' && type !== 'wait_for') {
      // Future/unknown semantic types must never inherit a low-risk default.
      rank = 2;
      reasons.add('unclassified_step');
    }
  }
  return {
    level: rank === 2 ? 'high' : rank === 1 ? 'medium' : 'low',
    reasons: [...reasons].sort(),
  };
}

function cleanRoutineInput(input, { existing = null, now = Date.now(), idFactory = randomUUID, stored = false } = {}) {
  assertPlainObject(input, 'browser routine');
  assertOnlyKeys(input, stored ? ALLOWED_STORED_ROUTINE_KEYS : ALLOWED_ROUTINE_INPUT_KEYS, 'browser routine');
  const origin = canonicalBrowserRoutineOrigin(input.origin);
  const name = cleanText(input.name, 'browser routine name', 100);
  const description = cleanText(input.description, 'browser routine description', 500, { required: false });
  if (!Array.isArray(input.steps) || input.steps.length < 1) {
    throw new TypeError('browser routine requires at least one semantic step');
  }
  if (input.steps.length > MAX_BROWSER_ROUTINE_STEPS) {
    throw new TypeError(`browser routine exceeds ${MAX_BROWSER_ROUTINE_STEPS} steps`);
  }
  const steps = input.steps.map((step, index) => normalizeStep(step, origin, index, { stored }));
  const risk = classifyBrowserRoutineRisk(steps);

  let id;
  if (stored && (input.id == null || input.id === '')) {
    throw new TypeError('persisted browser routine id is required');
  }
  if (input.id == null || input.id === '') id = `brt_${idFactory()}`;
  else {
    id = String(input.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) throw new TypeError('browser routine id is invalid');
  }
  const stamp = new Date(now).toISOString();
  if (stamp === 'Invalid Date') throw new TypeError('browser routine timestamp is invalid');

  if (stored) {
    if (typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt))) {
      throw new TypeError('browser routine createdAt is invalid');
    }
    if (typeof input.updatedAt !== 'string' || Number.isNaN(Date.parse(input.updatedAt))) {
      throw new TypeError('browser routine updatedAt is invalid');
    }
    assertPlainObject(input.risk, 'browser routine risk');
    assertOnlyKeys(input.risk, new Set(['level', 'reasons']), 'browser routine risk');
    if (input.risk.level !== risk.level
      || !Array.isArray(input.risk.reasons)
      || JSON.stringify(input.risk.reasons) !== JSON.stringify(risk.reasons)) {
      throw new TypeError('browser routine risk classification is invalid');
    }
    return { id, name, description, origin, steps, risk, createdAt: input.createdAt, updatedAt: input.updatedAt };
  }

  return {
    id,
    name,
    description,
    origin,
    steps,
    risk,
    createdAt: existing?.createdAt || stamp,
    updatedAt: stamp,
  };
}

function emptyStore() {
  return { schema: BROWSER_ROUTINE_SCHEMA, version: 0, updatedAt: null, routines: [] };
}

function corrupt(message, cause) {
  const error = new BrowserRoutineStoreError(
    `browser routine store is malformed; refusing to continue: ${message}`,
    'BROWSER_ROUTINE_STORE_CORRUPT',
  );
  if (cause) error.cause = cause;
  return error;
}

function loadStore(userId) {
  const file = storePath(userId);
  if (!fs.existsSync(file)) return emptyStore();
  let input;
  try { input = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw corrupt('invalid JSON', error); }
  try {
    assertPlainObject(input, 'browser routine store');
    assertOnlyKeys(input, new Set(['schema', 'version', 'updatedAt', 'routines']), 'browser routine store');
    if (input.schema !== BROWSER_ROUTINE_SCHEMA) throw new TypeError('unsupported schema');
    if (!Number.isInteger(input.version) || input.version < 0) throw new TypeError('invalid version');
    if (input.updatedAt !== null && (typeof input.updatedAt !== 'string' || Number.isNaN(Date.parse(input.updatedAt)))) {
      throw new TypeError('invalid updatedAt');
    }
    if (!Array.isArray(input.routines) || input.routines.length > MAX_BROWSER_ROUTINES_PER_USER) {
      throw new TypeError('invalid routines list');
    }
    const seen = new Set();
    const routines = input.routines.map(routine => cleanRoutineInput(routine, { stored: true }));
    for (const routine of routines) {
      if (seen.has(routine.id)) throw new TypeError(`duplicate routine id: ${routine.id}`);
      seen.add(routine.id);
    }
    return { schema: BROWSER_ROUTINE_SCHEMA, version: input.version, updatedAt: input.updatedAt, routines };
  } catch (error) {
    if (error instanceof BrowserRoutineStoreError) throw error;
    throw corrupt(error.message, error);
  }
}

function persistStore(userId, store) {
  const file = storePath(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** Return all routines owned by this user, newest update first. */
export function listBrowserRoutines(userId) {
  return clone(loadStore(userId).routines)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** Return one routine only when it belongs to this user's store. */
export function getBrowserRoutine(userId, routineId) {
  validateUserId(userId);
  if (typeof routineId !== 'string' || !routineId) return null;
  return clone(loadStore(userId).routines.find(routine => routine.id === routineId) || null);
}

/**
 * Create or update one routine in the current user's store.
 * @returns {Promise<object>}
 */
export async function saveBrowserRoutine(userId, input, options = {}) {
  const file = storePath(userId);
  return withLock(file, () => {
    const store = loadStore(userId); // malformed files throw before any write
    const requestedId = typeof input?.id === 'string' ? input.id : null;
    const index = requestedId ? store.routines.findIndex(routine => routine.id === requestedId) : -1;
    const existing = index >= 0 ? store.routines[index] : null;
    if (!existing && store.routines.length >= MAX_BROWSER_ROUTINES_PER_USER) {
      throw new RangeError(`browser routine limit is ${MAX_BROWSER_ROUTINES_PER_USER} per user`);
    }
    const routine = cleanRoutineInput(input, { ...options, existing });
    if (index >= 0) store.routines[index] = routine;
    else store.routines.push(routine);
    const now = options.now ?? Date.now();
    store.version += 1;
    store.updatedAt = new Date(now).toISOString();
    persistStore(userId, store);
    return clone(routine);
  });
}

/** Delete one routine from this user's store; other users are never scanned. */
export async function deleteBrowserRoutine(userId, routineId, { now = Date.now() } = {}) {
  const file = storePath(userId);
  return withLock(file, () => {
    const store = loadStore(userId);
    const index = store.routines.findIndex(routine => routine.id === routineId);
    if (index < 0) return false;
    store.routines.splice(index, 1);
    store.version += 1;
    store.updatedAt = new Date(now).toISOString();
    persistStore(userId, store);
    return true;
  });
}

function inferredRole(element) {
  const explicit = typeof element?.role === 'string' ? element.role.trim().toLowerCase() : '';
  if (TARGET_ROLES.has(explicit)) return explicit;
  const tag = String(element?.tag || '').toLowerCase();
  const type = String(element?.type || '').toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return element?.multiple ? 'listbox' : 'combobox';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    if (!['hidden', 'file', 'color', 'range'].includes(type)) return 'textbox';
  }
  return null;
}

function targetFromObservation(element) {
  if (!isPlainObject(element) || element.sensitive === true) return null;
  const role = inferredRole(element);
  if (!role) return null;
  const label = cleanText(element.label, 'taught element label', 160, { required: false });
  const candidateName = element.ariaLabel || element.accessibleName ||
    (CLICK_ROLES.has(role) ? element.text : null) || element.placeholder || element.name;
  const name = cleanText(candidateName, 'taught element name', 160, { required: false });
  if (!name && !label) return null;
  return { role, name: name || null, label: label || null, ordinal: 1, exact: true };
}

function sameTarget(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

/**
 * Convert the transient, extension-authenticated Teach buffer into a routine
 * draft without persisting selectors, coordinates, raw HTML, or scripts.
 * Unsupported/redacted events are reported and omitted; they never inherit a
 * permissive default.
 */
export function draftBrowserRoutineFromTeachEvents({ name, description = '', events, origin = null }) {
  if (!Array.isArray(events) || !events.length) {
    throw new TypeError('Teach Mode has no observations to save');
  }
  const observedUrls = events
    .map(event => typeof event?.tabUrl === 'string' ? event.tabUrl : '')
    .filter(Boolean);
  if (observedUrls.length !== events.length) {
    throw new TypeError('Teach observations are missing their browser-authenticated URL');
  }
  let canonicalOrigin = origin ? canonicalBrowserRoutineOrigin(origin) : null;
  if (!canonicalOrigin) {
    const firstUrl = observedUrls[0];
    if (!firstUrl) throw new TypeError('Teach observations are missing their browser-authenticated URL');
    let parsed;
    try { parsed = new URL(firstUrl); } catch { throw new TypeError('Teach observation URL is invalid'); }
    canonicalOrigin = canonicalBrowserRoutineOrigin(parsed.origin);
  }
  for (const rawUrl of observedUrls) {
    let eventOrigin;
    try { eventOrigin = new URL(rawUrl).origin; } catch { throw new TypeError('Teach observation URL is invalid'); }
    if (eventOrigin !== canonicalOrigin) {
      throw new TypeError('Teach observations crossed origins; nothing was saved');
    }
  }

  const steps = [];
  const warnings = [];
  let usedEvents = 0;
  const firstUrl = observedUrls[0] || `${canonicalOrigin}/`;
  try {
    const url = new URL(firstUrl);
    const pathValue = `${url.pathname}${url.search}${url.hash}`;
    // Run the same secret-bearing URL checks as persisted navigation steps.
    steps.push({ type: 'navigate', origin: canonicalOrigin, path: normalizeNavigatePath(pathValue, canonicalOrigin) });
  } catch (error) {
    warnings.push(`The starting URL was not saved: ${error.message}`);
  }

  for (const event of events) {
    if (!isPlainObject(event)) {
      warnings.push('An invalid observation was ignored.');
      continue;
    }
    const kind = String(event.kind || '');
    if (kind === 'submit') {
      warnings.push('A demonstrated form submission was not persisted; replay confirms consequential controls separately.');
      continue;
    }
    const target = targetFromObservation(event.element);
    if (!target) {
      warnings.push(event.element?.sensitive
        ? 'A sensitive-field interaction was redacted and omitted.'
        : `An interaction without a stable accessible name was omitted (${kind || 'unknown'}).`);
      continue;
    }
    let step = null;
    if (kind === 'click') {
      // Editable/select/toggle elements also emit input/change. Persisting the
      // click would replay the same interaction twice.
      if (FILL_ROLES.has(target.role) || SELECT_ROLES.has(target.role) || TOGGLE_ROLES.has(target.role)) continue;
      if (CLICK_ROLES.has(target.role)) step = { type: 'click', origin: canonicalOrigin, target };
    } else if (kind === 'input' && String(event.element?.tag || '').toLowerCase() !== 'select'
      && FILL_ROLES.has(target.role) && typeof event.value === 'string') {
      const value = cleanText(event.value, 'taught field value', 500);
      assertNonSecretValue(value, target, 'taught field value');
      step = { type: 'fill', origin: canonicalOrigin, target, value };
      const previous = steps.at(-1);
      if (previous?.type === 'fill' && sameTarget(previous.target, target)) {
        previous.value = value; // collapse per-keystroke snapshots to the final value
        usedEvents += 1;
        continue;
      }
    } else if (kind === 'change' && SELECT_ROLES.has(target.role) && typeof event.value === 'string') {
      const option = cleanText(event.value, 'taught selected option', 160);
      assertNonSecretValue(option, target, 'taught selected option');
      step = { type: 'select', origin: canonicalOrigin, target, option };
    } else if (kind === 'change' && TOGGLE_ROLES.has(target.role) && typeof event.checked === 'boolean') {
      step = { type: 'toggle', origin: canonicalOrigin, target, checked: event.checked };
    }
    if (!step) continue;
    steps.push(step);
    usedEvents += 1;
  }

  if (!steps.some(step => step.type !== 'navigate')) {
    throw new TypeError('Teach Mode did not capture any replayable, non-sensitive actions');
  }
  if (steps.length > MAX_BROWSER_ROUTINE_STEPS) {
    throw new RangeError(`taught routine exceeds ${MAX_BROWSER_ROUTINE_STEPS} semantic steps`);
  }
  const input = {
    name,
    description,
    origin: canonicalOrigin,
    steps,
  };
  // Validate the complete draft now so callers never receive a draft that the
  // persistence layer would later reinterpret or reject differently.
  const normalized = cleanRoutineInput(input, {
    now: Date.parse('2000-01-01T00:00:00.000Z'),
    idFactory: () => '00000000-0000-4000-8000-000000000000',
  });
  return {
    input: {
      name: normalized.name,
      description: normalized.description,
      origin: normalized.origin,
      steps: normalized.steps,
    },
    usedEvents,
    warnings: [...new Set(warnings)],
  };
}

/** Save one deterministic draft built from the current Teach buffer. */
export async function saveBrowserRoutineFromTeachEvents(userId, input, options = {}) {
  const draft = draftBrowserRoutineFromTeachEvents(input);
  const routine = await saveBrowserRoutine(userId, draft.input, options);
  return { routine, usedEvents: draft.usedEvents, warnings: draft.warnings };
}

/**
 * Replay one owned routine through the already capability-gated extension.
 * `command` has the shape `(action, args, options) => Promise<result>`.
 * The extension revalidates the exact tab/origin for every step and owns the
 * per-use confirmation UI; the server stops on the first refusal or mismatch.
 * @param {string} userId
 * @param {string} routineId
 * @param {{tabId?: number, command?: (action: string, args: object, options: {timeoutMs?: number}) => Promise<any>, timeoutMs?: number}} [options]
 */
export async function replayBrowserRoutine(userId, routineId, {
  tabId,
  command,
  timeoutMs = 65_000,
} = {}) {
  validateUserId(userId);
  if (typeof command !== 'function') throw new TypeError('browser routine replay requires a browser command function');
  const exactTabId = Number(tabId);
  if (!Number.isInteger(exactTabId) || exactTabId < 1) throw new TypeError('browser routine replay requires an exact tabId');
  const routine = getBrowserRoutine(userId, routineId);
  if (!routine) throw new BrowserRoutineReplayError('browser routine was not found for this user', 'BROWSER_ROUTINE_NOT_FOUND');

  let tabs;
  try { tabs = await command('list_tabs', {}, { timeoutMs: Math.min(timeoutMs, 10_000) }); }
  catch (error) {
    throw new BrowserRoutineReplayError(error?.message || 'could not validate the browser lease', 'BROWSER_ROUTINE_LEASE_REQUIRED');
  }
  const liveTab = Array.isArray(tabs) ? tabs.find(tab => Number(tab?.tabId) === exactTabId) : null;
  if (!liveTab?.url) {
    throw new BrowserRoutineReplayError('the target tab is not covered by an active browser lease', 'BROWSER_ROUTINE_LEASE_REQUIRED');
  }
  let liveOrigin;
  try { liveOrigin = new URL(liveTab.url).origin; } catch { liveOrigin = null; }
  if (liveOrigin !== routine.origin) {
    throw new BrowserRoutineReplayError(
      `routine is bound to ${routine.origin}, but the leased tab is on ${liveOrigin || 'an invalid origin'}`,
      'BROWSER_ROUTINE_ORIGIN_MISMATCH',
    );
  }

  const results = [];
  for (let index = 0; index < routine.steps.length; index += 1) {
    const step = routine.steps[index];
    try {
      const result = await command('run_routine_step', {
        tabId: exactTabId,
        routineId: routine.id,
        routineName: routine.name,
        stepIndex: index,
        origin: routine.origin,
        step: clone(step),
      }, { timeoutMs });
      results.push({ stepIndex: index, type: step.type, result: clone(result) });
    } catch (error) {
      throw new BrowserRoutineReplayError(
        `browser routine stopped at step ${index + 1}: ${error?.message || String(error)}`,
        'BROWSER_ROUTINE_STEP_FAILED',
        { routineId: routine.id, stepIndex: index, completedSteps: results.length },
      );
    }
  }
  return {
    routineId: routine.id,
    name: routine.name,
    tabId: exactTabId,
    completedSteps: results.length,
    results,
  };
}
