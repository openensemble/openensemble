// @ts-check
/**
 * Narrow browser field watches.
 *
 * A WatchSpec is a standing permission to read one field at one exact URL. It
 * is deliberately not a browser lease: it grants no tab inventory, page-wide
 * capture, navigation, clicking, typing, or access to surrounding content.
 *
 * Server and browser executors both submit the same tiny Detection record.
 * The service normalizes that record, confirms a changed value twice, applies
 * the predicate, and emits a deterministic notification event. Browser-side
 * execution is a contract only in this module; the extension/WS transport is
 * responsible for performing the scoped read and returning the Detection.
 */

import { createHash, randomUUID } from 'crypto';
import { isUrlSafe } from './url-guard.mjs';
import {
  addCollectionItem,
  assertWatcherStoreHealthy,
  getCollectionItem,
  listAllCollections,
  listCollectionItems,
  registerSystemWatcherHandler,
  registerWatcher,
  updateCollectionItem,
} from '../scheduler/watchers.mjs';

export const BROWSER_FIELD_WATCH_KIND = 'browser_field_watch';
export const BROWSER_FIELD_WATCH_SCHEMA = 2;
export const FIELD_WATCH_CONFIRMATIONS = 2;

const COLLECTION_REF = Object.freeze({ skillId: null, kind: BROWSER_FIELD_WATCH_KIND });
const MIN_CADENCE_SEC = 5 * 60;
const MAX_CADENCE_SEC = 30 * 24 * 60 * 60;
const MAX_WATCHES_PER_USER = 100;
const MAX_URL_LENGTH = 2_048;
const MAX_VALUE_LENGTH = 512;
const MAX_HTML_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_PARSERS = new Set(['price', 'number', 'text', 'availability']);
const ALLOWED_PREDICATES = new Set([
  'changed', 'below', 'at_or_below', 'above', 'at_or_above',
  'equals', 'not_equals', 'decrease_percent', 'increase_percent',
]);
const SECRET_KEYS = /^(?:authorization|cookie|cookies|credential|credentials|headers|password|token)$/i;
const SECRET_QUERY_KEYS = /(?:^|[-_])(?:access[-_]?token|token|auth|authorization|credential|key|password|secret|session|signature|sig)(?:$|[-_])/i;
const SENSITIVE_HOSTS = [
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com',
  'paypal.com', 'venmo.com', 'cash.app', 'wise.com',
  'chase.com', 'wellsfargo.com', 'bankofamerica.com', 'capitalone.com',
  'citi.com', 'usbank.com', 'ally.com', 'schwab.com', 'fidelity.com', 'vanguard.com',
  '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com', 'keepersecurity.com',
  'healthcare.gov',
];
const SENSITIVE_HOST_PATTERNS = [
  /^mychart\./i,
  /^(?:login|signin|auth|sso|id|account|accounts)\./i,
  /^(?:pay|payments|checkout|banking|bank)\./i,
];
const SENSITIVE_PATH_PATTERNS = [
  /^\/(?:login|signin|sign-in|signup|sign-up|oauth|authorize|auth)(?:\/|$)/i,
  /^\/(?:checkout|payment|payments|billing)(?:\/|$)/i,
];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function hasSecretBearingKey(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) return true;
    if (hasSecretBearingKey(child, seen)) return true;
  }
  return false;
}

/** Canonical exact URL used by both the grant and every observation. */
export function canonicalWatchUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('field watch requires a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`field watch protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) throw new Error('field watch URLs may not contain credentials');
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.test(key)) throw new Error('field watch URLs may not contain secret-bearing query parameters');
  }
  url.hash = '';
  const canonical = url.href;
  if (canonical.length > MAX_URL_LENGTH) throw new Error('field watch URL is too long');
  return canonical;
}

export function sensitiveFieldWatchUrlReason(value) {
  let url;
  try { url = new URL(canonicalWatchUrl(value)); }
  catch (error) { return error.message; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (SENSITIVE_HOSTS.some(item => host === item || host.endsWith(`.${item}`))
    || SENSITIVE_HOST_PATTERNS.some(pattern => pattern.test(host))
    || SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(url.pathname))) {
    return 'login, banking, payment, health, and password-manager pages cannot receive standing field permissions';
  }
  return null;
}

