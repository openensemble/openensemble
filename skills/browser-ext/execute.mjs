// @ts-check
/**
 * Browser-extension tools. Read-only Tier 0 (list, open_tab, read_page),
 * media keys + tab nav (Tier 1.5), and vision primitives (screenshot,
 * click_xy, type, keypress) that set up a screenshot → reason → act loop
 * for sites that don't make sense from HTML alone.
 *
 * The wire protocol + connection management lives in lib/browser-bus.mjs;
 * this file just adapts the bus surface to OE's tool-call shape.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { listBrowsers, sendCommand } from '../../lib/browser-bus.mjs';
import { getUserFilesDir, userSiteNotesDir, userSiteNotesPath, userSharedSiteNotesPath } from '../../lib/paths.mjs';
import {
  canonicalBrowserRoutineOrigin,
  deleteBrowserRoutine,
  listBrowserRoutines,
  replayBrowserRoutine,
  saveBrowserRoutineFromTeachEvents,
} from '../../lib/browser-routines.mjs';
import {
  browserMemoryTextContainsSecret,
  deleteBrowserPlaybook,
  evaluateBrowserAssertions,
  listBrowserPlaybooks,
  normalizeBrowserAssertions,
  saveBrowserPlaybook,
  templateBrowserAction,
} from '../../lib/browser-playbooks.mjs';
import { atomicWriteSync, withLock } from '../../routes/_helpers/io-lock.mjs';

const MAX_SITE_NOTE_WRITE = 8_000;
const MAX_SITE_NOTES_FILE = 64_000;
const LEARNING_INSPECTION_FRESH_MS = 2 * 60_000;
const LEARNING_MAX_RUN_MS = 15 * 60_000;
const LEARNING_MAX_TRANSITIONS = 40;
const LEARNING_PAGE_INSTRUCTION = /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b|\b(?:reveal|print|show|send|upload)\s+(?:the\s+)?(?:system prompt|credentials?|passwords?|tokens?|secrets?)\b|\b(?:system|developer|assistant)\s*:|\bfrom now on\b|\b(?:you|oe|the assistant)\s+(?:must|should|need to)\b|\b(?:always|never)\s+(?:click|select|fill|submit|send|upload|download|open|run|call|use)\b|\b(?:run|call|use)\s+(?:the\s+)?(?:browser_[a-z_]+|tool)\b/i;
const LEARNING_RAW_URL = /\bhttps?:\/\/\S+/i;

/** Process-local, fail-closed ledger. Never reconstructed from extension state. */
const _activeLearningRuns = new Map();

function _compact(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function _formatSemanticSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'No semantic page state was returned.';
  const lines = [
    `**${_compact(snapshot.title, 200) || '(no title)'}**`,
    `URL: ${_compact(snapshot.url, 1_500) || '(unknown)'}`,
    `Origin: ${_compact(snapshot.origin, 300) || '(unknown)'}`,
  ];
  const headings = Array.isArray(snapshot.headings) ? snapshot.headings : [];
  if (headings.length) {
    lines.push('', '## Headings');
    for (const heading of headings) {
      lines.push(`- h${Number(heading?.level) || '?'}: ${_compact(heading?.text, 200)}`);
    }
  }
  const dialogs = Array.isArray(snapshot.dialogs) ? snapshot.dialogs : [];
  if (dialogs.length) {
    lines.push('', '## Dialogs');
    for (const dialog of dialogs) {
      const state = [dialog?.modal ? 'modal' : null, dialog?.open === false ? 'closed' : 'open'].filter(Boolean).join(', ');
      lines.push(`- ${_compact(dialog?.role, 32) || 'dialog'} “${_compact(dialog?.name || dialog?.label, 180) || '(unnamed)'}”${state ? ` (${state})` : ''}`);
    }
  }
  const statuses = Array.isArray(snapshot.statusSignals) ? snapshot.statusSignals : [];
  if (statuses.length) {
    lines.push('', '## Status signals');
    for (const status of statuses) {
      lines.push(`- ${_compact(status?.role, 32) || 'status'}: ${_compact(status?.text, 300)}`);
    }
  }
  const controls = Array.isArray(snapshot.controls) ? snapshot.controls : [];
  if (controls.length) {
    lines.push('', '## Interactive controls');
    controls.forEach((control, index) => {
      const target = {
        role: _compact(control?.role, 32),
        ...(control?.name ? { name: _compact(control.name, 160) } : {}),
        ...(control?.label ? { label: _compact(control.label, 160) } : {}),
        ordinal: Number(control?.ordinal),
        exact: true,
      };
      const state = [];
      for (const key of ['type', 'disabled', 'checked', 'selected', 'expanded', 'pressed', 'required', 'readOnly', 'multiple']) {
        if (control?.[key] != null && control[key] !== '') state.push(`${key}=${String(control[key])}`);
      }
      if (Array.isArray(control?.options) && control.options.length) {
        state.push(`options=[${control.options.map(option => _compact(option, 80)).filter(Boolean).slice(0, 20).join(' | ')}]`);
      }
      lines.push(`${index + 1}. \`${JSON.stringify(target)}\`${state.length ? ` — ${state.join(', ')}` : ''}`);
    });
  }
  if (snapshot.truncated && Object.values(snapshot.truncated).some(Boolean)) {
    lines.push('', '_The semantic snapshot was safely truncated; inspect again after narrowing the page state if needed._');
  }
  return lines.join('\n').slice(0, 16_000);
}

function _semanticActionFromArgs(args) {
  const type = _compact(args?.operation, 24).toLowerCase();
  if (!['click', 'fill', 'select', 'toggle', 'wait_for'].includes(type)) {
    throw new TypeError('operation must be click, fill, select, toggle, or wait_for');
  }
  const rawTarget = args?.target && typeof args.target === 'object' && !Array.isArray(args.target)
    ? args.target
    : {};
  const target = {
    role: _compact(rawTarget.role, 32).toLowerCase(),
    name: rawTarget.name == null ? null : _compact(rawTarget.name, 160),
    label: rawTarget.label == null ? null : _compact(rawTarget.label, 160),
    ordinal: Number(rawTarget.ordinal),
    exact: rawTarget.exact !== false,
  };
  if (!target.role || (!target.name && !target.label)) {
    throw new TypeError('target must copy a role and accessible name or label from browser_inspect_page');
  }
  if (!Number.isInteger(target.ordinal) || target.ordinal < 1 || target.ordinal > 20) {
    throw new TypeError('target.ordinal must be the integer from browser_inspect_page (1–20)');
  }
  if (target.exact !== true) {
    throw new TypeError('target.exact must not be false; semantic actions use exact live-inspection matching');
  }
  /** @type {any} */
  const action = { type, target };
  if (type === 'fill') {
    if (typeof args?.value !== 'string') throw new TypeError('value is required for fill');
    action.value = args.value;
  }
  if (type === 'select') {
    if (typeof args?.option !== 'string' || !args.option.trim()) throw new TypeError('option is required for select');
    action.option = args.option;
  }
  if (type === 'toggle') {
    if (typeof args?.checked !== 'boolean') throw new TypeError('checked is required for toggle');
    action.checked = args.checked;
  }
  if (type === 'wait_for') {
    action.state = _compact(args?.state, 16).toLowerCase();
    if (!['visible', 'hidden', 'enabled', 'disabled'].includes(action.state)) {
      throw new TypeError('state is required for wait_for');
    }
    if (args?.timeoutMs != null) action.timeoutMs = Number(args.timeoutMs);
  }
  return action;
}

// Pull the registrable domain out of a URL — strips scheme, www., port,
// path. Used by browser_screenshot / browser_read_page to find site
// notes for the current page automatically.
function _domainOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

