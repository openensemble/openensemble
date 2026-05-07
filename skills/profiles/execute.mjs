/**
 * Profiles skill — agent-facing entry points for service-profile management.
 *
 * The actual logic lives in lib/service-profile.mjs and lib/capability-dispatcher.mjs;
 * this file is just the tool dispatch + argument validation + result formatting
 * layer.
 */

import {
  saveProfile,
  loadProfile,
  listProfilesForNode,
  setTrustState,
  renderProfileMd,
  patchProfile,
  ProfileValidationError,
} from '../../lib/service-profile.mjs';
import { verifyProfileReadonly, dispatchCapabilityCall } from '../../lib/capability-dispatcher.mjs';
import { rollbackOperation, rollbackOperationHostLevel } from '../../lib/rollback.mjs';
import { findOpRecord, getRollbackStatus } from '../../lib/op-record.mjs';
import { listIncidents, closeIncident, loadIncident } from '../../lib/incident.mjs';
import { resolveTokenStorage } from '../../lib/token-storage.mjs';
import { makeNodeExecFn } from '../../lib/node-exec-wrapper.mjs';
import {
  registerProfileHealthWatchers,
  unregisterProfileHealthWatchers,
} from '../../scheduler/health-monitor.mjs';

// ── tool implementations ─────────────────────────────────────────────────────

async function execProfileSave(args, userId) {
  const { node_id, service_id, profile } = args;
  if (!node_id || !service_id || !profile) {
    return 'Error: profile_save requires node_id, service_id, and profile.';
  }
  // Tool params authoritatively set service_id + node_id — the profile body
  // is identity-agnostic. (LLM drafts often carry the fixture's node_id; the
  // user is saving this profile against THIS node, so the param wins.)
  const draft = { ...profile, service_id, node_id };
  try {
    const saved = saveProfile(userId, node_id, draft);
    const opCount = saved.operations.length;
    const ro = saved.operations.filter(o => o.readonly).length;
    const lines = [
      `Saved profile "${service_id}" (v${saved.profile_version}) for node "${node_id}". ` +
      `${opCount} operations defined (${ro} read-only). Trust state: ${saved.trust_state}.`,
    ];
    if (saved.agent_requirements?.length) {
      lines.push('');
      lines.push(`**Agent permission requirements declared by this profile:**`);
      for (const r of saved.agent_requirements) {
        const desc = r.type === 'group'        ? `member of group \`${r.name}\``
                   : r.type === 'sudoers'      ? `passwordless sudo for \`${r.name}\``
                   : r.type === 'access_level' ? `access level \`${r.name}\``
                   : r.type === 'capability'   ? `capability \`${r.name}\``
                   : `${r.type} ${r.name ?? ''}`;
        lines.push(`- ${desc}${r.rationale ? ` — ${r.rationale}` : ''}`);
      }
      lines.push('');
      lines.push(`Call \`node_check_agent_permissions\` on the node to confirm these are satisfied. If not, ${'{{USER_NAME}}'} will need to apply the fix (e.g. \`sudo usermod -a -G <group> oe-agent\`) before operations will work cleanly.`);
    }
    lines.push('');
    lines.push(`Run \`profile_verify_readonly\` next to test the read-only ops against the live service.`);
    return lines.join('\n');
  } catch (e) {
    if (e instanceof ProfileValidationError) {
      return `Validation error: ${e.message}. Fix the profile and try again.`;
    }
    return `Error saving profile: ${e.message}`;
  }
}

async function execProfilePatch(args, userId) {
  const { node_id, service_id, edits } = args;
  if (!node_id || !service_id) {
    return 'Error: profile_patch requires node_id, service_id, and edits.';
  }
  if (!Array.isArray(edits) || !edits.length) {
    return 'Error: edits must be a non-empty array of {op, path, value?} objects.';
  }
  let updated;
  try {
    updated = patchProfile(userId, node_id, service_id, edits);
  } catch (e) {
    if (e instanceof ProfileValidationError) {
      return `Validation error after patch: ${e.message}. Original profile preserved.`;
    }
    return `Error patching profile: ${e.message}. Original profile preserved.`;
  }

  // Watcher state is frozen at registration time, so signal edits (cadence,
  // command, expect, etc.) wouldn't take effect until the next trust-state
  // toggle — easy to forget and a frequent foot-gun. If any edit touches
  // health_signals AND the profile is in a monitoring trust state, refresh
  // the watcher so the new signal config takes effect immediately.
  let watcherNote = '';
  const touchesSignals = edits.some(e => typeof e.path === 'string' && e.path.startsWith('health_signals'));
  const isMonitoring = updated.trust_state === 'reviewed' || updated.trust_state === 'proven';
  if (touchesSignals && isMonitoring) {
    try {
      unregisterProfileHealthWatchers(userId, node_id, service_id);
      const r = registerProfileHealthWatchers(userId, node_id, service_id, {
        agentId: `${userId}_coordinator`,
      });
      watcherNote = ` Health monitor refreshed (${r.signal_count} signal${r.signal_count === 1 ? '' : 's'}).`;
    } catch (e) {
      watcherNote = ` (watcher refresh failed: ${e.message} — patch saved, but the live watcher may be using stale signal config until you toggle trust state.)`;
    }
  }

  return `Patched profile "${service_id}" on "${node_id}" — applied ${edits.length} edit${edits.length === 1 ? '' : 's'}. Trust state: ${updated.trust_state}.${watcherNote}`;
}

