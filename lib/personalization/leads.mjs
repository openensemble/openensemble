// @ts-check
/**
 * Open leads — one-shot follow-ups on unmet questions ("I'll check X and let
 * you know"). Registered either live via ctx.registerLead (lead-helper.mjs)
 * or by nightly reflection's open_leads output (reflect.mjs). The 15-min
 * lead-sweep builtin (lead-runner.mjs) re-checks them INLINE — leads never
 * spawn scheduler tasks (a scheduled run can't create one; see ADDENDUM A).
 *
 * Storage: users/<uid>/personalization/leads.json
 *   { version, updated_at, leads: [Lead, ...] }
 * Lead: { id, query, toolName, args, skillId, agentId, createdAt, nextCheckAt,
 *         checksLeft, cadenceHint, status, lastResult, originObsId,
 *         pendingNotify?, notifyAfter?, notifiedAt?, hitAt?, expiredAt? }
 * (agentId + the notify-bookkeeping fields are additive beyond the spec's
 * base Lead schema — needed so lead-runner can re-invoke the right tool
 * context and track quiet-hours/budget-held hit deliveries.)
 *
 * Query/args/result summaries may contain personal content.  The file and
 * containing directory are therefore tightened to 0600/0700 and writes are
 * atomic with version + updated_at per the voice-config.mjs convention.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { USERS_DIR } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';
import { isDestructiveTool, isSensitiveArgName } from '../learning-safety.mjs';

// Config defaults mirrored from the master spec's config.json schema. Reads
// fail closed for NEW tracking: without a readable config we cannot verify
// consent/the master switch. Existing lead reads remain available for repair
// and dismissal.
const CONFIG_DEFAULTS = { maxOpenLeads: 8, leadChecksDefault: 2 };
const DEFAULT_CLAIM_LEASE_MS = 10 * 60_000;
const MAX_CHECK_HISTORY = 20;
const MAX_LEAD_ARGS_BYTES = 8_000;
const MAX_TERMINAL_LEADS = 200;
const MAX_LEAD_CHECKS = 20;
const MAX_CONSECUTIVE_DEFERS = 3;
const MAX_NEXT_CHECK_AHEAD_MS = 90 * 24 * 60 * 60_000;
const MAX_EXPIRES_AHEAD_MS = 365 * 24 * 60 * 60_000;
const SCHEDULE_PAST_GRACE_MS = 5 * 60_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EXTRA_SENSITIVE_KEY_RE = /credential|cookie|private[_.-]?key|client[_.-]?secret|session[_.-]?(?:id|key)|csrf/i;
const CREDENTIAL_VALUE_RES = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
  /\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)=[^\s&]{4,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

async function _safeConfig(userId) {
  try {
    const { getConfig } = await import('./config.mjs');
    const cfg = await getConfig(userId);
    return { ...CONFIG_DEFAULTS, ...cfg };
  } catch (e) {
    console.warn(`[personalization] leads: config unavailable, refusing new background tracking (${e.message})`);
    return { ...CONFIG_DEFAULTS, enabled: false, setupComplete: false, _unavailable: true };
  }
}

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}
function leadsPath(userId) {
  return path.join(personalizationDir(userId), 'leads.json');
}

function _readFile(userId, { strict = false } = {}) {
  const p = leadsPath(userId);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.leads)) {
      throw new Error('invalid leads envelope');
    }
    return {
      version: Number.isInteger(data.version) ? data.version : 0,
      leads: Array.isArray(data.leads) ? data.leads : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[personalization] leads.json read failed for ${userId}: ${e.message}`);
      if (strict) throw new Error(`Personalization leads are unreadable: ${e.message}`);
    }
    return { version: 0, leads: [] };
  }
}

function _writeFile(userId, prevVersion, leads) {
  const dir = personalizationDir(userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  // Open/pending work is never evicted. Keep a bounded audit tail for rows
  // that can no longer execute or notify so leads.json cannot grow forever.
  const terminal = leads.filter(lead => lead?.status === 'dismissed'
    || lead?.status === 'expired'
    || (lead?.status === 'hit' && !lead.pendingNotify));
  terminal.sort((a, b) => {
    const at = Date.parse(a.notifiedAt || a.dismissedAt || a.expiredAt || a.hitAt || a.lastCheckedAt || a.createdAt || '');
    const bt = Date.parse(b.notifiedAt || b.dismissedAt || b.expiredAt || b.hitAt || b.lastCheckedAt || b.createdAt || '');
    return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0);
  });
  const keptTerminal = new Set(terminal.slice(-MAX_TERMINAL_LEADS));
  const bounded = leads.filter(lead => !terminal.includes(lead) || keptTerminal.has(lead));
  const data = { version: (prevVersion || 0) + 1, updated_at: Date.now(), leads: bounded };
  atomicWriteSync(leadsPath(userId), JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(leadsPath(userId), 0o600); } catch { /* best effort */ }
}

