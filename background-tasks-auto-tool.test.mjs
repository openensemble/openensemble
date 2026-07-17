import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const surfaces = vi.hoisted(() => ({
  pushWatcherStatus: vi.fn(),
}));

vi.mock('./scheduler/watchers.mjs', () => ({
  registerWatcher: vi.fn(),
  pushWatcherStatus: surfaces.pushWatcherStatus,
  completeWatcher: vi.fn(),
}));

vi.mock('./lib/task-outcomes.mjs', () => ({
  appendTaskOutcome: vi.fn(async () => true),
  loadTaskOutcomes: vi.fn(() => []),
}));

vi.mock('./lib/tool-plan-memory.mjs', () => ({
  learnToolPlanFromToolEvents: vi.fn(),
  matchToolPlan: vi.fn(() => null),
}));

vi.mock('./lib/scheduled-child-barrier.mjs', () => ({
  registerScheduledChild: vi.fn(),
  completeScheduledChild: vi.fn(),
}));

const { BASE_DIR } = await import('./lib/paths.mjs');
const {
  cancelTask,
  getActiveTasks,
  markAutoBackgroundToolTerminal,
  registerAutoBackgroundTool,
  retireAutoBackgroundTool,
} = await import('./background-tasks.mjs');

const JOURNAL_PATH = path.join(BASE_DIR, 'background-task-journal.json');
const createdTaskIds = new Set();

function journalEntries() {
  const parsed = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
  return parsed.entries ?? parsed;
}

afterEach(() => {
  for (const taskId of createdTaskIds) retireAutoBackgroundTool(taskId);
  createdTaskIds.clear();
  surfaces.pushWatcherStatus.mockClear();
});

describe('generic slow-tool execution owner', () => {
  it('is active, cancellable, and restart-journaled through terminal settlement', () => {
    const taskId = `autobg_owner_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const watcherId = `watcher_${taskId}`;
    const abort = vi.fn();
    createdTaskIds.add(taskId);

    expect(registerAutoBackgroundTool({
      taskId,
      userId: 'generic-owner-user',
      agentId: 'primary',
      toolName: 'slow_probe',
      watcherId,
      startedAt: 1234,
      abort,
    })).toEqual({ taskId, watcherId });

    expect(getActiveTasks()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId,
        watcherId,
        status: 'running',
        phase: 'backgrounded',
        currentTool: 'slow_probe',
        isAutoBgTool: true,
      }),
    ]));
    expect(journalEntries()[taskId]).toEqual(expect.objectContaining({
      userId: 'generic-owner-user',
      watcherId,
      startedAt: 1234,
    }));

    expect(cancelTask('generic-owner-user', watcherId, 'stopped from task chip'))
      .toEqual(expect.objectContaining({ ok: true, taskId, watcherId }));
    expect(abort).toHaveBeenCalledWith('stopped from task chip');
    expect(getActiveTasks().find(task => task.taskId === taskId))
      .toEqual(expect.objectContaining({ status: 'cancelling', phase: 'cancelling' }));

    expect(markAutoBackgroundToolTerminal(taskId, {
      status: 'cancelled',
      error: 'stopped from task chip',
    })).toBe(true);
    expect(journalEntries()[taskId].completion).toEqual(expect.objectContaining({
      status: 'cancelled',
      error: 'stopped from task chip',
    }));
    expect(getActiveTasks().find(task => task.taskId === taskId))
      .toEqual(expect.objectContaining({
        status: 'cancelled',
        phase: 'finalizing',
        currentTool: null,
      }));

    expect(retireAutoBackgroundTool(taskId)).toBe(true);
    createdTaskIds.delete(taskId);
    expect(getActiveTasks().some(task => task.taskId === taskId)).toBe(false);
    expect(journalEntries()[taskId]).toBeUndefined();
  });
});