// Read the notes for a domain, returning the markdown body or null when
// no notes exist yet. Safe to call from auto-inject paths — never throws.
function _readNotes(userId, domain) {
  if (!domain) return null;
  try {
    const p = userSiteNotesPath(userId, domain);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

// Cross-cutting notes — patterns the user has shared across every site
// (general web-flow knowledge, user-wide preferences). Prepended to the
// per-domain notes so even unfamiliar domains arrive with priors.
function _readSharedNotes(userId) {
  try {
    const p = userSharedSiteNotesPath(userId);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

function _composeNotesBlock(userId, domain) {
  const shared = _readSharedNotes(userId);
  const perDomain = _readNotes(userId, domain);
  if (!shared && !perDomain && !domain) return '';
  const parts = [];
  if (shared) {
    parts.push(`## Your general patterns (apply to every site)`, shared.trim(), '');
  }
  if (perDomain) {
    parts.push(`## What you know about ${domain}`,
      'These are your own notes from prior explicit teaching sessions. Use them as priors, but trust the live page when reality differs. Updates require an active user-started Teach session on this exact origin.',
      '',
      perDomain.trim(),
      '');
  } else if (domain) {
    parts.push(`*No site notes yet for ${domain}. Notes can be created only while the user explicitly runs Teach Mode on this site.${shared ? ' Your confirmed general patterns above still apply.' : ''}*`, '');
  }
  parts.push('---', '');
  return parts.join('\n');
}

function _humanList(browsers) {
  if (!browsers.length) {
    return 'No browser extension connected. Install OE Bridge from `~/.openensemble/browser-extension/` (Load unpacked in the browser extensions page), open its popup, and use Pair this browser. Never ask the user to paste an auth token into chat.';
  }
  const lines = [`${browsers.length} connected extension(s):`];
  for (const b of browsers) {
    if (b.accessError) {
      lines.push(`- \`${b.extId}\` — ${b.name}${b.version ? ` (v${b.version})` : ''}, connected but tab access is unavailable: ${b.accessError}`);
      continue;
    }
    lines.push(`- \`${b.extId}\` — ${b.name}${b.version ? ` (v${b.version})` : ''}, ${b.tabs.length} explicitly shared tab(s)`);
    for (const t of b.tabs.slice(0, 15)) {
      const star = t.active ? '★' : ' ';
      lines.push(`    ${star} tabId=${t.tabId}  ${t.title || '(no title)'}\n      ${t.url}`);
    }
    if (b.tabs.length > 15) lines.push(`    … ${b.tabs.length - 15} more`);
  }
  return lines.join('\n');
}

async function _liveBrowsers(userId) {
  const connected = listBrowsers(userId);
  return Promise.all(connected.map(async browser => {
    try {
      const tabs = await sendCommand(userId, 'list_tabs', {}, { extId: browser.extId, timeoutMs: 5000 });
      return {
        ...browser,
        tabs: Array.isArray(tabs) ? tabs : [],
        tabCount: Array.isArray(tabs) ? tabs.length : 0,
        accessError: null,
      };
    } catch (e) {
      return { ...browser, tabs: [], tabCount: 0, accessError: e?.message || String(e) };
    }
  }));
}

async function _activeLeasedTab(userId, extId = null) {
  const browsers = await _liveBrowsers(userId);
  const browser = extId ? browsers.find(b => b.extId === extId) : browsers[0];
  return browser?.tabs?.find(t => t.active) || browser?.tabs?.[0] || null;
}

function _boundedLearningText(value, label, max, { memorySafe = false, required = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && value == null) return '';
    throw new TypeError(`${label} must be text`);
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (required && !text) throw new TypeError(`${label} is required`);
  if (text.length > max) throw new TypeError(`${label} exceeds ${max} characters`);
  if (memorySafe && text && (
    browserMemoryTextContainsSecret(text) ||
    LEARNING_PAGE_INSTRUCTION.test(text) ||
    LEARNING_RAW_URL.test(text)
  )) {
    throw new TypeError(`${label} may not contain credentials, secrets, raw URLs, or page-authored instructions`);
  }
  return text;
}

function _agentKey(agentId) {
  const value = String(agentId || 'main').trim();
  return value.slice(0, 160) || 'main';
}

function _learningLockKey(userId) {
  return `browser-learning:${String(userId)}`;
}

function _learningRunId(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 140) {
    throw new TypeError('runId is required');
  }
  return value.trim();
}

async function _resolveExtensionForTab(userId, tabId, requestedExtId = null) {
  if (!Number.isInteger(tabId) || tabId < 1) {
    throw new TypeError('tabId is required (integer from browser_list)');
  }
  const browsers = await _liveBrowsers(userId);
  if (!browsers.length) throw new Error('no browser extension is connected');
  if (requestedExtId != null) {
    const extId = _boundedLearningText(requestedExtId, 'extId', 160);
    const browser = browsers.find(item => item.extId === extId);
    if (!browser) throw new Error('the requested browser extension is no longer connected');
    if (browser.accessError) throw new Error(`the requested extension cannot enumerate its leased tabs: ${browser.accessError}`);
    if (!browser.tabs.some(tab => Number(tab?.tabId) === tabId)) {
      throw new Error('that tab is not covered by a current lease in the requested extension');
    }
    return browser;
  }
  const matches = browsers.filter(browser => (
    !browser.accessError && browser.tabs.some(tab => Number(tab?.tabId) === tabId)
  ));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error('more than one connected extension reports that tabId; pass the extId shown by browser_list');
  }
  const accessErrors = browsers.filter(browser => browser.accessError);
  if (accessErrors.length === browsers.length) {
    throw new Error(`no extension could enumerate its leased tabs: ${accessErrors[0].accessError}`);
  }
  throw new Error('that tab is not covered by a current browser lease; run browser_list again');
}

function _validatedLearningGrant(data, tabId) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.confirmed !== true) {
    throw new Error('the extension did not return a confirmed learning grant');
  }
  const runId = _learningRunId(data.runId);
  if (!/^learn_[A-Za-z0-9_]+$/.test(runId)) throw new Error('the extension returned an invalid learning run id');
  if (Number(data.tabId) !== tabId) throw new Error('the extension confirmed a different tab');
  const origin = canonicalBrowserRoutineOrigin(data.origin);
  let url;
  try { url = new URL(String(data.url || '')); }
  catch { throw new Error('the extension returned an invalid learning URL'); }
  if (url.origin !== origin) throw new Error('the extension learning URL does not match its confirmed origin');
  const confirmedAt = Number(data.confirmedAt);
  const expiresAt = Number(data.leaseExpiresAt);
  const now = Date.now();
  if (!Number.isFinite(confirmedAt) || confirmedAt > now + 5_000 ||
      !Number.isFinite(expiresAt) || expiresAt <= now ||
      expiresAt > confirmedAt + LEARNING_MAX_RUN_MS + 5_000) {
    throw new Error('the extension returned an invalid learning-run lifetime');
  }
  return {
    runId,
    tabId,
    origin,
    url: url.href,
    title: _compact(data.title, 240),
    confirmedAt,
    expiresAt,
  };
}

function _validateSnapshotForRun(snapshot, run) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('the extension returned no semantic page state');
  }
  const origin = canonicalBrowserRoutineOrigin(snapshot.origin);
  if (origin !== run.origin) throw new Error('the inspected page left the learning run origin');
  let url;
  try { url = new URL(String(snapshot.url || '')); }
  catch { throw new Error('the semantic inspection returned an invalid URL'); }
  if (url.origin !== run.origin) throw new Error('the semantic inspection URL left the learning run origin');
  return snapshot;
}

function _targetSeenInSnapshot(snapshot, target) {
  const fold = value => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const matches = (actual, wanted) => {
    if (!wanted) return true;
    return target.exact === false
      ? fold(actual).includes(fold(wanted))
      : fold(actual) === fold(wanted);
  };
  return (Array.isArray(snapshot?.controls) ? snapshot.controls : []).some(control => (
    fold(control?.role) === fold(target.role) &&
    matches(control?.name, target.name) &&
    matches(control?.label, target.label) &&
    Number(control?.ordinal) === Number(target.ordinal)
  ));
}

function _learningMutationConflict(userId, name, args) {
  const run = _activeLearningRuns.get(userId);
  if (!run || Date.now() >= Number(run.expiresAt)) return null;
  const mutationTools = new Set([
    'browser_close_tab', 'browser_back', 'browser_forward', 'browser_reload',
    'browser_click_xy', 'browser_type', 'browser_keypress', 'browser_media_control',
    'browser_routine_run',
  ]);
  if (name === 'browser_act' && args?.runId == null) mutationTools.add(name);
  if (!mutationTools.has(name)) return null;
  const requestedTabId = args?.tabId == null ? null : Number(args.tabId);
  if (requestedTabId != null && requestedTabId !== run.tabId) return null;
  return (
    `${name} cannot modify the active learning tab outside its verified semantic ledger. ` +
    `Use browser_act with runId=${run.runId}, or finish/abort that learning run first.`
  );
}

