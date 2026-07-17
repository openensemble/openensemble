import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
  registerWatcher: vi.fn(() => 'sync-delegation-watcher'),
  pushWatcherStatus: vi.fn(),
  completeWatcher: vi.fn(),
  registerSyncDelegation: vi.fn(),
  complete: vi.fn(),
  noteToolCall: vi.fn(),
  noteToolResult: vi.fn(),
  setStageName: vi.fn(),
  slotRelease: vi.fn(),
}));

vi.mock('../../chat.mjs', () => ({ streamChat: mocks.streamChat }));
vi.mock('../../routes/_helpers.mjs', () => ({
  getAgentsForUser: () => [
    { id: 'jarvis', name: 'Jarvis', emoji: 'J', skillCategory: 'coordinator', systemPrompt: 'Coordinate.' },
    { id: 'research', name: 'Researcher', emoji: 'R', skillCategory: 'research', systemPrompt: 'Research.' },
  ],
}));
vi.mock('../../chat-dispatch.mjs', () => ({
  isAgentBusy: () => false,
  waitForAgentIdle: vi.fn(async () => {}),
  markAgentBusy: () => ({ release: mocks.slotRelease }),
}));
vi.mock('../../scheduler/watchers.mjs', () => ({
  registerWatcher: mocks.registerWatcher,
  pushWatcherStatus: mocks.pushWatcherStatus,
  completeWatcher: mocks.completeWatcher,
}));
vi.mock('../../background-tasks.mjs', () => ({
  registerSyncDelegation: mocks.registerSyncDelegation,
}));
vi.mock('../../lib/context-resolvers.mjs', () => ({
  buildContextHints: vi.fn(async () => ({ hints: '' })),
}));
vi.mock('../../lib/tool-plan-memory.mjs', () => ({
  matchToolPlan: vi.fn(() => null),
}));
vi.mock('../../lib/ephemeral-tool-cache.mjs', () => ({
  initSession: vi.fn(),
}));
vi.mock('../../lib/orchestration-policy.mjs', () => ({
  getOrchestrationPolicy: () => ({ mode: 'ensemble', primaryAgentId: null }),
}));

