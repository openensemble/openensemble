/**
 * Incident — the unit OE and the user collaborate on when a service has a
 * problem. Aggregates the watcher trigger, diagnostic output, matched failure
 * mode, fix attempts, and the resolution status into one durable record.
 *
 * Storage: users/<uid>/nodes/<nid>/incidents/<incident_id>.json
 *
 * Each incident is a single JSON file, not JSONL — incidents are aggregations
 * (the events list IS the body), and we want one read to give a caller the
 * whole story. Atomic writes (tmp + rename) prevent torn reads.
 *
 * State machine:
 *   open → investigating → fix_proposed → (awaiting_user → fix_applied) → resolved
 *                                       → fix_applied → resolved
 *   any  → abandoned   (user manually closes without resolution)
 *   any  → resolved    (signal recovered without fix being needed)
 *
 * State transitions are advisory — `setIncidentStatus()` validates the source
 * status against an allowlist for the new status, but doesn't enforce a strict
 * graph. Operators can override.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { USERS_DIR } from './paths.mjs';

const SCHEMA_VERSION = 1;

const VALID_STATUSES = new Set([
  'open',
  'investigating',
  'fix_proposed',
  'awaiting_user',
  'fix_applied',
  'resolved',
  'abandoned',
]);

const VALID_EVENT_TYPES = new Set([
  'opened',
  'status_changed',
  'diagnostic_run',
  'failure_mode_matched',
  'fix_proposed',
  'fix_applied',
  'fix_failed',
  'message',
  'closed',
]);

// ── path helpers ─────────────────────────────────────────────────────────────

export function incidentsDir(userId, nodeId) {
  return path.join(USERS_DIR, userId, 'nodes', nodeId, 'incidents');
}

export function incidentPath(userId, nodeId, incidentId) {
  return path.join(incidentsDir(userId, nodeId), `${incidentId}.json`);
}

function ensureIncidentsDir(userId, nodeId) {
  fs.mkdirSync(incidentsDir(userId, nodeId), { recursive: true });
}

// ── id ───────────────────────────────────────────────────────────────────────

export function generateIncidentId(now = Date.now()) {
  const iso = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `inc_${iso}_${randomBytes(3).toString('hex')}`;
}

// ── validation ───────────────────────────────────────────────────────────────

export class IncidentValidationError extends Error {
  constructor(msg, field) {
    super(`incident validation: ${msg}${field ? ` (field: ${field})` : ''}`);
    this.field = field;
  }
}

function err(msg, f) { throw new IncidentValidationError(msg, f); }

export function validateIncident(inc) {
  if (!inc || typeof inc !== 'object') err('must be object');
  if (typeof inc.id !== 'string' || !inc.id.startsWith('inc_')) err('id must start with inc_', 'id');
  if (typeof inc.node_id !== 'string' || !inc.node_id) err('node_id required', 'node_id');
  if (!VALID_STATUSES.has(inc.status)) {
    err(`status must be one of ${[...VALID_STATUSES].join(',')}`, 'status');
  }
  if (typeof inc.ts_opened !== 'string') err('ts_opened required', 'ts_opened');
  if (!Array.isArray(inc.events)) err('events must be array', 'events');
  for (const [i, e] of inc.events.entries()) {
    if (!VALID_EVENT_TYPES.has(e?.type)) {
      err(`event.type invalid: got ${e?.type}`, `events[${i}].type`);
    }
    if (typeof e.ts !== 'string') err('event.ts required', `events[${i}].ts`);
  }
  return inc;
}

// ── persistence ──────────────────────────────────────────────────────────────

export function loadIncident(userId, nodeId, incidentId) {
  const p = incidentPath(userId, nodeId, incidentId);
  if (!fs.existsSync(p)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return validateIncident(obj);
  } catch (e) {
    if (e instanceof IncidentValidationError) throw e;
    console.warn(`[incident] failed to load ${p}:`, e.message);
    return null;
  }
}

function persistIncident(userId, nodeId, incident) {
  const validated = validateIncident(incident);
  ensureIncidentsDir(userId, nodeId);
  const p = incidentPath(userId, nodeId, validated.id);
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return validated;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Open a new incident. Idempotent on (nodeId, serviceId, triggering signal kind):
 * if there's already an open incident matching that combination, returns it
 * instead of creating a duplicate. This is what prevents a flapping watcher
 * from filing the same problem 50 times.
 */
export function openIncident(userId, nodeId, input) {
  const { service_id, profile_version, triggering_signal } = input;
  if (!triggering_signal?.kind) {
    throw new IncidentValidationError('triggering_signal.kind required', 'triggering_signal');
  }

  // De-dup against open incidents on the same service+signal kind.
  const existing = findOpenIncidentForSignal(userId, nodeId, service_id, triggering_signal.kind);
  if (existing) return existing;

  const id = generateIncidentId();
  const now = new Date().toISOString();
  const incident = {
    schema_version: SCHEMA_VERSION,
    id,
    node_id: nodeId,
    service_id: service_id ?? null,
    profile_version: profile_version ?? null,
    ts_opened: now,
    ts_closed: null,
    status: 'open',
    triggering_signal,
    matched_failure_mode_id: null,
    diagnostics_collected: [],
    fix_attempts: [],
    resolution_summary: null,
    events: [{ ts: now, type: 'opened', payload: { triggering_signal } }],
  };
  return persistIncident(userId, nodeId, incident);
}

