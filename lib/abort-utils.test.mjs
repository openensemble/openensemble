import { describe, expect, it, vi } from 'vitest';
import {
  abortError,
  createLinkedAbortController,
  raceWithAbort,
} from './abort-utils.mjs';
import { awaitUserReply, isAwaitingInput, submitReply } from './task-proxy-context.mjs';

describe('owned operation cancellation', () => {
  it('links a parent abort into a distinct per-operation signal', () => {
    const parent = new AbortController();
    const linked = createLinkedAbortController(parent.signal, 'linked operation cancelled');

    expect(linked.signal).not.toBe(parent.signal);
    expect(linked.signal.aborted).toBe(false);
    parent.abort('stop worker');

    expect(linked.signal.aborted).toBe(true);
    expect(abortError(linked.signal).message).toBe('stop worker');
    linked.dispose();
  });

  it('releases an owner and observes a late rejection from a non-cooperative operation', async () => {
    let rejectLate;
    const late = new Promise((_, reject) => { rejectLate = reject; });
    const owner = new AbortController();
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const raced = raceWithAbort(late, owner.signal, 'tool stopped');
      owner.abort('worker cancelled');
      await expect(raced).rejects.toThrow('worker cancelled');

      rejectLate(new Error('late tool failure'));
      await new Promise(resolve => setImmediate(resolve));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('removes an awaiting-input registration when its worker is cancelled', async () => {
    const watcherId = `abort-wait-${Date.now()}`;
    const owner = new AbortController();
    const waiting = awaitUserReply(watcherId, 'Continue?', {
      timeoutMs: 60_000,
      signal: owner.signal,
    });
    expect(isAwaitingInput(watcherId)).toBe(true);

    owner.abort('worker stopped while waiting');
    await expect(waiting).rejects.toThrow('worker stopped while waiting');
    expect(isAwaitingInput(watcherId)).toBe(false);
    expect(submitReply(watcherId, 'too late')).toEqual({ ok: false, error: 'not waiting' });
  });
});
