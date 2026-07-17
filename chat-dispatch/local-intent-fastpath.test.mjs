import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendToSession: vi.fn(),
  failPendingTurn: vi.fn(),
  localTierEnabled: vi.fn(),
  dispatch: vi.fn(),
  runIntent: vi.fn(),
  recordToolObservation: vi.fn(),
  recordToolInvocations: vi.fn(),
}));

vi.mock('../sessions.mjs', () => ({
  appendToSession: mocks.appendToSession,
  failPendingTurn: mocks.failPendingTurn,
}));

vi.mock('../lib/local-label.mjs', () => ({
  localTierEnabled: mocks.localTierEnabled,
  dispatch: mocks.dispatch,
  runIntent: mocks.runIntent,
}));

vi.mock('../lib/personalization/recorder.mjs', () => ({
  recordToolObservation: mocks.recordToolObservation,
}));

vi.mock('../lib/skill-telemetry.mjs', () => ({
  recordToolInvocations: mocks.recordToolInvocations,
}));

const { tryLocalIntentFastpath } = await import('./local-intent-fastpath.mjs');

const MATCH = Object.freeze({
  skillId: 'localweather',
  intentId: 'get_weather_fast',
  tool: 'localweather_get_weather',
  args: {},
  confirm: false,
  via: 'embedding',
});

beforeEach(() => {
  mocks.appendToSession.mockReset().mockResolvedValue(undefined);
  mocks.failPendingTurn.mockReset().mockResolvedValue(undefined);
  mocks.localTierEnabled.mockReset().mockReturnValue(true);
  mocks.dispatch.mockReset().mockResolvedValue({ ...MATCH });
  mocks.runIntent.mockReset().mockResolvedValue('Weather for Cape Coral: clear, 89°F.');
  mocks.recordToolObservation.mockReset();
  mocks.recordToolInvocations.mockReset();
});

describe('local-intent fast-path telemetry and trace', () => {
  it('records the completed custom-skill invocation and returns exact tool evidence', async () => {
    const onEvent = vi.fn();
    const result = await tryLocalIntentFastpath({
      userText: "What's the weather?",
      userId: 'user_test',
      agentId: 'jarvis',
      onEvent,
    });

    expect(result).toMatchObject({
      handled: true,
      trace: {
        name: 'localweather_get_weather',
        args: {},
        result: 'Weather for Cape Coral: clear, 89°F.',
        status: 'done',
        durationMs: expect.any(Number),
      },
    });
    expect(mocks.appendToSession).toHaveBeenCalledOnce();
    expect(mocks.recordToolInvocations).toHaveBeenCalledExactlyOnceWith({
      userId: 'user_test',
      toolsUsed: [{
        name: 'localweather_get_weather',
        args: {},
        text: 'Weather for Cape Coral: clear, 89°F.',
      }],
    });
    expect(mocks.recordToolObservation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      userId: 'user_test',
      agentId: 'jarvis',
      toolName: 'localweather_get_weather',
      skillId: 'localweather',
      ok: true,
    }));
    expect(mocks.appendToSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.recordToolInvocations.mock.invocationCallOrder[0]);
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['token', 'done']);
  });

  it('counts a completed error result but keeps it out of personalization observations', async () => {
    mocks.runIntent.mockResolvedValueOnce('Error: weather service unavailable');

    const result = await tryLocalIntentFastpath({
      userText: "What's the weather?",
      userId: 'user_test',
      agentId: 'jarvis',
      onEvent: vi.fn(),
    });

    expect(result).toMatchObject({
      handled: true,
      trace: { name: 'localweather_get_weather', status: 'error' },
    });
    expect(mocks.recordToolInvocations).toHaveBeenCalledOnce();
    expect(mocks.recordToolObservation).not.toHaveBeenCalled();
  });

  it('does not record an invocation when dispatch does not complete a handled tool', async () => {
    mocks.dispatch.mockResolvedValueOnce(null);
    expect(await tryLocalIntentFastpath({
      userText: "What's the weather?", userId: 'user_test', agentId: 'jarvis', onEvent: vi.fn(),
    })).toBeNull();

    mocks.dispatch.mockResolvedValueOnce({ ...MATCH, confirm: true });
    expect(await tryLocalIntentFastpath({
      userText: "What's the weather?", userId: 'user_test', agentId: 'jarvis', onEvent: vi.fn(),
    })).toBeNull();

    mocks.dispatch.mockResolvedValueOnce({ ...MATCH });
    mocks.runIntent.mockRejectedValueOnce(new Error('lookup crashed'));
    expect(await tryLocalIntentFastpath({
      userText: "What's the weather?", userId: 'user_test', agentId: 'jarvis', onEvent: vi.fn(),
    })).toBeNull();

    expect(mocks.recordToolInvocations).not.toHaveBeenCalled();
  });

  it('retains trace evidence but skips telemetry when session persistence fails', async () => {
    mocks.appendToSession.mockRejectedValueOnce(new Error('disk full'));
    const onEvent = vi.fn();

    const result = await tryLocalIntentFastpath({
      userText: "What's the weather?",
      userId: 'user_test',
      agentId: 'jarvis',
      onEvent,
    });

    expect(result).toMatchObject({
      handled: true,
      trace: { name: 'localweather_get_weather', status: 'done' },
    });
    expect(mocks.recordToolInvocations).not.toHaveBeenCalled();
    expect(mocks.failPendingTurn).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'error', code: 'persistence_failed', retryable: false,
    }));
  });
});
