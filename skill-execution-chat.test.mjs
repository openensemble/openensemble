import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sessions = vi.hoisted(() => ({
  loadSession: vi.fn(async () => []),
  appendToSession: vi.fn(async () => {}),
  loadCrossAgentContext: vi.fn(async () => []),
}));

const provider = vi.hoisted(() => ({
  calls: [],
  streamOllama: vi.fn(async function* (agent) {
    provider.calls.push({
      provider: agent.provider,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      tools: (agent.tools ?? []).map(tool => tool.function?.name),
    });
    yield { type: '__content', content: 'Profile applied.' };
    yield {
      type: '__usage', provider: agent.provider, model: agent.model,
      inputTokens: 12, outputTokens: 4,
      reqCount: 1, completionCount: 1, usageCount: 1, usageComplete: true,
    };
  }),
}));

vi.mock('./sessions.mjs', () => sessions);
vi.mock('./chat/providers/ollama.mjs', () => ({ streamOllama: provider.streamOllama }));

const { streamChat } = await import('./chat.mjs');
const { USERS_DIR } = await import('./lib/paths.mjs');
const { setSkillExecutionOverride } = await import('./lib/skill-overrides.mjs');
const { addRoleManifest, removeRoleManifest } = await import('./roles.mjs');
const { listRunTraces, getRunTrace } = await import('./lib/run-inspector.mjs');

const createdUsers = [];
const SKILL_ID = 'test-execution-chat-skill';

async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

afterEach(() => {
  provider.calls.length = 0;
  provider.streamOllama.mockClear();
  removeRoleManifest(SKILL_ID);
  for (const userId of createdUsers.splice(0)) {
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
});

describe('streamChat skill execution integration', () => {
  it('applies a selected skill model and effort before the provider call and traces the source', async () => {
    const userId = `execution_chat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    createdUsers.push(userId);
    fs.mkdirSync(path.join(USERS_DIR, userId), { recursive: true });
    fs.writeFileSync(path.join(USERS_DIR, userId, 'profile.json'), JSON.stringify({ id: userId, role: 'owner' }));

    const selectedTool = {
      type: 'function',
      function: {
        name: 'execution_profile_probe',
        description: 'Read-only execution profile probe',
        parameters: { type: 'object', properties: {} },
      },
    };
    addRoleManifest({ id: SKILL_ID, name: 'Execution Probe', category: 'utility', tools: [selectedTool] });
    await setSkillExecutionOverride(userId, SKILL_ID, {
      provider: 'ollama', model: 'profile-model', reasoningEffort: 'high',
    });

    const agent = {
      id: 'jarvis', name: 'Jarvis', provider: 'ollama', model: 'base-model',
      reasoningEffort: 'low', contextSize: 16_000, systemPrompt: 'test',
      skillCategory: 'coordinator', ephemeral: true, _rosterSolo: true,
      tools: [selectedTool],
    };

    await collect(streamChat(
      agent,
      'Use the selected read-only probe.',
      null, null, userId, null, null, true, null,
      {
        readOnlyTurn: true,
        toolPlan: { mode: 'selected', selectedTools: ['execution_profile_probe'], source: 'test' },
      },
    ));

    expect(provider.calls).toEqual([expect.objectContaining({
      provider: 'ollama', model: 'profile-model', reasoningEffort: 'high',
      tools: ['execution_profile_probe'],
    })]);
    // streamChat works on a routed copy; the caller's durable/base agent stays unchanged.
    expect(agent).toMatchObject({ model: 'base-model', reasoningEffort: 'low', contextSize: 16_000 });

    const summary = listRunTraces(userId, { limit: 1 })[0];
    const trace = getRunTrace(userId, summary.id);
    expect(trace).toMatchObject({ provider: 'ollama', model: 'profile-model' });
    expect(trace.meta.execution).toMatchObject({
      applied: true,
      sourceSkillIds: { model: SKILL_ID, reasoningEffort: SKILL_ID },
      effective: { provider: 'ollama', model: 'profile-model', reasoningEffort: 'high' },
    });
  });
});
