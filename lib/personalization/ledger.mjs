// @ts-check
/**
 * Memory writes for inferred facts + reflect.mjs's write-side sidecar CRUD.
 *
 * Per ADDENDUM E, memory/lance.mjs's remember()/pin() metadata only accepts a
 * FIXED set of keys (session_id, role, status, priority, title, category,
 * next_review_at, role_scope, host_scope) — a free-form tier/evidence/flag
 * WILL NOT persist on the cortex row. So the cortex write (via remember(),
 * agentId:'shared', type:'user_facts', text "INFERRED: <statement>") only
 * ever carries the statement itself; tier/evidence/provenance live entirely
 * in the SIDECAR at users/<uid>/personalization/ledger.json:
 *   { version, updated_at, rows: [{ id: <cortex row id>, statement, tier:
 *     'inferred'|'confirmed', evidence: [...], flag?, offerKind?, confidence?,
 *     createdAt, confirmedAt? }] }
 *
 * routes/personalization.mjs owns the UI-facing sidecar CRUD (list/confirm/
 * delete/start-fresh) as its OWN inline read-modify-write, using the exact
 * same file shape and the exact same io-lock key — this module's sidecar
 * helpers below are the WRITE side reflect.mjs uses to record new inferences,
 * reinforcements, and contradictions. Both sides serialize safely through the
 * shared withLock(path) registry in routes/_helpers/io-lock.mjs since both
 * construct the identical path string.
 *
 * forgetInferredRow (CONTRACTS v1.2 #3) is the one export routes/
 * personalization.mjs calls directly — and per that route's own division of
 * labor, it ONLY soft-forgets the cortex `user_facts` row; the route removes
 * the sidecar entry itself (DELETE / start-fresh handlers), so this function
 * must not also touch ledger.json (that would just be a redundant write, but
 * a needless one — the route's own write always follows immediately after).
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';
import { getTable, remember } from '../../memory/lance.mjs';
import { queuedWrite, assertId } from '../../memory/shared.mjs';

const MAX_STABILITY = 999998; // never the 999999 immortal sentinel (recall.mjs overflow lesson)
const REINFORCE_MULTIPLIER = 1.5;
const MAX_EVIDENCE = 20;

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}
function ledgerPath(userId) {
  return path.join(personalizationDir(userId), 'ledger.json');
}

/** Read the raw envelope (no lock — callers that mutate go through modifyLedger). */
function readLedgerFile(userId) {
  const p = ledgerPath(userId);
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      version: Number.isInteger(obj?.version) ? obj.version : 0,
      rows: Array.isArray(obj?.rows) ? obj.rows : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[personalization] ledger read failed for ${userId}: ${e.message}`);
    return { version: 0, rows: [] };
  }
}
function readLedgerRows(userId) {
  return readLedgerFile(userId).rows;
}

/**
 * Read-modify-write the rows array under the shared per-file lock (same lock
 * key as routes/personalization.mjs's own sidecar writer, so the two never
 * interleave). `mutator(rows)` returns whatever the caller wants back.
 */
function modifyLedger(userId, mutator) {
  const p = ledgerPath(userId);
  return withLock(p, () => {
    const file = readLedgerFile(userId);
    const result = mutator(file.rows);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    atomicWriteSync(p, JSON.stringify({ version: file.version + 1, updated_at: Date.now(), rows: file.rows }, null, 2));
    return result;
  });
}

function newRow(overrides) {
  return {
    id: null, statement: '', tier: 'inferred', evidence: [], flag: null, offerKind: null,
    confidence: null, createdAt: new Date().toISOString(), confirmedAt: null,
    ...overrides,
  };
}

function mergeEvidence(existing, incoming) {
  const set = new Set([...(existing || []), ...(incoming || [])].map(String));
  return [...set].slice(0, MAX_EVIDENCE);
}

/** List non-forgotten sidecar rows (used by reflect.mjs to build the [EXISTING MEMORIES] prompt section). */
export async function listLedger(userId) {
  return readLedgerRows(userId);
}

async function bumpStability(userId, memoryId) {
  const table = await getTable('user_facts', userId);
  let id;
  try { id = assertId(memoryId); } catch { return false; }
  const rows = await table.query().where(`id = '${id}'`).limit(1).toArray().catch(() => []);
  if (!rows.length) return false;
  const next = Math.min(MAX_STABILITY, (rows[0].stability || 24) * REINFORCE_MULTIPLIER);
  await queuedWrite('user_facts', () => table.update({ where: `id = '${id}'`, values: { stability: next } }));
  return true;
}

/** Best-effort lookup of a cortex row's own text, for when we need to seed a sidecar row we've never seen before. */
async function fetchMemoryStatement(userId, memoryId) {
  try {
    const table = await getTable('user_facts', userId);
    const id = assertId(memoryId);
    const rows = await table.query().where(`id = '${id}'`).limit(1).toArray().catch(() => []);
    const text = rows[0]?.text;
    return typeof text === 'string' ? text.replace(/^INFERRED:\s*/, '') : '(existing memory)';
  } catch {
    return '(existing memory)';
  }
}

/**
 * Applies one Inference (reflect.mjs's reflection-output item) to cortex +
 * the sidecar, per its `verb`:
 *   - 'new'        → remember() the statement, mirror a fresh sidecar row.
 *     A dedup hit (remember() found a near-duplicate existing row) merges
 *     evidence into that row's sidecar entry instead of creating a new one.
 *   - 'reinforce'  → bump the target row's cortex stability (×1.5, clamped)
 *     and merge evidence into its sidecar row.
 *   - 'contradict' → sidecar-only: flag the target row 'contradicted'. Never
 *     auto-forgets — a human should look at it via the ledger UI.
 *
 * @param {string} userId
 * @param {{statement: string, confidence?: number, evidence?: string[], verb?: string, targetMemoryId?: string|null}} inference
 * @returns {Promise<{action: 'created'|'deduped'|'reinforced'|'contradicted'|'skipped', memoryId?: string, reason?: string}>}
 */
export async function applyInference(userId, inference) {
  const { statement, confidence = 0.7, evidence = [], verb = 'new', targetMemoryId = null } = inference || {};
  if (!userId || !statement) return { action: 'skipped', reason: 'missing userId or statement' };

  if (verb === 'reinforce' && targetMemoryId) {
    const ok = await bumpStability(userId, targetMemoryId).catch(e => {
      console.warn(`[personalization] applyInference: reinforce failed for ${targetMemoryId}: ${e.message}`);
      return false;
    });
    if (!ok) return { action: 'skipped', reason: 'reinforce target not found', memoryId: targetMemoryId };
    await modifyLedger(userId, rows => {
      let r = rows.find(x => x.id === targetMemoryId);
      if (!r) { r = newRow({ id: targetMemoryId, statement }); rows.push(r); }
      r.evidence = mergeEvidence(r.evidence, evidence);
      return r;
    }).catch(e => console.warn(`[personalization] applyInference: reinforce ledger write failed: ${e.message}`));
    return { action: 'reinforced', memoryId: targetMemoryId };
  }

  if (verb === 'contradict' && targetMemoryId) {
    const fallbackStatement = statement || await fetchMemoryStatement(userId, targetMemoryId);
    await modifyLedger(userId, rows => {
      let r = rows.find(x => x.id === targetMemoryId);
      if (!r) { r = newRow({ id: targetMemoryId, statement: fallbackStatement }); rows.push(r); }
      r.flag = 'contradicted';
      r.evidence = mergeEvidence(r.evidence, evidence);
      return r;
    }).catch(e => console.warn(`[personalization] applyInference: contradict ledger write failed: ${e.message}`));
    return { action: 'contradicted', memoryId: targetMemoryId };
  }

  // verb 'new' (default / fallback for a malformed verb+missing target).
  let record;
  try {
    record = await remember({
      agentId: 'shared', type: 'user_facts', text: `INFERRED: ${statement}`,
      immortal: false, source: 'personalization', confidence, metadata: { category: 'fact' }, userId,
    });
  } catch (e) {
    console.warn(`[personalization] applyInference: remember() failed: ${e.message}`);
    return { action: 'skipped', reason: e.message };
  }
  if (!record?.id) return { action: 'skipped', reason: 'remember() returned no record' };

  if (record._dedupHit) {
    await modifyLedger(userId, rows => {
      let r = rows.find(x => x.id === record.id);
      if (!r) { r = newRow({ id: record.id, statement, confidence }); rows.push(r); }
      r.evidence = mergeEvidence(r.evidence, evidence);
      return r;
    }).catch(e => console.warn(`[personalization] applyInference: dedup ledger write failed: ${e.message}`));
    return { action: 'deduped', memoryId: record.id };
  }

  await modifyLedger(userId, rows => {
    rows.push(newRow({ id: record.id, statement, evidence: evidence.slice(0, MAX_EVIDENCE), confidence }));
  }).catch(e => console.warn(`[personalization] applyInference: create ledger write failed: ${e.message}`));
  return { action: 'created', memoryId: record.id };
}

/**
 * Soft-forgets the cortex `user_facts` row (CONTRACTS v1.2 #3). Does NOT
 * touch the ledger.json sidecar — routes/personalization.mjs's DELETE and
 * start-fresh handlers remove the sidecar entry themselves right after
 * calling this, per its own documented division of labor.
 *
 * @param {string} userId
 * @param {string} memoryId
 * @returns {Promise<boolean>}
 */
export async function forgetInferredRow(userId, memoryId) {
  if (!userId || !memoryId) return false;
  let id;
  try { id = assertId(memoryId); } catch (e) {
    console.warn(`[personalization] forgetInferredRow: invalid id ${memoryId}: ${e.message}`);
    return false;
  }
  try {
    const table = await getTable('user_facts', userId);
    await queuedWrite('user_facts', () => table.update({ where: `id = '${id}'`, values: { forgotten: true } }));
    // queuedWrite swallows its own errors (logs + resolves) so a failed
    // LanceDB write wouldn't otherwise surface here — verify the row actually
    // flipped before reporting success, same pattern as recall.mjs's forget().
    await table.checkoutLatest?.();
    const verify = await table.query().where(`id = '${id}'`).limit(1).toArray().catch(() => []);
    return !verify.length || verify[0].forgotten === true;
  } catch (e) {
    console.warn(`[personalization] forgetInferredRow: lance update failed for ${userId}/${memoryId}: ${e.message}`);
    return false;
  }
}
