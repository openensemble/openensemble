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

/**
 * Hide a tool from later model rounds in the current logical turn.
 *
 * The original fullTools catalog stays intact for routing telemetry. Recovery
 * paths consult suppressedToolNames before adding anything back.
 */
export function suppressToolForTurn(name) {
  if (typeof name !== 'string' || !name) return false;
  const store = getToolRouterContext();
  if (!store?.agent) return false;
  if (!(store.suppressedToolNames instanceof Set)) {
    store.suppressedToolNames = new Set();
  }
  const newlySuppressed = !store.suppressedToolNames.has(name);
  store.suppressedToolNames.add(name);
  if (Array.isArray(store.agent.tools)) {
    store.agent.tools = store.agent.tools.filter(tool =>
      (tool?.function?.name ?? tool?.name) !== name);
  }
  return newlySuppressed;
}

export function isToolSuppressedForTurn(name, agent = null) {
  const store = getToolRouterContext();
  if (!store || (agent && store.agent !== agent)) return false;
  return store.suppressedToolNames instanceof Set
    && store.suppressedToolNames.has(name);
}

/** Bind every resume of an async iterable to one router store. */
export function bindToolRouterContext(iterable, store) {
  if (!store || !iterable || typeof iterable[Symbol.asyncIterator] !== 'function') return iterable;
  const iterator = iterable[Symbol.asyncIterator]();
  const invoke = (method, value) => toolRouterContext.run(store, () => {
    const fn = iterator?.[method];
    if (typeof fn === 'function') return fn.call(iterator, value);
    if (method === 'throw') return Promise.reject(value);
    return Promise.resolve({ done: true, value });
  });
  return {
    [Symbol.asyncIterator]() { return this; },
    next(value) { return invoke('next', value); },
    return(value) { return invoke('return', value); },
    throw(error) { return invoke('throw', error); },
  };
}
