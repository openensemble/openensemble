// @ts-check
/**
 * Privacy-preserving browser project suggestions.
 *
 * A successful explicit Clip is the only event that teaches this store. The
 * extension receives coarse, label-free matchers only on a trusted single-user
 * browser profile. Project names and reasons remain server-side until the user
 * opens a generic "OE found something relevant" suggestion.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';
import { getUserRole } from '../routes/_helpers.mjs';

const STORE_VERSION = 1;
const MAX_PROJECTS = 100;
const MAX_KEYWORDS = 12;
const MAX_MUTED_HOSTS = 100;

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'best', 'browser', 'buying', 'from', 'have', 'home',
  'into', 'more', 'open', 'page', 'price', 'product', 'research', 'review', 'save',
  'that', 'their', 'there', 'these', 'this', 'with', 'your', 'www', 'http', 'https',
]);

// Suggestion matching is intentionally unavailable for projects whose labels
// or captured titles reveal high-sensitivity interests. The general browser
// sensitive-origin policy remains the primary boundary; this is defense in
// depth for matcher storage.
const SENSITIVE_WORDS = new Set([
  'abortion', 'addiction', 'bankruptcy', 'cancer', 'credit', 'debt', 'diagnosis',
  'divorce', 'fertility', 'hiv', 'insurance', 'lawsuit', 'medication', 'mortgage',
  'password', 'pregnancy', 'psychiatry', 'therapy', 'trauma', 'treatment',
]);

function storePath(userId) {
  const safe = String(userId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(safe)) throw new Error('valid userId is required');
  const dir = path.join(USERS_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'browser-suggestions.json');
}

function emptyStore() {
  return { version: STORE_VERSION, projects: [] };
}

function load(userId) {
  const file = storePath(userId);
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version === STORE_VERSION && Array.isArray(parsed.projects)) return parsed;
    throw new Error('unsupported or malformed schema');
  } catch (error) {
    throw new Error(`browser suggestion store is malformed; refusing to continue: ${error.message}`);
  }
}

function save(userId, store) {
  atomicWriteSync(storePath(userId), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function normalizeHost(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '').slice(0, 253) || null;
  } catch { return null; }
}

function tokens(value) {
  return [...new Set(String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 4 && word.length <= 28 && !STOP_WORDS.has(word)))]
    .slice(0, 80);
}

function containsSensitive(value) {
  return tokens(value).some(word => SENSITIVE_WORDS.has(word));
}

function coarseKeywords({ title, label, host }) {
  // Hostnames are stored in the separate domain field and are activated only
  // by Remember. Folding them into keywords would accidentally make every
  // same-host page match before that explicit broader consent.
  const ordered = [...tokens(title), ...tokens(label)];
  return [...new Set(ordered)]
    .filter(word => !SENSITIVE_WORDS.has(word))
    .slice(0, MAX_KEYWORDS);
}

function newMatcherId() {
  return `bsm_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function publicMatcher(project) {
  return {
    id: project.id,
    // Before explicit Remember, related-title keywords can surface a generic
    // suggestion but a same-domain visit alone cannot. Remember opts into the
    // broader (and more revealing) domain-level matcher.
    domains: project.remembered === true ? project.domains.slice(0, 6) : [],
    excludedDomains: (project.mutedHosts || []).slice(0, 20),
    keywords: project.keywords.slice(0, MAX_KEYWORDS),
    minKeywordMatches: project.keywords.length >= 4 ? 2 : 1,
    updatedAt: project.updatedAt,
  };
}

/** @param {any} project @param {{url?:unknown,title?:unknown}} [page] */
function pageMatches(project, { url, title } = {}) {
  const host = normalizeHost(url);
  if (!host || project.mutedHosts.includes(host)) return { matched: false, host, hits: [] };
  const pageTokens = new Set([...tokens(title), ...host.split('.')]);
  const hits = project.keywords.filter(keyword => pageTokens.has(keyword));
  const domainMatch = project.remembered === true
    && project.domains.some(domain => host === domain || host.endsWith(`.${domain}`));
  const needed = project.keywords.length >= 4 ? 2 : 1;
  return { matched: domainMatch || hits.length >= needed, host, hits };
}

function eligible(userId, sharedProfile) {
  return Boolean(userId) && sharedProfile !== true && getUserRole(userId) !== 'child';
}

