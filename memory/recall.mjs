/**
 * Cortex recall — vector search with Ebbinghaus reranking, spaced repetition,
 * and soft-deletion (forget / forgetByText).
 */

import {
  UUID_RE, assertId, safeLanceVal, queuedWrite,
  calcRetention, recencyScore,
} from './shared.mjs';
import { embed } from './embedding.mjs';
import { getTable } from './lance.mjs';

// ── Temporal query detection ─────────────────────────────────────────────────
export const TEMPORAL_RE = /\b(yesterday|last (week|month|time|night|session)|earlier today|recently|the other day|few days ago|a while (back|ago)|before|back when|remember when|what did (we|i|you) (talk|discuss|say|mention|do)|previous(ly)?|ago|in the past|history|our (last|earlier|previous) (chat|conversation|session|discussion))\b/i;
const TIME_ANCHOR_RE = /\b(?:(?<days>\d+)\s*days?\s*ago|yesterday|last\s+(?<unit>week|month|night|session)|earlier\s+today)\b/i;

export function parseTimeAnchor(text) {
  const m = TIME_ANCHOR_RE.exec(text);
  if (!m) return null;
  const now = Date.now();
  if (m.groups?.days) return new Date(now - parseInt(m.groups.days) * 86_400_000);
  if (m[0].includes('yesterday')) return new Date(now - 86_400_000);
  if (m[0].includes('earlier today')) return new Date(now - 6 * 3_600_000);
  const unit = m.groups?.unit;
  if (unit === 'week') return new Date(now - 7 * 86_400_000);
  if (unit === 'month') return new Date(now - 30 * 86_400_000);
  if (unit === 'night') return new Date(now - 86_400_000);
  if (unit === 'session') return new Date(now - 2 * 86_400_000);
  return null;
}

// Build a SQL fragment that restricts user_facts to rows whose role_scope is
// empty (globally visible) or one of the roles the calling agent holds.
// Returns e.g. " AND (role_scope = '' OR role_scope IN ('nodes','email'))".
function scopeClause(myRoles) {
  if (!myRoles?.length) return " AND role_scope = ''";
  const list = myRoles.map(r => `'${safeLanceVal(r)}'`).join(',');
  return ` AND (role_scope = '' OR role_scope IN (${list}))`;
}

// ── recall — vector search with Ebbinghaus reranking ─────────────────────────
export async function recall({ agentId = 'main', type = 'episodes', query, queryVec: precomputedVec, topK = 5, includeShared = true, recencyBoost = false, timeAnchor = null, userId = 'default', myRoles = null }) {
  const queryVec = precomputedVec ?? await embed(query);
  const tableName = type === 'user_facts' ? 'user_facts' : `${agentId}_${type}`;
  const table = await getTable(tableName, userId);

  // When temporal, fetch more candidates for reranking; optionally filter by date
  const searchLimit = recencyBoost ? topK + 15 : topK + 5;
  const dateFilter = timeAnchor
    ? ` AND created_at >= '${safeLanceVal(new Date(timeAnchor.getTime() - 12 * 3_600_000).toISOString())}'`
    : '';
  // Role-scope filter only applies to user_facts (cross-agent shared table).
  // Other tables are agent-scoped by table name already.
  const scopeFilter = type === 'user_facts' ? scopeClause(myRoles) : '';

  const [immortals, semantic] = await Promise.all([
    table.query().where(`immortal = true AND forgotten = false${scopeFilter}`).toArray().catch(() => []),
    table.vectorSearch(queryVec).where(`immortal = false AND forgotten = false${dateFilter}${scopeFilter}`).limit(searchLimit).toArray().catch(() => []),
  ]);

  let sharedFacts = [];
  if (includeShared && type !== 'user_facts') {
    const sharedTable = await getTable('user_facts', userId);
    const sharedScope = scopeClause(myRoles);
    const [si, ss] = await Promise.all([
      sharedTable.query().where(`immortal = true AND forgotten = false${sharedScope}`).toArray().catch(() => []),
      sharedTable.vectorSearch(queryVec).where(`immortal = false AND forgotten = false${sharedScope}`).limit(3).toArray().catch(() => []),
    ]);
    sharedFacts = [...si, ...ss.slice(0, 3)];
  }

  const reranked = [...semantic, ...sharedFacts]
    .map(m => {
      const semSim = 1 - (m._distance || 0.5);
      const salience = m.salience_composite || 0.5;
      const retention = calcRetention(m);
      const confidence = m.confidence || 0.9;
      const recency = recencyScore(m.created_at || m.last_recalled_at || new Date().toISOString());
      // Temporal mode: recency 40%, semantic 25%, salience 20%, retention 10%, confidence 5%
      // Normal mode:   semantic 40%, salience 30%, retention 20%, confidence 10%
      const final_score = recencyBoost
        ? recency * 0.40 + semSim * 0.25 + salience * 0.20 + retention * 0.10 + confidence * 0.05
        : semSim  * 0.40 + salience * 0.30 + retention * 0.20 + confidence * 0.10;
      return { ...m, final_score };
    })
    .filter(m => calcRetention(m) > 0.08)
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, topK);

  // Update recall stats (strengthens memory via spacing effect)
  reranked.forEach(m => {
    if (!UUID_RE.test(m.id)) return; // skip legacy non-UUID IDs
    const tName = m.agent_id === 'shared' ? 'user_facts' : `${m.agent_id}_${type}`;
    queuedWrite(tName, async () => {
      const t = await getTable(tName, userId);
      await t.update({
        where: `id = '${assertId(m.id)}'`,
        values: {
          recall_count: (m.recall_count || 0) + 1,
          stability: (m.stability || 24) * 1.8,
          retention_score: 1.0,
          last_recalled_at: new Date().toISOString(),
        }
      }).catch(e => console.debug('[cortex] LanceDB update error:', e.message));
    });
  });

  const immortalIds = new Set(immortals.map(m => m.id));
  return [...immortals, ...reranked.filter(m => !immortalIds.has(m.id))].slice(0, topK + immortals.length);
}

