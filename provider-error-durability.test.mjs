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
const runInspectorMocks = vi.hoisted(() => ({
  recordRunTrace: vi.fn(() => null),
}));

vi.mock('./sessions.mjs', () => sessionMocks);
vi.mock('./chat/providers/ollama.mjs', () => providerMocks);
vi.mock('./lib/run-inspector.mjs', async importOriginal => ({
  ...(await importOriginal()),
  recordRunTrace: runInspectorMocks.recordRunTrace,
}));
const { buildLlmHistory, streamChat } = await import('./chat.mjs');

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
  runInspectorMocks.recordRunTrace.mockClear();
});

function makeAgent() {
  return {
    id: 'durability-agent', name: 'Durability Agent',
    provider: 'ollama', model: 'test-model', systemPrompt: 'test',
    tools: [], ephemeral: true, skillCategory: 'test',
  };
}

describe('provider-error effect durability', () => {
  it('persists completed tool and media effects once without replaying the provider', async () => {
    const agent = makeAgent();
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

  it.each([
    ['unknown', 'call-unknown', 'unknown_result_identity'],
    ['malformed', ' malformed-result-id ', 'invalid_result_identity'],
  ])('persists %s result identity evidence once without fabricating a tool pair', async (_kind, resultId, reason) => {
    providerMocks.streamOllama.mockImplementationOnce(async function* () {
      yield {
        type: 'tool_call', name: 'email_send',
        args: { recipient: 'capture@example.test' }, toolCallId: 'call-known',
      };
      yield {
        type: 'tool_result', name: 'email_send',
        text: 'Message may have been accepted as msg-uncertain', toolCallId: resultId,
      };
    });
    const agent = makeAgent();
    const events = await collect(streamChat(
      agent, 'send exactly once', null, null, 'default',
      null, null, false, null, { readOnlyTurn: true },
    ));

    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(providerMocks.streamOllama).toHaveBeenCalledOnce();
    expect(sessionMocks.appendToSession).toHaveBeenCalledOnce();
    const [sessionKey, userRow, assistantRow] = sessionMocks.appendToSession.mock.calls[0];
    expect(sessionKey).toBe(agent.id);
    expect(assistantRow).toMatchObject({
      role: 'assistant',
      content: expect.stringMatching(/may already have completed[\s\S]*Do not automatically retry/i),
      toolIdentityAnomalies: [expect.objectContaining({
        kind: 'tool_result_identity_anomaly', name: 'email_send', reason,
      })],
      toolEvents: [expect.objectContaining({
        name: 'email_send', toolCallId: 'call-known', status: 'running',
      })],
    });
    expect(assistantRow).not.toHaveProperty('toolsUsed');
    expect(assistantRow).not.toHaveProperty('toolResults');
    expect(assistantRow.toolEvents[0]).not.toHaveProperty('resultIndex');

    const history = buildLlmHistory([userRow, assistantRow]);
    expect(history.some(row => Array.isArray(row.tool_calls))).toBe(false);
    expect(history.some(row => row.role === 'tool')).toBe(false);
    expect(JSON.stringify(history)).not.toContain('msg-uncertain');
    expect(JSON.stringify(history)).toMatch(/may already have completed/);

    const errorTrace = runInspectorMocks.recordRunTrace.mock.calls
      .map(([, trace]) => trace)
      .find(trace => trace?.status === 'error');
    expect(errorTrace).toMatchObject({
      error: expect.stringMatching(/Do not automatically retry/i),
      tools: {
        identityAnomalies: [expect.objectContaining({
          kind: 'tool_result_identity_anomaly', name: 'email_send', reason,
        })],
      },
    });
  });

  it('persists one verified result and quarantines a duplicate without reconstructing it', async () => {
    providerMocks.streamOllama.mockImplementationOnce(async function* () {
      yield {
        type: 'tool_call', name: 'email_send',
        args: { recipient: 'capture@example.test' }, toolCallId: 'call-once',
      };
      yield {
        type: 'tool_result', name: 'email_send',
        text: 'Message accepted as msg-first', toolCallId: 'call-once',
      };
      yield {
        type: 'tool_result', name: 'email_send',
        text: 'duplicate completion evidence', toolCallId: 'call-once',
      };
    });
    const agent = makeAgent();
    await collect(streamChat(
      agent, 'send exactly once', null, null, 'default',
      null, null, false, null, { readOnlyTurn: true },
    ));

    expect(sessionMocks.appendToSession).toHaveBeenCalledOnce();
    const [, userRow, assistantRow] = sessionMocks.appendToSession.mock.calls[0];
    expect(assistantRow.toolResults).toEqual([{
      name: 'email_send', text: 'Message accepted as msg-first', toolCallId: 'call-once',
    }]);
    expect(assistantRow.toolIdentityAnomalies).toEqual([
      expect.objectContaining({
        reason: 'duplicate_result_identity', toolCallId: 'call-once',
        resultPreview: 'duplicate completion evidence',
      }),
    ]);

    const history = buildLlmHistory([userRow, assistantRow]);
    expect(history.flatMap(row => row.tool_calls || [])).toHaveLength(1);
    expect(history.filter(row => row.role === 'tool')).toEqual([
      expect.objectContaining({ content: 'Message accepted as msg-first' }),
    ]);
    expect(JSON.stringify(history)).not.toContain('duplicate completion evidence');
  });
});
