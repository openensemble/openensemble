/**
 * One-time backfill: scope the unscoped facts that older builds wrote before
 * memory got skill-scoped. Generic across users — it can't know which skill
 * originally produced a historical fact, so it matches each fact semantically
 * against the user's *assigned scopable skills* (service roles + custom
 * specialist skills) and assigns the clear winner, leaving anything ambiguous
 * shared. Conservative by design: a wrong scope HIDES a fact, so we only move a
 * fact when one skill both clears `threshold` and beats the runner-up by
 * `margin`. Idempotent (only touches role_scope='' rows) and reversible.
 *
 * Going forward, facts are scoped correctly at write time (see pinFact +
 * executeToolStreaming); this only cleans up the pre-existing backlog.
 */
import { embed } from './embedding.mjs';
import { getDb } from './lance.mjs';
import { getRoleAssignments, isScopableSkill, getRoleManifest, loadRoleManifests } from '../roles.mjs';

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Meta/system roles make poor fact scopes (broad descriptions, not a domain) —
// exclude them as migration candidates even though they're "assigned".
const META_CATEGORIES = new Set(['system', 'delegate', 'meta']);
const META_IDS = new Set(['coordinator', 'oe-admin', 'oe-update-checker']);

async function skillVectors(userId) {
  const assignments = getRoleAssignments(userId);
  const out = [];
  for (const id of Object.keys(assignments)) {
    if (!isScopableSkill(id, userId)) continue;
    if (META_IDS.has(id)) continue;
    const man = getRoleManifest(id, userId);
    if (!man || META_CATEGORIES.has(man.category)) continue;
    const parts = [man.name, man.description, ...(man.intent_examples || []), ...(man.examples || [])].filter(Boolean);
    const text = parts.join('. ').slice(0, 2000);
    if (!text.trim()) continue;
    out.push({ id, vec: await embed(text) });
  }
  return out;
}

export async function migrateFactScopesForUser(userId, { apply = false, threshold = 0.40, margin = 0.05 } = {}) {
  await loadRoleManifests();
  const skills = await skillVectors(userId);
  if (!skills.length) return { userId, candidates: [], examined: 0, changes: [], applied: false, note: 'no scopable skills' };

  const db = await getDb(userId);
  let t;
  try { t = await db.openTable('user_facts'); }
  catch { return { userId, candidates: skills.map(s => s.id), examined: 0, changes: [], applied: false, note: 'no user_facts table' }; }

  const rows = (await t.query().limit(5000).toArray())
    .filter(r => r.forgotten === false && r.id !== '_init' && (!r.role_scope || r.role_scope === ''));

  const changes = [];
  for (const r of rows) {
    const fv = await embed(r.text || '');
    const scored = skills.map(s => ({ id: s.id, score: cosine(fv, s.vec) })).sort((a, b) => b.score - a.score);
    const best = scored[0], second = scored[1] || { score: 0 };
    const win = best && best.score >= threshold && (best.score - second.score) >= margin;
    changes.push({ id: r.id, to: win ? best.id : '', best: best?.id, score: +(best?.score ?? 0).toFixed(3),
                   second: second.id, secondScore: +(second.score ?? 0).toFixed(3), win,
                   text: (r.text || '').replace(/^FACT:\s*/, '').slice(0, 80) });
  }

  const winners = changes.filter(c => c.win);
  if (apply) {
    for (const c of winners) {
      try { await t.update({ where: `id = '${String(c.id).replace(/'/g, "''")}'`, values: { role_scope: c.to } }); }
      catch (e) { console.warn('[fact-scope-migration] update failed', c.id, e.message); }
    }
  }
  return { userId, candidates: skills.map(s => s.id), examined: rows.length, changes, winners: winners.length, applied: apply };
}