function normalizeAnchors(anchors) {
  if (!Array.isArray(anchors)) return [];
  return anchors.slice(0, 5).map(anchor => ({
    text: String(anchor?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    relation: ['before', 'after', 'parent', 'near'].includes(anchor?.relation)
      ? anchor.relation : 'near',
  })).filter(anchor => anchor.text);
}

function normalizeField(field, executionMode) {
  const raw = field && typeof field === 'object' ? field : {};
  const detector = String(raw.detector || (executionMode === 'server' ? 'structured' : 'dom'));
  if (!['structured', 'dom'].includes(detector)) {
    throw new Error('field detector must be structured or dom');
  }
  if (executionMode === 'server' && detector !== 'structured') {
    throw new Error('server field watches currently require structured product data');
  }
  const property = String(raw.property || 'price').trim().toLowerCase().slice(0, 64);
  const selector = detector === 'dom' ? String(raw.selector || '').trim().slice(0, 500) : '';
  if (detector === 'dom' && !selector) throw new Error('DOM field watches require a selector');
  const anchors = normalizeAnchors(raw.anchors);
  const structuredPath = raw.path ? String(raw.path).trim().slice(0, 240) : null;
  const identity = { detector, property, selector: selector || null, anchors, path: structuredPath };
  return {
    ...identity,
    fingerprint: stableHash(identity),
  };
}

function normalizeParser(parser) {
  const raw = parser && typeof parser === 'object' ? parser : {};
  const type = String(raw.type || 'price');
  if (!ALLOWED_PARSERS.has(type)) throw new Error(`unsupported field parser: ${type}`);
  return {
    type,
    currency: raw.currency ? String(raw.currency).toUpperCase().slice(0, 8) : null,
    unit: raw.unit ? String(raw.unit).trim().slice(0, 32) : null,
    locale: raw.locale ? String(raw.locale).trim().slice(0, 32) : null,
  };
}

function normalizePredicate(predicate, parser) {
  const raw = predicate && typeof predicate === 'object' ? predicate : {};
  const type = String(raw.type || 'changed');
  if (!ALLOWED_PREDICATES.has(type)) throw new Error(`unsupported field predicate: ${type}`);
  const numeric = ['below', 'at_or_below', 'above', 'at_or_above', 'decrease_percent', 'increase_percent'];
  let target = raw.target;
  if (numeric.includes(type)) {
    target = Number(target);
    if (!Number.isFinite(target)) throw new Error(`${type} predicate requires a numeric target`);
    if (['decrease_percent', 'increase_percent'].includes(type) && (target <= 0 || target > 100)) {
      throw new Error(`${type} target must be between 0 and 100`);
    }
  } else if (['equals', 'not_equals'].includes(type)) {
    if (target == null || String(target).length > MAX_VALUE_LENGTH) {
      throw new Error(`${type} predicate requires a bounded target`);
    }
    if (['number', 'price'].includes(parser.type)) {
      const parsed = parseNumericValue(target);
      if (parsed == null) throw new Error(`${type} predicate target is not numeric`);
      target = parsed;
    } else {
      target = normalizeText(target);
    }
  } else {
    target = null;
  }
  return { type, target };
}

function normalizeExecution(execution) {
  const raw = execution && typeof execution === 'object' ? execution : {};
  const mode = String(raw.mode || 'server');
  if (!['server', 'browser'].includes(mode)) throw new Error('field watch execution mode must be server or browser');
  const credentialId = raw.credentialId == null ? null : String(raw.credentialId).trim().slice(0, 160);
  if (mode === 'browser' && !credentialId) {
    throw new Error('browser field watches require a browser-bound executor credential');
  }
  return {
    mode,
    reason: raw.reason ? String(raw.reason).replace(/\s+/g, ' ').trim().slice(0, 160) : null,
    credentialId: mode === 'browser' ? credentialId : null,
  };
}

/**
 * Validate and construct the persisted WatchSpec.
 * `urlSafety` is injectable for focused tests. Server watches are checked at
 * creation and again on every fetch; browser watches are never fetched here.
 */
export async function buildBrowserFieldWatchSpec(input, {
  now = Date.now(),
  urlSafety = isUrlSafe,
} = {}) {
  if (!input || typeof input !== 'object') throw new Error('field watch spec required');
  if (hasSecretBearingKey(input)) {
    throw new Error('field watches may not contain cookies, credentials, authorization, or custom headers');
  }
  if (input.confirmed !== true && input.permission?.confirmed !== true) {
    throw new Error('field watch requires explicit user confirmation');
  }
  const url = canonicalWatchUrl(input.url);
  const sensitiveReason = sensitiveFieldWatchUrlReason(url);
  if (sensitiveReason) throw new Error(`field watch URL blocked: ${sensitiveReason}`);
  const execution = normalizeExecution(input.execution);
  // The server executor repeats this check immediately before every fetch.
  // Browser-only watches are checked here too so a standing permission can
  // never be used as a back door into localhost or a private network.
  const safety = await urlSafety(url);
  if (!safety?.ok) throw new Error(`field watch URL blocked: ${safety?.reason || 'unsafe URL'}`);
  const field = normalizeField(input.field, execution.mode);
  const parser = normalizeParser(input.parser);
  const predicate = normalizePredicate(input.predicate, parser);
  const cadenceSec = clamp(Math.floor(Number(input.cadenceSec) || 6 * 60 * 60), MIN_CADENCE_SEC, MAX_CADENCE_SEC);
  const minConfidence = clamp(Number(input.minConfidence) || 0.7, 0.5, 1);
  const spec = {
    schema: BROWSER_FIELD_WATCH_SCHEMA,
    id: randomUUID(),
    label: String(input.label || `Watch ${field.property}`).replace(/\s+/g, ' ').trim().slice(0, 160),
    url,
    field,
    parser,
    predicate,
    execution,
    cadenceSec,
    minConfidence,
    permission: {
      scope: 'exact_url_field_read',
      exactUrl: url,
      fieldFingerprint: field.fingerprint,
      executorCredentialId: execution.credentialId,
      grantedAt: new Date(now).toISOString(),
      revokedAt: null,
    },
    status: 'active',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    nextDueAt: 0,
    baseline: null,
    candidate: null,
    pendingEvent: null,
    lastNotified: null,
    consecutiveFailures: 0,
    lastError: null,
  };
  if (input.initialObservation) {
    const normalized = normalizeBrowserFieldDetection(spec, {
      ...input.initialObservation,
      pageUrl: input.initialObservation.pageUrl || url,
      detector: input.initialObservation.detector || field.detector,
      executor: input.initialObservation.executor || execution.mode,
      locatorFingerprint: input.initialObservation.locatorFingerprint || field.fingerprint,
    }, { now });
    spec.baseline = normalized;
    spec.updatedAt = new Date(now).toISOString();
    spec.nextDueAt = now + cadenceSec * 1000;
  }
  return spec;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_VALUE_LENGTH);
}

