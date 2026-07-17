import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  roles: [
    { id: 'dead-skill', name: 'Dead Skill', intent_examples: ['dead example'] },
    { id: 'live-skill', name: 'Live Skill', intent_examples: ['live example'] },
  ],
}));

vi.mock('../memory/embedding.mjs', () => ({ embed: mocks.embed }));
vi.mock('../roles.mjs', () => ({
  listRoles: vi.fn(() => mocks.roles),
  listAllRoles: vi.fn(() => mocks.roles),
  getRoleAssignments: vi.fn(() => ({
    coordinator: 'coordinator-agent',
    'dead-skill': 'dead-agent',
    'live-skill': 'live-agent',
  })),
}));

const {
  invalidateIntentEmbeddings,
  loadIntentEmbeddings,
  rankByEmbedding,
} = await import('./specialist-embed-router.mjs');

describe('specialist embedding index construction', () => {
  beforeEach(() => {
    invalidateIntentEmbeddings();
    mocks.embed.mockReset();
    mocks.roles = [
      { id: 'dead-skill', name: 'Dead Skill', intent_examples: ['dead example'] },
      { id: 'live-skill', name: 'Live Skill', intent_examples: ['live example'] },
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses and loudly counts zero-vector examples while retaining healthy examples', async () => {
    mocks.embed.mockImplementation(async text => {
      if (text === 'dead example') return [0, 0, 0];
      return [1, 0, 0];
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await loadIntentEmbeddings();

    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      'REFUSED 1 invalid embedding examples (zero-norm=1, empty/non-array=0, non-numeric/non-finite=0, dimension-mismatch=0)',
    ));
    await expect(rankByEmbedding(
      'find the live skill',
      'test-user',
      'coordinator-agent',
    )).resolves.toEqual([
      expect.objectContaining({ skillId: 'live-skill', phrase: 'live example' }),
    ]);
  });

  it('refuses empty, malformed, non-finite, and dimension-incompatible indexed vectors', async () => {
    const phrases = [
      'live example',
      'empty example',
      'non-array example',
      'non-numeric example',
      'nan example',
      'infinite example',
      'zero example',
      'wrong dimension example',
    ];
    mocks.roles = [{ id: 'live-skill', name: 'Live Skill', intent_examples: phrases }];
    const vectors = new Map([
      ['live example', [1, 0, 0]],
      ['empty example', []],
      ['non-array example', null],
      ['non-numeric example', [1, '0', 0]],
      ['nan example', [Number.NaN, 0, 0]],
      ['infinite example', [Number.POSITIVE_INFINITY, 0, 0]],
      ['zero example', [0, 0, 0]],
      ['wrong dimension example', [1, 0]],
      ['valid query', [1, 0, 0]],
    ]);
    mocks.embed.mockImplementation(async text => vectors.get(text));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await loadIntentEmbeddings();

    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      'REFUSED 7 invalid embedding examples (zero-norm=1, empty/non-array=2, non-numeric/non-finite=3, dimension-mismatch=1)',
    ));
    await expect(rankByEmbedding(
      'valid query',
      'test-user',
      'coordinator-agent',
    )).resolves.toEqual([
      expect.objectContaining({ skillId: 'live-skill', phrase: 'live example', sim: 1 }),
    ]);
  });

  it.each([
    ['empty', []],
    ['non-array', null],
    ['non-numeric', [1, '0', 0]],
    ['non-finite', [Number.NaN, 0, 0]],
    ['infinite', [Number.POSITIVE_INFINITY, 0, 0]],
    ['zero-norm', [0, 0, 0]],
    ['dimension-incompatible', [1, 0]],
  ])('fails closed for a %s query vector', async (_label, queryVector) => {
    mocks.embed.mockImplementation(async text => (
      text === 'query text' ? queryVector : [1, 0, 0]
    ));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await loadIntentEmbeddings();

    await expect(rankByEmbedding(
      'query text',
      'test-user',
      'coordinator-agent',
    )).resolves.toEqual([]);
  });
});
