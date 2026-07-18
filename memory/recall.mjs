/**
 * Cortex recall — vector search with Ebbinghaus reranking, spaced repetition,
 * and soft-deletion (forget / forgetByText).
 */

import {
  UUID_RE, assertId, safeLanceVal, queuedWrite,
  calcRetention, recencyScore, TOKEN_BUDGET,
} from './shared.mjs';
import { softForgetValues } from './forgotten-state.mjs';
import { embed } from './embedding.mjs';
import { getTable } from './lance.mjs';
import { getTurnContext } from '../lib/turn-abort-context.mjs';

// Upper bound on `stability` (hours). Recall multiplies stability by 1.8 each
// time; with no cap a hot memory grew geometrically until it overflowed JS
// doubles to Infinity. node-lancedb then serialized that into the UPDATE
// expression as a bare `Infinity` token, which Datafusion parsed as a COLUMN
// reference → "No field named Infinity", failing the write on every recall
// (and `new Date(Infinity).toISOString()` in the review path throws outright).
// 999999 is the codebase's existing "effectively immortal" stability sentinel
// (see lance.mjs initialStability / signals.mjs), so a heavily-recalled memory
// just asymptotes to permanent — the intended behavior — without overflowing.
const MAX_STABILITY = 999999;

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

// Immortal user_facts bypass the vector top-K (they're always injected), so a
// user who pins many facts inflates every prompt with no bound. Cap the set to
// a token budget, keeping the most salient (then most recently recalled) — the
// same way episodeHistory is trimmed in context.mjs.
function capImmortalFacts(rows, tokenBudget) {
  if (!Array.isArray(rows) || rows.length <= 1) return rows;
  const sorted = rows.slice().sort((a, b) => {
    const sa = a.salience_composite ?? 0.5, sb = b.salience_composite ?? 0.5;
    if (sb !== sa) return sb - sa;
    return new Date(b.last_recalled_at || b.created_at || 0) - new Date(a.last_recalled_at || a.created_at || 0);
  });
  const budgetChars = Math.max(0, tokenBudget) * 4; // ~4 chars/token
  const kept = [];
  let used = 0;
  for (const m of sorted) {
    const cost = (m.text?.length || 0) + 1;
    if (kept.length && used + cost > budgetChars) break;
    kept.push(m);
    used += cost;
  }
  return kept;
}

