/**
 * Service profile — the per-service runbook OE consults when operating on or
 * troubleshooting a node.
 *
 * Storage: users/<uid>/nodes/<nid>/profiles/<service_id>.json (machine)
 *          users/<uid>/nodes/<nid>/profiles/<service_id>.md   (human mirror)
 *          users/<uid>/nodes/<nid>/profiles/<service_id>.research.md (sources)
 *
 * A profile carries:
 *   - identity         what the service is, value, capabilities provided
 *   - control_surface  api auth shape, config files, cli, services, log sources
 *   - operations       callable actions with risk/parameters/mechanism templates
 *   - health_signals   what to monitor, how often, what counts as healthy
 *   - diagnostic_recipes  when health-signal X fails, run these in order
 *   - failure_modes    known symptoms → causes → fix operations
 *   - troubleshooting  freeform tips (LLM context for novel problems)
 *   - update_path      how to upgrade the service itself
 *   - backup_before    paths to capture before any risky op
 *   - known_quirks     version-specific gotchas
 *   - trust_state + verification flags  user has reviewed? ops verified?
 *   - research_sources where the LLM got the info
 *
 * Profiles are normally produced by `service_research` from a deep-research
 * pass, then verified against the real service, then reviewed by the user.
 * They can also be hand-written for testing or pinning.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { USERS_DIR, BASE_DIR } from './paths.mjs';

// Canonical-id resolver. Profiles for one logical node should always live
// under the registry's canonical nodeId, never the hostname — otherwise the
// same node ends up with profiles split across two dirs (one under hostname,
// one under canonical id) and tools that look up by one don't see the other.
//
// Reads nodes.json directly to avoid coupling lib/ to skills/nodes/. If the
// registry doesn't have an entry for the input, returns it unchanged (no
// node yet → first save defines the canonical path).
function resolveCanonicalNodeId(userId, nodeIdOrHostname) {
  if (!userId || !nodeIdOrHostname) return nodeIdOrHostname;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'nodes.json'), 'utf8'));
    const entries = Object.values(data?.nodes || data || {});
    // First try exact nodeId match (already canonical).
    const exact = entries.find(e => e?.userId === userId && e?.nodeId === nodeIdOrHostname);
    if (exact) return exact.nodeId;
    // Then hostname match → return the canonical nodeId.
    const byHost = entries.find(e => e?.userId === userId && e?.hostname === nodeIdOrHostname);
    if (byHost?.nodeId) return byHost.nodeId;
  } catch { /* registry unavailable — fall through to caller's input */ }
  return nodeIdOrHostname;
}

const SCHEMA_VERSION = 1;

// ── path helpers ─────────────────────────────────────────────────────────────

export function profilesDir(userId, nodeId) {
  return path.join(USERS_DIR, userId, 'nodes', nodeId, 'profiles');
}

export function profilePath(userId, nodeId, serviceId) {
  return path.join(profilesDir(userId, nodeId), `${serviceId}.json`);
}

export function profileMdPath(userId, nodeId, serviceId) {
  return path.join(profilesDir(userId, nodeId), `${serviceId}.md`);
}

export function profileResearchPath(userId, nodeId, serviceId) {
  return path.join(profilesDir(userId, nodeId), `${serviceId}.research.md`);
}

function ensureProfilesDir(userId, nodeId) {
  fs.mkdirSync(profilesDir(userId, nodeId), { recursive: true });
}

// ── validation ───────────────────────────────────────────────────────────────

const VALID_TRUST_STATES = new Set(['unverified', 'reviewed', 'proven']);
const VALID_RISK = new Set(['low', 'medium', 'high']);
const VALID_AUTH_METHODS = new Set(['none', 'api_key_query_param', 'api_key_header', 'bearer_token', 'basic_auth']);
const VALID_MECHANISMS = new Set(['http', 'config_file', 'cli', 'sqlite', 'mqtt']);
const VALID_PARAM_TYPES = new Set(['string', 'number', 'boolean', 'array']);
const VALID_SEVERITIES = new Set(['info', 'warn', 'critical']);
// Things the oe-agent user on the node needs in order to run this profile's
// operations cleanly (without hitting sudo prompts or permission denials).
//   group        — unix group membership ('pihole', 'docker', 'libvirt', ...)
//   sudoers      — passwordless sudo for a specific binary
//   access_level — node-agent install access level: 'updates' | 'full'
//   capability   — linux capability (e.g. 'CAP_NET_BIND_SERVICE')
const VALID_AGENT_REQ_TYPES = new Set(['group', 'sudoers', 'access_level', 'capability']);

