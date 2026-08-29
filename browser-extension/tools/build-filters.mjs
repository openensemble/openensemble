// @ts-check
/**
 * Convert upstream adblock filter lists into the artifacts OE Bridge ships.
 *
 * Outputs (all committed to the repo, so blocking works offline and without
 * pairing):
 *   rules/ads.json, rules/trackers.json, rules/annoyances.json
 *       Manifest V3 declarativeNetRequest static rulesets, one per toggleable
 *       tier.
 *   filters/cosmetic-generic-<tier>.css
 *       Element-hiding rules that apply to every site, one sheet per tier.
 *   filters/sites-<tier>/, filters/procedural-<tier>/, filters/scriptlets-<tier>/
 *       Per-site rules, bucketed. Each bucket embeds only its own hostname map
 *       and is registered against just those hosts, so a page loads its own
 *       rules and nothing else. Procedural buckets carry selectors needing the
 *       JS evaluator (:has-text, :upward, ...); scriptlet buckets run in the
 *       MAIN world.
 *   filters/registrations.json
 *       What adblock-engine.js feeds to chrome.scripting.registerContentScripts,
 *       each entry tagged with the tier that controls it.
 *   filters/build-info.json
 *       Upstream sources, licences, and counts for the shipped snapshot.
 *
 * Usage:
 *   node tools/build-filters.mjs --source <dir-of-lists> [--out <ext-dir>]
 *   node tools/build-filters.mjs --fetch [--source <cache-dir>]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BLOCKABLE_RESOURCE_TYPES, classifySelector, findCosmeticMarker,
  isCommentOrDirective, parseCosmeticDomains, parseNetworkFilter,
  parseScriptlet, patternToUrlFilter,
} from './filter-parser.mjs';

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Chrome guarantees an extension 30,000 rules across its *enabled* static
 * rulesets. Every tier can be on at once, so the budgets below must sum under
 * that with headroom for the handcrafted surrogate redirect rules.
 */
export const TIERS = ['ads', 'trackers', 'annoyances'];
const TIER_BUDGET = { ads: 14000, trackers: 9500, annoyances: 4500 };
const REGEX_BUDGET = 400;
const GENERIC_CSS_BUDGET_BYTES = 1_100_000;
const SITE_BUCKET_TARGET_BYTES = 120_000;
const MAX_DOMAINS_PER_RULE = 100;

/**
 * Scriptlets implemented by content-scriptlets.js, keyed by the canonical uBO
 * name, plus the short aliases the lists actually use. Keep this table in sync
 * with the runtime library in content-scriptlets.js. A rule naming anything
 * outside this table is dropped rather than shipped as a silent no-op.
 */
export const SCRIPTLET_ALIASES = Object.freeze({
  aopr: 'abort-on-property-read',
  aopw: 'abort-on-property-write',
  acs: 'abort-current-script',
  'abort-current-inline-script': 'abort-current-script',
  acis: 'abort-current-script',
  set: 'set-constant',
  nostif: 'no-setTimeout-if',
  'setTimeout-defuser': 'no-setTimeout-if',
  nosiif: 'no-setInterval-if',
  'setInterval-defuser': 'no-setInterval-if',
  aeld: 'addEventListener-defuser',
  ra: 'remove-attr',
  rc: 'remove-class',
  rmnt: 'remove-node-text',
  rpnt: 'replace-node-text',
  nowoif: 'no-window-open-if',
  'prevent-window-open': 'no-window-open-if',
  'window.open-defuser': 'no-window-open-if',
  'cookie-remover': 'remove-cookie',
  'trusted-set-cookie': 'set-cookie',
  'trusted-set-local-storage-item': 'set-local-storage-item',
  'nano-sib': 'nano-setInterval-booster',
  'nano-stb': 'nano-setTimeout-booster',
  'json-prune-fetch-response': 'json-prune',
});

export const SUPPORTED_SCRIPTLETS = Object.freeze([
  'abort-current-script', 'abort-on-property-read', 'abort-on-property-write',
  'addEventListener-defuser', 'href-sanitizer', 'json-prune',
  'nano-setInterval-booster', 'nano-setTimeout-booster', 'no-fetch-if',
  'no-setInterval-if', 'no-setTimeout-if', 'no-window-open-if', 'no-xhr-if',
  'noeval', 'remove-attr', 'remove-class', 'remove-cookie', 'remove-node-text',
  'replace-node-text', 'set-constant', 'set-cookie', 'set-local-storage-item',
  'set-session-storage-item', 'trusted-click-element',
]);

