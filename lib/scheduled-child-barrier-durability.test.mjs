import { describe, expect, it, vi } from 'vitest';

import {
  completeScheduledChild,
  completeScheduledMain,
  registerScheduledChild,
  registerScheduledMain,
} from './scheduled-child-barrier.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe('scheduled child barrier durable finalization acknowledgement', () => {
  it('waits for async onFinalize and shares one terminal result with duplicate completions', async () => {
    const userId = 'user_barrier_durable';
    const scheduledCtx = {
      originTaskId: 'task_barrier_durable',
      runId: `run_${Date.now()}_${Math.random()}`,
    };
    const finalizeGate = deferred();
    const onFinalize = vi.fn(async () => {
      await finalizeGate.promise;
    });

    registerScheduledMain({ userId, scheduledCtx });
    registerScheduledChild({
      userId,
      scheduledCtx,
      childId: 'worker_1',
      label: 'durable worker',
    });
    completeScheduledMain({ userId, scheduledCtx, onFinalize });

    const first = completeScheduledChild({
      userId,
      scheduledCtx,
      childId: 'worker_1',
      resultText: 'producer result',
    });
    const duplicate = completeScheduledChild({
      userId,
      scheduledCtx,
      childId: 'worker_1',
      resultText: 'must not replace the first terminal result',
    });

    expect(first.tracked).toBe(true);
    expect(duplicate).toMatchObject({ tracked: true, duplicate: true });
    expect(duplicate.finalized).toBe(first.finalized);

    let acknowledged = false;
    first.finalized.then(() => { acknowledged = true; });
    await vi.waitFor(() => expect(onFinalize).toHaveBeenCalledTimes(1));
    expect(onFinalize).toHaveBeenCalledWith(
      '## durable worker\nproducer result',
      { errorCount: 0, timedOut: false },
    );
    expect(acknowledged).toBe(false);

    finalizeGate.resolve();
    await expect(first.finalized).resolves.toEqual({
      ok: true,
      errorCount: 0,
      timedOut: false,
    });
    await expect(duplicate.finalized).resolves.toEqual({
      ok: true,
      errorCount: 0,
      timedOut: false,
    });
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });
});