function _requestActionTemplate(action, origin) {
  /** @type {any} */
  const publicAction = { type: action.type, origin, target: action.target };
  if (action.type === 'fill') publicAction.textLength = action.value.length;
  if (action.type === 'select') publicAction.option = action.option;
  if (action.type === 'toggle') publicAction.checked = action.checked;
  if (action.type === 'wait_for') {
    publicAction.state = action.state;
    publicAction.timeoutMs = Number.isInteger(action.timeoutMs) ? action.timeoutMs : 5_000;
  }
  return templateBrowserAction(publicAction, origin);
}

function _formatPlaybookAction(action) {
  const target = JSON.stringify(action?.target || {});
  if (action?.parameter) return `${action.type} ${target} using runtime parameter “${action.parameter}”`;
  if (action?.type === 'toggle') return `${action.type} ${target} to checked=${String(action.checked)}`;
  if (action?.type === 'wait_for') return `${action.type} ${target} until ${action.state}`;
  return `${action?.type || 'action'} ${target}`;
}

function _formatPlaybooks(playbooks, { detailed = true } = {}) {
  if (!Array.isArray(playbooks) || !playbooks.length) return 'No matching learned playbooks.';
  const lines = [`${playbooks.length} learned playbook(s):`];
  for (const playbook of playbooks.slice(0, detailed ? 10 : 20)) {
    lines.push(
      `- **${_compact(playbook?.name, 100)}** — id=${_compact(playbook?.id, 100)}, origin=${_compact(playbook?.origin, 300)}, ` +
      `${Array.isArray(playbook?.transitions) ? playbook.transitions.length : 0} verified transition(s), successes=${Number(playbook?.successCount) || 0}`,
      `  Goal: ${_compact(playbook?.goal, 300)}`,
    );
    if (detailed) {
      for (const [index, transition] of (playbook?.transitions || []).slice(0, LEARNING_MAX_TRANSITIONS).entries()) {
        lines.push(
          `  ${index + 1}. ${_formatPlaybookAction(transition?.action)}`,
          `     Verify: ${JSON.stringify(transition?.assertions || {})}`,
        );
      }
      lines.push(`  Final verification: ${JSON.stringify(playbook?.finalAssertions || {})}`);
    }
  }
  return lines.join('\n').slice(0, 20_000);
}

function _formatAssertionChecks(evaluation) {
  return (evaluation?.checks || [])
    .map(check => `${check.conclusive === false ? 'UNKNOWN' : (check.passed ? 'pass' : 'FAIL')} ${check.label}${check.reason ? ` (${check.reason})` : ''}`)
    .join('; ');
}

function _cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _runtimeValuesForAction(action) {
  if (action?.type === 'fill' && typeof action.value === 'string' && action.value.trim()) return [action.value];
  if (action?.type === 'select' && typeof action.option === 'string' && action.option.trim()) return [action.option];
  return [];
}

function _decodedMemoryVariants(value) {
  const variants = new Set();
  const decodeHtml = input => String(input || '').replace(
    /&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/gi,
    (match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try { return String.fromCodePoint(codePoint); } catch { return match; }
    },
  );
  const add = input => {
    const text = String(input || '').normalize('NFKC').toLocaleLowerCase();
    if (text) variants.add(text);
  };
  add(value);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const item of [...variants]) {
      try { add(decodeURIComponent(item)); } catch {}
      if (item.includes('+')) add(item.replace(/\+/g, ' '));
      if (item.includes('&#')) add(decodeHtml(item));
    }
  }
  return [...variants];
}

function _memoryRepresentations(value) {
  const full = new Set();
  const compact = new Set();
  const tokens = new Set();
  for (const variant of _decodedMemoryVariants(value)) {
    const folded = variant.replace(/\s+/g, ' ').trim();
    if (!folded) continue;
    full.add(folded);
    const joined = folded.replace(/[^\p{L}\p{N}]+/gu, '');
    if (joined) compact.add(joined);
    for (const token of folded.match(/[\p{L}\p{N}]+/gu) || []) tokens.add(token);
  }
  return { full, compact, tokens };
}

function _runtimeEncodingSources(value) {
  const sources = new Set();
  const variants = new Set();
  const add = input => {
    const text = String(input || '').normalize('NFKC');
    if (text) variants.add(text);
  };
  add(value);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const item of [...variants]) {
      try { add(decodeURIComponent(item)); } catch {}
      if (item.includes('+')) add(item.replace(/\+/g, ' '));
    }
  }
  for (const item of [...variants]) {
    add(item.toLocaleLowerCase());
    add(item.toLocaleUpperCase());
  }
  for (const variant of variants) {
    const folded = variant.replace(/\s+/g, ' ').trim();
    if (!folded) continue;
    sources.add(folded);
    const compact = folded.replace(/[^\p{L}\p{N}]+/gu, '');
    if (compact) sources.add(compact);
  }
  return sources;
}

function _runtimeBase64Representations(value) {
  const encoded = new Set();
  const sources = _runtimeEncodingSources(value);
  for (const source of sources) {
    const base64 = Buffer.from(source, 'utf8').toString('base64').toLocaleLowerCase();
    encoded.add(base64);
    encoded.add(base64.replace(/=+$/g, ''));
    encoded.add(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''));
    encoded.add(base64.replace(/[^a-z0-9]/g, ''));
  }
  return encoded;
}

function _rfc4648Base32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = Buffer.from(value, 'utf8');
  let accumulator = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(accumulator >> bits) & 31];
    }
    accumulator &= bits ? (1 << bits) - 1 : 0;
  }
  if (bits) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output.padEnd(Math.ceil(output.length / 8) * 8, '=');
}

function _runtimeBase32Representations(value) {
  const encoded = new Set();
  for (const source of _runtimeEncodingSources(value)) {
    const base32 = _rfc4648Base32(source).toLocaleLowerCase();
    encoded.add(base32);
    encoded.add(base32.replace(/=+$/g, ''));
  }
  return encoded;
}

function _runtimeHexRepresentations(value) {
  const encoded = new Set();
  for (const source of _runtimeEncodingSources(value)) {
    encoded.add(Buffer.from(source, 'utf8').toString('hex').toLocaleLowerCase());
  }
  return encoded;
}

function _encodingSplitAcrossCandidates(encoded, candidates) {
  if (!encoded) return false;
  /** Map an encoding offset to the greatest number of distinct fields used. */
  let offsets = new Map([[0, 0]]);
  for (const represented of candidates) {
    const next = new Map(offsets);
    const pieces = new Set([
      ...represented.full,
      ...represented.compact,
      ...represented.tokens,
    ]);
    for (const [offset, fieldsUsed] of offsets) {
      for (const piece of pieces) {
        if (!piece || !encoded.startsWith(piece, offset)) continue;
        const advanced = offset + piece.length;
        const nextFieldsUsed = fieldsUsed + 1;
        if (nextFieldsUsed > (next.get(advanced) || 0)) {
          next.set(advanced, nextFieldsUsed);
        }
      }
    }
    offsets = next;
  }
  return (offsets.get(encoded.length) || 0) >= 2;
}

