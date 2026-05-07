/**
 * Troubleshooting loop — orchestrates the full diagnostic flow from a
 * failed health signal to a proposed-or-applied fix.
 *
 * Flow:
 *   1. open (or find existing) incident for the (service, signal) pair
 *   2. run the matching diagnostic_recipe (if defined for the signal kind)
 *   3. match a failure_mode against collected diagnostic output
 *   4. propose / auto-apply the matched mode's first fix
 *   5. attach a closing "loop completed" message event
 *
 * This is what watchers fire when a signal goes unhealthy. It's also
 * directly callable from the agent (e.g. "diagnose what's wrong with my
 * pihole") which is how it gets exercised when the watcher path isn't yet
 * wired in.
 *
 * The loop is read-mostly: only the proposeFix step takes a write action,
 * and even then only if profile + risk + verified gates allow.
 */

import { loadProfile } from './service-profile.mjs';
import {
  openIncident,
  appendIncidentEvent,
  loadIncident,
} from './incident.mjs';
import { runDiagnosticRecipe } from './diagnostic-runner.mjs';
import { matchFailureModeHeuristic } from './failure-matcher.mjs';
import { proposeFix } from './fix-proposer.mjs';

/**
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.nodeId
 * @param {string} input.serviceId
 * @param {object} input.signal             {kind, value, expected, fired_at}
 * @param {object} [input.ctx]              forwarded to diagnostic-runner + capability-dispatcher
 *                                          (fetchFn, execFn, auth_override)
 * @param {object} [input.intent]           forwarded into auto-applied fix's op record
 * @param {object} [input.parameters]       forwarded into the fix dispatch
 *
 * @returns {Promise<{
 *   incident_id, profile_loaded, diagnostics_ran, matched_mode,
 *   fix_action, fix_outcome, summary
 * }>}
 */
export async function runTroubleshootingLoop(input) {
  const { userId, nodeId, serviceId, signal } = input;
  if (!signal?.kind) throw new Error('runTroubleshootingLoop: signal.kind required');

  const profile = loadProfile(userId, nodeId, serviceId);
  if (!profile) {
    return {
      profile_loaded: false,
      summary: `no profile for "${serviceId}" on "${nodeId}" — cannot diagnose`,
    };
  }

  // 1. open or join incident
  const inc = openIncident(userId, nodeId, {
    service_id: serviceId,
    profile_version: profile.profile_version,
    triggering_signal: signal,
  });

  // 2. diagnostics
  const diag = await runDiagnosticRecipe({
    userId, nodeId, incidentId: inc.id,
    profile,
    recipeKey: signal.kind,
    ctx: input.ctx,
  });

  // 3. match failure mode (heuristic for now; LLM hook later)
  const reloaded = loadIncident(userId, nodeId, inc.id);
  const matched = matchFailureModeHeuristic(profile, reloaded.diagnostics_collected);
  if (matched) {
    appendIncidentEvent(userId, nodeId, inc.id, {
      type: 'failure_mode_matched',
      payload: {
        mode_id: matched.mode.id,
        score: matched.score,
        matched_cause: matched.matched_cause ?? null,
        matched_symptom: matched.matched_symptom ?? null,
      },
    });
  }

  // 4. propose / auto-apply
  let fixResult = { action: 'no_fix' };
  if (matched) {
    fixResult = await proposeFix({
      userId, nodeId, incidentId: inc.id, profile, matchedMode: matched,
      ctx: input.ctx, intent: input.intent, parameters: input.parameters,
    });
  }

  const summary =
    !diag.ran          ? `Opened incident ${inc.id}; no diagnostic recipe defined for signal "${signal.kind}".`
    : !matched         ? `Opened incident ${inc.id}; ran ${diag.ran} diagnostic step(s); no failure mode matched.`
    : fixResult.action === 'auto_applied' ? `Opened incident ${inc.id}; matched "${matched.mode.id}"; auto-applied fix ${fixResult.fix.op_id} (success=${fixResult.success}).`
    : fixResult.action === 'proposed'      ? `Opened incident ${inc.id}; matched "${matched.mode.id}"; proposed fix ${fixResult.fix.op_id} (awaiting confirmation).`
    : fixResult.action === 'no_fix'        ? `Opened incident ${inc.id}; matched "${matched.mode.id}"; no fix defined.`
    : fixResult.action === 'no_op_for_fix' ? `Opened incident ${inc.id}; matched "${matched.mode.id}"; fix references missing op_id.`
    :                                        `Opened incident ${inc.id}; ran ${diag.ran} diagnostic(s).`;

  return {
    incident_id: inc.id,
    profile_loaded: true,
    diagnostics_ran: diag.ran,
    matched_mode: matched ? matched.mode.id : null,
    matched_score: matched?.score ?? null,
    fix_action: fixResult.action,
    fix_outcome: fixResult.success ?? null,
    fix_op_record_id: fixResult.op_record_id ?? null,
    summary,
  };
}