async function execProfileLoad(args, userId) {
  const { node_id, service_id, render } = args;
  if (!node_id || !service_id) return 'Error: profile_load requires node_id and service_id.';
  const profile = loadProfile(userId, node_id, service_id);
  if (!profile) return `No profile found for "${service_id}" on node "${node_id}".`;
  if (render) return renderProfileMd(profile);
  return JSON.stringify(profile, null, 2);
}

async function execProfileList(args, userId) {
  const { node_id } = args;
  if (!node_id) return 'Error: profile_list requires node_id.';
  const profiles = listProfilesForNode(userId, node_id);
  if (!profiles.length) return `No profiles saved for node "${node_id}".`;
  const lines = [`Profiles for node "${node_id}":`];
  for (const p of profiles) {
    const total = p.operations.length;
    const verified = p.operations.filter(o => o.verified).length;
    lines.push(
      `- **${p.service_id}** (v${p.profile_version}) — ${p.trust_state}, ${verified}/${total} ops verified, endpoint: ${p.endpoint || 'n/a'}`
    );
  }
  return lines.join('\n');
}

async function execProfileSetTrustState(args, userId) {
  const { node_id, service_id, state } = args;
  if (!node_id || !service_id || !state) {
    return 'Error: profile_set_trust_state requires node_id, service_id, state.';
  }
  let updated;
  try {
    updated = setTrustState(userId, node_id, service_id, state, userId);
  } catch (e) {
    return `Error: ${e.message}`;
  }

  // Auto-manage health watchers based on the new trust state.
  // Going to reviewed/proven → register watchers (idempotent: tear down first).
  // Going back to unverified → tear them down. The user shouldn't have to
  // remember to manually start/stop monitoring; that's the point of approval.
  let watcherNote = '';
  try {
    if (state === 'reviewed' || state === 'proven') {
      unregisterProfileHealthWatchers(userId, node_id, service_id);
      if ((updated.health_signals || []).length > 0) {
        const reg = registerProfileHealthWatchers(userId, node_id, service_id, {
          agentId: `${userId}_coordinator`,
        });
        watcherNote = ` Started health monitor (${reg.signal_count} signal${reg.signal_count === 1 ? '' : 's'}).`;
      }
    } else if (state === 'unverified') {
      const removed = unregisterProfileHealthWatchers(userId, node_id, service_id);
      if (removed > 0) watcherNote = ` Stopped health monitor.`;
    }
  } catch (e) {
    watcherNote = ` (watcher management failed: ${e.message})`;
  }

  return `Profile "${service_id}" on "${node_id}" is now **${updated.trust_state}**.${watcherNote}`;
}

