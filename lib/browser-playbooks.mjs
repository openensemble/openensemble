// @ts-check
/**
 * User-owned adaptive browser playbooks.
 *
 * A playbook is deliberately not a replayable macro. It stores only semantic
 * action templates and structured verification predicates from successful,
 * extension-confirmed learning runs. Runtime values, page snapshots, raw URLs,
 * selectors, coordinates, HTML, screenshots, and failure transcripts never
 * enter this file.
 *
 * Storage: users/<userId>/browser-playbooks.json
 */

import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { USERS_DIR } from './paths.mjs';
import { canonicalBrowserRoutineOrigin } from './browser-routines.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

export const BROWSER_PLAYBOOK_SCHEMA = 1;
export const MAX_BROWSER_PLAYBOOKS_PER_USER = 100;
export const MAX_BROWSER_PLAYBOOK_TRANSITIONS = 40;

const STORE_FILE = 'browser-playbooks.json';
const MAX_STORE_BYTES = 1_048_576;
const ACTION_TYPES = new Set(['click', 'fill', 'select', 'toggle', 'wait_for']);
const TARGET_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'spinbutton',
]);
const ASSERTION_KEYS = new Set([
  'urlIncludes', 'titleIncludes', 'headingIncludes', 'statusIncludes',
  'controlPresent', 'controlAbsent',
]);
const CONTROL_ASSERTION_KEYS = new Set([
  'role', 'name', 'label', 'checked', 'selected', 'expanded', 'pressed',
  'disabled',
]);
const TARGET_KEYS = new Set(['role', 'name', 'label', 'ordinal', 'exact']);
const ACTION_KEYS = Object.freeze({
  click: new Set(['type', 'target']),
  fill: new Set(['type', 'target', 'parameter']),
  select: new Set(['type', 'target', 'parameter']),
  toggle: new Set(['type', 'target', 'checked']),
  wait_for: new Set(['type', 'target', 'state', 'timeoutMs']),
});
const STORED_PLAYBOOK_KEYS = new Set([
  'id', 'signature', 'name', 'goal', 'origin', 'transitions',
  'finalAssertions', 'successCount', 'createdAt', 'updatedAt', 'lastSucceededAt',
]);
const STORE_KEYS = new Set(['schema', 'version', 'updatedAt', 'playbooks']);
const TRANSITION_KEYS = new Set(['action', 'assertions']);
const DANGEROUS_KEY = /^(?:x|y|left|top|coordinates?|selector|css|xpath|html|script|javascript|code|expression|eval|function|cookie|headers?|authorization|credential|credentials|password|passwd|secret|token|otp|cvv|cvc|value|option|textLength|snapshot|screenshot|pageText|rawUrl)$/i;
const SECRET_TEXT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}|\b(?:password|passwd|passcode|otp|cvv|cvc|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret)\s*[:=]\s*\S+|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/i;
const HIGH_RISK_NUMBER_TEXT = /(?:\bpin(?:\s+(?:code|number|no\.?))?\s*(?::|=|#|-)?\s*\d{3,12}\b|\b(?:ssn|social[ _-]?security(?:[ _-]?(?:number|no\.?))?)\s*(?::|=|#|-)?\s*\d{3}[ -]?\d{2}[ -]?\d{4}\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:aba[ _-]?)?routing(?:[ _-]?(?:number|no\.?))?\s*(?::|=|#|-)?\s*\d(?:[ -]?\d){8}\b|\b(?:bank[ _-]?)?account(?:[ _-]?(?:number|no\.?))?\s*(?::|=|#|-)?\s*\d(?:[ -]?\d){3,33}\b|\b(?:(?:credit|debit|payment)[ _-]?)?card(?:[ _-]?(?:number|no\.?))?\s*(?::|=|#|-)?\s*\d(?:[ -]?\d){12,18}\b|\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b)/i;
const PAGE_INSTRUCTION_TEXT = /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b|\b(?:reveal|print|show|send|upload)\s+(?:the\s+)?(?:system prompt|credentials?|passwords?|tokens?|secrets?)\b|\b(?:system|developer|assistant)\s*:|\bfrom now on\b|\b(?:you|oe|the assistant)\s+(?:must|should|need to)\b|\b(?:always|never)\s+(?:click|select|fill|submit|send|upload|download|open|run|call|use)\b|\b(?:run|call|use)\s+(?:the\s+)?(?:browser_[a-z_]+|tool)\b/i;
const RAW_URL_TEXT = /\bhttps?:\/\/\S+/i;
const SENSITIVE_TARGET = /\b(?:password|passphrase|passcode|passwd|pin|one[ -]?time(?: password| code)?|otp|2fa|mfa|verification code|security code|credit card|debit card|card number|payment card|cvv|cvc|expiration date|expiry date|routing number|bank account|iban|swift|social security|ssn|medical record|patient id|member id|private key|api key|access token|auth token|secret key)\b/i;
const WAIT_STATES = new Set(['visible', 'hidden', 'enabled', 'disabled']);

function hasUnlabeledNumericSecret(value) {
  return /(?<![\p{L}\p{N}])\d(?:[\s()\-]*\d){2,18}(?![\s()\-]*\d)(?![\p{L}\p{N}])/u
    .test(String(value || ''));
}

export function browserMemoryTextContainsSecret(value) {
  const text = String(value || '');
  return SECRET_TEXT.test(text) ||
    HIGH_RISK_NUMBER_TEXT.test(text) ||
    hasUnlabeledNumericSecret(text);
}

export class BrowserPlaybookStoreError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'BROWSER_PLAYBOOK_STORE_ERROR') {
    super(message);
    this.name = 'BrowserPlaybookStoreError';
    this.code = code;
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
      throw new TypeError(`${label} may not contain runtime values, selectors, coordinates, page snapshots, scripts, or secrets (${key})`);
    }
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
}

