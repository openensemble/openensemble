import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMocks = vi.hoisted(() => ({
  appendToSession: vi.fn(async () => {}),
  loadSession: vi.fn(async () => []),
  loadCrossAgentContext: vi.fn(async () => []),
}));

const providerMocks = vi.hoisted(() => ({
  streamOllama: vi.fn(async function* () {
    const attempt = providerMocks.streamOllama.mock.calls.length;
    yield {
      type: '__model_call', provider: 'ollama', model: 'test-model',
      phase: 'dispatch_planned', round: 1, toolsPresent: true,
      toolNames: attempt === 1 ? ['request_tools'] : ['request_tools', 'email_read'],
      toolCount: attempt === 1 ? 1 : 2,
    };
    if (attempt === 1) {
      yield { type: '__content', content: "I don't have access to email." };
      return;
    }
    yield {
      type: 'tool_call', name: 'email_read', args: { messageId: 'msg-9' },
      toolCallId: 'provider-read-9',
    };
    yield {
      type: 'tool_result', name: 'email_read', text: 'body: recovered',
      toolCallId: 'provider-read-9',
    };
    yield { type: '__content', content: 'The recovered body is available.' };
  }),
}));

const routerMocks = vi.hoisted(() => ({
  trimToolsForTurn: vi.fn(async ({ agent }) => ({
    fullTools: [...agent.tools],
    trimmedTools: agent.tools.filter(tool => tool.function?.name === 'request_tools'),
    initiallyIncludedSkills: new Set(),
    skillsKept: new Set(['coordinator']),
    matchedSkills: new Set(),
    routerNotes: ['recovery-round-test'],
  })),
  recordTurnRouting: vi.fn(async () => {}),
  expandToolsByReason: vi.fn(async ({ agent, fullTools }) => {
    const emailTool = fullTools.find(tool => tool.function?.name === 'email_read');
    if (emailTool && !agent.tools.includes(emailTool)) agent.tools.push(emailTool);
    return { addedToolNames: ['email_read'], addedSkills: ['email'] };
  }),
  inferMissingToolSkills: vi.fn(() => new Set(['email'])),
  shouldUseProviderHostedImageBackend: vi.fn(() => false),
}));

vi.mock('./sessions.mjs', () => sessionMocks);
vi.mock('./chat/providers/ollama.mjs', () => providerMocks);
vi.mock('./lib/tool-router.mjs', () => routerMocks);
vi.mock('./memory.mjs', () => ({
  buildAgentContext: vi.fn(async () => ({ memories: [] })),
  formatContext: vi.fn(() => ''),
  addToSessionBuffer: vi.fn(),
  processSignals: vi.fn(async () => null),
}));
vi.mock('./memory/signals.mjs', () => ({ trackFriction: vi.fn(async () => {}) }));

const { streamChat } = await import('./chat.mjs');

async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

function tool(name) {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chat recovery tool-round provenance', () => {
  it('offsets retry tool events past model calls from the rejected first draft', async () => {
    const agent = {
      id: 'recovery-round-agent', name: 'Recovery Round Agent',
      provider: 'ollama', model: 'test-model', systemPrompt: 'test',
      tools: [tool('request_tools'), tool('email_read')],
      ephemeral: true, skillCategory: 'coordinator',
    };

    const events = await collect(streamChat(
      agent, 'Read message 9.', null, null, 'default',
      null, null, false, null, { readOnlyTurn: true },
    ));

    expect(providerMocks.streamOllama).toHaveBeenCalledTimes(2);
    expect(events.some(event => event.type === 'done')).toBe(true);
    expect(sessionMocks.appendToSession).toHaveBeenCalledOnce();
    const assistantRow = sessionMocks.appendToSession.mock.calls[0].at(-1);
    expect(assistantRow.toolEvents).toEqual([
      expect.objectContaining({
        name: 'email_read', toolCallId: 'provider-read-9',
        providerCallOrdinal: 2, resultIndex: 0,
      }),
    ]);
  });
});
