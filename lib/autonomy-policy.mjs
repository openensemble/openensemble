// @ts-check
/**
 * Shared autonomy policy helpers.
 *
 * This is intentionally small and deterministic. It centralizes the safety
 * decisions that were previously scattered across watcher/task/proposal code:
 * how automation risk is classified, and how to summarize autonomy
 * state for review surfaces.
 */

const DESTRUCTIVE_RE = /\b(delete|remove|purge|erase|destroy|terminate|shutdown|shut down|kill|drop|truncate|wipe|reset|rollback)\b/i;
const EXTERNAL_SIDE_EFFECT_RE = /\b(send|email|message|post|publish|buy|purchase|order|pay|charge|transfer|deploy|merge|commit|push)\b/i;

export const AUTONOMY_RISK = Object.freeze({
  LOW: 'low',
  SIDE_EFFECT: 'side_effect',
  DESTRUCTIVE: 'destructive',
});

export function classifyAutomationText(text) {
  const s = String(text || '');
  if (DESTRUCTIVE_RE.test(s)) return AUTONOMY_RISK.DESTRUCTIVE;
  if (EXTERNAL_SIDE_EFFECT_RE.test(s)) return AUTONOMY_RISK.SIDE_EFFECT;
  return AUTONOMY_RISK.LOW;
}

export function summarizeAutonomyPolicy() {
  return {
    scheduledTasks: 'runs and results are recorded in Tasks → Ledger, separate from chat; tool authorization still applies',
    execWatchers: 'blocked from agent-created watches unless registered through a human-confirmed route',
    monitorOffers: 'cool down per topic and escalate repeated monitorable questions into review proposals',
    watcherRecovery: 'stuck polling watchers back off cadence and surface status instead of spinning silently',
  };
}
