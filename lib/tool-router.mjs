// @ts-check
/**
 * Per-turn dynamic tool routing for the coordinator.
 *
 * The coordinator's resolved tool surface today is ~70 tools after
 * defaultToolIds filtering. The vast majority go untouched on any given
 * turn — a "set a reminder for 5pm" doesn't need ha_*, oe_admin_*,
 * profile_*, etc. Shipping all 70 every turn pays ~16k input tokens of
 * tool-schema overhead for no benefit.
 *
 * This module classifies the user's message at turn start and trims the
 * outbound tool list to a "core" set + matched on-demand skills. A
 * companion `request_tools` meta-tool (defined on the coordinator) lets
 * the LLM expand the surface mid-turn if the classifier missed.
 *
 * Composition:
 *   - `trimToolsForTurn` — call once at the head of streamChat, BEFORE the
 *     provider builds its request. Returns the trimmed list and stashes
 *     the full set on a context store for request_tools to pull from.
 *   - `expandToolsByReason` — called by request_tools' executor. Embeds the
 *     reason, classifies on-demand skills, mutates ctx.agent.tools.
 *   - `recordTurnRouting` — telemetry: appends {prompt, initialSkills,
 *     addedSkills, usedToolNames} for future learning loops to consume.
 *
 * Two static taxonomies the LLM doesn't decide:
 *   - ALWAYS_INCLUDE_SKILL_IDS — skills whose tools we ship every turn
 *     (delegate, scheduling primitives, memory, web).
 *   - ON_DEMAND_SKILL_IDS — skills only included when the user's prompt
 *     scores above threshold against their intent_examples, or when the
 *     LLM explicitly asks via request_tools.
 *
 * Custom user skills (manifest.custom===true) are treated as always-on
 * for backwards compatibility — they were authored for the user's
 * particular agents and shouldn't get silently dropped.
 */

import { listRoles, getRoleManifest, getAgentRoles } from '../roles.mjs';
import { classifyByEmbedding } from './specialist-embed-router.mjs';
import { log } from '../logger.mjs';

// Skills whose tools always ship on a coordinator turn. Kept tight — these
// are universally useful (web, memory, delegate, telegram) or core to
// coordinator duties (coordinator, self-mgmt). `tasks` and `routines` USED to
// be here but moved to ON_DEMAND below; their tool surfaces are large
// (~10 tools each) and their SPAs are multi-KB, but they only matter on
// scheduling/routine-shaped turns where the classifier can pick them up.
const ALWAYS_INCLUDE_SKILL_IDS = new Set([
  'coordinator',     // ask_agent, create_agent — the delegation primitives
  'delegate',        // ask_agent (duplicate path)
  'self-mgmt',       // claim_role, list_roles, remember_fact, etc.
  'user-admin',      // manage_user, list_users (hidden but always-on)
  'web',             // web_search, fetch_url — general direct queries
  'telegram',        // send_telegram_message — common direct send
  'profile_files',   // list/read profile files — common reference path
  'logs',            // read_logs, scan_for_concerns — admin reference
  'utility',         // grab-bag
]);

// Skills whose tools are NOT shipped by default; pulled in by intent match
// or explicit request_tools call. These tend to be larger, more specialized
// surfaces that are noise on most turns.
const ON_DEMAND_SKILL_IDS = new Set([
  'tasks',           // ~10 tools + 6 KB SPA — only on scheduling-shaped turns
  'routines',        // ~4 tools + 2 KB SPA — only on routine-shaped turns
  'oe-admin',        // ~17 tools, install/tunnel/provider mutation
  'profiles',        // ~10 tools + ~10 KB SPA — the single biggest contributor
  'role_home_assistant',  // ha_* tools — only when smart-home language matches
  'email', 'gcal', 'expenses', 'coder', 'nodes', 'deep_research',
  'skill-builder', 'role_tutor', 'image_generator', 'role_video_generator',
]);

// Embedding-match threshold for on-demand skill inclusion at the initial
// trim. We sit BELOW the specialist-router's 0.78 (single-skill routing)
// but ABOVE 0.62 because empirical false positives at 0.62 were costing
// noise on every turn: "what is 17 times 23" was matching `email`,
// "set a reminder" was matching `role_tutor`. The LLM has a safety net
// via request_tools — better to miss and let the LLM ask than to mis-load.
const INITIAL_INCLUDE_THRESHOLD = 0.72;
// Tie-break gap. If top and runner-up are within this much, treat it as
// ambiguous → don't include either at the initial trim. The LLM's
// request_tools call has access to richer context (it knows what it's
// trying to do) and can ask for the right one.
const INITIAL_INCLUDE_GAP = 0.04;

// Lower threshold used by request_tools expansion — the LLM already
// declared it needs something, so be permissive about picking up
// neighboring skills.
const EXPANSION_THRESHOLD = 0.58;