/** Record one explicitly saved clip as project-only learning. */
export async function recordBrowserClipForSuggestions(userId, {
  targetId, projectLabel, capture, sharedProfile = false,
} = /** @type {{targetId?:unknown,projectLabel?:unknown,capture?:any,sharedProfile?:boolean}} */ ({})) {
  if (!eligible(userId, sharedProfile)) return null;
  const label = String(projectLabel || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160);
  const title = String(capture?.title || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300);
  const host = normalizeHost(capture?.url);
  if (!targetId || !label || !host || containsSensitive(`${label} ${title}`)) return null;
  const learned = coarseKeywords({ title, label, host });
  if (!learned.length) return null;
  const file = storePath(userId);
  return withLock(file, () => {
    const store = load(userId);
    let project = store.projects.find(row => row.targetId === String(targetId));
    const now = new Date().toISOString();
    if (!project) {
      project = {
        id: newMatcherId(), targetId: String(targetId).slice(0, 200), label, keywords: [], domains: [],
        mutedHosts: [], remembered: false, evidenceCount: 0, createdAt: now, updatedAt: now,
      };
      store.projects.push(project);
    }
    project.label = label;
    project.keywords = [...new Set([...project.keywords, ...learned])].slice(0, MAX_KEYWORDS);
    project.domains = [...new Set([...project.domains, host])].slice(0, 6);
    project.evidenceCount = Math.min(10_000, Number(project.evidenceCount || 0) + 1);
    project.updatedAt = now;
    store.projects = store.projects
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, MAX_PROJECTS);
    save(userId, store);
    return publicMatcher(project);
  });
}

/** Return label-free bundles suitable for trusted extension-local matching. */
export function listBrowserSuggestionMatchers(userId, { sharedProfile = false } = {}) {
  if (!eligible(userId, sharedProfile)) return [];
  return load(userId).projects
    .filter(project => Array.isArray(project.keywords) && project.keywords.length)
    .map(publicMatcher);
}

/** Revalidate a local match and reveal its project only after the user clicks. */
export function resolveBrowserSuggestion(userId, {
  matcherId: rawId, url, title, sharedProfile = false,
} = /** @type {{matcherId?:unknown,url?:unknown,title?:unknown,sharedProfile?:boolean}} */ ({})) {
  if (!eligible(userId, sharedProfile)) return null;
  const project = load(userId).projects.find(row => row.id === String(rawId || ''));
  if (!project) return null;
  const match = pageMatches(project, { url, title });
  if (!match.matched) return null;
  return {
    id: project.id,
    projectLabel: project.label,
    reason: match.hits.length
      ? `This page shares ${match.hits.slice(0, 3).join(', ')} with ${project.label}.`
      : `You previously saved research from ${match.host} to ${project.label}.`,
    remembered: project.remembered === true,
    actions: ['remember', 'not_relevant', 'forget'],
  };
}

/** Apply an explicit suggestion feedback action. */
export async function respondToBrowserSuggestion(userId, {
  matcherId: rawId, action, url, sharedProfile = false,
} = /** @type {{matcherId?:unknown,action?:unknown,url?:unknown,sharedProfile?:boolean}} */ ({})) {
  if (!eligible(userId, sharedProfile)) return { ok: false, error: 'suggestions_unavailable' };
  if (!['remember', 'not_relevant', 'forget'].includes(String(action))) {
    return { ok: false, error: 'invalid_action' };
  }
  const file = storePath(userId);
  return withLock(file, () => {
    const store = load(userId);
    const index = store.projects.findIndex(row => row.id === String(rawId || ''));
    if (index < 0) return { ok: false, error: 'not_found' };
    const project = store.projects[index];
    if (action === 'forget') {
      store.projects.splice(index, 1);
    } else if (action === 'remember') {
      project.remembered = true;
      project.updatedAt = new Date().toISOString();
    } else {
      const host = normalizeHost(url);
      if (!host) return { ok: false, error: 'invalid_url' };
      project.mutedHosts = [...new Set([...(project.mutedHosts || []), host])].slice(-MAX_MUTED_HOSTS);
      project.updatedAt = new Date().toISOString();
    }
    save(userId, store);
    return { ok: true, action };
  });
}

export function _resetBrowserSuggestionsForTests(userId) {
  try { fs.rmSync(storePath(userId), { force: true }); } catch {}
}

export const __test = Object.freeze({ tokens, normalizeHost, pageMatches, containsSensitive });