// ── recall — vector search with Ebbinghaus reranking ─────────────────────────
// Retrieval remains identical in non-learning mode, but recall must not queue
// count/stability writes that can land after the owning turn has terminated.
export async function recall({ agentId = 'main', type = 'episodes', query, queryVec: precomputedVec = undefined, topK = 5, includeShared = true, recencyBoost = false, timeAnchor = null, userId = 'default', myRoles = null, suppressLearning = false }) {
  const readOnlyRecall = suppressLearning || getTurnContext()?.suppressLearning === true;
  const queryVec = precomputedVec ?? await embed(query);
  // A zero/empty query vector means embed() failed (usually a misconfigured
  // embed model). vectorSearch with a zero vector returns arbitrary "nearest"
  // rows by distance — injecting unrelated high-salience facts AND strengthening
  // them via the recall-stat update below. Detect it and skip semantic recall;
  // immortals (which don't need the query vector) still return normally.
  const queryVecBad = !queryVec?.length || queryVec.every(v => v === 0);
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
  const activeStatus = type === 'user_facts' ? " AND status != 'contradicted'" : '';
  // Empty: inline contradiction/supersede was reverted (see memory/lance.mjs)
  // because auto-superseding from the small contradiction head could silently
  // hide legitimate/pinned facts. Nothing sets superseded_by on the fact path
  // anymore, so recall does not filter on it. Kept as a spliced-in clause so a
  // future, safe supersede design can re-enable it in one place.
  const notSuperseded = "";

  let [immortals, semantic] = await Promise.all([
    table.query().where(`immortal = true AND forgotten = false${activeStatus}${notSuperseded}${scopeFilter}`).toArray().catch(() => []),
    queryVecBad
      ? Promise.resolve([])
      : table.vectorSearch(queryVec).where(`immortal = false AND forgotten = false${activeStatus}${notSuperseded}${dateFilter}${scopeFilter}`).limit(searchLimit).toArray().catch(() => []),
  ]);
  // Cap pinned facts so a heavily-pinned user doesn't blow up every prompt.
  if (type === 'user_facts') immortals = capImmortalFacts(immortals, TOKEN_BUDGET.userContext);

  let sharedFacts = [];
  if (includeShared && type !== 'user_facts') {
    const sharedTable = await getTable('user_facts', userId);
    const sharedScope = scopeClause(myRoles);
    const [si, ss] = await Promise.all([
      sharedTable.query().where(`immortal = true AND forgotten = false AND status != 'contradicted'${notSuperseded}${sharedScope}`).toArray().catch(() => []),
      queryVecBad
        ? Promise.resolve([])
        : sharedTable.vectorSearch(queryVec).where(`immortal = false AND forgotten = false AND status != 'contradicted'${notSuperseded}${sharedScope}`).limit(3).toArray().catch(() => []),
    ]);
    sharedFacts = [...capImmortalFacts(si, TOKEN_BUDGET.userContext), ...ss.slice(0, 3)];
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

  // Normal recalls strengthen memory via the spacing effect. Verifier reads
  // return the same ranking without turning observation into a queued write.
  if (!readOnlyRecall) {
    reranked.forEach(m => {
      if (!UUID_RE.test(m.id)) return; // skip legacy non-UUID IDs
      const tName = m.agent_id === 'shared' ? 'user_facts' : `${m.agent_id}_${type}`;
      queuedWrite(tName, async () => {
        const t = await getTable(tName, userId);
        // Access frequency is not evidence that a fact is true. In particular,
        // repeatedly retrieving a stale personalization inference must not make
        // it progressively harder to correct or forget. Keep the spacing-effect
        // stability boost for episodic/parameter memories, but not user facts.
        const values = {
          recall_count: (m.recall_count || 0) + 1,
          retention_score: 1.0,
          last_recalled_at: new Date().toISOString(),
          ...(tName === 'user_facts' ? {} : {
            stability: Math.min(MAX_STABILITY, (m.stability || 24) * 1.8),
          }),
        };
        await t.update({
          where: `id = '${assertId(m.id)}'`,
          values,
        }).catch(e => console.debug('[cortex] LanceDB update error:', e.message));
      }, userId).catch(e => console.debug('[cortex] Recall update failed:', e.message));
    });
  }

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
  const newStability = Math.min(MAX_STABILITY, Math.max(1, (m.stability || 24) * multiplier));
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
  }), userId);
  return { newStability, nextReview, recallCount: (m.recall_count || 0) + 1, multiplier };
}

// ── forget — soft delete ─────────────────────────────────────────────────────
export async function forget({ agentId = 'main', type = 'episodes', exactId, userId = 'default', includeImmortal = false }) {
  if (!exactId) return { refused: true };
  const tableName = type === 'user_facts' ? 'user_facts' : `${agentId}_${type}`;
  const table = await getTable(tableName, userId);
  assertId(exactId);
  const rows = await table.query().where(`id = '${exactId}'`).toArray().catch(() => []);
  if (rows[0]?.immortal && !includeImmortal) return { refused: true, reason: 'Immortal — cannot forget.' };
  await queuedWrite(tableName, () => table.update({
    where: `id = '${exactId}'`, values: softForgetValues(),
  }), userId);
  await table.checkoutLatest?.();
  const verify = await table.query().where(`id = '${exactId}'`).limit(1).toArray().catch(() => []);
  if (verify[0] && verify[0].forgotten !== true) {
    throw new Error('Memory update did not persist.');
  }
  return { forgotten: true, id: exactId };
}

