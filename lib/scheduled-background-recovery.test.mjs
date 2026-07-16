import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
}));

vi.mock('../chat.mjs', () => ({
  streamChat: mocks.streamChat,
}));

const {
  addTask,
  findTaskById,
  recoverInterruptedScheduledBackground,
} = await import('../scheduler.mjs');
const { appendTaskRun, loadTaskRuns } = await import('./task-runs.mjs');
const { USERS_DIR } = await import('./paths.mjs');

const createdUsers = new Set();

afterEach(() => {
  mocks.streamChat.mockClear();
  for (const userId of createdUsers) {
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
  createdUsers.clear();
});

describe('interrupted scheduled background recovery', () => {
  it('records one failed occurrence without replaying work and dedupes by runId', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const userId = `user_scheduled_recovery_${suffix}`;
    const runId = `scheduled_run_${suffix}`;
    createdUsers.add(userId);

    const task = await addTask({
      ownerId: userId,
      agent: 'recovery-agent',
      label: 'Recovery durability fixture',
      prompt: 'Perform an external action exactly once.',
      repeat: 'daily',
      time: '09:00',
      silent: true,
    });

    const first = await recoverInterruptedScheduledBackground({
      userId,
      originTaskId: task.id,
      originTaskOwnerId: userId,
      originScheduledRunId: runId,
      aggregate: '## producer\nThe producer completed before restart.',
    });

    expect(first).toEqual({ ok: true, recoveredAsFailure: true });
    const afterFirst = findTaskById(task.id, userId);
    expect(afterFirst).toMatchObject({
      lastFinalizedRunId: runId,
      consecutiveFailures: 1,
    });
    expect(afterFirst.lastError).toContain('The producer was not rerun');
    const firstLastRun = afterFirst.lastRun;

    const duplicate = await recoverInterruptedScheduledBackground({
      userId,
      originTaskId: task.id,
      originTaskOwnerId: userId,
      originScheduledRunId: runId,
      aggregate: 'a duplicate boot must not finalize this occurrence again',
    });

    expect(duplicate).toEqual({ ok: true, alreadyFinalized: true });
    expect(findTaskById(task.id, userId)).toMatchObject({
      lastFinalizedRunId: runId,
      lastRun: firstLastRun,
      consecutiveFailures: 1,
    });
    expect(mocks.streamChat).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(loadTaskRuns(userId, task.id)).toHaveLength(1);
    });
    expect(loadTaskRuns(userId, task.id)[0]).toMatchObject({
      taskId: task.id,
      runId,
      status: 'error',
    });
  });

  it('persists at most one task-run row for the same task and run id', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const userId = `user_task_run_dedupe_${suffix}`;
    const taskId = `task_${suffix}`;
    const runId = `run_${suffix}`;
    createdUsers.add(userId);

    await appendTaskRun(userId, {
      taskId,
      taskName: 'dedupe fixture',
      runId,
      status: 'error',
      error: 'first terminal record wins',
    });
    await appendTaskRun(userId, {
      taskId,
      taskName: 'dedupe fixture',
      runId,
      status: 'ok',
    });

    expect(loadTaskRuns(userId, taskId)).toEqual([
      expect.objectContaining({
        taskId,
        runId,
        status: 'error',
        error: 'first terminal record wins',
      }),
    ]);
  });
});
