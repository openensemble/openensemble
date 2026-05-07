/**
 * Operation records — the audit trail for every write operation OE performs
 * on a managed node.
 *
 * Storage layout (per node, per user):
 *   users/<uid>/nodes/<nodeId>/
 *     activity.jsonl    one record per line, append-only, kept forever
 *     pinned.json       { pinnedOpIds: [...] } — snapshot retention overrides
 *     snapshots/        per-day directories of pre-state captures
 *
 * Invariants:
 *   1. activity.jsonl is append-only. Records are never edited or deleted.
 *      Mutations to op state (rollback invocation, pin changes) are expressed
 *      as new records or as separate index files, not by rewriting history.
 *   2. Every write operation produces one record. Failed and aborted ops
 *      still get a record so the audit trail is honest.
 *   3. rollback.invoked / invoked_at / invocation_op_id are *derived* on
 *      read by scanning for rollback ops that target this op. The fields
 *      stored at write time are only the static ones (rollback eligibility,
 *      method, expiry).
 *
 * This module is pure: schema + IO. The dispatcher, snapshot primitives, and
 * rollback logic live in sibling modules and call into here.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { USERS_DIR } from './paths.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_SNAPSHOT_TTL_DAYS = 30;

// ── path helpers ─────────────────────────────────────────────────────────────

export function nodeDir(userId, nodeId) {
  if (!userId || !nodeId) throw new Error('nodeDir: userId and nodeId required');
  return path.join(USERS_DIR, userId, 'nodes', nodeId);
}

export function activityLogPath(userId, nodeId) {
  return path.join(nodeDir(userId, nodeId), 'activity.jsonl');
}

export function snapshotsDir(userId, nodeId) {
  return path.join(nodeDir(userId, nodeId), 'snapshots');
}

export function pinnedPath(userId, nodeId) {
  return path.join(nodeDir(userId, nodeId), 'pinned.json');
}

export function ensureNodeDir(userId, nodeId) {
  const dir = nodeDir(userId, nodeId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(snapshotsDir(userId, nodeId), { recursive: true });
  return dir;
}

// ── id generation ────────────────────────────────────────────────────────────

// Format: op_<iso ts with : replaced>_<6 hex>. Sorts lexically by time.
// Used as both the record id and the snapshot file basename so they're trivially joinable.
export function generateOpId(now = Date.now()) {
  const iso = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `op_${iso}_${randomBytes(3).toString('hex')}`;
}

// ── schema validation ────────────────────────────────────────────────────────

const REQUIRED_TOP = ['id', 'ts', 'node_id', 'intent', 'operation', 'pre_state', 'execution', 'outcome', 'rollback'];
const VALID_OUTCOMES = new Set(['success', 'failure', 'partial', 'rolled_back', 'aborted']);
const VALID_RISK = new Set(['low', 'medium', 'high']);
const VALID_MECHANISMS = new Set(['http', 'config_file', 'cli', 'sqlite', 'mqtt', 'host_snapshot', 'noop']);
const VALID_ROLLBACK_METHODS = new Set(['http', 'config_file', 'cli', 'sqlite', 'host_snapshot', 'noop', 'manual', 'none']);

export class OpRecordValidationError extends Error {
  constructor(msg, field) {
    super(`op-record validation: ${msg}${field ? ` (field: ${field})` : ''}`);
    this.field = field;
  }
}

// Throws OpRecordValidationError on the first violation. Returns the record
// (possibly with defaults filled in) on success.
export function validateOpRecord(rec) {
  if (!rec || typeof rec !== 'object') throw new OpRecordValidationError('record must be object');

  for (const field of REQUIRED_TOP) {
    if (rec[field] === undefined) throw new OpRecordValidationError('missing required field', field);
  }

  if (typeof rec.id !== 'string' || !rec.id.startsWith('op_')) {
    throw new OpRecordValidationError('id must be a string starting with op_', 'id');
  }
  if (typeof rec.ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(rec.ts)) {
    throw new OpRecordValidationError('ts must be ISO-8601', 'ts');
  }
  if (typeof rec.node_id !== 'string' || !rec.node_id) {
    throw new OpRecordValidationError('node_id required', 'node_id');
  }

  // intent
  if (typeof rec.intent !== 'object') throw new OpRecordValidationError('intent must be object', 'intent');
  if (typeof rec.intent.user_text !== 'string') {
    throw new OpRecordValidationError('intent.user_text required', 'intent.user_text');
  }

  // operation
  const op = rec.operation;
  if (typeof op !== 'object') throw new OpRecordValidationError('operation must be object', 'operation');
  if (typeof op.id !== 'string' || !op.id) throw new OpRecordValidationError('operation.id required', 'operation.id');
  if (!VALID_MECHANISMS.has(op.mechanism)) {
    throw new OpRecordValidationError(`mechanism must be one of ${[...VALID_MECHANISMS].join(',')}`, 'operation.mechanism');
  }
  if (!VALID_RISK.has(op.risk_class)) {
    throw new OpRecordValidationError(`risk_class must be one of ${[...VALID_RISK].join(',')}`, 'operation.risk_class');
  }

  // pre_state
  if (typeof rec.pre_state !== 'object') throw new OpRecordValidationError('pre_state must be object', 'pre_state');
  if (!Array.isArray(rec.pre_state.snapshots)) {
    throw new OpRecordValidationError('pre_state.snapshots must be array', 'pre_state.snapshots');
  }

  // execution
  if (typeof rec.execution !== 'object') throw new OpRecordValidationError('execution must be object', 'execution');

  // outcome
  if (!VALID_OUTCOMES.has(rec.outcome)) {
    throw new OpRecordValidationError(`outcome must be one of ${[...VALID_OUTCOMES].join(',')}`, 'outcome');
  }

  // rollback
  const rb = rec.rollback;
  if (typeof rb !== 'object') throw new OpRecordValidationError('rollback must be object', 'rollback');
  if (typeof rb.available !== 'boolean') throw new OpRecordValidationError('rollback.available required', 'rollback.available');
  if (!VALID_ROLLBACK_METHODS.has(rb.method)) {
    throw new OpRecordValidationError(`rollback.method must be one of ${[...VALID_ROLLBACK_METHODS].join(',')}`, 'rollback.method');
  }
  if (rb.available && rb.method === 'manual') {
    throw new OpRecordValidationError('rollback cannot be available with method=manual', 'rollback');
  }
  if (rb.available && rb.method === 'none') {
    throw new OpRecordValidationError('rollback cannot be available with method=none', 'rollback');
  }

  return rec;
}

// Build a record with sane defaults from a partial input. Callers typically
// fill in everything except schema_version + computed fields.
export function buildOpRecord(input) {
  const now = input.ts ? new Date(input.ts).getTime() : Date.now();
  const rec = {
    schema_version: SCHEMA_VERSION,
    id: input.id || generateOpId(now),
    ts: input.ts || new Date(now).toISOString(),
    node_id: input.node_id,
    service_id: input.service_id ?? null,
    profile_version: input.profile_version ?? null,

    intent: {
      user_text: input.intent?.user_text ?? '',
      agent: input.intent?.agent ?? null,
      agent_interpretation: input.intent?.agent_interpretation ?? null,
      session_ref: input.intent?.session_ref ?? null,
      scheduled: !!input.intent?.scheduled,
    },

    operation: {
      id: input.operation?.id,
      capability: input.operation?.capability ?? null,
      mechanism: input.operation?.mechanism,
      parameters: input.operation?.parameters ?? {},
      risk_class: input.operation?.risk_class ?? 'low',
      profile_verified: !!input.operation?.profile_verified,
      trust_state: input.operation?.trust_state ?? 'unverified',
    },

    pre_state: {
      snapshots: input.pre_state?.snapshots ?? [],
      natural_description: input.pre_state?.natural_description ?? null,
      host_snapshot: input.pre_state?.host_snapshot ?? null,
    },

    execution: {
      started_at: input.execution?.started_at ?? null,
      completed_at: input.execution?.completed_at ?? null,
      mechanism_response: input.execution?.mechanism_response ?? null,
      exit_code: input.execution?.exit_code ?? null,
      stdout_tail: input.execution?.stdout_tail ?? null,
      stderr_tail: input.execution?.stderr_tail ?? null,
      error: input.execution?.error ?? null,
    },

    outcome: input.outcome ?? 'success',
    outcome_message: input.outcome_message ?? null,
    verification: input.verification ?? { performed: false, method: null, passed: null },

    rollback: {
      available: !!input.rollback?.available,
      method: input.rollback?.method ?? 'none',
      inverse_call: input.rollback?.inverse_call ?? null,
      expires_at: input.rollback?.expires_at ?? defaultSnapshotExpiry(now),
    },

    approval: {
      required: !!input.approval?.required,
      auto_fired: !!input.approval?.auto_fired,
      user_confirmed: !!input.approval?.user_confirmed,
      confirmed_at: input.approval?.confirmed_at ?? null,
      confirmation_text: input.approval?.confirmation_text ?? null,
    },

    // Reverse-link: when this op IS a rollback of another, point at the original.
    // Forward-link (was-this-op-rolled-back) is computed on read by scanning for ops
    // whose rolls_back_op_id == this id.
    rolls_back_op_id: input.rolls_back_op_id ?? null,
  };

  return validateOpRecord(rec);
}

function defaultSnapshotExpiry(nowMs) {
  return new Date(nowMs + DEFAULT_SNAPSHOT_TTL_DAYS * 86400_000).toISOString();
}

// ── writing ──────────────────────────────────────────────────────────────────

// Append a record. Writes a single line + newline; uses fs.appendFileSync so
// concurrent writers (different ops on different nodes, or even same node) get
// atomic line-level appends on POSIX. Records are never edited after write.
export function writeOpRecord(userId, nodeId, record) {
  const validated = validateOpRecord(record);
  ensureNodeDir(userId, nodeId);
  const line = JSON.stringify(validated) + '\n';
  fs.appendFileSync(activityLogPath(userId, nodeId), line, 'utf8');
  return validated;
}

// ── reading ──────────────────────────────────────────────────────────────────

// Read all records for a node. opts.since/until filter on ts (ISO strings
// or Date). opts.limit truncates from the end (most recent first when
// reverse=true). Lines that fail to parse are skipped with a warning — we'd
// rather lose one corrupted line than crash the activity view.
export function readOpRecords(userId, nodeId, opts = {}) {
  const p = activityLogPath(userId, nodeId);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  if (!text) return [];

  const records = [];
  const since = opts.since ? new Date(opts.since).getTime() : null;
  const until = opts.until ? new Date(opts.until).getTime() : null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); }
    catch { console.warn(`[op-record] skipping malformed line in ${p}`); continue; }

    if (since != null || until != null) {
      const t = new Date(rec.ts).getTime();
      if (since != null && t < since) continue;
      if (until != null && t > until) continue;
    }
    records.push(rec);
  }

  if (opts.reverse) records.reverse();
  if (typeof opts.limit === 'number' && opts.limit > 0) {
    return records.slice(0, opts.limit);
  }
  return records;
}

export function findOpRecord(userId, nodeId, opId) {
  if (!opId) return null;
  // Could be made faster with an index, but at <100k ops linear scan is fine.
  for (const rec of readOpRecords(userId, nodeId)) {
    if (rec.id === opId) return rec;
  }
  return null;
}

// Compute the live rollback state of a record: was it rolled back, by whom, when.
// Done by scanning forward through the log for an op whose rolls_back_op_id
// matches. This is the immutability-preserving alternative to mutating the
// original record in place.
export function getRollbackStatus(userId, nodeId, opId) {
  const orig = findOpRecord(userId, nodeId, opId);
  if (!orig) return { exists: false };

  const status = {
    exists: true,
    available: orig.rollback.available,
    method: orig.rollback.method,
    expires_at: orig.rollback.expires_at,
    expired: orig.rollback.expires_at
      ? new Date(orig.rollback.expires_at).getTime() < Date.now()
      : false,
    invoked: false,
    invoked_at: null,
    invoked_by: null,
    invocation_op_id: null,
    invocation_outcome: null,
  };

  for (const rec of readOpRecords(userId, nodeId)) {
    if (rec.rolls_back_op_id === opId) {
      status.invoked = true;
      status.invoked_at = rec.ts;
      status.invoked_by = rec.intent.agent;
      status.invocation_op_id = rec.id;
      status.invocation_outcome = rec.outcome;
      break; // first rollback wins; subsequent attempts are no-ops or new ops
    }
  }

  // Once successfully rolled back, surgical rollback is no longer available.
  if (status.invoked && status.invocation_outcome === 'success') {
    status.available = false;
  }
  return status;
}

// ── pin state ────────────────────────────────────────────────────────────────
//
// Pinning a snapshot opts it out of the 30-day pruner. Pin state is mutable
// and lives in pinned.json — kept separate from activity.jsonl so the audit
// trail stays append-only. Pinning is itself NOT recorded as an op (it
// doesn't change any external state, only OE's retention behavior).

function readPinned(userId, nodeId) {
  const p = pinnedPath(userId, nodeId);
  if (!fs.existsSync(p)) return { pinnedOpIds: [] };
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      pinnedOpIds: Array.isArray(obj.pinnedOpIds) ? obj.pinnedOpIds : [],
    };
  } catch (e) {
    console.warn(`[op-record] failed to read ${p}:`, e.message);
    return { pinnedOpIds: [] };
  }
}

function writePinned(userId, nodeId, data) {
  ensureNodeDir(userId, nodeId);
  const p = pinnedPath(userId, nodeId);
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

export function isPinned(userId, nodeId, opId) {
  return readPinned(userId, nodeId).pinnedOpIds.includes(opId);
}

export function pinSnapshot(userId, nodeId, opId) {
  const data = readPinned(userId, nodeId);
  if (!data.pinnedOpIds.includes(opId)) {
    data.pinnedOpIds.push(opId);
    writePinned(userId, nodeId, data);
  }
  return data.pinnedOpIds;
}

export function unpinSnapshot(userId, nodeId, opId) {
  const data = readPinned(userId, nodeId);
  data.pinnedOpIds = data.pinnedOpIds.filter(id => id !== opId);
  writePinned(userId, nodeId, data);
  return data.pinnedOpIds;
}

export function listPinned(userId, nodeId) {
  return readPinned(userId, nodeId).pinnedOpIds.slice();
}

// Convenience constants for downstream modules
export const constants = {
  SCHEMA_VERSION,
  DEFAULT_SNAPSHOT_TTL_DAYS,
  VALID_OUTCOMES: [...VALID_OUTCOMES],
  VALID_RISK: [...VALID_RISK],
  VALID_MECHANISMS: [...VALID_MECHANISMS],
  VALID_ROLLBACK_METHODS: [...VALID_ROLLBACK_METHODS],
};
