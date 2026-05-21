/**
 * Per-skill trigger phrases — a side-file of natural-language phrasings that
 * should invoke a user-created skill, plus an embedding-indexed copy in
 * LanceDB so we can semantically rank triggers against the current user query
 * instead of injecting all of them into every system prompt.
 *
 * The "OE-better-than-Hermes" piece: Hermes uses author-specified keyword
 * triggers (brittle, doesn't scale past a few skills). OE accumulates each
 * user's *actual* phrasings AND ranks them semantically at retrieval time,
 * so prompt-block size stays constant regardless of how many skills the
 * user has accumulated.
 *
 * Storage:
 *   - users/<uid>/skills/<skillId>/triggers.json — authoritative list, colocated
 *     with the skill manifest (deleting the skill removes the file).
 *   - LanceDB table `skill_triggers` (per user) — vector index used by
 *     getRelevantTriggers for top-K ranking against the user's current query.
 *
 * Capped at MAX_TRIGGERS phrases per skill (most-recent kept). The LanceDB
 * mirror is best-effort — embed/insert is fire-and-forget; if the cortex
 * provider isn't healthy, buildTriggerNudgeBlock falls back to "show last 3
 * per skill" automatically.
 */
import fs from 'fs';
import path from 'path';
import { userSkillsDir } from './paths.mjs';

const MAX_TRIGGERS = 10;
const MAX_PHRASE_LEN = 200;
const TRIGGERS_TABLE = 'skill_triggers';

// Distance threshold for "this trigger is relevant to the current query".
// LanceDB returns lower-is-better cosine distances; corrections-to-rules
// uses 0.30, but trigger matching is fuzzier (one-shot phrasings vary widely
// in surface form) so we relax to 0.55. Tune in production based on whether
// the block over- or under-fires.
const TRIGGER_DISTANCE_THRESHOLD = 0.55;

function triggersPath(userId, skillId) {
  return path.join(userSkillsDir(userId), skillId, 'triggers.json');
}