/**
 * Build the per-tool → skill_id index from the loaded role manifests.
 * Cached per-call to listRoles(); invalidated when the manifest cache rolls.
 */
const _toolOwnerCache = new WeakMap();
function toolOwnerIndex(userId) {
  const manifests = listRoles(userId);
  const cached = _toolOwnerCache.get(manifests);
  if (cached) return cached;
  const idx = Object.create(null);
  for (const m of manifests) {
    for (const t of (m.tools ?? [])) {
      const name = t.function?.name;
      if (name && !idx[name]) idx[name] = m.id;
    }
  }
  _toolOwnerCache.set(manifests, idx);
  return idx;
}

/**
 * Is this skill always-on for this user?
 * - Built-in always-on (see ALWAYS_INCLUDE_SKILL_IDS) → always
 * - Custom user skill with coordinator_scope === 'auto' → no (on-demand only)
 * - Custom user skill with coordinator_scope === 'exclude' → no (and
 *   agent-resolver already drops its tools from this agent entirely)
 * - Other custom user skill → yes (the default for back-compat with
 *   skills authored before scoping existed)
 */
function isAlwaysOnSkill(skillId, userId) {
  if (ALWAYS_INCLUDE_SKILL_IDS.has(skillId)) return true;
  const m = getRoleManifest(skillId, userId);
  if (!m?.custom) return false;
  return m.coordinator_scope !== 'auto' && m.coordinator_scope !== 'exclude';
}

/**
 * Custom skills the user opted into per-turn classification for. Returned
 * as a Set so it composes cleanly with the static ON_DEMAND_SKILL_IDS in
 * the classifier hit-check below.
 */
function getCustomAutoSkills(userId) {
  const out = new Set();
  for (const m of listRoles(userId)) {
    if (m.custom === true && m.coordinator_scope === 'auto') out.add(m.id);
  }
  return out;
}

/**
 * Classify which on-demand skills the user prompt is asking for.
 * Returns a Set of skill IDs whose tools should be included this turn.
 * Empty Set when classifier misses or fails — the LLM can request via
 * request_tools.
 */
async function classifyOnDemandSkills(userText, userId, threshold) {
  if (!userText || userText.length < 6) return new Set();
  const hits = new Set();
  // Custom skills the user authored with coordinator_scope='auto' join the
  // built-in on-demand set as classifier-eligible. Their intent_examples are
  // already in the embed router (loadIntentEmbeddings walks every skill with
  // examples now, not just service:true ones).
  const dynamicOnDemand = new Set([...ON_DEMAND_SKILL_IDS, ...getCustomAutoSkills(userId)]);
  try {
    const top = await classifyByEmbedding(userText, userId, /* coordAgentId */ null, { threshold, gap: INITIAL_INCLUDE_GAP, includeUnassigned: true });
    if (top && dynamicOnDemand.has(top.skillId)) hits.add(top.skillId);
  } catch (e) {
    log.warn('tool-router', 'embed classify threw', { err: e.message });
  }
  return hits;
}

/**
 * @typedef {object} TrimResult
 * @property {Array} trimmedTools  Tool list to ship to the provider.
 * @property {Array} fullTools     Original full tool list (kept for request_tools to draw from).
 * @property {Set<string>} initiallyIncludedSkills  Skills whose tools made it into trimmedTools.
 * @property {string[]} routerNotes  Short strings describing what fired (for logging).
 */

/**
 * Trim the agent's tool list down to {always-on} + {on-demand matched
 * by the user's message}. Pure: does not mutate the input agent.
 *
 * Called at the head of streamChat() ONLY for coordinator-category agents.
 * Other agents are already tightly scoped by their service skill's
 * defaultToolIds and don't benefit from per-turn trimming.
 *
 * @returns {Promise<TrimResult>}
 */
