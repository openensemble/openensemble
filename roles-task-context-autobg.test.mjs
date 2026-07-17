import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const surfaceMocks = vi.hoisted(() => ({
  registerWatcher: vi.fn(),
  unregisterWatcher: vi.fn(),
  pushWatcherStatus: vi.fn(),
  completeWatcher: vi.fn(),
  registerTaskRoot: vi.fn(),
  deferRootCompletion: vi.fn(() => false),
  clearTaskRoot: vi.fn(),
  completeSyncDelegation: vi.fn(),
  registerAutoBackgroundTool: vi.fn(() => ({ taskId: 'registered' })),
  markAutoBackgroundToolTerminal: vi.fn(() => true),
  retireAutoBackgroundTool: vi.fn(() => true),
  appendToSession: vi.fn(async () => {}),
  sendToUser: vi.fn(),
  emitAgentNotification: vi.fn(),
  noteDeviceBackgroundWork: vi.fn(),
}));

vi.mock('./scheduler/watchers.mjs', () => ({
  registerWatcher: surfaceMocks.registerWatcher,
  unregisterWatcher: surfaceMocks.unregisterWatcher,
  pushWatcherStatus: surfaceMocks.pushWatcherStatus,
  completeWatcher: surfaceMocks.completeWatcher,
}));

vi.mock('./background-tasks.mjs', () => ({
  registerTaskRoot: surfaceMocks.registerTaskRoot,
  deferRootCompletion: surfaceMocks.deferRootCompletion,
  clearTaskRoot: surfaceMocks.clearTaskRoot,
  completeSyncDelegation: surfaceMocks.completeSyncDelegation,
  registerAutoBackgroundTool: surfaceMocks.registerAutoBackgroundTool,
  markAutoBackgroundToolTerminal: surfaceMocks.markAutoBackgroundToolTerminal,
  retireAutoBackgroundTool: surfaceMocks.retireAutoBackgroundTool,
  persistedReportImage: image => image,
}));

vi.mock('./sessions.mjs', () => ({
  appendToSession: surfaceMocks.appendToSession,
}));

vi.mock('./ws-handler.mjs', () => ({
  sendToUser: surfaceMocks.sendToUser,
  emitAgentNotification: surfaceMocks.emitAgentNotification,
  noteDeviceBackgroundWork: surfaceMocks.noteDeviceBackgroundWork,
}));

const {
  addRoleManifest,
  autoBackgroundToolsInCurrentContext,
  executeToolStreaming,
  removeRoleManifest,
  setAutoBackgroundDelayForTest,
} = await import('./roles.mjs');
const { currentTaskContext, runInTaskContext } = await import('./lib/task-proxy-context.mjs');
const { runWithTurnContext } = await import('./lib/turn-abort-context.mjs');
const { SKILLS_DIR, USERS_DIR } = await import('./lib/paths.mjs');

const SKILL_ID = 'task-context-autobg-probe';
const TOOL_NAMES = {
  stream: 'autobg_stream_probe',
  promise: 'autobg_promise_probe',
};
const SKILL_DIR = path.join(SKILLS_DIR, SKILL_ID);
const PROBE_USERS = new Set();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installProbeControls() {
  const controls = {
    stream: { started: deferred(), gate: deferred(), settled: deferred(), signal: null },
    promise: { started: deferred(), gate: deferred(), settled: deferred(), signal: null },
  };
  globalThis.__oeTaskContextAutoBgProbe = controls;
  return controls;
}

async function crossAutoBackgroundBoundary() {
  await new Promise(resolve => setTimeout(resolve, 30));
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function flushDetachedFinalization() {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
}

async function waitForSurface(assertion) {
  await vi.waitFor(assertion, { timeout: 1_000, interval: 5 });
}

async function waitForProbeStart(control) {
  await Promise.race([
    control.started.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('probe did not start')), 500)),
  ]);
}

