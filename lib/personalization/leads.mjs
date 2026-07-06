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
 * Plaintext JSON is fine here (no raw content — query/args only), written
 * atomically with version + updated_at per the voice-config.mjs convention.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { USERS_DIR } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';
import { isDestructiveTool } from '../learning-safety.mjs';

// Config defaults mirrored from the master spec's config.json schema. Read
// live via config.mjs when available; fall back to these if that module
// can't be loaded (e.g. isolated tests, or a boot race) — leads must keep
// working, just with sane conservative defaults, per the "never throw into
// callers" rule for personalization background paths.
const CONFIG_DEFAULTS = { maxOpenLeads: 8, leadChecksDefault: 2 };

async function _safeConfig(userId) {
  try {
    const { getConfig } = await import('./config.mjs');
    const cfg = await getConfig(userId);
    return { ...CONFIG_DEFAULTS, ...cfg };
  } catch (e) {
    console.warn(`[personalization] leads: config unavailable, using defaults (${e.message})`);
    return { ...CONFIG_DEFAULTS };
  }
}

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}
function leadsPath(userId) {
  return path.join(personalizationDir(userId), 'leads.json');
}

function _readFile(userId) {
  const p = leadsPath(userId);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      version: Number.isInteger(data.version) ? data.version : 0,
      leads: Array.isArray(data.leads) ? data.leads : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[personalization] leads.json read failed for ${userId}: ${e.message}`);
    return { version: 0, leads: [] };
  }
}

function _writeFile(userId, prevVersion, leads) {
  const dir = personalizationDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const data = { version: (prevVersion || 0) + 1, updated_at: Date.now(), leads };
  atomicWriteSync(leadsPath(userId), JSON.stringify(data, null, 2));
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
 * A null/empty toolName is never "eligible" by this function, but both
 * callers (addLead, lead-runner's due-lead loop) special-case that before
 * ever calling it — a tool-less lead is briefing-only and never reaches
 * this check.
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
export function nextCheckFromCadence(cadence, now) {
  const base = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const c = (cadence && cadence.kind) ? cadence : { kind: 'daily' };

  if (c.kind === 'hourly') {
    return new Date(base.getTime() + 60 * 60 * 1000).toISOString();
  }

  const hour = Number.isFinite(c.hour) ? c.hour : DEFAULT_CHECK_HOUR;
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
 * would ever flag). A null toolName is fine either way (the lead becomes
 * briefing-only, never auto-rechecked — see dueLeads below).
 */
export async function addLead(userId, leadPartial) {
  if (!userId) throw new Error('addLead: userId required');
  if (!leadPartial || typeof leadPartial !== 'object' || !leadPartial.query) {
    throw new Error('addLead: leadPartial.query required');
  }
  if (isMutatingToolName(leadPartial.toolName)) {
    console.warn(`[personalization] rejected lead with mutating tool: ${leadPartial.toolName}`);
    return { rejected: 'mutating-tool' };
  }
  if (leadPartial.toolName && !(await isLeadEligibleTool(leadPartial.toolName, { skillId: leadPartial.skillId, userId }))) {
    console.warn(`[personalization] rejected lead with a tool that isn't lead-eligible (not on the read-only allowlist / skill manifest): ${leadPartial.toolName}`);
    return { rejected: 'not-lead-eligible' };
  }
  const cfg = await _safeConfig(userId);
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId);
    const active = file.leads.filter(l => l.status === 'active');

    const dup = active.find(l => (l.toolName || null) === (leadPartial.toolName || null)
      && querySimilar(l.query, leadPartial.query));
    if (dup) return { deduped: true, existing: dup };

    if (active.length >= cfg.maxOpenLeads) {
      console.warn(`[personalization] addLead: maxOpenLeads (${cfg.maxOpenLeads}) reached for ${userId}, dropping "${String(leadPartial.query).slice(0, 80)}"`);
      return { deduped: true, capped: true };
    }

    const now = new Date();
    const cadence = parseRefreshCadence(leadPartial.cadenceHint) || { kind: 'daily' };
    const lead = {
      id: `lead_${now.getTime()}_${randomUUID().slice(0, 8)}`,
      query: String(leadPartial.query).slice(0, 300),
      toolName: leadPartial.toolName || null,
      args: (leadPartial.args && typeof leadPartial.args === 'object') ? leadPartial.args : {},
      skillId: leadPartial.skillId || null,
      agentId: leadPartial.agentId || null,
      createdAt: now.toISOString(),
      nextCheckAt: leadPartial.nextCheckAt || nextCheckFromCadence(cadence, now),
      checksLeft: Number.isFinite(leadPartial.checksLeft) ? leadPartial.checksLeft : cfg.leadChecksDefault,
      cadenceHint: leadPartial.cadenceHint || null,
      status: 'active',
      lastResult: null,
      originObsId: leadPartial.originObsId || null,
    };
    file.leads.push(lead);
    _writeFile(userId, file.version, file.leads);
    return lead;
  });
}