function validateUserId(userId) {
  const value = String(userId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError('browser playbook userId is invalid');
  }
  return value;
}

function storePath(userId) {
  return path.join(USERS_DIR, validateUserId(userId), STORE_FILE);
}

function inspectUserStoreDirectory(userId, { create = false } = {}) {
  const id = validateUserId(userId);
  const usersRoot = path.resolve(USERS_DIR);
  try {
    if (create) fs.mkdirSync(usersRoot, { recursive: true, mode: 0o700 });
    const rootStat = fs.statSync(usersRoot);
    if (!rootStat.isDirectory()) throw new TypeError('users root is not a directory');
  } catch (error) {
    if (!create && error?.code === 'ENOENT') {
      return {
        userId: id,
        userDir: path.join(usersRoot, id),
        file: path.join(usersRoot, id, STORE_FILE),
        missing: true,
      };
    }
    throw corrupt(`unsafe users root: ${error?.message || error}`, error);
  }

  let rootReal;
  try { rootReal = fs.realpathSync(usersRoot); }
  catch (error) { throw corrupt(`could not resolve users root: ${error?.message || error}`, error); }
  const userDir = path.join(usersRoot, id);
  let dirStat;
  try {
    dirStat = fs.lstatSync(userDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw corrupt(`could not inspect the user store directory: ${error?.message || error}`, error);
    }
    if (!create) {
      return { userId: id, userDir, file: path.join(userDir, STORE_FILE), missing: true };
    }
    try { fs.mkdirSync(userDir, { mode: 0o700 }); }
    catch (mkdirError) {
      if (mkdirError?.code !== 'EEXIST') {
        throw corrupt(`could not create the user store directory: ${mkdirError?.message || mkdirError}`, mkdirError);
      }
    }
    try { dirStat = fs.lstatSync(userDir); }
    catch (inspectError) {
      throw corrupt(`could not inspect the created user store directory: ${inspectError?.message || inspectError}`, inspectError);
    }
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw corrupt('unsafe user store directory: expected a real directory, not a symlink or special file');
  }
  let userDirReal;
  try { userDirReal = fs.realpathSync(userDir); }
  catch (error) { throw corrupt(`could not resolve the user store directory: ${error?.message || error}`, error); }
  const expectedReal = path.join(rootReal, id);
  if (path.resolve(userDirReal) !== path.resolve(expectedReal)) {
    throw corrupt('unsafe user store directory: resolved path left the exact user boundary');
  }
  return {
    userId: id,
    userDir,
    userDirReal,
    dirDev: dirStat.dev,
    dirIno: dirStat.ino,
    file: path.join(userDir, STORE_FILE),
    missing: false,
  };
}

