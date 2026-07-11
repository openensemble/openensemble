// @ts-check
/**
 * Deterministic, bounded structure for unmistakable preference statements.
 *
 * This module intentionally does not use a model or merchant allowlist. It
 * extracts only syntax that is strong enough to stand on its own and returns
 * null for questions, imperatives, and mixed preference/action requests.
 */
import { redactSecretsDeep, sanitizeSignalText } from './signal-safety.mjs';

const MAX_INPUT_LEN = 300;
const MAX_SUBJECT_LEN = 120;
const MAX_MERCHANT_LEN = 80;
const MAX_CONTEXT_LEN = 40;
const MAX_UNIT_LEN = 24;
const MAX_TEMPORARY_HINT_LEN = 40;
const MAX_PRICE = 100_000_000;

const TOP_LEVEL_KEYS = new Set([
  'subject', 'sentiment', 'merchant', 'context', 'priceCeiling', 'temporary',
]);
const PRICE_KEYS = new Set(['value', 'currency', 'unit']);
const TEMPORARY_KEYS = new Set(['hint', 'expiresAt']);

const QUESTION_PREFIX_RE = /^(?:what'?s?|which|who'?s?|whose|when|where|why|how|do|does|did|is|are|was|were|can|could|should|would|will|am|have|has|had|may|might)\b/i;
const ACTION_VERB = '(?:buy|purchase|order|add|find|search|look|show|get|grab|pick\\s+up|tell|check|remind|schedule|send|book|reserve|notify|alert|watch|monitor)';
const IMPERATIVE_RE = new RegExp(`^(?:please\\s+)?${ACTION_VERB}\\b`, 'i');
const MIXED_ACTION_RE = new RegExp(`(?:[.,;:!?&]|\\s[-—]\\s|\\b(?:and|but|so|then)\\b)\\s*(?:(?:also|now|just|later|next|afterwards?|after\\s+that|subsequently)\\s+)*(?:please\\s+)?(?:(?:(?:can|could|would|will)\\s+you|(?:i|we)\\s+(?:want|need)\\s+you\\s+to)\\s+(?:please\\s+)?)?${ACTION_VERB}\\b`, 'i');
const INLINE_PLEASE_ACTION_RE = new RegExp(`\\bplease\\s+${ACTION_VERB}\\b`, 'i');
const REQUEST_RE = /\b(?:can|could|would|will)\s+you\b/i;
const PREFERENCE_CUE_RE = /\b(?:i|we)\s+(?:(?:really|absolutely|especially)\s+)?(?:love|adore|like|enjoy|prefer|only\s+(?:buy|purchase|order|choose|eat|drink|use|wear|want))\b/i;

const PRICE_CEILING_RE = /\b(?:under|below|less\s+than|at\s+most|no\s+more\s+than|up\s+to|not\s+over|maximum(?:\s+of)?)\s*(?:([A-Z]{3})\s*)?([$€£])?\s*(\d{1,8}(?:,\d{3})*(?:\.\d{1,2})?)(?![\d,.])(?:\s*(?:\/|per\s+)([\p{L}][\p{L}\p{N}._-]{0,23}))?/iu;
const MERCHANT_RE = /\b(?:at|from|through)\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N}&'’.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}&'’.-]*){0,3})(?=\s+(?:under|below|less|at\s+most|no\s+more|up\s+to|until|for\s+the\s+next|this\s+week|today|for\s+now)\b|\s*[,.;!?]?\s*$)/iu;
const PRONOUN_ONLY_RE = /^(?:it|this|that|them|these|those|something|anything)$/i;