async function execProfileVerifyReadonly(args, userId) {
  const { node_id, service_id, auth_token } = args;
  if (!node_id || !service_id) return 'Error: profile_verify_readonly requires node_id and service_id.';

  const profile = loadProfile(userId, node_id, service_id);
  if (!profile) return `No profile found for "${service_id}" on "${node_id}".`;

  // Resolve auth: explicit param wins, else look up via the profile's token_storage.
  let resolvedAuth = auth_token;
  if (resolvedAuth === undefined) {
    const ref = profile.control_surface?.api?.token_storage;
    if (ref) resolvedAuth = resolveTokenStorage(userId, ref);
  }
  const authMethod = profile.control_surface?.api?.auth_method;
  if (authMethod && authMethod !== 'none' && !resolvedAuth) {
    return `Error: profile auth_method=${authMethod} but no token resolved. Pass auth_token explicitly or store the token at "${profile.control_surface.api.token_storage}".`;
  }

  try {
    // Build a full ctx (execFn for cli/config_file, fetchFn for http) so
    // verifying readonly ops actually works regardless of mechanism. Using
    // just auth_override here meant CLI-shaped read-only ops failed with
    // "cli mechanism requires ctx.execFn" — the verifier had no shell.
    const baseCtx = await buildOpCtx(userId, node_id, profile);
    const summary = await verifyProfileReadonly({
      userId, nodeId: node_id, serviceId: service_id,
      ctx: { ...baseCtx, auth_override: resolvedAuth ?? baseCtx.auth_override },
    });
    const lines = [
      `Verification of "${service_id}" on "${node_id}":`,
      `- Tested: ${summary.tested}, passed: ${summary.passed}, failed: ${summary.failed}, skipped: ${summary.skipped}`,
    ];
    for (const r of summary.results) {
      const mark = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '—';
      lines.push(`  ${mark} ${r.op_id} (${r.status})${r.reason ? ` — ${r.reason}` : ''}${r.error ? ` — ${r.error}` : ''}`);
    }
    return lines.join('\n');
  } catch (e) {
    return `Error during verification: ${e.message}`;
  }
}

// Build the standard ctx for dispatching an op against a node:
//   - resolve auth token via the profile's declared token_storage
//   - bind a node-exec function for cli/config_file mechanisms
//   - fetchFn defaults to globalThis.fetch
async function buildOpCtx(userId, nodeId, profile) {
  const storageRef = profile?.control_surface?.api?.token_storage;
  const auth = storageRef ? resolveTokenStorage(userId, storageRef) : null;
  return {
    fetchFn:       globalThis.fetch,
    execFn:        makeNodeExecFn(userId, nodeId),
    auth_override: auth || '',
  };
}

// Resolve parent_host for a node, lazily importing node-registry to keep
// this skill loadable in tests that don't pull in the WS-bound registry.
async function lookupParentHost(userId, nodeId) {
  try {
    const { getParentHost } = await import('../nodes/node-registry.mjs');
    return getParentHost(nodeId, userId);
  } catch { return null; }
}

async function execDispatchOp(args, userId) {
  const { node_id, service_id, op_id, parameters, user_text } = args;
  if (!node_id || !service_id || !op_id) {
    return 'Error: dispatch_op requires node_id, service_id, op_id.';
  }
  const profile = loadProfile(userId, node_id, service_id);
  if (!profile) return `No profile found for "${service_id}" on "${node_id}". Save one first via profile_save.`;

  const ctx = await buildOpCtx(userId, node_id, profile);
  const parent_host = await lookupParentHost(userId, node_id);

  let result;
  try {
    result = await dispatchCapabilityCall({
      userId, nodeId: node_id, serviceId: service_id, opId: op_id,
      parameters: parameters || {},
      intent: { user_text: user_text || `${op_id}(${JSON.stringify(parameters || {})})`, agent: 'profiles' },
      ctx,
      parent_host,
    });
  } catch (e) {
    return `Dispatch error: ${e.message}`;
  }

  const r = result.record;
  const lines = [`Operation \`${op_id}\` on "${node_id}" — outcome: **${r.outcome}** (risk: ${r.operation.risk_class})`];
  if (r.outcome_message) lines.push(r.outcome_message);
  if (r.execution.error) lines.push(`Error: ${r.execution.error}`);
  // Surface stderr_tail so agents see the real reason for CLI failures
  // (e.g. "Please enter your password" → caller knows sudo wasn't usable
  // and can suggest the group-add or API-auth fix). Without this, agents
  // pattern-match to recent failures and give wrong root-cause guesses.
  if (r.outcome === 'failure' && r.execution.stderr_tail) {
    lines.push(`stderr: ${r.execution.stderr_tail}`);
  }
  if (r.outcome === 'failure' && r.execution.exit_code != null && r.execution.exit_code !== 0) {
    lines.push(`exit_code: ${r.execution.exit_code}`);
  }
  if (r.rollback.available) {
    lines.push(`Rollback: available via \`rollback_op id=${r.id}\`.`);
  } else if (r.rollback.method === 'manual') {
    lines.push(`Rollback: manual only (no inverse defined).`);
  }
  if (r.pre_state.host_snapshot) {
    lines.push(`Host snapshot taken: \`${r.pre_state.host_snapshot.snapname}\` (${r.pre_state.host_snapshot.type}). Use \`rollback_op id=${r.id} host_level=true\` to restore the whole guest.`);
  }
  lines.push(`Op id: \`${r.id}\``);
  return lines.join('\n');
}

