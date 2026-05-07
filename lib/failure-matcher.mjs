/**
 * Failure mode matcher — given an incident's diagnostic output, find the
 * profile.failure_modes entry that best matches.
 *
 * Two modes:
 *   - heuristic   string-match `likely_causes` and `symptom` against diagnostic output
 *   - llm         (future) prompt the LLM to pick. Stub here for now.
 *
 * Heuristic returns the highest-scoring match, or null if nothing matches.
 * Score 1.0 = exact `likely_causes` substring hit; 0.5 = symptom phrase hit.
 *
 * The matcher does NOT mutate the incident — callers do that via
 * appendIncidentEvent so the audit trail is honest about who decided what.
 */

function lower(s) { return String(s ?? '').toLowerCase(); }

/**
 * @param {object} profile
 * @param {Array<{output_excerpt:string}>} diagnostics  from incident.diagnostics_collected
 * @returns {null | {mode, score, matched_cause?, matched_symptom?}}
 */
export function matchFailureModeHeuristic(profile, diagnostics) {
  const modes = profile?.failure_modes || [];
  if (!modes.length || !diagnostics?.length) return null;

  const allOutput = diagnostics.map(d => lower(d.output_excerpt)).join('\n');

  let best = null;

  for (const fm of modes) {
    // Strongest signal: exact phrase from likely_causes appears in output.
    for (const cause of fm.likely_causes || []) {
      if (cause && allOutput.includes(lower(cause))) {
        const candidate = { mode: fm, score: 1.0, matched_cause: cause };
        if (!best || candidate.score > best.score) best = candidate;
      }
    }
    // Weaker signal: symptom phrase hit.
    if (fm.symptom && allOutput.includes(lower(fm.symptom))) {
      const candidate = { mode: fm, score: 0.5, matched_symptom: fm.symptom };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }

  return best;
}

/**
 * LLM-driven matcher (stub). Production callers should wire this to the
 * coordinator agent's chat session. Throws so callers know it's not wired.
 */
export async function matchFailureModeLlm() {
  throw new Error('LLM failure-mode matcher not wired yet; use heuristic for now');
}
