/**
 * LanceDB connections, base schema, fast write path, enrichment queue,
 * and the public `remember`/`pin` write API.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import {
  VECTOR_DIM, dbPath, assertId, queuedWrite, getCortexConfig,
  providerHealthy, initialStability,
} from './shared.mjs';
import { embed, scoreSalience, checkContradiction } from './embedding.mjs';

// Jailbreak-marker detection for child accounts. A child who socially-engineers
// the model shouldn't have that social-engineering persist in memory and re-inject
// on the next turn. We do NOT drop the write entirely (the conversation still
// happens) — we clamp salience so the record decays quickly instead of being
// promoted to stable long-term memory.
const JAILBREAK_MARKERS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|messages?)/i,
  /\byou\s+are\s+(?:now\s+)?(?:DAN|a\s+new|an\s+unrestricted|a\s+different|no\s+longer)/i,
  /\bno\s+restrictions?\b/i,
  /\bnew\s+persona\b/i,
  /\bpretend\s+(?:you\s+are|to\s+be)\b/i,
  /\broleplay\s+as\b/i,
  /\bjailbreak\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bas\s+an?\s+unrestricted\s+AI\b/i,
];
function looksLikeJailbreak(text) {
  if (!text || typeof text !== 'string') return false;
  return JAILBREAK_MARKERS.some(re => re.test(text));
}
function _readRoleForUser(userId) {
  if (!userId) return null;
  try {
    const p = path.join(USERS_DIR, userId, 'profile.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'))?.role ?? null;
  } catch { return null; }
}

// ── DB handle cache ──────────────────────────────────────────────────────────
const _dbs = new Map(); // userId → { db, lastUsed }
const DB_IDLE_MS = 30 * 60_000; // 30 minutes

export async function getDb(userId = 'default') {
  const entry = _dbs.get(userId);
  if (entry) { entry.lastUsed = Date.now(); return entry.db; }
  const lancedb = await import('@lancedb/lancedb');
  const db = await lancedb.connect(dbPath(userId));
  _dbs.set(userId, { db, lastUsed: Date.now() });
  return db;
}

/** Drop a cached DB handle — used after a destructive filesystem op (migration). */
export function invalidateDbCache(userId) {
  _dbs.delete(userId);
}

// Evict idle LanceDB connections every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of _dbs) {
    if (now - entry.lastUsed > DB_IDLE_MS) {
      _dbs.delete(userId);
      console.debug('[cortex] Evicted idle DB connection for', userId);
    }
  }
}, 10 * 60_000).unref?.();

// ── Base schema for table init ───────────────────────────────────────────────
export const BASE_SCHEMA = {
  id: '_init', text: '', vector: new Array(VECTOR_DIM).fill(0),
  agent_id: '', source: 'system', category: 'fact',
  confidence: 1.0, immortal: false,
  // The _init row is purely a schema seed — mark it forgotten so every query
  // (which filters `forgotten = false`) skips it. Otherwise its zero-vector
  // confuses vectorSearch distance scoring and the dedup check in remember()
  // bails out treating every new write as a near-duplicate of _init.
  forgotten: true,
  salience_composite: 0.5, emotional_weight: 0.5, decision_weight: 0.5, uniqueness_score: 0.5,
  stability: 72, retention_score: 1.0, recall_count: 0,
  session_id: '', role: '', status: 'active', priority: 0.5,
  title: '', embed_model: getCortexConfig().embedModel,
  created_at: new Date().toISOString(),
  last_recalled_at: new Date().toISOString(),
  superseded_by: '', enriched: true,
  next_review_at: '',
  // Empty string = visible to every agent. A role id (e.g. "nodes") means the
  // fact is only injected into agents that currently hold that role. Set at
  // pin time and filtered in recall (see recall.mjs).
  role_scope: '',
};

// Tracks (userId::tableName) entries where we've already verified the
// role_scope column exists — avoids retrying addColumns on every getTable call.
const _scopeColumnEnsured = new Set();

async function ensureRoleScopeColumn(table, userId, name) {
  const key = `${userId}::${name}`;
  if (_scopeColumnEnsured.has(key)) return;
  _scopeColumnEnsured.add(key);
  // addColumns throws if the column already exists — that's the expected path
  // for tables created after this migration landed. We swallow that error.
  try {
    await table.addColumns([{ name: 'role_scope', valueSql: "''" }]);
  } catch (e) {
    if (!/already exists|duplicate/i.test(e.message)) {
      console.debug('[cortex] role_scope column ensure skipped for', key + ':', e.message);
    }
  }
}

// Per-(userId, tableName) lock to prevent concurrent create races:
// if the table doesn't exist yet and two callers race, the first createTable
// wins; without serialization the second one would throw "already exists".
const _tableLocks = new Map();

