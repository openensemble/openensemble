import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveTasks: vi.fn(),
  listWatchers: vi.fn(),
  getWatcher: vi.fn(),
}));

vi.mock('../../background-tasks.mjs', () => ({ getActiveTasks: mocks.getActiveTasks }));
vi.mock('../../scheduler/watchers.mjs', () => ({
  listWatchers: mocks.listWatchers,
  getWatcher: mocks.getWatcher,
}));

const { executeSkillTool } = await import('./execute.mjs');

describe('active-agents background ownership view', () => {
  beforeEach(() => {
    mocks.getActiveTasks.mockReset().mockReturnValue([]);
    mocks.listWatchers.mockReset().mockReturnValue({ active: [], recent: [] });
    mocks.getWatcher.mockReset();
  });

  it('includes a generic auto-background task_proxy that has no activeTasks row', async () => {
    mocks.listWatchers.mockReturnValue({
      active: [{
        id: 'watcher_autobg_1',
        kind: 'task_proxy',
        label: '⏵ slow_lookup',
        createdAt: Date.now() - 2_000,
        lastStatusText: 'slow_lookup is still running in the background',
        state: {
          taskId: 'autobg_internal_1',
          targetAgentName: 'slow_lookup',
          targetAgentEmoji: '⏵',
          tool: 'slow_lookup',
          startedAt: Date.now() - 2_000,
        },
      }],
      recent: [],
    });

    const result = await executeSkillTool('list_active_agents', {}, 'user_test');

    expect(result).toContain('1 background task in flight');
    expect(result).toContain('watcher_autobg_1');
    expect(result).toContain('running tool: slow_lookup');
  });

  it('does not list a task_proxy twice when activeTasks already owns its watcher', async () => {
    mocks.getActiveTasks.mockReturnValue([{
      userId: 'user_test', taskId: 'wkr_1', watcherId: 'watcher_1',
      agentName: 'Jarvis worker', startedAt: Date.now() - 1_000,
    }]);
    mocks.listWatchers.mockReturnValue({
      active: [{ id: 'watcher_1', kind: 'task_proxy', state: { targetAgentName: 'Jarvis worker' } }],
      recent: [],
    });

    const result = await executeSkillTool('list_active_agents', {}, 'user_test');

    expect(result).toContain('1 background task in flight');
    expect((result.match(/Jarvis worker/g) || [])).toHaveLength(1);
  });
});

