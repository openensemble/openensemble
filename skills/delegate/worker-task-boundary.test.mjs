import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnWorker: vi.fn(() => 'wkr_1784150000000_bound'),
  spawnWorkerIdempotently: vi.fn(async ({ spawn }) => ({
    duplicate: false,
    taskId: await spawn(),
  })),
}));

vi.mock('../../background-tasks.mjs', () => ({
  listWorkersForOwner: vi.fn(() => []),
  spawnWorker: mocks.spawnWorker,
}));

vi.mock('../../routes/_helpers.mjs', () => ({
  getAgentsForUser: vi.fn(() => [{
    id: 'jarvis', name: 'Jarvis', emoji: 'J', tools: [],
  }]),
}));

vi.mock('../../lib/worker-spawn-idempotency.mjs', () => ({
  spawnWorkerIdempotently: mocks.spawnWorkerIdempotently,
}));

vi.mock('../../lib/turn-trace-context.mjs', () => ({
  getTurn: vi.fn(() => ({
    rootId: 'root_boundary', messageId: 'message_boundary',
    attemptId: 'attempt_boundary', sessionKey: 'user_abc_jarvis',
    sessionEpoch: 'epoch_boundary',
  })),
}));

const { executeSkillTool } = await import('./execute.mjs');

describe('delegate worker task boundary', () => {
  it('passes the raw task separately from detached execution guidance', async () => {
    const rawTask = 'Create a cat image, check the weather, then email both to me.';
    const trustedExecutionTask = 'The worker is already running. Do the cat, weather, and email steps directly.';
    const trustedContract = Object.freeze({
      version: 1,
      source: 'singleton-compound',
      steps: Object.freeze([{ index: 0, toolName: 'image_generation' }]),
    });
    const events = [];
    for await (const event of executeSkillTool(
      'spawn_worker',
      {
        task: rawTask,
        label: 'Complete 3-step workflow',
        completionContract: { injected: 'model-controlled value must be ignored' },
        executionTask: 'MODEL-CONTROLLED EXECUTION OVERRIDE',
      },
      'user_abc',
      'user_abc_jarvis',
      { completionContract: trustedContract, executionTask: trustedExecutionTask },
    )) events.push(event);

    expect(mocks.spawnWorkerIdempotently).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_abc', ownerKey: 'jarvis', task: rawTask,
    }));
    expect(mocks.spawnWorker).toHaveBeenCalledOnce();
    const admission = mocks.spawnWorker.mock.calls[0][0];
    expect(admission.task).toBe(rawTask);
    expect(admission.executionTask).toContain(trustedExecutionTask);
    expect(admission.executionTask).toContain('background worker running detached');
    expect(admission.executionTask).not.toBe(rawTask);
    expect(admission.executionTask).not.toContain('MODEL-CONTROLLED EXECUTION OVERRIDE');
    expect(admission.executionTask).not.toContain(rawTask);
    expect(admission.completionContract).toBe(trustedContract);
    expect(admission.task).not.toContain('completionContract');
    expect(admission.executionTask).not.toContain('model-controlled value');
    const idempotentBoundary = mocks.spawnWorkerIdempotently.mock.calls[0][0];
    expect(idempotentBoundary).not.toHaveProperty('completionContract');
    expect(idempotentBoundary.task).toBe(rawTask);
    expect(events).toEqual([expect.objectContaining({
      type: 'result', text: expect.stringContaining('wkr_1784150000000_bound'),
    })]);
  });
});