export async function trimToolsForTurn({ agent, userText, userId }) {
  const fullTools = agent.tools ?? [];
  if (!fullTools.length || agent.skillCategory !== 'coordinator') {
    return { trimmedTools: fullTools, fullTools, initiallyIncludedSkills: new Set(), routerNotes: ['skipped: not coordinator'] };
  }
  const owners = toolOwnerIndex(userId);
  // Step 1: classify which on-demand skills match this turn.
  const matched = await classifyOnDemandSkills(userText, userId, INITIAL_INCLUDE_THRESHOLD);
  // Step 2: which service roles does this agent currently hold? Holding a
  // role means the user explicitly delegated that capability to this agent
  // via claim_role; its tools must always ship on the holder's turns,
  // regardless of whether the per-turn classifier matched. Without this,
  // a vague follow-up like "ok do it" right after a role transfer leaves
  // the agent with no way to actually do the thing.
  const heldRoles = new Set(getAgentRoles(agent.id, userId));
  // Step 3: assemble the keep-set: always-on + matched + held-role.
  const keepSkills = new Set();
  for (const t of fullTools) {
    const ownerId = owners[t.function?.name];
    if (!ownerId) continue;
    if (isAlwaysOnSkill(ownerId, userId)) keepSkills.add(ownerId);
    else if (matched.has(ownerId))         keepSkills.add(ownerId);
    else if (heldRoles.has(ownerId))       keepSkills.add(ownerId);
  }
  const trimmedTools = fullTools.filter(t => {
    const ownerId = owners[t.function?.name];
    if (!ownerId) return true; // unknown owner — keep to be safe
    return keepSkills.has(ownerId);
  });
  const notes = [
    `kept ${trimmedTools.length}/${fullTools.length} tools`,
    `skills: ${[...keepSkills].sort().join(',')}`,
  ];
  if (matched.size) notes.push(`matched on-demand: ${[...matched].join(',')}`);
  if (heldRoles.size) notes.push(`held roles: ${[...heldRoles].join(',')}`);
  return { trimmedTools, fullTools, initiallyIncludedSkills: keepSkills, routerNotes: notes };
}

/**
 * Given a free-form reason (LLM-supplied) and optional explicit group names,
 * find tools from the full set to add to agent.tools that aren't already
 * present. Mutates `ctx.agent.tools` (in place) so the next provider
 * iteration picks them up.
 *
 * @returns {Promise<{addedToolNames: string[], addedSkills: string[]}>}
 */
export async function expandToolsByReason({ agent, fullTools, reason, groups, userId, alreadyIncludedSkills }) {
  const owners = toolOwnerIndex(userId);
  const targetSkills = new Set();
  const dynamicOnDemand = new Set([...ON_DEMAND_SKILL_IDS, ...getCustomAutoSkills(userId)]);

  // Explicit group hint wins — LLM declared what it needs by name.
  if (Array.isArray(groups) && groups.length) {
    for (const g of groups) {
      if (typeof g === 'string' && dynamicOnDemand.has(g)) targetSkills.add(g);
    }
  }

  // Embed-match the free-form reason against on-demand skills.
  if (typeof reason === 'string' && reason.trim().length >= 4) {
    try {
      const top = await classifyByEmbedding(reason, userId, /* coordAgentId */ null, { threshold: EXPANSION_THRESHOLD, gap: 0.0, includeUnassigned: true });
      if (top && dynamicOnDemand.has(top.skillId)) targetSkills.add(top.skillId);
    } catch (e) {
      log.warn('tool-router', 'expansion embed threw', { err: e.message });
    }
  }

  // Build the addition list — tools in target skills that aren't already
  // in agent.tools.
  const currentNames = new Set((agent.tools ?? []).map(t => t.function?.name));
  const newTools = [];
  const addedSkills = [];
  for (const skillId of targetSkills) {
    if (alreadyIncludedSkills?.has(skillId)) continue;
    let touched = false;
    for (const t of fullTools) {
      if (owners[t.function?.name] !== skillId) continue;
      if (currentNames.has(t.function?.name)) continue;
      newTools.push(t);
      currentNames.add(t.function?.name);
      touched = true;
    }
    if (touched) addedSkills.push(skillId);
  }
  if (newTools.length) agent.tools = [...(agent.tools ?? []), ...newTools];
  return { addedToolNames: newTools.map(t => t.function?.name), addedSkills };
}

/**
 * Append a telemetry record describing which skills were initially
 * included vs added-via-request, and what was actually called. Fuel for
 * a future learning loop that uses prior {prompt → skill} mappings as
 * extra intent examples.
 *
 * Best-effort; never throws and is fire-and-forget at the call site.
 */
import { promises as fsp } from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
export async function recordTurnRouting({ userId, userText, initiallyIncludedSkills, addedSkills, usedToolNames }) {
  if (!userId || !userText) return;
  try {
    const dir = path.join(USERS_DIR, userId);
    const log = path.join(dir, 'tool-routing-log.jsonl');
    const rec = {
      ts: new Date().toISOString(),
      prompt: userText.length > 500 ? userText.slice(0, 500) + '…' : userText,
      initialSkills: [...(initiallyIncludedSkills ?? [])].sort(),
      addedSkills: [...(addedSkills ?? [])].sort(),
      usedToolNames: [...(usedToolNames ?? [])],
    };
    await fsp.appendFile(log, JSON.stringify(rec) + '\n');
  } catch { /* never block a turn on telemetry */ }
}

// Bare-name access for tests.
export const _internal = { ALWAYS_INCLUDE_SKILL_IDS, ON_DEMAND_SKILL_IDS, INITIAL_INCLUDE_THRESHOLD };