export function appendIncidentEvent(userId, nodeId, incidentId, event) {
  const inc = loadIncident(userId, nodeId, incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);
  const ev = { ts: new Date().toISOString(), ...event };
  if (!VALID_EVENT_TYPES.has(ev.type)) {
    throw new IncidentValidationError(`unknown event.type: ${ev.type}`, 'event.type');
  }
  inc.events.push(ev);
  return persistIncident(userId, nodeId, inc);
}

export function recordDiagnostic(userId, nodeId, incidentId, diagnostic) {
  const inc = loadIncident(userId, nodeId, incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);
  const entry = {
    ts: new Date().toISOString(),
    recipe_step: diagnostic.recipe_step ?? null,
    output_excerpt: diagnostic.output_excerpt ?? null,
    op_id: diagnostic.op_id ?? null,
    interpretation: diagnostic.interpretation ?? null,
  };
  inc.diagnostics_collected.push(entry);
  inc.events.push({ ts: entry.ts, type: 'diagnostic_run', payload: entry });
  if (inc.status === 'open') inc.status = 'investigating';
  return persistIncident(userId, nodeId, inc);
}

export function recordFixAttempt(userId, nodeId, incidentId, attempt) {
  const inc = loadIncident(userId, nodeId, incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);
  const entry = {
    ts: new Date().toISOString(),
    op_id_in_profile: attempt.op_id_in_profile,
    op_record_id: attempt.op_record_id ?? null,
    outcome: attempt.outcome,
    message: attempt.message ?? null,
  };
  inc.fix_attempts.push(entry);
  inc.events.push({
    ts: entry.ts,
    type: entry.outcome === 'success' ? 'fix_applied' : 'fix_failed',
    payload: entry,
  });
  if (entry.outcome === 'success') inc.status = 'fix_applied';
  return persistIncident(userId, nodeId, inc);
}

const STATUS_TRANSITIONS = {
  // Permissive: list which prior statuses are allowed for each target.
  // Any status can go to abandoned or resolved (escape hatches).
  open:           ['__init__'],
  investigating:  ['open', 'fix_applied'],
  fix_proposed:   ['investigating', 'fix_applied'],
  awaiting_user:  ['fix_proposed'],
  fix_applied:    ['fix_proposed', 'awaiting_user', 'investigating'],
  resolved:       ['*'],
  abandoned:      ['*'],
};

export function setIncidentStatus(userId, nodeId, incidentId, newStatus, opts = {}) {
  if (!VALID_STATUSES.has(newStatus)) {
    throw new IncidentValidationError(`invalid status: ${newStatus}`, 'status');
  }
  const inc = loadIncident(userId, nodeId, incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);
  const allowed = STATUS_TRANSITIONS[newStatus];
  const ok = allowed?.includes('*') || allowed?.includes(inc.status);
  if (!ok && !opts.force) {
    throw new IncidentValidationError(
      `transition ${inc.status} → ${newStatus} not allowed (use opts.force to override)`,
      'status',
    );
  }
  const prev = inc.status;
  inc.status = newStatus;
  const now = new Date().toISOString();
  inc.events.push({
    ts: now, type: 'status_changed',
    payload: { from: prev, to: newStatus, reason: opts.reason ?? null },
  });
  if (newStatus === 'resolved' || newStatus === 'abandoned') {
    inc.ts_closed = now;
    inc.resolution_summary = opts.summary ?? inc.resolution_summary;
    inc.events.push({ ts: now, type: 'closed', payload: { final_status: newStatus, summary: inc.resolution_summary } });
  }
  return persistIncident(userId, nodeId, inc);
}

export function closeIncident(userId, nodeId, incidentId, summary, status = 'resolved') {
  return setIncidentStatus(userId, nodeId, incidentId, status, { summary, force: true });
}

// ── queries ──────────────────────────────────────────────────────────────────

export function listIncidents(userId, nodeId, opts = {}) {
  const dir = incidentsDir(userId, nodeId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    if (file.includes('.tmp.')) continue; // skip in-flight writes
    const id = file.replace(/\.json$/, '');
    // loadIncident re-throws IncidentValidationError so DIRECT loads surface
    // schema problems loudly — but one drifted file must not brick
    // list/dedup/open for the whole node (watchers could no longer file
    // incidents at all). Skip it and leave the file on disk for inspection.
    let inc = null;
    try { inc = loadIncident(userId, nodeId, id); }
    catch (e) {
      console.warn(`[incident] skipping malformed ${id}: ${e.message}`);
      continue;
    }
    if (!inc) continue;
    if (opts.status && inc.status !== opts.status) continue;
    if (opts.openOnly && (inc.status === 'resolved' || inc.status === 'abandoned')) continue;
    out.push(inc);
  }
  // Sort by id (which embeds the timestamp + random suffix) — stable even
  // when two incidents are opened within the same millisecond.
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

export function findOpenIncidentForSignal(userId, nodeId, serviceId, signalKind) {
  for (const inc of listIncidents(userId, nodeId, { openOnly: true })) {
    if (inc.service_id !== serviceId) continue;
    if (inc.triggering_signal?.kind !== signalKind) continue;
    return inc;
  }
  return null;
}

export const constants = {
  SCHEMA_VERSION,
  VALID_STATUSES: [...VALID_STATUSES],
  VALID_EVENT_TYPES: [...VALID_EVENT_TYPES],
};