export class ProfileValidationError extends Error {
  constructor(msg, field) {
    super(`profile validation: ${msg}${field ? ` (field: ${field})` : ''}`);
    this.field = field;
  }
}

function err(msg, field) { throw new ProfileValidationError(msg, field); }

function validateOperation(op, idx) {
  const ctx = `operations[${idx}]`;
  if (!op || typeof op !== 'object') err('must be object', ctx);
  if (typeof op.id !== 'string' || !op.id) err('id required', `${ctx}.id`);
  if (op.capability != null && typeof op.capability !== 'string') err('capability must be string|null', `${ctx}.capability`);
  if (!VALID_MECHANISMS.has(op.mechanism)) err(`mechanism must be one of ${[...VALID_MECHANISMS].join(',')}`, `${ctx}.mechanism`);
  if (!VALID_RISK.has(op.risk)) err(`risk must be one of ${[...VALID_RISK].join(',')}`, `${ctx}.risk`);
  if (typeof op.readonly !== 'boolean') err('readonly required boolean', `${ctx}.readonly`);
  if (!Array.isArray(op.parameters)) err('parameters must be array', `${ctx}.parameters`);
  for (const [pi, p] of op.parameters.entries()) {
    if (!p?.name) err('parameter.name required', `${ctx}.parameters[${pi}].name`);
    if (!VALID_PARAM_TYPES.has(p.type)) err(`parameter.type must be one of ${[...VALID_PARAM_TYPES].join(',')}`, `${ctx}.parameters[${pi}].type`);
  }
  // Mechanism-specific section must exist for the declared mechanism.
  if (op.mechanism === 'http') {
    if (!op.http?.write) err('http.write required for http mechanism', `${ctx}.http`);
  } else if (op.mechanism === 'cli') {
    if (!op.cli?.write?.command) err('cli.write.command required for cli mechanism', `${ctx}.cli`);
  } else if (op.mechanism === 'config_file') {
    // Profiles can declare files at op.config_file.files (preferred) or
    // at op.config_file.write.files. Either is accepted at validation time.
    const files = op.config_file?.files || op.config_file?.write?.files;
    if (!Array.isArray(files) || !files.length) {
      err('config_file.files (or config_file.write.files) required non-empty array', `${ctx}.config_file`);
    }
    for (const [fi, f] of files.entries()) {
      if (!f?.path) err('files[].path required', `${ctx}.config_file.files[${fi}].path`);
    }
  }
  // For non-readonly ops, an inverse is strongly preferred — its absence forces
  // dispatcher to mark rollback unavailable. We don't reject it (some ops
  // genuinely have no inverse), just trust the dispatcher's risk gating.
  if (typeof op.verified !== 'boolean') err('verified required boolean', `${ctx}.verified`);
}

const VALID_SIGNAL_MECHANISMS = new Set(['cli', 'http']);
function validateHealthSignal(hs, idx) {
  const ctx = `health_signals[${idx}]`;
  if (!hs?.kind) err('kind required', `${ctx}.kind`);
  if (!hs?.check) err('check required', `${ctx}.check`);
  // Mechanism canonicalization happens at registration time (handler tolerates
  // 'exec'/'shell'/'cmd' as 'cli' aliases), but the saved schema must declare
  // either 'cli' or 'http' so the rest of the system has one canonical name.
  // The LLM otherwise drifts to 'exec', 'shell', or omits the field entirely.
  const mech = hs.check.mechanism || hs.check.type;
  if (mech && !VALID_SIGNAL_MECHANISMS.has(mech) && !['exec', 'shell', 'cmd', 'bash'].includes(mech)) {
    err(`check.mechanism must be 'cli' or 'http' (got ${JSON.stringify(mech)})`, `${ctx}.check.mechanism`);
  }
  if (hs.severity && !VALID_SEVERITIES.has(hs.severity)) {
    err(`severity must be one of ${[...VALID_SEVERITIES].join(',')}`, `${ctx}.severity`);
  }
}

