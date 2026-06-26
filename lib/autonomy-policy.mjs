// @ts-check
/**
 * Shared autonomy policy helpers.
 *
 * This is intentionally small and deterministic. It centralizes the safety
 * decisions that were previously scattered across watcher/task/proposal code:
 * which automated actions may run silently, and how to summarize autonomy
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

export function canRunScheduledTaskSilently({ prompt, silent }) {
  if (!silent) return { ok: true, risk: classifyAutomationText(prompt) };
  const risk = classifyAutomationText(prompt);
  if (risk === AUTONOMY_RISK.LOW) return { ok: true, risk };
  return {
    ok: false,
    risk,
    reason: `silent scheduled tasks cannot perform ${risk === AUTONOMY_RISK.DESTRUCTIVE ? 'destructive actions' : 'external side effects'}`,
  };
}

export function summarizeAutonomyPolicy() {
  return {
    silentTasks: 'allowed only for low-risk prompts; side-effect/destructive prompts must be visible',
    execWatchers: 'blocked from agent-created watches unless registered through a human-confirmed route',
    monitorOffers: 'cool down per topic and escalate repeated monitorable questions into review proposals',
    watcherRecovery: 'stuck polling watchers back off cadence and surface status instead of spinning silently',
  };
}
