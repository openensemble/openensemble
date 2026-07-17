import { describe, expect, it, vi } from 'vitest';

import { iterateUntilAbort } from './abortable-async-iterator.mjs';

describe('abortable async iterator ownership boundary', () => {
  it('releases a caller even when the producer ignores cancellation', async () => {
    const never = new Promise(() => {});
    const returned = vi.fn();
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next: () => never,
          return: returned,
        };
      },
    };
    const ac = new AbortController();
    const consume = (async () => {
      for await (const _ of iterateUntilAbort(iterable, ac.signal, 'owned stream stopped')) { /* none */ }
    })();
    ac.abort('stop requested');
    await expect(consume).rejects.toThrow('stop requested');
    expect(returned).toHaveBeenCalledOnce();
  });

  it('preserves normal events and completion', async () => {
    async function* source() { yield 1; yield 2; }
    const values = [];
    for await (const value of iterateUntilAbort(source(), null)) values.push(value);
    expect(values).toEqual([1, 2]);
  });

  it('propagates an Error abort reason', async () => {
    async function* source() { await new Promise(() => {}); }
    const ac = new AbortController();
    const expected = new Error('deadline exceeded');
    const consume = (async () => {
      for await (const _ of iterateUntilAbort(source(), ac.signal)) { /* none */ }
    })();
    ac.abort(expected);
    await expect(consume).rejects.toBe(expected);
  });
});