/**
 * The hand-curated advertising platforms OE blocked before it carried upstream
 * lists. Upstream expresses several of these only through narrower path rules,
 * so without this floor the budget trim can drop a blanket block on a major ad
 * exchange. These are always emitted, ahead of everything ranked.
 */
export const CORE_AD_DOMAINS = Object.freeze([
  '360yield.com', 'adform.net', 'adition.com', 'adnxs-simple.com', 'adnxs.com',
  'adsafeprotected.com', 'adservice.google.com', 'adsrvr.org', 'advertising.com',
  'amazon-adsystem.com', 'bidswitch.net', 'casalemedia.com', 'contextweb.com',
  'criteo.com', 'criteo.net', 'doubleclick.net', 'freewheel.tv',
  'googleadservices.com', 'googlesyndication.com', 'gumgum.com',
  'improvedigital.com', 'indexww.com', 'innovid.com', 'lijit.com', 'media.net',
  'moatads.com', 'openx.net', 'outbrain.com', 'pubmatic.com', 'rubiconproject.com',
  'serving-sys.com', 'sharethrough.com', 'smartadserver.com', 'sovrn.com',
  'spotx.tv', 'spotxchange.com', 'springserve.com', 'taboola.com',
  'taboolasyndication.com', 'triplelift.com', 'yieldlab.net', 'yieldmo.com',
]);

