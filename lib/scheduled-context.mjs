/**
 * AsyncLocalStorage that carries the [SCHEDULED RUN] systemNote across the
 * scheduler → coordinator-agent → ask_agent → sub-agent call chain.
 *
 * Without this, the delegate skill (skills/delegate/execute.mjs) calls
 * streamChat with a null systemNote — so sub-agents like Gina don't know
 * the run is scheduled and fall back to their default "show draft and wait
 * for confirmation" behavior, which never resolves because no human is
 * present.
 *
 * scheduler.runTask wraps the streamChat call in scheduledContext.run({...}),
 * and any code reachable from there can read the note via getStore().
 */
import { AsyncLocalStorage } from 'async_hooks';

export const scheduledContext = new AsyncLocalStorage();

export function getScheduledNote() {
  return scheduledContext.getStore()?.scheduledNote ?? null;
}
