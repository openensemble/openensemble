import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(async () => [1, 0]),
  recall: vi.fn(async () => []),
  listLedger: vi.fn(async () => []),
  getConfig: vi.fn(async () => ({ enabled: false, setupComplete: true })),
}));

vi.mock('./embedding.mjs', () => ({ embed: mocks.embed }));
vi.mock('./recall.mjs', () => ({
  recall: mocks.recall,
  TEMPORAL_RE: /\b(?:yesterday|recently)\b/i,
  parseTimeAnchor: () => null,
}));
vi.mock('./lance.mjs', () => ({ isChildAccountJailbreak: () => false }));
vi.mock('./predictive-context.mjs', () => ({
  shouldSkipRecall: () => ({ skip: false }),
  filterByConfidence: rows => rows,
}));
vi.mock('../roles.mjs', () => ({ getAgentAssignedSkills: () => ['coordinator'] }));
vi.mock('../lib/personalization/ledger.mjs', () => ({ listLedger: mocks.listLedger }));
vi.mock('../lib/personalization/config.mjs', () => ({ getConfig: mocks.getConfig }));

const { buildAgentContext } = await import('./context.mjs');

describe('buildAgentContext non-learning propagation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes suppressLearning to every recall while retaining normal defaults', async () => {
    await buildAgentContext(
      'jarvis',
      'Remember the kitchen lighting preference',
      'readonly-context-user',
      { suppressLearning: true },
    );

    expect(mocks.recall).toHaveBeenCalledTimes(3);
    expect(mocks.recall.mock.calls.every(([args]) => args.suppressLearning === true)).toBe(true);

    mocks.recall.mockClear();
    await buildAgentContext(
      'jarvis',
      'Remember the kitchen lighting preference',
      'normal-context-user',
    );

    expect(mocks.recall).toHaveBeenCalledTimes(3);
    expect(mocks.recall.mock.calls.every(([args]) => args.suppressLearning === false)).toBe(true);
  });
});