/** Locale-tolerant numeric parsing for prices and measurements. */
export function parseNumericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value ?? '').replace(/[\u00a0\u202f\s]/g, '');
  const match = text.match(/[-+]?\d[\d.,']*/);
  if (!match) return null;
  text = match[0].replace(/'/g, '');
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    text = text.replace(thousands, '').replace(decimal, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = text.split(sep);
    const tail = parts.at(-1) || '';
    // One/two trailing digits are decimal; groups of three are thousands.
    text = tail.length > 0 && tail.length <= 2
      ? `${parts.slice(0, -1).join('')}.${tail}`
      : parts.join('');
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferredCurrency(raw, explicit) {
  if (explicit) return String(explicit).toUpperCase().slice(0, 8);
  const text = String(raw ?? '');
  if (/\bUSD\b/i.test(text) || text.includes('$')) return 'USD';
  if (/\bEUR\b/i.test(text) || text.includes('€')) return 'EUR';
  if (/\bGBP\b/i.test(text) || text.includes('£')) return 'GBP';
  if (/\bJPY\b/i.test(text) || text.includes('¥')) return 'JPY';
  return null;
}

function parseAvailability(value) {
  const text = normalizeText(value);
  if (/out[ -]?of[ -]?stock|sold out|unavailable|discontinued/.test(text)) return 'out_of_stock';
  if (/pre[ -]?order|preorder/.test(text)) return 'preorder';
  if (/in[ -]?stock|available|ships? (?:now|today)/.test(text)) return 'in_stock';
  return text;
}

function detectorKind(detection) {
  const kind = String(detection?.detector || detection?.source?.detector || '').toLowerCase();
  if (['json_ld', 'meta', 'schema', 'structured'].includes(kind)) return 'structured';
  if (['dom', 'browser'].includes(kind)) return 'dom';
  return kind;
}

/**
 * Convert any executor's tiny Detection into the common observation record.
 * This function rejects URL/locator retargeting rather than trusting metadata
 * supplied by the browser or a page.
 */
export function normalizeBrowserFieldDetection(spec, detection, { now = Date.now() } = {}) {
  if (!spec || spec.schema !== BROWSER_FIELD_WATCH_SCHEMA) throw new Error('invalid field WatchSpec');
  if (!detection || typeof detection !== 'object') throw new Error('field detection required');
  if (spec.execution.mode === 'browser' && !detection.pageUrl && !detection.url) {
    throw new Error('browser field detection must report its live page URL');
  }
  const pageUrl = canonicalWatchUrl(detection.pageUrl || detection.url || spec.url);
  if (pageUrl !== spec.url) throw new Error('field detection URL is outside the standing permission');
  if (spec.execution.mode === 'browser'
    && !detection.locatorFingerprint && !detection.source?.locatorFingerprint) {
    throw new Error('browser field detection must report its locator fingerprint');
  }
  const locatorFingerprint = String(detection.locatorFingerprint
    || detection.source?.locatorFingerprint || spec.field.fingerprint);
  if (locatorFingerprint !== spec.field.fingerprint) {
    throw new Error('field detection locator does not match the standing permission');
  }
  const detector = detectorKind(detection) || spec.field.detector;
  if (detector !== spec.field.detector) throw new Error('field detection used an unapproved detector');
  const executor = String(detection.executor || detection.source?.executor || spec.execution.mode);
  if (executor !== spec.execution.mode) throw new Error('field detection used an unapproved executor');
  const raw = detection.value ?? detection.rawValue ?? detection.text;
  if (raw == null || String(raw).length > MAX_VALUE_LENGTH) throw new Error('field detection value is missing or too large');

  let value;
  let currency = detection.currency || spec.parser.currency || null;
  let unit = detection.unit || spec.parser.unit || null;
  switch (spec.parser.type) {
    case 'price':
    case 'number':
      value = parseNumericValue(raw);
      if (value == null) throw new Error(`field value is not a valid ${spec.parser.type}`);
      if (spec.parser.type === 'price') currency = inferredCurrency(raw, currency);
      break;
    case 'availability': value = parseAvailability(raw); break;
    default: value = normalizeText(raw); break;
  }
  const confidence = clamp(Number(detection.confidence) || (detector === 'structured' ? 0.97 : 0.85), 0, 1);
  const observedAtMs = Number.isFinite(Number(detection.observedAt))
    ? Number(detection.observedAt)
    : Date.parse(String(detection.observedAt || ''));
  const observedAt = Number.isFinite(observedAtMs) ? observedAtMs : now;
  const signature = stableHash({ type: spec.parser.type, value, currency, unit });
  return {
    value,
    displayValue: String(raw).replace(/\s+/g, ' ').trim().slice(0, 120),
    currency: currency ? String(currency).toUpperCase().slice(0, 8) : null,
    unit: unit ? String(unit).slice(0, 32) : null,
    observedAt: new Date(observedAt).toISOString(),
    confidence,
    signature,
    source: { executor, detector, locatorFingerprint },
  };
}

function scalarMatches(predicate, observation) {
  const value = observation?.value;
  const target = predicate.target;
  switch (predicate.type) {
    case 'below': return Number(value) < Number(target);
    case 'at_or_below': return Number(value) <= Number(target);
    case 'above': return Number(value) > Number(target);
    case 'at_or_above': return Number(value) >= Number(target);
    case 'equals': return value === target;
    case 'not_equals': return value !== target;
    default: return false;
  }
}

export function evaluateBrowserFieldPredicate(predicate, current, previous) {
  if (!previous) return false;
  if (predicate.type === 'changed') return current.signature !== previous.signature;
  if (predicate.type === 'decrease_percent') {
    const prior = Number(previous.value);
    return prior !== 0 && ((prior - Number(current.value)) / Math.abs(prior)) * 100 >= Number(predicate.target);
  }
  if (predicate.type === 'increase_percent') {
    const prior = Number(previous.value);
    return prior !== 0 && ((Number(current.value) - prior) / Math.abs(prior)) * 100 >= Number(predicate.target);
  }
  // Threshold/equality alerts fire on entry, not on every changed value while
  // the watch remains inside the matching range.
  return scalarMatches(predicate, current) && !scalarMatches(predicate, previous);
}

function makeWatchEvent(spec, previous, current, now) {
  return {
    id: randomUUID(),
    watchId: spec.id,
    type: 'browser_field_changed',
    label: spec.label,
    url: spec.url,
    previous: clone(previous),
    current: clone(current),
    predicate: clone(spec.predicate),
    createdAt: new Date(now).toISOString(),
  };
}

/** Pure two-confirmation state transition. */
export function applyBrowserFieldObservation(spec, detection, { now = Date.now() } = {}) {
  const next = clone(spec);
  const observation = normalizeBrowserFieldDetection(next, detection, { now });
  next.updatedAt = new Date(now).toISOString();
  next.consecutiveFailures = 0;
  next.lastError = null;
  if (observation.confidence < next.minConfidence) {
    next.lastError = { code: 'low_confidence', at: next.updatedAt };
    return { spec: next, status: 'low_confidence', observation, event: next.pendingEvent || null };
  }
  if (!next.baseline) {
    next.baseline = observation;
    next.candidate = null;
    return { spec: next, status: 'baseline_seeded', observation, event: next.pendingEvent || null };
  }
  if (observation.signature === next.baseline.signature) {
    next.candidate = null;
    return { spec: next, status: 'unchanged', observation, event: next.pendingEvent || null };
  }
  if (next.candidate?.observation?.signature === observation.signature) {
    next.candidate.confirmations += 1;
    next.candidate.lastSeenAt = observation.observedAt;
    next.candidate.observation = observation;
  } else {
    next.candidate = {
      observation,
      confirmations: 1,
      firstSeenAt: observation.observedAt,
      lastSeenAt: observation.observedAt,
    };
  }
  if (next.candidate.confirmations < FIELD_WATCH_CONFIRMATIONS) {
    return { spec: next, status: 'change_pending_confirmation', observation, event: next.pendingEvent || null };
  }
  const previous = next.baseline;
  next.baseline = observation;
  next.candidate = null;
  let event = next.pendingEvent || null;
  if (!event && evaluateBrowserFieldPredicate(next.predicate, observation, previous)) {
    event = makeWatchEvent(next, previous, observation, now);
    next.pendingEvent = event;
  }
  return { spec: next, status: event ? 'changed' : 'baseline_updated', observation, event };
}

export function applyBrowserFieldFailure(spec, failure, { now = Date.now() } = {}) {
  const next = clone(spec);
  const code = String(failure?.code || 'check_failed').slice(0, 80);
  const message = String(failure?.message || code).replace(/\s+/g, ' ').trim().slice(0, 240);
  next.updatedAt = new Date(now).toISOString();
  next.consecutiveFailures = Number(next.consecutiveFailures || 0) + 1;
  next.lastError = { code, message, at: next.updatedAt };
  if (['url_blocked', 'redirect_out_of_scope'].includes(code)) next.status = 'blocked';
  else if (code === 'locator_not_found' && next.consecutiveFailures >= 2) next.status = 'needs_repair';
  return next;
}

function readPath(value, path) {
  if (!path || path === '$') return value;
  const tokens = String(path).replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) || [];
  let current = value;
  for (const token of tokens) {
    if (current == null) return undefined;
    current = token.startsWith('[') ? current[Number(token.slice(1, -1))] : current[token];
  }
  return current;
}

function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (let match; (match = re.exec(tag));) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return attrs;
}

function flattenStructured(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenStructured(item, out);
  } else if (value && typeof value === 'object') {
    out.push(value);
    if (value['@graph']) flattenStructured(value['@graph'], out);
  }
  return out;
}

function structuredProperty(objects, property) {
  const products = objects.filter(obj => {
    const types = Array.isArray(obj?.['@type']) ? obj['@type'] : [obj?.['@type']];
    return types.some(type => /^(?:product|offer|aggregateoffer)$/i.test(String(type || '')));
  });
  for (const obj of products) {
    const offers = Array.isArray(obj.offers) ? obj.offers : (obj.offers ? [obj.offers] : []);
    const candidates = [...offers, obj];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      if (property === 'price') {
        const value = candidate.price ?? candidate.lowPrice ?? candidate.highPrice;
        if (value != null) return { value, currency: candidate.priceCurrency || null };
      } else if (property === 'availability') {
        const value = candidate.availability;
        if (value != null) return { value: String(value).split('/').at(-1) };
      } else if (candidate[property] != null) {
        return { value: candidate[property] };
      }
    }
  }
  return null;
}