function validDateIso(value) {
  if (typeof value !== 'string' && !(value instanceof Date) && typeof value !== 'number') return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeJsonObject(value, { maxBytes = MAX_LEAD_ARGS_BYTES } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json, 'utf8') > maxBytes) return null;
    const parsed = JSON.parse(json);
    const stack = [{ value: parsed, depth: 0 }];
    while (stack.length) {
      const current = stack.pop();
      if (current.depth > 6) return null;
      if (Array.isArray(current.value)) {
        if (current.value.length > 50) return null;
        for (const child of current.value) {
          if (child && typeof child === 'object') stack.push({ value: child, depth: current.depth + 1 });
        }
        continue;
      }
      if (!current.value || typeof current.value !== 'object') continue;
      const entries = Object.entries(current.value);
      if (entries.length > 50 || entries.some(([key]) => DANGEROUS_KEYS.has(key))) return null;
      for (const [, child] of entries) {
        if (child && typeof child === 'object') stack.push({ value: child, depth: current.depth + 1 });
      }
    }
    return parsed;
  } catch { return null; }
}

/** True when replay args contain credential-bearing keys or values. */
export function hasSensitiveReplayArgs(value) {
  if (!value || typeof value !== 'object') return false;
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const child of current) {
        if (child && typeof child === 'object') stack.push(child);
        else if (typeof child === 'string' && CREDENTIAL_VALUE_RES.some(re => re.test(child))) return true;
      }
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (isSensitiveArgName(key) || EXTRA_SENSITIVE_KEY_RE.test(key)) return true;
      if (child && typeof child === 'object') stack.push(child);
      else if (typeof child === 'string' && CREDENTIAL_VALUE_RES.some(re => re.test(child))) return true;
    }
  }
  return false;
}

function hasCredentialText(value) {
  return typeof value === 'string' && CREDENTIAL_VALUE_RES.some(re => re.test(value));
}

/** Credential guard for every plaintext/model-bound lead field. */
export function hasSensitiveLeadContent({ query = '', condition = null, dedupKey = '' } = {}) {
  return hasCredentialText(query)
    || hasCredentialText(dedupKey)
    || (typeof condition === 'string' ? hasCredentialText(condition) : hasSensitiveReplayArgs(condition));
}

function normalizeCondition(value) {
  if (typeof value === 'string' && value.trim()) return { type: 'description', text: value.trim().slice(0, 300) };
  // Bound arbitrary skill metadata while retaining additive structured
  // conditions for newer callers.
  return normalizeJsonObject(value, { maxBytes: 2_000 });
}

function transitionResult(lead, applied) {
  return lead ? { ...lead, transitionApplied: applied } : null;
}

function claimMatches(lead, claimToken) {
  return !claimToken || lead.claimToken === claimToken;
}

function clearClaim(lead) {
  lead.claimToken = null;
  lead.claimedAt = null;
  lead.claimExpiresAt = null;
}

// ── query similarity (dedupe) ────────────────────────────────────────────────