/** Lists leads for a user. activeOnly=true (default) filters to status==='active'. */
export async function listLeads(userId, { activeOnly = true } = {}) {
  const file = _readFile(userId);
  return activeOnly ? file.leads.filter(l => l.status === 'active') : file.leads;
}

/** Dismisses a lead (any status). Returns true if a lead with that id existed. */
export async function dismissLead(userId, id) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId);
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return false;
    lead.status = 'dismissed';
    lead.dismissedAt = new Date().toISOString();
    _writeFile(userId, file.version, file.leads);
    return true;
  });
}

/**
 * Active leads whose nextCheckAt has arrived. `now` accepts a Date or epoch
 * ms/ISO. Leads with no toolName are excluded — there's nothing to
 * re-invoke, so they're briefing-only and never picked up by the sweep.
 */
export async function dueLeads(userId, now) {
  const ts = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const file = _readFile(userId);
  return file.leads.filter(l => l.status === 'active' && l.toolName && new Date(l.nextCheckAt).getTime() <= ts);
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
 */
export async function recordLeadCheck(userId, id, { hit, resultLine = null, nextCheckAt = null } = {}) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId);
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return null;
    lead.lastResult = resultLine != null ? String(resultLine).slice(0, 400) : lead.lastResult;
    lead.checkedAt = new Date().toISOString();
    if (hit) {
      lead.status = 'hit';
      lead.hitAt = lead.hitAt || new Date().toISOString();
    } else {
      lead.checksLeft = Math.max(0, (Number.isFinite(lead.checksLeft) ? lead.checksLeft : 0) - 1);
      if (lead.checksLeft <= 0) {
        lead.status = 'expired';
        lead.expiredAt = new Date().toISOString();
      } else {
        lead.status = 'active';
        if (nextCheckAt) lead.nextCheckAt = nextCheckAt;
      }
    }
    _writeFile(userId, file.version, file.leads);
    return lead;
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
export async function expireLead(userId, id, resultLine = null) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId);
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return null;
    lead.status = 'expired';
    lead.expiredAt = new Date().toISOString();
    if (resultLine != null) lead.lastResult = String(resultLine).slice(0, 400);
    _writeFile(userId, file.version, file.leads);
    return lead;
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
export async function rescheduleLead(userId, id, nextCheckAt) {
  return withLock(leadsPath(userId), () => {
    const file = _readFile(userId);
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return null;
    lead.nextCheckAt = nextCheckAt;
    _writeFile(userId, file.version, file.leads);
    return lead;
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
    const file = _readFile(userId);
    const lead = file.leads.find(l => l.id === id);
    if (!lead) return null;
    if ('pendingNotify' in patch) lead.pendingNotify = !!patch.pendingNotify;
    if ('notifyAfter' in patch) lead.notifyAfter = patch.notifyAfter;
    if ('notifiedAt' in patch) lead.notifiedAt = patch.notifiedAt;
    _writeFile(userId, file.version, file.leads);
    return lead;
  });
}
