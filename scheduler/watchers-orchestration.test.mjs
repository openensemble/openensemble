import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { USERS_DIR } from '../lib/paths.mjs';

const mocks = vi.hoisted(() => ({
  runAgentWithRetry: vi.fn(),
  streamChat: vi.fn(),
  showImage: vi.fn(),
}));

vi.mock('../chat.mjs', () => ({ streamChat: mocks.streamChat }));
vi.mock('../lib/run-agent-with-retry.mjs', () => ({
  runAgentWithRetry: mocks.runAgentWithRetry,
}));

const { getUser, saveUser } = await import('../routes/_helpers.mjs');
const { createCustomAgent } = await import('../agents.mjs');
const { setOrchestrationPolicy } = await import('../lib/orchestration-policy.mjs');
const {
  finishUserTopologyTransition,
  tryAcquireUserTopologyTransition,
} = await import('../chat-dispatch/slot-registry.mjs');
const {
  getWatcher,
  completeWatcher,
  handlerHelpers,
  pushWatcherStatus,
  registerWatcher,
  startWatcherSupervisor,
  stopWatcherSupervisor,
  unregisterWatcher,
} = await import('./watchers.mjs');

const USER = 'user_watcher_orchestration';
let ensembleCoordinator;
let singlePrimary;
let watcherId;
let agentFireWatcherId;
let cancelDuringWaitWatcherId;
let finalizedDuringWaitWatcherId;
let imageDuringWaitWatcherId;
let imageCancelledDuringWaitWatcherId;
const statusEvents = [];

function createAgent(name) {
  return createCustomAgent({
    name,
    emoji: 'W',
    description: 'watcher orchestration fixture',
    provider: 'openai',
    model: 'gpt-4',
    toolSet: 'none',
    systemPrompt: 'Watcher orchestration test agent.',
    ownerId: USER,
  }).id;
}

beforeAll(async () => {
  fs.mkdirSync(path.join(USERS_DIR, USER), { recursive: true });
  saveUser({ id: USER, name: 'Watcher Test', role: 'user', skills: [], skillAssignments: {} });
  ensembleCoordinator = createAgent('Watcher Ensemble Coordinator');
  singlePrimary = createAgent('Watcher Single Primary');
  saveUser({
    id: USER,
    name: 'Watcher Test',
    role: 'user',
    skills: [],
    skillAssignments: { coordinator: ensembleCoordinator },
    orchestration: { mode: 'ensemble' },
  });
  watcherId = registerWatcher({
    userId: USER,
    // This is the durable shape used by the copied production watcher store.
    agentId: `${USER}_coordinator`,
    kind: 'fixture_orchestration_projection',
    label: 'Watcher projection fixture',
    expiresAt: null,
    state: {},
    onFire: { type: 'notify' },
  });
  agentFireWatcherId = registerWatcher({
    userId: USER,
    agentId: `${USER}_coordinator`,
    kind: 'fixture_orchestration_agent_fire',
    label: 'Watcher topology overlap fixture',
    expiresAt: null,
    state: {},
    onFire: { type: 'agent', prompt: 'Report the watcher result.' },
  });
  cancelDuringWaitWatcherId = registerWatcher({
    userId: USER,
    agentId: `${USER}_coordinator`,
    kind: 'fixture_orchestration_cancelled_fire',
    label: 'Watcher cancellation overlap fixture',
    expiresAt: null,
    state: {},
    onFire: { type: 'agent', prompt: 'This action must be cancelled.' },
  });
  finalizedDuringWaitWatcherId = registerWatcher({
    userId: USER,
    agentId: `${USER}_coordinator`,
    kind: 'fixture_orchestration_finalized_fire',
    label: 'Watcher finalized overlap fixture',
    expiresAt: null,
    state: {},
    onFire: { type: 'agent', prompt: 'This committed action must run.' },
  });
  imageDuringWaitWatcherId = registerWatcher({
    userId: USER,
    agentId: `${USER}_coordinator`,
    kind: 'fixture_orchestration_image_overlap',
    label: 'Watcher image topology overlap fixture',
    expiresAt: null,
    state: {},
    onFire: { type: 'notify' },
  });
  imageCancelledDuringWaitWatcherId = registerWatcher({
    userId: USER,
    agentId: `${USER}_coordinator`,
    kind: 'fixture_orchestration_image_cancelled',
    label: 'Watcher image cancellation overlap fixture',
    expiresAt: null,
    state: {},
    onFire: { type: 'notify' },
  });
  startWatcherSupervisor({
    sendStatus: (userId, event) => statusEvents.push({ userId, event }),
    showImage: mocks.showImage,
  });
  stopWatcherSupervisor();
});

