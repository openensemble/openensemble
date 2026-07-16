import { describe, expect, it, vi } from 'vitest';

vi.mock('./scheduler/watchers.mjs', () => ({
  registerWatcher: vi.fn(),
  pushWatcherStatus: vi.fn(),
  completeWatcher: vi.fn(),
}));
vi.mock('./lib/tool-plan-memory.mjs', () => ({
  learnToolPlanFromToolEvents: vi.fn(),
  matchToolPlan: vi.fn(() => null),
}));
vi.mock('./lib/scheduled-child-barrier.mjs', () => ({
  registerScheduledChild: vi.fn(),
  completeScheduledChild: vi.fn(),
}));
vi.mock('./lib/task-outcomes.mjs', () => ({
  appendTaskOutcome: vi.fn(async () => true),
  loadTaskOutcomes: vi.fn(() => []),
}));
vi.mock('./lib/orchestration-policy.mjs', () => ({
  getOrchestrationPolicy: vi.fn(() => ({ mode: 'ensemble', primaryAgentId: null })),
}));
vi.mock('./chat.mjs', () => ({
  streamChat: vi.fn(async function* () {
    yield { type: 'token', text: 'provisional text' };
    yield { type: 'replace', text: 'replacement text' };
    yield { type: 'token', text: ' plus a delta' };
    yield { type: '__content', content: 'authoritative final content' };
  }),
}));

const { dispatchEphemeral } = await import('./background-tasks.mjs');

describe('background stream content accumulation', () => {
  it('appends tokens, resets on replace, and trusts final __content', async () => {
    const progress = vi.fn();
    const result = await dispatchEphemeral(
      { id: 'ephemeral_content_test', name: 'Content test worker', ephemeral: true },
      'return canonical content',
      'content-test-user',
      { onProgress: progress },
    );

    expect(result).toBe('authoritative final content');
    expect(progress.mock.calls).toEqual([['provisional text'], [' plus a delta']]);
  });
});