/** Extract schema.org/JSON-LD/product meta data without sending HTML to an LLM. */
export function extractStructuredField(html, spec) {
  const source = String(html || '');
  if (!source) return null;
  const property = spec.field.property;
  const objects = [];
  const scriptRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  for (let match; (match = scriptRe.exec(source));) {
    try { flattenStructured(JSON.parse(match[1].trim()), objects); } catch { /* malformed publisher data */ }
  }
  /** @type {{ value: any, currency?: any } | null | undefined} */
  let found;
  if (spec.field.path) {
    for (const object of objects) {
      const value = readPath(object, spec.field.path);
      if (value != null) { found = { value }; break; }
    }
  } else {
    found = structuredProperty(objects, property);
  }
  if (!found) {
    const meta = [];
    const metaRe = /<meta\b[^>]*>/gi;
    for (let match; (match = metaRe.exec(source));) meta.push(parseTagAttributes(match[0]));
    const aliases = property === 'price'
      ? ['product:price:amount', 'og:price:amount', 'price']
      : property === 'availability'
        ? ['product:availability', 'availability']
        : [property];
    const hit = meta.find(attrs => aliases.includes(String(attrs.property || attrs.itemprop || attrs.name || '').toLowerCase()));
    if (hit?.content != null) {
      found = { value: hit.content };
      if (property === 'price') {
        const currency = meta.find(attrs => ['product:price:currency', 'og:price:currency', 'pricecurrency']
          .includes(String(attrs.property || attrs.itemprop || attrs.name || '').toLowerCase()));
        found.currency = currency?.content || null;
      }
    }
  }
  if (!found) return null;
  return {
    value: found.value,
    currency: found.currency || null,
    pageUrl: spec.url,
    executor: 'server',
    detector: 'structured',
    locatorFingerprint: spec.field.fingerprint,
    confidence: 0.97,
  };
}

