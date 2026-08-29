// OE Bridge ad-blocking engine (service worker side).
//
// Owns everything about *list-driven* blocking:
//   - which tiers are on, and the static declarativeNetRequest rulesets and
//     registered content scripts that follow from that;
//   - the per-site pause list, expressed both as dynamic allow rules (network)
//     and as excludeMatches on every registered script (cosmetic);
//   - the per-tab blocked counter behind the toolbar badge.
//
// Learned right-click rules stay in background.js. Nothing here reports to the
// OE server: tiers, the pause list, and counts are all browser-local.

export const TIERS = ['ads', 'trackers', 'annoyances'];

/** Mirrors tools/filter-parser.mjs: every blockable type except `main_frame`. */
const BLOCKABLE_RESOURCE_TYPES = Object.freeze([
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other',
]);

const RULESET_FOR_TIER = { ads: 'oe_ads', trackers: 'oe_trackers', annoyances: 'oe_annoyances' };
const SURROGATE_RULESET_ID = 'oe_surrogates';

export const AD_BLOCK_ENABLED_KEY = 'adBlockingEnabled';
const TIERS_KEY = 'adBlockTiers';
const ALLOWLIST_KEY = 'adBlockAllowlist';
const BLOCKLIST_KEY = 'adBlockCustomDomains';

/** Trackers ride with ads by default; annoyances are opt-in because cookie and
 * newsletter rules are the most likely to interfere with a site. */
const DEFAULT_TIERS = Object.freeze({ ads: true, trackers: true, annoyances: false });

const REGISTRATION_PREFIX = 'oe-';
const REGISTRATION_CHUNK = 6;
const MAX_ALLOWLIST_HOSTS = 500;
const MAX_BLOCKLIST_HOSTS = 500;
/**
 * Dynamic rule ids are ours to allocate; keep them clear of the static
 * rulesets and give each list its own range so one sync never clears the
 * other's rules.
 */
const BLOCKLIST_RULE_ID_BASE = 800_000;
const ALLOWLIST_RULE_ID_BASE = 900_000;

/**
 * Priority ladder, highest first:
 *   5000  a site the user paused              (allowAllRequests)
 *   4500  a domain the user blocked by hand   (block)
 *   4000  an `$important` list exception      (allowAllRequests)
 *   3000  a list `$document` exception        (allowAllRequests)
 *   2500  a surrogate redirect
 *   2000  an `$important` list block
 *   1000  an ordinary list block or exception
 * A hand-added block therefore beats every list rule, because the user asked
 * for it explicitly, but still yields to their own pause on the current site.
 */
const BLOCKLIST_PRIORITY = 4500;

let _registrationsCache = null;
const _blockedCounts = new Map();

// --- preferences -------------------------------------------------------------

export async function getMasterEnabled() {
  const stored = await chrome.storage.local.get(AD_BLOCK_ENABLED_KEY);
  return stored?.[AD_BLOCK_ENABLED_KEY] !== false;
}

export async function getTierPreferences() {
  const stored = await chrome.storage.local.get(TIERS_KEY);
  const value = stored?.[TIERS_KEY];
  const result = { ...DEFAULT_TIERS };
  if (value && typeof value === 'object') {
    for (const tier of TIERS) {
      if (typeof value[tier] === 'boolean') result[tier] = value[tier];
    }
  }
  return result;
}

export async function setTierPreference(tier, enabled) {
  if (!TIERS.includes(tier)) throw new Error('unknown blocking tier');
  const tiers = await getTierPreferences();
  tiers[tier] = enabled === true;
  await chrome.storage.local.set({ [TIERS_KEY]: tiers });
  return tiers;
}

function normalizeHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host || host.length > 253) return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

export async function getAllowlist() {
  const stored = await chrome.storage.local.get(ALLOWLIST_KEY);
  const value = Array.isArray(stored?.[ALLOWLIST_KEY]) ? stored[ALLOWLIST_KEY] : [];
  const hosts = [];
  for (const entry of value) {
    const host = normalizeHost(entry);
    if (host && !hosts.includes(host)) hosts.push(host);
    if (hosts.length >= MAX_ALLOWLIST_HOSTS) break;
  }
  return hosts;
}

export async function setSiteAllowed(rawHost, allowed) {
  const host = normalizeHost(rawHost);
  if (!host) throw new Error('open a web page first');
  const current = await getAllowlist();
  const next = allowed
    ? [...new Set([host, ...current])].slice(0, MAX_ALLOWLIST_HOSTS)
    : current.filter(entry => entry !== host);
  await chrome.storage.local.set({ [ALLOWLIST_KEY]: next });
  return next;
}

export async function getBlocklist() {
  const stored = await chrome.storage.local.get(BLOCKLIST_KEY);
  const value = Array.isArray(stored?.[BLOCKLIST_KEY]) ? stored[BLOCKLIST_KEY] : [];
  const hosts = [];
  for (const entry of value) {
    const host = normalizeHost(entry);
    if (host && !hosts.includes(host)) hosts.push(host);
    if (hosts.length >= MAX_BLOCKLIST_HOSTS) break;
  }
  return hosts;
}

