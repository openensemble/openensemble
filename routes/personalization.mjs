// @ts-check
/**
 * Personalization REST API — Settings → Personalization panel.
 *
 *   GET    /api/personalization/config          — {config, providers, coordinatorLabel}
 *                                                  (one fetch is enough for the whole panel)
 *   PATCH  /api/personalization/config          — shallow-merge patch; a `model` field is
 *                                                  validated against the provider enumeration
 *                                                  or the 'coordinator'/'off' sentinels first
 *   GET    /api/personalization/ledger          — "what I've learned about you" rows
 *   POST   /api/personalization/ledger/:id/confirm — mark an inferred row as user-confirmed
 *   DELETE /api/personalization/ledger/:id      — soft-forget one row (any tier)
 *   GET    /api/personalization/leads           — open "keeping an eye on" leads
 *   DELETE /api/personalization/leads/:id       — dismiss a lead
 *   POST   /api/personalization/run             — force a reflection run now (self only)
 *   POST   /api/personalization/start-fresh     — soft-forget every tier:'inferred' row,
 *                                                  keep tier:'confirmed' rows
 *
 * All routes are per-user scoped from session auth (requireAuth) — there is
 * no admin override; a user can only ever act on their own personalization
 * data, matching every other per-user route module in routes/.
 *
 * Ledger storage: cortex holds the actual memory row (written by
 * lib/personalization/reflect.mjs via memory/lance.mjs remember()); this
 * route owns reading/writing the SIDECAR at
 * users/<uid>/personalization/ledger.json, which is the only place
 * tier/evidence/provenance live (cortex metadata keys are fixed — see
 * PERSONALIZATION_SPEC ADDENDUM E). Only the actual cortex soft-forget
 * (DELETE / start-fresh) reaches into lib/personalization/ledger.mjs's
 * forgetInferredRow — everything else here is plain sidecar-file CRUD.
 */

import fs from 'fs';
import path from 'path';
import { requireAuth, readBody, withLock, atomicWriteSync, USERS_DIR, getUserCoordinatorAgentId, getAgentsForUser } from './_helpers.mjs';
import { getConfig, saveConfig } from '../lib/personalization/config.mjs';
import { enumerateProviders } from '../lib/personalization/providers.mjs';
import { runReflection } from '../lib/personalization/reflect.mjs';
import { forgetInferredRow } from '../lib/personalization/ledger.mjs';
import { listLeads, dismissLead } from '../lib/personalization/leads.mjs';

// ── Ledger sidecar (users/<uid>/personalization/ledger.json) ───────────────
// Plaintext JSON (no raw content, statements only — see ADDENDUM G), written
// via atomicWriteSync with version/updated_at fields, following the
// lib/voice-config.mjs shape. Per-user lock key so concurrent writes for the
// SAME user serialize without blocking other users.

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}
function ledgerPath(userId) {
  return path.join(personalizationDir(userId), 'ledger.json');
}

function readLedgerSidecar(userId) {
  const p = ledgerPath(userId);
  try {
    if (!fs.existsSync(p)) return { version: 0, updated_at: 0, rows: [] };
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      version: Number.isInteger(obj?.version) ? obj.version : 0,
      updated_at: Number.isInteger(obj?.updated_at) ? obj.updated_at : 0,
      rows: Array.isArray(obj?.rows) ? obj.rows : [],
    };
  } catch (e) {
    console.warn(`[personalization] ledger sidecar read failed for ${userId}: ${e.message}`);
    return { version: 0, updated_at: 0, rows: [] };
  }
}

function writeLedgerSidecar(userId, rows) {
  const prev = readLedgerSidecar(userId);
  fs.mkdirSync(personalizationDir(userId), { recursive: true });
  const next = { version: (prev.version || 0) + 1, updated_at: Date.now(), rows };
  atomicWriteSync(ledgerPath(userId), JSON.stringify(next, null, 2));
  return next;
}

