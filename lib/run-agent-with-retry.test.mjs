import { describe, expect, it, vi } from 'vitest';

import { runAgentWithRetry } from './run-agent-with-retry.mjs';

function agent() {
  return { id: 'user_test_jarvis', tools: [] };
}

describe('runAgentWithRetry detached correlation', () => {
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
    const streamChat = vi.fn(async function* (...args) {
      turnOpts = args[9];
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
  });
});