async function collectTool(kind, userId) {
  if (!PROBE_USERS.has(userId)) {
    const userDir = path.join(USERS_DIR, userId);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, 'profile.json'), JSON.stringify({
      id: userId,
      name: 'Auto-background probe user',
      role: 'user',
      skills: [SKILL_ID],
      skillAssignments: {},
    }));
    PROBE_USERS.add(userId);
  }
  const name = TOOL_NAMES[kind];
  const events = [];
  for await (const event of executeToolStreaming(
    name,
    {},
    userId,
    'jarvis_lab',
    [name],
  )) events.push(event);
  return events;
}

function collectForeground(kind, userId, turnCtx = {}) {
  return runWithTurnContext(
    // Exercise the ordinary production 10-second boundary. Tests run under a
    // temporary BASE_DIR, so any best-effort learning writes stay isolated.
    { suppressLearning: false, ...turnCtx },
    () => collectTool(kind, userId),
  );
}

function collectInsideTask(kind, userId, turnCtx = {}) {
  return runInTaskContext({
    taskId: `task-${kind}`,
    watcherId: `worker-${kind}`,
    userId,
    agentId: 'jarvis_lab',
    rootTaskId: `worker-${kind}`,
    rootWatcherId: `worker-${kind}`,
  }, () => collectForeground(kind, userId, turnCtx));
}