function validateFailureMode(fm, idx) {
  const ctx = `failure_modes[${idx}]`;
  if (!fm?.id) err('id required', `${ctx}.id`);
  if (!fm?.symptom) err('symptom required', `${ctx}.symptom`);
  if (!Array.isArray(fm.fixes)) err('fixes must be array', `${ctx}.fixes`);
  for (const [fi, f] of fm.fixes.entries()) {
    if (!f.op_id) err('fix.op_id required', `${ctx}.fixes[${fi}].op_id`);
    if (f.risk && !VALID_RISK.has(f.risk)) err('fix.risk invalid', `${ctx}.fixes[${fi}].risk`);
  }
}

export function validateProfile(p) {
  if (!p || typeof p !== 'object') err('profile must be object');
  if (typeof p.service_id !== 'string' || !p.service_id) err('service_id required', 'service_id');
  if (typeof p.node_id !== 'string' || !p.node_id) err('node_id required', 'node_id');
  if (!VALID_TRUST_STATES.has(p.trust_state)) {
    err(`trust_state must be one of ${[...VALID_TRUST_STATES].join(',')}`, 'trust_state');
  }
  if (!p.identity || typeof p.identity !== 'object') err('identity required', 'identity');
  if (!p.control_surface || typeof p.control_surface !== 'object') err('control_surface required', 'control_surface');
  if (p.control_surface.api && !VALID_AUTH_METHODS.has(p.control_surface.api.auth_method)) {
    err(`control_surface.api.auth_method must be one of ${[...VALID_AUTH_METHODS].join(',')}`,
        'control_surface.api.auth_method');
  }
  if (!Array.isArray(p.operations)) err('operations must be array', 'operations');
  p.operations.forEach(validateOperation);
  if (p.health_signals && !Array.isArray(p.health_signals)) err('health_signals must be array', 'health_signals');
  (p.health_signals || []).forEach(validateHealthSignal);
  if (p.failure_modes && !Array.isArray(p.failure_modes)) err('failure_modes must be array', 'failure_modes');
  (p.failure_modes || []).forEach(validateFailureMode);
  if (p.agent_requirements != null) {
    if (!Array.isArray(p.agent_requirements)) err('agent_requirements must be array', 'agent_requirements');
    for (const [i, r] of p.agent_requirements.entries()) {
      if (!r?.type) err('type required', `agent_requirements[${i}].type`);
      if (!VALID_AGENT_REQ_TYPES.has(r.type)) {
        err(`type must be one of ${[...VALID_AGENT_REQ_TYPES].join(',')}`, `agent_requirements[${i}].type`);
      }
      if (r.type !== 'access_level' && !r.name) {
        err('name required (except for access_level)', `agent_requirements[${i}].name`);
      }
      if (r.type === 'access_level' && r.name && !['updates', 'full'].includes(r.name)) {
        err('access_level name must be "updates" or "full"', `agent_requirements[${i}].name`);
      }
    }
  }
  return p;
}

// ── builder ──────────────────────────────────────────────────────────────────

export function buildProfile(input) {
  const now = new Date().toISOString();
  const p = {
    schema_version: SCHEMA_VERSION,
    service_id: input.service_id,
    node_id: input.node_id,
    detected_version: input.detected_version ?? null,
    endpoint: input.endpoint ?? null,
    detected_at: input.detected_at ?? now,
    researched_at: input.researched_at ?? now,
    profile_version: input.profile_version ?? generateProfileVersion(now),

    identity: {
      what_it_is: input.identity?.what_it_is ?? '',
      primary_value: input.identity?.primary_value ?? '',
      related_capabilities: input.identity?.related_capabilities ?? [],
    },

    control_surface: {
      api: input.control_surface?.api ?? null,
      config_files: input.control_surface?.config_files ?? [],
      cli: input.control_surface?.cli ?? [],
      services: input.control_surface?.services ?? [],
      log_sources: input.control_surface?.log_sources ?? [],
    },

    operations: (input.operations || []).map(o => ({
      id: o.id,
      capability: o.capability ?? null,
      description: o.description ?? '',
      mechanism: o.mechanism,
      risk: o.risk ?? 'low',
      readonly: !!o.readonly,
      parameters: o.parameters ?? [],
      http: o.http ?? null,
      cli: o.cli ?? null,
      config_file: o.config_file ?? null,
      sqlite: o.sqlite ?? null,
      mqtt: o.mqtt ?? null,
      verified: !!o.verified,
      last_tested: o.last_tested ?? null,
      last_failure: o.last_failure ?? null,
    })),

    health_signals: input.health_signals ?? [],
    diagnostic_recipes: input.diagnostic_recipes ?? {},
    failure_modes: input.failure_modes ?? [],
    troubleshooting: input.troubleshooting ?? [],

    update_path: input.update_path ?? null,
    backup_before: input.backup_before ?? [],
    known_quirks: input.known_quirks ?? [],
    agent_requirements: input.agent_requirements ?? [],

    trust_state: input.trust_state ?? 'unverified',
    trust_state_changed_at: input.trust_state_changed_at ?? now,
    trust_state_changed_by: input.trust_state_changed_by ?? null,

    research_sources: input.research_sources ?? [],
    detected_version_at_research: input.detected_version_at_research ?? input.detected_version ?? null,
  };
  return validateProfile(p);
}

