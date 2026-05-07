/**
 * Capability dispatcher — the bridge between agent intent (capability + opId)
 * and the op-dispatcher (which only speaks raw mechanism-level opSpecs).
 *
 * Flow when an agent wants to do something to a service:
 *   agent calls dispatchCapabilityCall({nodeId, serviceId, opId, parameters, ...})
 *     ↓
 *   we load the profile for (nodeId, serviceId)
 *     ↓
 *   find the operation by opId
 *     ↓
 *   build a template context: { endpoint, auth, ...userParameters }
 *     ↓
 *   substitute templates in the operation's mechanism-specific section
 *     ↓
 *   construct an opSpec
 *     ↓
 *   call op-dispatcher (which captures pre-state, executes, writes a record,
 *   determines rollback eligibility)
 *
 * Auth resolution is intentionally pluggable. Profiles declare where their
 * token lives via control_surface.api.token_storage (e.g.
 * 'config_field:pihole_api_token'). The default resolver reads from a
 * caller-supplied resolveAuth function so this module stays agnostic of
 * OE's specific config storage.
 */

import {
  loadProfile,
  findOperation,
  substituteTemplate,
  markOperationVerified,
} from './service-profile.mjs';
import { dispatchOperation } from './op-dispatcher.mjs';

/**
 * Validate caller-supplied parameters against the operation's parameter
 * schema. Throws on missing required, returns the resolved param map (with
 * defaults filled where omitted).
 */