async function readResponseBodyLimited(response, maxBytes = MAX_HTML_BYTES) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('response exceeds field-watch size limit'), { code: 'response_too_large' });
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw Object.assign(new Error('response exceeds field-watch size limit'), { code: 'response_too_large' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Execute a server-backed check. Options are intentionally not extensible with
 * caller headers: cookies, authorization, and browser credentials never enter
 * this path.
 */
export async function checkServerBrowserFieldWatch(spec, {
  fetchImpl = globalThis.fetch,
  urlSafety = isUrlSafe,
  now = Date.now(),
} = {}) {
  if (spec.execution?.mode !== 'server') {
    return { ok: false, failure: { code: 'browser_executor_required', message: 'watch requires the browser executor' } };
  }
  let exactUrl;
  try { exactUrl = canonicalWatchUrl(spec.url); }
  catch (error) { return { ok: false, failure: { code: 'invalid_spec', message: error.message } }; }
  if (exactUrl !== spec.url || spec.permission?.scope !== 'exact_url_field_read'
    || spec.permission?.exactUrl !== exactUrl
    || spec.permission?.fieldFingerprint !== spec.field?.fingerprint
    || spec.permission?.revokedAt) {
    return { ok: false, failure: { code: 'invalid_spec', message: 'field watch standing permission is invalid' } };
  }
  const sensitiveReason = sensitiveFieldWatchUrlReason(exactUrl);
  if (sensitiveReason) return { ok: false, failure: { code: 'url_blocked', message: sensitiveReason } };
  const safety = await urlSafety(exactUrl);
  if (!safety?.ok) return { ok: false, failure: { code: 'url_blocked', message: safety?.reason || 'unsafe URL' } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(exactUrl, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,application/json;q=0.8',
        'User-Agent': 'OpenEnsemble-FieldWatch/1.0',
        'Cache-Control': 'no-cache',
      },
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, failure: { code: 'redirect_out_of_scope', message: 'watched URL redirected outside its exact standing permission' } };
    }
    if (!response.ok) return { ok: false, failure: { code: 'http_error', message: `HTTP ${response.status}` } };
    const html = await readResponseBodyLimited(response);
    const detection = extractStructuredField(html, spec);
    if (!detection) return { ok: false, failure: { code: 'locator_not_found', message: 'structured field was not found' } };
    detection.observedAt = now;
    return { ok: true, detection, observation: normalizeBrowserFieldDetection(spec, detection, { now }) };
  } catch (error) {
    const code = error?.code || (error?.name === 'AbortError' ? 'timeout' : 'fetch_failed');
    return { ok: false, failure: { code, message: error?.message || String(error) } };
  } finally {
    clearTimeout(timer);
  }
}