function generateProfileVersion(now = new Date().toISOString()) {
  return `${now.slice(0, 10)}_${randomBytes(2).toString('hex')}`;
}

// ── persistence ──────────────────────────────────────────────────────────────

export function loadProfile(userId, nodeId, serviceId) {
  // Canonicalize so callers passing a hostname (LLM tools often do) route to
  // the same dir as canonical-id callers — eliminates split lookups.
  const canonical = resolveCanonicalNodeId(userId, nodeId);
  const p = profilePath(userId, canonical, serviceId);
  if (!fs.existsSync(p)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return validateProfile(obj);
  } catch (e) {
    if (e instanceof ProfileValidationError) throw e;
    console.warn(`[service-profile] failed to load ${p}:`, e.message);
    return null;
  }
}

// Parse a dotted path with optional bracketed array indices into a token list.
// 'health_signals[0].expect' → ['health_signals', 0, 'expect']
// 'operations[1].http.write.method' → ['operations', 1, 'http', 'write', 'method']
function parseProfilePath(p) {
  if (!p || typeof p !== 'string') throw new Error('path must be a non-empty string');
  const tokens = [];
  for (const part of p.split('.')) {
    if (!part) throw new Error(`empty path segment in "${p}"`);
    const m = part.match(/^([^[]+)((?:\[\d+\])*)$/);
    if (!m) throw new Error(`bad path segment "${part}" in "${p}"`);
    tokens.push(m[1]);
    for (const b of m[2].matchAll(/\[(\d+)\]/g)) tokens.push(Number(b[1]));
  }
  return tokens;
}

function applyProfileEdit(obj, edit) {
  const { op, path: rawPath } = edit;
  if (!op) throw new Error('edit.op required (set | remove)');
  if (!['set', 'remove'].includes(op)) throw new Error(`unknown op "${op}" (must be set | remove)`);
  const tokens = parseProfilePath(rawPath);
  if (!tokens.length) throw new Error('path resolves to empty token list');

  if (op === 'set') {
    let cur = obj;
    for (let i = 0; i < tokens.length - 1; i++) {
      const key = tokens[i];
      if (cur[key] == null) {
        // Auto-create — array if next token is numeric, object otherwise.
        cur[key] = typeof tokens[i + 1] === 'number' ? [] : {};
      }
      cur = cur[key];
    }
    cur[tokens[tokens.length - 1]] = edit.value;
    return;
  }

  // op === 'remove'
  let cur = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (cur == null) return;
    cur = cur[tokens[i]];
  }
  if (cur == null) return;
  const last = tokens[tokens.length - 1];
  if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1);
  else delete cur[last];
}

/**
 * Apply targeted edits to a saved profile. Each edit is
 *   { op: 'set' | 'remove', path: 'dotted.path[0].field', value?: any }
 *
 * Edits are applied in order against an in-memory copy. The result is run
 * through saveProfile (which validates), so a malformed patch leaves the
 * on-disk profile untouched.
 */
export function patchProfile(userId, nodeId, serviceId, edits) {
  if (!Array.isArray(edits) || !edits.length) {
    throw new Error('edits must be a non-empty array');
  }
  const original = loadProfile(userId, nodeId, serviceId);
  if (!original) throw new Error(`no profile for "${serviceId}" on "${nodeId}"`);
  const draft = JSON.parse(JSON.stringify(original));
  for (const [i, edit] of edits.entries()) {
    try { applyProfileEdit(draft, edit); }
    catch (e) { throw new Error(`edit #${i + 1}: ${e.message}`); }
  }
  return saveProfile(userId, nodeId, draft);
}