// Read-modify-write the sidecar's rows array under this user's lock.
// `fn(rows)` returns the new rows array (or a falsy value to keep it as-is).
function modifyLedgerRows(userId, fn) {
  return withLock(ledgerPath(userId), () => {
    const cur = readLedgerSidecar(userId);
    const nextRows = fn(cur.rows) ?? cur.rows;
    return writeLedgerSidecar(userId, nextRows);
  });
}

// ── Coordinator label (for the "Same as coordinator (default)" option) ─────
// Same lookup pattern as lib/task-label.mjs:75-78. Best-effort only — the UI
// falls back to a generic label if this fails, it never blocks the response.
function safeCoordinatorLabel(userId) {
  try {
    const coordId = getUserCoordinatorAgentId(userId);
    if (!coordId) return null;
    const agent = getAgentsForUser(userId).find(a => a.id === coordId);
    if (!agent?.provider) return null;
    return agent.model ? `${agent.model} (${agent.provider})` : agent.provider;
  } catch (e) {
    console.warn(`[personalization] coordinator label lookup failed for ${userId}: ${e.message}`);
    return null;
  }
}

// ── Model-pick validation (PATCH /config) ───────────────────────────────────
// Accepts the two sentinel strings, or {provider, model} matched against the
// live provider enumeration. Anything else is rejected with a 400 rather
// than silently saved and failing at reflection time.
//
// lib/personalization/providers.mjs's own documented contract: cloud
// providers have no cheap universal "list models" call, so `models` comes
// back empty for them — an empty models[] means "any non-empty model string
// is acceptable", NOT "no models exist" (only ollama/lmstudio ever get a
// populated, exact-match-checkable list). Requiring `p.models.includes(...)`
// unconditionally made it impossible to ever save a cloud provider pick.
// `configured:true` is still required either way, so an unconfigured
// provider (no API key, not connected) can never be picked just because its
// models array happens to be empty.
function isValidModelPick(model, providers) {
  if (model === 'coordinator' || model === 'off') return true;
  if (!model || typeof model !== 'object') return false;
  const { provider, model: modelName } = model;
  if (typeof provider !== 'string' || typeof modelName !== 'string' || !modelName.trim()) return false;
  const p = providers.find(pr => pr.id === provider);
  if (!p || !p.configured) return false;
  const models = Array.isArray(p.models) ? p.models : [];
  return models.length > 0 ? models.includes(modelName) : true;
}

async function safeEnumerateProviders(userId) {
  try {
    const list = await enumerateProviders(userId);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error(`[personalization] enumerateProviders failed for ${userId}: ${e.message}`);
    return [];
  }
}