function normalizeQuery(q) {
  return String(q || '').toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

// Cheap lexical similarity — no embeddings available at this layer. Exact
// match after normalization, substring containment, or high word-overlap
// (Jaccard) all count as "the same open question" for dedupe purposes.
function querySimilar(a, b) {
  const na = normalizeQuery(a), nb = normalizeQuery(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length > 6 && nb.length > 6 && (na.includes(nb) || nb.includes(na))) return true;
  const wa = new Set(na.split(' ')), wb = new Set(nb.split(' '));
  const inter = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && inter / union >= 0.6;
}

// ── mutating-tool guard ──────────────────────────────────────────────────────
//
// open_leads exist to re-invoke a READ-ONLY data-fetch tool later ("check
// again whether X changed") — never to auto-fire something that mutates
// state (that's what ask-first offers are for). This is the first of two
// layers of defense-in-depth (the second lives in lead-runner.mjs, right
// before a stored lead's tool is actually invoked) against a prompt that
// mis-generates leads shaped like offers, e.g. {toolName:'set_reminder'}.
const MUTATING_TOOL_RE = /^(set_|schedule_|send_|create_|make_|add_|delete_|remove_|cancel_|update_|write_|post_|email_|purge_)/i;
const MUTATING_TOOL_DENYLIST = new Set([
  'set_reminder', 'schedule_task', 'email_compose', 'send_telegram_message', 'remember_fact', 'forget_fact',
]);

/** True if `toolName` looks like it mutates state / sends something, rather than a read-only fetch. Null/empty is never mutating (it just means "no tool"). */
export function isMutatingToolName(toolName) {
  if (!toolName || typeof toolName !== 'string') return false;
  return MUTATING_TOOL_RE.test(toolName) || MUTATING_TOOL_DENYLIST.has(toolName);
}

// ── lead-eligible tool guard ─────────────────────────────────────────────────
//
// isMutatingToolName above is a NAME-SHAPE blocklist — it catches a tool that
// ANNOUNCES a mutation (set_/send_/create_/...), but is blind to a tool that
// mutates state, shells out, or dispatches an op under an innocuous-looking
// name — e.g. `node_exec`, `coder_run_command`, `desktop_run_command` (see
// roles.mjs:91; roles.mjs:1435 calls out node_exec as destructive). A
// reflection-LLM-authored lead {toolName:'node_exec', args:{...}} would sail
// straight through the blocklist and get invoked, unattended, on every
// 15-minute sweep. isLeadEligibleTool flips this to a POSITIVE list: a tool
// is eligible only if it's both not-mutating/not-destructive-by-name AND
// explicitly known-safe — a builtin pure-read lookup, or a skill tool whose
// OWN manifest opts it in via `readOnly: true` (see skills/SKILL_BLUEPRINT.md).
// Fails closed on any doubt: no skillId, an unresolved/erroring manifest
// lookup, or the tool missing from the skill's own tools array are all
// treated as "not eligible", never as "assume it's fine".
const READONLY_LEAD_TOOLS = new Set([
  // Web lookups
  'web_search',
  // Calendar reads (skills/gcal)
  'gcal_list', 'gcal_get', 'calendar_snapshot', 'gcal_list_calendars',
  // Home Assistant state reads (skills/role_home_assistant)
  'ha_get_state', 'ha_list_devices', 'ha_list_areas', 'ha_list_services',
  // Scheduler read-backs (skills/tasks) — status lookups only; the
  // mutating counterparts (set_reminder, schedule_task, create_watch,
  // update_watch, cancel_watch, delete_task, cancel_reminder, ...) are all
  // already caught by isMutatingToolName above and would never reach here.
  // autonomy_status is deliberately NOT listed despite reading like a status
  // lookup: it calls listUserProposals(), which wakes elapsed snoozed
  // proposals and can flip policy-failed ones to 'failed' with disk writes —
  // not side-effect-free, so not safe for an unattended sweep.
  'list_tasks', 'list_reminders', 'list_watches', 'list_watch_items',
]);
// No builtin weather tool is listed here — there is no global weather skill
// in this codebase (only a one-off per-user custom skill), so hardcoding a
// name would be guessing at something that isn't guaranteed to exist, or to
// mean the same thing, for every user. `fetch_url` is deliberately excluded
// too: an arbitrary unattended GET can still have a real side effect (a
// webhook, a one-click unsubscribe/action link), so "it's a read" isn't a
// strong enough guarantee the way it is for a fixed, purpose-built lookup.

/**
 * True if `toolName` is safe for the lead sweep to invoke completely
 * unattended: not mutating (isMutatingToolName), not destructive-by-name
 * (learning-safety.mjs's isDestructiveTool — same shared classifier the rest
 * of OE's learning loops use), and explicitly allowed — either a builtin
 * read-only lookup (READONLY_LEAD_TOOLS above), or, given a resolvable
 * skillId, the owning skill's own manifest.tools entry for this exact tool
 * name has `readOnly: true`. Async because the skill-manifest path needs a
 * dynamic import of roles.mjs — see lead-helper.mjs's registerLead for the
 * same pattern and the cycle-avoidance rationale (roles.mjs transitively
 * loads this module, so a static import here would cycle).
 *
 * A null/empty toolName is never "eligible" by this function. New tool-less
 * leads are rejected; the runner expires legacy rows without invoking them.
 * @param {string} toolName
 * @param {{skillId?: string|null, userId?: string}} [opts]
 */
export async function isLeadEligibleTool(toolName, { skillId, userId } = {}) {
  if (!toolName || typeof toolName !== 'string') return false;
  if (isMutatingToolName(toolName)) return false;
  if (isDestructiveTool(toolName)) return false;
  if (READONLY_LEAD_TOOLS.has(toolName)) return true;
  if (!skillId) return false; // fail closed — no manifest to consult
  try {
    const { getRoleManifest } = await import('../../roles.mjs');
    const tools = getRoleManifest(skillId, userId)?.tools;
    const def = Array.isArray(tools) ? tools.find(t => t?.function?.name === toolName) : null;
    return def?.readOnly === true;
  } catch (e) {
    console.warn(`[personalization] isLeadEligibleTool: manifest lookup failed for ${skillId}/${toolName}: ${e.message}`);
    return false; // fail closed
  }
}

// ── refresh cadence parsing ──────────────────────────────────────────────────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ALIASES = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
// No hour granularity in the 'weekly:<day>' / 'daily' cadence syntax — 9am
// local is the "morning check-in" default for both.
const DEFAULT_CHECK_HOUR = 9;

/**
 * Parses "weekly:<day>" | "daily" | "hourly" into a structured cadence.
 * Returns null for anything else (caller falls back to a sane default).
 */
export function parseRefreshCadence(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'daily') return { kind: 'daily' };
  if (s === 'hourly') return { kind: 'hourly' };
  const m = s.match(/^weekly:([a-z]+)$/);
  if (m) {
    const token = m[1];
    const day = DAY_NAMES.includes(token) ? token
      : (DAY_ALIASES[token] !== undefined ? DAY_NAMES[DAY_ALIASES[token]] : null);
    if (!day) return null;
    return { kind: 'weekly', day };
  }
  return null;
}