function _assertMemoryOmitsRuntime(value, runtimeValues, label) {
  if (!Array.isArray(runtimeValues) || !runtimeValues.length || value == null) return;
  /** @type {string[]} */
  const candidates = [];
  const visit = item => {
    if (typeof item === 'string') candidates.push(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  const candidateInputs = [
    ...candidates,
    candidates.join(' '),
    candidates.join(''),
  ];
  const candidateFull = new Set();
  const candidateCompact = new Set();
  const candidateTokens = new Set();
  const candidateFields = candidates.map(rawCandidate => _memoryRepresentations(rawCandidate));
  for (const rawCandidate of candidateInputs) {
    const represented = _memoryRepresentations(rawCandidate);
    for (const item of represented.full) candidateFull.add(item);
    for (const item of represented.compact) candidateCompact.add(item);
    for (const item of represented.tokens) candidateTokens.add(item);
  }
  for (const rawRuntime of runtimeValues) {
    const runtime = _memoryRepresentations(rawRuntime);
    const runtimeBase64 = _runtimeBase64Representations(rawRuntime);
    const runtimeBase32 = _runtimeBase32Representations(rawRuntime);
    const runtimeHex = _runtimeHexRepresentations(rawRuntime);
    const runtimeCompacts = [...runtime.compact];
    if ([...candidateFull].some(text => (
      [...runtime.full].some(runtimeText => runtimeText.length >= 3 && text.includes(runtimeText))
    ))) {
      throw new TypeError(`${label} may not persist a runtime fill or select value`);
    }
    if ([...candidateCompact].some(text => (
      runtimeCompacts.some(runtimeText => runtimeText.length >= 3 && text.includes(runtimeText))
    ))) {
      throw new TypeError(`${label} may not persist a formatted runtime fill or select value`);
    }
    for (const token of runtime.tokens) {
      if (candidateTokens.has(token)) {
        throw new TypeError(
          token.length <= 2
            ? `${label} may not persist a short runtime fill or select token`
            : `${label} may not persist a runtime fill or select token fragment`,
        );
      }
    }
    /** @type {Array<[string, Set<string>, number]>} */
    const encodedForms = [
      ['base64', runtimeBase64, 4],
      ['base32', runtimeBase32, 4],
      ['hex', runtimeHex, 6],
    ];
    for (const [kind, encodings, minimumLength] of encodedForms) {
      const matched = [...encodings].some(encoded => (
        encoded.length >= minimumLength &&
        (
          [...candidateFull, ...candidateCompact].some(text => text.includes(encoded)) ||
          _encodingSplitAcrossCandidates(encoded, candidateFields)
        )
      ));
      if (matched) {
        throw new TypeError(
          `${label} may not persist a ${kind}-encoded runtime fill or select value`,
        );
      }
    }
  }
}

function _evaluateAssertionChange(beforeSnapshot, afterSnapshot, assertions, { requireSupplied = false } = {}) {
  const after = evaluateBrowserAssertions(afterSnapshot, assertions, { requireSupplied });
  const before = evaluateBrowserAssertions(beforeSnapshot, after.assertions, { requireSupplied });
  const newlySatisfied = after.checks.length > 0 && after.checks.every((check, index) => (
    check.passed &&
    before.checks[index]?.conclusive !== false &&
    before.checks[index]?.passed === false
  ));
  return { ...after, before, newlySatisfied };
}

function _finalAssertionsComeFromVerifiedTransitions(finalAssertions, transitions) {
  const verified = new Set();
  for (const transition of transitions || []) {
    for (const [key, value] of Object.entries(transition?.assertions || {})) {
      verified.add(`${key}:${JSON.stringify(value)}`);
    }
  }
  return Object.entries(finalAssertions || {}).every(([key, value]) => (
    verified.has(`${key}:${JSON.stringify(value)}`)
  ));
}

async function _endExtensionLearningRun(userId, run) {
  try {
    await sendCommand(
      userId,
      'end_learning_run',
      { runId: run.runId },
      { extId: run.extId, timeoutMs: 5_000 },
    );
    return '';
  } catch (error) {
    return ` The extension could not clear its transient run immediately: ${error?.message || String(error)}`;
  }
}

async function _requireLearningRun(userId, agentId, runId, requestedExtId = null) {
  const id = _learningRunId(runId);
  const run = _activeLearningRuns.get(userId);
  if (!run || run.runId !== id) {
    throw new Error('no matching server learning ledger is active; start a new learning run');
  }
  if (run.agentId !== _agentKey(agentId)) {
    throw new Error('this learning run belongs to the agent that started it');
  }
  if (requestedExtId != null && String(requestedExtId).trim() !== run.extId) {
    throw new Error('this learning run is bound to a different browser extension');
  }
  if (Date.now() >= run.expiresAt) {
    _activeLearningRuns.delete(userId);
    await _endExtensionLearningRun(userId, run);
    throw new Error('the learning run expired; start a new one');
  }
  return run;
}

async function _inspectLearningRun(userId, run) {
  const rawSnapshot = await sendCommand(
    userId,
    'inspect_page',
    { tabId: run.tabId, runId: run.runId },
    { extId: run.extId, timeoutMs: 12_000 },
  );
  _validateSnapshotForRun(rawSnapshot, run);
  const inspectionId = _boundedLearningText(rawSnapshot?.inspectionId, 'inspectionId', 140);
  if (!/^inspect_[A-Za-z0-9_]+$/.test(inspectionId)) {
    throw new Error('the extension returned an invalid learning inspection proof');
  }
  const snapshot = { ...rawSnapshot };
  delete snapshot.inspectionId;
  run.latestInspection = snapshot;
  run.inspectionId = inspectionId;
  run.inspectedAt = Date.now();
  run.inspectionVersion += 1;
  return snapshot;
}

const _learningSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [userId, run] of _activeLearningRuns) {
    if (now < Number(run.expiresAt)) continue;
    _activeLearningRuns.delete(userId);
    _endExtensionLearningRun(userId, run).catch(() => {});
  }
}, 60_000);
_learningSweepTimer.unref?.();