function openBoundUserDirectory(location) {
  if (process.platform !== 'linux') {
    throw corrupt('durable browser playbook I/O requires Linux directory-descriptor binding');
  }
  let fd = null;
  try {
    fd = fs.openSync(
      location.userDir,
      fs.constants.O_RDONLY |
        (fs.constants.O_DIRECTORY || 0) |
        (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== location.dirDev || opened.ino !== location.dirIno) {
      throw new TypeError('user store directory changed before it could be bound');
    }
    const directory = `/proc/self/fd/${fd}`;
    const procStat = fs.statSync(directory);
    if (!procStat.isDirectory() || procStat.dev !== opened.dev || procStat.ino !== opened.ino) {
      throw new TypeError('proc directory descriptor did not resolve to the expected user directory');
    }
    return {
      fd,
      directory,
      file: path.join(directory, STORE_FILE),
      bound: true,
    };
  } catch (error) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (error instanceof BrowserPlaybookStoreError) throw error;
    throw corrupt(`could not bind the user store directory: ${error?.message || error}`, error);
  }
}

function closeBoundUserDirectory(binding) {
  if (binding?.fd != null) {
    try { fs.closeSync(binding.fd); } catch {}
  }
}

function assertBoundDirectoryUnchanged(location, binding) {
  if (!binding?.bound || binding.fd == null) {
    throw corrupt('durable browser playbook I/O is not directory-descriptor bound');
  }
  const current = fs.fstatSync(binding.fd);
  if (!current.isDirectory() || current.dev !== location.dirDev || current.ino !== location.dirIno) {
    throw corrupt('bound user store directory changed during I/O');
  }
}

function inspectRegularStoreFile(binding) {
  if (!binding?.bound || binding.fd == null) {
    throw corrupt('durable browser playbook file access is not directory-descriptor bound');
  }
  const file = binding.file;
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw corrupt(`could not inspect the store: ${error?.message || error}`, error);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw corrupt('unsafe store path: expected one regular, non-symlinked file');
  }
  return stat;
}

function cleanText(value, label, max, {
  required = true,
  memorySafe = false,
} = {}) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (required && !text) throw new TypeError(`${label} is required`);
  if (text.length > max) throw new TypeError(`${label} exceeds ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${label} contains control characters`);
  }
  if (memorySafe && text && (
    browserMemoryTextContainsSecret(text) ||
    PAGE_INSTRUCTION_TEXT.test(text) ||
    RAW_URL_TEXT.test(text)
  )) {
    throw new TypeError(`${label} may not contain credentials, secrets, raw URLs, or page-authored instructions`);
  }
  return text;
}

function canonicalOrigin(value) {
  try {
    return canonicalBrowserRoutineOrigin(value);
  } catch (error) {
    throw new TypeError(String(error?.message || error).replace(/browser routine/gi, 'browser playbook'));
  }
}

function normalizeTarget(input, label) {
  assertPlainObject(input, label);
  assertOnlyKeys(input, TARGET_KEYS, label);
  const role = cleanText(input.role, `${label}.role`, 32).toLowerCase();
  if (!TARGET_ROLES.has(role)) throw new TypeError(`${label}.role is not supported`);
  const name = cleanText(input.name, `${label}.name`, 160, { required: false, memorySafe: true });
  const fieldLabel = cleanText(input.label, `${label}.label`, 160, { required: false, memorySafe: true });
  if (!name && !fieldLabel) throw new TypeError(`${label} requires an accessible name or label`);
  if (SENSITIVE_TARGET.test(`${name} ${fieldLabel}`)) {
    throw new TypeError(`${label} may not identify a password, payment, OTP, health, token, or secret field`);
  }
  const ordinal = Number(input.ordinal);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 20) {
    throw new TypeError(`${label}.ordinal must be an integer from 1 to 20`);
  }
  if (input.exact != null && typeof input.exact !== 'boolean') {
    throw new TypeError(`${label}.exact must be boolean`);
  }
  if (input.exact === false) {
    throw new TypeError(`${label}.exact must be true for durable learning`);
  }
  return {
    role,
    name: name || null,
    label: fieldLabel || null,
    ordinal,
    exact: true,
  };
}

