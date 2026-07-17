import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMocks = vi.hoisted(() => ({
  appendToSession: vi.fn(),
  loadSession: vi.fn(async () => []),
  loadCrossAgentContext: vi.fn(async () => []),
}));
const providerMocks = vi.hoisted(() => ({ streamOllama: vi.fn() }));
const traceMocks = vi.hoisted(() => ({ recordRunTrace: vi.fn() }));

vi.mock('./sessions.mjs', () => sessionMocks);
vi.mock('./chat/providers/ollama.mjs', () => providerMocks);
vi.mock('./lib/run-inspector.mjs', () => ({
  recordRunTrace: traceMocks.recordRunTrace,
  redactArgsForTrace: value => value,
  redactTextForTrace: value => String(value ?? ''),
}));

const { streamChat } = await import('./chat.mjs');

const agent = {
  id: 'persistence-trace-agent',
  name: 'Persistence Trace Agent',
  provider: 'ollama',
  model: 'test-model',
  systemPrompt: 'test',
  tools: [],
  ephemeral: true,
  skillCategory: 'test',
};

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

beforeEach(() => {
  sessionMocks.appendToSession.mockReset();
  sessionMocks.loadSession.mockClear();
  sessionMocks.loadCrossAgentContext.mockClear();
  providerMocks.streamOllama.mockReset();
  traceMocks.recordRunTrace.mockReset();
});

describe('Run Inspector persistence ordering', () => {
  it('records a storage error, never complete, when a successful reply cannot persist', async () => {
    providerMocks.streamOllama.mockImplementation(async function* () {
      yield { type: 'token', text: 'finished' };
      yield { type: '__content', content: 'finished' };
    });
    sessionMocks.appendToSession.mockRejectedValue(new Error('forced session append failure'));

    const events = await collect(streamChat(
      agent, 'finish this', null, null, 'trace-order-user',
      null, null, false, null, { readOnlyTurn: true },
    ));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', code: 'persistence_failed', retryable: false,
    }));
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(traceMocks.recordRunTrace).toHaveBeenCalledOnce();
    expect(traceMocks.recordRunTrace.mock.calls[0][1]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Session persistence failed'),
    });
    expect(traceMocks.recordRunTrace.mock.calls.some(([, trace]) => trace.status === 'complete')).toBe(false);
  });

  it('combines provider and storage failure when completed effects cannot persist', async () => {
    providerMocks.streamOllama.mockImplementation(async function* () {
      yield { type: 'tool_call', name: 'email_send', args: { to: 'capture@example.test' } };
      yield { type: 'tool_result', name: 'email_send', text: 'accepted as message-1' };
      yield { type: 'error', message: 'provider disconnected after completion' };
    });
    sessionMocks.appendToSession.mockRejectedValue(new Error('forced effect append failure'));

    const events = await collect(streamChat(
      agent, 'send once', null, null, 'trace-order-user',
      null, null, false, null, { readOnlyTurn: true },
    ));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', code: 'persistence_failed', retryable: false,
    }));
    expect(sessionMocks.appendToSession).toHaveBeenCalledOnce();
    expect(traceMocks.recordRunTrace).toHaveBeenCalledOnce();
    expect(traceMocks.recordRunTrace.mock.calls[0][1]).toMatchObject({ status: 'error' });
    expect(traceMocks.recordRunTrace.mock.calls[0][1].error).toContain('Provider turn errored');
    expect(traceMocks.recordRunTrace.mock.calls[0][1].error).toContain('Session persistence failed');
  });
});