const { executeSkillTool } = await import('./execute.mjs');
const { currentTaskContext, runInTaskContext } = await import('../../lib/task-proxy-context.mjs');
const { getTurnContext, runWithTurnContext } = await import('../../lib/turn-abort-context.mjs');

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('synchronous delegation task ownership', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.registerWatcher.mockReturnValue('sync-delegation-watcher');
    mocks.registerSyncDelegation.mockReturnValue({
      complete: mocks.complete,
      noteToolCall: mocks.noteToolCall,
      noteToolResult: mocks.noteToolResult,
      setStageName: mocks.setStageName,
      isCancelling: () => false,
    });
    mocks.slotRelease.mockImplementation(() => {});
  });

  it('binds the child model stream to its delegation while the outer call remains foreground-owned', async () => {
    const seen = [];
    mocks.streamChat.mockImplementation(async function* () {
      seen.push(currentTaskContext());
      await Promise.resolve();
      seen.push(currentTaskContext());
      yield { type: 'token', text: 'real delegated result' };
      yield { type: 'done' };
    });

    expect(currentTaskContext()).toBeNull();
    const events = await collect(executeSkillTool('ask_agent', {
      agent_id: 'research',
      task: 'Research this and return the real result while I wait here.',
      background: false,
    }, 'user_test', 'user_test_jarvis'));

    expect(seen).toHaveLength(2);
    expect(seen.every(ctx => ctx?.taskId?.startsWith('deleg_'))).toBe(true);
    expect(seen.every(ctx => ctx?.watcherId === 'sync-delegation-watcher')).toBe(true);
    expect(seen.every(ctx => ctx?.rootTaskId === ctx?.taskId)).toBe(true);
    expect(currentTaskContext()).toBeNull();
    expect(events[0]).toMatchObject({
      type: 'tool_progress',
      delegated: true,
      chipWatcherId: 'sync-delegation-watcher',
      chipTaskId: expect.stringMatching(/^deleg_/),
      targetAgentId: expect.stringContaining('research'),
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'result', text: 'real delegated result' }),
    ]));
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'done' }));
    expect(mocks.slotRelease).toHaveBeenCalledOnce();
  });

  it('forces explicit background delegation to await inside a non-scheduled owner', async () => {
    const parentAbort = new AbortController();
    const seen = [];
    mocks.streamChat.mockImplementation(async function* (...args) {
      seen.push({ task: currentTaskContext(), signal: getTurnContext()?.signal, argumentSignal: args[2] });
      yield { type: '__content', content: 'owned delegated completion' };
      yield { type: 'done' };
    });
    const events = await runWithTurnContext({ signal: parentAbort.signal }, () => runInTaskContext({
      taskId: 'proposal:owned_1',
      rootTaskId: 'root_owned_1',
      watcherId: 'parent-watcher',
      rootWatcherId: 'root-watcher',
      visibleAgentId: 'visible-owner',
      userId: 'user_test',
      agentId: 'jarvis',
    }, () => collect(executeSkillTool('ask_agent', {
      agent_id: 'research',
      task: 'Research this in the background.',
      background: true,
      _parallel: true,
    }, 'user_test', 'user_test_jarvis'))));

    expect(seen).toHaveLength(1);
    expect(seen[0].task).toMatchObject({
      taskId: expect.stringMatching(/^deleg_/),
      rootTaskId: 'root_owned_1',
      parentTaskId: 'proposal:owned_1',
      parentWatcherId: 'parent-watcher',
      rootWatcherId: 'root-watcher',
      visibleAgentId: 'visible-owner',
    });
    expect(seen[0].signal).toBe(seen[0].argumentSignal);
    expect(seen[0].signal).not.toBe(parentAbort.signal);
    expect(mocks.registerSyncDelegation).toHaveBeenCalledWith(expect.objectContaining({
      rootTaskId: 'root_owned_1',
      parentTaskId: 'proposal:owned_1',
      parentWatcherId: 'parent-watcher',
      rootWatcherId: 'root-watcher',
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'result', text: 'owned delegated completion' }),
    ]));
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it('propagates parent cancellation and finalizes the owner exactly once', async () => {
    const parentAbort = new AbortController();
    let streamStarted;
    const started = new Promise(resolve => { streamStarted = resolve; });
    mocks.streamChat.mockImplementation(async function* (...args) {
      streamStarted(args[2]);
      await new Promise(() => {});
      yield { type: 'done' };
    });

    const resultPromise = runWithTurnContext({ signal: parentAbort.signal }, () => collect(executeSkillTool('ask_agent', {
      agent_id: 'research',
      task: 'Keep researching until stopped while I wait here.',
      background: false,
    }, 'user_test', 'user_test_jarvis')));
    const childSignal = await started;
    expect(childSignal).not.toBe(parentAbort.signal);
    expect(childSignal.aborted).toBe(false);

    parentAbort.abort('user stopped the turn');
    const events = await resultPromise;

    expect(childSignal.aborted).toBe(true);
    expect(childSignal.reason).toBe('user stopped the turn');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'result', text: expect.stringContaining('cancelled') }),
    ]));
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'stopped' }));
    expect(mocks.slotRelease).toHaveBeenCalledOnce();
  });

  it('retires the owner when the caller closes on the early chip frame', async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'token', text: 'must not start' };
    });
    const iterator = executeSkillTool('ask_agent', {
      agent_id: 'research',
      task: 'Research this and return the result while I wait here.',
      background: false,
    }, 'user_test', 'user_test_jarvis');

    const first = await iterator.next();
    expect(first).toMatchObject({
      done: false,
      value: { type: 'tool_progress', chipTaskId: expect.stringMatching(/^deleg_/) },
    });
    await iterator.return();

    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'stopped' }));
  });

  it('refuses a detached worker inside a non-scheduled completion owner', async () => {
    const events = await runInTaskContext({
      taskId: 'mcp_turn_owned', rootTaskId: 'mcp_turn_owned', userId: 'user_test', agentId: 'jarvis',
    }, () => collect(executeSkillTool('spawn_worker', {
      task: 'Detach this again.',
      label: 'nested worker',
    }, 'user_test', 'user_test_jarvis')));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'result',
        text: expect.stringContaining('already has a completion owner'),
      }),
    ]);
  });
});
