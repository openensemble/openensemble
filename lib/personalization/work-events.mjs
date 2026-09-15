import { getConfig } from './config.mjs';
import { mutateWorkState, readWorkState, workFingerprint } from './work-store.mjs';
import { redactSecretsInText } from './signal-safety.mjs';

let wake = null;
export function setWorkEventWake(fn) { wake = typeof fn === 'function' ? fn : null; }

/** Persist small event references before waking the debounced worker. */
export async function queueWorkEvent(userId, input) {
  if (!userId || !['calendar', 'goal', 'project', 'task', 'email'].includes(input?.kind)) return false;
  const config = await getConfig(userId);
  if (!config.enabled || !config.setupComplete || !['suggest', 'prepare'].includes(config.workMode)) return false;
  if (input.kind === 'calendar' && !config.sources.calendar) return false;
  if (['email', 'task'].includes(input.kind) && !config.sources.tools) return false;
  if (['goal', 'project'].includes(input.kind) && !config.sources.sessions) return false;
  const event = { kind: input.kind, at: new Date().toISOString() };
  if (input.kind === 'email') {
    // Only a thread explicitly attached to an active goal can enter the store.
    const goals = readWorkState(userId).goals.filter(goal => goal.status === 'active'
      && goal.emailRef?.accountId === input.accountId && goal.emailRef?.threadId === input.threadId);
    if (!goals.length) return false;
    Object.assign(event, { accountId: input.accountId, threadId: input.threadId,
      messageId: String(input.messageId || '').slice(0, 300),
      subject: redactSecretsInText(String(input.subject || ''), 200),
      snippet: redactSecretsInText(String(input.snippet || ''), 2000) });
  }
  for (const key of ['goalId', 'projectId', 'taskId']) if (typeof input[key] === 'string') event[key] = input[key].slice(0, 160);
  const identity = { ...event }; delete identity.at;
  event.key = workFingerprint(identity);
  await mutateWorkState(userId, state => {
    if (!state.events.some(row => row.key === event.key)) state.events.push(event);
    // Calendar/project/goal/task wake-ups are recoverable from their stores;
    // bound event retention and avoid accumulating mail data indefinitely.
    state.events = state.events.filter(row => Date.parse(row.at) > Date.now() - 7 * 86_400_000).slice(-200);
  });
  wake?.(userId);
  return true;
}

/** Hot-path producers cannot fail their original operation on a wake-up error. */
export function signalWorkEvent(userId, input) {
  queueWorkEvent(userId, input).catch(error => console.warn('[proactive-work] event could not be queued:', error.message));
}