afterAll(() => stopWatcherSupervisor());

describe('watcher ownership follows orchestration without rewriting durable targets', () => {
  it('projects symbolic coordinator to the single primary and restores it in ensemble', async () => {
    const watcher = getWatcher(USER, watcherId);
    const durableTarget = `${USER}_coordinator`;
    expect(watcher.agentId).toBe(durableTarget);
    expect(handlerHelpers(watcher).agentId).toBe(`${USER}_${ensembleCoordinator}`);
    expect(pushWatcherStatus(USER, watcherId, 'ensemble status')).toBe(true);
    expect(statusEvents.at(-1)).toMatchObject({
      userId: USER,
      event: { agent: `${USER}_${ensembleCoordinator}` },
    });

    await setOrchestrationPolicy(USER, { mode: 'single', primaryAgentId: singlePrimary });
    expect(getWatcher(USER, watcherId).agentId).toBe(durableTarget);
    expect(handlerHelpers(watcher).agentId).toBe(`${USER}_${singlePrimary}`);
    expect(pushWatcherStatus(USER, watcherId, 'single status')).toBe(true);
    expect(statusEvents.at(-1)).toMatchObject({
      userId: USER,
      event: { agent: `${USER}_${singlePrimary}` },
    });

    await setOrchestrationPolicy(USER, { mode: 'ensemble' });
    expect(getWatcher(USER, watcherId).agentId).toBe(durableTarget);
    expect(handlerHelpers(watcher).agentId).toBe(`${USER}_${ensembleCoordinator}`);
    expect(pushWatcherStatus(USER, watcherId, 'restored ensemble status')).toBe(true);
    expect(statusEvents.at(-1)).toMatchObject({
      userId: USER,
      event: { agent: `${USER}_${ensembleCoordinator}` },
    });
  });

  it('waits through a long mode-switch overlap and resolves after the commit', async () => {
    mocks.runAgentWithRetry.mockResolvedValueOnce({ succeeded: true, lastError: null });
    const writer = tryAcquireUserTopologyTransition(USER);
    expect(writer).toBeTruthy();
    // Model an interactive switch whose policy write has committed but whose
    // topology writer remains held through its terminal confirmation event.
    saveUser({
      ...getUser(USER),
      orchestration: { mode: 'single', primaryAgentId: singlePrimary },
    });

    const pending = handlerHelpers(getWatcher(USER, agentFireWatcherId))
      .fireAgent('The overlapped watcher fired.');
    try {
      // This exceeds the former 80 × 25ms retry ceiling.
      await new Promise(resolve => setTimeout(resolve, 2_100));
      expect(mocks.runAgentWithRetry).not.toHaveBeenCalled();
    } finally {
      finishUserTopologyTransition(writer);
    }

    await expect(pending).resolves.toBe(true);
    expect(mocks.runAgentWithRetry).toHaveBeenCalledOnce();
    expect(mocks.runAgentWithRetry.mock.calls[0][0].scopedAgent.id)
      .toBe(`${USER}_${singlePrimary}`);
    expect(mocks.runAgentWithRetry.mock.calls[0][0].systemNote).toContain('spawn_worker');
    expect(mocks.runAgentWithRetry.mock.calls[0][0].systemNote).not.toContain('ask_agent');
    expect(getWatcher(USER, agentFireWatcherId).agentId).toBe(`${USER}_coordinator`);
    await setOrchestrationPolicy(USER, { mode: 'ensemble' });
  });

  it('does not run a recurring watcher action cancelled while topology is held', async () => {
    mocks.runAgentWithRetry.mockClear();
    mocks.runAgentWithRetry.mockResolvedValueOnce({ succeeded: true, lastError: null });
    const writer = tryAcquireUserTopologyTransition(USER);
    expect(writer).toBeTruthy();

    const pending = handlerHelpers(getWatcher(USER, cancelDuringWaitWatcherId))
      .fireAgent('This pending action should be revoked.');
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(unregisterWatcher(USER, cancelDuringWaitWatcherId, 'cancelled')).toBe(true);
      expect(mocks.runAgentWithRetry).not.toHaveBeenCalled();
    } finally {
      finishUserTopologyTransition(writer);
    }

    await expect(pending).resolves.toBe(false);
    expect(mocks.runAgentWithRetry).not.toHaveBeenCalled();
    expect(getWatcher(USER, cancelDuringWaitWatcherId)).toMatchObject({ status: 'cancelled' });
  });

  it('holds watcher images until the committed topology can be observed', async () => {
    mocks.showImage.mockClear();
    mocks.showImage.mockResolvedValueOnce(true);
    const writer = tryAcquireUserTopologyTransition(USER);
    expect(writer).toBeTruthy();
    saveUser({
      ...getUser(USER),
      orchestration: { mode: 'single', primaryAgentId: singlePrimary },
    });

    const pending = handlerHelpers(getWatcher(USER, imageDuringWaitWatcherId)).showImage({
      filename: 'overlap.png',
      base64: 'aW1hZ2U=',
      mimeType: 'image/png',
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(mocks.showImage).not.toHaveBeenCalled();
    } finally {
      finishUserTopologyTransition(writer);
    }

    await expect(pending).resolves.toBe(true);
    expect(mocks.showImage).toHaveBeenCalledOnce();
    expect(mocks.showImage).toHaveBeenCalledWith(USER, expect.objectContaining({
      agent: `${USER}_${singlePrimary}`,
      filename: 'overlap.png',
    }));
    expect(getWatcher(USER, imageDuringWaitWatcherId).agentId).toBe(`${USER}_coordinator`);
    await setOrchestrationPolicy(USER, { mode: 'ensemble' });
  });

  it('drops a watcher image cancelled while it waits for topology', async () => {
    mocks.showImage.mockClear();
    const writer = tryAcquireUserTopologyTransition(USER);
    expect(writer).toBeTruthy();
    const pending = handlerHelpers(getWatcher(USER, imageCancelledDuringWaitWatcherId)).showImage({
      filename: 'cancelled.png',
      base64: 'aW1hZ2U=',
      mimeType: 'image/png',
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(unregisterWatcher(USER, imageCancelledDuringWaitWatcherId, 'cancelled')).toBe(true);
      await expect(pending).resolves.toBe(false);
      expect(mocks.showImage).not.toHaveBeenCalled();
    } finally {
      finishUserTopologyTransition(writer);
    }
  });

  it('preserves an already-finalized successful action while topology is held', async () => {
    mocks.runAgentWithRetry.mockClear();
    mocks.runAgentWithRetry.mockResolvedValueOnce({ succeeded: true, lastError: null });
    const writer = tryAcquireUserTopologyTransition(USER);
    expect(writer).toBeTruthy();
    try {
      expect(completeWatcher(USER, finalizedDuringWaitWatcherId, {
        status: 'done',
        finalText: 'The committed watcher fired.',
      })).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mocks.runAgentWithRetry).not.toHaveBeenCalled();
    } finally {
      finishUserTopologyTransition(writer);
    }

    await vi.waitFor(() => expect(mocks.runAgentWithRetry).toHaveBeenCalledOnce());
    expect(mocks.runAgentWithRetry.mock.calls[0][0].systemNote).toContain('ask_agent');
    expect(getWatcher(USER, finalizedDuringWaitWatcherId)).toMatchObject({ status: 'done' });
  });
});
