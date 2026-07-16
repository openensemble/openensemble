import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  roster: [{ id: 'jarvis', name: 'Jarvis', emoji: '🫙', _rosterSolo: true }],
  nextTask: 0,
  spawnWorker: vi.fn(() => `wkr_1700000000000_${(++mocks.nextTask).toString(36)}`),
  listWorkersForUser: vi.fn(() => []),
  listWorkersForOwner: vi.fn(() => []),
  stopWorker: vi.fn(() => ({ ok: true, name: 'Jarvis worker' })),
}));

vi.mock('./background-tasks.mjs', () => ({
  spawnWorker: mocks.spawnWorker,
  listWorkersForUser: mocks.listWorkersForUser,
  listWorkersForOwner: mocks.listWorkersForOwner,
  listRecentWorkersForUser: vi.fn(() => []),
  listRecentWorkersForOwner: vi.fn(() => []),
  listActiveDelegationsForUser: vi.fn(() => []),
  listRecentDelegationsForUser: vi.fn(() => []),
  stopWorker: mocks.stopWorker,
}));

vi.mock('./routes/_helpers.mjs', () => ({
  getAgentsForUser: () => mocks.roster,
}));

const { executeSkillTool } = await import('./skills/delegate/execute.mjs');
const { turnTraceContext } = await import('./lib/turn-trace-context.mjs');

function unique(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function collect(name, args, userId, callerAgentId) {
  const chunks = [];
  for await (const chunk of executeSkillTool(name, args, userId, callerAgentId)) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  mocks.roster = [{ id: 'jarvis', name: 'Jarvis', emoji: '🫙', _rosterSolo: true }];
  mocks.spawnWorker.mockClear();
  mocks.listWorkersForUser.mockReset().mockReturnValue([]);
  mocks.listWorkersForOwner.mockReset().mockReturnValue([]);
  mocks.stopWorker.mockClear();
});

describe('delegate worker admission', () => {
  it('keeps single-mode quota user-wide, threads source correlation, and coalesces Retry', async () => {
    const userId = unique('worker_delegate_solo');
    const messageId = unique('message');
    const firstTurn = {
      messageId, rootId: 'root-one', attemptId: 'attempt-one',
      sessionKey: `${userId}_jarvis`, sessionEpoch: 'epoch-one',
    };
    const first = await turnTraceContext.run(firstTurn, () => collect(
      'spawn_worker',
      { label: 'Stable audit', task: 'Audit the inbox fully.' },
      userId,
      'user_test_jarvis',
    ));

    expect(first[0].text).toContain('Hired a background worker');
    expect(mocks.listWorkersForUser).toHaveBeenCalled();
    expect(mocks.listWorkersForOwner).not.toHaveBeenCalled();
    expect(mocks.spawnWorker).toHaveBeenCalledTimes(1);
    expect(mocks.spawnWorker).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      ownerKey: 'jarvis',
      originalTask: 'Audit the inbox fully.',
      workerAgent: expect.objectContaining({ ephemeral: true, workerOwnerId: 'jarvis' }),
      rootTaskId: 'root-one',
      sourceMessageId: messageId,
      sourceAttemptId: 'attempt-one',
      sourceSessionKey: `${userId}_jarvis`,
      sourceSessionEpoch: 'epoch-one',
    }));

    const retryTurn = {
      messageId, rootId: 'root-two', attemptId: 'attempt-two',
      sessionKey: `${userId}_jarvis`, sessionEpoch: 'epoch-one',
    };
    // Duplicate recovery must happen before the new-admission capacity gate;
    // the already-running logical job still resolves to its original id when
    // other workers have filled the account quota in the meantime.
    mocks.listWorkersForUser.mockReturnValue(Array.from({ length: 5 }, (_, i) => ({ taskId: `other_${i}` })));
    const retry = await turnTraceContext.run(retryTurn, () => collect(
      'spawn_worker',
      { label: 'Rephrased audit', task: 'Please deeply audit every inbox item.' },
      userId,
      'user_test_jarvis',
    ));
    expect(retry[0].text).toContain('already has a background worker');
    expect(mocks.spawnWorker).toHaveBeenCalledTimes(1);
  });

  it('keeps single-mode stop authorization user-wide', async () => {
    const userId = unique('worker_stop_solo');
    await collect('stop_worker', { worker_id: 'wkr_1700000000000_a' }, userId, 'user_test_jarvis');
    expect(mocks.stopWorker).toHaveBeenCalledWith(userId, 'wkr_1700000000000_a', null);
  });

  it('keeps ensemble quota and stop authorization owner-scoped', async () => {
    mocks.roster = [
      { id: 'jarvis', name: 'Jarvis', emoji: '🫙' },
      { id: 'gina', name: 'Gina', emoji: '✉️' },
    ];
    const userId = unique('worker_delegate_ensemble');
    const turn = { messageId: unique('message'), rootId: 'root-ensemble' };
    await turnTraceContext.run(turn, () => collect(
      'spawn_worker',
      { label: 'Owner job', task: 'Run the owner job.' },
      userId,
      'user_test_jarvis',
    ));
    expect(mocks.listWorkersForOwner).toHaveBeenCalledWith(userId, 'jarvis');
    expect(mocks.listWorkersForUser).not.toHaveBeenCalled();

    await collect('stop_worker', { worker_id: 'wkr_1700000000000_b' }, userId, 'user_test_jarvis');
    expect(mocks.stopWorker).toHaveBeenCalledWith(userId, 'wkr_1700000000000_b', 'jarvis');
  });
});