function normalizeControlAssertion(input, label) {
  assertPlainObject(input, label);
  assertOnlyKeys(input, CONTROL_ASSERTION_KEYS, label);
  const out = {};
  if (input.role != null) {
    const role = cleanText(input.role, `${label}.role`, 32).toLowerCase();
    if (!TARGET_ROLES.has(role)) throw new TypeError(`${label}.role is not supported`);
    out.role = role;
  }
  for (const key of ['name', 'label']) {
    if (input[key] == null) continue;
    const value = cleanText(input[key], `${label}.${key}`, 160, { required: false, memorySafe: true });
    if (value) out[key] = value;
  }
  for (const key of ['checked', 'selected', 'expanded', 'pressed', 'disabled']) {
    if (input[key] == null) continue;
    if (typeof input[key] !== 'boolean') throw new TypeError(`${label}.${key} must be boolean`);
    out[key] = input[key];
  }
  const hasState = ['checked', 'selected', 'expanded', 'pressed', 'disabled']
    .some(key => typeof out[key] === 'boolean');
  if (!out.role && !out.name && !out.label) {
    throw new TypeError(`${label} requires a role, name, or label`);
  }
  if (out.role && !out.name && !out.label && !hasState) {
    throw new TypeError(`${label} requires a name, label, or explicit control state in addition to role`);
  }
  if (SENSITIVE_TARGET.test(`${out.name || ''} ${out.label || ''}`)) {
    throw new TypeError(`${label} may not identify a sensitive field`);
  }
  return out;
}

/**
 * Strictly normalize deterministic predicates used by checkpoints and stored
 * playbooks. An empty object is valid input but reports `supplied:false`.
 */
export function normalizeBrowserAssertions(input, { required = false } = {}) {
  if (input == null) {
    if (required) throw new TypeError('verification assertions are required');
    return {};
  }
  assertPlainObject(input, 'verification assertions');
  assertOnlyKeys(input, ASSERTION_KEYS, 'verification assertions');
  const out = {};
  for (const key of ['urlIncludes', 'titleIncludes', 'headingIncludes', 'statusIncludes']) {
    if (input[key] == null) continue;
    const value = cleanText(input[key], `verification assertions.${key}`, 240, {
      required: false,
      memorySafe: true,
    });
    if (value && value.length < 3) {
      throw new TypeError(`verification assertions.${key} must contain at least 3 characters`);
    }
    if (key === 'urlIncludes' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      throw new TypeError('verification assertions.urlIncludes must be a stable URL fragment, not a raw URL');
    }
    if (value) out[key] = value;
  }
  if (input.controlPresent != null) {
    out.controlPresent = normalizeControlAssertion(input.controlPresent, 'verification assertions.controlPresent');
  }
  if (input.controlAbsent != null) {
    out.controlAbsent = normalizeControlAssertion(input.controlAbsent, 'verification assertions.controlAbsent');
  }
  if (required && Object.keys(out).length === 0) {
    throw new TypeError('at least one non-empty verification assertion is required');
  }
  return out;
}