export async function getTable(name, userId = 'default') {
  const db = await getDb(userId);
  // Fast path: table already exists
  let table;
  try { table = await db.openTable(name); } catch {}

  if (!table) {
    // Slow path: may need to create. Serialize per-(userId,name) to avoid races.
    const lockKey = `${userId}::${name}`;
    const prev = _tableLocks.get(lockKey) ?? Promise.resolve();
    const guard = prev.catch(() => {});
    const next = guard.then(async () => {
      // Re-check under the lock: another caller may have created it already
      try { return await db.openTable(name); } catch {}
      try { return await db.createTable(name, [{ ...BASE_SCHEMA, id: '_init_' + name }]); }
      catch { return await db.openTable(name); } // race lost but table is there now
    });
    _tableLocks.set(lockKey, next);
    try { table = await next; }
    finally { if (_tableLocks.get(lockKey) === next) _tableLocks.delete(lockKey); }
  }

  // One-time per-table migration: ensure role_scope column exists on existing
  // tables created before this feature landed. No-op after first call per table.
  await ensureRoleScopeColumn(table, userId, name);
  return table;
}

export async function searchSimilar(tableName, text, k = 6, userId = 'default') {
  const table = await getTable(tableName, userId);
  const vec = await embed(text);
  return table.vectorSearch(vec).where('forgotten = false').limit(k).toArray().catch(() => []);
}

// ── Fast write — embedding only, ~5ms, no LLM ────────────────────────────────
export async function rememberFast({ agentId = 'main', type = 'episodes', text,
    immortal = false, source = 'system', confidence = 0.9, metadata = {}, userId = 'default' }) {
  if (!text || text.trim().length < 8) return null; // skip blank / junk
  const tableName = type === 'user_facts' ? 'user_facts' : `${agentId}_${type}`;
  const table = await getTable(tableName, userId);
  const vector = await embed(text);
  const defaultSalience = immortal ? 1.0 : 0.5;

  const record = {
    id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    text, vector, agent_id: agentId, source, confidence, immortal,
    forgotten: false,
    salience_composite: defaultSalience,
    emotional_weight:   defaultSalience,
    decision_weight:    defaultSalience,
    uniqueness_score:   defaultSalience,
    stability: immortal ? 999999 : initialStability(defaultSalience),
    retention_score: 1.0, recall_count: 0,
    session_id: metadata.session_id || '',
    role: metadata.role || '',
    status: metadata.status || 'active',
    priority: metadata.priority || defaultSalience,
    title: metadata.title || '',
    embed_model: getCortexConfig().embedModel,
    created_at: new Date().toISOString(),
    last_recalled_at: new Date().toISOString(),
    superseded_by: '',
    category: metadata.category || type,
    enriched: false,
    role_scope: metadata.role_scope || '',
  };

  await queuedWrite(tableName, () => table.add([record]));
  return record;
}

// ── Enrichment queue — background salience scoring ───────────────────────────
const _enrichQueue   = [];
const ENRICH_MAX     = 500;
let   _enrichRunning = false;

export function queueEnrich(record, tableName, userId = 'default') {
  if (_enrichQueue.length >= ENRICH_MAX) {
    console.warn('[cortex] Enrichment queue full — dropping oldest entry');
    _enrichQueue.shift();
  }
  _enrichQueue.push({ record, tableName, userId });
  if (!_enrichRunning) drainEnrichQueue();
}

async function drainEnrichQueue() {
  if (_enrichRunning || _enrichQueue.length === 0) return;
  _enrichRunning = true;
  if (_enrichQueue.length === 1) await new Promise(r => setTimeout(r, 800));

  while (_enrichQueue.length > 0) {
    const job = _enrichQueue.shift();
    await rememberEnrich(job.record, job.tableName, job.userId ?? 'default');
    if (_enrichQueue.length > 0) await new Promise(r => setTimeout(r, 200));
  }
  _enrichRunning = false;
}

async function rememberEnrich(record, tableName, userId = 'default') {
  if (!await providerHealthy()) return; // skip if Ollama down
  try {
    const salience = await scoreSalience(record.text, { userId, agentId: record.agent_id });
    let supersededBy = '';

    if (record.category !== 'episodes') {
      const similar = await searchSimilar(tableName, record.text, 3, userId);
      const contradiction = await checkContradiction(record.text, similar.filter(m => m.id !== record.id), { userId, agentId: record.agent_id });
      if (contradiction.contradicts && contradiction.conflicting_id) {
        supersededBy = contradiction.conflicting_id;
        const t = await getTable(tableName, userId);
        await queuedWrite(tableName, () =>
          t.update({ where: `id = '${assertId(contradiction.conflicting_id)}'`,
            values: { superseded_by: record.id } }).catch(e => console.debug('[cortex] LanceDB update error:', e.message))
        );
      }
    }

    const table = await getTable(tableName, userId);
    await queuedWrite(tableName, () =>
      table.update({
        where: `id = '${assertId(record.id)}'`,
        values: {
          salience_composite: salience.composite,
          emotional_weight:   salience.emotional_weight,
          decision_weight:    salience.decision_weight,
          uniqueness_score:   salience.uniqueness,
          stability:          initialStability(salience.composite),
          priority:           salience.composite,
          superseded_by:      supersededBy,
          enriched:           true,
        }
      }).catch(e => console.debug('[cortex] LanceDB update error:', e.message))
    );

    // Post-enrichment GC: soft-delete truly unimportant episodes
    if (record.category === 'episodes' && salience.composite < 0.25) {
      await queuedWrite(tableName, () =>
        table.update({ where: `id = '${assertId(record.id)}'`, values: { forgotten: true } })
          .catch(e => console.debug('[cortex] Episode GC error:', e.message))
      );
    }
  } catch (e) {
    console.warn('[cortex] enrichment failed:', e.message);
  }
}

