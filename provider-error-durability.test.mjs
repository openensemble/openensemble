import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMocks = vi.hoisted(() => ({
  appendToSession: vi.fn(async () => {}),
  loadSession: vi.fn(async () => []),
  loadCrossAgentContext: vi.fn(async () => []),
}));
const providerMocks = vi.hoisted(() => ({
  streamOllama: vi.fn(async function* () {
    yield {
      type: '__model_call', provider: 'ollama', model: 'test-model',
      phase: 'dispatch_planned', round: 1, toolsPresent: true,
      toolNames: ['email_send'], toolCount: 1,
    };
    yield { type: 'tool_call', name: 'email_send', args: { recipient: 'capture@example.test' } };
    yield { type: 'tool_result', name: 'email_send', text: 'Message accepted as msg-123' };
    yield { type: 'image', filename: 'receipt.png', mimeType: 'image/png', base64: 'inline-pixels' };
    yield { type: 'error', message: 'provider disconnected after tool completion' };
  }),
}));

vi.mock('./sessions.mjs', () => sessionMocks);
vi.mock('./chat/providers/ollama.mjs', () => providerMocks);
const { streamChat } = await import('./chat.mjs');

async function collect(gen) {
  const events = [];
  for await (const event of gen) events.push(event);
  return events;
}

beforeEach(() => {
  sessionMocks.appendToSession.mockClear();
  sessionMocks.loadSession.mockClear();
  sessionMocks.loadCrossAgentContext.mockClear();
  providerMocks.streamOllama.mockClear();
});

describe('provider-error effect durability', () => {
  it('persists completed tool and media effects once without replaying the provider', async () => {
    const agent = {
      id: 'durability-agent', name: 'Durability Agent',
      provider: 'ollama', model: 'test-model', systemPrompt: 'test',
      tools: [], ephemeral: true, skillCategory: 'test',
    };
    const events = await collect(streamChat(
      agent, 'send this once and make a receipt', null, null, 'default',
      null, null, false, null, { readOnlyTurn: true },
    ));

    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(providerMocks.streamOllama).toHaveBeenCalledOnce();
    expect(sessionMocks.appendToSession).toHaveBeenCalledOnce();
    const [sessionKey, userRow, imageRow, assistantRow] = sessionMocks.appendToSession.mock.calls[0];
    expect(sessionKey).toBe(agent.id);
    expect(userRow).toMatchObject({ role: 'user', content: 'send this once and make a receipt' });
    expect(imageRow).toMatchObject({
      role: 'assistant',
      image: { filename: 'receipt.png', mimeType: 'image/png', base64: 'inline-pixels' },
    });
    expect(assistantRow).toMatchObject({
      role: 'assistant', content: '',
      toolResults: [{ name: 'email_send', text: 'Message accepted as msg-123' }],
      toolEvents: [expect.objectContaining({
        name: 'email_send', providerCallOrdinal: 1, resultIndex: 0,
      })],
    });
    expect(assistantRow.toolsUsed[0]).toContain('email_send');
  });
});
