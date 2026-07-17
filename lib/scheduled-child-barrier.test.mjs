import { describe, expect, it, vi } from 'vitest';

import {
  completeScheduledChild,
  completeScheduledMain,
  getScheduledChildGroup,
  registerScheduledChild,
  registerScheduledMain,
} from './scheduled-child-barrier.mjs';

let sequence = 0;

function fixture() {
  const id = ++sequence;
  return {
    userId: `scheduled-barrier-user-${id}`,
    scheduledCtx: {
      originTaskId: `schedule-${id}`,
      runId: `run-${id}`,
      originTaskOwnerId: `scheduled-barrier-user-${id}`,
      originTaskAgent: 'jarvis_lab',
    },
  };
}

describe('scheduled background child barrier', () => {
  it('does not finalize until the main turn and every background child settle', async () => {
    const key = fixture();
    const onContinue = vi.fn(async () => {});
    const onFinalize = vi.fn(async () => {});

    registerScheduledMain({ ...key, label: 'scheduled workflow' });
    registerScheduledChild({ ...key, childId: 'slow-tool', label: 'slow tool', kind: 'tool' });
    completeScheduledMain({
      ...key,
      resultText: 'The slow tool is still running.',
      onContinue,
      onFinalize,
    });
    await Promise.resolve();

    expect(onContinue).not.toHaveBeenCalled();
    expect(onFinalize).not.toHaveBeenCalled();
    expect(getScheduledChildGroup(key)).toMatchObject({ pendingCount: 1, doneCount: 1 });

    completeScheduledChild({ ...key, childId: 'slow-tool', resultText: 'real tool result' });
    await vi.waitFor(() => expect(onFinalize).toHaveBeenCalledOnce());

    expect(onContinue).toHaveBeenCalledOnce();
    expect(onContinue.mock.calls[0][0]).toContain('real tool result');
    expect(onFinalize.mock.calls[0][0]).toContain('real tool result');
    expect(onFinalize.mock.calls[0][1]).toMatchObject({ errorCount: 0, timedOut: false });
    expect(getScheduledChildGroup(key)).toBeNull();
  });

  it('makes duplicate main completion idempotent before and after finalization', async () => {
    const key = fixture();
    const firstFinalize = vi.fn(async () => {});
    const duplicateFinalize = vi.fn(async () => {});

    registerScheduledMain({ ...key });
    registerScheduledChild({ ...key, childId: 'child', label: 'child', kind: 'tool' });
    completeScheduledMain({ ...key, onFinalize: firstFinalize });
    completeScheduledMain({ ...key, onFinalize: duplicateFinalize });
    completeScheduledChild({ ...key, childId: 'child', resultText: 'child result' });
    await vi.waitFor(() => expect(firstFinalize).toHaveBeenCalledOnce());

    expect(duplicateFinalize).not.toHaveBeenCalled();
    completeScheduledMain({ ...key, onFinalize: duplicateFinalize });
    await Promise.resolve();
    expect(firstFinalize).toHaveBeenCalledOnce();
    expect(duplicateFinalize).not.toHaveBeenCalled();
  });

  it('refuses late main or child registration after a run has finalized', async () => {
    const key = fixture();
    const onFinalize = vi.fn(async () => {});

    registerScheduledMain({ ...key });
    completeScheduledMain({ ...key, onFinalize });
    await vi.waitFor(() => expect(onFinalize).toHaveBeenCalledOnce());

    expect(registerScheduledMain({ ...key })).toBeNull();
    expect(registerScheduledChild({
      ...key,
      childId: 'late-child',
      label: 'late child',
      kind: 'tool',
    })).toBeNull();
    expect(getScheduledChildGroup(key)).toBeNull();
  });

  it('tracks work spawned by a reaction and still finalizes exactly once', async () => {
    const key = fixture();
    const onFinalize = vi.fn(async () => {});
    let reactionRounds = 0;
    const onContinue = vi.fn(async () => {
      reactionRounds++;
      if (reactionRounds === 1) {
        registerScheduledChild({
          ...key,
          childId: 'reaction-child',
          label: 'dependent delivery',
          kind: 'tool',
        });
      }
    });

    registerScheduledMain({ ...key });
    registerScheduledChild({ ...key, childId: 'producer', label: 'producer', kind: 'tool' });
    completeScheduledMain({ ...key, onContinue, onFinalize });
    completeScheduledChild({ ...key, childId: 'producer', resultText: 'document id doc_123' });

    await vi.waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    expect(onFinalize).not.toHaveBeenCalled();
    expect(getScheduledChildGroup(key)).toMatchObject({ pendingCount: 1 });

    completeScheduledChild({ ...key, childId: 'reaction-child', resultText: 'email sent' });
    await vi.waitFor(() => expect(onFinalize).toHaveBeenCalledOnce());

    expect(onContinue).toHaveBeenCalledTimes(2);
    expect(onContinue.mock.calls[1][0]).toContain('email sent');
    expect(onContinue.mock.calls[1][0]).not.toContain('document id doc_123');
    expect(onContinue.mock.calls[1][1].cumulativeAggregate).toContain('document id doc_123');
    expect(onContinue.mock.calls[1][1].cumulativeAggregate).toContain('email sent');
    expect(onFinalize.mock.calls[0][0]).toContain('document id doc_123');
    expect(onFinalize.mock.calls[0][0]).toContain('email sent');
    const duplicate = completeScheduledChild({
      ...key,
      childId: 'reaction-child',
      resultText: 'duplicate completion',
    });
    await Promise.resolve();
    expect(duplicate).toMatchObject({ tracked: false });
    expect(onFinalize).toHaveBeenCalledOnce();
  });

  it('runs another reaction when a child starts and finishes before the prior reaction returns', async () => {
    const key = fixture();
    const onFinalize = vi.fn(async () => {});
    const onContinue = vi.fn(async (_aggregate, { round }) => {
      if (round !== 1) return;
      registerScheduledChild({ ...key, childId: 'fast-child', label: 'fast child', kind: 'tool' });
      completeScheduledChild({ ...key, childId: 'fast-child', resultText: 'fast child result' });
    });

    registerScheduledMain({ ...key });
    registerScheduledChild({ ...key, childId: 'seed', label: 'seed', kind: 'tool' });
    completeScheduledMain({ ...key, onContinue, onFinalize });
    completeScheduledChild({ ...key, childId: 'seed', resultText: 'seed result' });

    await vi.waitFor(() => expect(onFinalize).toHaveBeenCalledOnce());
    expect(onContinue).toHaveBeenCalledTimes(2);
    expect(onContinue.mock.calls[1][0]).toContain('fast child result');
    expect(onContinue.mock.calls[1][0]).not.toContain('seed result');
    expect(onContinue.mock.calls[1][1].cumulativeAggregate).toContain('seed result');
    expect(onContinue.mock.calls[1][1].cumulativeAggregate).toContain('fast child result');
    expect(onFinalize.mock.calls[0][1]).toMatchObject({ errorCount: 0, timedOut: false });
  });

  it('propagates a background child error into final status', async () => {
    const key = fixture();
    const onFinalize = vi.fn(async () => {});

    registerScheduledMain({ ...key });
    registerScheduledChild({ ...key, childId: 'failed-child', label: 'failed child', kind: 'delegate' });
    completeScheduledMain({ ...key, onFinalize });
    completeScheduledChild({ ...key, childId: 'failed-child', errorMsg: 'upstream failed' });

    await vi.waitFor(() => expect(onFinalize).toHaveBeenCalledOnce());
    expect(onFinalize.mock.calls[0][0]).toContain('ERROR: upstream failed');
    expect(onFinalize.mock.calls[0][1]).toMatchObject({ errorCount: 1, timedOut: false });
  });

  it('marks a continuation exception as a task failure', async () => {
    const key = fixture();
    const onFinalize = vi.fn(async () => {});

    registerScheduledMain({ ...key });
    registerScheduledChild({ ...key, childId: 'producer', label: 'producer', kind: 'tool' });
    completeScheduledMain({
      ...key,
      onContinue: async () => { throw new Error('dependent action failed'); },
      onFinalize,
    });
    completeScheduledChild({ ...key, childId: 'producer', resultText: 'producer result' });

    await vi.waitFor(() => expect(onFinalize).toHaveBeenCalledOnce());
    expect(onFinalize.mock.calls[0][0]).toContain('ERROR: dependent action failed');
    expect(onFinalize.mock.calls[0][1]).toMatchObject({ errorCount: 1, timedOut: false });
  });

  it('fails instead of claiming success when the watchdog expires with a child running', async () => {
    vi.useFakeTimers();
    try {
      const key = fixture();
      const onFinalize = vi.fn(async () => {});

      registerScheduledMain({ ...key });
      registerScheduledChild({ ...key, childId: 'hung-child', label: 'hung child', kind: 'tool' });
      completeScheduledMain({ ...key, onFinalize });
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      await Promise.resolve();

      expect(onFinalize).toHaveBeenCalledOnce();
      expect(onFinalize.mock.calls[0][0]).toContain('timed out after 30 minutes');
      expect(onFinalize.mock.calls[0][1]).toMatchObject({ errorCount: 1, timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats the watchdog as an inactivity timeout and rearms it on child progress', async () => {
    vi.useFakeTimers();
    try {
      const key = fixture();
      const onFinalize = vi.fn(async () => {});

      registerScheduledMain({ ...key });
      registerScheduledChild({ ...key, childId: 'stage-a', label: 'stage a', kind: 'tool' });
      registerScheduledChild({ ...key, childId: 'stage-b', label: 'stage b', kind: 'tool' });
      completeScheduledMain({ ...key, onFinalize });

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      completeScheduledChild({ ...key, childId: 'stage-a', resultText: 'stage a done' });
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(onFinalize).not.toHaveBeenCalled();

      completeScheduledChild({ ...key, childId: 'stage-b', resultText: 'stage b done' });
      await Promise.resolve();
      await Promise.resolve();
      expect(onFinalize).toHaveBeenCalledOnce();
      expect(onFinalize.mock.calls[0][1]).toMatchObject({ errorCount: 0, timedOut: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a hung continuation as failed when the watchdog expires', async () => {
    vi.useFakeTimers();
    let releaseContinuation;
    try {
      const key = fixture();
      const onFinalize = vi.fn(async () => {});
      const hung = new Promise(resolve => { releaseContinuation = resolve; });

      registerScheduledMain({ ...key });
      registerScheduledChild({ ...key, childId: 'producer', label: 'producer', kind: 'tool' });
      completeScheduledMain({ ...key, onContinue: () => hung, onFinalize });
      completeScheduledChild({ ...key, childId: 'producer', resultText: 'producer result' });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      await Promise.resolve();

      expect(onFinalize).toHaveBeenCalledOnce();
      expect(onFinalize.mock.calls[0][0]).toContain('background barrier timed out');
      expect(onFinalize.mock.calls[0][1]).toMatchObject({ errorCount: 1, timedOut: true });
    } finally {
      releaseContinuation?.();
      vi.useRealTimers();
    }
  });

  it('fails safely when chained background work exceeds the continuation cap', async () => {
    const key = fixture();
    const onFinalize = vi.fn(async () => {});
    const onContinue = vi.fn(async (_aggregate, { round }) => {
      registerScheduledChild({
        ...key,
        childId: `chain-${round}`,
        label: `chain ${round}`,
        kind: 'tool',
      });
    });

    registerScheduledMain({ ...key });
    registerScheduledChild({ ...key, childId: 'seed', label: 'seed', kind: 'tool' });
    completeScheduledMain({ ...key, onContinue, onFinalize });
    completeScheduledChild({ ...key, childId: 'seed', resultText: 'seed result' });

    for (let round = 1; round <= 4; round++) {
      await vi.waitFor(() => expect(onContinue).toHaveBeenCalledTimes(round));
      completeScheduledChild({
        ...key,
        childId: `chain-${round}`,
        resultText: `chain result ${round}`,
      });
    }
    await vi.waitFor(() => expect(onFinalize).toHaveBeenCalledOnce());

    expect(onContinue).toHaveBeenCalledTimes(4);
    expect(onFinalize.mock.calls[0][0]).toContain('continuation limit (4) reached');
    expect(onFinalize.mock.calls[0][1]).toMatchObject({ errorCount: 1, timedOut: false });
  });
});
