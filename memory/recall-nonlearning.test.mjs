import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(async () => [1, 0]),
  getTable: vi.fn(),
  queuedWrite: vi.fn(async () => {}),
}));

vi.mock('./embedding.mjs', () => ({ embed: mocks.embed }));
vi.mock('./lance.mjs', () => ({ getTable: mocks.getTable }));
vi.mock('./shared.mjs', () => ({
  UUID_RE: /^[a-zA-Z0-9_-]{3,120}$/,
  assertId: id => id,
  safeLanceVal: value => String(value),
  queuedWrite: mocks.queuedWrite,
  calcRetention: () => 1,
  recencyScore: () => 1,
  TOKEN_BUDGET: { userContext: 400 },
}));

const { recall } = await import('./recall.mjs');
const { runWithTurnContext } = await import('../lib/turn-abort-context.mjs');

const semanticRow = Object.freeze({
  id: 'mem_read_only_1',
  agent_id: 'jarvis',
  text: 'The kitchen lights are warm white.',
  _distance: 0.1,
  salience_composite: 0.8,
  confidence: 0.9,
  stability: 24,
  recall_count: 3,
  created_at: '2026-07-01T00:00:00.000Z',
  last_recalled_at: '2026-07-12T00:00:00.000Z',
});
function fakeTable() {
  return {
    query: () => ({
      where: () => ({ toArray: async () => [] }),
    }),
    vectorSearch: () => ({
      where: () => ({
        limit: () => ({ toArray: async () => [{ ...semanticRow }] }),
      }),
    }),
  };
}

describe('recall non-learning reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTable.mockResolvedValue(fakeTable());
  });

  it('returns identical ranked memories without queueing recall-stat writes', async () => {
    const base = {
      agentId: 'jarvis',
      type: 'params',
      query: 'What color are the kitchen lights?',
      queryVec: [1, 0],
      includeShared: false,
      userId: 'readonly-recall-user',
    };

    const normal = await recall(base);
    expect(mocks.queuedWrite).toHaveBeenCalledOnce();

    mocks.queuedWrite.mockClear();
    const readOnly = await recall({ ...base, suppressLearning: true });

    expect(readOnly).toEqual(normal);
    expect(mocks.queuedWrite).not.toHaveBeenCalled();

    const inherited = await runWithTurnContext(
      { suppressLearning: true },
      () => recall(base),
    );
    expect(inherited).toEqual(normal);
    expect(mocks.queuedWrite).not.toHaveBeenCalled();
  });
});