export function loadTriggers(userId, skillId) {
  const p = triggersPath(userId, skillId);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

// Write phrase to triggers.json AND mirror to the LanceDB index. Returns true
// when the JSON layer accepted the phrase (caller's contract), false on dedup
// or missing skill dir. LanceDB write is fire-and-forget — if cortex is down,
// the JSON layer still carries the phrase and the all-triggers fallback in
// buildTriggerNudgeBlock will still surface it.
export function appendTrigger(userId, skillId, phrase) {
  const trimmed = (phrase || '').trim().slice(0, MAX_PHRASE_LEN);
  if (!trimmed) return false;
  const p = triggersPath(userId, skillId);
  const dir = path.dirname(p);
  // If the skill dir doesn't exist, the skill itself doesn't exist — silent
  // no-op rather than creating an orphan triggers.json that outlives a deleted
  // or never-created skill.
  if (!fs.existsSync(dir)) return false;

  let list = loadTriggers(userId, skillId);
  const key = trimmed.toLowerCase();
  if (list.some(t => t?.phrase?.toLowerCase() === key)) return false;
  list.push({ phrase: trimmed, ts: Date.now() });
  if (list.length > MAX_TRIGGERS) list = list.slice(-MAX_TRIGGERS);
  fs.writeFileSync(p, JSON.stringify(list, null, 2));

  // Fire-and-forget embed + LanceDB upsert. Inline import keeps cortex out of
  // the dependency chain for installs that disable memory features.
  (async () => {
    try {
      const { getTable } = await import('../memory/lance.mjs');
      const { embed } = await import('../memory/embedding.mjs');
      const table = await getTable(TRIGGERS_TABLE, userId);
      const vector = await embed(trimmed);
      // Skip writes for zero-vector embed failures — they pollute the index
      // and would dominate any cosine-search result.
      if (!vector?.length || vector.every(v => v === 0)) return;
      const row = {
        id: `trig_${skillId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: trimmed, vector,
        agent_id: skillId,         // reuse agent_id as the skillId scope (matches BASE_SCHEMA)
        source: 'trigger', category: 'trigger',
        confidence: 1.0, immortal: true, forgotten: false,
        salience_composite: 0.8, emotional_weight: 0.5,
        decision_weight: 0.5, uniqueness_score: 0.5,
        stability: 999, retention_score: 1.0, recall_count: 0,
        session_id: '', role: '', status: 'active', priority: 0.8,
        title: '', embed_model: '',
        created_at: new Date().toISOString(),
        last_recalled_at: new Date().toISOString(),
        superseded_by: '', enriched: true, next_review_at: '', role_scope: '',
      };
      await table.add([row]);
    } catch (e) {
      // Cortex unavailable / table create raced / embed timeout — fine. The
      // JSON file is authoritative; the LanceDB mirror is an optimisation.
      console.debug('[skill-triggers] embed-write skipped:', e.message);
    }
  })();

  return true;
}

// Remove all triggers for a skill — JSON file is deleted with the skill dir
// itself by skill-builder's handleDelete (rmSync(skillDir, recursive: true)),
// but the LanceDB rows persist unless we drop them explicitly. Called from
// handleDelete after the dir is gone.
export async function dropSkillTriggers(userId, skillId) {
  try {
    const { getTable } = await import('../memory/lance.mjs');
    const table = await getTable(TRIGGERS_TABLE, userId);
    // LanceDB delete by filter — SQL-ish syntax matching corrections-to-rules
    // cleanup pattern. agent_id holds the skillId in our schema.
    await table.delete(`agent_id = '${skillId.replace(/'/g, "''")}'`);
  } catch (e) {
    console.debug('[skill-triggers] LanceDB drop skipped:', e.message);
  }
}

// Walk users/<uid>/skills/<id>/triggers.json for every user skill. Returns
// { skillId: [phrases...] } with empty entries omitted. Used as the embedding
// fallback path in buildTriggerNudgeBlock.
export function getAllUserTriggers(userId) {
  const dir = userSkillsDir(userId);
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const triggers = loadTriggers(userId, entry.name);
    if (triggers.length > 0) out[entry.name] = triggers.map(t => t.phrase);
  }
  return out;
}

// Pick the newest skill directory created since startTime. Used by the
// skill-proposal accept handler to seed triggers.json on the skill the
// LLM-driven builder just created — we don't know the id the builder picked,
// so we scan by mtime.
export function findNewestSkillSince(userId, startTime) {
  const dir = userSkillsDir(userId);
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(dir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const stat = fs.statSync(manifestPath);
    if (stat.mtimeMs < startTime) continue;
    if (!best || stat.mtimeMs > best.mtime) best = { skillId: entry.name, mtime: stat.mtimeMs };
  }
  return best?.skillId ?? null;
}

// Cosine-search the user's trigger index for phrases most relevant to the
// current query. Returns up to `topK` { skillId, phrase, distance } entries,
// already-best-per-skill (we only keep the closest match per skill so the
// caller doesn't see five rows from the same skill). Distance is lower-is-
// better; entries beyond TRIGGER_DISTANCE_THRESHOLD are filtered out.
//
// Returns [] on no index / no matches / embedding failure — caller falls
// back to the static all-triggers path.
export async function getRelevantTriggers(userId, queryText, topK = 5) {
  if (!queryText || !queryText.trim()) return [];
  try {
    const { searchSimilar } = await import('../memory/lance.mjs');
    // Fetch more than topK so we can dedupe-by-skill and still hit the cap.
    const rows = await searchSimilar(TRIGGERS_TABLE, queryText, topK * 4, userId);
    if (!rows?.length) return [];
    const bestPerSkill = new Map();
    for (const r of rows) {
      const dist = typeof r._distance === 'number' ? r._distance : 1;
      if (dist > TRIGGER_DISTANCE_THRESHOLD) continue;
      const skillId = r.agent_id;
      if (!skillId || skillId.startsWith('_init')) continue;
      const prev = bestPerSkill.get(skillId);
      if (!prev || dist < prev.distance) {
        bestPerSkill.set(skillId, { skillId, phrase: r.text, distance: dist });
      }
    }
    return [...bestPerSkill.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK);
  } catch (e) {
    console.debug('[skill-triggers] retrieval failed:', e.message);
    return [];
  }
}

// One-call helper used by chat.mjs to build the per-turn system-prompt nudge.
// Tries embedding-ranked retrieval first; falls back to the static
// "last 3 phrases per skill" listing when the embedding head is unavailable
// or the user's index is empty. Returns '' when the user has no triggers at
// all — caller can skip the block entirely.
export async function buildTriggerNudgeBlock(userId, queryText) {
  // Embedding path — preferred when cortex is healthy + the user has phrased
  // anything semantically close to a known trigger.
  const ranked = await getRelevantTriggers(userId, queryText, 5);
  if (ranked.length > 0) {
    const lines = ranked.map(r =>
      `- \`${r.skillId}\` — closest past phrasing: "${r.phrase.replace(/"/g, "'").slice(0, 140)}"`
    );
    return `## Your custom skills — relevant to this request\n\n` +
      `Past phrasings the user has invoked these skills with. When the current request matches the pattern, prefer the skill over rebuilding the workflow with raw tool calls:\n` +
      lines.join('\n');
  }

  // Fallback: static all-triggers listing. Same shape as the agent-resolver
  // version we used to ship — kept so installs without a working embedding
  // head still get the nudge.
  const all = getAllUserTriggers(userId);
  const fallbackLines = [];
  for (const [skillId, phrases] of Object.entries(all)) {
    if (!phrases?.length) continue;
    const examples = phrases.slice(-3).map(p => `"${p.replace(/"/g, "'").slice(0, 120)}"`).join(', ');
    fallbackLines.push(`- \`${skillId}\` — invoked by: ${examples}`);
  }
  if (fallbackLines.length === 0) return '';
  return `## Your custom skills — example invocations\n\n` +
    `These are the user's own skills built from past workflows, with phrasings they've used. When the current request matches one of these patterns, prefer the skill over rebuilding the workflow with raw tool calls:\n` +
    fallbackLines.join('\n');
}