function collectionForUser(userId) {
  return listAllCollections(userId, COLLECTION_REF)[0] || null;
}

function ensureCollection(userId, agentId) {
  const existing = collectionForUser(userId);
  if (existing) return existing.watcherId;
  return registerWatcher({
    userId,
    agentId,
    kind: BROWSER_FIELD_WATCH_KIND,
    skillId: null,
    label: 'Browser field watches',
    cadenceSec: 60,
    expiresAt: null,
    state: { schema: BROWSER_FIELD_WATCH_SCHEMA, items: [] },
    onFire: { type: 'notify' },
  });
}

export async function createBrowserFieldWatch(userId, agentId, input, opts = {}) {
  if (!userId) throw new Error('field watch owner required');
  if (!agentId) throw new Error('field watch agent required');
  assertWatcherStoreHealthy(userId);
  const current = listCollectionItems(userId, COLLECTION_REF) || [];
  if (current.filter(item => item.status !== 'revoked').length >= MAX_WATCHES_PER_USER) {
    throw new Error(`field watch cap reached (${MAX_WATCHES_PER_USER})`);
  }
  const spec = await buildBrowserFieldWatchSpec(input, opts);
  spec.ownerId = userId;
  const watcherId = ensureCollection(userId, agentId);
  const result = addCollectionItem(userId, { watcherId }, spec, { requirePersist: true });
  if (!result.added) throw new Error(result.error || 'field watch could not be stored');
  return clone(result.item);
}

export function listBrowserFieldWatches(userId, { includeRevoked = false } = {}) {
  const items = listCollectionItems(userId, COLLECTION_REF) || [];
  return items.filter(item => includeRevoked || item.status !== 'revoked').map(clone);
}

