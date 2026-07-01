// @ts-check
/**
 * Per-top-level-user-turn context for learning gates.
 *
 * This intentionally carries only the user's own visible text. Tool arguments
 * are authored by the model; default-arg learning may only count values that
 * can be traced back to the human turn that started the async call tree.
 */
import { AsyncLocalStorage } from 'async_hooks';

const learningTurnContext = new AsyncLocalStorage();

export function runWithLearningTurnContext(ctx, fn) {
  const clean = {
    userId: ctx?.userId || null,
    userText: typeof ctx?.userText === 'string' ? ctx.userText : '',
  };
  return learningTurnContext.run(clean, fn);
}

export function getLearningTurnContext() {
  try {
    return learningTurnContext.getStore() || null;
  } catch {
    return null;
  }
}

export function getLearningUserText() {
  return getLearningTurnContext()?.userText || '';
}
