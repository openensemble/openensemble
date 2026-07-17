import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => ({
  validate: vi.fn(async () => ({ ok: true, reason: 'available', status: 200 })),
}));

vi.mock('./execution-model-policy.mjs', () => ({
  validateExecutionModelAccess: policy.validate,
}));

import { USERS_DIR } from './paths.mjs';
import { setSkillExecutionOverride } from './skill-overrides.mjs';
import { resolveValidatedSkillExecutionForTurn } from './skill-execution.mjs';

const createdUsers = [];
const baseAgent = {
  id: 'coordinator', provider: 'openai-oauth', model: 'base-model', reasoningEffort: 'low',
};

function makeUser() {
  const userId = `execution_runtime_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const dir = path.join(USERS_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ id: userId, role: 'owner' }));
  createdUsers.push(userId);
  return userId;
}

afterEach(() => {
  policy.validate.mockReset().mockResolvedValue({ ok: true, reason: 'available', status: 200 });
  for (const userId of createdUsers.splice(0)) {
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
});

describe('runtime execution-profile authorization', () => {
  it('fails closed when a once-valid provider grant has been revoked', async () => {
    const userId = makeUser();
    await setSkillExecutionOverride(userId, 'deep_research', {
      provider: 'openai-oauth', model: 'gpt-saved', reasoningEffort: 'high',
    });
    policy.validate.mockResolvedValue({
      ok: false, reason: 'oauth-provider-not-allowed', status: 403, error: 'grant revoked',
    });

    const result = await resolveValidatedSkillExecutionForTurn({
      userId, baseAgent, selectedSkillIds: ['deep_research'],
    });

    expect(result.applied).toBe(false);
    expect(result.effective).toEqual({
      provider: 'openai-oauth', model: 'base-model', reasoningEffort: 'low',
    });
    expect(result.contenders).toEqual([expect.objectContaining({
      skillId: 'deep_research', eligible: false, reason: 'oauth-provider-not-allowed',
    })]);
  });

  it('rechecks access on every resolution instead of trusting the saved profile', async () => {
    const userId = makeUser();
    await setSkillExecutionOverride(userId, 'coder', {
      provider: 'anthropic', model: 'claude-saved', reasoningEffort: 'high',
    });

    const first = await resolveValidatedSkillExecutionForTurn({
      userId, baseAgent, selectedSkillIds: ['coder'],
    });
    policy.validate.mockResolvedValue({
      ok: false, reason: 'provider-disabled', status: 400, error: 'disabled',
    });
    const replay = await resolveValidatedSkillExecutionForTurn({
      userId, baseAgent, selectedSkillIds: ['coder'],
    });

    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(policy.validate).toHaveBeenCalledTimes(2);
  });

  it('rejects even effort-only saved state after its user is deleted', async () => {
    const userId = makeUser();
    await setSkillExecutionOverride(userId, 'email', { reasoningEffort: 'high' });
    fs.rmSync(path.join(USERS_DIR, userId, 'profile.json'), { force: true });

    const result = await resolveValidatedSkillExecutionForTurn({
      userId, baseAgent, selectedSkillIds: ['email'],
    });

    expect(result).toMatchObject({ applied: false, reason: 'user-not-found' });
    expect(policy.validate).not.toHaveBeenCalled();
  });
});
