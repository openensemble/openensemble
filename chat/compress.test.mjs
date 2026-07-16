import { describe, expect, it } from 'vitest';
import { LoopGuard } from './compress.mjs';

describe('LoopGuard provider-round ceiling', () => {
  it('permits exactly the configured number of rounds', () => {
    const guard = new LoopGuard(4);
    expect([guard.tick(), guard.tick(), guard.tick(), guard.tick(), guard.tick()])
      .toEqual([true, true, true, true, false]);
    expect(guard.count).toBe(5);
  });

  it('fails closed when configured with no rounds', () => {
    const guard = new LoopGuard(0);
    expect(guard.tick()).toBe(false);
  });
});