async function execRollbackOp(args, userId) {
  const { node_id, op_id, host_level } = args;
  if (!node_id || !op_id) return 'Error: rollback_op requires node_id and op_id.';

  const orig = findOpRecord(userId, node_id, op_id);
  if (!orig) return `Op \`${op_id}\` not found on "${node_id}".`;
  const serviceId = orig.service_id;
  const profile = serviceId ? loadProfile(userId, node_id, serviceId) : null;
  const ctx = profile ? await buildOpCtx(userId, node_id, profile) : { fetchFn: globalThis.fetch, execFn: makeNodeExecFn(userId, node_id) };

  if (host_level) {
    const parent_host = await lookupParentHost(userId, node_id);
    if (!parent_host) return `Cannot host-level rollback: node "${node_id}" has no parent_host configured. Wire one with node_set_parent_host.`;
    const r = await rollbackOperationHostLevel({
      userId, nodeId: node_id, opId: op_id,
      parent_host,
      intent: { user_text: `host-level undo of ${op_id}`, agent: 'profiles' },
      ctx,
    });
    return `Host-level rollback: **${r.outcome}**. ${r.message}`;
  }

  const status = getRollbackStatus(userId, node_id, op_id);
  if (!status.available) {
    return `Surgical rollback unavailable for \`${op_id}\` (${status.invoked ? 'already rolled back' : status.expired ? 'snapshot expired' : status.method}). ` +
      (orig.pre_state?.host_snapshot ? 'Host-level rollback IS available — pass host_level=true.' : '');
  }
  const r = await rollbackOperation({
    userId, nodeId: node_id, opId: op_id,
    intent: { user_text: `undo ${op_id}`, agent: 'profiles' },
    ctx,
  });
  return `Surgical rollback: **${r.outcome}**. ${r.message}`;
}

async function execIncidentList(args, userId) {
  const { node_id, open_only } = args;
  if (!node_id) return 'Error: incident_list requires node_id.';
  const incidents = listIncidents(userId, node_id, { openOnly: !!open_only });
  if (!incidents.length) return `No${open_only ? ' open' : ''} incidents for node "${node_id}".`;
  const lines = [`${open_only ? 'Open i' : 'I'}ncidents for "${node_id}":`];
  for (const inc of incidents) {
    lines.push(
      `- **${inc.id}** [${inc.status}] ${inc.service_id || 'no-service'} — ` +
      `${inc.triggering_signal?.kind ?? 'unknown signal'}, opened ${inc.ts_opened}` +
      (inc.fix_attempts.length ? `, ${inc.fix_attempts.length} fix attempt(s)` : '') +
      (inc.ts_closed ? `, closed ${inc.ts_closed}` : '')
    );
  }
  return lines.join('\n');
}

async function execIncidentResolve(args, userId) {
  const { node_id, incident_id, summary, status } = args;
  if (!node_id || !incident_id) {
    return 'Error: incident_resolve requires node_id and incident_id.';
  }
  const finalStatus = status || 'resolved';
  if (!['resolved', 'abandoned'].includes(finalStatus)) {
    return `Error: status must be 'resolved' or 'abandoned' (got ${JSON.stringify(status)}).`;
  }
  const existing = loadIncident(userId, node_id, incident_id);
  if (!existing) {
    return `Error: incident "${incident_id}" not found on node "${node_id}".`;
  }
  if (existing.ts_closed) {
    return `Incident "${incident_id}" was already closed at ${existing.ts_closed} (status: ${existing.status}).`;
  }
  try {
    closeIncident(userId, node_id, incident_id, summary || `Closed by user via incident_resolve`, finalStatus);
    return `Closed incident "${incident_id}" on "${node_id}" — status: ${finalStatus}.`;
  } catch (e) {
    return `Error closing incident: ${e.message}`;
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export default async function execute(name, args, userId, _agentId, _ctx) {
  const a = args || {};
  switch (name) {
    case 'profile_save':              return execProfileSave(a, userId);
    case 'profile_patch':             return execProfilePatch(a, userId);
    case 'profile_load':              return execProfileLoad(a, userId);
    case 'profile_list':              return execProfileList(a, userId);
    case 'profile_set_trust_state':   return execProfileSetTrustState(a, userId);
    case 'profile_verify_readonly':   return execProfileVerifyReadonly(a, userId);
    case 'dispatch_op':               return execDispatchOp(a, userId);
    case 'rollback_op':               return execRollbackOp(a, userId);
    case 'incident_list':             return execIncidentList(a, userId);
    case 'incident_resolve':          return execIncidentResolve(a, userId);
    default:                          return `Unknown tool: ${name}`;
  }
}