function fold(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function controlMatches(control, expected) {
  if (!control || !expected) return false;
  if (expected.role && fold(control.role) !== fold(expected.role)) return false;
  if (expected.name && !fold(control.name).includes(fold(expected.name))) return false;
  if (expected.label && !fold(control.label).includes(fold(expected.label))) return false;
  for (const key of ['checked', 'selected', 'expanded', 'pressed', 'disabled']) {
    if (typeof expected[key] === 'boolean' && control[key] !== expected[key]) return false;
  }
  return true;
}

/** Evaluate already-bounded semantic page state against strict assertions. */
export function evaluateBrowserAssertions(snapshot, input, { requireSupplied = false } = {}) {
  const assertions = normalizeBrowserAssertions(input, { required: requireSupplied });
  const checks = [];
  const addIncludes = (label, actual, expected) => {
    if (!expected) return;
    checks.push({
      label,
      passed: fold(actual).includes(fold(expected)),
      expected,
    });
  };
  addIncludes('URL', snapshot?.url, assertions.urlIncludes);
  addIncludes('title', snapshot?.title, assertions.titleIncludes);
  if (assertions.headingIncludes) {
    const matched = (Array.isArray(snapshot?.headings) ? snapshot.headings : [])
      .some(item => fold(item?.text).includes(fold(assertions.headingIncludes)));
    const truncated = snapshot?.truncated?.headings === true;
    checks.push({
      label: 'heading',
      passed: matched,
      conclusive: matched || !truncated,
      expected: assertions.headingIncludes,
      ...(!matched && truncated ? {
        reason: 'heading inventory was truncated, so absence of a match cannot be proven',
      } : {}),
    });
  }
  if (assertions.statusIncludes) {
    const matched = (Array.isArray(snapshot?.statusSignals) ? snapshot.statusSignals : [])
      .some(item => fold(item?.text).includes(fold(assertions.statusIncludes)));
    const truncated = snapshot?.truncated?.statusSignals === true;
    checks.push({
      label: 'status',
      passed: matched,
      conclusive: matched || !truncated,
      expected: assertions.statusIncludes,
      ...(!matched && truncated ? {
        reason: 'status inventory was truncated, so absence of a match cannot be proven',
      } : {}),
    });
  }
  const controls = Array.isArray(snapshot?.controls) ? snapshot.controls : [];
  if (assertions.controlPresent) {
    const matched = controls.some(control => controlMatches(control, assertions.controlPresent));
    const truncated = snapshot?.truncated?.controls === true;
    checks.push({
      label: 'control present',
      passed: matched,
      conclusive: matched || !truncated,
      expected: clone(assertions.controlPresent),
      ...(!matched && truncated ? {
        reason: 'control inventory was truncated, so absence of a matching control cannot be proven',
      } : {}),
    });
  }
  if (assertions.controlAbsent) {
    const truncated = snapshot?.truncated?.controls === true;
    const matched = controls.some(control => controlMatches(control, assertions.controlAbsent));
    checks.push({
      label: 'control absent',
      passed: !truncated && !matched,
      conclusive: matched || !truncated,
      expected: clone(assertions.controlAbsent),
      ...(!matched && truncated ? { reason: 'control inventory was truncated, so absence cannot be proven' } : {}),
    });
  }
  return {
    assertions,
    supplied: checks.length > 0,
    passed: checks.length > 0 && checks.every(check => check.passed),
    checks,
  };
}

/**
 * Reduce the extension-returned public semantic action to a durable template.
 * Fill/select values are replaced by runtime parameter markers.
 */
export function templateBrowserAction(raw, expectedOrigin) {
  assertPlainObject(raw, 'verified semantic action');
  const type = cleanText(raw.type, 'verified semantic action.type', 24).toLowerCase();
  if (!ACTION_TYPES.has(type)) throw new TypeError('verified semantic action type is unsupported');
  const allowedWireKeys = new Set([
    'type', 'origin', 'target', 'textLength', 'option', 'checked', 'state', 'timeoutMs',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedWireKeys.has(key)) {
      throw new TypeError(`verified semantic action contains unsupported field: ${key}`);
    }
  }
  if (canonicalOrigin(raw.origin) !== canonicalOrigin(expectedOrigin)) {
    throw new TypeError('verified semantic action origin does not match the learning run');
  }
  const target = normalizeTarget(raw.target, 'verified semantic action.target');
  if (type === 'click') {
    if (['checkbox', 'radio', 'switch', 'option'].includes(target.role)) {
      throw new TypeError('verified semantic action must use toggle/select instead of clicking a stateful option control');
    }
    return { type, target };
  }
  if (type === 'fill') return { type, target, parameter: 'value' };
  if (type === 'select') return { type, target, parameter: 'option' };
  if (type === 'toggle') {
    if (typeof raw.checked !== 'boolean') throw new TypeError('verified toggle action is missing its checked state');
    return { type, target, checked: raw.checked };
  }
  const state = cleanText(raw.state, 'verified wait action.state', 16).toLowerCase();
  if (!WAIT_STATES.has(state)) throw new TypeError('verified wait action state is unsupported');
  const timeoutMs = Number(raw.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) {
    throw new TypeError('verified wait action timeout is invalid');
  }
  return { type, target, state, timeoutMs };
}

function normalizeStoredAction(input, label) {
  assertPlainObject(input, label);
  const type = cleanText(input.type, `${label}.type`, 24).toLowerCase();
  if (!ACTION_TYPES.has(type)) throw new TypeError(`${label}.type is unsupported`);
  assertOnlyKeys(input, ACTION_KEYS[type], label);
  const target = normalizeTarget(input.target, `${label}.target`);
  if (type === 'click') {
    if (['checkbox', 'radio', 'switch', 'option'].includes(target.role)) {
      throw new TypeError(`${label} must use toggle/select instead of clicking a stateful option control`);
    }
    return { type, target };
  }
  if (type === 'fill' || type === 'select') {
    const expected = type === 'fill' ? 'value' : 'option';
    if (input.parameter !== expected) throw new TypeError(`${label}.parameter must be ${expected}`);
    return { type, target, parameter: expected };
  }
  if (type === 'toggle') {
    if (typeof input.checked !== 'boolean') throw new TypeError(`${label}.checked must be boolean`);
    return { type, target, checked: input.checked };
  }
  const state = cleanText(input.state, `${label}.state`, 16).toLowerCase();
  if (!WAIT_STATES.has(state)) throw new TypeError(`${label}.state is unsupported`);
  const timeoutMs = Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) {
    throw new TypeError(`${label}.timeoutMs must be between 100 and 15000`);
  }
  return { type, target, state, timeoutMs };
}

