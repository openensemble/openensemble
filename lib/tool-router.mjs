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
import { embed } from '../memory/embedding.mjs';
import { loadConfig } from '../routes/_helpers.mjs';
import { log } from '../logger.mjs';
import { directiveText, instructionText } from './instruction-text.mjs';

// Skills whose tools always ship on a coordinator turn. Kept tight — these
// are universally useful (web, memory, delegate, telegram) or core to
// coordinator duties (coordinator, self-mgmt). `tasks` and `routines` USED to
// be here but moved to ON_DEMAND below; their tool surfaces are large
// (~10 tools each) and their SPAs are multi-KB, but they only matter on
// scheduling/routine-shaped turns where the classifier can pick them up.
const ALWAYS_INCLUDE_SKILL_IDS = new Set([
  'coordinator',     // ask_agent, create_agent — the delegation primitives
  'delegate',        // ask_agent (duplicate path)
  'self-mgmt',       // claim_role, remember_fact, etc. (role mgmt moved to coordinator)
  'user-admin',      // manage_user, list_users (bundled with coordinator)
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
  'browser-ext',     // browser tools are still experimental; load only on browser/page/tab intent
  'mcp-admin',       // MCP management is clear by keyword and too specific for every turn
  'active-agents',   // task-status tools only matter on status/check-in turns
  'role_home_assistant',  // ha_* tools — only when smart-home language matches
  'email', 'gcal', 'expenses', 'coder', 'nodes', 'deep_research',
  'skill-builder', 'role_tutor', 'image_generator', 'role_video_generator',
  'transcribe',      // audio/video → text, only on transcribe-shaped turns
]);