export function resolveParameters(op, supplied = {}) {
  const out = {};
  for (const p of op.parameters || []) {
    if (supplied[p.name] !== undefined) {
      out[p.name] = supplied[p.name];
    } else if (p.default !== undefined) {
      out[p.name] = p.default;
    } else if (p.required) {
      throw new Error(`missing required parameter "${p.name}" for op "${op.id}"`);
    } else {
      // Optional + no default → substitute empty string. Without this, any
      // call template that references the param (e.g. `pihole disable ${duration}`)
      // would throw "unresolved template variable" when the caller omits it.
      // Empty-string substitution gives sane behavior for shell commands and
      // most URL templates ("?duration=" is usually accepted).
      out[p.name] = '';
    }
  }
  // Allow extras (e.g. ${endpoint} / ${auth} are added by the caller, not by
  // the op's parameter schema). Don't reject unknown keys here.
  for (const [k, v] of Object.entries(supplied)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/**
 * Build an opSpec for the op-dispatcher from a profile op + resolved template
 * context. Mechanism-specific.
 */
export function buildOpSpec(op, tplCtx, opts = {}) {
  const base = {
    id: op.id,
    capability: op.capability ?? null,
    mechanism: op.mechanism,
    parameters: opts.exposeParameters ?? tplCtx,
    declared_risk: op.risk,
    profile_verified: !!op.verified,
    profile_version: opts.profile_version ?? null,
    trust_state: opts.trust_state ?? 'unverified',
  };

  if (op.mechanism === 'http' && op.http) {
    return {
      ...base,
      pre_capture: op.http.pre_capture ? substituteTemplate(op.http.pre_capture, tplCtx) : null,
      write:       substituteTemplate(op.http.write, tplCtx),
      inverse:     op.http.inverse ? substituteTemplate(op.http.inverse, tplCtx) : null,
    };
  }
  if (op.mechanism === 'cli' && op.cli) {
    return {
      ...base,
      pre_capture: op.cli.pre_capture ? substituteTemplate(op.cli.pre_capture, tplCtx) : null,
      write:       substituteTemplate(op.cli.write, tplCtx),
      inverse:     op.cli.inverse ? substituteTemplate(op.cli.inverse, tplCtx) : null,
    };
  }
  if (op.mechanism === 'config_file' && op.config_file) {
    return {
      ...base,
      pre_capture: op.config_file.pre_capture ? substituteTemplate(op.config_file.pre_capture, tplCtx) : null,
      write:       substituteTemplate(op.config_file.write || { files: op.config_file.files || [], reload_cmd: op.config_file.reload_cmd }, tplCtx),
      // config_file uses snapshot for rollback, no inverse_call.
      inverse:     null,
    };
  }
  // Remaining mechanisms (sqlite/mqtt) need their respective snapshot
  // primitives. Throw early so callers get a clear error.
  throw new Error(`capability dispatch for mechanism="${op.mechanism}" not yet supported`);
}

/**
 * Resolve auth based on profile.control_surface.api.token_storage.
 *
 * @param {object} profile
 * @param {object} ctx
 * @param {string} [ctx.auth_override]  test/manual override; bypasses storage lookup
 * @param {function} [ctx.resolveAuth]  (storageRef) => string|Promise<string>
 *                                       e.g. for 'config_field:pihole_api_token',
 *                                       caller looks up the field and returns the value.
 */
export async function resolveAuth(profile, ctx = {}) {
  const api = profile?.control_surface?.api;
  if (!api) return '';
  if (api.auth_method === 'none') return '';
  if (ctx.auth_override !== undefined) return ctx.auth_override;
  if (typeof ctx.resolveAuth === 'function') {
    const v = await ctx.resolveAuth(api.token_storage);
    return v ?? '';
  }
  // No resolver supplied → empty string. Calls that depend on auth will fail
  // at the service end rather than here, which is honest behavior; we'd rather
  // not silently succeed with an empty auth.
  return '';
}

/**
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.nodeId
 * @param {string} input.serviceId
 * @param {string} input.opId
 * @param {object} [input.parameters]  user-supplied parameters
 * @param {object} input.intent        forwarded to op-dispatcher
 * @param {object} [input.ctx]         mechanism-specific (fetchFn for http) +
 *                                     auth_override / resolveAuth
 * @param {object} [input.approval]    forwarded to op-dispatcher
 * @returns {Promise<{record, executionResult, error, profile, op}>}
 */
export async function dispatchCapabilityCall(input) {
  const { userId, nodeId, serviceId, opId, parameters = {}, intent } = input;
  if (!userId || !nodeId || !serviceId || !opId) {
    throw new Error('dispatchCapabilityCall: userId, nodeId, serviceId, opId required');
  }

  const profile = loadProfile(userId, nodeId, serviceId);
  if (!profile) throw new Error(`no profile for ${serviceId} on ${nodeId}`);

  const op = findOperation(profile, opId);
  if (!op) throw new Error(`operation "${opId}" not found in profile ${serviceId}`);

  // Build template context
  const auth = await resolveAuth(profile, input.ctx || {});
  const tplCtx = {
    endpoint: profile.endpoint || '',
    auth,
    ...resolveParameters(op, parameters),
  };

  const opSpec = buildOpSpec(op, tplCtx, {
    profile_version: profile.profile_version,
    trust_state: profile.trust_state,
    // Don't leak the auth token into the op record's parameters field.
    exposeParameters: { ...parameters, _redacted_auth: !!auth },
  });

  const result = await dispatchOperation({
    userId,
    nodeId,
    serviceId,
    intent,
    opSpec,
    ctx: input.ctx,
    approval: input.approval,
  });

  // Auto-mark the op verified when it actually ran successfully — accumulates
  // trust-through-use for write ops the same way profile_verify_readonly does
  // for readonly ones. Only flips to true; never demotes on failure (a
  // transient blip shouldn't unverify an op that has worked before — explicit
  // re-verify or profile_patch is the way to demote).
  try {
    if (result?.record?.outcome === 'success' && op.verified === false) {
      markOperationVerified(userId, nodeId, serviceId, op.id, true, null);
    }
  } catch { /* best-effort — never fail the op over a verified-flag write */ }

  return result;
}

/**
 * Run all read-only operations in a profile and update each one's `verified`
 * flag based on the outcome. Skips ops with required parameters that have no
 * `default` (we can't safely call them with arbitrary inputs).
 *
 * Returns { tested, passed, failed, skipped }.
 */
export async function verifyProfileReadonly(input) {
  const { userId, nodeId, serviceId, ctx = {} } = input;
  const profile = loadProfile(userId, nodeId, serviceId);
  if (!profile) throw new Error(`no profile for ${serviceId} on ${nodeId}`);

  const summary = { tested: 0, passed: 0, failed: 0, skipped: 0, results: [] };

  for (const op of profile.operations) {
    if (!op.readonly) continue;

    // Skip ops with required-no-default parameters
    const needsParams = (op.parameters || []).filter(p => p.required && p.default === undefined);
    if (needsParams.length) {
      summary.skipped++;
      summary.results.push({ op_id: op.id, status: 'skipped', reason: `requires ${needsParams.map(p => p.name).join(',')}` });
      continue;
    }

    summary.tested++;
    try {
      const result = await dispatchCapabilityCall({
        userId, nodeId, serviceId, opId: op.id,
        intent: { user_text: `[verify] ${op.id}`, agent: 'verifier', scheduled: true },
        ctx,
        parameters: {},
        approval: { auto_fired: true },
      });
      const success = result.record.outcome === 'success';
      markOperationVerified(userId, nodeId, serviceId, op.id, success,
        success ? null : (result.record.execution.error || `outcome=${result.record.outcome}`));
      if (success) summary.passed++; else summary.failed++;
      summary.results.push({
        op_id: op.id,
        status: success ? 'passed' : 'failed',
        op_record_id: result.record.id,
      });
    } catch (e) {
      markOperationVerified(userId, nodeId, serviceId, op.id, false, e.message);
      summary.failed++;
      summary.results.push({ op_id: op.id, status: 'failed', error: e.message });
    }
  }

  return summary;
}
