import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(async function* () {
    yield { type: 'token', text: 'routed reply' };
    yield { type: 'done' };
  }),
  appendToSession: vi.fn(async () => {}),
  logRoutingFire: vi.fn(async () => {}),
  buildContextHints: vi.fn(async () => ({ hints: '<resolved />', resolutions: [] })),
  captureFromTurn: vi.fn(async () => {}),
  recordActivity: vi.fn(),
  recordRouting: vi.fn(),
  runWithTurnContext: vi.fn(async (_ctx, fn) => fn()),
}));

vi.mock('./chat.mjs', () => ({ streamChat: mocks.streamChat }));
vi.mock('./sessions.mjs', () => ({
  appendToSession: mocks.appendToSession,
  loadSession: vi.fn(async () => []),
  failPendingTurn: vi.fn(async () => true),
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
  loadConfig: vi.fn(() => ({})),
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

const { runSpecialistRoute } = await import('./chat-dispatch/llm-loop.mjs');

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
});