/** Computes the next ISO check time for a parsed cadence, relative to `now`. */
export function nextCheckFromCadence(cadence, now, timezone = null) {
  const base = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const c = (cadence && cadence.kind) ? cadence : { kind: 'daily' };

  if (c.kind === 'hourly') {
    return new Date(base.getTime() + 60 * 60 * 1000).toISOString();
  }

  const hour = Number.isFinite(c.hour) ? c.hour : DEFAULT_CHECK_HOUR;
  if (timezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      const startMs = Math.floor(base.getTime() / 60_000) * 60_000 + 60_000;
      // Search wall-clock minutes so half/quarter-hour offsets and DST changes
      // are handled by the platform timezone database rather than hand math.
      for (let i = 0; i < 8 * 24 * 60; i++) {
        const candidate = new Date(startMs + i * 60_000);
        const parts = Object.fromEntries(fmt.formatToParts(candidate).map(part => [part.type, part.value]));
        const weekday = String(parts.weekday || '').toLowerCase();
        if (Number(parts.hour) === hour && Number(parts.minute) === 0
          && (c.kind !== 'weekly' || weekday === c.day)) {
          return candidate.toISOString();
        }
      }
    } catch {
      // Invalid/missing timezone falls back to server-local cadence below.
    }
  }
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  if (next <= base) next.setDate(next.getDate() + 1);

  if (c.kind === 'weekly') {
    const targetIdx = DAY_NAMES.indexOf(c.day);
    if (targetIdx >= 0) {
      while (next.getDay() !== targetIdx) next.setDate(next.getDate() + 1);
    }
    return next.toISOString();
  }

  // 'daily' (or an unrecognized kind — fall back to the same daily math so a
  // bad cadence value can't spin the sweep every tick).
  return next.toISOString();
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Registers a new open lead. Dedupes against existing ACTIVE leads with the
 * same toolName + a similar query (returns {deduped:true, existing}) and
 * enforces config.maxOpenLeads (returns {deduped:true, capped:true} when
 * full — the caller decides how to phrase that to the user). Rejects a
 * toolName that isn't lead-eligible outright — {rejected:'mutating-tool'}
 * when the name itself looks like a mutation/notification (isMutatingToolName),
 * or {rejected:'not-lead-eligible'} when it isn't mutating by name but still
 * isn't a known-safe read-only tool (see isLeadEligibleTool above — this is
 * what catches something like `node_exec`, which no name-shape blocklist
 * would ever flag). A null toolName is rejected: without a re-check operation
 * it could never hit or expire and would permanently consume the open-lead cap.
 */
