// @ts-check
/**
 * Adblock Plus / uBlock Origin filter syntax parser.
 *
 * Converts upstream filter-list text into the intermediate shapes that
 * `build-filters.mjs` turns into a Manifest V3 declarativeNetRequest ruleset
 * plus cosmetic/scriptlet payloads.
 *
 * This is deliberately a *subset* parser. Filters that cannot be represented
 * faithfully under MV3 are reported as skipped rather than approximated,
 * because a wrong network rule breaks a site while a missing one only leaves
 * an ad visible.
 */

/** Resource types a block rule may target. `main_frame` is never included: OE
 * never blocks a top-level navigation. */
export const BLOCKABLE_RESOURCE_TYPES = Object.freeze([
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other',
]);

const OPTION_TO_RESOURCE_TYPE = new Map([
  ['script', 'script'],
  ['image', 'image'],
  ['stylesheet', 'stylesheet'],
  ['css', 'stylesheet'],
  ['object', 'object'],
  ['object-subrequest', 'object'],
  ['xmlhttprequest', 'xmlhttprequest'],
  ['xhr', 'xmlhttprequest'],
  ['subdocument', 'sub_frame'],
  ['frame', 'sub_frame'],
  ['media', 'media'],
  ['font', 'font'],
  ['websocket', 'websocket'],
  ['ping', 'ping'],
  ['beacon', 'ping'],
  ['other', 'other'],
  ['csp_report', 'csp_report'],
]);

/** Options that change *what* a rule does in ways MV3 cannot express. A filter
 * carrying any of these is skipped outright. */
const UNSUPPORTED_OPTIONS = new Set([
  'csp', 'replace', 'removeparam', 'removeheader', 'permissions', 'urltransform',
  'popup', 'popunder', 'genericblock', 'generichide', 'specifichide', 'elemhide',
  'inline-script', 'inline-font', 'empty', 'mp4', 'cname', 'header', 'method',
  'strict1p', 'strict3p', 'to', 'ipaddress', 'from',
]);

const NOOP_OPTIONS = new Set(['~document', 'all', 'ghide', 'ehide']);

export const COSMETIC_MARKERS = Object.freeze({
  HIDE: '##',
  UNHIDE: '#@#',
  EXT_HIDE: '#?#',
  EXT_UNHIDE: '#@?#',
  STYLE: '#$#',
  STYLE_UNHIDE: '#@$#',
});

/** uBO procedural pseudo-classes we implement in the content script. Anything
 * outside this set (plus native CSS) makes a cosmetic filter unusable. */
export const SUPPORTED_PROCEDURAL = new Set([
  'has-text', 'upward', 'matches-css', 'matches-css-before', 'matches-css-after',
  'min-text-length', 'style', 'remove', 'matches-attr',
]);

/** Pseudo-classes Chrome matches natively, so they can stay in plain CSS. */
const NATIVE_PSEUDO = new Set([
  'has', 'not', 'is', 'where', 'first-child', 'last-child', 'nth-child',
  'nth-of-type', 'first-of-type', 'last-of-type', 'only-child', 'only-of-type',
  'empty', 'root', 'checked', 'disabled', 'enabled', 'hover', 'focus',
  'link', 'visited', 'target', 'lang', 'any-link', 'scope', 'defined',
  'before', 'after', 'placeholder', 'first-line', 'first-letter', 'selection',
  'nth-last-child', 'nth-last-of-type', 'read-only', 'read-write', 'required',
  'optional', 'indeterminate', 'default', 'valid', 'invalid', 'in-range',
  'out-of-range', 'host', 'host-context', 'slotted', 'part', 'dir',
]);

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ASCII_URL_RE = /^[\x21-\x7e]+$/;

export function isPlainDomain(value) {
  return typeof value === 'string' && value.length <= 253 && DOMAIN_RE.test(value);
}

/**
 * Split a filter line into its pattern and option string, honouring the fact
 * that `$` is legal inside a regex pattern.
 */