function normalizeTransition(input, index) {
  const label = `browser playbook transition ${index + 1}`;
  assertPlainObject(input, label);
  assertOnlyKeys(input, TRANSITION_KEYS, label);
  return {
    action: normalizeStoredAction(input.action, `${label}.action`),
    assertions: normalizeBrowserAssertions(input.assertions, { required: true }),
  };
}

function signatureFor({ origin, goal, transitions, finalAssertions }) {
  const structural = {
    origin,
    goal: fold(goal),
    transitions,
    finalAssertions,
  };
  return createHash('sha256').update(JSON.stringify(structural)).digest('hex');
}

function normalizePlaybookId(value) {
  const id = cleanText(value, 'browser playbook id', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) {
    throw new TypeError('browser playbook id is invalid');
  }
  return id;
}

function normalizePlaybook(input, {
  stored = false,
  existing = null,
  now = Date.now(),
  idFactory = randomUUID,
} = {}) {
  assertPlainObject(input, 'browser playbook');
  if (stored) assertOnlyKeys(input, STORED_PLAYBOOK_KEYS, 'browser playbook');
  const origin = canonicalOrigin(input.origin);
  const name = cleanText(input.name, 'browser playbook name', 100, { memorySafe: true });
  const goal = cleanText(input.goal, 'browser playbook goal', 300, { memorySafe: true });
  if (!Array.isArray(input.transitions) || input.transitions.length < 1) {
    throw new TypeError('browser playbook requires at least one verified transition');
  }
  if (input.transitions.length > MAX_BROWSER_PLAYBOOK_TRANSITIONS) {
    throw new TypeError(`browser playbook exceeds ${MAX_BROWSER_PLAYBOOK_TRANSITIONS} transitions`);
  }
  const transitions = input.transitions.map(normalizeTransition);
  const finalAssertions = normalizeBrowserAssertions(input.finalAssertions, { required: true });
  const signature = signatureFor({ origin, goal, transitions, finalAssertions });
  const stamp = new Date(now).toISOString();
  if (stamp === 'Invalid Date') throw new TypeError('browser playbook timestamp is invalid');

  if (!stored) {
    return {
      id: normalizePlaybookId(existing?.id || `bpb_${idFactory()}`),
      signature,
      name,
      goal,
      origin,
      transitions,
      finalAssertions,
      successCount: Number(existing?.successCount || 0) + 1,
      createdAt: existing?.createdAt || stamp,
      updatedAt: stamp,
      lastSucceededAt: stamp,
    };
  }

  const id = normalizePlaybookId(input.id);
  if (input.signature !== signature) throw new TypeError('browser playbook signature is invalid');
  const successCount = Number(input.successCount);
  if (!Number.isSafeInteger(successCount) || successCount < 1) {
    throw new TypeError('browser playbook successCount is invalid');
  }
  for (const key of ['createdAt', 'updatedAt', 'lastSucceededAt']) {
    if (typeof input[key] !== 'string' || Number.isNaN(Date.parse(input[key]))) {
      throw new TypeError(`browser playbook ${key} is invalid`);
    }
  }
  return {
    id,
    signature,
    name,
    goal,
    origin,
    transitions,
    finalAssertions,
    successCount,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastSucceededAt: input.lastSucceededAt,
  };
}