export async function addLead(userId, leadPartial) {
  if (!userId) throw new Error('addLead: userId required');
  if (!leadPartial || typeof leadPartial !== 'object' || typeof leadPartial.query !== 'string' || !leadPartial.query.trim()) {
    throw new Error('addLead: leadPartial.query required');
  }
  if (!leadPartial.toolName || typeof leadPartial.toolName !== 'string') {
    console.warn('[personalization] rejected tool-less lead (no re-check is possible)');
    return { rejected: 'missing-tool' };
  }
  if (isMutatingToolName(leadPartial.toolName)) {
    console.warn(`[personalization] rejected lead with mutating tool: ${leadPartial.toolName}`);
    return { rejected: 'mutating-tool' };
  }
  if (leadPartial.toolName && !(await isLeadEligibleTool(leadPartial.toolName, { skillId: leadPartial.skillId, userId }))) {
    console.warn(`[personalization] rejected lead with a tool that isn't lead-eligible (not on the read-only allowlist / skill manifest): ${leadPartial.toolName}`);
    return { rejected: 'not-lead-eligible' };
  }
  const args = leadPartial.args == null ? {} : normalizeJsonObject(leadPartial.args);
  if (!args) {
    console.warn('[personalization] rejected lead with invalid or oversized replay arguments');
    return { rejected: 'invalid-args' };
  }
  if (hasSensitiveReplayArgs(args)) {
    console.warn('[personalization] rejected lead with credential-bearing replay arguments');
    return { rejected: 'sensitive-args' };
  }
  if (hasSensitiveLeadContent(leadPartial)) {
    console.warn('[personalization] rejected lead with credential-bearing plaintext content');
    return { rejected: 'sensitive-content' };
  }
  const cfg = await _safeConfig(userId);
  if (cfg.enabled === false || cfg.setupComplete === false) {
    return { rejected: 'personalization-disabled' };
  }
  if (cfg.model === 'off') return { rejected: 'personalization-model-off' };
  return withLock(leadsPath(userId), async () => {
    const file = _readFile(userId, { strict: true });
    const active = file.leads.filter(l => l.status === 'active');

    const lockedCfg = await _safeConfig(userId);
    if (lockedCfg.enabled !== true || lockedCfg.setupComplete !== true) {
      return { rejected: 'personalization-disabled' };
    }
    if (lockedCfg.model === 'off') return { rejected: 'personalization-model-off' };

    const requestedDedupKey = typeof leadPartial.dedupKey === 'string' && leadPartial.dedupKey.trim()
      ? leadPartial.dedupKey.trim().slice(0, 240) : null;
    const dup = active.find(l => requestedDedupKey
      ? l.dedupKey === requestedDedupKey
      : ((l.toolName || null) === (leadPartial.toolName || null) && querySimilar(l.query, leadPartial.query)));
    if (dup) return { deduped: true, existing: dup };

    if (active.length >= lockedCfg.maxOpenLeads) {
      console.warn(`[personalization] addLead: maxOpenLeads (${lockedCfg.maxOpenLeads}) reached for ${userId}; tool=${leadPartial.toolName}`);
      return { deduped: true, capped: true };
    }

    const now = new Date();
    const cadence = parseRefreshCadence(leadPartial.cadenceHint) || { kind: 'daily' };
    const nextCheckAt = leadPartial.nextCheckAt == null
      ? nextCheckFromCadence(cadence, now, lockedCfg.timezone || null)
      : validDateIso(leadPartial.nextCheckAt);
    if (!nextCheckAt) return { rejected: 'invalid-next-check' };
    const nextCheckMs = Date.parse(nextCheckAt);
    if (nextCheckMs < now.getTime() - SCHEDULE_PAST_GRACE_MS
      || nextCheckMs > now.getTime() + MAX_NEXT_CHECK_AHEAD_MS) {
      return { rejected: 'invalid-next-check' };
    }
    const expiresAt = leadPartial.expiresAt == null ? null : validDateIso(leadPartial.expiresAt);
    if (leadPartial.expiresAt != null && !expiresAt) return { rejected: 'invalid-expires-at' };
    if (expiresAt) {
      const expiresMs = Date.parse(expiresAt);
      if (expiresMs <= now.getTime() || expiresMs < nextCheckMs
        || expiresMs > now.getTime() + MAX_EXPIRES_AHEAD_MS) {
        return { rejected: 'invalid-expires-at' };
      }
    }
    const checksLeft = Number.isInteger(leadPartial.checksLeft) && leadPartial.checksLeft > 0
      ? Math.min(MAX_LEAD_CHECKS, leadPartial.checksLeft)
      : Math.min(MAX_LEAD_CHECKS, Math.max(1, Number(lockedCfg.leadChecksDefault) || 2));
    const lead = {
      id: `lead_${now.getTime()}_${randomUUID().slice(0, 8)}`,
      query: leadPartial.query.trim().slice(0, 300),
      toolName: leadPartial.toolName,
      args,
      skillId: leadPartial.skillId || null,
      agentId: leadPartial.agentId || null,
      createdAt: now.toISOString(),
      nextCheckAt,
      expiresAt,
      checksLeft,
      cadenceHint: leadPartial.cadenceHint || null,
      condition: normalizeCondition(leadPartial.condition),
      dedupKey: requestedDedupKey,
      status: 'active',
      lastResult: null,
      lastCheckedAt: null,
      checkHistory: [],
      consecutiveDefers: 0,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      originObsId: leadPartial.originObsId || null,
    };

    // Re-check consent as close to the commit as possible. Config and leads
    // are separate files, so this closes the practical check/write race when
    // the user disables Personalization while a manifest lookup is in flight.
    const commitCfg = await _safeConfig(userId);
    if (commitCfg.enabled !== true || commitCfg.setupComplete !== true) {
      return { rejected: 'personalization-disabled' };
    }
    if (commitCfg.model === 'off') return { rejected: 'personalization-model-off' };
    if (active.length >= Math.max(0, Number(commitCfg.maxOpenLeads) || 0)) {
      return { deduped: true, capped: true };
    }
    file.leads.push(lead);
    _writeFile(userId, file.version, file.leads);
    return lead;
  });
}

