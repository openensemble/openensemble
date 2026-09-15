import { isQuietHours, isQuietEngagement } from './config.mjs';

/** Decide whether an already-useful item deserves a chat interruption. */
export function workDeliveryDecision(item, { config, now = Date.now(), activeChat = false, calendar = null, sourceValid = true, feedback = [] }) {
  if (!sourceValid || ['completed', 'paused'].includes(item.goalStatus)) return { action: 'expire', reason: 'The source changed or the goal is no longer active' };
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return { action: 'expire', reason: 'The useful moment has passed' };
  if (!config?.enabled || !config?.setupComplete || config.workMode === 'off') return { action: 'hold', reason: 'Background preparation is off' };
  if (isQuietHours(config, new Date(now))) return { action: 'hold', reason: 'Quiet hours' };
  if (isQuietEngagement(config) || config.deliveryMode === 'briefing') return { action: 'digest', reason: 'Your delivery preference' };
  if (activeChat) return { action: 'hold', reason: 'A conversation is in progress' };
  // A stale or missing calendar cannot establish that the user is free.
  const fresh = calendar && now - calendar.fetchedAt < 10 * 60_000;
  const busy = fresh && calendar.events?.some(event => {
    if (event.transparency === 'transparent' || event.selfResponse === 'declined') return false;
    const start = Date.parse(event.start?.dateTime || '');
    const end = Date.parse(event.end?.dateTime || '');
    return start <= now && end > now;
  });
  if (busy) return { action: 'hold', reason: 'A calendar event is in progress' };
  const recent = feedback.filter(row => row.kind === item.kind && row.feedback
    && now - Date.parse(row.feedbackAt || '') < 30 * 86_400_000).slice(-10);
  if (recent.some(row => row.feedback === 'not_useful') && !recent.some(row => row.feedback === 'useful' || row.feedback === 'acted')) {
    return { action: 'digest', reason: 'You recently found this kind of help unhelpful' };
  }
  const dueIn = Date.parse(item.dueAt || '') - now;
  const urgent = Number.isFinite(dueIn) && dueIn > 0 && dueIn <= 2 * 3_600_000;
  const positive = recent.filter(row => ['useful', 'acted'].includes(row.feedback)).length;
  const score = (item.goalId ? 0.4 : 0.2) + (urgent ? 0.4 : 0.1)
    + (item.status === 'ready' ? 0.15 : 0) + Math.min(positive * 0.05, 0.15);
  return score >= 0.65
    ? { action: 'notify', reason: urgent ? 'Useful before an approaching deadline' : 'Prepared work for an active goal', score }
    : { action: 'digest', reason: 'Saved for your next review', score };
}

export const INITIATIVE_GUIDANCE = `## Carry the user's work forward
When the user requests an outcome, complete the necessary research, preparation, and verification within the request and existing permissions. Use reasonable defaults for reversible details and ask only when missing information materially blocks the work. Existing approvals continue to apply to their original scope; a new suggestion is not permission to send, buy, delete, or change external systems.
For ongoing work the user asks you to manage, use track_goal with a concrete completion condition, next step, and any stated deadline. Keep it in the current project. Use update_work_goal as verified results change the next step or blocker; mark completed only when the stated condition is met. A saved goal is not itself a scheduled action or a promise of monitoring: describe only the follow-up mode the tool confirms.
Use prepare_work to create a private meeting brief, document summary, reply draft, comparison, or proposed project next steps from the goal and its references. If these tools are not currently present, recover the tasks skill through request_tools first. A draft is not a sent reply, completed task, or finished project. Read the saved result and continue authorized work when useful.
When handing work to a specialist, include the user's intended result, constraints, relevant findings, project and goal IDs, existing authorization, remaining steps, and the completion check. Inspect the returned result and finish the remaining authorized steps. Avoid making the user coordinate the handoff. Do not repeatedly propose a follow-up the user dismissed.`;