const UNIT_ALIASES = new Map([
  ['lbs', 'lb'], ['pound', 'lb'], ['pounds', 'lb'],
  ['kgs', 'kg'], ['kilogram', 'kg'], ['kilograms', 'kg'],
  ['ounce', 'oz'], ['ounces', 'oz'],
  ['ea', 'each'], ['item', 'each'],
  ['pkg', 'package'], ['packages', 'package'],
  ['gallon', 'gal'], ['gallons', 'gal'],
  ['liter', 'l'], ['liters', 'l'], ['litre', 'l'], ['litres', 'l'],
  ['months', 'month'], ['weeks', 'week'], ['days', 'day'], ['nights', 'night'],
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cleanFacet(value, maxLen, { lower = false } = {}) {
  if (typeof value !== 'string') return '';
  const clean = sanitizeSignalText(value, maxLen + 1)
    .replace(/^[\s,;:.]+|[\s,;:.]+$/g, '')
    .trim();
  if (!clean || clean.length > maxLen) return '';
  const redacted = String(redactSecretsDeep(clean, { maxString: maxLen + 1 }) || '');
  if (!redacted || redacted.includes('[redacted]')) return '';
  return lower ? redacted.toLocaleLowerCase() : redacted;
}

function normalizeCurrency(value) {
  if (value == null || value === '') return null;
  const currency = String(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function normalizeUnit(value) {
  if (value == null || value === '') return null;
  const unit = cleanFacet(value, MAX_UNIT_LEN, { lower: true });
  if (!unit || !/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(unit)) return null;
  return UNIT_ALIASES.get(unit) || unit;
}

function normalizePriceCeiling(value) {
  if (!isPlainObject(value)) return null;
  const amount = typeof value.value === 'number' ? value.value : Number(value.value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PRICE) return null;
  const currency = normalizeCurrency(value.currency);
  if (value.currency != null && value.currency !== '' && !currency) return null;
  const unit = normalizeUnit(value.unit);
  if (value.unit != null && value.unit !== '' && !unit) return null;
  return {
    value: Math.round(amount * 100) / 100,
    ...(currency ? { currency } : {}),
    ...(unit ? { unit } : {}),
  };
}

function normalizeExpiry(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeTemporary(value) {
  if (!isPlainObject(value)) return null;
  const hint = value.hint == null
    ? '' : cleanFacet(value.hint, MAX_TEMPORARY_HINT_LEN, { lower: true });
  const expiresAt = value.expiresAt == null ? null : normalizeExpiry(value.expiresAt);
  if (value.hint != null && !hint) return null;
  if (value.expiresAt != null && !expiresAt) return null;
  if (!hint && !expiresAt) return null;
  return {
    ...(hint ? { hint } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * Normalize a structure before persistence. Unknown fields are ignored here;
 * strict ledger reads separately reject non-canonical stored shapes.
 */
export function normalizePreferenceStructure(value) {
  if (!isPlainObject(value)) return null;
  const subject = cleanFacet(value.subject, MAX_SUBJECT_LEN);
  if (!subject || !['positive', 'negative'].includes(value.sentiment)) return null;
  const merchant = value.merchant == null ? '' : cleanFacet(value.merchant, MAX_MERCHANT_LEN);
  const context = value.context == null
    ? '' : cleanFacet(value.context, MAX_CONTEXT_LEN, { lower: true });
  if (value.merchant != null && !merchant) return null;
  if (value.context != null && (!context || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(context))) return null;
  const priceCeiling = value.priceCeiling == null ? null : normalizePriceCeiling(value.priceCeiling);
  const temporary = value.temporary == null ? null : normalizeTemporary(value.temporary);
  if (value.priceCeiling != null && !priceCeiling) return null;
  if (value.temporary != null && !temporary) return null;
  return {
    subject,
    sentiment: value.sentiment,
    ...(merchant ? { merchant } : {}),
    ...(context ? { context } : {}),
    ...(priceCeiling ? { priceCeiling } : {}),
    ...(temporary ? { temporary } : {}),
  };
}

function sameKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function sameCanonicalValue(left, right) {
  if (left === right) return true;
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key)
      && sameCanonicalValue(left[key], right[key]));
}

/** True only for the canonical bounded representation written by this module. */
export function isValidPreferenceStructure(value) {
  if (!isPlainObject(value) || !sameKeys(value, TOP_LEVEL_KEYS)) return false;
  if (value.priceCeiling != null
    && (!isPlainObject(value.priceCeiling) || !sameKeys(value.priceCeiling, PRICE_KEYS))) return false;
  if (value.temporary != null
    && (!isPlainObject(value.temporary) || !sameKeys(value.temporary, TEMPORARY_KEYS))) return false;
  const normalized = normalizePreferenceStructure(value);
  if (!normalized) return false;
  return sameCanonicalValue(normalized, value);
}

function priceCurrency(code, symbol) {
  if (code) return code.toUpperCase();
  if (symbol === '$') return 'USD';
  if (symbol === '€') return 'EUR';
  if (symbol === '£') return 'GBP';
  return null;
}

function localDateParts(date, timeZone = null) {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      }).formatToParts(date);
      const pick = type => parts.find(part => part.type === type)?.value;
      const weekdays = new Map([
        ['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3],
        ['Thu', 4], ['Fri', 5], ['Sat', 6],
      ]);
      const result = {
        year: Number(pick('year')), month: Number(pick('month')),
        day: Number(pick('day')), weekday: weekdays.get(pick('weekday')),
      };
      if (Number.isInteger(result.year) && Number.isInteger(result.month)
        && Number.isInteger(result.day) && Number.isInteger(result.weekday)) return result;
    } catch { /* use server-local time */ }
  }
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
    day: date.getUTCDate(), weekday: date.getUTCDay(),
  };
}

function zonedLocalMidnightUtc(year, month, day, timeZone) {
  let guess = Date.UTC(year, month - 1, day);
  for (let i = 0; i < 4; i++) {
    const actual = localDateParts(new Date(guess), timeZone);
    const clock = new Intl.DateTimeFormat('en-US', {
      timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const part = type => Number(clock.find(value => value.type === type)?.value || 0);
    const delta = Date.UTC(year, month - 1, day)
      - Date.UTC(actual.year, actual.month - 1, actual.day)
      - (part('hour') * 3_600_000 + part('minute') * 60_000 + part('second') * 1_000);
    if (!delta) break;
    guess += delta;
  }
  return guess;
}

function endOfLocalDate(year, month, day, timeZone = null) {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  if (timeZone) {
    try {
      return new Date(zonedLocalMidnightUtc(
        next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone,
      ) - 1).toISOString();
    } catch { /* use server-local time */ }
  }
  return new Date(Date.UTC(year, month - 1, day + 1) - 1).toISOString();
}

function parseIsoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed : null;
}

function extractTemporary(text, now, timeZone = null) {
  let match = text.match(/\buntil\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (match) {
    const parsed = parseIsoDay(match[1]);
    if (parsed) {
      return {
        hint: `until ${match[1]}`,
        expiresAt: endOfLocalDate(
          parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(), timeZone,
        ),
      };
    }
  }
  match = text.match(/\bfor\s+the\s+next\s+(\d{1,3})\s+(day|week|month)s?\b/i);
  if (match) {
    const count = Number(match[1]);
    const multiplier = match[2].toLowerCase() === 'day' ? 1
      : match[2].toLowerCase() === 'week' ? 7 : 30;
    const days = count * multiplier;
    if (count > 0 && days <= 3650) {
      return {
        hint: `for the next ${count} ${match[2].toLowerCase()}${count === 1 ? '' : 's'}`,
        expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
      };
    }
  }
  if (/\bthis\s+week\b/i.test(text)) {
    const local = localDateParts(now, timeZone);
    const end = new Date(Date.UTC(local.year, local.month - 1, local.day + ((7 - local.weekday) % 7)));
    return {
      hint: 'this week',
      expiresAt: endOfLocalDate(
        end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate(), timeZone,
      ),
    };
  }
  if (/\btoday\b/i.test(text)) {
    const local = localDateParts(now, timeZone);
    return { hint: 'today', expiresAt: endOfLocalDate(local.year, local.month, local.day, timeZone) };
  }
  if (/\bfor\s+now\b/i.test(text)) {
    return { hint: 'for now', expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString() };
  }
  if (/\btemporarily\b/i.test(text)) {
    return { hint: 'temporarily', expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString() };
  }
  return null;
}

function inferContext(text, verb) {
  if (/\b(?:for|at)\s+breakfast\b/i.test(text)) return 'breakfast';
  if (/\b(?:for|at)\s+lunch\b/i.test(text)) return 'lunch';
  if (/\b(?:for|at)\s+dinner\b/i.test(text)) return 'dinner';
  if (/\b(?:when|while)\s+travell?ing\b|\bon\s+(?:a\s+)?trips?\b/i.test(text)) return 'travel';
  if (/\bat\s+work\b/i.test(text)) return 'work';
  if (/\bat\s+home\b/i.test(text)) return 'home';
  if (/^(?:buy|purchase|order|choose|want)$/i.test(verb || '')) return 'purchase';
  if (/^(?:eat|drink)$/i.test(verb || '')) return 'consumption';
  if (/^(?:use|wear)$/i.test(verb || '')) return 'usage';
  return null;
}

function merchantFacet(match) {
  const merchant = match ? cleanFacet(match[1], MAX_MERCHANT_LEN)
    .replace(/\s+(?:this\s+week|today|for\s+now|temporarily)$/i, '').trim() : '';
  return /^(?:home|work|school|breakfast|lunch|dinner|morning|afternoon|evening|night)$/i.test(merchant)
    ? '' : merchant;
}

function stripConditions(subject) {
  let value = subject
    .split(/\s+(?:over|rather\s+than|instead\s+of)\s+/i)[0]
    .replace(PRICE_CEILING_RE, '')
    .replace(MERCHANT_RE, '')
    .replace(/\buntil\s+\d{4}-\d{2}-\d{2}\b/gi, '')
    .replace(/\bfor\s+the\s+next\s+\d{1,3}\s+(?:day|week|month)s?\b/gi, '')
    .replace(/\b(?:this\s+week|today|for\s+now|temporarily)\b/gi, '')
    .replace(/\b(?:for|at)\s+(?:breakfast|lunch|dinner)\b/gi, '')
    .replace(/\b(?:when|while)\s+travell?ing\b|\bon\s+(?:a\s+)?trips?\b/gi, '')
    .replace(/\bat\s+(?:work|home)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.]+|[\s,;:.]+$/g, '')
    .trim();
  // A dangling connector means the statement did not fit the narrow grammar.
  value = value.replace(/\s+(?:at|from|through|under|below|until|for)$/i, '').trim();
  return value;
}

/**
 * Extract useful facets from a standalone, unmistakable preference statement.
 * `now` is injectable so temporary hints are deterministic in tests/callers.
 */
export function extractPreferenceStructure(input, { now = new Date(), timeZone = null } = {}) {
  const text = sanitizeSignalText(input, MAX_INPUT_LEN + 1);
  if (!text || text.length > MAX_INPUT_LEN || text.includes('?')
    || QUESTION_PREFIX_RE.test(text) || IMPERATIVE_RE.test(text)
    || REQUEST_RE.test(text) || MIXED_ACTION_RE.test(text)
    || INLINE_PLEASE_ACTION_RE.test(text)) return null;
  const safeText = String(redactSecretsDeep(text, { maxString: MAX_INPUT_LEN + 1 }) || '');
  if (!safeText || safeText.includes('[redacted]')) return null;
  const statement = safeText.replace(/[.!]+$/, '').trim();

  let rawSubject = '';
  let sentiment = '';
  let verb = '';
  let match = statement.match(/^(?:i|we)\s+(?:(?:really|absolutely|especially)\s+)?(love|adore|like|enjoy|prefer)\s+(.{3,260})$/i);
  if (match) {
    sentiment = 'positive';
    verb = match[1].toLowerCase();
    rawSubject = match[2];
  } else {
    match = statement.match(/^(?:i|we)\s+(?:(?:really|absolutely)\s+)?(?:do\s+not\s+like|don['’]?t\s+like|dislike|hate|avoid|can['’]?t\s+stand|am\s+allergic\s+to)\s+(.{3,250})$/i);
    if (match) {
      sentiment = 'negative';
      rawSubject = match[1];
    }
  }
  // The editable profile stores some direct preferences in concise canonical
  // form (for example "Avoids Gala apples" or "Only buys Honeycrisp").
  // Re-accept those forms so a user correction can refresh, rather than retain
  // stale, structured polarity/subject facets from the prior wording.
  if (!rawSubject) {
    match = statement.match(/^(?:likes?|loves?|adores?|enjoys?|prefers?)\s+(.{3,260})$/i);
    if (match) {
      sentiment = 'positive';
      rawSubject = match[1];
    }
  }
  if (!rawSubject) {
    match = statement.match(/^(?:avoids?|dislikes?|hates?)\s+(.{3,250})$/i);
    if (match) {
      sentiment = 'negative';
      rawSubject = match[1];
    }
  }
  if (!rawSubject) {
    match = statement.match(/^(?:i|we)\s+(only|always|never|do\s+not|don['’]?t)\s+(buy|purchase|order|choose|eat|drink|use|wear|want)\s+(.{3,245})$/i);
    if (match) {
      sentiment = /^(?:never|do\s+not|don['’]?t)$/i.test(match[1]) ? 'negative' : 'positive';
      verb = match[2].toLowerCase();
      rawSubject = match[3];
    }
  }
  if (!rawSubject) {
    match = statement.match(/^only\s+(buys?|purchases?|orders?|chooses?|eats?|drinks?|uses?|wears?|wants?)\s+(.{3,245})$/i);
    if (match) {
      sentiment = 'positive';
      const form = match[1].toLowerCase();
      verb = form.startsWith('purchas') ? 'purchase'
        : form.startsWith('choos') ? 'choose'
        : form.startsWith('bu') ? 'buy'
        : form.startsWith('order') ? 'order'
        : form.startsWith('eat') ? 'eat'
        : form.startsWith('drink') ? 'drink'
        : form.startsWith('us') ? 'use'
        : form.startsWith('wear') ? 'wear' : 'want';
      rawSubject = match[2];
    }
  }
  if (!rawSubject) {
    match = statement.match(/^my\s+favou?rite\s+(.{2,70}?)\s+(?:is|are)\s+(.{3,160})$/i);
    if (match) {
      sentiment = 'positive';
      const category = cleanFacet(match[1], 70);
      const favorite = cleanFacet(match[2], 160);
      if (!category || !favorite) return null;
      rawSubject = new RegExp(`\\b${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(favorite)
        ? favorite : `${favorite} ${category}`;
    }
  }
  if (!rawSubject || !sentiment) return null;

  const subject = cleanFacet(stripConditions(rawSubject), MAX_SUBJECT_LEN);
  if (!subject || subject.length < 2 || PRONOUN_ONLY_RE.test(subject)
    || /^(?:that|how|when|what)\s+you\b|^your\b/i.test(subject)) return null;

  const merchantMatch = statement.match(MERCHANT_RE);
  const merchant = merchantFacet(merchantMatch);
  const priceMatch = statement.match(PRICE_CEILING_RE);
  const priceCeiling = priceMatch ? normalizePriceCeiling({
    value: Number(priceMatch[3].replace(/,/g, '')),
    currency: priceCurrency(priceMatch[1], priceMatch[2]),
    unit: priceMatch[4] || null,
  }) : null;
  const hasPriceSyntax = /\b(?:under|below|less\s+than|at\s+most|no\s+more\s+than|up\s+to|not\s+over|maximum(?:\s+of)?)\s*(?:[A-Z]{3}\s*)?[$€£]?\s*[\d,.]+/iu.test(statement);
  if (hasPriceSyntax && !priceCeiling) return null;
  const context = inferContext(statement, verb);
  const parsedNow = now instanceof Date ? now : new Date(now);
  const temporary = Number.isNaN(parsedNow.getTime())
    ? null : extractTemporary(statement, parsedNow, timeZone);
  const hasTemporarySyntax = /\b(?:until\s+\d{4}-\d{2}-\d{2}|for\s+the\s+next\s+\d{1,3}\s+(?:day|week|month)s?|this\s+week|today|for\s+now|temporarily)\b/i.test(statement);
  if (hasTemporarySyntax && !temporary) return null;

  return normalizePreferenceStructure({
    subject,
    sentiment,
    ...(merchant ? { merchant } : {}),
    ...(context ? { context } : {}),
    ...(priceCeiling ? { priceCeiling } : {}),
    ...(temporary ? { temporary } : {}),
  });
}

/**
 * True when one turn combines a preference assertion with an assistant action
 * request. Signal ingestion uses this to avoid handing an intentionally
 * rejected mixed turn to a probabilistic classifier.
 */
export function hasAmbiguousPreferenceAction(input) {
  const text = sanitizeSignalText(input, MAX_INPUT_LEN + 1);
  if (!text || text.length > MAX_INPUT_LEN || !PREFERENCE_CUE_RE.test(text)) return false;
  return REQUEST_RE.test(text) || MIXED_ACTION_RE.test(text) || INLINE_PLEASE_ACTION_RE.test(text);
}

const SUBJECT_PREFIX_RE = /^(?:(?:i|we)\s+(?:(?:really|absolutely|especially)\s+)?(?:love|adore|like|enjoy|prefer|dislike|hate|avoid|can['’]?t\s+stand|am\s+allergic\s+to|do\s+not\s+like|don['’]?t\s+like|(?:only|always|never|do\s+not|don['’]?t)\s+(?:buy|purchase|order|choose|eat|drink|use|wear|want))|(?:(?:the\s+)?user\s+)?(?:likes?|loves?|adores?|enjoys?|prefers?|avoids?|dislikes?|hates?|does\s+not\s+like|doesn['’]?t\s+like)|(?:only|always|never)\s+(?:buys?|purchases?|orders?|chooses?|eats?|drinks?|uses?|wears?|wants?))\s+/i;
const NAMED_SUBJECT_PREFIX_RE = /^[\p{Lu}][\p{L}\p{M}'’.-]{1,39}\s+(?:likes?|loves?|adores?|enjoys?|prefers?|avoids?|dislikes?|hates?|does\s+not\s+like|doesn['’]?t\s+like)\s+/u;

/**
 * Canonical comparison key for preference subjects at conflict boundaries.
 * Structured rows naturally reduce to their subject. Legacy/unstructured
 * canonical statements such as "Loves apples" and "Avoids apples" lose only
 * a tightly bounded preference prefix; arbitrary prose is otherwise retained.
 */
export function canonicalPreferenceSubjectKey(input) {
  const text = sanitizeSignalText(input, MAX_INPUT_LEN + 1);
  if (!text || text.length > MAX_INPUT_LEN) return '';
  const safeText = String(redactSecretsDeep(text, { maxString: MAX_INPUT_LEN + 1 }) || '');
  if (!safeText || safeText.includes('[redacted]')) return '';
  const parsed = extractPreferenceStructure(safeText);
  const legacySubject = safeText
    .replace(NAMED_SUBJECT_PREFIX_RE, '')
    .replace(SUBJECT_PREFIX_RE, '');
  const subject = String(parsed?.subject || legacySubject);
  return subject.normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
