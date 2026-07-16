import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendToSession: vi.fn(),
  failPendingTurn: vi.fn(),
  haRequest: vi.fn(),
  runtimeEnabled: vi.fn(),
}));

vi.mock('../sessions.mjs', () => ({
  appendToSession: mocks.appendToSession,
  failPendingTurn: mocks.failPendingTurn,
}));
vi.mock('../lib/routines.mjs', () => ({
  classifyRoutineIntent: vi.fn(), executeRoutine: vi.fn(),
  resolveRoutineDeviceId: vi.fn(), runDeferredAmbient: vi.fn(),
}));
vi.mock('../lib/voice-reminder.mjs', () => ({ speakRoutineTts: vi.fn() }));
vi.mock('../roles.mjs', () => ({
  isSkillRuntimeEnabledForUser: mocks.runtimeEnabled,
}));
vi.mock('../lib/ha-aliases.mjs', () => ({
  resolveAlias: vi.fn(() => 'light.kitchen_group'),
}));
vi.mock('../lib/ha-cache.mjs', () => ({
  ensureCache: vi.fn(async () => new Map([['kitchen', {
    entity_id: 'light.kitchen_group', friendly_name: 'Kitchen',
  }]])),
  lookupEntity: vi.fn(),
}));
vi.mock('../lib/ha-client.mjs', () => ({
  getHaConfig: vi.fn(() => ({ url: 'http://test-ha.invalid', token: 'not-used' })),
  haRequest: mocks.haRequest,
}));
vi.mock('../lib/skill-overrides.mjs', () => ({
  getHiddenTools: vi.fn(() => []),
}));

import { tryHaFastpath } from './fastpaths.mjs';

describe('Home Assistant fast-path trace evidence', () => {
  beforeEach(() => {
    mocks.appendToSession.mockReset().mockResolvedValue(undefined);
    mocks.failPendingTurn.mockReset().mockResolvedValue(undefined);
    mocks.haRequest.mockReset().mockResolvedValue([]);
    mocks.runtimeEnabled.mockReset().mockReturnValue(true);
  });

  it('returns the exact executed HA action while making zero model calls', async () => {
    const events = [];
    const result = await tryHaFastpath({
      userText: 'turn off kitchen', userId: 'user_test', agentId: 'jarvis',
      onEvent: event => events.push(event),
    });

    expect(mocks.haRequest).toHaveBeenCalledWith(
      expect.anything(), '/services/homeassistant/turn_off', 'POST',
      { entity_id: 'light.kitchen_group' },
    );
    expect(result).toMatchObject({
      handled: true,
      trace: {
        name: 'ha_call_service', status: 'done', result: 'Kitchen off.',
        args: {
          service: 'turn_off', entity_id: 'light.kitchen_group', domain: 'homeassistant',
        },
      },
    });
    expect(result.trace.durationMs).toEqual(expect.any(Number));
    expect(events).toEqual([
      { type: 'token', text: 'Kitchen off.', agent: 'jarvis' },
      { type: 'done', agent: 'jarvis' },
    ]);
  });

  it('retains action evidence when persistence fails after dispatch', async () => {
    mocks.appendToSession.mockRejectedValueOnce(new Error('disk full'));
    const events = [];
    const result = await tryHaFastpath({
      userText: 'turn off kitchen', userId: 'user_test', agentId: 'jarvis',
      onEvent: event => events.push(event),
    });

    expect(mocks.haRequest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ handled: true, trace: { name: 'ha_call_service' } });
    expect(events).toEqual([expect.objectContaining({
      type: 'error', code: 'persistence_failed', retryable: false,
    })]);
  });
});