/** Lists leads for a user. activeOnly=true (default) filters to status==='active'. */
export async function listLeads(userId, { activeOnly = true } = {}) {
  const file = _readFile(userId, { strict: true });
  return activeOnly ? file.leads.filter(l => l.status === 'active') : file.leads;
}

/** Dismisses a lead (any status). Returns true if a lead with that id existed. */
export async function dismissLead(userId, id) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return false;
    lead.status = 'dismissed';
    lead.dismissedAt = new Date().toISOString();
    lead.pendingNotify = false;
    lead.notifyAfter = null;
    clearClaim(lead);
    _writeFile(userId, file.version, file.leads);
    return true;
  });
}

/**
 * Active leads whose nextCheckAt has arrived. `now` accepts a Date or epoch
 * ms/ISO. Legacy leads with no toolName or an invalid nextCheckAt are returned
 * once so the runner can expire them instead of leaving immortal active rows.
 */
export async function dueLeads(userId, now) {
  const ts = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(ts)) return [];
  const file = _readFile(userId, { strict: true });
  return file.leads.filter(l => {
    if (l.status !== 'active') return false;
    const claimExpiry = Date.parse(l.claimExpiresAt || '');
    if (l.claimToken && Number.isFinite(claimExpiry) && claimExpiry > ts) return false;
    const expires = Date.parse(l.expiresAt || '');
    if (Number.isFinite(expires) && expires <= ts) return true;
    const next = Date.parse(l.nextCheckAt || '');
    // Legacy invalid/tool-less records are returned once so the runner can
    // expire them instead of leaving them active forever.
    return !l.toolName || !Number.isFinite(next) || next <= ts;
  });
}