// Rewrite an LLM-drafted health_signal entry into the canonical schema:
//   - check.type → check.mechanism
//   - exec/shell/cmd/bash mechanism → cli
//   - check.expect → top-level expect (when both absent at top)
//   - drop legacy fields the runtime ignores
// Idempotent — re-running on already-canonical entries is a no-op.
function canonicalizeHealthSignal(s) {
  if (!s || typeof s !== 'object') return s;
  const rawCheck = s.check || {};
  let mechanism = rawCheck.mechanism || rawCheck.type || null;
  if (mechanism === 'exec' || mechanism === 'shell' || mechanism === 'cmd' || mechanism === 'bash') {
    mechanism = 'cli';
  }
  const expect = s.expect !== undefined ? s.expect : rawCheck.expect;
  const newCheck = {};
  if (mechanism)               newCheck.mechanism = mechanism;
  if (rawCheck.command)        newCheck.command = rawCheck.command;
  if (rawCheck.url)            newCheck.url = rawCheck.url;
  if (rawCheck.parse_jsonpath) newCheck.parse_jsonpath = rawCheck.parse_jsonpath;

  return {
    ...s,
    check: newCheck,
    ...(expect !== undefined ? { expect } : {}),
  };
}

// Rewrite common LLM-drafted operation shapes into the canonical schema before
// validation. The prompt tells agents to emit `cli.write.command`, but models
// often produce `cli.command`, `command`, or `cli.write` as a string.
function canonicalizeOperation(op) {
  if (!op || typeof op !== 'object') return op;
  const out = { ...op };

  if (out.mechanism === 'cli') {
    const rawCli = out.cli && typeof out.cli === 'object' ? { ...out.cli } : {};
    const write = rawCli.write;
    const command =
      (write && typeof write === 'object' && (write.command || write.cmd)) ||
      (typeof write === 'string' ? write : null) ||
      rawCli.command ||
      rawCli.cmd ||
      out.command ||
      out.cmd ||
      null;
    if (command && !(write && typeof write === 'object' && write.command)) {
      rawCli.write = { ...(write && typeof write === 'object' ? write : {}), command };
      delete rawCli.command;
      delete rawCli.cmd;
      delete out.command;
      delete out.cmd;
      out.cli = rawCli;
    }
  }

  return out;
}

export function saveProfile(userId, nodeId, profile) {
  // Canonicalize the nodeId — if the caller passed a hostname (e.g. an LLM
  // tool taking the hostname column from node_list), rewrite to the
  // registry's canonical nodeId so profiles for one logical node don't end
  // up scattered between two dirs (`nodes/<hostname>/` vs `nodes/<nodeId>/`).
  const canonicalNodeId = resolveCanonicalNodeId(userId, nodeId);

  // Self-heal LLM schema drift on every save: canonicalize health_signals
  // and auto-fill profile_version if missing. Without this, on-disk profiles
  // accumulate non-canonical fields the LLM keeps inventing (check.type,
  // nested expect, etc.) which makes profile_patch paths confusing and
  // surfaces "vundefined" in the drawer.
  const incoming = { ...profile, node_id: canonicalNodeId };
  if (Array.isArray(incoming.operations)) {
    incoming.operations = incoming.operations.map(canonicalizeOperation);
  }
  if (Array.isArray(incoming.health_signals)) {
    incoming.health_signals = incoming.health_signals.map(canonicalizeHealthSignal);
  }
  if (!incoming.profile_version) {
    incoming.profile_version = generateProfileVersion();
  }

  const validated = validateProfile(incoming);
  ensureProfilesDir(userId, canonicalNodeId);
  const p = profilePath(userId, canonicalNodeId, validated.service_id);
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  // Mirror the human-readable view atomically too — write side-by-side.
  fs.writeFileSync(profileMdPath(userId, canonicalNodeId, validated.service_id), renderProfileMd(validated), 'utf8');
  return validated;
}

export function listProfilesForNode(userId, nodeId) {
  // Canonicalize so callers passing hostname route to the same dir.
  const canonical = resolveCanonicalNodeId(userId, nodeId);
  const dir = profilesDir(userId, canonical);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const serviceId = entry.replace(/\.json$/, '');
    const prof = loadProfile(userId, canonical, serviceId);
    if (prof) out.push(prof);
  }
  return out;
}