describe('task-owned tools and the generic auto-background boundary', () => {
  beforeAll(() => {
    mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(path.join(SKILL_DIR, 'execute.mjs'), `
      export default function execute(name, _args, _userId, _agentId, ctx) {
        const controls = globalThis.__oeTaskContextAutoBgProbe;
        if (!controls) throw new Error('missing auto-background probe controls');

        const waitForGate = (kind) => {
          const control = controls[kind];
          control.signal = ctx?.signal ?? null;
          control.started.resolve();
          return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
              if (settled) return;
              settled = true;
              control.signal?.removeEventListener?.('abort', onAbort);
              fn(value);
            };
            const onAbort = () => {
              const reason = control.signal?.reason;
              finish(reject, reason instanceof Error ? reason : new Error(String(reason || kind + ' cancelled')));
            };
            control.signal?.addEventListener?.('abort', onAbort, { once: true });
            control.gate.promise.then(
              value => finish(resolve, value),
              error => finish(reject, error),
            );
            if (control.signal?.aborted) onAbort();
          });
        };

        if (name === 'autobg_stream_probe') {
          return (async function* () {
            try {
              if (controls.stream.delegationMeta) yield controls.stream.delegationMeta;
              await waitForGate('stream');
              yield { type: 'tool_progress', text: 'stream progress' };
              yield { type: 'result', text: 'stream complete' };
            } finally {
              controls.stream.settled.resolve();
            }
          })();
        }

        return waitForGate('promise')
          .then(() => 'promise complete')
          .finally(() => controls.promise.settled.resolve());
      }
    `);
    addRoleManifest({
      id: SKILL_ID,
      name: 'Task-context auto-background probe',
      category: 'utility',
      service: false,
      tools: Object.values(TOOL_NAMES).map(name => ({
        type: 'function',
        function: {
          name,
          description: 'Exercise auto-background ownership in tests.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      })),
    });
  });

  afterAll(() => {
    removeRoleManifest(SKILL_ID);
    rmSync(SKILL_DIR, { recursive: true, force: true });
    for (const userId of PROBE_USERS) {
      rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
    }
    PROBE_USERS.clear();
    delete globalThis.__oeTaskContextAutoBgProbe;
  });

  beforeEach(() => {
    setAutoBackgroundDelayForTest(15);
    let watcherSequence = 0;
    for (const mock of Object.values(surfaceMocks)) mock.mockClear();
    surfaceMocks.registerWatcher.mockImplementation(() => `autobg-watcher-${++watcherSequence}`);
    surfaceMocks.deferRootCompletion.mockReturnValue(false);
  });

  afterEach(() => {
    const controls = globalThis.__oeTaskContextAutoBgProbe;
    controls?.stream.gate.resolve();
    controls?.promise.gate.resolve();
    delete globalThis.__oeTaskContextAutoBgProbe;
    setAutoBackgroundDelayForTest(null);
  });

  it('uses task_proxy AsyncLocalStorage as the capability-agnostic ownership signal', async () => {
    expect(autoBackgroundToolsInCurrentContext()).toBe(true);

    await runInTaskContext({ taskId: 'worker', watcherId: 'watcher' }, async () => {
      expect(autoBackgroundToolsInCurrentContext()).toBe(false);
      await Promise.resolve();
      expect(autoBackgroundToolsInCurrentContext()).toBe(false);
    });

    expect(autoBackgroundToolsInCurrentContext()).toBe(true);

    await runWithTurnContext({ awaitSlowTools: true }, async () => {
      expect(autoBackgroundToolsInCurrentContext()).toBe(false);
      await Promise.resolve();
      expect(autoBackgroundToolsInCurrentContext()).toBe(false);
    });

    expect(autoBackgroundToolsInCurrentContext()).toBe(true);
  });

  it.each(['stream', 'promise'])('preserves foreground auto-backgrounding for a slow %s tool', async kind => {
    const controls = installProbeControls();
    const detachedTaskContexts = [];
    surfaceMocks.markAutoBackgroundToolTerminal.mockImplementation(() => {
      detachedTaskContexts.push(currentTaskContext());
      return true;
    });
    surfaceMocks.pushWatcherStatus.mockImplementation(() => {
      detachedTaskContexts.push(currentTaskContext());
    });
    const execution = collectForeground(kind, `foreground-${kind}-user`);
    let executionSettled = false;
    execution.finally(() => { executionSettled = true; });

    await waitForProbeStart(controls[kind]);
    await crossAutoBackgroundBoundary();
    expect(surfaceMocks.registerWatcher).toHaveBeenCalledOnce();
    expect(executionSettled).toBe(true);
    const events = await execution;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'result', text: expect.stringMatching(/running in the background/i) }),
      expect.objectContaining({ type: '__hide_turn', reason: 'bg_chip', taskId: 'autobg-watcher-1' }),
    ]));
    expect(surfaceMocks.registerWatcher).toHaveBeenCalledOnce();
    expect(surfaceMocks.registerAutoBackgroundTool).toHaveBeenCalledWith(expect.objectContaining({
      userId: `foreground-${kind}-user`,
      toolName: TOOL_NAMES[kind],
      watcherId: 'autobg-watcher-1',
      taskId: expect.stringMatching(/^autobg_/),
      abort: expect.any(Function),
    }));
    const registration = surfaceMocks.registerAutoBackgroundTool.mock.calls[0][0];

    // Let the detached owner consume the exact pending value and finish so
    // this regression test cannot conceal a stranded drain.
    controls[kind].gate.resolve();
    await controls[kind].settled.promise;
    await flushDetachedFinalization();
    await waitForSurface(() => {
      expect(surfaceMocks.retireAutoBackgroundTool).toHaveBeenCalledWith(registration.taskId);
    });
    expect(surfaceMocks.completeWatcher).toHaveBeenCalledWith(
      expect.any(String),
      'autobg-watcher-1',
      expect.objectContaining({ status: 'done' }),
    );
    expect(surfaceMocks.markAutoBackgroundToolTerminal).toHaveBeenCalledWith(
      expect.stringMatching(/^autobg_/),
      expect.objectContaining({ status: 'done' }),
    );
    expect(surfaceMocks.retireAutoBackgroundTool).toHaveBeenCalledWith(
      expect.stringMatching(/^autobg_/),
    );
    expect(detachedTaskContexts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: registration.taskId,
        watcherId: 'autobg-watcher-1',
      }),
    ]));

    const terminalOrder = surfaceMocks.markAutoBackgroundToolTerminal.mock.invocationCallOrder[0];
    expect(terminalOrder).toBeLessThan(surfaceMocks.completeWatcher.mock.invocationCallOrder[0]);
    expect(terminalOrder).toBeLessThan(surfaceMocks.appendToSession.mock.invocationCallOrder[0]);
    expect(terminalOrder).toBeLessThan(surfaceMocks.sendToUser.mock.invocationCallOrder[0]);
  });

  it.each(['stream', 'promise'])('keeps a slow %s tool owned by its existing task until the real result', async kind => {
    const controls = installProbeControls();
    const execution = collectInsideTask(kind, `worker-${kind}-user`);
    let settled = false;
    execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await controls[kind].started.promise;
    await crossAutoBackgroundBoundary();

    expect(settled).toBe(false);
    expect(surfaceMocks.registerWatcher).not.toHaveBeenCalled();
    expect(surfaceMocks.registerAutoBackgroundTool).not.toHaveBeenCalled();

    controls[kind].gate.resolve();
    const events = await execution;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'result', text: `${kind} complete` }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: '__hide_turn' }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringMatching(/running in the background/i) }),
    ]));
    expect(surfaceMocks.completeWatcher).not.toHaveBeenCalled();
  });

  it.each(['stream', 'promise'])('keeps a slow owned %s rejection inline and never reports false completion', async kind => {
    const controls = installProbeControls();
    const execution = collectInsideTask(kind, `worker-${kind}-error-user`);
    let settled = false;
    execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await controls[kind].started.promise;
    await crossAutoBackgroundBoundary();
    expect(settled).toBe(false);
    expect(surfaceMocks.registerWatcher).not.toHaveBeenCalled();

    controls[kind].gate.reject(new Error(`${kind} owned failure`));
    const events = await execution;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result',
        text: expect.stringContaining(`${kind} owned failure`),
      }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: '__hide_turn' }),
    ]));
    expect(surfaceMocks.registerWatcher).not.toHaveBeenCalled();
    expect(surfaceMocks.completeWatcher).not.toHaveBeenCalled();
  });

  it.each(['stream', 'promise'])('propagates an owned cancellation into a running %s tool', async kind => {
    const controls = installProbeControls();
    const owner = new AbortController();
    const execution = collectInsideTask(
      kind,
      `worker-${kind}-cancel-user`,
      { signal: owner.signal },
    );

    await controls[kind].started.promise;
    expect(controls[kind].signal).toBeInstanceOf(AbortSignal);
    expect(controls[kind].signal).not.toBe(owner.signal);
    expect(controls[kind].signal.aborted).toBe(false);

    owner.abort(`${kind} worker stopped`);
    await controls[kind].settled.promise;
    await expect(execution).rejects.toThrow(`${kind} worker stopped`);

    expect(controls[kind].signal.aborted).toBe(true);
    expect(surfaceMocks.registerWatcher).not.toHaveBeenCalled();
    expect(surfaceMocks.registerAutoBackgroundTool).not.toHaveBeenCalled();
    expect(surfaceMocks.completeWatcher).not.toHaveBeenCalled();
  });

  it.each(['stream', 'promise'])('finalizes a foreground detached %s rejection as an error', async kind => {
    const controls = installProbeControls();
    const execution = collectForeground(kind, `foreground-${kind}-error-user`);

    await controls[kind].started.promise;
    await crossAutoBackgroundBoundary();
    const events = await execution;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: '__hide_turn', taskId: 'autobg-watcher-1' }),
    ]));

    controls[kind].gate.reject(new Error(`${kind} detached failure`));
    const registration = surfaceMocks.registerAutoBackgroundTool.mock.calls[0][0];
    await controls[kind].settled.promise;
    await flushDetachedFinalization();
    await waitForSurface(() => {
      expect(surfaceMocks.retireAutoBackgroundTool).toHaveBeenCalledWith(registration.taskId);
    });
    expect(surfaceMocks.completeWatcher).toHaveBeenCalledWith(
      expect.any(String),
      'autobg-watcher-1',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it.each(['stream', 'promise'])('lets the detached execution owner cancel a slow %s tool', async kind => {
    const controls = installProbeControls();
    const userId = `foreground-${kind}-detached-cancel-user`;
    const execution = collectForeground(kind, userId);

    await controls[kind].started.promise;
    await crossAutoBackgroundBoundary();
    const events = await execution;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: '__hide_turn', taskId: 'autobg-watcher-1' }),
    ]));

    const registration = surfaceMocks.registerAutoBackgroundTool.mock.calls[0][0];
    expect(registration.abort).toBeTypeOf('function');
    registration.abort(`${kind} stopped from task chip`);

    await controls[kind].settled.promise;
    await flushDetachedFinalization();
    await waitForSurface(() => {
      expect(surfaceMocks.retireAutoBackgroundTool).toHaveBeenCalledWith(registration.taskId);
    });
    expect(surfaceMocks.markAutoBackgroundToolTerminal).toHaveBeenCalledWith(
      registration.taskId,
      expect.objectContaining({ status: 'cancelled' }),
    );
    expect(surfaceMocks.completeWatcher).toHaveBeenCalledWith(
      userId,
      'autobg-watcher-1',
      expect.objectContaining({ status: 'cancelled' }),
    );
    expect(surfaceMocks.retireAutoBackgroundTool).toHaveBeenCalledWith(registration.taskId);
  });

  it('keeps a slow promise foreground-owned when watcher admission fails', async () => {
    const controls = installProbeControls();
    surfaceMocks.registerWatcher.mockImplementationOnce(() => {
      throw new Error('watcher store unavailable');
    });
    const execution = collectForeground('promise', 'foreground-promise-register-failure');
    let settled = false;
    execution.finally(() => { settled = true; });

    await controls.promise.started.promise;
    await crossAutoBackgroundBoundary();
    expect(surfaceMocks.registerWatcher).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    controls.promise.gate.resolve();
    const events = await execution;
    expect(events).toEqual([
      expect.objectContaining({ type: 'result', text: 'promise complete' }),
    ]);
    expect(events.some(event => event.type === '__hide_turn')).toBe(false);
    expect(surfaceMocks.completeWatcher).not.toHaveBeenCalled();
  });

  it.each(['stream', 'promise'])('rolls back a %s watcher when execution-owner admission fails', async kind => {
    const controls = installProbeControls();
    surfaceMocks.registerAutoBackgroundTool.mockReturnValueOnce(null);
    const execution = collectForeground(kind, `foreground-${kind}-owner-failure`);
    let settled = false;
    execution.finally(() => { settled = true; });

    await controls[kind].started.promise;
    await crossAutoBackgroundBoundary();
    expect(surfaceMocks.registerWatcher).toHaveBeenCalledOnce();
    expect(surfaceMocks.unregisterWatcher).toHaveBeenCalledWith(
      `foreground-${kind}-owner-failure`,
      'autobg-watcher-1',
      'handoff_failed',
    );
    expect(settled).toBe(false);

    controls[kind].gate.resolve();
    const events = await execution;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'result', text: `${kind} complete` }),
    ]));
    expect(events.some(event => event.type === '__hide_turn')).toBe(false);
    expect(surfaceMocks.markAutoBackgroundToolTerminal).not.toHaveBeenCalled();
    expect(surfaceMocks.retireAutoBackgroundTool).not.toHaveBeenCalled();
  });

  it('adopts a sync-delegation chip without registering a second execution owner', async () => {
    const controls = installProbeControls();
    controls.stream.delegationMeta = {
      type: 'tool_progress',
      text: 'Specialist started',
      delegated: true,
      agentName: 'Specialist',
      chipWatcherId: 'sync-delegation-watcher',
      chipTaskId: 'deleg_sync_owned',
    };
    const execution = collectForeground('stream', 'foreground-adopted-delegation');

    await controls.stream.started.promise;
    await crossAutoBackgroundBoundary();
    const events = await execution;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: '__hide_turn', reason: 'bg_chip', taskId: 'sync-delegation-watcher',
      }),
    ]));
    expect(surfaceMocks.registerWatcher).not.toHaveBeenCalled();
    expect(surfaceMocks.registerAutoBackgroundTool).not.toHaveBeenCalled();

    controls.stream.gate.resolve();
    await controls.stream.settled.promise;
    await flushDetachedFinalization();
    await waitForSurface(() => expect(surfaceMocks.appendToSession).toHaveBeenCalled());
    expect(surfaceMocks.appendToSession).toHaveBeenCalled();
    expect(surfaceMocks.markAutoBackgroundToolTerminal).not.toHaveBeenCalled();
    expect(surfaceMocks.retireAutoBackgroundTool).not.toHaveBeenCalled();
  });
});