// ── spaced repetition ────────────────────────────────────────────────────────
export async function getDueReviews({ agentId = 'main', type = 'params', userId = 'default', limit = 10 }) {
  const tableName = `${agentId}_${type}`;
  const table = await getTable(tableName, userId);
  const now = new Date().toISOString();
  try {
    const all = await table.query()
      .where(`forgotten = false AND next_review_at != '' AND next_review_at <= '${safeLanceVal(now)}'`)
      .limit(limit * 3)  // over-fetch to allow filtering
      .toArray();
    // Filter to tutor categories and sort by most overdue
    return all
      .filter(m => m.category?.startsWith('tutor_'))
      .sort((a, b) => a.next_review_at.localeCompare(b.next_review_at))
      .slice(0, limit);
  } catch { return []; }
}

// Rating-to-stability multipliers (Anki-style). Used when rating is explicitly
// provided (e.g. from flashcard self-rating widget). Legacy callers without a
// rating get the historical behavior: always strengthen by 1.8×.
const RATING_MULTIPLIERS = { again: 0.5, hard: 1.0, good: 1.8, easy: 2.5 };

export async function updateReviewSchedule({ agentId = 'main', type = 'params', memoryId, userId = 'default', rating = null, correct = null }) {
  const tableName = `${agentId}_${type}`;
  const table = await getTable(tableName, userId);
  const id = assertId(memoryId);
  // Fetch current record to get stability
  const rows = await table.query().where(`id = '${id}'`).limit(1).toArray().catch(() => []);
  if (!rows.length) return null;
  const m = rows[0];
  // Pick stability multiplier:
  //  - explicit rating: use table above
  //  - explicit correct=false: treat as 'again' (weaken)
  //  - otherwise (legacy call or correct=true): preserve historical 1.8× strengthening
  let multiplier = 1.8;
  if (rating && RATING_MULTIPLIERS[rating]) multiplier = RATING_MULTIPLIERS[rating];
  else if (correct === false) multiplier = RATING_MULTIPLIERS.again;
  const newStability = Math.max(1, (m.stability || 24) * multiplier);
  // Next review at ~60% retention: solve e^(-t/S) = 0.6 => t = S * 0.51
  const hoursUntilReview = newStability * 0.51;
  const nextReview = new Date(Date.now() + hoursUntilReview * 3_600_000).toISOString();
  await queuedWrite(tableName, () => table.update({
    where: `id = '${id}'`,
    values: {
      recall_count: (m.recall_count || 0) + 1,
      stability: newStability,
      retention_score: rating === 'again' || correct === false ? 0.5 : 1.0,
      last_recalled_at: new Date().toISOString(),
      next_review_at: nextReview,
    }
  }));
  return { newStability, nextReview, recallCount: (m.recall_count || 0) + 1, multiplier };
}

// ── forget — soft delete ─────────────────────────────────────────────────────
export async function forget({ agentId = 'main', type = 'episodes', exactId, userId = 'default' }) {
  if (!exactId) return { refused: true };
  const tableName = `${agentId}_${type}`;
  const table = await getTable(tableName, userId);
  assertId(exactId);
  const rows = await table.query().where(`id = '${exactId}'`).toArray().catch(() => []);
  if (rows[0]?.immortal) return { refused: true, reason: 'Immortal — cannot forget.' };
  await queuedWrite(tableName, () => table.update({ where: `id = '${exactId}'`, values: { forgotten: true } }));
  return { forgotten: true, id: exactId };
}

// ── forgetByText — semantic search then soft-delete matching memories ───────
// By default, immortal memories are protected. Set includeImmortal: true when
// the caller explicitly wants to remove pinned facts (e.g. the forget_fact tool).
export async function forgetByText({ agentId = 'main', text, userId = 'default', includeImmortal = false }) {
  const tableNames = [
    `${agentId}_params`,
    `${agentId}_episodes`,
    'user_facts',
  ];
  const whereClause = includeImmortal
    ? 'forgotten = false'
    : 'forgotten = false AND immortal = false';
  let totalForgotten = 0;
  const forgottenTexts = [];
  for (const tableName of tableNames) {
    try {
      const table = await getTable(tableName, userId);
      const vec = await embed(text);
      const hits = await table.vectorSearch(vec).where(whereClause).limit(5).toArray().catch(() => []);
      for (const hit of hits) {
        // Only forget if the memory is semantically close (distance < 0.35)
        if ((hit._distance ?? 1) < 0.35) {
          await queuedWrite(tableName, () =>
            table.update({ where: `id = '${assertId(hit.id)}'`, values: { forgotten: true } })
          );
          totalForgotten++;
          forgottenTexts.push(hit.text);
        }
      }
    } catch (e) { console.warn('[cortex] forgetByText error for table', tableName + ':', e.message); }
  }
  return { forgotten: totalForgotten, texts: forgottenTexts };
}
