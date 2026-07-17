import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { backgroundRunTraceOptions, resolveBackgroundRootTaskId, scheduledFailureEmailScope } from '../background-tasks.mjs';
import { sendEmailIdempotently } from './email-idempotency.mjs';
import { USERS_DIR } from './paths.mjs';
import { beginTurn, turnTraceContext } from './turn-trace-context.mjs';
import { resolveDispatchTurnCorrelation } from './turn-correlation.mjs';

const USER = `user_background_correlation_${Date.now()}_${Math.random().toString(36).slice(2)}`;

afterAll(() => {
  fs.rmSync(path.join(USERS_DIR, USER), { recursive: true, force: true });
});

describe('background email authorization correlation', () => {
  it('separates a fresh hidden-continuation wire turn from its original authorization', () => {
    const trace = resolveDispatchTurnCorrelation({
      rootTaskId: 'bg-root',
      sideEffectMessageId: 'original-message',
      sideEffectAttemptId: 'original-attempt',
    });
    expect(trace).toEqual({
      rootId: 'bg-root',
      turnId: null,
      messageId: 'original-message',
      attemptId: 'original-attempt',
    });
  });

  it('inherits the scheduled run root instead of minting a random worker root', () => {
    expect(resolveBackgroundRootTaskId(
      'bg_random',
      {},
      { runId: 'scheduled:task-7:2026-07-13T12:00:00.000Z' },
    )).toBe('scheduled:task-7:2026-07-13T12:00:00.000Z');
    expect(resolveBackgroundRootTaskId(
      'bg_random',
      { rootTaskId: 'parent-worker-root' },
      null,
    )).toBe('parent-worker-root');
    expect(resolveBackgroundRootTaskId(
      'bg_random',
      { rootTaskId: 'random-autobg-watcher-root' },
      { runId: 'scheduled:task-7:2026-07-13T12:00:00.000Z' },
    )).toBe('scheduled:task-7:2026-07-13T12:00:00.000Z');
  });

  it('binds a scheduled failure notice to the logical task and UTC day', () => {
    expect(scheduledFailureEmailScope(null, 'scheduled-task', 'bg-random-a', '2026-07-13'))
      .toBe('scheduled-failure:scheduled-task:2026-07-13');
    expect(scheduledFailureEmailScope(null, 'scheduled-task', 'bg-random-b', '2026-07-13'))
      .toBe('scheduled-failure:scheduled-task:2026-07-13');
    expect(scheduledFailureEmailScope(null, 'scheduled-task', 'bg-random-c', '2026-07-14'))
      .not.toBe('scheduled-failure:scheduled-task:2026-07-13');
  });

  it('keeps one scheduled-failure scope for the same occurrence across midnight', () => {
    const runId = 'scheduled:daily-briefing:2026-07-13T23:59:59.000Z';
    expect(scheduledFailureEmailScope(runId, 'daily-briefing', 'bg-before', '2026-07-13'))
      .toBe(`scheduled-failure-run:${runId}`);
    expect(scheduledFailureEmailScope(runId, 'daily-briefing', 'bg-after', '2026-07-14'))
      .toBe(`scheduled-failure-run:${runId}`);
  });

  it('passes browser message, attempt, and session identity into the detached turn', () => {
    expect(backgroundRunTraceOptions({
      taskId: 'bg_1',
      rootTaskId: 'bg_1',
      sourceMessageId: 'msg_stable',
      sourceAttemptId: 'attempt_a',
      sourceSessionKey: 'user_x_jarvis',
      sourceSessionEpoch: 'epoch_a',
    })).toEqual({
      rootTaskId: 'bg_1',
      traceSource: 'background',
      messageId: 'msg_stable',
      attemptId: 'attempt_a',
      sessionKey: 'user_x_jarvis',
      sessionEpoch: 'epoch_a',
    });
  });

  it('suppresses a changed email payload from a Browser Retry background attempt', async () => {
    let sends = 0;
    const runDetached = async (attemptId, payload) => {
      const trace = backgroundRunTraceOptions({
        taskId: `bg_${attemptId}`,
        rootTaskId: `bg_${attemptId}`,
        sourceMessageId: 'msg_browser_retry',
        sourceAttemptId: attemptId,
        sourceSessionKey: `${USER}_jarvis`,
        sourceSessionEpoch: 'epoch-a',
      });
      return turnTraceContext.run(undefined, async () => {
        beginTurn({
          userId: USER,
          agentId: 'email-agent',
          source: trace.traceSource,
          rootId: trace.rootTaskId,
          forceRoot: true,
          messageId: trace.messageId,
          attemptId: trace.attemptId,
          sessionKey: trace.sessionKey,
          sessionEpoch: trace.sessionEpoch,
        });
        return sendEmailIdempotently({
          userId: USER,
          payload,
          send: async markDispatchStarted => {
            markDispatchStarted();
            sends++;
            return `Email sent. RFC Message-ID: <background-${sends}@lab.local>.`;
          },
        });
      });
    };

    const first = await runDetached('attempt-a', {
      provider: 'imap', accountId: 'lab', to: 'alex@example.com',
      subject: 'Original', body: 'Original body',
    });
    const retried = await runDetached('attempt-b', {
      provider: 'imap', accountId: 'lab', to: 'alex@example.com',
      subject: 'Changed by retry', body: 'Changed body',
    });

    expect(first).toContain('Email sent');
    expect(retried).toMatch(/retry of a request that already dispatched email/i);
    expect(sends).toBe(1);
  });

  it('uses one scheduled worker root across a replay of the same occurrence', () => {
    const scheduled = { runId: 'scheduled:task-9:2026-07-13T12:00:00.000Z' };
    const firstRoot = resolveBackgroundRootTaskId('wkr_random_a', {}, scheduled);
    const replayRoot = resolveBackgroundRootTaskId('wkr_random_b', {}, scheduled);
    expect(firstRoot).toBe(scheduled.runId);
    expect(replayRoot).toBe(scheduled.runId);
  });

  it('suppresses a changed email payload from a replayed scheduled worker', async () => {
    const rootId = 'scheduled:task-10:2026-07-13T12:00:00.000Z';
    let sends = 0;
    const runWorker = async (attemptId, subject) => turnTraceContext.run(undefined, async () => {
      beginTurn({
        userId: USER,
        agentId: 'scheduled-worker',
        source: 'scheduled',
        rootId,
        forceRoot: true,
        attemptId,
      });
      return sendEmailIdempotently({
        userId: USER,
        payload: {
          provider: 'imap', accountId: 'lab', to: 'alex@example.com',
          subject, body: `${subject} body`,
        },
        send: async markDispatchStarted => {
          markDispatchStarted();
          sends++;
          return `Email sent. RFC Message-ID: <scheduled-worker-${sends}@lab.local>.`;
        },
      });
    });

    expect(await runWorker('attempt-a', 'Original scheduled email')).toContain('Email sent');
    expect(await runWorker('attempt-b', 'Changed scheduled retry'))
      .toMatch(/retry of a request that already dispatched email/i);
    expect(sends).toBe(1);
  });
});