export async function handle(req, res) {
  const url = req.url.split('?')[0];

  // ── GET /api/personalization/config ───────────────────────────────────────
  if (url === '/api/personalization/config' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    let config;
    try {
      config = await getConfig(userId);
    } catch (e) {
      console.error(`[personalization] getConfig failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load personalization config' }));
      return true;
    }
    const providers = await safeEnumerateProviders(userId);
    const coordinatorLabel = safeCoordinatorLabel(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config, providers, coordinatorLabel }));
    return true;
  }

  // ── PATCH /api/personalization/config ─────────────────────────────────────
  if (url === '/api/personalization/config' && req.method === 'PATCH') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body must be an object' }));
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'model')) {
      const providers = await safeEnumerateProviders(userId);
      if (!isValidModelPick(body.model, providers)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "model must be 'coordinator', 'off', or a {provider, model} pair from the enumeration" }));
        return true;
      }
    }
    let saved;
    try {
      saved = await saveConfig(userId, body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'invalid personalization config' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config: saved }));
    return true;
  }

  // ── GET /api/personalization/ledger ────────────────────────────────────────
  if (url === '/api/personalization/ledger' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const { rows } = readLedgerSidecar(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ledger: rows }));
    return true;
  }

  // ── POST /api/personalization/ledger/:id/confirm ──────────────────────────
  const confirmMatch = url.match(/^\/api\/personalization\/ledger\/([^/]+)\/confirm$/);
  if (confirmMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = decodeURIComponent(confirmMatch[1]);
    let found = null;
    await modifyLedgerRows(userId, rows => {
      const row = rows.find(r => r.id === id);
      if (row) {
        row.tier = 'confirmed';
        row.confirmedAt = new Date().toISOString();
        found = row;
      }
      return rows;
    });
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ledger row not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, row: found }));
    return true;
  }

  // ── DELETE /api/personalization/ledger/:id ────────────────────────────────
  const ledgerDeleteMatch = url.match(/^\/api\/personalization\/ledger\/([^/]+)$/);
  if (ledgerDeleteMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = decodeURIComponent(ledgerDeleteMatch[1]);
    const existing = readLedgerSidecar(userId).rows.find(r => r.id === id);
    if (!existing) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ledger row not found' }));
      return true;
    }
    // forgetInferredRow is designed to NEVER throw — every failure (bad id,
    // LanceDB update failure) is caught internally and signaled by returning
    // false — so the boolean itself, not just a catch block, is what tells
    // us whether the cortex row actually got soft-forgotten. Ignoring it
    // would remove the sidecar row and report ok:true even though the
    // 'INFERRED: …' memory is still live and still being recalled.
    let ok = false;
    try {
      ok = await forgetInferredRow(userId, id);
    } catch (e) {
      console.error(`[personalization] forgetInferredRow threw for ${userId}/${id}: ${e.message}`);
      ok = false;
    }
    if (!ok) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'memory delete failed — try again' }));
      return true;
    }
    await modifyLedgerRows(userId, rows => rows.filter(r => r.id !== id));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── GET /api/personalization/leads ─────────────────────────────────────────
  if (url === '/api/personalization/leads' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    let leads = [];
    try {
      leads = await listLeads(userId, { activeOnly: true });
    } catch (e) {
      console.error(`[personalization] listLeads failed for ${userId}: ${e.message}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leads }));
    return true;
  }

  // ── DELETE /api/personalization/leads/:id ─────────────────────────────────
  const leadsDeleteMatch = url.match(/^\/api\/personalization\/leads\/([^/]+)$/);
  if (leadsDeleteMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = decodeURIComponent(leadsDeleteMatch[1]);
    let ok = false;
    try {
      ok = await dismissLead(userId, id);
    } catch (e) {
      console.error(`[personalization] dismissLead failed for ${userId}/${id}: ${e.message}`);
    }
    if (!ok) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'lead not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── POST /api/personalization/run ─────────────────────────────────────────
  // Self-only: always the requesting session's own userId, force:true bypasses
  // the "already ran recently" gate so the Settings "Run now" button (and the
  // orchestrator's live-verify hook) sees an immediate result.
  if (url === '/api/personalization/run' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    let stats;
    try {
      stats = await runReflection(userId, { force: true });
    } catch (e) {
      console.error(`[personalization] runReflection failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'reflection run failed', message: e.message }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...stats }));
    return true;
  }

  // ── POST /api/personalization/start-fresh ─────────────────────────────────
  // Soft-forgets every tier:'inferred' row (the cortex memory row via
  // forgetInferredRow, then the sidecar entry itself); tier:'confirmed' rows
  // are left untouched. One row's forget failure doesn't block the rest.
  if (url === '/api/personalization/start-fresh' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const { rows } = readLedgerSidecar(userId);
    const toForget = rows.filter(r => r.tier !== 'confirmed');
    let removed = 0;
    let failed = 0;
    const failedIds = new Set();
    for (const row of toForget) {
      // Same forgetInferredRow-never-throws honesty as DELETE /ledger/:id
      // above: only count a row as removed when it actually returns true.
      let ok = false;
      try {
        ok = await forgetInferredRow(userId, row.id);
      } catch (e) {
        console.error(`[personalization] start-fresh: forgetInferredRow threw for ${userId}/${row.id}: ${e.message}`);
        ok = false;
      }
      if (ok) removed++;
      else { failed++; failedIds.add(row.id); }
    }
    await modifyLedgerRows(userId, curRows =>
      curRows.filter(r => r.tier === 'confirmed' || failedIds.has(r.id)));
    const keptConfirmed = rows.length - toForget.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, removed, failed, keptConfirmed }));
    return true;
  }

  return false;
}
