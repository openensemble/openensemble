import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { instructionText } from './instruction-text.mjs';

const MAX_RECIPES = 120;
const MATCH_THRESHOLD = 0.58;
const MAX_LEARNED_TOOLS = 16;
const CONTROL_TOOLS = new Set(['ask_agent', 'request_tools']);
const SIDE_EFFECT_TOOL_RE = /(?:^|_)(?:compose|reply|send|create|update|delete|remove|add|set|call|run|execute|label|sort|purge|trash|mark|move|schedule|cancel|start|stop|install|patch|write|upload|download|watch)(?:_|$)/i;

// A recipe is only worth memorizing if the run that produced it actually SUCCEEDED
// at the task. A turn can finish without throwing yet still fail — e.g. a research
// specialist that searched an empty index, declared a "tooling limitation," and
// handed the job back to the coordinator. Banking that turn's tool list pins every
// future match to the exact toolset that does NOT work, and the learning loop then
// re-confirms the failure (the LG-Twins poison: recipes pinned to
// [research_search, list_research] with no web_search/fetch_url). This regex flags
// the unambiguous capability/incompletion phrasings agents emit when they fail or
// punt, so those turns are never learned. Kept conservative (task-failure verbs,
// not bare "couldn't find …") so a successful summary isn't misread as a failure —
// the structural `escalated`/`succeeded` signals carry the main load; this is a
// backstop. Under-learning a good recipe is cheap (the router still trims sanely
// next turn); learning a bad one poisons every retry.
const TURN_FAILURE_RE = /\b(?:tooling limitation|tool limitation|no (?:web|search|internet|tool) access|(?:could|can|was|were|did|does|do|is|are|am)(?:n'?t| not)(?: able to)? (?:complete|extract|retrieve|get|access|compile|pull|finish|produce|load|reach)|unable to (?:complete|extract|retrieve|get|access|compile|pull|finish|produce|load|reach)|(?:could|can|was|were|did|does|do|is|are|am|have|had)(?:n'?t| not) have (?:access|web|search|the tools?|tool access|any (?:web|search) tools?)|(?:was ?n'?t|was not|were ?n'?t|were not) provided|not provided (?:with )?(?:the )?(?:tools|web|search|access)|failed to (?:complete|extract|retrieve|get|access|compile|pull|finish|produce|load|reach)|handed (?:this|it|the (?:extraction|task|job|compilation|work)))/i;

function looksUnsuccessful(text) {
  return TURN_FAILURE_RE.test(String(text || ''));
}

function storePath(userId) {
  return path.join(USERS_DIR, userId, 'tool-plan-recipes.json');
}

function knownAgentIds(userId) {
  try {
    const p = path.join(USERS_DIR, userId, 'agents.json');
    if (!fs.existsSync(p)) return [];
    const agents = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(agents)
      ? agents.map(a => String(a?.id || '').trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function loadStore(userId) {
  try {
    const p = storePath(userId);
    if (!fs.existsSync(p)) return { version: 1, recipes: [] };
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { version: 1, recipes: normalizeRecipes(userId, Array.isArray(parsed.recipes) ? parsed.recipes : []) };
  } catch {
    return { version: 1, recipes: [] };
  }
}

function saveStore(userId, store) {
  const p = storePath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    version: 1,
    recipes: (store.recipes || []).slice(0, MAX_RECIPES),
  }, null, 2));
}

function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[^\w@.]+/g, ' ')
    .replace(/\b\d+\b/g, ' number ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phraseTokens(text) {
  const stop = new Set(['the', 'a', 'an', 'to', 'for', 'my', 'me', 'i', 'you', 'and', 'or', 'that', 'this', 'it', 'please']);
  return normalizePhrase(text).split(' ')
    .map(t => t.replace(/^[._-]+|[._-]+$/g, ''))
    .filter(t => t.length > 1 && !stop.has(t));
}

function tokenScore(a, b) {
  const at = new Set(phraseTokens(a));
  const bt = new Set(phraseTokens(b));
  if (!at.size || !bt.size) return 0;
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap++;
  return overlap / Math.max(at.size, bt.size);
}

function exampleVariants(text) {
  return [text, ...likelyOriginalPhrases(text)]
    .map(t => String(t || '').trim())
    .filter(Boolean);
}

function sameIntent(aExamples, bExamples) {
  const av = aExamples.flatMap(exampleVariants);
  const bv = bExamples.flatMap(exampleVariants);
  for (const a of av) {
    for (const b of bv) {
      if (tokenScore(a, b) >= 0.8) return true;
    }
  }
  return false;
}

function stableAgentId(agentId, userId) {
  const raw = String(agentId || '').trim();
  const prefix = `${userId}_`;
  const scoped = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (scoped.startsWith('ephemeral_') && userId) {
    const known = knownAgentIds(userId)
      .filter(id => scoped.endsWith(`_${id}`))
      .sort((a, b) => b.length - a.length)[0];
    if (known) return known;
  }
  return scoped;
}

