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
import { loadConfig } from '../routes/_helpers.mjs';
import { log } from '../logger.mjs';
import { instructionText } from './instruction-text.mjs';

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
  'role_tv_control', // tv_* tools — Android TV control, only on TV-shaped turns
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
    // TV vocabulary: launching apps/streaming services, playback transport,
    // volume, search, "show ... on the tv", and camera phrases ("show me the
    // front door"). Deliberately broad — overlaps role_home_assistant on
    // some phrases (e.g. "garage" only appears inside the camera-phrase
    // group below, never bare) and that's fine, multiple skills can load for
    // the same turn. NOTE: the "open/launch/..." and "pause/resume" groups
    // require actual app/media vocabulary (not a bare `\S+`/no-object match)
    // so generic sentences like "open the garage door" or "pause for a
    // second" don't false-positive into this skill; the "show me ..." group
    // requires genuine camera/TV vocabulary for the same reason — a bare
    // "show me the ..." must NOT match (that was the CRITICAL bug: it made
    // "show me the weather/news/calendar/report" all match). Mirrors
    // skills/role_tv_control/manifest.json's intent_patterns.
    skillId: 'role_tv_control',
    re: /\b(?:(?:open|launch|start|put\s+on|watch)\s+(?:netflix|youtube|hulu|disney(?:\+|\s*plus)?|plex|prime\s*(?:video)?|hbo|max|spotify|apple\s*tv)\b|netflix|youtube|hulu|disney(?:\+|\s*plus)?|plex|prime\s*video|on\s+the\s+tv|(?:the\s+)?tv('?s)?\s+volume|volume\s+(?:up|down)\s+on\s+(?:the\s+)?tv|mute\s+(?:the\s+)?tv|(?:pause|resume)\s+(?:the\s+)?(?:tv|show|movie)\b|play\s+the\s+(?:movie|show)|show\s+.+\s+on\s+the\s+tv|show\s+me\s+(?:who'?s\s+(?:at\s+the\s+door|there)\b|(?:the\s+)?(?:.*\bcamera\b|front\s+door|back\s+door|doorbell|driveway|garage|backyard|porch|patio|entryway))|what'?s\s+(?:playing|on)\s+(?:the\s+)?tv)\b/i,
  },
  {
    skillId: 'email',
    re: /\b(?:email|gmail|inbox|message|reply|send\s+(?:\w+\s+)?(?:an\s+)?email|mail)\b/i,
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
 *
 * Cached per user, keyed on a cheap signature of the manifest set rather than
 * on the listRoles() array itself: listRoles() rebuilds a fresh array (and
 * fresh element objects) on every call, so a WeakMap keyed on that array never
 * hit — the index was being rebuilt 3-4× per turn on the hot path. The
 * signature (skill id + tool count per manifest) is O(skills), far cheaper than
 * the O(skills × tools) index build, and shifts exactly when the mapping goes
 * stale: a skill added/removed, enabled/disabled (listRoles already drops
 * disabled skills), or its tool set resized. roles.mjs exposes no generation
 * counter to import, so the signature is computed here.
 */
const _toolOwnerCache = new Map(); // userId -> { sig, idx }
function toolOwnerIndex(userId) {
  const manifests = listRoles(userId);
  // Signature over each skill's id + its tool NAMES (not just count): the index
  // maps tool-name → skill, so a tool renamed/swapped at constant count must
  // invalidate the cache too. Still far cheaper than the O(skills×tools) index
  // build it gates (string concat vs object allocation + per-tool property set),
  // and only rebuilds when the mapping actually changes.
  let sig = '';
  for (const m of manifests) {
    sig += `${m.id}:`;
    if (m.tools) for (const t of m.tools) sig += `${t.function?.name ?? ''},`;
    sig += '|';
  }
  const key = userId ?? null;
  const cached = _toolOwnerCache.get(key);
  if (cached && cached.sig === sig) return cached.idx;
  const idx = Object.create(null);
  for (const m of manifests) {
    for (const t of (m.tools ?? [])) {
      const name = t.function?.name;
      if (name && !idx[name]) idx[name] = m.id;
    }
  }
  _toolOwnerCache.set(key, { sig, idx });
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
// ── Tool-level routing (borrowed-tool buckets, v2) ───────────────────────────
// v1 ranked ALL of an agent's tools by embedding similarity and kept a cluster.
// Same-skill descriptions cluster tightly ("every email tool says email"), so
// it could drop the agent's own action tool (email_compose on an email agent).
// The agent then concluded "I can't do this", escalated to the coordinator,
// which saw the role-holder and handed the task right back — a loop. Every
// shipped mitigation (terminal force-add, never-trim email_user, instruction-
// keyed scoring) was a band-aid on that backwards policy, and the trimmer was
// finally disabled in config.
//
// v2 inverts the policy: an agent's PRIMARY-skill tools are its identity and
// are NEVER trimmed — so it can never falsely conclude it lacks its own
// capability. Only borrowed universal surfaces are trim candidates, and only
// from explicit buckets where a miss is cheap and recoverable via
// request_tools:
//   - tasks (~15 tools)         — relevance-gated (regex OR embedding)
//   - self-mgmt admin half (5)  — relevance-gated (the memory trio always ships)
//   - desktop (8)               — desktop-app-origin turns keep them; other
//                                 origins keep them only on desktop intent
// Everything else always ships: control plane, primary skill, custom skills,
// tiny universals, unknown owners (MCP tools), and whatever the coordinator
// skill-gate admitted. Deliberate trade: predictable beats aggressive.

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

// The three trim buckets, gated by intent regex + request origin ONLY — fully
// deterministic. An embedding backup was measured and removed: on the bundled
// embedder, task-shaped phrases that dodge the regex ("ping me when the sun
// goes down" → 0.64) score inside the unrelated-noise band (0.50–0.66), so no
// floor separates them — the backup either kept everything or nothing. The
// regexes are deliberately broad (a false positive ships ~15 extra schemas
// once; a miss is recovered by request_tools + the prompt nudge). A regex hit
// keeps the WHOLE bucket — partial task/admin surfaces confuse the model more
// than they save.
const SELF_MGMT_MEMORY_TOOLS = new Set(['remember_fact', 'recall_facts', 'forget_fact']);
const BUCKET_INTENT_RE = {
  tasks: /\b(?:remind|forget|alarm|timer|task|to-?do|watch|monitor|notif|alert|schedul|autonomy|daily|weekly|hourly|every\s+(?:day|week|hour|morning|night|evening)|tomorrow|tonight|later|at\s+\d|ping\s+me|let\s+me\s+know|keep\s+an\s+eye|wake\s+me)/i,
  selfMgmtAdmin: /\b(?:rule|rules|without\s+confirm|claim|role)\b/i,
  desktop: /\b(?:desktop|sandbox|my\s+(?:computer|machine|pc|laptop)|local\s+file)\b/i,
};

// Config (config.json → toolRouter.*), read fresh each turn so live tuning
// during testing doesn't need a restart. v2's bucket gates are deterministic
// (regex + origin), so the only knob is the on/off flag.
export function toolRouterCfg() {
  const c = loadConfig()?.toolRouter ?? {};
  return {
    enabled: c.toolLevel !== false,                // default ON for all agents
  };
}

// Cache-stable-prefix gate (experiment). Only the openai-oauth (Codex) path
// sends prompt_cache_key, so only there does a byte-stable tool+SPA prefix turn
// into real cross-turn prompt-cache hits. When toolRouter.cacheStablePrefix is
// on, trimToolsForTurn ships the full set unchanged so the `instructions` and
// `tools` the provider sees are identical turn-to-turn (no trim, no SPA
// recompose). Read fresh each turn; default off — flip it on to A/B against the
// current trim-every-turn behavior on latency, not just hit-rate.
export function shouldPreserveCachePrefix(agent) {
  if (agent?.provider !== 'openai-oauth') return false;
  return loadConfig()?.toolRouter?.cacheStablePrefix === true;
}

// Apply the bucket policy to a candidate tool list. Returns kept tools
// (original order) + per-tool decisions for logging/preview. Fully
// deterministic; fail-open on anything it can't classify (unknown owner →
// keep). A dropped bucket tool is always recoverable via request_tools.
export async function scoreToolsForTurn({ tools, userText, userId, agent, source, cfg }) {
  cfg = cfg || toolRouterCfg();
  const decisions = [];
  if (!cfg.enabled || !tools?.length) {
    return { kept: tools ?? [], decisions, applied: false };
  }
  const owners = toolOwnerIndex(userId);
  const primarySkill = (agent?.skillCategory && agent.skillCategory !== 'coordinator')
    ? agent.skillCategory : null;
  const customSkills = new Set(listRoles(userId).filter(m => m.custom === true).map(m => m.id));

  // Gate the buckets on the INSTRUCTION, not the whole message. A delegated
  // "set a reminder about this: <10 KB payload>" must match on the directive,
  // not drown in the pasted content.
  const directive = instructionText(userText || '');
  const bucketIntent = {
    tasks: BUCKET_INTENT_RE.tasks.test(directive),
    desktop: source === 'desktop-app' || BUCKET_INTENT_RE.desktop.test(directive),
    'self-mgmt': BUCKET_INTENT_RE.selfMgmtAdmin.test(directive),
  };

  const kept = [];
  for (const t of tools) {
    const name = toolName(t);
    const owner = owners[name];
    let keep = true;
    let reason = 'default';
    if (ALWAYS_TOOL_NAMES.has(name)) reason = 'control';
    else if (!owner) reason = 'unowned';                       // MCP + dynamic tools
    else if (primarySkill && owner === primarySkill) reason = 'primary';
    else if (customSkills.has(owner)) reason = 'custom';
    else if (owner === 'self-mgmt' && SELF_MGMT_MEMORY_TOOLS.has(name)) reason = 'memory';
    else if (owner in bucketIntent) {
      keep = bucketIntent[owner];
      reason = keep ? 'bucket-intent' : 'bucket-drop';
    }
    decisions.push({ name, kept: keep, reason, control: reason === 'control' });
    if (keep) kept.push(t);
  }
  return { kept, decisions, applied: true };
}

function toolName(t) {
  return t?.function?.name || t?.name || '';
}

/**
 * Trim the agent's tool list for this turn. Two stages:
 *   1. Skill-level gate (coordinators only): drop whole skills the turn doesn't
 *      need — always-on + intent-matched on-demand + held-role.
 *   2. Tool-level pass (every agent): shed borrowed bucket tools
 *      (tasks / self-mgmt admin / desktop) the turn doesn't need. The agent's
 *      own primary-skill tools are never touched.
 * `source` is the request origin ('desktop-app' keeps desktop tools).
 * Pure: does not mutate the input agent.
 *
 * @returns {Promise<TrimResult>}
 */
export async function trimToolsForTurn({ agent, userText, userId, source = null }) {
  const fullTools = agent.tools ?? [];
  if (!fullTools.length) {
    return { trimmedTools: fullTools, fullTools, initiallyIncludedSkills: new Set(), routerNotes: ['skipped: no tools'] };
  }
  // Cache-stable mode: ship the full byte-stable set so the openai-oauth prompt
  // prefix stays identical across turns and the prompt_cache_key actually buys
  // cross-turn hits. Returning trimmedTools === fullTools keeps `changed` false
  // in the caller, so the SPA tier isn't recomposed either — the whole
  // `instructions` string stays stable. Trades ~N (cached-after-turn-1) tool-def
  // tokens for a stable prefix. skillsKept empty: nothing was gated out.
  if (shouldPreserveCachePrefix(agent)) {
    return { trimmedTools: fullTools, fullTools, initiallyIncludedSkills: new Set(), skillsKept: new Set(), routerNotes: [`cache-stable: trim skipped (${fullTools.length} tools)`] };
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

  // Tool-level pass — all agents. Bucket policy: primary skill untouchable,
  // only borrowed tasks/self-mgmt-admin/desktop tools are gated.
  const cfg = toolRouterCfg();
  if (cfg.enabled) {
    const res = await scoreToolsForTurn({ tools: candidate, userText, userId, agent, source, cfg });
    if (res.applied) {
      const dropped = res.decisions.filter(d => !d.kept).map(d => d.name);
      notes.push(`tool-level: kept ${res.kept.length}/${candidate.length}`);
      if (dropped.length) notes.push(`dropped: ${dropped.slice(0, 14).join(',')}${dropped.length > 14 ? '…' : ''}`);
      // Empty initiallyIncludedSkills so request_tools can recover ANY dropped
      // tool, including one from an otherwise-kept skill (tool-level made
      // skill-inclusion partial; expandToolsByReason dedupes by current names).
      return { trimmedTools: res.kept, fullTools, initiallyIncludedSkills: new Set(), skillsKept: keepSkills, routerNotes: notes, toolDecisions: res.decisions };
    }
    notes.push('tool-level: not applied (disabled/empty)');
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