export function getBrowserFieldWatch(userId, watchId) {
  const item = getCollectionItem(userId, COLLECTION_REF, watchId);
  if (!item || item.ownerId !== userId) return null;
  return clone(item);
}

export function revokeBrowserFieldWatch(userId, watchId, { now = Date.now() } = {}) {
  assertWatcherStoreHealthy(userId);
  const item = getBrowserFieldWatch(userId, watchId);
  if (!item) return null;
  if (item.status === 'revoked') return item;
  const revokedAt = new Date(now).toISOString();
  const grant = { ...item.permission, revokedAt };
  const result = updateCollectionItem(userId, COLLECTION_REF, watchId, {
    status: 'revoked', permission: grant, updatedAt: revokedAt, nextDueAt: null,
    candidate: null, pendingEvent: null,
  }, { requirePersist: true });
  return result.updated ? clone(result.item) : null;
}

export function recordBrowserFieldObservation(userId, watchId, detection, { now = Date.now() } = {}) {
  assertWatcherStoreHealthy(userId);
  const current = getBrowserFieldWatch(userId, watchId);
  if (!current || current.status === 'revoked') return null;
  const transition = applyBrowserFieldObservation(current, detection, { now });
  transition.spec.nextDueAt = now + transition.spec.cadenceSec * 1000;
  // updateCollectionItem treats cadenceSec as a schedule edit and resets the
  // due time. Omit the unchanged cadence so our explicit nextDueAt survives.
  const { cadenceSec: _unchangedCadence, ...patch } = transition.spec;
  const result = updateCollectionItem(userId, COLLECTION_REF, watchId, patch, { requirePersist: true });
  return result.updated ? { ...transition, spec: clone(result.item) } : null;
}

/**
 * Persist a browser-executor failure without widening its standing grant.
 * The browser reports only a bounded code/message for the exact owned watch;
 * page content, HTML, screenshots, and cookies are never accepted here.
 */
export function recordBrowserFieldFailure(userId, watchId, failure, { now = Date.now() } = {}) {
  assertWatcherStoreHealthy(userId);
  const current = getBrowserFieldWatch(userId, watchId);
  if (!current || current.status === 'revoked' || current.execution?.mode !== 'browser') return null;
  const next = applyBrowserFieldFailure(current, {
    code: String(failure?.code || 'check_failed').slice(0, 80),
    message: String(failure?.message || failure?.code || 'browser field check failed')
      .replace(/\s+/g, ' ').trim().slice(0, 240),
  }, { now });
  next.nextDueAt = now + next.cadenceSec * 1000;
  const { cadenceSec: _unchangedCadence, ...patch } = next;
  const result = updateCollectionItem(userId, COLLECTION_REF, watchId, patch, { requirePersist: true });
  return result.updated ? clone(result.item) : null;
}

export function acknowledgeBrowserFieldWatchEvent(userId, watchId, eventId, { now = Date.now() } = {}) {
  assertWatcherStoreHealthy(userId);
  const current = getBrowserFieldWatch(userId, watchId);
  if (!current?.pendingEvent || current.pendingEvent.id !== eventId) return null;
  const lastNotified = {
    eventId,
    signature: current.pendingEvent.current?.signature || null,
    deliveredAt: new Date(now).toISOString(),
  };
  const result = updateCollectionItem(userId, COLLECTION_REF, watchId, {
    pendingEvent: null, lastNotified, updatedAt: new Date(now).toISOString(),
  }, { requirePersist: true });
  return result.updated ? clone(result.item) : null;
}

/** Minimal, non-page-wide command contract for an extension executor. */
export function browserFieldCheckRequest(spec) {
  if (!spec || spec.execution?.mode !== 'browser' || spec.status !== 'active'
      || !spec.execution?.credentialId
      || spec.permission?.executorCredentialId !== spec.execution.credentialId) return null;
  return {
    type: 'browser_field_check',
    watchId: spec.id,
    exactUrl: spec.url,
    field: clone(spec.field),
    parser: clone(spec.parser),
    permission: {
      scope: 'exact_url_field_read',
      exactUrl: spec.url,
      fieldFingerprint: spec.field.fingerprint,
      executorCredentialId: spec.execution.credentialId,
      allow: ['read_selected_field'],
      deny: ['tab_inventory', 'surrounding_page', 'navigate', 'click', 'type', 'submit'],
    },
    maxValueChars: MAX_VALUE_LENGTH,
  };
}