function splitOptions(text) {
  if (text.startsWith('/') && text.length > 1) {
    const close = text.lastIndexOf('/');
    if (close > 0) {
      const after = text.slice(close + 1);
      if (!after) return { pattern: text, options: '' };
      if (after.startsWith('$')) return { pattern: text.slice(0, close + 1), options: after.slice(1) };
    }
  }
  let index = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '$') continue;
    if (i > 0 && text[i - 1] === '\\') continue;
    index = i;
    break;
  }
  if (index < 0) return { pattern: text, options: '' };
  return { pattern: text.slice(0, index), options: text.slice(index + 1) };
}

function splitOptionList(options) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const char of options) {
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Parse a network filter line.
 * @returns {{kind:'network'}&Record<string,any>|{kind:'skip',reason:string}}
 */
export function parseNetworkFilter(line) {
  let text = line;
  const isException = text.startsWith('@@');
  if (isException) text = text.slice(2);

  const { pattern, options } = splitOptions(text);
  if (!pattern) return { kind: 'skip', reason: 'empty-pattern' };

  const resourceTypes = new Set();
  const excludedResourceTypes = new Set();
  const initiatorDomains = [];
  const excludedInitiatorDomains = [];
  const requestDomains = [];
  const excludedRequestDomains = [];
  let domainType = null;
  let important = false;
  let matchCase = false;
  let isDocument = false;

  for (const raw of splitOptionList(options)) {
    const option = raw.trim();
    if (!option) continue;
    const negated = option.startsWith('~');
    const body = negated ? option.slice(1) : option;
    const eq = body.indexOf('=');
    const name = (eq >= 0 ? body.slice(0, eq) : body).toLowerCase();
    const value = eq >= 0 ? body.slice(eq + 1) : '';

    if (NOOP_OPTIONS.has(option.toLowerCase())) continue;
    if (UNSUPPORTED_OPTIONS.has(name)) return { kind: 'skip', reason: `option:${name}` };

    if (name === 'redirect' || name === 'redirect-rule') return { kind: 'skip', reason: 'option:redirect' };

    if (OPTION_TO_RESOURCE_TYPE.has(name)) {
      (negated ? excludedResourceTypes : resourceTypes).add(OPTION_TO_RESOURCE_TYPE.get(name));
      continue;
    }
    if (name === 'document' || name === 'doc') {
      if (negated) continue;
      isDocument = true;
      continue;
    }
    if (name === 'third-party' || name === '3p') {
      domainType = negated ? 'firstParty' : 'thirdParty';
      continue;
    }
    if (name === 'first-party' || name === '1p') {
      domainType = negated ? 'thirdParty' : 'firstParty';
      continue;
    }
    if (name === 'important') { important = true; continue; }
    if (name === 'match-case') { matchCase = !negated; continue; }
    if (name === 'domain' || name === 'denyallow') {
      const target = name === 'domain' ? null : 'deny';
      for (const entry of value.split('|')) {
        const trimmed = entry.trim().toLowerCase();
        if (!trimmed) continue;
        const exclude = trimmed.startsWith('~');
        const host = exclude ? trimmed.slice(1) : trimmed;
        if (!isPlainDomain(host)) return { kind: 'skip', reason: 'domain-syntax' };
        if (target === 'deny') {
          (exclude ? requestDomains : excludedRequestDomains).push(host);
        } else {
          (exclude ? excludedInitiatorDomains : initiatorDomains).push(host);
        }
      }
      continue;
    }
    return { kind: 'skip', reason: `option:${name}` };
  }

  return {
    kind: 'network',
    isException,
    pattern,
    resourceTypes: [...resourceTypes],
    excludedResourceTypes: [...excludedResourceTypes],
    initiatorDomains,
    excludedInitiatorDomains,
    requestDomains,
    excludedRequestDomains,
    domainType,
    important,
    matchCase,
    isDocument,
  };
}

/**
 * Translate an ABP URL pattern into a DNR `urlFilter`, or report why it cannot
 * be represented.
 */
export function patternToUrlFilter(pattern) {
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    return { regex: pattern.slice(1, -1) };
  }
  if (!ASCII_URL_RE.test(pattern)) return { error: 'non-ascii' };
  if (pattern.length > 500) return { error: 'too-long' };

  // `|` is only meaningful as an anchor; anywhere else DNR rejects the rule.
  const body = pattern.replace(/^\|\|?/, '').replace(/\|$/, '');
  if (body.includes('|')) return { error: 'embedded-pipe' };
  if (!body || body === '*') return { error: 'matches-everything' };
  // A bare `*` prefix with almost no literal text matches far too much to be
  // worth the rule slot.
  if (body.replace(/[*^]/g, '').length < 3) return { error: 'too-generic' };
  return { urlFilter: pattern };
}

