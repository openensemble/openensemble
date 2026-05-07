/**
 * Rollback dispatcher.
 *
 * Reads an immutable op record, validates that rollback is still possible,
 * calls the mechanism handler's restore(), and writes a NEW op record
 * describing the rollback. The original record is never edited; the
 * forward-link from the rollback (`rolls_back_op_id`) is what
 * `getRollbackStatus()` uses to compute that the original was reversed.
 */

import { resolveHandler } from './snapshots/index.mjs';
import {
  findOpRecord,
  getRollbackStatus,
  buildOpRecord,
  writeOpRecord,
  generateOpId,
} from './op-record.mjs';
import { rollbackToHostSnapshot } from './host-snapshot.mjs';

/**
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.nodeId
 * @param {string} input.opId          op to roll back
 * @param {object} [input.intent]      {user_text?, agent?, session_ref?}
 * @param {object} [input.ctx]         mechanism context (fetchFn, world, ...)
 * @returns {Promise<{outcome, message, record?}>}
 */
export async function rollbackOperation(input) {
  const { userId, nodeId, opId } = input;
  if (!userId || !nodeId || !opId) throw new Error('rollbackOperation: userId+nodeId+opId required');

  const orig = findOpRecord(userId, nodeId, opId);
  if (!orig) return { outcome: 'aborted', message: `op ${opId} not found` };

  const status = getRollbackStatus(userId, nodeId, opId);
  if (!status.available) {
    const reason = status.expired ? 'snapshot expired'
      : status.invoked ? 'already rolled back'
      : `method=${status.method}`;
    return { outcome: 'aborted', message: `rollback not available (${reason})` };
  }

  const handler = resolveHandler(orig.operation.mechanism);
  if (!handler) {
    return { outcome: 'aborted', message: `unknown mechanism: ${orig.operation.mechanism}` };
  }

  const rollbackOpId = generateOpId();
  const ctx = { ...input.ctx, userId, nodeId, opId: rollbackOpId };

  const validation = await handler.validate?.(orig, ctx) ?? { valid: true };
  if (!validation.valid) {
    return { outcome: 'aborted', message: `validation failed: ${validation.reason}` };
  }

  const startedAt = new Date().toISOString();
  let result = null;
  let error = null;
  try {
    result = await handler.restore(orig, ctx);
  } catch (e) {
    error = e.message;
  }
  const completedAt = new Date().toISOString();

  const outcome = error ? 'failure' : (result?.outcome || 'success');

  const rollbackRecord = buildOpRecord({
    id: rollbackOpId,
    ts: startedAt,
    node_id: nodeId,
    service_id: orig.service_id,
    profile_version: orig.profile_version,

    intent: {
      user_text: input.intent?.user_text || `rollback of ${opId}`,
      agent: input.intent?.agent || null,
      agent_interpretation: `replay-reverse of operation ${orig.operation.id}`,
      session_ref: input.intent?.session_ref || null,
      scheduled: !!input.intent?.scheduled,
    },

    operation: {
      id: `rollback_${orig.operation.id}`,
      capability: orig.operation.capability,
      mechanism: orig.operation.mechanism,
      mechanism_subtype: orig.operation.mechanism_subtype,
      parameters: orig.operation.parameters,
      risk_class: orig.operation.risk_class,
      profile_verified: orig.operation.profile_verified,
      trust_state: orig.operation.trust_state,
    },

    pre_state: { snapshots: [] },

    execution: {
      started_at: startedAt,
      completed_at: completedAt,
      mechanism_response: null,
      exit_code: outcome === 'success' ? 0 : 1,
      error,
    },

    outcome,
    outcome_message: result?.message || error || null,
    verification: { performed: false, method: null, passed: null },

    // Rollback ops are themselves not auto-rollback-eligible. Rolling back a
    // rollback would be a new forward operation the user can request explicitly.
    rollback: { available: false, method: 'none', inverse_call: null },

    approval: { required: false, auto_fired: true },

    rolls_back_op_id: opId,
  });

  writeOpRecord(userId, nodeId, rollbackRecord);

  return { outcome, message: result?.message || error, record: rollbackRecord };
}

/**
 * Roll back an operation using the HOST-LEVEL snapshot (Proxmox/ZFS) instead
 * of the inner mechanism's surgical snapshot. This reverses the entire guest
 * state — every file, every database, every kernel buffer — to whatever it
 * was when the host snapshot was taken (right before the original op ran).
 *
 * Use this when:
 *   - the surgical rollback failed
 *   - the op's blast radius exceeded what the inner snapshot captured
 *   - you don't trust the inner state and want to go back to "known good"
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.nodeId
 * @param {string} input.opId
 * @param {object} input.parent_host  Current parent_host config (api_url + token + node)
 * @param {object} [input.intent]
 * @param {object} [input.ctx]        {fetchFn, proxmox_token}
 * @returns {Promise<{outcome, message, record?}>}
 */
export async function rollbackOperationHostLevel(input) {
  const { userId, nodeId, opId, parent_host } = input;
  if (!userId || !nodeId || !opId) {
    throw new Error('rollbackOperationHostLevel: userId+nodeId+opId required');
  }
  if (!parent_host) {
    return { outcome: 'aborted', message: 'parent_host config required for host-level rollback' };
  }

  const orig = findOpRecord(userId, nodeId, opId);
  if (!orig) return { outcome: 'aborted', message: `op ${opId} not found` };
  const hs = orig.pre_state?.host_snapshot;
  if (!hs) {
    return { outcome: 'aborted', message: 'no host_snapshot in record (op was not run with host-snapshot wrapper)' };
  }

  const rollbackOpId = generateOpId();
  const startedAt = new Date().toISOString();

  let result;
  try {
    result = await rollbackToHostSnapshot(parent_host, hs, input.ctx);
  } catch (e) {
    result = { outcome: 'failure', message: e.message };
  }
  const completedAt = new Date().toISOString();

  const rollbackRecord = buildOpRecord({
    id: rollbackOpId,
    ts: startedAt,
    node_id: nodeId,
    service_id: orig.service_id,
    profile_version: orig.profile_version,

    intent: {
      user_text: input.intent?.user_text || `host-level rollback of ${opId}`,
      agent: input.intent?.agent || null,
      agent_interpretation: `restore Proxmox/ZFS snapshot ${hs.snapname}`,
      session_ref: input.intent?.session_ref || null,
      scheduled: !!input.intent?.scheduled,
    },

    operation: {
      id: `host_rollback_${orig.operation.id}`,
      capability: orig.operation.capability,
      mechanism: orig.operation.mechanism,
      parameters: { snapname: hs.snapname, host_type: hs.type, vmid: hs.vmid, kind: hs.kind },
      risk_class: 'high', // restoring a whole VM is by definition high
      profile_verified: orig.operation.profile_verified,
      trust_state: orig.operation.trust_state,
    },

    pre_state: { snapshots: [] },

    execution: {
      started_at: startedAt,
      completed_at: completedAt,
      mechanism_response: { snapname: hs.snapname, host_type: hs.type },
      exit_code: result.outcome === 'success' ? 0 : 1,
    },

    outcome: result.outcome,
    outcome_message: result.message,
    verification: { performed: false, method: null, passed: null },

    rollback: { available: false, method: 'none', inverse_call: null },
    approval: { required: false, auto_fired: !!input.intent?.scheduled, user_confirmed: !input.intent?.scheduled },

    rolls_back_op_id: opId,
  });

  writeOpRecord(userId, nodeId, rollbackRecord);

  return { outcome: result.outcome, message: result.message, record: rollbackRecord };
}
