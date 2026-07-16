import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toolsBySkill: new Map(),
  getRoleTools: vi.fn(),
  loadRoleManifests: vi.fn(),
}));

vi.mock('../../roles.mjs', () => ({
  getRoleTools: mocks.getRoleTools,
  loadRoleManifests: mocks.loadRoleManifests,
}));

import { buildWorkerTools } from './execute.mjs';

const tool = name => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});

describe('deep-research worker authorization', () => {
  beforeEach(() => {
    mocks.toolsBySkill.clear();
    mocks.getRoleTools.mockReset();
    mocks.getRoleTools.mockImplementation(skillId => mocks.toolsBySkill.get(skillId) ?? []);
    mocks.loadRoleManifests.mockReset();
  });

  it('builds worker schemas only from each skill authorized tool surface', async () => {
    mocks.toolsBySkill.set('deep_research', [tool('research_search'), tool('save_research')]);
    // An unauthorized/disabled/hidden web skill is represented by the canonical
    // getRoleTools boundary as an empty tool surface.
    mocks.toolsBySkill.set('web', []);

    const workerTools = await buildWorkerTools('user_research_restricted');

    expect(mocks.getRoleTools).toHaveBeenCalledWith('deep_research', 'user_research_restricted');
    expect(mocks.getRoleTools).toHaveBeenCalledWith('web', 'user_research_restricted');
    expect(workerTools.map(t => t.function.name)).toEqual(['research_search']);
    expect(workerTools.map(t => t.function.name)).not.toContain('web_search');
    expect(workerTools.map(t => t.function.name)).not.toContain('fetch_url');
  });

  it('retains the restricted web tools when the authorized surface includes them', async () => {
    mocks.toolsBySkill.set('deep_research', [tool('research_search')]);
    mocks.toolsBySkill.set('web', [tool('web_search'), tool('fetch_url'), tool('other_web_tool')]);

    const workerTools = await buildWorkerTools('user_research_allowed');

    expect(workerTools.map(t => t.function.name)).toEqual([
      'research_search',
      'web_search',
      'fetch_url',
    ]);
  });
});
