import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const pending = { expenses: null, email: null, profiles: null, tasks: null };
  const clear = {};
  const run = {};
  for (const family of Object.keys(pending)) {
    clear[family] = vi.fn((_userId, _agentId, expectedOpId = null) => {
      const current = pending[family];
      if (!current) return false;
      if (expectedOpId && current.opId !== expectedOpId) return false;
      pending[family] = null;
      return true;
    });
    run[family] = vi.fn(async () => 'EXECUTED');
  }
  return {
    pending, clear, run,
    runtimeEnabled: vi.fn(),
    automationAllowed: vi.fn(),
    appendToSession: vi.fn(),
    failPendingTurn: vi.fn(),
  };
});

vi.mock('../sessions.mjs', () => ({
  appendToSession: fixtures.appendToSession,
  failPendingTurn: fixtures.failPendingTurn,
}));

vi.mock('../lib/voice-timer.mjs', () => ({
  classifyTimerIntent: vi.fn(), createVoiceTimer: vi.fn(),
  classifyTimerCancelIntent: vi.fn(), cancelVoiceTimer: vi.fn(),
  classifyTimerExtendIntent: vi.fn(), extendVoiceTimer: vi.fn(),
  resolveTimerDisambig: vi.fn(), hasPendingDisambig: vi.fn(),
  DISAMBIG_TTL_MS: 60_000,
}));
vi.mock('../ws-handler.mjs', () => ({ sendToDevice: vi.fn() }));
vi.mock('../lib/voice-devices.mjs', () => ({ updateDevice: vi.fn() }));
vi.mock('../lib/alarms.mjs', () => ({ broadcastAlarmStop: vi.fn(), hasActiveAlarms: vi.fn() }));
vi.mock('./slot-registry.mjs', () => ({ abortChat: vi.fn() }));
vi.mock('../lib/ambient-playback.mjs', () => ({ stopAmbientOnDevice: vi.fn() }));
vi.mock('../routes/devices.mjs', () => ({ getAmbientForDevice: vi.fn() }));

vi.mock('../skills/expenses/execute.mjs', () => ({
  getPendingDelete: () => fixtures.pending.expenses,
  clearPendingDelete: fixtures.clear.expenses,
  executePendingDelete: fixtures.run.expenses,
}));
vi.mock('../skills/email/execute.mjs', () => ({
  getPendingEmail: () => fixtures.pending.email,
  clearPendingEmail: fixtures.clear.email,
  executePendingEmail: fixtures.run.email,
}));
vi.mock('../skills/profiles/execute.mjs', () => ({
  getPendingProven: () => fixtures.pending.profiles,
  clearPendingProven: fixtures.clear.profiles,
  executePendingProven: fixtures.run.profiles,
}));
vi.mock('../skills/tasks/execute.mjs', () => ({
  getPendingWatcherOp: () => fixtures.pending.tasks,
  clearPendingWatcherOp: fixtures.clear.tasks,
  executePendingWatcherOp: fixtures.run.tasks,
}));

vi.mock('../roles.mjs', () => ({
  isSkillRuntimeEnabledForUser: fixtures.runtimeEnabled,
}));
vi.mock('../lib/skill-overrides.mjs', () => ({
  assertSkillToolAutomationAllowed: fixtures.automationAllowed,
}));

import { tryApprovalIntercept } from './voice-preprocess.mjs';

const USER_ID = 'approval_auth_user';
const AGENT_ID = 'coordinator';
const CASES = [
  ['expenses', 'CONFIRM DELETION', 'expenses', 'expense_delete',       { name: 'expense_delete' }],
  ['expenses', 'CONFIRM DELETION', 'expenses', 'expense_delete_batch', { name: 'expense_delete_batch' }],
  ['expenses', 'CONFIRM DELETION', 'expenses', 'expense_delete_all',  { name: 'expense_delete_all' }],
  ['email',    'APPROVE PURGE',    'email',    'email_purge_sender',  { name: 'email_purge_sender' }],
  ['email',    'APPROVE PURGE',    'email',    'email_batch_trash',   { name: 'email_batch_trash' }],
  ['profiles', 'APPROVE PROVEN',   'profiles', 'profile_set_trust_state', {}],
  ['tasks',    'APPROVE WATCHER OP', 'tasks',  'cancel_watch',        { action: 'cancel' }],
  ['tasks',    'APPROVE WATCHER OP', 'tasks',  'update_watch',        { action: 'update' }],
];