/** Claim due browser checks for transport. No browser action is performed here. */
export function claimDueBrowserFieldChecks(userId, { now = Date.now(), limit = 20, executorCredentialId = null } = {}) {
  assertWatcherStoreHealthy(userId);
  const due = listBrowserFieldWatches(userId)
    .filter(spec => spec.status === 'active' && spec.execution?.mode === 'browser'
      && (!executorCredentialId || spec.execution?.credentialId === executorCredentialId)
      && Number(spec.nextDueAt || 0) <= now)
    .slice(0, clamp(Number(limit) || 20, 1, 50));
  const requests = [];
  for (const spec of due) {
    const request = browserFieldCheckRequest(spec);
    if (!request) continue;
    const claimed = updateCollectionItem(userId, COLLECTION_REF, spec.id, {
      lastRequestedAt: new Date(now).toISOString(),
      nextDueAt: now + spec.cadenceSec * 1000,
    }, { requirePersist: true });
    if (claimed.updated) requests.push(request);
  }
  return requests;
}

function displayObservation(observation) {
  if (!observation) return 'unknown';
  if (observation.currency && typeof observation.value === 'number') {
    return `${observation.currency} ${observation.value}`;
  }
  return `${observation.value}${observation.unit ? ` ${observation.unit}` : ''}`;
}

export function formatBrowserFieldWatchEvent(event) {
  return `🔔 ${event.label}: ${displayObservation(event.previous)} → ${displayObservation(event.current)}`;
}

/** System collection-watcher handler for server-executable WatchSpecs only. */
export async function browserFieldWatchHandler(state, helpers, deps = {}) {
  const now = deps.now ?? Date.now();
  const items = Array.isArray(state?.items) ? state.items : [];
  let fired = 0;
  let errors = 0;
  const processItem = async original => {
    let spec = clone(original);
    if (spec.status !== 'active') return spec;
    // Browser executors persist the same pendingEvent through
    // recordBrowserFieldObservation(). Let the normal watcher delivery path
    // notify/ack it on the next supervisor tick; only the tiny Detection ever
    // crossed the browser wire.
    if (spec.pendingEvent && (helpers?.notify || helpers?.fire)) {
      const message = formatBrowserFieldWatchEvent(spec.pendingEvent);
      let delivered = false;
      if (helpers?.notify) {
        await helpers.notify(message, {
          from: spec.label,
          event: 'browser_field_changed',
          data: { watchId: spec.id, url: spec.url },
        });
        delivered = true;
      } else {
        delivered = await helpers.fire({ message, itemKey: spec.id });
      }
      if (delivered) {
        spec.lastNotified = {
          eventId: spec.pendingEvent.id,
          signature: spec.pendingEvent.current?.signature || null,
          deliveredAt: new Date(now).toISOString(),
        };
        spec.pendingEvent = null;
        fired += 1;
      }
    }
    if (spec.execution?.mode !== 'server' || Number(spec.nextDueAt || 0) > now) return spec;
    const check = await checkServerBrowserFieldWatch(spec, { ...deps, now });
    if (!check.ok) {
      spec = applyBrowserFieldFailure(spec, check.failure, { now });
      spec.nextDueAt = now + spec.cadenceSec * 1000;
      errors += 1;
      return spec;
    }
    const transition = applyBrowserFieldObservation(spec, check.detection, { now });
    spec = transition.spec;
    spec.nextDueAt = now + spec.cadenceSec * 1000;
    if (transition.event && (helpers?.notify || helpers?.fire)) {
      const message = formatBrowserFieldWatchEvent(transition.event);
      let delivered = false;
      if (helpers?.notify) {
        await helpers.notify(message, {
          from: spec.label,
          event: 'browser_field_changed',
          data: { watchId: spec.id, url: spec.url },
        });
        delivered = true;
      } else {
        delivered = await helpers.fire({ message, itemKey: spec.id });
      }
      if (delivered) {
        spec.lastNotified = {
          eventId: transition.event.id,
          signature: transition.event.current?.signature || null,
          deliveredAt: new Date(now).toISOString(),
        };
        spec.pendingEvent = null;
        fired += 1;
      }
    }
    return spec;
  };
  const mapped = helpers?.mapItems
    ? await helpers.mapItems(items, processItem, { concurrency: 4 })
    : await Promise.all(items.map(processItem));
  const result = { newState: { ...state, schema: BROWSER_FIELD_WATCH_SCHEMA, items: mapped } };
  if (fired) result.textUpdate = `${fired} browser field watch${fired === 1 ? '' : 'es'} changed`;
  else if (errors) result.textUpdate = `${errors} browser field watch check${errors === 1 ? '' : 's'} need attention`;
  return result;
}

export function registerBrowserFieldWatchHandler() {
  registerSystemWatcherHandler(BROWSER_FIELD_WATCH_KIND, browserFieldWatchHandler);
}
