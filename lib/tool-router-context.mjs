// @ts-check
/**
 * AsyncLocalStorage that lets the request_tools meta-tool reach back into
 * the running streamChat() to mutate the agent's tool list mid-turn.
 *
 * Without this, executeSkillTool would have only `agentId` (a string) and
 * no way to add tools to the in-memory agent object the provider is
 * looping over. Same pattern scheduledContext uses to thread the
 * [SCHEDULED RUN] note across nested ask_agent calls.
 *
 * streamChat wraps the entire turn:
 *   toolRouterContext.run({ agent, fullTools, initiallyIncludedSkills, addedSkills: new Set() }, async () => { ... })
 *
 * skills/coordinator/execute.mjs:request_tools reads the store:
 *   const ctx = toolRouterContext.getStore();
 *   if (ctx) { expandToolsByReason({ agent: ctx.agent, fullTools: ctx.fullTools, ... }); }
 */
import { AsyncLocalStorage } from 'async_hooks';

export const toolRouterContext = new AsyncLocalStorage();

export function getToolRouterContext() {
  return toolRouterContext.getStore() ?? null;
}
