import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(async function* () {
    yield { type: 'token', text: 'routed reply' };
    yield { type: 'done' };
  }),
  appendToSession: vi.fn(async () => {}),
  failPendingTurn: vi.fn(async () => true),
  logRoutingFire: vi.fn(async () => {}),
  buildContextHints: vi.fn(async () => ({ hints: '<resolved />', resolutions: [] })),
  captureFromTurn: vi.fn(async () => {}),
  recordActivity: vi.fn(),
  recordRouting: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  runWithTurnContext: vi.fn(async (_ctx, fn) => fn()),
}));

vi.mock('./chat.mjs', () => ({ streamChat: mocks.streamChat }));
vi.mock('./sessions.mjs', () => ({
  appendToSession: mocks.appendToSession,
  loadSession: vi.fn(async () => []),
  failPendingTurn: mocks.failPendingTurn,
}));
vi.mock('./roles.mjs', () => ({
  getRoleAssignments: vi.fn(() => ({ coordinator: 'coordinator-agent' })),
  listRoles: vi.fn(() => []),
  getRoleTools: vi.fn(() => []),
}));
vi.mock('./lib/routing-overrides.mjs', () => ({
  matchOverride: vi.fn(() => ({
    id: 'override-1', forcedAgent: 'email-agent', pattern: 'captured email',
  })),
  logFire: mocks.logRoutingFire,
}));
vi.mock('./routes/_helpers.mjs', () => ({
  loadConfig: mocks.loadConfig,
  getAgentsForUser: vi.fn(() => [{
    id: 'email-agent', name: 'Email Specialist', provider: 'ollama', model: 'test',
    systemPrompt: 'email specialist', tools: [],
  }]),
  recordActivity: mocks.recordActivity,
  recordTokenUsage: vi.fn(),
}));
vi.mock('./lib/scheduler-intent.mjs', () => ({
  interceptScheduling: vi.fn(async () => ({ matched: false })),
}));
vi.mock('./ws-handler.mjs', () => ({ armFollowupAfterDrain: vi.fn() }));
vi.mock('./lib/turn-abort-context.mjs', () => ({
  runWithTurnContext: mocks.runWithTurnContext,
}));
vi.mock('./logger.mjs', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./chat-dispatch/slash-commands.mjs', () => ({ getSpecialistTrim: vi.fn(() => true) }));
vi.mock('./lib/voice-context.mjs', () => ({ buildVoiceSystemAddition: vi.fn(() => '') }));
vi.mock('./lib/turn-trace-context.mjs', () => ({
  getTurn: vi.fn(() => null),
  recordRouting: mocks.recordRouting,
}));
vi.mock('./lib/context-resolvers.mjs', () => ({
  buildContextHints: mocks.buildContextHints,
}));
vi.mock('./lib/intent-learner.mjs', () => ({
  captureFromTurn: mocks.captureFromTurn,
}));

const { runLlmTurn, runSpecialistRoute } = await import('./chat-dispatch/llm-loop.mjs');

describe('lab verifier specialist non-learning contract', () => {
  afterEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
  });

  it('keeps specialist routing and persistence while suppressing route, alias, and intent learning', async () => {
    const events = [];
    const result = await runSpecialistRoute({
      userText: 'Show my captured email.',
      userId: 'lab-user',
      agentId: 'coordinator-agent',
      source: 'web',
      deviceId: null,
      attachment: null,
      attachments: [],
      toolPlan: { mode: 'auto', source: 'lab-verifier', maxProviderRequests: 2 },
      ac: new AbortController(),
      onEvent: event => events.push(event),
      onNotify: vi.fn(),
      suppressLearning: true,
      verifierAllowedTools: ['email_list'],
      verifierLeaseRequired: true,
      verifierLeaseToken: 'a'.repeat(64),
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(result).toEqual({ handled: true });
    expect(mocks.streamChat).toHaveBeenCalledOnce();
    expect(mocks.runWithTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressLearning: true,
        verifierAllowedTools: ['email_list'],
        verifierLeaseRequired: true,
        verifierLeaseToken: 'a'.repeat(64),
      }),
      expect.any(Function),
    );
    expect(mocks.appendToSession).toHaveBeenCalledOnce();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'token', text: 'routed reply', agent: 'coordinator-agent' }),
      expect.objectContaining({ type: 'done', agent: 'coordinator-agent' }),
    ]));
    expect(mocks.buildContextHints).toHaveBeenCalledWith(
      'lab-user',
      'Show my captured email.',
      { suppressLearning: true },
    );
    expect(mocks.logRoutingFire).not.toHaveBeenCalled();
    expect(mocks.captureFromTurn).not.toHaveBeenCalled();
  });

  it('drains a yielded terminal error so streamChat can persist its failed-turn trace', async () => {
    let finalizedAfterError = false;
    const onNotify = vi.fn();
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'tool_call', name: 'generate_image', args: { prompt: 'test' } };
      yield { type: 'error', message: 'tool-loop request budget ended', retryable: false };
      yield { type: '__usage', inputTokens: 12, outputTokens: 3, provider: 'test', model: 'test-model' };
      yield { type: '__notify', message: 'must stay internal' };
      yield { type: 'tool_call', name: 'email_user', args: { subject: 'must not run' } };
      yield { type: 'token', text: 'must not escape' };
      yield { type: 'done' };
      finalizedAfterError = true;
    });
    const events = [];
    await runLlmTurn({
      userId: 'lab-user',
      agentId: 'coordinator-agent',
      scopedAgent: {
        id: 'coordinator-agent', name: 'Coordinator', provider: 'openai-oauth',
        model: 'test-model', tools: [],
      },
      scopedSessionKey: 'lab-user_coordinator-agent',
      userText: 'generate an image',
      toolPlan: { mode: 'auto', source: 'lab-verifier', maxProviderRequests: 3 },
      schedulerNote: '',
      source: 'web',
      deviceId: null,
      ac: new AbortController(),
      onEvent: event => events.push(event),
      onNotify,
      suppressLearning: true,
      verifierAllowedTools: ['generate_image'],
      verifierLeaseRequired: true,
      verifierLeaseToken: 'b'.repeat(64),
    });

    expect(finalizedAfterError).toBe(true);
    expect(onNotify).not.toHaveBeenCalled();
    expect(mocks.failPendingTurn).toHaveBeenCalledOnce();
    expect(mocks.failPendingTurn).toHaveBeenCalledWith(
      'lab-user_coordinator-agent',
      'tool-loop request budget ended',
      expect.objectContaining({ status: 'failed', retryable: false }),
    );
    expect(events.filter(event => event.type === 'error')).toEqual([
      expect.objectContaining({
        message: 'tool-loop request budget ended', code: 'turn_failed', retryable: false,
      }),
    ]);
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'email_user' }),
      expect.objectContaining({ text: 'must not escape' }),
      expect.objectContaining({ type: 'done' }),
    ]));
  });

  it('preserves no-tool provider failover while draining a retriable primary error', async () => {
    let primaryFinalized = false;
    const onNotify = vi.fn();
    mocks.loadConfig.mockReturnValueOnce({
      providerFailover: {
        enabled: true,
        fallbackProvider: 'fallback-provider',
        fallbackModel: 'fallback-model',
      },
    });
    mocks.streamChat
      .mockImplementationOnce(async function* () {
        yield { type: 'error', message: 'provider timeout', retryable: true };
        yield { type: '__notify', message: 'must stay internal' };
        yield { type: 'tool_call', name: 'email_user', args: { subject: 'must not run' } };
        yield { type: 'token', text: 'must not escape' };
        yield { type: 'done' };
        primaryFinalized = true;
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'token', text: 'fallback reply' };
        yield { type: 'done' };
      });
    const events = [];

    await runLlmTurn({
      userId: 'lab-user',
      agentId: 'coordinator-agent',
      scopedAgent: {
        id: 'coordinator-agent', name: 'Coordinator', provider: 'primary-provider',
        model: 'primary-model', tools: [],
      },
      scopedSessionKey: 'lab-user_coordinator-agent',
      userText: 'retry this request',
      toolPlan: { mode: 'auto', source: 'lab-verifier', maxProviderRequests: 2 },
      schedulerNote: '',
      source: 'web',
      deviceId: null,
      ac: new AbortController(),
      onEvent: event => events.push(event),
      onNotify,
      suppressLearning: true,
    });

    expect(primaryFinalized).toBe(true);
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    expect(mocks.streamChat.mock.calls[1][0]).toEqual(expect.objectContaining({
      provider: 'fallback-provider', model: 'fallback-model',
    }));
    expect(onNotify).not.toHaveBeenCalled();
    expect(mocks.failPendingTurn).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'token', text: 'fallback reply' }),
      expect.objectContaining({ type: 'done' }),
    ]));
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'email_user' }),
      expect.objectContaining({ text: 'must not escape' }),
    ]));
  });
});