/**
 * Atomically leases due leads.  A second sweep sees the live lease and cannot
 * execute the same tool.  Leases expire after a crash so work is never stuck.
 */
export async function claimDueLeads(userId, now = new Date(), { limit = 50, leaseMs = DEFAULT_CLAIM_LEASE_MS } = {}) {
  const ts = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(ts)) return [];
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const claimed = [];
    for (const lead of file.leads) {
      if (claimed.length >= Math.max(1, Math.min(100, Number(limit) || 50))) break;
      if (lead.status !== 'active') continue;
      const leaseExpiry = Date.parse(lead.claimExpiresAt || '');
      if (lead.claimToken && Number.isFinite(leaseExpiry) && leaseExpiry > ts) continue;
      const expires = Date.parse(lead.expiresAt || '');
      const next = Date.parse(lead.nextCheckAt || '');
      if (!(Number.isFinite(expires) && expires <= ts)
        && lead.toolName && Number.isFinite(next) && next > ts) continue;
      const token = `lclaim_${randomUUID()}`;
      lead.claimToken = token;
      lead.claimedAt = new Date(ts).toISOString();
      lead.claimExpiresAt = new Date(ts + Math.max(30_000, Number(leaseMs) || DEFAULT_CLAIM_LEASE_MS)).toISOString();
      claimed.push({ ...lead });
    }
    if (claimed.length) _writeFile(userId, file.version, file.leads);
    return claimed;
  });
}

export async function releaseLeadClaim(userId, id, claimToken) {
  if (!userId || !id || !claimToken) return null;
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const lead = file.leads.find(l => l.id === id);
    if (!lead || lead.claimToken !== claimToken) return transitionResult(lead, false);
    clearClaim(lead);
    _writeFile(userId, file.version, file.leads);
    return transitionResult(lead, true);
  });
}

/**
 * Records the outcome of a re-check. hit:true moves the lead to terminal
 * 'hit' status (delivery bookkeeping is lead-runner's job via
 * markLeadNotifyState below). hit:false decrements checksLeft and either
 * reschedules (nextCheckAt) or expires QUIETLY — no throw, no notification,
 * just a state flip — once checksLeft hits 0.
 * @param {string} userId
 * @param {string} id
 * @param {Object} [outcome]
 * @param {boolean} [outcome.hit]
 * @param {string|null} [outcome.resultLine]
 * @param {string|null} [outcome.nextCheckAt]
 * @param {string|null} [outcome.claimToken]
 */
export async function recordLeadCheck(userId, id, { hit, resultLine = null, nextCheckAt = null, claimToken = null } = {}) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return null;
    if (lead.status !== 'active' || !claimMatches(lead, claimToken)) return transitionResult(lead, false);
    lead.lastResult = resultLine != null ? String(resultLine).slice(0, 400) : lead.lastResult;
    lead.checkedAt = new Date().toISOString();
    lead.lastCheckedAt = lead.checkedAt;
    lead.checkHistory = Array.isArray(lead.checkHistory) ? lead.checkHistory : [];
    lead.checkHistory.push({ at: lead.checkedAt, hit: !!hit, result: lead.lastResult });
    lead.checkHistory = lead.checkHistory.slice(-MAX_CHECK_HISTORY);
    lead.consecutiveDefers = 0;
    lead.lastDeferredAt = null;
    clearClaim(lead);
    if (hit) {
      lead.status = 'hit';
      lead.hitAt = lead.hitAt || new Date().toISOString();
      // Durable-outbox invariant: a terminal hit is pending until delivery (or
      // an in-channel inbox read) explicitly clears it.
      lead.pendingNotify = true;
    } else {
      lead.checksLeft = Math.max(0, (Number.isFinite(lead.checksLeft) ? lead.checksLeft : 0) - 1);
      if (lead.checksLeft <= 0) {
        lead.status = 'expired';
        lead.expiredAt = new Date().toISOString();
      } else {
        lead.status = 'active';
        if (nextCheckAt) {
          const normalized = validDateIso(nextCheckAt);
          if (normalized) lead.nextCheckAt = normalized;
        }
      }
    }
    _writeFile(userId, file.version, file.leads);
    return transitionResult(lead, true);
  });
}