function normalizeRecipes(userId, recipes) {
  const sorted = [...recipes]
    .filter(r => r && typeof r === 'object')
    .map(r => ({ ...r, agentId: stableAgentId(r.agentId, userId) }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const out = [];
  for (const rec of sorted) {
    const examples = Array.isArray(rec.examples) ? rec.examples : [];
    const existing = out.find(r => r.agentId === rec.agentId && sameIntent(r.examples || [], examples));
    if (!existing) {
      out.push({ ...rec, examples: examples.slice(0, 8) });
      continue;
    }
    const merged = [...(existing.examples || []), ...examples]
      .map(ex => String(ex || '').trim())
      .filter(Boolean);
    existing.examples = [...new Set(merged)].slice(0, 8);
    existing.createdAt = Math.min(existing.createdAt || existing.updatedAt || Date.now(), rec.createdAt || rec.updatedAt || Date.now());
  }
  return out.slice(0, MAX_RECIPES);
}

function cleanTools(tools) {
  return [...new Set((Array.isArray(tools) ? tools : [])
    .filter(t => typeof t === 'string')
    .map(t => t.trim())
    .filter(t => /^[A-Za-z0-9_.:-]{1,120}$/.test(t)))];
}

function actionTools(tools) {
  return cleanTools(tools).filter(t => !CONTROL_TOOLS.has(t)).slice(0, MAX_LEARNED_TOOLS);
}

function toolNamesFromEvents(events) {
  return cleanTools((Array.isArray(events) ? events : [])
    .filter(e => e?.status !== 'error')
    .map(e => e?.name));
}

function likelyOriginalPhrases(text) {
  const src = String(text || '');
  const out = [];
  const patterns = [
    /\b(?:user|shawn)\s+asked:\s*["“]([^"”]{8,240})["”]/ig,
    /\boriginal(?:\s+user)?\s+(?:request|message|task):\s*["“]?([^"”\n]{8,240})["”]?/ig,
    /\bexecute\s+[^:\n]{0,100}?\brequest\s+now:\s*([^.\n]{8,240})[.\n]/ig,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const phrase = String(m[1] || '').trim();
      if (phrase) out.push(phrase);
    }
  }
  return [...new Set(out)];
}

export function rememberToolPlan(userId, { agentId, phrase, selectedTools, mode = 'selected', source = 'user' } = {}) {
  if (!userId || !phrase || !agentId) return { ok: false, error: 'userId, agentId, and phrase are required' };
  const cleanMode = mode === 'none' ? 'none' : 'selected';
  const tools = cleanTools(selectedTools);
  if (cleanMode === 'selected' && !tools.length) return { ok: false, error: 'selectedTools are required' };
  const store = loadStore(userId);
  const targetAgentId = stableAgentId(agentId, userId);
  const norm = normalizePhrase(phrase);
  const existing = store.recipes.find(r =>
    stableAgentId(r.agentId, userId) === targetAgentId
      && (r.examples || []).flatMap(exampleVariants).some(ex => tokenScore(ex, norm) >= 0.8)
  );
  const rec = existing || {
    id: `tool_recipe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    agentId: targetAgentId,
    examples: [],
    createdAt: Date.now(),
  };
  rec.examples = [String(phrase).trim(), ...(rec.examples || []).filter(ex => normalizePhrase(ex) !== norm)].slice(0, 8);
  rec.mode = cleanMode;
  rec.selectedTools = tools;
  rec.source = String(source || 'user').slice(0, 80);
  rec.updatedAt = Date.now();
  if (!existing) store.recipes.unshift(rec);
  store.recipes = normalizeRecipes(userId, store.recipes);
  store.recipes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  saveStore(userId, store);
  return { ok: true, recipe: rec };
}

export function learnToolPlanFromTurn(userId, {
  agentId,
  phrase,
  usedToolNames,
  initiallyAvailableToolNames = [],
  fullToolNames = [],
  recoveredMissingTools = false,
  addedSkills = [],
  succeeded = true,
  escalated = false,
  outcomeText = '',
  source = 'auto-turn',
} = {}) {
  // Only memorize a recipe from a turn that actually SUCCEEDED at its task.
  // A turn can finish without throwing yet still fail — search an empty index,
  // declare a "tooling limitation," and hand the job back to the coordinator.
  // Banking that turn's tools pins every future match to the toolset that failed,
  // and the loop re-confirms it on each retry (the LG-Twins poison). Skip when the
  // caller reports failure (`succeeded:false`), the agent punted (`escalated`), or
  // the result text reads as an inability/handoff (TURN_FAILURE_RE).
  if (succeeded === false || escalated === true || looksUnsuccessful(outcomeText)) {
    return { ok: false, skipped: 'unsuccessful turn' };
  }
  // Key the recipe on the INSTRUCTION, not the full task — otherwise the stored
  // example carries that turn's payload (a day's briefing, a pasted doc) and
  // both pollutes future matching and lets unrelated tasks collide on shared
  // boilerplate. instructionText() is a no-op on an already-short directive.
  phrase = instructionText(phrase);
  const selectedTools = actionTools(usedToolNames);
  if (!userId || !agentId || !phrase || !selectedTools.length) {
    return { ok: false, skipped: 'insufficient workflow' };
  }

  const available = new Set(cleanTools(initiallyAvailableToolNames));
  const full = new Set(cleanTools(fullToolNames));
  const usedMissingInitially = selectedTools.some(t => !available.has(t));
  const usedKnownTools = full.size === 0 || selectedTools.every(t => full.has(t));
  const recovered = recoveredMissingTools === true
    || (Array.isArray(addedSkills) && addedSkills.length > 0)
    || usedMissingInitially;
  const learnableSingleTool = selectedTools.length === 1
    && SIDE_EFFECT_TOOL_RE.test(selectedTools[0]);
  if (selectedTools.length < 2 && !learnableSingleTool) {
    return { ok: false, skipped: 'single non-action workflow' };
  }

  // Learn multi-tool workflows generally, but never persist nonsense names
  // outside the agent's full surface when that surface is available.
  if (!usedKnownTools) return { ok: false, skipped: 'unknown tools' };

  const result = rememberToolPlan(userId, {
    agentId,
    phrase,
    selectedTools,
    mode: 'selected',
    source: recovered ? `${source}:recovered` : source,
  });
  return result.ok ? { ...result, learned: true, recovered } : result;
}

export function learnToolPlanFromToolEvents(userId, {
  agentId,
  phrase,
  toolEvents,
  resultText = '',
  succeeded = true,
  source = 'auto-background',
} = {}) {
  const usedToolNames = toolNamesFromEvents(toolEvents);
  // A delegated/worker run that called ask_agent handed the job off (escalated to
  // its coordinator, or re-delegated) — it did not complete the work itself, so
  // its tool list is not a success recipe. The result text is scanned too, so a
  // "couldn't do it" outcome with no ask_agent is still caught downstream.
  const escalated = (Array.isArray(toolEvents) ? toolEvents : [])
    .some(e => e?.name === 'ask_agent' && e?.status !== 'error');
  const phrases = [phrase, ...likelyOriginalPhrases(phrase)].filter(Boolean);
  const results = [];
  for (const p of [...new Set(phrases)]) {
    results.push(learnToolPlanFromTurn(userId, {
      agentId,
      phrase: p,
      usedToolNames,
      initiallyAvailableToolNames: [],
      fullToolNames: [],
      recoveredMissingTools: true,
      succeeded,
      escalated,
      outcomeText: resultText,
      source,
    }));
  }
  return results;
}

export function compactToolPlans(userId) {
  if (!userId) return { ok: false, error: 'userId is required' };
  const before = loadStore(userId);
  const recipes = normalizeRecipes(userId, before.recipes || []);
  saveStore(userId, { version: 1, recipes });
  return { ok: true, before: before.recipes?.length || 0, after: recipes.length };
}

/**
 * Drop every recipe that uses any of `toolNames` — called on skill deletion so a
 * removed skill's tools stop surfacing as learned recipes. Returns count removed.
 */
export function forgetToolPlansForTools(userId, toolNames = []) {
  if (!userId) return { ok: false, removed: 0 };
  const drop = new Set((toolNames || []).filter(Boolean));
  if (!drop.size) return { ok: true, removed: 0 };
  const store = loadStore(userId);
  const before = store.recipes.length;
  const kept = store.recipes.filter(r => !(Array.isArray(r.selectedTools) && r.selectedTools.some(t => drop.has(t))));
  if (kept.length !== before) saveStore(userId, { version: 1, recipes: kept });
  return { ok: true, removed: before - kept.length };
}

export function matchToolPlan(userId, { agentId, phrase } = {}) {
  if (!userId || !agentId || !phrase) return null;
  // Match instruction-to-instruction. Normalizing BOTH sides means a recipe
  // learned before this change (its example still holds the full payload) no
  // longer false-matches an unrelated task on shared boilerplate, and a clean
  // incoming directive matches a clean stored one.
  phrase = instructionText(phrase);
  const targetAgentId = stableAgentId(agentId, userId);
  let best = null;
  for (const rec of loadStore(userId).recipes) {
    if (stableAgentId(rec.agentId, userId) !== targetAgentId) continue;
    for (const ex of (rec.examples || []).flatMap(exampleVariants)) {
      const score = tokenScore(phrase, instructionText(ex));
      if (score < MATCH_THRESHOLD) continue;
      const currentIsNewerCloseMatch = best
        && (best.updatedAt || 0) > (rec.updatedAt || 0)
        && score <= best.score + 0.15;
      if (currentIsNewerCloseMatch) continue;
      const newerCloseMatch = best
        && score >= best.score - 0.15
        && (rec.updatedAt || 0) > (best.updatedAt || 0);
      if (!best || score > best.score || newerCloseMatch) best = { ...rec, agentId: targetAgentId, score };
    }
  }
  if (!best) return null;
  return {
    mode: best.mode === 'none' ? 'none' : 'selected',
    selectedTools: cleanTools(best.selectedTools),
    source: 'server-remembered',
    recipeId: best.id,
    score: best.score,
  };
}