// ── remember — public write API ──────────────────────────────────────────────
export async function remember({
  agentId = 'main', type = 'episodes', text,
  immortal = false, source = 'user_stated', confidence = 0.9, metadata = {}, userId = 'default'
}) {
  const tableName = type === 'user_facts' ? 'user_facts' : `${agentId}_${type}`;

  // Child accounts: never let a jailbreak fact become immortal / stable. Drop
  // immortality, force low salience so the record decays within hours rather
  // than amplifying the jailbreak across sessions.
  const isChild = _readRoleForUser(userId) === 'child';
  const jailbreak = isChild && looksLikeJailbreak(text);
  if (jailbreak) {
    immortal = false;
    metadata = { ...metadata, priority: 0.1 };
  }

  // Episodes: write immediately, score in background
  if (type === 'episodes' && !immortal) {
    const record = await rememberFast({ agentId, type, text, immortal, source, confidence, metadata, userId });
    if (jailbreak && record) {
      // Skip enrichment — don't let the background scorer re-promote this.
      return record;
    }
    queueEnrich(record, tableName, userId);
    return record;
  }

  // Params / immortals / facts: score inline (accuracy matters more than speed)
  const table = await getTable(tableName, userId);
  const salience = immortal
    ? { composite: 1.0, emotional_weight: 1.0, decision_weight: 1.0, uniqueness: 1.0 }
    : (await providerHealthy() ? await scoreSalience(text, { userId, agentId }) : { composite: 0.7, emotional_weight: 0.7, decision_weight: 0.7, uniqueness: 0.5 });
  const vector = await embed(text);

  // Abort when embed() returned a zero vector — usually means the configured
  // embed model is wrong (e.g. a chat model was picked for Embed in Settings).
  // Writing with a zero vector would (a) make every subsequent write collide
  // with this record at distance=0 via the dedup check below, and (b) pollute
  // the table with unsearchable rows. Fail loud instead.
  if (vector.length && vector.every(v => v === 0)) {
    console.warn('[cortex] Refusing to write fact — embed() returned a zero vector. Check Settings → System → Embed model.');
    throw new Error('Embedding failed (zero vector). Check cortex embed model configuration.');
  }

  // Dedup check for non-episodes. Threshold trade-off:
  //   < 0.05 = essentially exact match — misses paraphrases like
  //     "Shawn prefers plain English" vs "I prefer plain English, never markdown".
  //   < 0.12 = same semantic meaning with different wording — catches the
  //     paraphrase case without merging genuinely distinct facts.
  // If the existing match was forgotten, we'd already have skipped it via
  // the where(forgotten = false) filter.
  const existing = await table.vectorSearch(vector).where('forgotten = false').limit(3).toArray().catch(() => []);
  const dupThreshold = immortal ? 0.12 : 0.05;
  const dupHit = existing.find(r => (r._distance ?? 2) < dupThreshold);
  if (dupHit) return { ...dupHit, _dedupHit: true }; // near-duplicate — return existing, flag for caller

  const record = {
    id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    text, vector, agent_id: agentId, source, confidence, immortal,
    forgotten: false,
    salience_composite: salience.composite,
    emotional_weight:   salience.emotional_weight,
    decision_weight:    salience.decision_weight,
    uniqueness_score:   salience.uniqueness,
    stability: immortal ? 999999 : initialStability(salience.composite),
    retention_score: 1.0, recall_count: 0,
    session_id: metadata.session_id || '',
    role: metadata.role || '',
    status: metadata.status || 'active',
    priority: metadata.priority || salience.composite,
    title: metadata.title || '',
    embed_model: getCortexConfig().embedModel,
    created_at: new Date().toISOString(),
    last_recalled_at: new Date().toISOString(),
    superseded_by: '',
    category: metadata.category || type,
    enriched: true,
    next_review_at: metadata.next_review_at || '',
    role_scope: metadata.role_scope || '',
  };

  await queuedWrite(tableName, () => table.add([record]));
  return record;
}

// ── pin — immortal memory (never decays, never forgotten) ────────────────────
export async function pin({ agentId = 'main', type = 'params', text, category = 'rule', userId = 'default', roleScope = '' }) {
  return remember({
    agentId, type, text, immortal: true, source: 'user_stated', confidence: 1.0,
    metadata: { category, role_scope: roleScope }, userId,
  });
}