export function deleteProfile(userId, nodeId, serviceId) {
  const canonical = resolveCanonicalNodeId(userId, nodeId);
  for (const p of [
    profilePath(userId, canonical, serviceId),
    profileMdPath(userId, canonical, serviceId),
    profileResearchPath(userId, canonical, serviceId),
  ]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// ── finders ──────────────────────────────────────────────────────────────────

export function findOperation(profile, opId) {
  return profile?.operations?.find(o => o.id === opId) || null;
}

export function findOperationsByCapability(profile, capability) {
  return (profile?.operations || []).filter(o => o.capability === capability);
}

export function findFailureMode(profile, failureModeId) {
  return profile?.failure_modes?.find(fm => fm.id === failureModeId) || null;
}

export function findFailureModesForSignal(profile, signalKind) {
  return (profile?.failure_modes || []).filter(fm => fm.diagnostic_recipe === signalKind);
}

// ── template substitution ────────────────────────────────────────────────────
//
// Profile call templates use ${name} placeholders. The capability dispatcher
// builds a context object (endpoint, auth, plus user-supplied parameters) and
// passes it here. Substitution is recursive — works on strings, arrays, and
// objects of strings. Unresolved variables throw, which surfaces as a clear
// "the profile asked for ${blah} but you didn't supply it" error rather than
// silently sending `${blah}` to the service.

const TEMPLATE_RE = /\$\{([^}]+)\}/g;

export function substituteTemplate(template, ctx) {
  if (template == null) return template;
  if (typeof template === 'string') {
    return template.replace(TEMPLATE_RE, (_, key) => {
      const trimmed = key.trim();
      if (ctx[trimmed] === undefined) {
        throw new Error(`unresolved template variable: \${${trimmed}}`);
      }
      return String(ctx[trimmed]);
    });
  }
  if (Array.isArray(template)) return template.map(t => substituteTemplate(t, ctx));
  if (typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = substituteTemplate(v, ctx);
    return out;
  }
  return template;
}

// ── verification + trust state mutations ─────────────────────────────────────
//
// These return a NEW profile object (immutable input) and persist it.
// Callers should `profile = markOperationVerified(...)` to keep their handle.

export function markOperationVerified(userId, nodeId, serviceId, opId, success, errorMsg = null) {
  const profile = loadProfile(userId, nodeId, serviceId);
  if (!profile) throw new Error(`profile ${serviceId} not found for node ${nodeId}`);
  const op = profile.operations.find(o => o.id === opId);
  if (!op) throw new Error(`operation ${opId} not in profile`);
  const now = new Date().toISOString();
  op.verified = !!success;
  op.last_tested = now;
  op.last_failure = success ? null : { error: errorMsg, failed_at: now };
  return saveProfile(userId, nodeId, profile);
}

export function setTrustState(userId, nodeId, serviceId, newState, changedBy = null) {
  if (!VALID_TRUST_STATES.has(newState)) {
    throw new Error(`invalid trust_state: ${newState}`);
  }
  const profile = loadProfile(userId, nodeId, serviceId);
  if (!profile) throw new Error(`profile ${serviceId} not found for node ${nodeId}`);
  profile.trust_state = newState;
  profile.trust_state_changed_at = new Date().toISOString();
  profile.trust_state_changed_by = changedBy;
  return saveProfile(userId, nodeId, profile);
}

// ── markdown renderer ────────────────────────────────────────────────────────

function escMd(s) { return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }

export function renderProfileMd(profile) {
  const p = profile;
  const trustBadge = {
    unverified: '⚠ unverified',
    reviewed:   '✓ reviewed',
    proven:     '★ proven',
  }[p.trust_state] || p.trust_state;

  const lines = [];
  lines.push(`# ${p.service_id} on ${p.node_id}`);
  lines.push('');
  lines.push(`**${p.identity.what_it_is || '(no description)'}**`);
  if (p.identity.primary_value) lines.push(`_${p.identity.primary_value}_`);
  lines.push('');
  lines.push(`- **Version:** ${p.detected_version ?? '?'}`);
  lines.push(`- **Endpoint:** ${p.endpoint ?? '—'}`);
  lines.push(`- **Capabilities:** ${(p.identity.related_capabilities || []).join(', ') || '—'}`);
  lines.push(`- **Trust state:** ${trustBadge}`);
  lines.push(`- **Profile version:** \`${p.profile_version}\``);
  lines.push(`- **Researched at:** ${p.researched_at}`);
  lines.push('');

  // Operations table
  if (p.operations.length) {
    lines.push('## Operations');
    lines.push('');
    lines.push('| ID | Capability | Mechanism | Risk | Readonly | Verified | Description |');
    lines.push('|----|-----------|-----------|------|----------|----------|-------------|');
    for (const op of p.operations) {
      lines.push('| ' + [
        `\`${op.id}\``,
        op.capability ?? '—',
        op.mechanism,
        op.risk,
        op.readonly ? 'yes' : 'no',
        op.verified ? '✓' : (op.last_failure ? '✗' : '—'),
        escMd(op.description),
      ].join(' | ') + ' |');
    }
    lines.push('');
  }

  // Health signals
  if (p.health_signals?.length) {
    lines.push('## Health signals');
    lines.push('');
    for (const hs of p.health_signals) {
      lines.push(`- **${hs.kind}** (${hs.severity || 'info'}, every ${hs.cadence_sec ?? '?'}s) — ${hs.description ?? ''}`);
    }
    lines.push('');
  }

  // Failure modes
  if (p.failure_modes?.length) {
    lines.push('## Known failure modes');
    lines.push('');
    for (const fm of p.failure_modes) {
      lines.push(`### ${fm.id}`);
      lines.push(`**Symptom:** ${fm.symptom}`);
      if (fm.likely_causes?.length) lines.push(`**Likely causes:** ${fm.likely_causes.join(', ')}`);
      if (fm.fixes?.length) {
        lines.push('**Fixes:**');
        for (const f of fm.fixes) {
          lines.push(`  - \`${f.op_id}\` (${f.risk || '?'}) ${f.applies_when ? `— when: ${f.applies_when}` : ''}`);
        }
      }
      lines.push('');
    }
  }

  // Log sources
  if (p.control_surface?.log_sources?.length) {
    lines.push('## Log sources');
    lines.push('');
    for (const ls of p.control_surface.log_sources) {
      const where = ls.path || (ls.systemd_unit ? `systemd:${ls.systemd_unit}` : '?');
      lines.push(`- ${where} — \`${ls.tail_cmd}\``);
    }
    lines.push('');
  }

  // Update path
  if (p.update_path) {
    lines.push('## Update path');
    lines.push('');
    lines.push('```');
    lines.push(JSON.stringify(p.update_path, null, 2));
    lines.push('```');
    lines.push('');
  }

  // Agent requirements (what oe-agent on the node needs)
  if (p.agent_requirements?.length) {
    lines.push('## Agent requirements');
    lines.push('');
    lines.push('_What the oe-agent user on the node needs to run this profile\'s operations cleanly (no sudo prompts, no permission denials)._');
    lines.push('');
    for (const r of p.agent_requirements) {
      const desc = r.type === 'group'        ? `Member of group \`${r.name}\``
                 : r.type === 'sudoers'      ? `Passwordless sudo for \`${r.name}\``
                 : r.type === 'access_level' ? `Node-agent access level: \`${r.name || 'full'}\``
                 : r.type === 'capability'   ? `Linux capability: \`${r.name}\``
                 : `${r.type}: ${r.name ?? ''}`;
      lines.push(`- **${desc}** — ${escMd(r.rationale ?? '')}`);
    }
    lines.push('');
  }

  // Quirks
  if (p.known_quirks?.length) {
    lines.push('## Known quirks');
    lines.push('');
    for (const q of p.known_quirks) lines.push(`- ${q}`);
    lines.push('');
  }

  // Sources
  if (p.research_sources?.length) {
    lines.push('## Research sources');
    lines.push('');
    for (const s of p.research_sources) {
      const title = s.title || s.url;
      lines.push(`- [${title}](${s.url})${s.fetched_at ? ` _(fetched ${s.fetched_at})_` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export const constants = {
  SCHEMA_VERSION,
  VALID_TRUST_STATES: [...VALID_TRUST_STATES],
  VALID_RISK: [...VALID_RISK],
  VALID_AUTH_METHODS: [...VALID_AUTH_METHODS],
  VALID_MECHANISMS: [...VALID_MECHANISMS],
};
