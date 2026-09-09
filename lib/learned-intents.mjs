// @ts-check
/**
 * Per-user LEARNED local-intent utterances (Phase 3 of the local cognition tier).
 *
 * When the local tier misses an utterance but the cloud LLM then calls a tool
 * that IS one of the user's localIntent tools (see lib/intent-learner.mjs), the
 * user is offered a `learned_intent` proposal. Accepting writes the missed
 * phrasing here, and lib/local-label.mjs `collectLocalIntents` merges these into
 * the intent's `utterances` so Tier-2 (nomic) matches them next time — no cloud.
 *
 * Mirrors lib/routing-overrides.mjs (the utterance→AGENT analogue): a per-user
 * JSON store + a `.deleted.log` sibling for undo. This is the utterance→TOOL
 * store. Additive + revertable: deleting the file restores manifest-only behavior.
 *
 * Shape (users/<id>/learned-intents.json):
 *   { "<skillId>": { "<intentId>": {
 *       tool, utterances: [<phrase>...], learnedAt, examples: [{utterance,args,ts}...]
 *   } } }
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';
import { recordProposalUndo, restoreProposalUndo } from './proposal-undo.mjs';

const MAX_UTTERANCES = 50;   // per intent — bound growth
const MAX_EXAMPLES = 10;

function storePath(userId) {
  return path.join(USERS_DIR, userId, 'learned-intents.json');
}
function deletedLogPath(userId) {
  return path.join(USERS_DIR, userId, 'learned-intents.deleted.log');
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/[''']/g, '').replace(/\s+/g, ' ');
}

/** Synchronous — called on the dispatch hot path by collectLocalIntents. {} on miss. */
export function loadLearnedIntents(userId) {
  if (!userId) return {};
  const obj = readJsonSafe(storePath(userId));
  return obj && typeof obj === 'object' ? obj : {};
}

/** Convenience: the learned utterance strings for one intent (empty array on miss). */
export function learnedUtterancesFor(userId, skillId, intentId) {
  const utts = loadLearnedIntents(userId)?.[skillId]?.[intentId]?.utterances;
  return Array.isArray(utts) ? utts : [];
}

/** Drop ALL learned utterances for a skill (used on skill deletion). Returns count of intents removed. */
export async function purgeSkillIntents(userId, skillId) {
  if (!userId || !skillId) return { ok: false, removed: 0 };
  return withLock(storePath(userId), () => {
    const obj = loadLearnedIntents(userId);
    if (!obj[skillId]) return { ok: true, removed: 0 };
    const removed = Object.keys(obj[skillId]).length;
    delete obj[skillId];
    saveStore(userId, obj);
    return { ok: true, removed };
  });
}

function saveStore(userId, obj) {
  const p = storePath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(obj, null, 2));
}

/**
 * Teach one phrasing for (skillId, intentId). Deduped by normalized text against
 * whatever is already learned. Returns { ok, added } (added=false if a duplicate).
 * @param {string} userId
 * @param {{skillId?:string, intentId?:string, tool?:string, utterance?:string, args?:any}} [opts]
 */
export async function addLearnedUtterance(userId, { skillId, intentId, tool, utterance, args } = {}) {
  if (!userId || !skillId || !intentId || !utterance) return { ok: false, error: 'bad args' };
  return addLearnedUtterances(userId, { skillId, intentId, tool, utterances: [utterance], args });
}

// A proposal's complete phrase set is one mutation, so its receipt includes
// the original intent even when deduplication or retention removes phrases.
export async function addLearnedUtterances(userId, { skillId, intentId, tool, utterances, args = null }, { recordUndo = false } = {}) {
  if (!userId || !skillId || !intentId || !Array.isArray(utterances) || !utterances.length) {
    return { ok: false, error: 'bad args' };
  }
  const phrases = utterances.map(u => String(u ?? '').trim());
  if (phrases.some(phrase => !phrase)) return { ok: false, error: 'empty utterance' };
  return withLock(storePath(userId), () => {
    const obj = loadLearnedIntents(userId);
    const skill = obj[skillId] || (obj[skillId] = {});
    const before = structuredClone(skill[intentId] ?? null);
    const intent = skill[intentId] || (skill[intentId] = { tool: tool || null, utterances: [], learnedAt: Date.now(), examples: [] });
    if (tool && !intent.tool) intent.tool = tool;
    let added = false;
    for (const phrase of phrases) {
      const have = new Set((intent.utterances || []).map(normalize));
      if (!have.has(normalize(phrase))) {
        intent.utterances = [...(intent.utterances || []), phrase].slice(-MAX_UTTERANCES);
        intent.learnedAt = Date.now();
        added = true;
      }
      intent.examples = [...(intent.examples || []), { utterance: phrase, args: args || {}, ts: Date.now() }].slice(-MAX_EXAMPLES);
    }
    saveStore(userId, obj);
    return { ok: true, added,
      ...(recordUndo ? { undo: recordProposalUndo(storePath(userId), before, intent) } : {}) };
  });
}

export async function undoLearnedIntent(userId, skillId, intentId, receipt) {
  return withLock(storePath(userId), () => restoreProposalUndo(storePath(userId), receipt, before => {
    const obj = loadLearnedIntents(userId);
    if (before === null) {
      delete obj[skillId][intentId];
      if (Object.keys(obj[skillId]).length === 0) delete obj[skillId];
    } else {
      obj[skillId][intentId] = before;
    }
    saveStore(userId, obj);
  }));
}

/**
 * Revoke a learned mapping. With `utterance` → remove just that phrase; without
 * it → remove the whole intent's learned set. Appends to the .deleted.log first
 * (undo recovery), then prunes empty intent/skill objects.
 */
export async function removeLearnedUtterance(userId, skillId, intentId, utterance) {
  if (!userId || !skillId || !intentId) return { ok: false, error: 'bad args' };
  let removed = null;
  await withLock(storePath(userId), () => {
    const obj = loadLearnedIntents(userId);
    const intent = obj?.[skillId]?.[intentId];
    if (!intent) return;
    if (utterance) {
      const before = intent.utterances || [];
      const keep = before.filter(u => normalize(u) !== normalize(utterance));
      if (keep.length === before.length) return;   // nothing matched
      removed = { skillId, intentId, utterances: before.filter(u => normalize(u) === normalize(utterance)) };
      intent.utterances = keep;
      if (!keep.length) delete obj[skillId][intentId];
    } else {
      removed = { skillId, intentId, utterances: intent.utterances || [] };
      delete obj[skillId][intentId];
    }
    if (obj[skillId] && Object.keys(obj[skillId]).length === 0) delete obj[skillId];
    try {
      fs.appendFileSync(deletedLogPath(userId), JSON.stringify({ ts: Date.now(), entry: removed }) + '\n');
    } catch (e) { console.warn('[learned-intents] deleted-log write failed:', e.message); }
    saveStore(userId, obj);
  });
  return removed ? { ok: true, removed } : { ok: false, error: 'not found' };
}