function emptyStore() {
  return { schema: BROWSER_PLAYBOOK_SCHEMA, version: 0, updatedAt: null, playbooks: [] };
}

function corrupt(message, cause) {
  const error = new BrowserPlaybookStoreError(
    `browser playbook store is malformed; refusing to continue: ${message}`,
    'BROWSER_PLAYBOOK_STORE_CORRUPT',
  );
  if (cause) error.cause = cause;
  return error;
}

function loadStore(userId) {
  if (process.platform !== 'linux') {
    try {
      fs.lstatSync(path.resolve(USERS_DIR));
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyStore();
      throw corrupt(`could not inspect the users root: ${error?.message || error}`, error);
    }
    throw corrupt('durable browser playbook I/O requires Linux directory-descriptor binding');
  }
  const location = inspectUserStoreDirectory(userId);
  if (location.missing) return emptyStore();
  const binding = openBoundUserDirectory(location);
  let storeFd = null;
  let input;
  try {
    if (!inspectRegularStoreFile(binding)) return emptyStore();
    storeFd = fs.openSync(
      binding.file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(storeFd);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new TypeError('opened store is not one regular file');
    }
    if (opened.size > MAX_STORE_BYTES) {
      throw new TypeError(`store exceeds ${MAX_STORE_BYTES} bytes`);
    }
    if ((opened.mode & 0o777) !== 0o600) fs.fchmodSync(storeFd, 0o600);
    input = JSON.parse(fs.readFileSync(storeFd, 'utf8'));
    assertBoundDirectoryUnchanged(location, binding);
  } catch (error) {
    throw corrupt(error?.message || 'could not safely read the store', error);
  } finally {
    if (storeFd != null) {
      try { fs.closeSync(storeFd); } catch {}
    }
    closeBoundUserDirectory(binding);
  }
  try {
    assertPlainObject(input, 'browser playbook store');
    assertOnlyKeys(input, STORE_KEYS, 'browser playbook store');
    if (input.schema !== BROWSER_PLAYBOOK_SCHEMA) throw new TypeError('unsupported schema');
    if (!Number.isInteger(input.version) || input.version < 0) throw new TypeError('invalid version');
    if (input.updatedAt !== null && (typeof input.updatedAt !== 'string' || Number.isNaN(Date.parse(input.updatedAt)))) {
      throw new TypeError('invalid updatedAt');
    }
    if (!Array.isArray(input.playbooks) || input.playbooks.length > MAX_BROWSER_PLAYBOOKS_PER_USER) {
      throw new TypeError('invalid playbooks list');
    }
    const playbooks = input.playbooks.map(playbook => normalizePlaybook(playbook, { stored: true }));
    const ids = new Set();
    const signatures = new Set();
    for (const playbook of playbooks) {
      if (ids.has(playbook.id)) throw new TypeError(`duplicate playbook id: ${playbook.id}`);
      if (signatures.has(playbook.signature)) throw new TypeError(`duplicate playbook signature: ${playbook.signature}`);
      ids.add(playbook.id);
      signatures.add(playbook.signature);
    }
    return {
      schema: BROWSER_PLAYBOOK_SCHEMA,
      version: input.version,
      updatedAt: input.updatedAt,
      playbooks,
    };
  } catch (error) {
    if (error instanceof BrowserPlaybookStoreError) throw error;
    throw corrupt(error?.message || 'invalid data', error);
  }
}

