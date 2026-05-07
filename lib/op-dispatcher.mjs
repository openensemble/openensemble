/**
 * Operation dispatcher — the single chokepoint every service-skill operation
 * flows through.
 *
 * Responsibilities:
 *   1. Resolve the mechanism handler.
 *   2. Capture pre-state (snapshot). Failure here doesn't abort the op — we
 *      still execute and record, but rollback eligibility is reduced.
 *   3. Compute effective risk_class: max of declared, mechanism floor, and a
 *      no-snapshot penalty. The LLM can't downgrade below mechanism limits.
 *   4. Execute the operation.
 *   5. Build + write an immutable op record describing what happened, including
 *      whether rollback is available and how.
 *
 * Service skills MUST go through this. Bypassing it means no audit trail,
 * no snapshot, no rollback — defeats the whole architecture.
 */

import { resolveHandler } from './snapshots/index.mjs';
import { buildOpRecord, writeOpRecord, generateOpId } from './op-record.mjs';
import { captureHostSnapshot } from './host-snapshot.mjs';

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

function maxRisk(...risks) {
  let max = 'low';
  for (const r of risks) {
    if (r && RISK_ORDER[r] > RISK_ORDER[max]) max = r;
  }
  return max;
}

/**
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.nodeId
 * @param {string} [input.serviceId]
 * @param {object} input.intent      {user_text, agent, agent_interpretation?, session_ref?, scheduled?}
 * @param {object} input.opSpec      {id, mechanism, mechanism_subtype?, capability?, parameters,
 *                                    declared_risk?, profile_verified?, trust_state?, profile_version?,
 *                                    write?, pre_capture?, inverse?, host_snapshot?}
 * @param {object} [input.ctx]       Mechanism-specific (fetchFn, world, ...).
 * @param {object} [input.approval]  {required?, auto_fired?, user_confirmed?, ...}
 * @returns {Promise<{record, executionResult, error}>}
 */
export async function dispatchOperation(input) {
  const { userId, nodeId, serviceId = null, intent, opSpec } = input;
  if (!userId || !nodeId) throw new Error('dispatchOperation: userId + nodeId required');
  if (!opSpec?.mechanism) throw new Error('dispatchOperation: opSpec.mechanism required');

  const opId = opSpec.opId || generateOpId();
  const ctx = { ...input.ctx, userId, nodeId, opId };

  const handler = resolveHandler(opSpec.mechanism);
  if (!handler) throw new Error(`unknown mechanism: ${opSpec.mechanism}`);

  // ── capture ─────────────────────────────────────────────────────────────
  let snapshots = [];
  let captureError = null;
  try {
    snapshots = await handler.capture(opSpec, ctx);
  } catch (e) {
    captureError = e.message;
  }

  // ── compute effective risk ──────────────────────────────────────────────
  // Snapshot-capable iff we have a snapshot OR a directly-specified inverse.
  // No-snapshot escalates risk to 'high' — the LLM can't lie about reversibility.
  const declaredRisk = opSpec.declared_risk || 'low';
  const mechFloor = handler.minimumRisk?.(opSpec) || 'low';
  const snapshotCapable = snapshots.length > 0 || !!opSpec.inverse;
  let effectiveRisk = maxRisk(declaredRisk, mechFloor);
  if (!snapshotCapable) effectiveRisk = maxRisk(effectiveRisk, 'high');

  // ── host snapshot (Proxmox/ZFS outer rollback layer) ────────────────────
  // High-risk ops on guests that live inside a snapshot-capable host get an
  // additional whole-guest rollback layer. Failure here is logged but does
  // NOT abort the op — the inner snapshot is still the primary path; the
  // host snapshot is belt-and-suspenders for "stuff we didn't track" cases.
  let hostSnapshot = null;
  if (effectiveRisk === 'high' && input.parent_host) {
    try {
      hostSnapshot = await captureHostSnapshot(input.parent_host, opId, ctx);
    } catch (e) {
      captureError = (captureError ? captureError + '; ' : '') + `host_snapshot: ${e.message}`;
    }
  }

  // ── execute ─────────────────────────────────────────────────────────────
  const startedAt = new Date().toISOString();
  let executionResult = null;
  let executionError = null;
  let outcome = 'success';

  try {
    executionResult = await handler.execute(opSpec, ctx);
    if (executionResult?.exit_code !== 0) outcome = 'failure';
  } catch (e) {
    executionError = e.message;
    outcome = 'failure';
  }
  const completedAt = new Date().toISOString();

  // ── rollback eligibility ────────────────────────────────────────────────
  // Only successful ops with snapshot capability are rollback-eligible.
  // Failed ops never auto-rollback (they may have left the system in a
  // partial state that the inverse wouldn't cleanly undo).
  const rollbackAvailable = outcome === 'success' && snapshotCapable;
  let rollbackMethod;
  if (rollbackAvailable) rollbackMethod = opSpec.mechanism;
  else if (snapshotCapable) rollbackMethod = 'none';   // had a path, but op failed
  else rollbackMethod = 'manual';                       // no path at all

  // ── build + persist record ──────────────────────────────────────────────
  const record = buildOpRecord({
    id: opId,
    ts: startedAt,
    node_id: nodeId,
    service_id: serviceId,
    profile_version: opSpec.profile_version || null,

    intent,

    operation: {
      id: opSpec.id,
      capability: opSpec.capability || null,
      mechanism: opSpec.mechanism,
      mechanism_subtype: opSpec.mechanism_subtype, // permissive — schema doesn't reject extras
      parameters: opSpec.parameters || {},
      risk_class: effectiveRisk,
      profile_verified: !!opSpec.profile_verified,
      trust_state: opSpec.trust_state || 'unverified',
    },

    pre_state: {
      snapshots,
      natural_description: opSpec.pre_state_description || null,
      host_snapshot: hostSnapshot || opSpec.host_snapshot || null,
    },

    execution: {
      started_at: startedAt,
      completed_at: completedAt,
      mechanism_response: executionResult?.mechanism_response || null,
      exit_code: executionResult?.exit_code ?? (executionError ? 1 : null),
      stdout_tail: executionResult?.stdout_tail || null,
      stderr_tail: executionResult?.stderr_tail || null,
      error: executionError || captureError,
    },

    outcome,
    outcome_message: executionResult?.outcome_message || null,
    verification: { performed: false, method: null, passed: null },

    rollback: {
      available: rollbackAvailable,
      method: rollbackMethod,
      inverse_call: opSpec.inverse || null,
    },

    approval: {
      required: input.approval?.required ?? (effectiveRisk !== 'low'),
      auto_fired: input.approval?.auto_fired ?? (effectiveRisk === 'low'),
      user_confirmed: !!input.approval?.user_confirmed,
      confirmed_at: input.approval?.confirmed_at || null,
      confirmation_text: input.approval?.confirmation_text || null,
    },
  });

  writeOpRecord(userId, nodeId, record);

  return { record, executionResult, error: executionError || captureError };
}
