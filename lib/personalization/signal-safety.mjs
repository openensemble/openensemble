// @ts-check
/**
 * Bounded, deterministic sanitizers shared by Personalization's recorder and
 * encrypted observation store. This is deliberately a leaf module: no config,
 * storage, LLM, or route dependencies.
 */
import { isSensitiveArgName } from '../learning-safety.mjs';

export const STRUCTURED_SIGNAL_TYPES = Object.freeze([
  'preference',
  'correction',
  'choice',
  'outcome',
]);

const STRUCTURED_SIGNAL_TYPE_SET = new Set(STRUCTURED_SIGNAL_TYPES);
const EXTRA_SENSITIVE_KEY_RE = /credential|cookie|private[_.-]?key|client[_.-]?secret|session[_.-]?(?:id|key)|csrf/i;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_METADATA_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
const SECRET_VALUE_RES = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
  /\bbasic\s+[A-Za-z0-9+/=]{8,}/i,
  /\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)=[^\s&]{4,}/i,
  /\b(?:my\s+)?(?:password|passcode|api[_-]?key|access[_-]?token|secret)\s*(?:is|:)\s*[^\s,;]{4,}/i,
  /\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

/** @type {Array<[RegExp, string]>} */
const SECRET_TEXT_REPLACERS = [
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]'],
  [/\bbasic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [redacted]'],
  [/\b((?:api[_-]?key|access[_-]?token|authorization|password|secret)=)[^\s&]{4,}/gi, '$1[redacted]'],
  [/\b((?:my\s+)?(?:password|passcode|api[_-]?key|access[_-]?token|secret)\s*(?:is|:)\s*)[^\s,;]{4,}/gi, '$1[redacted]'],
  [/(\bhttps?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[redacted]@'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi, '[redacted]'],
  [/\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
];

const MAX_ENTITIES = 12;
const MAX_ENTITY_LEN = 80;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_DEPTH = 3;
const MAX_METADATA_ARRAY = 8;
const MAX_METADATA_STRING = 160;
const MAX_SIGNAL_TEXT = 400;

export function isStructuredSignalType(value) {
  return STRUCTURED_SIGNAL_TYPE_SET.has(value);
}

export function isSensitiveSignalKey(key) {
  return isSensitiveArgName(key) || EXTRA_SENSITIVE_KEY_RE.test(String(key || ''));
}

function looksLikeSecretValue(value) {
  return SECRET_VALUE_RES.some(re => re.test(value));
}

function containsOnlyRedactedCredential(value) {
  const residue = String(value || '')
    .replace(/\b(?:Bearer|Basic) \[redacted\]/gi, '')
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)=\[redacted\]/gi, '')
    .replace(/\b(?:my\s+)?(?:password|passcode|api[_-]?key|access[_-]?token|secret)\s*(?:is|:)\s*\[redacted\]/gi, '')
    .replace(/\[redacted\]/g, '')
    .trim();
  return !residue;
}

function cleanText(value, maxLen) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

/**
 * Redact credential-shaped substrings without discarding the useful text
 * around them. The final slice happens after replacement so a credential at
 * the output boundary cannot be partially persisted.
 */
export function redactSecretsInText(value, maxLen = 240) {
  if (typeof value !== 'string') return '';
  const cap = Math.max(0, Number(maxLen) || 0);
  if (!cap) return '';
  let text = cleanText(value, Math.max(cap + 512, cap * 2));
  for (const [pattern, replacement] of SECRET_TEXT_REPLACERS) {
    text = text.replace(pattern, replacement);
  }
  return text.length > cap ? text.slice(0, cap) : text;
}

/** One-line, bounded text suitable for an encrypted observation digest. */
export function sanitizeSignalText(value, maxLen = MAX_SIGNAL_TEXT) {
  return typeof value === 'string' ? cleanText(value, maxLen) : '';
}

/**
 * Recursively redact credential-shaped fields and values while bounding the
 * work performed on adversarial/cyclic inputs. The result is JSON-safe.
 */
export function redactSecretsDeep(value, {
  maxDepth = 5,
  maxKeys = 32,
  maxArray = 16,
  maxString = 240,
} = {}) {
  const seen = new WeakSet();

  function visit(input, depth) {
    if (input == null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'bigint') return '[bigint]';
    if (typeof input === 'string') {
      const text = cleanText(input, maxString);
      if (!looksLikeSecretValue(text)) return text;
      const redacted = redactSecretsInText(text, maxString);
      return containsOnlyRedactedCredential(redacted) ? '[redacted]' : redacted;
    }
    if (typeof input !== 'object') return `[${typeof input}]`;
    if (Buffer.isBuffer(input) || ArrayBuffer.isView(input)) {
      return `[binary:${input.byteLength ?? 0}]`;
    }
    if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.toISOString();
    if (depth >= maxDepth) return '[max-depth]';
    if (seen.has(input)) return '[circular]';
    seen.add(input);

    if (Array.isArray(input)) {
      const out = input.slice(0, maxArray).map(item => visit(item, depth + 1));
      if (input.length > maxArray) out.push(`[+${input.length - maxArray} items]`);
      return out;
    }

    const out = Object.create(null);
    let redactedKeyIndex = 0;
    const entries = Object.entries(input).slice(0, maxKeys);
    for (const [key, item] of entries) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (isSensitiveSignalKey(key)) {
        let safeKey;
        do { safeKey = `redactedKey${++redactedKeyIndex}`; } while (Object.hasOwn(out, safeKey));
        out[safeKey] = '[redacted]';
      } else {
        out[key] = visit(item, depth + 1);
      }
    }
    if (Object.keys(input).length > maxKeys) out._truncated = true;
    return out;
  }

  return visit(value, 0);
}

export function sanitizeSignalEntities(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const entity = cleanText(item, MAX_ENTITY_LEN);
    if (looksLikeSecretValue(entity) || redactSecretsInText(entity, MAX_ENTITY_LEN).includes('[redacted]')) continue;
    const dedupeKey = entity.toLocaleLowerCase();
    if (!entity || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(entity);
    if (out.length >= MAX_ENTITIES) break;
  }
  return out;
}

/**
 * Metadata is additive/audit-oriented, never an unbounded content side-channel.
 * Top-level keys must be simple identifiers; values are recursively bounded and
 * credential-redacted.
 */
export function sanitizeSignalMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const redacted = redactSecretsDeep(value, {
    maxDepth: MAX_METADATA_DEPTH,
    maxKeys: MAX_METADATA_KEYS,
    maxArray: MAX_METADATA_ARRAY,
    maxString: MAX_METADATA_STRING,
  });
  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) return {};
  const out = {};
  for (const [key, item] of Object.entries(redacted)) {
    if (DANGEROUS_KEYS.has(key) || !SAFE_METADATA_KEY_RE.test(key)) continue;
    out[key] = item;
  }
  return out;
}