// ── forgetByText — semantic search then soft-delete matching memories ───────
// By default, immortal memories are protected. Set includeImmortal: true when
// the caller explicitly wants to remove pinned facts (e.g. the forget_fact tool).
const FORGET_MEMORY_TYPES = new Set(['params', 'episodes', 'user_facts']);
const PERSONALIZATION_FACT_SOURCES = new Set(['personalization', 'user_confirmed', 'user_corrected']);

function forgetTableNames(agentId, types) {
  const requested = types === undefined ? [...FORGET_MEMORY_TYPES] : types;
  if (!Array.isArray(requested)) return [];
  return [...new Set(requested)]
    .filter(type => FORGET_MEMORY_TYPES.has(type))
    .map(type => type === 'user_facts' ? type : `${agentId}_${type}`);
}

function ledgerStatementFromMemoryText(text) {
  return String(text || '').trim().replace(/^INFERRED:\s*/i, '');
}

export async function forgetByText({
  agentId = 'main', text, userId = 'default', includeImmortal = false, types = undefined,
}) {
  const tableNames = forgetTableNames(agentId, types);
  const whereClause = includeImmortal
    ? 'forgotten = false'
    : 'forgotten = false AND immortal = false';
  // Embed once, up front, and refuse to forget on a zero/empty vector. Without
  // this, a down/misconfigured embed model returns a zero vector whose
  // vectorSearch yields arbitrary "nearest" rows — and since includeImmortal
  // now deletes pinned facts, a bad embed could soft-delete unrelated pins.
  const vec = await embed(text);
  if (!vec?.length || vec.every(v => v === 0)) {
    console.warn('[cortex] forgetByText skipped — embed returned a zero vector (embed model unavailable?)');
    return { forgotten: 0, texts: [] };
  }
  let totalForgotten = 0;
  const forgottenTexts = [];
  for (const tableName of tableNames) {
    try {
      const table = await getTable(tableName, userId);
      const hits = await table.vectorSearch(vec).where(whereClause).limit(5).toArray().catch(() => []);
      const closeHits = hits.filter(hit => (hit._distance ?? 1) < 0.35);
      let ledgerApi = null;
      let ownedProfileIds = new Set();
      if (tableName === 'user_facts' && closeHits.length) {
        try {
          ledgerApi = await import('../lib/personalization/ledger.mjs');
          ownedProfileIds = new Set((await ledgerApi.listLedger(userId)).map(row => row.id));
        } catch (error) {
          console.warn('[cortex] personalization ledger unavailable during semantic forget:', error?.message || error);
        }
      }
      for (const hit of closeHits) {
        if (tableName === 'user_facts' && ownedProfileIds.has(hit.id)) {
          try {
            const forgotten = await ledgerApi.forgetLedgerRow(userId, hit.id, {
              reason: 'forgotten',
              expectedStatement: ledgerStatementFromMemoryText(hit.text),
            });
            if (forgotten) {
              totalForgotten++;
              forgottenTexts.push(hit.text);
            }
          } catch (error) {
            console.warn('[cortex] personalization forget transaction failed:', error?.message || error);
          }
          // Raw Cortex fallback would leave a live profile sidecar behind.
          continue;
        }
        if (tableName === 'user_facts' && PERSONALIZATION_FACT_SOURCES.has(hit.source)) {
          // A tagged row without exact readable ownership may be a crash
          // orphan or racing sidecar commit. It is already excluded from
          // personalization context; never create a Cortex/sidecar split via
          // raw fallback, regardless of whether the ledger read succeeded.
          continue;
        }
        await queuedWrite(
          tableName,
          () => table.update({ where: `id = '${assertId(hit.id)}'`, values: softForgetValues() }),
          userId,
        );
        totalForgotten++;
        forgottenTexts.push(hit.text);
      }
    } catch (e) { console.warn('[cortex] forgetByText error for table', tableName + ':', e.message); }
  }
  return { forgotten: totalForgotten, texts: forgottenTexts };
}