function splitCosmeticSelector(selector) {
  const procedural = [];
  let depth = 0;
  let current = '';
  const parts = [];
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    current += char;
  }
  if (depth !== 0) return { error: 'unbalanced' };
  parts.push(current);
  return { parts, procedural };
}

/**
 * Inspect a cosmetic selector and classify it as plain CSS, procedural (needs
 * the JS evaluator), or unusable.
 */
export function classifySelector(selector) {
  const trimmed = selector.trim();
  if (!trimmed) return { kind: 'skip', reason: 'empty' };
  if (trimmed.length > 700) return { kind: 'skip', reason: 'too-long' };
  if (/[{}]/.test(trimmed)) return { kind: 'skip', reason: 'braces' };
  if (splitCosmeticSelector(trimmed).error) return { kind: 'skip', reason: 'unbalanced' };

  const pseudos = [...trimmed.matchAll(/:(-abp-)?([a-z][a-z0-9-]*)\s*\(?/gi)];
  const used = [];
  for (const match of pseudos) {
    const name = match[2].toLowerCase();
    if (NATIVE_PSEUDO.has(name)) continue;
    used.push(name);
  }
  if (!used.length) return { kind: 'css', selector: trimmed };
  if (used.every(name => SUPPORTED_PROCEDURAL.has(name))) {
    return { kind: 'procedural', selector: trimmed, operators: used };
  }
  return { kind: 'skip', reason: `pseudo:${used.find(name => !SUPPORTED_PROCEDURAL.has(name))}` };
}

/** Parse the `domains` half of a cosmetic filter into include/exclude sets. */
export function parseCosmeticDomains(prefix) {
  const include = [];
  const exclude = [];
  if (!prefix) return { include, exclude };
  for (const raw of prefix.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const negated = entry.startsWith('~');
    const host = negated ? entry.slice(1) : entry;
    if (!isPlainDomain(host)) return null;
    (negated ? exclude : include).push(host);
  }
  return { include, exclude };
}

/** Find the cosmetic marker in a line, if any. Longest marker wins. */
export function findCosmeticMarker(line) {
  const hash = line.indexOf('#');
  if (hash < 0) return null;
  for (const marker of ['#@?#', '#@$#', '#@#', '#?#', '#$#', '##']) {
    if (line.startsWith(marker, hash)) {
      return { marker, prefix: line.slice(0, hash), body: line.slice(hash + marker.length) };
    }
  }
  return null;
}

/** Parse a uBO `+js(...)` scriptlet payload. */
export function parseScriptlet(body) {
  const match = /^\+js\(([\s\S]*)\)$/.exec(body.trim());
  if (!match) return null;
  const args = [];
  let current = '';
  let escaped = false;
  for (const char of match[1]) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === ',') { args.push(current.trim()); current = ''; continue; }
    current += char;
  }
  args.push(current.trim());
  const name = args.shift();
  if (!name) return null;
  return { name: name.replace(/\.js$/, ''), args };
}

export function isCommentOrDirective(line) {
  return !line || line.startsWith('!') || line.startsWith('[') || line.startsWith('#%#')
    || line.startsWith('# ') || line === '#';
}