/**
 * Add or remove a hand-entered domain block. Blocking `example.com` also covers
 * its subdomains, so entering the registrable domain is usually what is wanted.
 */
export async function setDomainBlocked(rawHost, blocked) {
  const host = normalizeHost(rawHost);
  if (!host) throw new Error('enter a domain like log.byteoversea.com');
  const current = await getBlocklist();
  if (blocked && current.length >= MAX_BLOCKLIST_HOSTS && !current.includes(host)) {
    throw new Error(`the blocked-domain list is full (${MAX_BLOCKLIST_HOSTS})`);
  }
  const next = blocked
    ? [...new Set([host, ...current])].sort()
    : current.filter(entry => entry !== host);
  await chrome.storage.local.set({ [BLOCKLIST_KEY]: next });
  return next;
}

export async function isSiteAllowed(rawHost) {
  const host = normalizeHost(rawHost);
  if (!host) return false;
  const allowlist = await getAllowlist();
  // A pause on `example.com` covers `www.example.com` too.
  return allowlist.some(entry => host === entry || host.endsWith(`.${entry}`));
}

function hostPatterns(host) {
  return [`*://${host}/*`, `*://*.${host}/*`];
}

// --- generated filter payload ------------------------------------------------

async function loadRegistrations() {
  if (_registrationsCache) return _registrationsCache;
  try {
    const response = await fetch(chrome.runtime.getURL('filters/registrations.json'));
    const parsed = await response.json();
    _registrationsCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    _registrationsCache = [];
  }
  return _registrationsCache;
}

export async function getBuildInfo() {
  try {
    const response = await fetch(chrome.runtime.getURL('filters/build-info.json'));
    return await response.json();
  } catch {
    return null;
  }
}

// --- network rulesets --------------------------------------------------------

async function syncRulesets(master, tiers) {
  const api = chrome?.declarativeNetRequest;
  if (!api?.updateEnabledRulesets) {
    throw new Error('This browser does not provide Manifest V3 network filtering.');
  }
  const enableRulesetIds = [];
  const disableRulesetIds = [];
  for (const tier of TIERS) {
    const id = RULESET_FOR_TIER[tier];
    (master && tiers[tier] ? enableRulesetIds : disableRulesetIds).push(id);
  }
  // Surrogates only matter while something is being blocked, and they must not
  // redirect anything once the user turns blocking off entirely.
  (master ? enableRulesetIds : disableRulesetIds).push(SURROGATE_RULESET_ID);
  await api.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
}

/**
 * Rebuild both dynamic lists: paused sites get an `allowAllRequests` rule above
 * every other priority, and hand-added domains get a block just below it.
 *
 * Both are rewritten in one call so a toggle cannot leave the two halves
 * disagreeing, and each only clears ids from its own range.
 */
async function syncDynamicRules(allowlist, blocklist) {
  const api = chrome?.declarativeNetRequest;
  if (!api?.updateDynamicRules) return;
  const existing = await api.getDynamicRules().catch(() => []);
  const removeRuleIds = existing
    .filter(rule => rule.id >= BLOCKLIST_RULE_ID_BASE)
    .map(rule => rule.id);

  const addRules = [
    ...blocklist.slice(0, MAX_BLOCKLIST_HOSTS).map((host, index) => ({
      id: BLOCKLIST_RULE_ID_BASE + index,
      priority: BLOCKLIST_PRIORITY,
      action: { type: 'block' },
      // `main_frame` stays out: OE never blocks a top-level navigation, so a
      // hand-added domain still opens if it is typed into the address bar.
      condition: { urlFilter: `||${host}^`, resourceTypes: [...BLOCKABLE_RESOURCE_TYPES] },
    })),
    ...allowlist.slice(0, MAX_ALLOWLIST_HOSTS).map((host, index) => ({
      id: ALLOWLIST_RULE_ID_BASE + index,
      priority: 5000,
      action: { type: 'allowAllRequests' },
      condition: { urlFilter: `||${host}^`, resourceTypes: ['main_frame', 'sub_frame'] },
    })),
  ];
  await api.updateDynamicRules({ removeRuleIds, addRules });
}

// --- registered content scripts ---------------------------------------------