const DIRECT_INTENT_RULES = [
  {
    skillId: 'browser-ext',
    re: /\b(?:browser|tab|current\s+page|page\s+i'?m\s+on|read\s+(?:the\s+)?page|summari[sz]e\s+(?:this|the|my)\s+(?:page|tab)|open\s+(?:this\s+)?(?:site|website|url|link|page)|click|screenshot|web\s*page)\b/i,
  },
  {
    skillId: 'mcp-admin',
    re: /\b(?:mcp|model\s+context\s+protocol|server[-\s]?mcp|mcp\s+server|tool\s+server)\b/i,
  },
  {
    skillId: 'active-agents',
    re: /\b(?:(?:how'?s|how\s+is)\s+(?:it|that|the\s+(?:task|job|work|agent))\s+going|what(?:'s|\s+is)\s+(?:running|in\s+flight|the\s+status)|(?:background|delegated)\s+(?:task|job|work)|is\s+\w+\s+still\s+(?:working|running)|check\s+(?:on\s+)?(?:the\s+)?(?:task|job|work|agent)|task\s+log|active\s+agents?)\b/i,
  },
  {
    skillId: 'role_home_assistant',
    re: /\b(?:home\s+assistant|turn\s+(?:on|off)|set\s+(?:the\s+)?(?:thermostat|ac|a\/c|air\s+conditioner)|lights?|switch|climate|scene|script|fan|garage|lock)\b/i,
  },
  {
    skillId: 'email',
    re: /\b(?:email|gmail|inbox|message|reply|send\s+(?:shawn\s+)?(?:an\s+)?email|mail)\b/i,
  },
  {
    skillId: 'gcal',
    re: /\b(?:calendar|appointment|event|meeting|schedule\s+(?:a\s+)?meeting)\b/i,
  },
  {
    skillId: 'tasks',
    re: /\b(?:remind|reminder|alarm|timer|task|to-?do|watch|monitor|notify\s+me|schedule\s+(?:a\s+)?task)\b/i,
  },
  {
    skillId: 'routines',
    re: /\b(?:routine|when\s+i\s+say|every\s+time\s+i\s+(?:say|tell)|voice\s+routine)\b/i,
  },
  {
    skillId: 'oe-admin',
    re: /\b(?:openensemble|oe\s+server|restart\s+(?:the\s+)?server|provider|integration|tunnel|cloudflared|tailscale|update\s+(?:oe|openensemble))\b/i,
  },
];

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
  if (!m) return false;
  // Manifest opt-in for built-in skills: setting `always_on: true` on the
  // manifest forces inclusion every turn without needing to edit the
  // hardcoded ALWAYS_INCLUDE_SKILL_IDS set above. Required for newer
  // service skills (mcp-admin, future similar) so they ship regardless of
  // whether the per-turn embedding classifier matched.
  if (m.always_on === true) return true;
  if (!m.custom) return false;
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
  for (const rule of DIRECT_INTENT_RULES) {
    if (dynamicOnDemand.has(rule.skillId) && rule.re.test(userText)) hits.add(rule.skillId);
  }
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
 * @property {Set<string>} initiallyIncludedSkills  Skills the request_tools recovery gate treats as already-present (empty when the tool-level pass ran, so any dropped tool is recoverable).
 * @property {Set<string>} [skillsKept]  Skills actually kept this turn — for telemetry/learning (the tool-level pass narrows within a kept skill, so this differs from initiallyIncludedSkills).
 * @property {string[]} routerNotes  Short strings describing what fired (for logging).
 * @property {Array} [toolDecisions]  Per-tool keep/drop decisions from the tool-level pass.
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
// ── Tool-level routing (intra-skill) ─────────────────────────────────────────
// Skill-level trimming keeps/drops whole skills; this narrows WITHIN the kept
// set so e.g. an email agent asked to "summarize" doesn't also ship its
// labeling/sending tools. Embeds each tool's name+description once (cached),
// scores it against the user message, and keeps the relevant ones plus a
// control-plane floor. Applies to EVERY agent (coordinator + specialist).

// Always-ship regardless of score: the recovery + delegation + delivery
// primitives. request_tools lets the LLM pull back anything the trim dropped
// mid-turn. ask_agent starts available, then the specialist terminal-action
// policy can remove it when the agent already has the right primary action
// tool. email_user is the UNIVERSAL send primitive (always_on on every agent) —
// never trim it, so any agent asked to "email X" can always deliver. It was
// being dropped as a cross-skill "unrelated service tool" on non-email agents
// exactly when a "do X AND email it" directive needed it (e.g. a research agent
// re-dispatched to prepare+email), crippling the run and making the coordinator
// flail through retries.
//
// `web_search` is here for the same reason plus one more: it's the single most-used
// tool, AND on native-search models (gpt-5.5/Codex, Claude, grok, openrouter,
// perplexity) the provider only injects the model's hosted/native web search when
// the agent STILL holds this Brave `web_search` function in its trimmed list
// (model-capabilities.mjs `holdsBrave`, openai-responses.mjs). So trimming it
// doesn't just drop Brave search — it silently revokes the model's native search,
// leaving a research agent with no way to reach the web at all (the LG-Twins
// failure: Rose on gpt-5.5 pinned to research_search/list_research, no web). Never
// trimming it keeps the capability intact. This only KEEPS the tool for agents
// that already have it (the `web` skill) — it never grants web access to an agent
// that lacked it.
const ALWAYS_TOOL_NAMES = new Set(['request_tools', 'ask_agent', 'email_user', 'web_search']);
const TERMINAL_ACTION_RE = /\b(?:send|email|reply|compose|create|update|delete|remove|add|set|turn|run|execute|label|sort|purge|trash|mark|move|schedule|cancel|start|stop|install|patch|write|upload|download|watch|call)\b/i;
const VERIFY_BEFORE_ACTION_RE = /\b(?:verify|check|search|find|look\s+for|already|duplicate|sent|outbox|inbox|before|whether|confirm|read|list|fetch|lookup|count|status)\b/i;
const EXTERNAL_RESEARCH_RE = /\b(?:research|look\s+up|find\s+out|latest|current|browse|web\s+search|search\s+the\s+web)\b/i;
const READ_COMPANION_TOOL_RE = /\b(?:list|search|read|get|fetch|find|lookup|count|status|check|thread|stats|inbox)\b/i;
const TERMINAL_SUPPORT_SKILLS = new Set(['profile_files', 'utility', 'logs']);

// _toolText -> embedding vector. Lazily filled; lives for the process. Keyed by
// the embedded text so a description edit naturally re-embeds under a new key.
const _toolVecCache = new Map();
function _toolText(t) {
  const fn = t?.function || {};
  return `${fn.name || ''}: ${fn.description || ''}`.slice(0, 800);
}
async function getToolVec(t) {
  const text = _toolText(t);
  if (!text.trim()) return null;
  let v = _toolVecCache.get(text);
  if (v) return v;
  try { v = await embed(text); } catch { v = null; }
  if (Array.isArray(v) && v.length) _toolVecCache.set(text, v);
  return v;
}
function _toolDot(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }

// Config (config.json → toolRouter.*), read fresh each turn so live tuning
// during testing doesn't need a restart. Selection is RANK-RELATIVE, not an
// absolute threshold: tool-description embeddings within one skill cluster
// tightly (every email tool says "email"), so an absolute cutoff keeps either
// all or none. We instead keep tools within `margin` of the best-scoring tool,
// clamped to [minKeep, maxKeep]. `noActionFloor` is an absolute sanity gate —
// if even the best tool scores below it the turn is chat, so ship only the
// control-plane. Defaults are starting points; tune live during testing.
export function toolRouterCfg() {
  const c = loadConfig()?.toolRouter ?? {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    enabled: c.toolLevel !== false,                 // default ON for all agents
    margin: num(c.toolMargin, 0.05),                // keep tools within this of the top score
    minKeep: num(c.toolMinKeep, 3),                 // never fewer than this on an actionable turn
    maxKeep: num(c.toolMaxKeep, 8),                 // hard cap on action tools kept (bounds chat-turn noise)
    noActionFloor: num(c.toolNoActionFloor, 0.45),  // best tool below this → chat turn, control-plane only
  };
}

// Score a candidate tool list against the message and keep the relevant cluster.
// Control-plane tools (request_tools/ask_agent) always ship and don't count
// toward the cap. Returns kept tools (original order) + per-tool decisions for
// logging/preview. Fail-open: any embed failure returns the full set unchanged.
export async function scoreToolsForTurn({ tools, userText, userId, cfg }) {
  cfg = cfg || toolRouterCfg();
  const decisions = [];
  if (!cfg.enabled || !tools?.length || !userText?.trim()) {
    return { kept: tools ?? [], decisions, applied: false };
  }
  // Embed the INSTRUCTION, not the whole message. A delegated "email this
  // briefing to X: <10 KB of content>" must score the send tool against "email
  // this to X", not drown it in the pasted payload — that dilution is what
  // dropped an email specialist's compose tool on big-payload sends.
  let qVec = null;
  try { qVec = await embed(instructionText(userText)); } catch { /* embed down */ }
  if (!Array.isArray(qVec) || !qVec.length) return { kept: tools, decisions, applied: false };

  const scored = await Promise.all(tools.map(async (t) => {
    const name = t.function?.name || '';
    if (ALWAYS_TOOL_NAMES.has(name)) return { t, name, sim: 1, control: true };
    const v = await getToolVec(t);
    return { t, name, sim: v ? _toolDot(qVec, v) : 0, control: false };
  }));

  const keep = new Set(scored.filter(s => s.control));   // control-plane always
  const action = scored.filter(s => !s.control).sort((a, b) => b.sim - a.sim);
  const top = action.length ? action[0].sim : 0;
  // Above the sanity floor → keep the cluster within `margin` of the best,
  // clamped to [minKeep, maxKeep]. Below it → chat turn, keep no action tools.
  if (top >= cfg.noActionFloor) {
    const cutoff = top - cfg.margin;
    let chosen = action.filter(s => s.sim >= cutoff);
    if (chosen.length < cfg.minKeep) chosen = action.slice(0, cfg.minKeep);
    if (chosen.length > cfg.maxKeep) chosen = chosen.slice(0, cfg.maxKeep);
    for (const s of chosen) keep.add(s);
  }

  const kept = [];
  for (const s of scored) {
    const inKept = keep.has(s);
    decisions.push({ name: s.name, sim: Number(s.sim.toFixed(3)), kept: inKept, control: s.control });
    if (inKept) kept.push(s.t);
  }
  return { kept, decisions, applied: true };
}

function toolName(t) {
  return t?.function?.name || t?.name || '';
}

function hasToolNamed(tools, names) {
  const wanted = new Set(names);
  return (tools || []).some(t => wanted.has(toolName(t)));
}

function adjustSpecialistTerminalTools({ agent, userText, userId, kept, fullTools, decisions, isolatedTaskRun = false }) {
  if (agent?.skillCategory === 'coordinator') return { kept, notes: [] };
  const primarySkill = agent?.skillCategory;
  if (!primarySkill || primarySkill === 'general' || primarySkill === 'web' || primarySkill === 'none') {
    return { kept, notes: [] };
  }

  const owners = toolOwnerIndex(userId);
  const keptNames = new Set((kept || []).map(toolName).filter(Boolean));
  const directive = directiveText(userText);
  const primaryActionTools = (kept || []).filter(t => {
    const name = toolName(t);
    return name && !ALWAYS_TOOL_NAMES.has(name) && owners[name] === primarySkill;
  });
  if (!primaryActionTools.length) {
    // The scorer kept no primary-skill action tool — the turn scored below the
    // action floor (a long pasted payload can drag every score down). If the
    // directive is plainly a terminal action of THIS specialist's own skill
    // ("send/email/compose/..."), it must still be able to act, so force the
    // best-scoring primary-skill action tool(s) back in. Best-scoring reuses
    // the sims the scorer already computed (now instruction-based), so a send
    // directive surfaces compose/reply rather than a read tool.
    if (!TERMINAL_ACTION_RE.test(directive)) return { kept, notes: [] };
    const sim = new Map((decisions || []).map(d => [d.name, d.sim ?? 0]));
    const forced = (fullTools || [])
      .filter(t => { const n = toolName(t); return n && !ALWAYS_TOOL_NAMES.has(n) && owners[n] === primarySkill; })
      .sort((a, b) => (sim.get(toolName(b)) ?? 0) - (sim.get(toolName(a)) ?? 0))
      .slice(0, 3);
    if (!forced.length) return { kept, notes: [] };
    for (const t of forced) keptNames.add(toolName(t));
    for (const d of decisions || []) if (keptNames.has(d.name)) d.kept = true;
    return {
      kept: (fullTools || kept || []).filter(t => keptNames.has(toolName(t))),
      notes: [`terminal-specialist: force-kept ${forced.length} primary action tool${forced.length === 1 ? '' : 's'} (scorer dropped all on a terminal directive)`],
    };
  }

  const notes = [];
  if (VERIFY_BEFORE_ACTION_RE.test(directive)) {
    let added = 0;
    for (const t of fullTools || []) {
      const name = toolName(t);
      if (!name || keptNames.has(name) || owners[name] !== primarySkill) continue;
      if (!READ_COMPANION_TOOL_RE.test(`${name} ${t?.function?.description || ''}`)) continue;
      keptNames.add(name);
      added++;
      if (added >= 4) break;
    }
    if (added) notes.push(`terminal-specialist: added ${added} same-skill read/search companion tool${added === 1 ? '' : 's'}`);
  }

  const needsExternalResearch = EXTERNAL_RESEARCH_RE.test(directive)
    && !hasToolNamed(fullTools, ['web_search', 'fetch_url']);
  const terminalPrimaryAction = TERMINAL_ACTION_RE.test(directive) && !needsExternalResearch;
  // Suppress ask_agent ONLY on interactive turns. On an autonomous run
  // (scheduled task, watcher on_fire, background continuation) the task may be
  // complex and need to hand off to OTHER agents — e.g. a youtube watcher told
  // to email an HTML preview card must delegate the build+send to the email /
  // coder agents. Removing ask_agent there silently breaks delivery, and there
  // is no human present to recover, so never suppress it when autonomous.
  if (terminalPrimaryAction && !isolatedTaskRun && keptNames.delete('ask_agent')) {
    notes.push('terminal-specialist: suppressed ask_agent because primary action tools are available');
  }
  if (terminalPrimaryAction) {
    let removedCrossSkill = 0;
    for (const name of [...keptNames]) {
      if (ALWAYS_TOOL_NAMES.has(name)) continue;
      const owner = owners[name];
      if (!owner || owner === primarySkill || TERMINAL_SUPPORT_SKILLS.has(owner)) continue;
      keptNames.delete(name);
      removedCrossSkill++;
    }
    if (removedCrossSkill) notes.push(`terminal-specialist: dropped ${removedCrossSkill} unrelated service tool${removedCrossSkill === 1 ? '' : 's'}`);
  }

  if (!notes.length) return { kept, notes };
  for (const d of decisions || []) {
    if (keptNames.has(d.name)) d.kept = true;
    else if (d.name === 'ask_agent' || owners[d.name] !== primarySkill) d.kept = false;
  }
  return {
    kept: (fullTools || kept || []).filter(t => keptNames.has(toolName(t))),
    notes,
  };
}

// Embed all global skill tools up front so the first real turn isn't paying the
// per-tool embed cost. Best-effort; per-user custom-skill tools fill in lazily.
export async function warmToolEmbeddings() {
  const start = Date.now();
  let n = 0;
  try {
    for (const m of listRoles()) {
      for (const t of m?.tools ?? []) { await getToolVec(t); n++; }
    }
  } catch (e) { log.warn('tool-router', 'warm tool embeddings failed', { err: e.message }); }
  log.info('tool-router', 'warmed tool embeddings', { tools: n, ms: Date.now() - start });
}

/**
 * Trim the agent's tool list for this turn. Two stages:
 *   1. Skill-level gate (coordinators only): drop whole skills the turn doesn't
 *      need — always-on + intent-matched on-demand + held-role.
 *   2. Tool-level pass (every agent): narrow the surviving candidate set to the
 *      individual tools this message actually needs.
 * Pure: does not mutate the input agent.
 *
 * @returns {Promise<TrimResult>}
 */
export async function trimToolsForTurn({ agent, userText, userId, isolatedTaskRun = false }) {
  const fullTools = agent.tools ?? [];
  if (!fullTools.length) {
    return { trimmedTools: fullTools, fullTools, initiallyIncludedSkills: new Set(), routerNotes: ['skipped: no tools'] };
  }
  const notes = [];
  // Candidate set fed to the tool-level pass. Coordinators get a cross-skill
  // gate first; specialists hold their skills directly, so their full set is
  // the candidate.
  let candidate = fullTools;
  let keepSkills = new Set();

  if (agent.skillCategory === 'coordinator') {
    const owners = toolOwnerIndex(userId);
    const matched = await classifyOnDemandSkills(userText, userId, INITIAL_INCLUDE_THRESHOLD);
    // Held service roles always ship on the holder's turns (explicit claim_role
    // delegation), so a vague "ok do it" after a transfer can still act.
    const heldRoles = new Set(getAgentRoles(agent.id, userId));
    const forceHeldRoles = new Set([...heldRoles].filter(id => id === agent.skillCategory));
    for (const t of fullTools) {
      const ownerId = owners[t.function?.name];
      if (!ownerId) continue;
      if (isAlwaysOnSkill(ownerId, userId)) keepSkills.add(ownerId);
      else if (matched.has(ownerId))         keepSkills.add(ownerId);
      else if (forceHeldRoles.has(ownerId))  keepSkills.add(ownerId);
    }
    // Stable prefix (always-on/held/unknown-owner) + dynamic suffix (matched
    // on-demand) keeps the provider tool-cache prefix byte-stable across turns.
    const stableSegment = [];
    const dynamicSegment = [];
    for (const t of fullTools) {
      const ownerId = owners[t.function?.name];
      if (!ownerId) { stableSegment.push(t); continue; }
      if (!keepSkills.has(ownerId)) continue;
      if (isAlwaysOnSkill(ownerId, userId) || forceHeldRoles.has(ownerId)) stableSegment.push(t);
      else if (matched.has(ownerId)) dynamicSegment.push(t);
      else stableSegment.push(t);
    }
    candidate = [...stableSegment, ...dynamicSegment];
    notes.push(`skill-gate: kept ${candidate.length}/${fullTools.length} (${[...keepSkills].sort().join(',') || 'none'})`);
    if (heldRoles.size) notes.push(`held roles: ${[...heldRoles].join(',')}`);
  } else {
    notes.push(`specialist: ${fullTools.length} tools → tool-level candidate`);
  }

  // Tool-level pass — all agents.
  const cfg = toolRouterCfg();
  if (cfg.enabled) {
    const res = await scoreToolsForTurn({ tools: candidate, userText, userId, cfg });
    if (res.applied) {
      const terminal = adjustSpecialistTerminalTools({
        agent,
        userText,
        userId,
        kept: res.kept,
        fullTools,
        decisions: res.decisions,
        isolatedTaskRun,
      });
      const keptTools = terminal.kept;
      notes.push(...terminal.notes);
      const dropped = res.decisions.filter(d => !d.kept).map(d => d.name);
      notes.push(`tool-level: kept ${keptTools.length}/${candidate.length}`);
      if (dropped.length) notes.push(`dropped: ${dropped.slice(0, 14).join(',')}${dropped.length > 14 ? '…' : ''}`);
      // Empty initiallyIncludedSkills so request_tools can recover ANY dropped
      // tool, including one from an otherwise-kept skill (tool-level made
      // skill-inclusion partial; expandToolsByReason dedupes by current names).
      return { trimmedTools: keptTools, fullTools, initiallyIncludedSkills: new Set(), skillsKept: keepSkills, routerNotes: notes, toolDecisions: res.decisions };
    }
    notes.push('tool-level: not applied (embed unavailable/empty)');
  }
  return { trimmedTools: candidate, fullTools, initiallyIncludedSkills: keepSkills, routerNotes: notes };
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
  // Recoverable = the skills the agent actually carries (everything in
  // fullTools) PLUS on-demand skills it could pull in on intent. The tool-level
  // pass can drop tools from ALWAYS-ON skills too (web, self-mgmt, delegate…),
  // and request_tools must be able to recover those — not just on-demand ones,
  // which was the gap that made the "recover ANY dropped tool" contract false.
  const recoverable = new Set(dynamicOnDemand);
  for (const t of fullTools) {
    const owner = owners[t.function?.name];
    if (owner) recoverable.add(owner);
  }

  // Explicit group hint wins — LLM declared what it needs by name.
  if (Array.isArray(groups) && groups.length) {
    for (const g of groups) {
      if (typeof g === 'string' && recoverable.has(g)) targetSkills.add(g);
    }
  }

  // Embed-match the free-form reason against recoverable skills.
  if (typeof reason === 'string' && reason.trim().length >= 4) {
    try {
      const top = await classifyByEmbedding(reason, userId, /* coordAgentId */ null, { threshold: EXPANSION_THRESHOLD, gap: 0.0, includeUnassigned: true });
      if (top && recoverable.has(top.skillId)) targetSkills.add(top.skillId);
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
 * @param {{ userText?: string, assistantText?: string, userId?: string }} [args]
 */
export function inferMissingToolSkills({ userText = '', assistantText = '', userId } = {}) {
  const text = `${userText}\n${assistantText}`;
  const dynamicOnDemand = new Set([...ON_DEMAND_SKILL_IDS, ...getCustomAutoSkills(userId)]);
  const skills = new Set();
  for (const rule of DIRECT_INTENT_RULES) {
    if (dynamicOnDemand.has(rule.skillId) && rule.re.test(text)) skills.add(rule.skillId);
  }
  return skills;
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
export const _internal = { ALWAYS_INCLUDE_SKILL_IDS, ON_DEMAND_SKILL_IDS, INITIAL_INCLUDE_THRESHOLD, DIRECT_INTENT_RULES };