export default async function execute(name, args, userId, agentId) {
  const learningConflict = _learningMutationConflict(userId, name, args);
  if (learningConflict) return learningConflict;

  if (name === 'browser_list') {
    return _humanList(await _liveBrowsers(userId));
  }

  if (name === 'browser_learning_start') {
    const tabId = Number(args?.tabId);
    try {
      if (!Number.isInteger(tabId) || tabId < 1) {
        throw new TypeError('tabId is required (integer from browser_list)');
      }
      const goalInput = typeof args?.goal === 'string'
        ? args.goal.replace(/\bhttps?:\/\/\S+/gi, '[site]')
        : args?.goal;
      const goal = _boundedLearningText(goalInput, 'goal', 300, { memorySafe: true });
      const playbookName = args?.name == null
        ? goal.slice(0, 100)
        : _boundedLearningText(
            typeof args.name === 'string' ? args.name.replace(/\bhttps?:\/\/\S+/gi, '[site]') : args.name,
            'name',
            100,
            { memorySafe: true },
          );
      return await withLock(_learningLockKey(userId), async () => {
        const existing = _activeLearningRuns.get(userId);
        if (existing && Date.now() < existing.expiresAt) {
          throw new Error(`learning run ${existing.runId} is already active; finish or abort it first`);
        }
        if (existing) {
          _activeLearningRuns.delete(userId);
          await _endExtensionLearningRun(userId, existing);
        }

        const browser = await _resolveExtensionForTab(userId, tabId, args?.extId);
        let grant = null;
        let startedRunId = null;
        try {
          // Server state is authoritative. A run surviving only in the
          // extension after a server restart is explicitly ended, never
          // reconstructed into a writable learning ledger.
          const orphan = await sendCommand(
            userId,
            'get_learning_run',
            {},
            { extId: browser.extId, timeoutMs: 5_000 },
          );
          if (orphan?.runId) {
            await sendCommand(
              userId,
              'end_learning_run',
              { runId: orphan.runId },
              { extId: browser.extId, timeoutMs: 5_000 },
            );
          }

          const rawGrant = await sendCommand(
            userId,
            'start_learning_run',
            { tabId, goalSummary: goal },
            { extId: browser.extId, timeoutMs: 65_000 },
          );
          if (typeof rawGrant?.runId === 'string' && rawGrant.runId.trim().length <= 140) {
            startedRunId = rawGrant.runId.trim();
          }
          grant = _validatedLearningGrant(rawGrant, tabId);
          const run = {
            ...grant,
            userId,
            agentId: _agentKey(agentId),
            extId: browser.extId,
            goal,
            name: playbookName,
            latestInspection: null,
            initialInspection: null,
            inspectionId: null,
            inspectedAt: 0,
            inspectionVersion: 0,
            pendingAction: null,
            transitions: [],
            failures: 0,
            runtimeValues: [],
            persistenceTainted: false,
          };
          const snapshot = await _inspectLearningRun(userId, run);
          run.initialInspection = _cloneJson(snapshot);
          const playbooks = listBrowserPlaybooks(userId, {
            origin: run.origin,
            goal,
            limit: 5,
          });
          _activeLearningRuns.set(userId, run);
          return [
            `Learning run confirmed: ${run.runId}`,
            `Scope: extension=${run.extId}, tabId=${run.tabId}, origin=${run.origin}, expires=${new Date(run.expiresAt).toISOString()}`,
            '',
            '## Fresh live inspection',
            _formatSemanticSnapshot(snapshot),
            '',
            '## Same-origin learned priors',
            _formatPlaybooks(playbooks),
            '',
            'Reason from the live inspection, take one semantic action, then verify it with a structured checkpoint.',
          ].join('\n');
        } catch (error) {
          if (grant?.runId || startedRunId) {
            await _endExtensionLearningRun(userId, {
              ...(grant || {}),
              runId: grant?.runId || startedRunId,
              extId: browser.extId,
            });
          }
          throw error;
        }
      });
    } catch (error) {
      return `Could not start adaptive browser learning: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_inspect_page') {
    const tabId = Number(args?.tabId);
    try {
      if (!Number.isInteger(tabId) || tabId < 1) {
        throw new TypeError('tabId is required (integer from browser_list)');
      }
      if (args?.runId != null) {
        return await withLock(_learningLockKey(userId), async () => {
          const run = await _requireLearningRun(userId, agentId, args.runId, args?.extId);
          if (run.tabId !== tabId) throw new Error('the learning run is bound to a different tab');
          const snapshot = await _inspectLearningRun(userId, run);
          return `Fresh inspection for learning run ${run.runId}:\n\n${_formatSemanticSnapshot(snapshot)}`;
        });
      }
      const browser = await _resolveExtensionForTab(userId, tabId, args?.extId);
      const snapshot = await sendCommand(
        userId,
        'inspect_page',
        { tabId },
        { extId: browser.extId, timeoutMs: 12_000 },
      );
      return _formatSemanticSnapshot(snapshot);
    } catch (error) {
      return `Failed to inspect the page: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_act') {
    const tabId = Number(args?.tabId);
    try {
      if (!Number.isInteger(tabId) || tabId < 1) {
        throw new TypeError('tabId is required (integer from browser_list)');
      }
      const expectedAssertions = normalizeBrowserAssertions(args?.expectedOutcome, { required: true });
      const action = _semanticActionFromArgs(args);
      if (args?.runId == null) {
        const browser = await _resolveExtensionForTab(userId, tabId, args?.extId);
        const data = await sendCommand(
          userId,
          'semantic_action',
          { tabId, action },
          { extId: browser.extId, timeoutMs: 65_000 },
        );
        return [
          `Performed one semantic ${action.type} action${data?.confirmed ? ' after the user allowed it once' : ''}.`,
          data?.result?.summary ? `Extension result: ${_compact(data.result.summary, 240)}` : '',
          'Inspect the page again before deciding whether it worked.',
        ].filter(Boolean).join(' ');
      }

      return await withLock(_learningLockKey(userId), async () => {
        const run = await _requireLearningRun(userId, agentId, args.runId, args?.extId);
        if (run.tabId !== tabId) throw new Error('the learning run is bound to a different tab');
        if (run.pendingAction) {
          throw new Error('the prior action still needs a success/failure checkpoint before another action');
        }
        if (!run.latestInspection || Date.now() - run.inspectedAt > LEARNING_INSPECTION_FRESH_MS) {
          throw new Error('the learning inspection is stale; inspect the page again before acting');
        }
        if (!run.inspectionId) {
          throw new Error('the latest inspection has no usable extension proof; inspect the page again');
        }
        if (action.target.exact !== true) {
          throw new Error('learning actions must copy an exact target from browser_inspect_page');
        }
        if (action.type === 'click' && ['checkbox', 'radio', 'switch', 'option'].includes(action.target.role)) {
          throw new Error('use toggle/select instead of clicking a stateful option control during learning');
        }
        if (!_targetSeenInSnapshot(run.latestInspection, action.target)) {
          throw new Error('the requested semantic target was not present in the latest learning inspection');
        }
        if (run.transitions.length >= LEARNING_MAX_TRANSITIONS) {
          throw new Error(`a learning run is limited to ${LEARNING_MAX_TRANSITIONS} verified transitions`);
        }

        const requestTemplate = _requestActionTemplate(action, run.origin);
        const runtimeValues = [...run.runtimeValues, ..._runtimeValuesForAction(action)];
        _assertMemoryOmitsRuntime(action.target, runtimeValues, 'the durable semantic target');
        _assertMemoryOmitsRuntime(expectedAssertions, runtimeValues, 'the bound expected outcome');
        const beforeExpected = evaluateBrowserAssertions(
          run.latestInspection,
          expectedAssertions,
          { requireSupplied: true },
        );
        if (beforeExpected.checks.some(check => check.conclusive === false)) {
          throw new Error(
            `the expected outcome is not conclusively false in the pre-action inspection: ${_formatAssertionChecks(beforeExpected)}`,
          );
        }
        if (beforeExpected.checks.some(check => check.passed)) {
          throw new Error(
            `every expected outcome predicate must be false before the action: ${_formatAssertionChecks(beforeExpected)}`,
          );
        }
        run.runtimeValues = runtimeValues;
        run.pendingAction = {
          startedAt: Date.now(),
          inspectionVersion: run.inspectionVersion,
          beforeInspection: _cloneJson(run.latestInspection),
          expectedAssertions: _cloneJson(expectedAssertions),
          requestTemplate,
          action: null,
          state: 'dispatching',
        };
        run.inspectedAt = 0;
        const inspectionId = run.inspectionId;
        run.inspectionId = null;
        let data;
        try {
          data = await sendCommand(
            userId,
            'semantic_action',
            { tabId, runId: run.runId, inspectionId, action },
            { extId: run.extId, timeoutMs: 65_000 },
          );
          const verifiedTemplate = templateBrowserAction(data?.semanticAction, run.origin);
          if (JSON.stringify(verifiedTemplate) !== JSON.stringify(requestTemplate)) {
            throw new Error('the extension-confirmed semantic action did not match the requested template');
          }
          run.pendingAction.action = verifiedTemplate;
          run.pendingAction.state = 'acted';
          run.pendingAction.confirmed = data?.confirmed === true;
        } catch (error) {
          run.pendingAction.state = 'uncertain';
          run.persistenceTainted = true;
          throw new Error(
            `the action did not return a trustworthy completion result (${error?.message || String(error)}). ` +
            'Inspect the page and checkpoint this attempt as failure, or abort the run; do not repeat it blindly.',
          );
        }
        return [
          `Action dispatched for learning run ${run.runId}${data?.confirmed ? ' after one-time user confirmation' : ''}.`,
          data?.result?.summary ? `Extension result: ${_compact(data.result.summary, 240)}` : '',
          `Expected outcome bound before dispatch: ${JSON.stringify(expectedAssertions)}.`,
          'Now verify the fresh page state with browser_learning_checkpoint before taking another action.',
        ].filter(Boolean).join(' ');
      });
    } catch (error) {
      return `Browser semantic action was not completed: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_learning_checkpoint') {
    try {
      const runId = _learningRunId(args?.runId);
      const outcome = String(args?.outcome || '');
      if (!['success', 'failure'].includes(outcome)) throw new TypeError('outcome must be success or failure');
      _boundedLearningText(args?.summary, 'summary', 400);
      return await withLock(_learningLockKey(userId), async () => {
        const run = await _requireLearningRun(userId, agentId, runId);
        const pending = run.pendingAction;
        if (!pending) throw new Error('there is no pending semantic action to checkpoint');
        if (outcome === 'success' && run.persistenceTainted) {
          throw new Error('this run is permanently ineligible for persistence after a rejected or uncertain verification');
        }
        try {
          const checkpointAssertions = args?.assertions == null
            ? pending.expectedAssertions
            : normalizeBrowserAssertions(args.assertions, { required: outcome === 'success' });
          if (outcome === 'success' &&
              JSON.stringify(checkpointAssertions) !== JSON.stringify(pending.expectedAssertions)) {
            throw new Error('success verification must exactly reuse the structured outcome bound before the action');
          }
          const snapshot = await _inspectLearningRun(userId, run);
          _assertMemoryOmitsRuntime(checkpointAssertions, run.runtimeValues, 'verification assertions');
          const evaluation = _evaluateAssertionChange(
            pending.beforeInspection,
            snapshot,
            checkpointAssertions,
            { requireSupplied: outcome === 'success' },
          );
          if (outcome === 'success') {
            if (pending.state !== 'acted' || !pending.action) {
              throw new Error('the extension never returned a trustworthy action result, so this attempt cannot be retained as a success');
            }
            if (!evaluation.passed) {
              throw new Error(`the structured verification did not pass: ${_formatAssertionChecks(evaluation)}`);
            }
            if (!evaluation.newlySatisfied) {
              throw new Error('every structured predicate must be conclusively false before the action and true afterward');
            }
            run.transitions.push({
              action: JSON.parse(JSON.stringify(pending.action)),
              assertions: JSON.parse(JSON.stringify(evaluation.assertions)),
            });
            run.pendingAction = null;
            return [
              `Verified transition ${run.transitions.length} for learning run ${run.runId}.`,
              `Checks: ${_formatAssertionChecks(evaluation)}.`,
              '',
              _formatSemanticSnapshot(snapshot),
            ].join('\n');
          }
          run.failures += 1;
          run.persistenceTainted = true;
          run.pendingAction = null;
          return [
            `Recorded a failed attempt in transient run state. This run can continue the task, but it is now ineligible for durable playbook persistence; abort and restart from a clean baseline to learn it.`,
            evaluation.supplied ? `Checks: ${_formatAssertionChecks(evaluation)}.` : '',
            '',
            _formatSemanticSnapshot(snapshot),
          ].filter(Boolean).join('\n');
        } catch (error) {
          if (outcome === 'success') {
            run.persistenceTainted = true;
            pending.state = 'verification_rejected';
          }
          throw error;
        }
      });
    } catch (error) {
      return `Could not checkpoint the learning action: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_learning_finish') {
    try {
      const runId = _learningRunId(args?.runId);
      const outcome = String(args?.outcome || '');
      if (!['success', 'aborted'].includes(outcome)) throw new TypeError('outcome must be success or aborted');
      _boundedLearningText(args?.summary, 'summary', 400);
      return await withLock(_learningLockKey(userId), async () => {
        const run = await _requireLearningRun(userId, agentId, runId);
        if (outcome === 'aborted') {
          _activeLearningRuns.delete(userId);
          const warning = await _endExtensionLearningRun(userId, run);
          return `Aborted learning run ${run.runId}. No playbook was saved.${warning}`;
        }
        if (run.pendingAction) throw new Error('the most recent action still needs a checkpoint');
        if (run.persistenceTainted) {
          throw new Error('a rejected verification, failed action, or uncertain action tainted this run; abort it and restart from a clean baseline before saving a playbook');
        }
        if (!run.transitions.length) throw new Error('no verified semantic transitions are available to save');
        const snapshot = await _inspectLearningRun(userId, run);
        _assertMemoryOmitsRuntime(args?.assertions, run.runtimeValues, 'final verification assertions');
        const finalEvaluation = _evaluateAssertionChange(
          run.initialInspection,
          snapshot,
          args?.assertions,
          { requireSupplied: true },
        );
        if (!finalEvaluation.passed) {
          throw new Error(`the final structured verification did not pass: ${_formatAssertionChecks(finalEvaluation)}`);
        }
        if (!finalEvaluation.newlySatisfied) {
          throw new Error('every final predicate must have been conclusively false in the initial inspection and true now');
        }
        if (!_finalAssertionsComeFromVerifiedTransitions(finalEvaluation.assertions, run.transitions)) {
          throw new Error('each final assertion must reuse a result predicate that was causally proven by a successful action checkpoint');
        }
        _assertMemoryOmitsRuntime(
          {
            name: run.name,
            goal: run.goal,
            transitions: run.transitions.map(transition => ({
              target: {
                name: transition?.action?.target?.name,
                label: transition?.action?.target?.label,
              },
              assertions: transition?.assertions,
            })),
          },
          run.runtimeValues,
          'the durable playbook',
        );
        const saved = await saveBrowserPlaybook(userId, {
          name: run.name,
          goal: run.goal,
          origin: run.origin,
          transitions: run.transitions,
          finalAssertions: finalEvaluation.assertions,
        });
        _activeLearningRuns.delete(userId);
        const warning = await _endExtensionLearningRun(userId, run);
        return (
          `Saved adaptive browser playbook “${saved.name}” (${saved.id}) with ` +
          `${saved.transitions.length} verified transition(s) for ${saved.origin}. ` +
          `It has ${saved.successCount} confirmed success(es) and remains a fallible live-planning prior.${warning}`
        );
      });
    } catch (error) {
      return `Could not finish adaptive browser learning: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_playbook_list') {
    try {
      const origin = args?.origin == null
        ? null
        : _boundedLearningText(args.origin, 'origin', 300);
      const goal = args?.goal == null
        ? ''
        : _boundedLearningText(args.goal, 'goal', 300, { required: false });
      return _formatPlaybooks(listBrowserPlaybooks(userId, { origin, goal, limit: 20 }));
    } catch (error) {
      return `Failed to list browser playbooks: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_playbook_delete') {
    try {
      const playbookId = _boundedLearningText(args?.playbookId, 'playbookId', 100);
      return await deleteBrowserPlaybook(userId, playbookId)
        ? `Deleted adaptive browser playbook ${playbookId}.`
        : `No adaptive browser playbook ${playbookId} belongs to this user.`;
    } catch (error) {
      return `Failed to delete browser playbook: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_open_tab') {
    const url = String(args?.url || '').trim();
    if (!url) return 'url is required.';
    if (!/^https?:\/\//i.test(url)) return 'url must start with http:// or https://.';
    try {
      const data = await sendCommand(userId, 'open_tab', { url }, { extId: args?.extId, timeoutMs: 65_000 });
      return `Opened ${url} in browser. tabId=${data?.tabId ?? '?'}`;
    } catch (e) {
      return `Failed to open tab: ${e?.message || String(e)}`;
    }
  }

  // Tab-level operations — all bounded to "things the user could press
  // with a keyboard shortcut" (Ctrl+W, Ctrl+Tab, Alt+Left, F5, etc.).
  // No per-site permission gate because they don't touch page content.
  if (name === 'browser_close_tab' || name === 'browser_focus_tab' ||
      name === 'browser_back' || name === 'browser_forward' ||
      name === 'browser_reload') {
    const tabId = args?.tabId != null ? Number(args.tabId) : null;
    if ((name === 'browser_close_tab' || name === 'browser_focus_tab') && !Number.isFinite(tabId)) {
      return 'tabId is required.';
    }
    const action = name.replace(/^browser_/, '');
    try {
      const data = await sendCommand(userId, action, tabId != null ? { tabId } : {}, { extId: args?.extId, timeoutMs: 5000 });
      const verbs = {
        close_tab: 'Closed tab',
        focus_tab: 'Brought tab to the front',
        back: 'Went back',
        forward: 'Went forward',
        reload: 'Reloaded the page',
      };
      const url = data?.url ? ` — ${data.url}` : '';
      return `${verbs[action] || action}${url}.`;
    } catch (e) {
      return `Failed (${action}): ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_focus_window') {
    try {
      const data = await sendCommand(userId, 'focus_window', {}, { extId: args?.extId, timeoutMs: 5000 });
      return `Brought the browser window to the front.${data?.windowId ? ` (windowId=${data.windowId})` : ''}`;
    } catch (e) {
      return `Failed to focus browser window: ${e?.message || String(e)}`;
    }
  }

  // Vision primitives — screenshot + xy-click + type + keypress. Form the
  // basis of a "look at the page like a human" loop on arbitrary sites.
  if (name === 'browser_screenshot') {
    try {
      const data = await sendCommand(userId, 'screenshot', args?.tabId != null ? { tabId: Number(args.tabId) } : {}, { extId: args?.extId, timeoutMs: 8000 });
      const png = data?.base64;
      if (!png) return 'Screenshot returned no image data — the tab may be a chrome:// page (not capturable).';
      // Persist to user's images dir so the user can review it.
      const outDir = getUserFilesDir(userId, 'images');
      mkdirSync(outDir, { recursive: true });
      const fname = `browser-screenshot-${Date.now()}.png`;
      const fpath = path.join(outDir, fname);
      writeFileSync(fpath, Buffer.from(png, 'base64'));
      const sizeKb = Math.round(png.length * 0.75 / 1024);
      // Auto-inject shared + per-domain notes. Shared notes always
      // prepend so even unfamiliar domains arrive with priors (general
      // web patterns, user-wide preferences). Per-domain comes next.
      const domain = _domainOf(data.tabUrl);
      const notesBlock = _composeNotesBlock(userId, domain);
      return {
        text: `${notesBlock}Screenshot saved (${sizeKb} KB, ${data.width}×${data.height}) at:\n  ${fpath}\n\nTab: ${data.tabTitle || '(no title)'} — ${data.tabUrl || ''}\n\nThe viewport coordinate space is 0,0 (top-left) to ${data.width},${data.height} (bottom-right). Use browser_click_xy with coordinates in that space. The screenshot itself is attached as a follow-up image — look at it to decide which (x,y) to click next.`,
        _images: [{ mediaType: 'image/png', base64: png }],
      };
    } catch (e) {
      return `Failed to screenshot: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_watch_mode') {
    const on = !!args?.on;
    if (on) {
      return 'Teach Mode must be started by the user: ask them to open the OE side panel on the page they want to teach and press “Teach this site.” The grant covers only that tab and origin for 15 minutes; do not claim it is active until browser_observe succeeds.';
    }
    try {
      await sendCommand(userId, 'set_watch_mode', { on: false }, { extId: args?.extId, timeoutMs: 5000 });
      return 'Teach Mode stopped. Its transient observation buffer was cleared.';
    } catch (e) {
      return `Failed to set watch mode: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_observe') {
    // Reject `tabId: 0` — Chrome never assigns it, so the LLM passing
    // it as a default leads to the buffer lookup missing the real tab
    // where the user actually clicked.
    const rawTabId = args?.tabId != null ? Number(args.tabId) : null;
    const tabId = (Number.isFinite(rawTabId) && rawTabId > 0) ? rawTabId : null;
    const since_ms = args?.since_ms != null ? Number(args.since_ms) : null;
    try {
      const data = await sendCommand(
        userId,
        'get_observations',
        { ...(tabId != null ? { tabId } : {}), ...(Number.isFinite(since_ms) ? { since_ms } : {}) },
        { extId: args?.extId, timeoutMs: 5000 },
      );
      const events = Array.isArray(data?.events) ? data.events : [];
      const watched = Array.isArray(data?.watchedTabs) ? data.watchedTabs : [];
      if (!data?.watchMode) {
        return 'Teach Mode is OFF — no observations are being captured. Ask the user to press “Teach this site” in the OE side panel on the exact tab they want to demonstrate.';
      }
      if (!events.length) {
        if (watched.length) {
          // We have events on OTHER tabs — Chey was looking at the wrong one.
          const summary = watched
            .map(w => `tab ${w.tabId} (${w.eventCount} event${w.eventCount === 1 ? '' : 's'})`)
            .join(', ');
          return `No events on tab ${data?.tabId ?? '?'} — the active Teach session is on: ${summary}. Read only that explicitly granted tab.`;
        }
        return `Watch mode is ON but no events captured yet — nobody has clicked / typed on any page since watch mode came on. Ask the user to demonstrate something and I'll see it. (Tab being polled: ${data?.tabId ?? 'no active tab found'}.) If you ARE seeing the orange banner on the right page, this means the page might be in an iframe or chrome:// or otherwise unscriptable.`;
      }
      const lines = [`${events.length} observation(s) on tab ${data.tabId} (most recent last):`, ''];
      for (const e of events) {
        const ago = Math.max(0, Math.round((Date.now() - e.recvTs) / 1000));
        const el = e.element || {};
        const elDesc = `<${el.tag || '?'}${el.id ? '#'+el.id : ''}${el.class ? '.'+el.class : ''}>${el.text ? ` "${el.text}"` : ''}${el.placeholder ? ` placeholder="${el.placeholder}"` : ''}${el.ariaLabel ? ` aria-label="${el.ariaLabel}"` : ''}`;
        if (e.kind === 'click') {
          lines.push(`- ${ago}s ago: **clicked** ${elDesc}`);
        } else if (e.kind === 'input') {
          lines.push(`- ${ago}s ago: **typed** into ${elDesc} → ${e.value == null ? '[sensitive — value redacted]' : `"${e.value}"`}`);
        } else if (e.kind === 'change') {
          lines.push(`- ${ago}s ago: **changed** ${elDesc} → ${e.checked != null ? `checked=${e.checked}` : `value="${e.value || ''}"`}`);
        } else if (e.kind === 'submit') {
          lines.push(`- ${ago}s ago: **submitted** ${elDesc}`);
        }
        if (el.selector) lines.push(`    selector: ${el.selector}`);
      }
      return lines.join('\n');
    } catch (e) {
      return `Failed to read observations: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_routine_create_from_teach') {
    const routineName = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!routineName) return 'name is required.';
    const rawTabId = args?.tabId != null ? Number(args.tabId) : null;
    const tabId = Number.isInteger(rawTabId) && rawTabId > 0 ? rawTabId : null;
    try {
      const data = await sendCommand(
        userId,
        'get_observations',
        { ...(tabId == null ? {} : { tabId }), limit: 200 },
        { extId: args?.extId, timeoutMs: 5000 },
      );
      if (!data?.watchMode) {
        return 'Teach Mode is not active. Ask the user to press “Teach this site,” demonstrate the routine, then ask to save it.';
      }
      if (!data?.teach?.origin || !data?.teach?.url || Number(data?.teach?.tabId) !== Number(data?.tabId)) {
        return 'Teach Mode did not return an exact active tab/origin scope, so nothing was saved. Reload the updated OE Bridge and try again.';
      }
      const saved = await saveBrowserRoutineFromTeachEvents(userId, {
        name: routineName,
        description: typeof args?.description === 'string' ? args.description : '',
        events: Array.isArray(data?.events) ? data.events : [],
        origin: data.teach.origin,
      });
      import('../../lib/browser-attention.mjs')
        .then(({ recordBrowserAttention }) => recordBrowserAttention(userId, {
          action: 'teach', domains: [saved.routine.origin], sharedProfile: false,
        }))
        .catch(() => {});
      let stopWarning = '';
      try {
        await sendCommand(userId, 'set_watch_mode', { on: false }, { extId: args?.extId, timeoutMs: 5000 });
      } catch (error) {
        stopWarning = ` Teach Mode could not be stopped automatically: ${error?.message || String(error)}`;
      }
      const warnings = saved.warnings.length ? ` Omitted/adjusted: ${saved.warnings.join(' ')}` : '';
      return `Saved browser routine “${saved.routine.name}” (${saved.routine.id}) with ${saved.routine.steps.length} semantic step(s), bound to ${saved.routine.origin}. Risk: ${saved.routine.risk.level}. Replay still requires a live lease; consequential steps ask for confirmation.${warnings}${stopWarning}`;
    } catch (error) {
      return `Failed to create browser routine: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_routine_list') {
    try {
      const routines = listBrowserRoutines(userId);
      if (!routines.length) return 'No taught browser routines yet.';
      return [
        `${routines.length} taught browser routine(s):`,
        ...routines.map(routine =>
          `- ${routine.name} — id=${routine.id}, origin=${routine.origin}, ${routine.steps.length} step(s), risk=${routine.risk.level}`),
      ].join('\n');
    } catch (error) {
      return `Failed to list browser routines: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_routine_delete') {
    const routineId = typeof args?.routineId === 'string' ? args.routineId.trim() : '';
    if (!routineId) return 'routineId is required.';
    try {
      return await deleteBrowserRoutine(userId, routineId)
        ? `Deleted browser routine ${routineId}.`
        : `No browser routine ${routineId} belongs to this user.`;
    } catch (error) {
      return `Failed to delete browser routine: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_routine_run') {
    const routineId = typeof args?.routineId === 'string' ? args.routineId.trim() : '';
    const tabId = Number(args?.tabId);
    if (!routineId) return 'routineId is required.';
    if (!Number.isInteger(tabId) || tabId < 1) return 'tabId is required (integer from browser_list).';
    try {
      const result = await replayBrowserRoutine(userId, routineId, {
        tabId,
        command: (action, commandArgs, options = {}) => sendCommand(
          userId,
          action,
          commandArgs,
          { extId: args?.extId, timeoutMs: options.timeoutMs },
        ),
      });
      return `Completed browser routine “${result.name}” on tab ${result.tabId}: ${result.completedSteps} step(s). Consequential steps, if any, were confirmed individually by the user.`;
    } catch (error) {
      return `Browser routine did not complete: ${error?.message || String(error)}`;
    }
  }

  // Site-notes tools — Sydney's institutional memory of how each
  // website works. Markdown free-form, NOT step-by-step recipes.
  if (name === 'browser_site_notes_read') {
    let domain = args?.domain ? String(args.domain).trim() : null;
    if (domain === '_shared' || domain === '*') {
      const shared = _readSharedNotes(userId);
      return shared
        ? `# Your general / cross-site patterns\n\n${shared}`
        : 'No shared notes yet. Cross-site preferences must be stated and confirmed in normal OE chat; browser agents cannot write them.';
    }
    if (!domain) {
      const activeTab = await _activeLeasedTab(userId, args?.extId);
      domain = _domainOf(activeTab?.url);
    }
    if (!domain) return 'No domain specified, and no active tab to infer from. Pass `domain: "<example.com>"` (or `"_shared"` for the cross-cutting file).';
    const notes = _readNotes(userId, domain);
    if (!notes) return `No site notes for ${domain} yet. The user can start Teach Mode on that exact site before notes are written.`;
    return `# Site notes for ${domain}\n\n${notes}`;
  }

  if (name === 'browser_site_notes_write') {
    let domain = args?.domain ? String(args.domain).trim() : null;
    const content = typeof args?.content === 'string' ? args.content : '';
    const mode = args?.mode === 'append' ? 'append' : 'replace';
    if (!content.trim()) return 'content is required (free-form markdown).';
    if (content.length > MAX_SITE_NOTE_WRITE) return `Site-note updates are limited to ${MAX_SITE_NOTE_WRITE} characters.`;
    if (domain === '_shared' || domain === '*') {
      return 'Cross-site notes require a separate explicit confirmation and cannot be written from a browser agent turn. Ask the user to state the preference in normal OE chat instead.';
    }
    try {
      // Persistence is allowed only while the extension proves a live,
      // UI-minted, exact-origin Teach grant. The domain comes from Chrome's
      // authenticated tab metadata—not page text or an LLM-supplied URL.
      const observed = await sendCommand(userId, 'get_observations', {}, {
        extId: args?.extId, timeoutMs: 5_000,
      });
      if (!observed?.watchMode || !observed?.teach?.origin || !observed?.teach?.url) {
        return 'Site notes can be saved only during an active “Teach this site” session.';
      }
      const taughtDomain = _domainOf(observed.teach.url);
      if (!taughtDomain || new URL(observed.teach.url).origin !== observed.teach.origin) {
        return 'Teach Mode did not provide a valid exact-origin scope; no notes were saved.';
      }
      if (domain) {
        const requested = _domainOf(domain.includes('://') ? domain : `https://${domain}`);
        if (!requested || requested !== taughtDomain) {
          return `Teach Mode is scoped to ${taughtDomain}; it cannot write notes for another site.`;
        }
      }
      domain = taughtDomain;
      const p = userSiteNotesPath(userId, domain);
      mkdirSync(userSiteNotesDir(userId), { recursive: true });
      let next;
      if (mode === 'append' && existsSync(p)) {
        const existing = readFileSync(p, 'utf8').replace(/\n+$/, '');
        const sep = existing ? '\n\n' : '';
        next = `${existing}${sep}${content.trim()}\n`;
      } else {
        next = content.trim() + '\n';
      }
      if (Buffer.byteLength(next) > MAX_SITE_NOTES_FILE) {
        return `Site notes for ${domain} are at the ${MAX_SITE_NOTES_FILE}-byte limit; shorten or replace them before adding more.`;
      }
      atomicWriteSync(p, next, { mode: 0o600 });
      const size = statSync(p).size;
      return `${mode === 'append' ? 'Appended to' : 'Wrote'} site notes for ${domain} (${size} bytes total) from the active Teach session.`;
    } catch (e) {
      return `Failed to write notes: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_site_notes_list') {
    const dir = userSiteNotesDir(userId);
    if (!existsSync(dir)) return 'No site notes yet.';
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    if (!files.length) return 'No site notes yet.';
    const lines = [];
    // Shared notes first if present, with a special label.
    const sharedFile = files.find(f => f === '_shared.md');
    const perDomainFiles = files.filter(f => f !== '_shared.md');
    if (sharedFile) {
      const full = path.join(dir, sharedFile);
      try {
        const stat = statSync(full);
        const txt = readFileSync(full, 'utf8').slice(0, 200).replace(/\s+/g, ' ').trim();
        lines.push(`**Shared / cross-site** — ${stat.size} bytes, updated ${new Date(stat.mtimeMs).toLocaleDateString()}: "${txt.slice(0, 120)}${txt.length > 120 ? '…' : ''}"`);
        lines.push('');
      } catch { /* unreadable — skip */ }
    }
    if (perDomainFiles.length) {
      lines.push('Sites you have notes for:');
      for (const f of perDomainFiles) {
        const domain = f.replace(/\.md$/, '');
        const full = path.join(dir, f);
        try {
          const stat = statSync(full);
          const txt = readFileSync(full, 'utf8').slice(0, 200).replace(/\s+/g, ' ').trim();
          lines.push(`- **${domain}** — ${stat.size} bytes, updated ${new Date(stat.mtimeMs).toLocaleDateString()}: "${txt.slice(0, 120)}${txt.length > 120 ? '…' : ''}"`);
        } catch { /* unreadable — skip */ }
      }
    } else if (!sharedFile) {
      lines.push('No site notes yet.');
    }
    return lines.join('\n');
  }

  if (name === 'browser_click_xy') {
    const tabId = Number(args?.tabId);
    const x = Number(args?.x);
    const y = Number(args?.y);
    if (!Number.isFinite(tabId) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return 'tabId, x, y are all required and must be integers.';
    }
    try {
      const data = await sendCommand(userId, 'click_xy', { tabId, x, y }, { extId: args?.extId, timeoutMs: 65_000 });
      const what = data?.elementSummary ? ` on ${data.elementSummary}` : '';
      return `Clicked at (${x}, ${y})${what}. Take another screenshot if you need to verify the result.`;
    } catch (e) {
      return `Failed to click at (${x}, ${y}): ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_type') {
    const tabId = Number(args?.tabId);
    const text = typeof args?.text === 'string' ? args.text : null;
    if (!Number.isFinite(tabId)) return 'tabId is required.';
    if (text == null) return 'text is required.';
    try {
      const data = await sendCommand(userId, 'type', { tabId, text }, { extId: args?.extId, timeoutMs: 8000 });
      const what = data?.elementSummary ? ` into ${data.elementSummary}` : '';
      return `Typed ${text.length} character(s)${what}. This did not submit the form; submission requires a separate explicit confirmation.`;
    } catch (e) {
      return `Failed to type: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_keypress') {
    const tabId = Number(args?.tabId);
    const key = String(args?.key || '').trim();
    if (!Number.isFinite(tabId)) return 'tabId is required.';
    if (!key) return 'key is required.';
    if (/^(enter|numpadenter|space|spacebar)$/i.test(key)) {
      return `${key} can submit a form or trigger an application action, so OE will not send it without per-use confirmation. Ask the user to press it themselves.`;
    }
    try {
      const data = await sendCommand(userId, 'keypress', { tabId, key }, { extId: args?.extId, timeoutMs: 5000 });
      return `Sent ${key} keypress${data?.elementSummary ? ` to ${data.elementSummary}` : ''}.`;
    } catch (e) {
      return `Failed to send ${key}: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_media_control') {
    const action = String(args?.action || '').trim().toLowerCase();
    if (!['next', 'previous', 'playpause'].includes(action)) {
      return 'action must be one of: next, previous, playpause.';
    }
    try {
      const data = await sendCommand(userId, 'media_control', { action }, { extId: args?.extId, timeoutMs: 65_000 });
      const where = data?.matchedHost ? `on ${data.matchedHost}` : (data?.tabUrl ? `on ${new URL(data.tabUrl).host}` : 'in the active tab');
      const verb = action === 'next' ? 'Skipped' : action === 'previous' ? 'Back' : 'Toggled play/pause';
      return `${verb} ${where}.${data?.method ? ` (via ${data.method})` : ''}`;
    } catch (e) {
      return `Failed to control media: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_read_page') {
    const tabId = Number(args?.tabId);
    if (!Number.isFinite(tabId)) return 'tabId is required (integer from browser_list).';
    try {
      const data = await sendCommand(userId, 'read_page', { tabId }, { extId: args?.extId, timeoutMs: 12_000 });
      const text = String(data?.text || '').slice(0, 8000);
      const trunc = (data?.text || '').length > text.length ? `\n…[truncated, ${(data?.text || '').length - text.length} more chars]` : '';
      const links = Array.isArray(data?.links) ? data.links.slice(0, 30) : [];
      const jsonLd = Array.isArray(data?.jsonLd) ? data.jsonLd.slice(0, 5) : [];
      const domain = _domainOf(data?.url);
      const notesBlock = _composeNotesBlock(userId, domain);
      const out = [];
      if (notesBlock) out.push(notesBlock);
      out.push(
        `**${data?.title || '(no title)'}**`,
        `URL: ${data?.url}`,
        '',
        '## Text',
        text + trunc,
      );
      if (links.length) {
        out.push('', '## Links');
        for (const l of links) out.push(`- [${(l.text || '').slice(0, 80)}](${l.href})`);
      }
      if (jsonLd.length) {
        out.push('', '## Structured data (JSON-LD)');
        for (const d of jsonLd) out.push('```json\n' + JSON.stringify(d, null, 2).slice(0, 2000) + '\n```');
      }
      return out.join('\n');
    } catch (e) {
      return `Failed to read page: ${e?.message || String(e)}`;
    }
  }

  return `Unknown tool: ${name}`;
}

export const executeSkillTool = execute;