function stage(family, shape, opId = `op_${family}`) {
  fixtures.pending[family] = { ...shape, opId };
  return opId;
}

async function approve(phrase, opId) {
  const onEvent = vi.fn();
  const result = await tryApprovalIntercept({
    userText: `${phrase} #${opId}`,
    userId: USER_ID,
    agentId: AGENT_ID,
    onEvent,
  });
  return { result, onEvent };
}

describe('staged approval authorization revalidation', () => {
  beforeEach(() => {
    for (const family of Object.keys(fixtures.pending)) fixtures.pending[family] = null;
    vi.clearAllMocks();
    fixtures.runtimeEnabled.mockReturnValue(true);
    fixtures.automationAllowed.mockReturnValue(true);
    fixtures.appendToSession.mockResolvedValue(undefined);
    fixtures.failPendingTurn.mockResolvedValue(undefined);
  });

  it.each(CASES)(
    'consumes %s approval without executing when the skill grant was revoked',
    async (family, phrase, skillId, toolName, pendingShape) => {
      const opId = stage(family, pendingShape);
      fixtures.runtimeEnabled.mockReturnValue(false);

      const { result, onEvent } = await approve(phrase, opId);

      expect(result).toEqual({ handled: true });
      expect(fixtures.runtimeEnabled).toHaveBeenCalledWith(skillId, USER_ID);
      expect(fixtures.automationAllowed).not.toHaveBeenCalled();
      expect(fixtures.clear[family]).toHaveBeenCalledWith(USER_ID, AGENT_ID, opId);
      expect(fixtures.run[family]).not.toHaveBeenCalled();
      expect(fixtures.pending[family]).toBeNull();
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'token', text: expect.stringContaining(`"${toolName}" is no longer permitted`),
      }));
    },
  );

  it.each(CASES)(
    'maps %s staged action to its exact tool-level override before execution',
    async (family, phrase, skillId, toolName, pendingShape) => {
      const opId = stage(family, pendingShape);
      fixtures.automationAllowed.mockReturnValue(false);

      await approve(phrase, opId);

      expect(fixtures.automationAllowed).toHaveBeenCalledWith(USER_ID, skillId, toolName);
      expect(fixtures.clear[family]).toHaveBeenCalledWith(USER_ID, AGENT_ID, opId);
      expect(fixtures.run[family]).not.toHaveBeenCalled();
      expect(fixtures.pending[family]).toBeNull();
    },
  );

  it.each(CASES)(
    'executes authorized %s staged action after both current checks pass',
    async (family, phrase, skillId, toolName, pendingShape) => {
      const opId = stage(family, pendingShape);

      const { onEvent } = await approve(phrase, opId);

      expect(fixtures.runtimeEnabled).toHaveBeenCalledWith(skillId, USER_ID);
      expect(fixtures.automationAllowed).toHaveBeenCalledWith(USER_ID, skillId, toolName);
      expect(fixtures.run[family]).toHaveBeenCalledWith(USER_ID, AGENT_ID, opId);
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'token', text: 'EXECUTED' }));
    },
  );

  it('does not clear a replacement approval staged during the authorization check', async () => {
    const oldId = stage('email', { name: 'email_purge_sender' }, 'old_op');
    fixtures.automationAllowed.mockImplementation(() => {
      fixtures.pending.email = { name: 'email_batch_trash', opId: 'new_op' };
      return false;
    });

    const { onEvent } = await approve('APPROVE PURGE', oldId);

    expect(fixtures.clear.email).toHaveBeenCalledWith(USER_ID, AGENT_ID, oldId);
    expect(fixtures.run.email).not.toHaveBeenCalled();
    expect(fixtures.pending.email).toEqual({ name: 'email_batch_trash', opId: 'new_op' });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'token', text: expect.stringContaining('approval changed'),
    }));
  });

  it('fails closed and consumes a malformed staged action', async () => {
    const opId = stage('tasks', { action: 'unexpected' }, 'bad_op');

    await approve('APPROVE WATCHER OP', opId);

    expect(fixtures.runtimeEnabled).not.toHaveBeenCalled();
    expect(fixtures.run.tasks).not.toHaveBeenCalled();
    expect(fixtures.clear.tasks).toHaveBeenCalledWith(USER_ID, AGENT_ID, opId);
    expect(fixtures.pending.tasks).toBeNull();
  });
});
