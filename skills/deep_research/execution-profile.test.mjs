import { rmSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_DIR } from '../../lib/paths.mjs';

const mocks = vi.hoisted(() => ({
  dispatchEphemeral: vi.fn(),
  getAgentsForUser: vi.fn(() => [{
    id: 'coordinator',
    name: 'Coordinator',
    provider: 'test',
    model: 'test-model',
    contextSize: 16_000,
  }]),
  getUser: vi.fn(() => ({})),
}));

vi.mock('../../background-tasks.mjs', () => ({ dispatchEphemeral: mocks.dispatchEphemeral }));
vi.mock('../../roles.mjs', () => ({
  getRoleManifest: () => ({
    tools: [
      { function: { name: 'research_search' } },
      { function: { name: 'web_search' } },
      { function: { name: 'fetch_url' } },
    ],
  }),
  getRoleTools: () => [
    { function: { name: 'research_search' } },
    { function: { name: 'web_search' } },
    { function: { name: 'fetch_url' } },
  ],
  loadRoleManifests: vi.fn(),
}));
vi.mock('../../routes/_helpers.mjs', () => ({
  getAgentsForUser: mocks.getAgentsForUser,
  getUser: mocks.getUser,
}));
vi.mock('../../routes/_helpers/broadcast.mjs', () => ({ broadcastToUsers: vi.fn() }));

import execute from './execute.mjs';
import { setSkillExecutionOverride } from '../../lib/skill-overrides.mjs';

afterEach(() => {
  mocks.dispatchEphemeral.mockReset();
  mocks.getAgentsForUser.mockClear();
  mocks.getUser.mockClear();
});

describe('deep research execution profiles', () => {
  it('applies the Deep Research profile to planner, workers, and synthesis', async () => {
    const userId = `deep_execution_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await setSkillExecutionOverride(userId, 'deep_research', {
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
    mocks.dispatchEphemeral.mockImplementation(async agent => {
      if (agent.name === 'Planner') {
        return JSON.stringify({ angles: [
          { title: 'One', query: 'question one' },
          { title: 'Two', query: 'question two' },
          { title: 'Three', query: 'question three' },
        ] });
      }
      if (agent.name === 'Synthesizer') return '# Final research';
      return '## Findings\nResult\n\n## Sources\n- https://example.com';
    });

    try {
      for await (const _chunk of execute(
        'deep_research_parallel',
        { topic: 'execution profile propagation', depth: 'deep' },
        userId,
        'coordinator',
        {},
      )) {}

      const phaseAgents = mocks.dispatchEphemeral.mock.calls.map(call => call[0]);
      expect(phaseAgents.map(agent => agent.name)).toEqual([
        'Planner',
        'Researcher — One',
        'Researcher — Two',
        'Researcher — Three',
        'Synthesizer',
      ]);
      for (const agent of phaseAgents) {
        expect(agent).toMatchObject({
          provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
        });
      }
    } finally {
      rmSync(path.join(BASE_DIR, 'users', userId), { recursive: true, force: true });
    }
  });
});
