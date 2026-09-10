import { beginTurn, turnTraceContext } from './turn-trace-context.mjs';

// Async generators resume in their consumer's context. Bind every resume,
// including cleanup, so a timer cannot reuse the chat that created it.
export async function* iterateInDetachedTurn(factory, identity) {
  const turn = turnTraceContext.run(undefined, () => beginTurn({ ...identity, forceRoot: true }));
  const iterator = turnTraceContext.run(turn, factory)[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      const step = await turnTraceContext.run(turn, () => iterator.next());
      if (step.done) { complete = true; return step.value; }
      yield step.value;
    }
  } finally {
    if (!complete && iterator.return) await turnTraceContext.run(turn, () => iterator.return());
  }
}