/** Upstream sources, grouped by the tier they feed. */
export const SOURCES = [
  { file: 'easylist.txt', tier: 'ads', name: 'EasyList', license: 'GPLv3 / CC BY-SA 3.0', url: 'https://easylist.to/easylist/easylist.txt' },
  { file: 'ubo-filters.txt', tier: 'ads', name: 'uBlock Origin filters', license: 'GPLv3', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt' },
  { file: 'ubo-badware.txt', tier: 'ads', name: 'uBlock Origin badware risks', license: 'GPLv3', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt' },
  { file: 'ubo-quick-fixes.txt', tier: 'ads', name: 'uBlock Origin quick fixes', license: 'GPLv3', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt' },
  { file: 'easyprivacy.txt', tier: 'trackers', name: 'EasyPrivacy', license: 'GPLv3 / CC BY-SA 3.0', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { file: 'ubo-privacy.txt', tier: 'trackers', name: 'uBlock Origin privacy', license: 'GPLv3', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt' },
  { file: 'easylist-cookie.txt', tier: 'annoyances', name: 'EasyList Cookie List', license: 'GPLv3 / CC BY-SA 3.0', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt' },
  { file: 'ubo-ann-cookies.txt', tier: 'annoyances', name: 'uBlock Origin cookie notices', license: 'GPLv3', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt' },
  { file: 'ubo-ann-others.txt', tier: 'annoyances', name: 'uBlock Origin annoyances', license: 'GPLv3', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-others.txt' },
];

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** Rank a block rule so the budget keeps the broadest, highest-value filters. */
function ruleValue(parsed, urlFilter) {
  if (parsed.core) return Number.MAX_SAFE_INTEGER;
  let score = 0;
  if (urlFilter.startsWith('||')) score += 40;
  const body = urlFilter.replace(/^\|\|?/, '');
  if (/^[a-z0-9.-]+\^$/.test(body)) score += 40;       // pure domain block
  if (!body.includes('/')) score += 15;                 // no path component
  if (parsed.domainType === 'thirdParty') score += 8;
  if (!parsed.initiatorDomains.length) score += 6;      // applies everywhere
  score -= Math.min(20, Math.floor(urlFilter.length / 12));
  return score;
}

function applyDomainConditions(condition, parsed) {
  const assign = (key, values) => {
    if (!values.length) return;
    if (values.length > MAX_DOMAINS_PER_RULE) throw new Error('domain-list-too-large');
    condition[key] = [...new Set(values)].sort();
  };
  assign('initiatorDomains', parsed.initiatorDomains);
  assign('excludedInitiatorDomains', parsed.excludedInitiatorDomains);
  assign('requestDomains', parsed.requestDomains);
  assign('excludedRequestDomains', parsed.excludedRequestDomains);
}

function buildNetworkRule(parsed, id) {
  const translated = patternToUrlFilter(parsed.pattern);
  if (translated.error) return { error: translated.error };

  const condition = {};
  if (translated.regex) {
    condition.regexFilter = translated.regex;
    if (parsed.matchCase) condition.isUrlFilterCaseSensitive = true;
  } else if (parsed.matchCase) {
    condition.urlFilter = translated.urlFilter;
    condition.isUrlFilterCaseSensitive = true;
  } else {
    // Chrome matches `urlFilter` case-insensitively by default and rejects any
    // pattern that is not already lowercase.
    condition.urlFilter = translated.urlFilter.toLowerCase();
  }

  let resourceTypes = parsed.resourceTypes.length
    ? parsed.resourceTypes.filter(type => BLOCKABLE_RESOURCE_TYPES.includes(type))
    : [...BLOCKABLE_RESOURCE_TYPES];
  if (parsed.excludedResourceTypes.length) {
    resourceTypes = resourceTypes.filter(type => !parsed.excludedResourceTypes.includes(type));
  }

  // A `$document` exception allowlists a whole page load. As a *block* it would
  // mean blocking navigation, which OE never does.
  if (parsed.isDocument && parsed.isException) {
    const rule = {
      id,
      priority: parsed.important ? 4000 : 3000,
      action: { type: 'allowAllRequests' },
      condition: { ...condition, resourceTypes: ['main_frame', 'sub_frame'] },
    };
    applyDomainConditions(rule.condition, parsed);
    return { rule };
  }
  if (!resourceTypes.length) return { error: 'no-resource-types' };

  const rule = {
    id,
    priority: parsed.important ? 2000 : 1000,
    action: { type: parsed.isException ? 'allow' : 'block' },
    condition: { ...condition, resourceTypes },
  };
  if (parsed.domainType) rule.condition.domainType = parsed.domainType;
  applyDomainConditions(rule.condition, parsed);
  return { rule };
}

function newStats() {
  return { network: 0, exceptions: 0, cosmetic: 0, procedural: 0, scriptlets: 0, skipped: 0, reasons: new Map() };
}

function note(stats, reason) {
  stats.skipped++;
  stats.reasons.set(reason, (stats.reasons.get(reason) || 0) + 1);
}

/**
 * Cosmetic state is tracked per tier, not globally: hiding a cookie banner is
 * an annoyances-tier decision, and turning that tier off has to take its
 * element-hiding rules with it, not just its network rules.
 */
function tierMap(root, tier) {
  let map = root.get(tier);
  if (!map) { map = new Map(); root.set(tier, map); }
  return map;
}

function tierSet(root, tier) {
  let set = root.get(tier);
  if (!set) { set = new Set(); root.set(tier, set); }
  return set;
}

function handleCosmetic({ marker, prefix, body }, tier, collected, stats) {
  const domains = parseCosmeticDomains(prefix);
  if (!domains) { note(stats, 'cosmetic-domain-syntax'); return; }

  const scriptlet = parseScriptlet(body);
  if (scriptlet) {
    if (marker === '#@#' || marker === '#@?#') return; // scriptlet exceptions: not modelled
    if (!domains.include.length) { note(stats, 'scriptlet-generic'); return; }
    const target = tierMap(collected.scriptlets, tier);
    for (const host of domains.include) {
      const list = target.get(host) || [];
      list.push({ name: scriptlet.name, args: scriptlet.args });
      target.set(host, list);
    }
    stats.scriptlets++;
    return;
  }

  // `#$#` with a body that is not `+js(...)` is an ABP snippet or a CSS
  // declaration block; neither is modelled here.
  if (marker === '#$#' || marker === '#@$#') { note(stats, 'abp-snippet'); return; }

  const classified = classifySelector(body);
  if (classified.kind === 'skip') { note(stats, `selector:${classified.reason}`); return; }

  const isUnhide = marker === '#@#' || marker === '#@?#';
  const target = tierMap(classified.kind === 'procedural' ? collected.procedural : collected.cosmetic, tier);

  if (!domains.include.length) {
    if (classified.kind === 'procedural') { note(stats, 'procedural-generic'); return; }
    if (isUnhide) { tierSet(collected.genericExceptions, tier).add(classified.selector); return; }
    tierSet(collected.generic, tier).add(classified.selector);
    stats.cosmetic++;
    return;
  }

  for (const host of domains.include) {
    const bucket = target.get(host) || { hide: new Set(), unhide: new Set() };
    (isUnhide ? bucket.unhide : bucket.hide).add(classified.selector);
    target.set(host, bucket);
  }
  for (const host of domains.exclude) {
    const bucket = target.get(host) || { hide: new Set(), unhide: new Set() };
    bucket.unhide.add(classified.selector);
    target.set(host, bucket);
  }
  if (classified.kind === 'procedural') stats.procedural++; else stats.cosmetic++;
}

export function parseList(text, tier, collected, stats) {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (isCommentOrDirective(line)) continue;

    const cosmetic = findCosmeticMarker(line);
    if (cosmetic) {
      handleCosmetic(cosmetic, tier, collected, stats);
      continue;
    }

    const parsed = parseNetworkFilter(line);
    if (parsed.kind === 'skip') { note(stats, parsed.reason); continue; }
    collected.network.push({ tier, parsed });
    if (parsed.isException) stats.exceptions++; else stats.network++;
  }
}

/** Deduplicate, rank, and number the network rules within each tier's budget. */
export function buildRulesets(networkFilters, stats) {
  const tiers = new Map();
  const seen = new Set();
  let regexUsed = 0;

  for (const { tier, parsed } of networkFilters) {
    const bucket = tiers.get(tier) || { allow: [], block: [] };
    tiers.set(tier, bucket);

    let built;
    try {
      built = buildNetworkRule(parsed, 0);
    } catch (error) {
      note(stats, String(error?.message || 'rule-error'));
      continue;
    }
    if (built.error) { note(stats, `rule:${built.error}`); continue; }

    const rule = built.rule;
    if (rule.condition.regexFilter) {
      if (regexUsed >= REGEX_BUDGET) { note(stats, 'regex-budget'); continue; }
      regexUsed++;
    }
    const key = `${tier}|${JSON.stringify(rule.action)}|${JSON.stringify(rule.condition)}`;
    if (seen.has(key)) { note(stats, 'duplicate'); continue; }
    seen.add(key);

    const filterText = rule.condition.urlFilter || rule.condition.regexFilter || '';
    (rule.action.type === 'block' ? bucket.block : bucket.allow)
      .push({ rule, value: ruleValue(parsed, filterText) });
  }

  const out = new Map();
  let nextId = 1;
  for (const [tier, bucket] of tiers) {
    const budget = TIER_BUDGET[tier] ?? 5000;
    // Exceptions are kept first: they exist to stop the list breaking sites.
    const allow = bucket.allow.slice(0, Math.floor(budget * 0.25));
    const blockBudget = Math.max(0, budget - allow.length);
    const block = bucket.block.sort((a, b) => b.value - a.value).slice(0, blockBudget);
    const rules = [...allow, ...block].map(entry => ({ ...entry.rule, id: nextId++ }));
    out.set(tier, rules);
    if (bucket.block.length > blockBudget) {
      note(stats, `budget-trim:${tier}:${bucket.block.length - blockBudget}`);
    }
  }
  return out;
}

/** Build the always-on generic stylesheet, honouring global unhide rules. */
export function buildGenericCss(generic, exceptions, stats) {
  const selectors = [...generic]
    .filter(selector => !exceptions.has(selector))
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const kept = [];
  let bytes = 0;
  for (const selector of selectors) {
    const cost = selector.length + 1;
    if (bytes + cost > GENERIC_CSS_BUDGET_BYTES) { note(stats, 'generic-css-budget'); continue; }
    bytes += cost;
    kept.push(selector);
  }
  const header = '/* OE Bridge generic element-hiding rules. Generated by tools/build-filters.mjs. */\n';
  if (!kept.length) return { css: header, count: 0 };
  // One rule per chunk keeps any single malformed selector from voiding the
  // entire stylesheet, since CSS discards only the rule it appears in.
  const chunks = [];
  for (let i = 0; i < kept.length; i += 500) {
    chunks.push(`${kept.slice(i, i + 500).join(',\n')}\n{display:none!important;}`);
  }
  return { css: `${header}${chunks.join('\n')}\n`, count: kept.length };
}

function hostPattern(host) {
  return [`*://${host}/*`, `*://*.${host}/*`];
}

/**
 * Flatten the collected per-site cosmetic rules into sorted, bucketable
 * entries. A selector that the same host also unhides is dropped outright.
 */
export function buildSiteEntries(cosmetic) {
  return [...cosmetic.entries()]
    .map(([host, bucket]) => ({
      host,
      hide: [...bucket.hide].filter(selector => !bucket.unhide.has(selector)),
      unhide: [...bucket.unhide],
    }))
    .filter(entry => entry.hide.length || entry.unhide.length)
    .sort((a, b) => (a.host < b.host ? -1 : 1));
}

/**
 * Bucket payloads hand their rules over through a queue rather than calling
 * into the engine directly. Each bucket is registered together with the engine
 * script ahead of it, but the queue keeps the pair correct even if a browser
 * ever injects them the other way round.
 */
function queueSource(queueName, flushName, payloads) {
  return '// Generated by tools/build-filters.mjs. Do not edit.\n'
    + `(globalThis.${queueName} ||= []).push(${payloads.join(',')});\n`
    + `globalThis.${flushName}?.();\n`;
}

function cosmeticBucketSource(entries) {
  const hide = {};
  const unhide = {};
  for (const entry of entries) {
    if (entry.hide.length) hide[entry.host] = entry.hide;
    if (entry.unhide.length) unhide[entry.host] = entry.unhide;
  }
  return queueSource('__oeCosmeticQueue', '__oeCosmeticFlush',
    [`[${JSON.stringify(hide)},${JSON.stringify(unhide)}]`]);
}

function proceduralBucketSource(entries) {
  const map = {};
  for (const entry of entries) map[entry.host] = entry.selectors;
  return queueSource('__oeProceduralQueue', '__oeCosmeticFlush', [JSON.stringify(map)]);
}

function scriptletBucketSource(entries) {
  const map = {};
  for (const entry of entries) map[entry.host] = entry.rules;
  return '// Generated by tools/build-filters.mjs. Do not edit.\n'
    + `(() => { const M = ${JSON.stringify(map)};\n`
    + 'const host = location.hostname.toLowerCase(); const parts = host.split(".");\n'
    + 'const rules = []; for (let i = 0; i < parts.length - 1; i++) {\n'
    + '  const found = M[parts.slice(i).join(".")]; if (found) rules.push(...found); }\n'
    + 'if (!rules.length) return;\n'
    + '(globalThis.__oeScriptletQueue ||= []).push(rules);\n'
    + 'globalThis.__oeScriptletFlush?.();\n})();\n';
}

/**
 * Split host-keyed entries into byte-bounded buckets so a page only ever
 * downloads and parses the rules that can apply to it.
 */
function bucketize(entries, targetBytes) {
  const buckets = [];
  let current = { entries: [], bytes: 0 };
  for (const entry of entries) {
    const cost = JSON.stringify(entry).length;
    if (current.bytes + cost > targetBytes && current.entries.length) {
      buckets.push(current);
      current = { entries: [], bytes: 0 };
    }
    current.entries.push(entry);
    current.bytes += cost;
  }
  if (current.entries.length) buckets.push(current);
  return buckets;
}

/**
 * Write one bucket family and return the registration entries the background
 * worker feeds to chrome.scripting.registerContentScripts.
 */
function emitBuckets({ outDir, dir, prefix, buckets, render, engine, world, tier }) {
  const target = path.join(outDir, 'filters', dir);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const registrations = [];
  let bytes = 0;
  buckets.forEach((bucket, position) => {
    const name = `${prefix}-${String(position).padStart(3, '0')}.js`;
    const file = path.join(target, name);
    fs.writeFileSync(file, render(bucket.entries));
    bytes += fs.statSync(file).size;
    registrations.push({
      id: `oe-${prefix}-${String(position).padStart(3, '0')}`,
      js: [...engine, `filters/${dir}/${name}`],
      matches: bucket.entries.flatMap(entry => hostPattern(entry.host)),
      world,
      tier,
    });
  });
  return { registrations, bytes };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return fs.statSync(file).size;
}

async function fetchSources(sourceDir) {
  fs.mkdirSync(sourceDir, { recursive: true });
  for (const source of SOURCES) {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`${source.file}: HTTP ${response.status}`);
    fs.writeFileSync(path.join(sourceDir, source.file), await response.text());
    process.stdout.write(`fetched ${source.file}\n`);
  }
}

/**
 * @param {{sourceDir?: string, outDir?: string, fetch?: boolean}} [options]
 *   Omitted values fall back to the command line, so the same entry point
 *   serves both `node tools/build-filters.mjs` and the OE refresh endpoint.
 */
export async function main(options = {}) {
  const sourceDir = path.resolve(
    options.sourceDir || argValue('--source', path.join(EXT_DIR, '.filter-cache')),
  );
  const outDir = path.resolve(options.outDir || argValue('--out', EXT_DIR));
  if (options.fetch ?? process.argv.includes('--fetch')) await fetchSources(sourceDir);

  // Every cosmetic collection is keyed by tier first, so a tier that is turned
  // off takes its element-hiding and scriptlet rules with it.
  const collected = {
    network: [],
    generic: new Map(),
    genericExceptions: new Map(),
    cosmetic: new Map(),
    procedural: new Map(),
    scriptlets: new Map(),
  };
  const stats = newStats();
  const used = [];

  // Seed the ads tier with the curated floor before any list is read, so these
  // rank first and survive the budget regardless of what upstream provides.
  for (const domain of CORE_AD_DOMAINS) {
    const parsed = parseNetworkFilter(`||${domain}^$third-party`);
    if (parsed.kind !== 'network') throw new Error(`core domain did not parse: ${domain}`);
    collected.network.push({ tier: 'ads', parsed: { ...parsed, core: true } });
  }

  for (const source of SOURCES) {
    const file = path.join(sourceDir, source.file);
    if (!fs.existsSync(file)) {
      process.stderr.write(`missing source, skipping: ${source.file}\n`);
      continue;
    }
    parseList(fs.readFileSync(file, 'utf8'), source.tier, collected, stats);
    used.push({ name: source.name, license: source.license, url: source.url, tier: source.tier });
  }
  if (!used.length) throw new Error(`no filter lists found in ${sourceDir}`);

  const rulesets = buildRulesets(collected.network, stats);
  const summary = { tiers: {}, sources: used };
  for (const tier of TIERS) {
    const rules = rulesets.get(tier) || [];
    const bytes = writeJson(path.join(outDir, 'rules', `${tier}.json`), rules);
    summary.tiers[tier] = { rules: rules.length, bytes };
  }

  const registrations = [];
  let droppedScriptlets = 0;
  summary.generic = { selectors: 0, bytes: 0 };
  summary.sites = { buckets: 0, hosts: 0, bytes: 0 };
  summary.procedural = { buckets: 0, hosts: 0, bytes: 0 };
  summary.scriptlets = { buckets: 0, hosts: 0, bytes: 0 };

  for (const tier of TIERS) {
    const siteEntries = buildSiteEntries(collected.cosmetic.get(tier) || new Map());
    const siteResult = emitBuckets({
      outDir,
      dir: `sites-${tier}`,
      prefix: `site-${tier}`,
      buckets: bucketize(siteEntries, SITE_BUCKET_TARGET_BYTES),
      render: cosmeticBucketSource,
      engine: ['content-cosmetic.js'],
      world: 'ISOLATED',
      tier,
    });
    registrations.push(...siteResult.registrations);
    summary.sites.buckets += siteResult.registrations.length;
    summary.sites.hosts += siteEntries.length;
    summary.sites.bytes += siteResult.bytes;

    const proceduralEntries = [...(collected.procedural.get(tier) || new Map()).entries()]
      .map(([host, bucket]) => ({
        host,
        selectors: [...bucket.hide].filter(selector => !bucket.unhide.has(selector)),
      }))
      .filter(entry => entry.selectors.length)
      .sort((a, b) => (a.host < b.host ? -1 : 1));
    const proceduralResult = emitBuckets({
      outDir,
      dir: `procedural-${tier}`,
      prefix: `proc-${tier}`,
      buckets: bucketize(proceduralEntries, SITE_BUCKET_TARGET_BYTES),
      render: proceduralBucketSource,
      engine: ['content-cosmetic.js'],
      world: 'ISOLATED',
      tier,
    });
    registrations.push(...proceduralResult.registrations);
    summary.procedural.buckets += proceduralResult.registrations.length;
    summary.procedural.hosts += proceduralEntries.length;
    summary.procedural.bytes += proceduralResult.bytes;

    const scriptletEntries = [...(collected.scriptlets.get(tier) || new Map()).entries()]
      .map(([host, list]) => {
        const unique = new Map();
        for (const entry of list) {
          const canonical = SCRIPTLET_ALIASES[entry.name] || entry.name;
          if (!SUPPORTED_SCRIPTLETS.includes(canonical)) { droppedScriptlets++; continue; }
          unique.set(`${canonical}|${entry.args.join(' ')}`, [canonical, ...entry.args]);
        }
        return { host, rules: [...unique.values()] };
      })
      .filter(entry => entry.rules.length)
      .sort((a, b) => (a.host < b.host ? -1 : 1));
    const scriptletResult = emitBuckets({
      outDir,
      dir: `scriptlets-${tier}`,
      prefix: `js-${tier}`,
      buckets: bucketize(scriptletEntries, SITE_BUCKET_TARGET_BYTES),
      render: scriptletBucketSource,
      engine: ['content-scriptlets.js'],
      world: 'MAIN',
      tier,
    });
    registrations.push(...scriptletResult.registrations);
    summary.scriptlets.buckets += scriptletResult.registrations.length;
    summary.scriptlets.hosts += scriptletEntries.length;
    summary.scriptlets.bytes += scriptletResult.bytes;

    // The always-on stylesheet is per tier too, and is registered rather than
    // declared in the manifest so a paused site can be excluded from it.
    const genericTier = buildGenericCss(
      collected.generic.get(tier) || new Set(),
      collected.genericExceptions.get(tier) || new Set(),
      stats,
    );
    const genericName = `filters/cosmetic-generic-${tier}.css`;
    const genericPath = path.join(outDir, genericName);
    fs.mkdirSync(path.dirname(genericPath), { recursive: true });
    fs.writeFileSync(genericPath, genericTier.css);
    summary.generic.selectors += genericTier.count;
    summary.generic.bytes += fs.statSync(genericPath).size;
    if (genericTier.count) {
      registrations.push({
        id: `oe-generic-${tier}`,
        css: [genericName],
        matches: ['http://*/*', 'https://*/*'],
        world: 'ISOLATED',
        tier,
      });
    }
  }
  summary.scriptlets.dropped = droppedScriptlets;
  if (droppedScriptlets) note(stats, `scriptlet-unsupported:${droppedScriptlets}`);

  summary.registrationBytes = writeJson(
    path.join(outDir, 'filters', 'registrations.json'),
    registrations,
  );

  writeJson(path.join(outDir, 'filters', 'build-info.json'), {
    generated: new Date().toISOString().slice(0, 10),
    sources: used,
    counts: {
      tiers: Object.fromEntries(Object.entries(summary.tiers).map(([key, value]) => [key, value.rules])),
      genericSelectors: summary.generic.selectors,
      siteHosts: summary.sites.hosts,
      proceduralHosts: summary.procedural.hosts,
      scriptletHosts: summary.scriptlets.hosts,
    },
  });

  const totalBytes = Object.values(summary.tiers).reduce((total, value) => total + value.bytes, 0)
    + summary.generic.bytes + summary.sites.bytes + summary.procedural.bytes
    + summary.scriptlets.bytes + summary.registrationBytes;
  const topSkips = [...stats.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  summary.totalBytes = totalBytes;
  if (options.quiet) return summary;
  process.stdout.write(`${JSON.stringify({
    ...summary,
    sources: used.length,
    totalBytes,
    stats: { ...stats, reasons: undefined },
    topSkips,
  }, null, 2)}\n`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exit(1); });
}