async function syncContentScripts(master, tiers, allowlist) {
  const api = chrome?.scripting;
  if (!api?.registerContentScripts) return;

  const all = await loadRegistrations();
  const excludeMatches = allowlist.flatMap(hostPatterns);
  const desired = new Map();
  if (master) {
    for (const entry of all) {
      if (!entry?.id || !tiers[entry.tier]) continue;
      const script = {
        id: entry.id,
        matches: entry.matches,
        runAt: 'document_start',
        allFrames: true,
        persistAcrossSessions: true,
      };
      if (entry.js) script.js = entry.js;
      if (entry.css) script.css = entry.css;
      if (entry.world) script.world = entry.world;
      if (excludeMatches.length) script.excludeMatches = excludeMatches;
      desired.set(entry.id, script);
    }
  }

  const registered = await api.getRegisteredContentScripts().catch(() => []);
  const ours = registered.filter(script => String(script.id || '').startsWith(REGISTRATION_PREFIX));

  const stale = ours.filter(script => !desired.has(script.id)).map(script => script.id);
  if (stale.length) await api.unregisterContentScripts({ ids: stale }).catch(() => {});

  const existingIds = new Set(ours.map(script => script.id));
  const toAdd = [...desired.values()].filter(script => !existingIds.has(script.id));
  const toUpdate = [...desired.values()].filter(script => {
    if (!existingIds.has(script.id)) return false;
    const current = ours.find(entry => entry.id === script.id);
    const before = (current?.excludeMatches || []).join('|');
    return before !== excludeMatches.join('|');
  });

  // Chrome rejects the whole call if any one script is invalid, so these go in
  // small batches: a bad bucket then costs its batch instead of all blocking.
  for (let index = 0; index < toAdd.length; index += REGISTRATION_CHUNK) {
    const batch = toAdd.slice(index, index + REGISTRATION_CHUNK);
    try {
      await api.registerContentScripts(batch);
    } catch (error) {
      console.warn('[OE Bridge] filter script registration failed:', error?.message || error);
    }
  }
  for (let index = 0; index < toUpdate.length; index += REGISTRATION_CHUNK) {
    const batch = toUpdate.slice(index, index + REGISTRATION_CHUNK)
      .map(script => ({ id: script.id, excludeMatches: script.excludeMatches || [] }));
    try {
      await api.updateContentScripts(batch);
    } catch (error) {
      console.warn('[OE Bridge] filter script update failed:', error?.message || error);
    }
  }
}

// --- blocked counters --------------------------------------------------------

export function blockedCountForTab(tabId) {
  return _blockedCounts.get(Number(tabId)) || 0;
}

function paintBadge(tabId, count) {
  if (!chrome?.action?.setBadgeText) return;
  const text = count > 999 ? '999+' : String(count || '');
  chrome.action.setBadgeText({ tabId, text: count ? text : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor?.({ tabId, color: '#4b5563' }).catch(() => {});
}

export function resetTabCount(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return;
  _blockedCounts.delete(id);
  paintBadge(id, 0);
}

/**
 * `onRuleMatchedDebug` is only delivered to unpacked extensions, which is how
 * OE Bridge is installed. Where it is missing the counter simply stays absent
 * rather than reporting a wrong number.
 */
export function installCounters() {
  const api = chrome?.declarativeNetRequest;
  if (!api?.onRuleMatchedDebug?.addListener) return false;
  try {
    api.onRuleMatchedDebug.addListener(info => {
      const tabId = Number(info?.request?.tabId);
      if (!Number.isInteger(tabId) || tabId < 0) return;
      const next = (_blockedCounts.get(tabId) || 0) + 1;
      _blockedCounts.set(tabId, next);
      paintBadge(tabId, next);
    });
  } catch {
    return false;
  }
  chrome.tabs?.onRemoved?.addListener(tabId => _blockedCounts.delete(Number(tabId)));
  return true;
}

export function countersAvailable() {
  return Boolean(chrome?.declarativeNetRequest?.onRuleMatchedDebug);
}

// --- top-level sync ----------------------------------------------------------

let _syncTail = Promise.resolve();

/** Bring rulesets, dynamic allow rules, and registered scripts in line with the
 * stored preferences. Serialized so overlapping toggles cannot interleave. */
export function syncEverything() {
  const pending = _syncTail.then(async () => {
    const [master, tiers, allowlist, blocklist] = await Promise.all([
      getMasterEnabled(), getTierPreferences(), getAllowlist(), getBlocklist(),
    ]);
    await syncRulesets(master, tiers);
    await syncDynamicRules(master ? allowlist : [], master ? blocklist : []);
    await syncContentScripts(master, tiers, allowlist);
    return { master, tiers, allowlist, blocklist };
  });
  _syncTail = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function setMasterEnabled(enabled) {
  await chrome.storage.local.set({ [AD_BLOCK_ENABLED_KEY]: enabled === true });
  await syncEverything();
  return enabled === true;
}

export async function engineStatus(siteHost) {
  const [master, tiers, allowlist, blocklist, buildInfo] = await Promise.all([
    getMasterEnabled(), getTierPreferences(), getAllowlist(), getBlocklist(), getBuildInfo(),
  ]);
  const paused = siteHost
    ? allowlist.some(entry => siteHost === entry || siteHost.endsWith(`.${entry}`))
    : false;
  return {
    enabled: master,
    tiers,
    paused,
    allowlistCount: allowlist.length,
    blockedDomains: blocklist,
    countersAvailable: countersAvailable(),
    filters: buildInfo
      ? { generated: buildInfo.generated, counts: buildInfo.counts, sources: buildInfo.sources?.length || 0 }
      : null,
  };
}
