import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  learnToolPlanFromToolEvents: vi.fn(() => [{ learned: true }]),
  appendSessionReportOnce: vi.fn(async () => 'appended'),
  handleChatMessage: vi.fn(async () => {}),
  observedContexts: [],
}));

vi.mock('./scheduler/watchers.mjs', () => ({
  registerWatcher: vi.fn(() => 'watcher-nonlearning-test'),
  pushWatcherStatus: vi.fn(),
  completeWatcher: vi.fn(),
}));
vi.mock('./lib/tool-plan-memory.mjs', () => ({
  learnToolPlanFromToolEvents: mocks.learnToolPlanFromToolEvents,
  matchToolPlan: vi.fn(() => null),
}));
vi.mock('./lib/scheduled-child-barrier.mjs', () => ({
  registerScheduledChild: vi.fn(),
  completeScheduledChild: vi.fn(),
}));
vi.mock('./lib/task-outcomes.mjs', () => ({
  appendTaskOutcome: vi.fn(async () => {}),
  loadTaskOutcomes: vi.fn(() => []),
}));
vi.mock('./sessions.mjs', () => ({
  appendSessionReportOnce: mocks.appendSessionReportOnce,
}));
vi.mock('./routes/_helpers.mjs', () => ({
  isUserTimeBlocked: vi.fn(() => false),
}));
vi.mock('./chat-dispatch.mjs', () => ({
  handleChatMessage: mocks.handleChatMessage,
}));
vi.mock('./ws-handler.mjs', () => ({
  sendToUser: vi.fn(),
}));
vi.mock('./chat.mjs', async () => {
  const { getTurnContext } = await import('./lib/turn-abort-context.mjs');
  return {
    streamChat: vi.fn(async function* () {
      mocks.observedContexts.push(getTurnContext()?.suppressLearning === true);
      yield { type: 'tool_call', name: 'list_tasks', args: {} };
      yield { type: 'tool_result', name: 'list_tasks', text: 'No tasks.' };
      yield { type: 'token', text: 'Finished.' };
      yield { type: 'done' };
    }),
  };
});

const { dispatchBackground, isTaskActive } = await import('./background-tasks.mjs');
const { runWithTurnContext } = await import('./lib/turn-abort-context.mjs');

async function waitForCompletion(taskId) {
  const deadline = Date.now() + 2_000;
  while (isTaskActive(taskId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(isTaskActive(taskId)).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function waitFor(check) {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

function dispatch(userId) {
  return dispatchBackground(
    {
      id: `ephemeral_${userId}`,
      name: 'Test Specialist',
      tools: [],
      ephemeral: true,
      skillCategory: 'general',
    },
    'Run a background probe.',
    userId,
    `coordinator_${userId}`,
    'Test Specialist',
    'T',
    { autoContinue: true },
  );
}

describe('background verifier non-learning boundary', () => {
  it('carries suppression into detached work and skips late recipe/continuation learning', async () => {
    const verifierTask = await runWithTurnContext(
      { suppressLearning: true },
      () => dispatch(`verifier-bg-${Date.now()}`),
    );
    await waitForCompletion(verifierTask);

    expect(mocks.observedContexts).toEqual([true]);
    expect(mocks.learnToolPlanFromToolEvents).not.toHaveBeenCalled();
    expect(mocks.handleChatMessage).not.toHaveBeenCalled();

    const normalTask = dispatch(`normal-bg-${Date.now()}`);
    await waitForCompletion(normalTask);
    await waitFor(() => mocks.handleChatMessage.mock.calls.length === 1);

    expect(mocks.observedContexts).toEqual([true, false]);
    expect(mocks.learnToolPlanFromToolEvents).toHaveBeenCalledOnce();
    expect(mocks.handleChatMessage).toHaveBeenCalledOnce();
    expect(mocks.appendSessionReportOnce).toHaveBeenCalledTimes(2);
  });
});