/**
 * Immediately expires a lead, bypassing the checksLeft countdown — used by
 * lead-runner's second guard layer when a stored lead's toolName fails the
 * lead-eligible check right before it would otherwise be invoked (e.g. a
 * lead written before this guard existed, or whose owning skill's manifest
 * dropped its `readOnly` flag since the lead was registered). Never invokes
 * anything; just flips terminal state so the sweep stops touching it.
 */
export async function expireLead(userId, id, resultLine = null, { claimToken = null } = {}) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return null;
    if (lead.status !== 'active' || !claimMatches(lead, claimToken)) return transitionResult(lead, false);
    lead.status = 'expired';
    lead.expiredAt = new Date().toISOString();
    if (resultLine != null) lead.lastResult = String(resultLine).slice(0, 400);
    clearClaim(lead);
    _writeFile(userId, file.version, file.leads);
    return transitionResult(lead, true);
  });
}

/**
 * Reschedules an active lead's nextCheckAt WITHOUT touching checksLeft or
 * status. Additive export (not in the original spec list) — used by
 * lead-runner.mjs when a due lead can't be judged this cycle for a reason
 * that isn't the lead's fault (no reflection model resolved), so the
 * countdown toward expiry isn't spent on a cycle whose tool was never even
 * invoked. Unlike recordLeadCheck, this never counts as a "check".
 */
export async function rescheduleLead(userId, id, nextCheckAt, { claimToken = null } = {}) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return null;
    if (lead.status !== 'active' || !claimMatches(lead, claimToken)) return transitionResult(lead, false);
    const normalized = validDateIso(nextCheckAt);
    if (!normalized) return transitionResult(lead, false);
    lead.nextCheckAt = normalized;
    clearClaim(lead);
    _writeFile(userId, file.version, file.leads);
    return transitionResult(lead, true);
  });
}

/**
 * Retryable infrastructure/tool failure. Unlike an ordinary reschedule, this
 * is bounded so a permanently broken provider/tool cannot poll forever.
 */
export async function deferLead(userId, id, nextCheckAt, { claimToken = null, reason = 'unavailable' } = {}) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return null;
    if (lead.status !== 'active' || !claimMatches(lead, claimToken)) return transitionResult(lead, false);
    const normalized = validDateIso(nextCheckAt);
    if (!normalized) return transitionResult(lead, false);
    lead.consecutiveDefers = Math.max(0, Number(lead.consecutiveDefers) || 0) + 1;
    lead.lastDeferredAt = new Date().toISOString();
    lead.lastDeferralReason = String(reason || 'unavailable').slice(0, 80);
    clearClaim(lead);
    if (lead.consecutiveDefers >= MAX_CONSECUTIVE_DEFERS) {
      lead.status = 'expired';
      lead.expiredAt = new Date().toISOString();
      lead.lastResult = 'Tracking stopped after repeated check failures.';
    } else {
      lead.nextCheckAt = normalized;
    }
    _writeFile(userId, file.version, file.leads);
    return transitionResult(lead, true);
  });
}

/**
 * Delivery bookkeeping for 'hit' leads held back by quiet hours or an
 * exhausted daily ping budget (ADDENDUM H). Not in the original export list
 * — additive, used internally by lead-runner.mjs to track
 * pendingNotify/notifyAfter/notifiedAt without overloading recordLeadCheck's
 * documented {hit, resultLine, nextCheckAt} shape.
 */
export async function markLeadNotifyState(userId, id, patch = {}) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId, { strict: true });
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return null;
    if (patch.expectedStatus && lead.status !== patch.expectedStatus) return transitionResult(lead, false);
    if ('expectedPendingNotify' in patch && !!lead.pendingNotify !== !!patch.expectedPendingNotify) {
      return transitionResult(lead, false);
    }
    if ('pendingNotify' in patch) lead.pendingNotify = !!patch.pendingNotify;
    if ('notifyAfter' in patch) lead.notifyAfter = patch.notifyAfter;
    if ('notifiedAt' in patch) lead.notifiedAt = patch.notifiedAt;
    _writeFile(userId, file.version, file.leads);
    return transitionResult(lead, true);
  });
}
