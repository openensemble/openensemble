/**
 * Fix proposer — given a matched failure mode, decide whether to auto-apply
 * a fix or surface it for user confirmation.
 *
 * Decision matrix:
 *   - profile.trust_state == 'unverified'  → never auto. Always propose.
 *   - profile.trust_state in {reviewed, proven} AND fix.risk == 'low'
 *       AND op exists AND op.verified  → auto-apply.
 *   - everything else → propose only.
 *
 * Auto-applies route through capability-dispatcher (so they get a real
 * op record + rollback eligibility + activity-log entry). Proposals
 * append a `fix_proposed` event to the incident and move status to
 * `fix_proposed`; the user (or agent on behalf of user) calls
 * applyProposedFix() once they've decided.
 */

import { dispatchCapabilityCall } from './capability-dispatcher.mjs';
import { findOperation } from './service-profile.mjs';
import {
  appendIncidentEvent,
  recordFixAttempt,
  setIncidentStatus,
} from './incident.mjs';

function shouldAutoApply(profile, fix, op) {
  if (!op) return false;
  if (!op.verified) return false;
  if (profile.trust_state === 'unverified') return false;
  if (fix.risk !== 'low') return false;
  return true;
}

/**
 * Propose (or auto-apply) the first fix from the matched failure mode.
 *
 * @returns {Promise<{
 *   action: 'auto_applied' | 'proposed' | 'no_fix' | 'no_op_for_fix',
 *   fix?: {op_id, risk, applies_when?},
 *   op_record_id?: string,
 *   success?: boolean,
 *   message?: string,
 * }>}
 */
export async function proposeFix(input) {
  const { userId, nodeId, incidentId, profile, matchedMode, ctx, intent } = input;

  const fix = matchedMode?.mode?.fixes?.[0];
  if (!fix) {
    return { action: 'no_fix', message: 'matched failure mode has no fixes defined' };
  }
  const op = findOperation(profile, fix.op_id);
  if (!op) {
    appendIncidentEvent(userId, nodeId, incidentId, {
      type: 'message',
      payload: { error: `fix references missing op_id "${fix.op_id}"` },
    });
    return { action: 'no_op_for_fix', fix };
  }

  if (shouldAutoApply(profile, fix, op)) {
    // Lookup parent_host so a high-risk fix on a Proxmox-hosted service gets
    // the whole-guest snapshot insurance even when fired autonomously.
    let parent_host = input.parent_host;
    if (parent_host === undefined) {
      try {
        const { getParentHost } = await import('../skills/nodes/node-registry.mjs');
        parent_host = getParentHost(nodeId, userId);
      } catch { parent_host = null; }
    }
    const result = await dispatchCapabilityCall({
      userId, nodeId, serviceId: profile.service_id, opId: fix.op_id,
      parameters: input.parameters || {},
      intent: intent || {
        user_text: `[auto-fix incident ${incidentId}: ${fix.op_id}]`,
        agent: 'fix-proposer',
        scheduled: true,
      },
      ctx,
      parent_host,
    });
    const success = result.record.outcome === 'success';
    recordFixAttempt(userId, nodeId, incidentId, {
      op_id_in_profile: fix.op_id,
      op_record_id: result.record.id,
      outcome: success ? 'success' : 'failure',
      message: result.record.outcome_message ?? result.record.execution.error,
    });
    return {
      action: 'auto_applied',
      fix,
      op_record_id: result.record.id,
      success,
      message: result.record.outcome_message ?? result.record.execution.error ?? 'applied',
    };
  }

  // Just propose. Append to incident, await user/agent decision.
  appendIncidentEvent(userId, nodeId, incidentId, {
    type: 'fix_proposed',
    payload: {
      op_id: fix.op_id,
      risk: fix.risk,
      applies_when: fix.applies_when || null,
      reason_not_auto: !op.verified
        ? 'op not verified in profile yet'
        : profile.trust_state === 'unverified'
          ? 'profile trust_state is unverified'
          : `risk=${fix.risk} requires user confirmation`,
    },
  });
  setIncidentStatus(userId, nodeId, incidentId, 'fix_proposed', { force: true });

  return {
    action: 'proposed',
    fix,
    message: `Proposed ${fix.op_id} (risk=${fix.risk}); awaiting user confirmation.`,
  };
}

/**
 * Apply a previously-proposed fix after user/agent confirms. Goes through
 * capability-dispatcher with `approval.user_confirmed: true` so the op record
 * reflects the consent.
 */
export async function applyProposedFix(input) {
  const { userId, nodeId, incidentId, profile, fix, parameters, intent, ctx, confirmedBy } = input;
  const op = findOperation(profile, fix.op_id);
  if (!op) throw new Error(`op "${fix.op_id}" not in profile`);

  const result = await dispatchCapabilityCall({
    userId, nodeId, serviceId: profile.service_id, opId: fix.op_id,
    parameters: parameters || {},
    intent: intent || { user_text: `[apply fix for incident ${incidentId}]`, agent: 'fix-proposer' },
    ctx,
    approval: {
      required: true,
      auto_fired: false,
      user_confirmed: true,
      confirmed_at: new Date().toISOString(),
      confirmation_text: confirmedBy ? `confirmed by ${confirmedBy}` : 'confirmed',
    },
  });

  const success = result.record.outcome === 'success';
  recordFixAttempt(userId, nodeId, incidentId, {
    op_id_in_profile: fix.op_id,
    op_record_id: result.record.id,
    outcome: success ? 'success' : 'failure',
    message: result.record.outcome_message ?? result.record.execution.error,
  });

  return { applied: true, success, op_record_id: result.record.id };
}