function atomicWriteStoreSync(location, binding, encoded) {
  const tmp = path.join(
    binding.directory,
    `.${STORE_FILE}.tmp.${process.pid}.${randomUUID().replace(/-/g, '')}`,
  );
  let writtenFd = null;
  try {
    fs.writeFileSync(tmp, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    assertBoundDirectoryUnchanged(location, binding);
    inspectRegularStoreFile(binding);
    // rename(2) replaces a last-moment symlink instead of following it.
    fs.renameSync(tmp, binding.file);
    const written = inspectRegularStoreFile(binding);
    if (!written) throw corrupt('store disappeared after persistence');
    writtenFd = fs.openSync(
      binding.file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(writtenFd);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw corrupt('persisted store was replaced by an unsafe file');
    }
    fs.fchmodSync(writtenFd, 0o600);
    assertBoundDirectoryUnchanged(location, binding);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  } finally {
    if (writtenFd != null) {
      try { fs.closeSync(writtenFd); } catch {}
    }
  }
}

function persistStore(userId, store) {
  if (process.platform !== 'linux') {
    throw corrupt('durable browser playbook I/O requires Linux directory-descriptor binding');
  }
  const location = inspectUserStoreDirectory(userId, { create: true });
  if (location.missing) throw corrupt('could not create the user store directory');
  const binding = openBoundUserDirectory(location);
  try {
    inspectRegularStoreFile(binding);
    fs.fchmodSync(binding.fd, 0o700);
    const encoded = `${JSON.stringify(store, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > MAX_STORE_BYTES) {
      throw new RangeError(`browser playbook store exceeds ${MAX_STORE_BYTES} bytes`);
    }
    atomicWriteStoreSync(location, binding, encoded);
  } catch (error) {
    if (error instanceof BrowserPlaybookStoreError || error instanceof RangeError) throw error;
    throw corrupt(`could not safely persist the store: ${error?.message || error}`, error);
  } finally {
    closeBoundUserDirectory(binding);
  }
}

function goalTokens(value) {
  const stop = new Set(['a', 'an', 'and', 'at', 'do', 'for', 'in', 'it', 'my', 'of', 'on', 'the', 'this', 'to', 'with']);
  return new Set(fold(value).match(/[a-z0-9]{2,}/g)?.filter(token => !stop.has(token)) || []);
}

function relevance(playbook, goal) {
  if (!goal) return 0;
  if (fold(playbook.goal) === fold(goal)) return 10_000;
  const wanted = goalTokens(goal);
  const known = goalTokens(playbook.goal);
  if (!wanted.size || !known.size) return 0;
  let overlap = 0;
  for (const token of wanted) if (known.has(token)) overlap += 1;
  return overlap / Math.max(wanted.size, known.size);
}

/** Save or merge one structurally identical, fully verified playbook. */
export async function saveBrowserPlaybook(userId, input, options = {}) {
  const file = storePath(userId);
  return withLock(file, () => {
    const store = loadStore(userId);
    const candidate = normalizePlaybook(input, options);
    const index = store.playbooks.findIndex(playbook => playbook.signature === candidate.signature);
    if (index < 0 && store.playbooks.length >= MAX_BROWSER_PLAYBOOKS_PER_USER) {
      throw new RangeError(`browser playbook limit is ${MAX_BROWSER_PLAYBOOKS_PER_USER} per user`);
    }
    const existing = index >= 0 ? store.playbooks[index] : null;
    const playbook = normalizePlaybook(input, { ...options, existing });
    if (index >= 0) store.playbooks[index] = playbook;
    else store.playbooks.push(playbook);
    store.version += 1;
    store.updatedAt = playbook.updatedAt;
    persistStore(userId, store);
    return clone(playbook);
  });
}

/** List only this user's playbooks, optionally exact-origin filtered/ranked. */
export function listBrowserPlaybooks(userId, { origin = null, goal = '', limit = 20 } = {}) {
  const exactOrigin = origin ? canonicalOrigin(origin) : null;
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  return clone(loadStore(userId).playbooks)
    .filter(playbook => !exactOrigin || playbook.origin === exactOrigin)
    .map(playbook => ({ ...playbook, relevance: relevance(playbook, goal) }))
    .filter(playbook => !goal || playbook.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance
      || b.successCount - a.successCount
      || b.updatedAt.localeCompare(a.updatedAt)
      || a.id.localeCompare(b.id))
    .slice(0, boundedLimit);
}

/** Delete one playbook only from the current user's store. */
export async function deleteBrowserPlaybook(userId, playbookId, { now = Date.now() } = {}) {
  const id = cleanText(playbookId, 'browser playbook id', 100);
  const file = storePath(userId);
  return withLock(file, () => {
    const store = loadStore(userId);
    const index = store.playbooks.findIndex(playbook => playbook.id === id);
    if (index < 0) return false;
    store.playbooks.splice(index, 1);
    store.version += 1;
    store.updatedAt = new Date(now).toISOString();
    persistStore(userId, store);
    return true;
  });
}
