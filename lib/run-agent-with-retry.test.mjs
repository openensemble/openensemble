import { describe, expect, it, vi } from 'vitest';

import { runAgentWithRetry } from './run-agent-with-retry.mjs';
import { currentTaskContext } from './task-proxy-context.mjs';
import { getScheduledContext } from './scheduled-context.mjs';

function agent() {
  return { id: 'user_test_jarvis', tools: [] };
}

describe('runAgentWithRetry detached correlation', () => {
  it('fails a non-cooperative silent stream at the inactivity deadline', async () => {
    vi.useFakeTimers();
    try {
      const streamChat = vi.fn(async function* () {
        await new Promise(() => {});
      });
      const execution = runAgentWithRetry({
        scopedAgent: agent(),
        userText: 'hang forever',
        systemNote: '[WATCHER FIRED]',
        userId: 'user_test',
        streamChat,
        maxAttempts: 1,
      });
      await vi.advanceTimersByTimeAsync(300_001);
      await expect(execution).resolves.toMatchObject({
        succeeded: false,
        lastError: expect.stringContaining('made no progress for 300s'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes one explicit durable root through every provider retry', async () => {
    const seen = [];
    let calls = 0;
    const streamChat = vi.fn(async function* (...args) {
      seen.push(args[9]);
      calls += 1;
      if (calls === 1) yield { type: 'error', message: 'temporary upstream failure' };
      else yield { type: '__content', content: 'done' };
    });

    const result = await runAgentWithRetry({
      scopedAgent: agent(),
      userText: 'send the report',
      systemNote: '[SCHEDULED RUN]',
      userId: 'user_test',
      streamChat,
      maxAttempts: 2,
      retryDelayMs: 0,
      rootTaskId: 'scheduled:task_1:2026-07-13T12:00:00.000Z',
      traceSource: 'scheduled',
    });

    expect(result.succeeded).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen.every(opts => opts.rootTaskId === 'scheduled:task_1:2026-07-13T12:00:00.000Z')).toBe(true);
    expect(seen.every(opts => opts.traceSource === 'scheduled')).toBe(true);
  });

  it('falls back to the caller-provided scheduled run id', async () => {
    let turnOpts;
    let seenTaskContext;
    let seenScheduledContext;
    const streamChat = vi.fn(async function* (...args) {
      turnOpts = args[9];
      seenTaskContext = currentTaskContext();
      seenScheduledContext = getScheduledContext();
      yield { type: '__content', content: 'done' };
    });

    await runAgentWithRetry({
      scopedAgent: agent(),
      userText: 'run',
      systemNote: '[SCHEDULED RUN]',
      userId: 'user_test',
      streamChat,
      originTaskId: 'task_1',
      originTaskRunId: 'scheduled:task_1:occurrence_1',
    });

    expect(turnOpts.rootTaskId).toBe('scheduled:task_1:occurrence_1');
    expect(turnOpts.traceSource).toBe('scheduled');
    // Scheduled mains intentionally retain generic auto-bg. Their dedicated
    // child/reaction barrier, not task_proxy ALS, owns delayed completion.
    expect(seenTaskContext).toBeNull();
    expect(seenScheduledContext).toMatchObject({
      originTaskId: 'task_1',
      runId: 'scheduled:task_1:occurrence_1',
    });
  });

  it('binds an unattended durable owner across awaits and provider retries', async () => {
    const seen = [];
    let calls = 0;
    const streamChat = vi.fn(async function* () {
      seen.push(currentTaskContext());
      await Promise.resolve();
      seen.push(currentTaskContext());
      calls += 1;
      if (calls === 1) throw new Error('retry this owned run');
      yield { type: '__content', content: 'owned completion' };
    });
    const taskContext = {
      taskId: 'proposal:proposal_1',
      watcherId: null,
      rootTaskId: 'proposal:proposal_1',
      rootWatcherId: null,
      visibleAgentId: 'user_test_jarvis',
      spanId: 'proposal:proposal_1:agent',
    };

    const result = await runAgentWithRetry({
      scopedAgent: agent(),
      userText: 'apply accepted proposal',
      systemNote: '[PROPOSAL ACCEPTED]',
      userId: 'user_test',
      streamChat,
      maxAttempts: 2,
      retryDelayMs: 0,
      rootTaskId: taskContext.rootTaskId,
      traceSource: 'proposal',
      taskContext,
    });

    expect(result).toMatchObject({ succeeded: true, assistantContent: 'owned completion' });
    expect(seen).toHaveLength(4);
    expect(seen.every(ctx => ctx?.taskId === 'proposal:proposal_1')).toBe(true);
    expect(seen.every(ctx => ctx?.userId === 'user_test')).toBe(true);
    expect(seen.every(ctx => ctx?.agentId === 'user_test_jarvis')).toBe(true);
    expect(currentTaskContext()).toBeNull();
  });
});
