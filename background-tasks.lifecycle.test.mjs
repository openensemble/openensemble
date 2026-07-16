import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const fixture = vi.hoisted(() => ({
  watcherSeq: 0,
}));

vi.mock('./scheduler/watchers.mjs', () => ({
  registerWatcher: vi.fn(() => `watcher_lifecycle_${++fixture.watcherSeq}`),
  pushWatcherStatus: vi.fn(() => true),
  completeWatcher: vi.fn(() => true),
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

vi.mock('./sessions.mjs', () => ({ appendToSession: vi.fn(async () => true) }));
vi.mock('./ws-handler.mjs', () => ({ noteDeviceBackgroundWork: vi.fn() }));

// Keep workers live until stopWorker aborts them, so ownership/status can be
// asserted against the real in-memory background registry.
vi.mock('./chat.mjs', () => ({
  streamChat: async function* (_agent, _task, signal) {
    await new Promise(resolve => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    if (signal?.aborted) throw new Error('aborted by lifecycle test');
    yield { type: 'token', text: 'done' };
  },
}));

import { USERS_DIR } from './lib/paths.mjs';
import { saveUser } from './routes/_helpers.mjs';
import { createCustomAgent } from './agents.mjs';
import { setOrchestrationPolicy } from './lib/orchestration-policy.mjs';
import {
  completeSyncDelegation,
  describeBackgroundWorkForSession,
  dispatchBackground,
  getActiveTasks,
  listActiveBackgroundWorkForAgent,
  registerSyncDelegation,
  spawnWorker,
  stopWorker,
} from './background-tasks.mjs';

const USER = 'user_bglifecycle';
const OTHER = 'user_bglifecycleother';
let primary;
let parked;
let workerA;
let workerB;
let delegation;

function makeAgent(ownerId, name) {
  return createCustomAgent({
    name,
    emoji: 'B',
    description: 'background lifecycle fixture',
    provider: 'openai',
    model: 'gpt-4',
    toolSet: 'web',
    systemPrompt: 'Test agent.',
    ownerId,
  }).id;
}

beforeAll(async () => {
  for (const id of [USER, OTHER]) fs.mkdirSync(path.join(USERS_DIR, id), { recursive: true });
  saveUser({ id: USER, name: 'Background Lifecycle', role: 'user', skills: [], skillAssignments: {} });
  saveUser({ id: OTHER, name: 'Background Lifecycle Other', role: 'user', skills: [], skillAssignments: {} });
  primary = makeAgent(USER, 'Background Primary');
  parked = makeAgent(USER, 'Background Parked');
  saveUser({
    id: USER,
    name: 'Background Lifecycle',
    role: 'user',
    skills: [],
    skillAssignments: { coordinator: primary, fixture_parked: parked },
  });
  await setOrchestrationPolicy(USER, { mode: 'ensemble' });

  workerA = spawnWorker({
    workerAgent: { id: `ephemeral_worker_1_a_${primary}` },
    task: 'primary-owned work',
    userId: USER,
    chipOwnerId: `${USER}_${primary}`,
    ownerKey: primary,
    workerName: 'Primary Worker',
  });
  workerB = spawnWorker({
    workerAgent: { id: `ephemeral_worker_2_b_${parked}` },
    task: 'parked-owned work',
    userId: USER,
    chipOwnerId: `${USER}_${parked}`,
    ownerKey: parked,
    workerName: 'Parked Worker',
  });
  delegation = 'sync_lifecycle_delegation';
  registerSyncDelegation({
    taskId: delegation,
    userId: USER,
    agentId: `ephemeral_deleg_3_c_${parked}`,
    agentName: 'Parked Delegation',
    summary: 'delegated parked work',
    visibleAgentId: `${USER}_${primary}`,
  });

  // Let both worker runners enter the mocked stream so abort-driven cleanup is
  // deterministic even on a heavily parallelized full-suite run.
  await new Promise(resolve => setImmediate(resolve));
  await vi.waitFor(() => {
    expect(getActiveTasks().map(task => task.taskId)).toEqual(
      expect.arrayContaining([workerA, workerB, delegation]),
    );
  });
});

afterAll(async () => {
  completeSyncDelegation(delegation, { outcome: 'stopped', finalText: 'test cleanup' });
  expect(stopWorker(USER, workerA, primary).ok).toBe(true);
  expect(stopWorker(USER, workerB, parked).ok).toBe(true);
  await vi.waitFor(() => {
    expect(getActiveTasks().filter(task => task.userId === USER)).toHaveLength(0);
  }, { timeout: 5000 });
  await setOrchestrationPolicy(USER, { mode: 'ensemble' });
});

describe('background ownership across orchestration modes', () => {
  it('matches worker and delegation references without crossing user boundaries', () => {
    expect(listActiveBackgroundWorkForAgent(USER, primary).map(task => task.taskId))
      .toEqual(expect.arrayContaining([workerA, delegation]));
    expect(listActiveBackgroundWorkForAgent(USER, parked).map(task => task.taskId))
      .toEqual(expect.arrayContaining([workerB, delegation]));
    expect(listActiveBackgroundWorkForAgent(OTHER, primary)).toEqual([]);
    expect(listActiveBackgroundWorkForAgent(USER, 'stale_background_agent')).toEqual([]);
  });

  it('reserves a planned handoff target while stage one is still running', async () => {
    const pipelineId = dispatchBackground(
      {
        id: `ephemeral_deleg_4_d_${primary}`,
        name: 'Pipeline Producer',
        systemPrompt: 'Produce the first-stage result.',
      },
      'produce then hand off',
      USER,
      `${USER}_${primary}`,
      'Pipeline Producer',
      '🧪',
      {
        handoff: {
          agent: {
            id: parked,
            name: 'Pipeline Consumer',
            systemPrompt: 'Consume the first-stage result.',
          },
          directive: 'Finish the pipeline.',
        },
      },
    );

    expect(listActiveBackgroundWorkForAgent(USER, parked).map(task => task.taskId))
      .toContain(pipelineId);
    expect(stopWorker(USER, pipelineId).ok).toBe(true);
    await vi.waitFor(() => {
      expect(getActiveTasks().some(task => task.taskId === pipelineId)).toBe(false);
    });
  });

  it('keeps worker status owner-scoped in ensemble and user-wide in single mode', async () => {
    await setOrchestrationPolicy(USER, { mode: 'ensemble' });
    const ensemble = describeBackgroundWorkForSession(USER, `${USER}_${primary}`);
    expect(ensemble).toContain('Primary Worker');
    expect(ensemble).not.toContain('Parked Worker');

    await setOrchestrationPolicy(USER, { mode: 'single', primaryAgentId: primary });
    const single = describeBackgroundWorkForSession(USER, `${USER}_${primary}`);
    expect(single).toContain('Primary Worker');
    expect(single).toContain('Parked Worker');
  });
});
