import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { USERS_DIR } from './paths.mjs';
import {
  getSkillExecutionOverride,
  listSkillOverrides,
  setSkillExecutionOverride,
  setSkillOverride,
} from './skill-overrides.mjs';
import { isExecutionTextModel, resolveSkillExecutionForTurn } from './skill-execution.mjs';

const createdUsers = [];

function uniqueUser() {
  const userId = `skill_execution_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  createdUsers.push(userId);
  return userId;
}

const baselineAgent = () => ({
  id: 'jarvis',
  provider: 'openai-oauth',
  model: 'gpt-5.4-mini',
  reasoningEffort: 'low',
  tools: [{ function: { name: 'keep_me' } }],
});

afterEach(() => {
  for (const userId of createdUsers.splice(0)) {
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
});

describe('skill execution override storage', () => {
  it('stores an atomic provider/model pair without disturbing disabled or hidden-tool preferences', async () => {
    const userId = uniqueUser();
    await setSkillOverride(userId, 'coder', { disabled: true, hiddenTools: ['coder_delete_file'] });
    const result = await setSkillExecutionOverride(userId, 'coder', {
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'AUTO',
    });

    expect(result).toMatchObject({ ok: true });
    expect(getSkillExecutionOverride(userId, 'coder')).toEqual({
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'auto',
    });
    expect(listSkillOverrides(userId)).toEqual([{
      skillId: 'coder', disabled: true, hiddenTools: ['coder_delete_file'],
      execution: { provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'auto' },
    }]);

    await setSkillExecutionOverride(userId, 'coder', null);
    expect(getSkillExecutionOverride(userId, 'coder')).toBeNull();
    expect(listSkillOverrides(userId)[0]).toMatchObject({
      skillId: 'coder', disabled: true, hiddenTools: ['coder_delete_file'], execution: null,
    });
  });

  it('rejects a partial pair without clobbering the prior execution override', async () => {
    const userId = uniqueUser();
    await setSkillExecutionOverride(userId, 'coder', {
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
    const result = await setSkillExecutionOverride(userId, 'coder', { model: 'gpt-other' });
    expect(result.ok).toBe(false);
    expect(getSkillExecutionOverride(userId, 'coder')).toEqual({
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
  });

  it('stores an effort-only override while rejecting an empty execution object', async () => {
    const userId = uniqueUser();
    const stored = await setSkillExecutionOverride(userId, 'email', { reasoningEffort: 'medium' });
    expect(stored).toMatchObject({
      ok: true,
      override: { execution: { reasoningEffort: 'medium' } },
    });
    expect(getSkillExecutionOverride(userId, 'email')).toEqual({ reasoningEffort: 'medium' });
    expect(listSkillOverrides(userId)).toEqual([{
      skillId: 'email', disabled: false, hiddenTools: [],
      execution: { reasoningEffort: 'medium' },
    }]);

    const empty = await setSkillExecutionOverride(userId, 'email', {});
    expect(empty.ok).toBe(false);
    expect(getSkillExecutionOverride(userId, 'email')).toEqual({ reasoningEffort: 'medium' });
  });
});

describe('turn-level skill execution resolution', () => {
  it('keeps the baseline when no matched skill ids are selected and never mutates the agent', async () => {
    const userId = uniqueUser();
    await setSkillExecutionOverride(userId, 'coder', {
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
    const agent = baselineAgent();
    const snapshot = structuredClone(agent);

    const result = resolveSkillExecutionForTurn({ userId, baseAgent: agent, selectedSkillIds: [] });

    expect(result).toMatchObject({
      baseline: { provider: 'openai-oauth', model: 'gpt-5.4-mini', reasoningEffort: 'low' },
      effective: { provider: 'openai-oauth', model: 'gpt-5.4-mini', reasoningEffort: 'low' },
      sourceSkillIds: { model: null, reasoningEffort: null },
      contenders: [], reason: 'no-selected-skills', applied: false,
    });
    expect(agent).toEqual(snapshot);
    expect(result.effective).not.toBe(agent);
  });

  it('applies only the selected coder override', async () => {
    const userId = uniqueUser();
    await setSkillExecutionOverride(userId, 'coder', {
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
    await setSkillExecutionOverride(userId, 'email', {
      provider: 'anthropic', model: 'claude-sonnet', reasoningEffort: 'medium',
    });

    const result = resolveSkillExecutionForTurn({
      userId, baseAgent: baselineAgent(), selectedSkillIds: ['coder'],
      allowedModels: ['gpt-5.4-mini', 'gpt-5.6-sol', 'claude-sonnet'],
    });
    expect(result).toMatchObject({
      effective: { provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      sourceSkillIds: { model: 'coder', reasoningEffort: 'coder' },
      reason: 'selected-skill-execution', applied: true,
    });
    expect(result.contenders.map(candidate => candidate.skillId)).toEqual(['coder']);
  });

  it('applies email without considering an unselected coder override', async () => {
    const userId = uniqueUser();
    await setSkillExecutionOverride(userId, 'coder', {
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
    await setSkillExecutionOverride(userId, 'email', {
      provider: 'anthropic', model: 'claude-sonnet', reasoningEffort: 'medium',
    });

    const result = resolveSkillExecutionForTurn({
      userId, baseAgent: baselineAgent(), selectedSkillIds: ['email'],
    });
    expect(result.effective).toEqual({
      provider: 'anthropic', model: 'claude-sonnet', reasoningEffort: 'medium',
    });
    expect(result.contenders.map(candidate => candidate.skillId)).toEqual(['email']);
  });

  it('applies an effort-only override to the unchanged base provider/model', async () => {
    const userId = uniqueUser();
    await setSkillExecutionOverride(userId, 'email', { reasoningEffort: 'high' });

    const result = resolveSkillExecutionForTurn({
      userId, baseAgent: baselineAgent(), selectedSkillIds: ['email'],
    });
    expect(result).toMatchObject({
      baseline: { provider: 'openai-oauth', model: 'gpt-5.4-mini', reasoningEffort: 'low' },
      effective: { provider: 'openai-oauth', model: 'gpt-5.4-mini', reasoningEffort: 'high' },
      sourceSkillIds: { model: null, reasoningEffort: 'email' },
      reason: 'selected-skill-execution', applied: true,
      reasoningEffortInherited: false,
      contenders: [{ skillId: 'email', reasoningEffort: 'high', effortRank: 4, eligible: true }],
    });
  });

  it('keeps model competition among pair entries while merging stronger effort-only policy', async () => {
    const userId = uniqueUser();
    await setSkillExecutionOverride(userId, 'coder', {
      provider: 'openai-oauth', model: 'gpt-coder', reasoningEffort: 'low',
    });
    await setSkillExecutionOverride(userId, 'email', {
      provider: 'anthropic', model: 'claude-email', reasoningEffort: 'medium',
    });
    await setSkillExecutionOverride(userId, 'review-policy', { reasoningEffort: 'high' });

    const result = resolveSkillExecutionForTurn({
      userId, baseAgent: baselineAgent(),
      selectedSkillIds: ['coder', 'review-policy', 'email'],
    });
    expect(result.effective).toEqual({
      provider: 'anthropic', model: 'claude-email', reasoningEffort: 'high',
    });
    expect(result.sourceSkillIds).toEqual({ model: 'email', reasoningEffort: 'review-policy' });
    expect(result.contenders.map(candidate => [candidate.skillId, candidate.effortRank])).toEqual([
      ['coder', 1], ['review-policy', 4], ['email', 2],
    ]);
  });

  it('chooses the strongest explicit effort and breaks equal-rank ties by selected order', async () => {
    const userId = uniqueUser();
    await setSkillExecutionOverride(userId, 'coder', {
      provider: 'openai-oauth', model: 'gpt-coder', reasoningEffort: 'medium',
    });
    await setSkillExecutionOverride(userId, 'email', {
      provider: 'anthropic', model: 'claude-email', reasoningEffort: 'high',
    });
    await setSkillExecutionOverride(userId, 'calendar', {
      provider: 'openrouter', model: 'calendar-model', reasoningEffort: 'high',
    });

    const result = resolveSkillExecutionForTurn({
      userId, baseAgent: baselineAgent(), selectedSkillIds: ['coder', 'calendar', 'email'],
    });
    expect(result.effective).toEqual({
      provider: 'openrouter', model: 'calendar-model', reasoningEffort: 'high',
    });
    expect(result.sourceSkillIds).toEqual({ model: 'calendar', reasoningEffort: 'calendar' });
    expect(result.contenders.map(candidate => [candidate.skillId, candidate.effortRank])).toEqual([
      ['coder', 2], ['calendar', 4], ['email', 4],
    ]);
  });

  it('rejects disallowed model candidates as an atomic provider/model override', async () => {
    const userId = uniqueUser();
    await setSkillExecutionOverride(userId, 'coder', {
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });

    const result = resolveSkillExecutionForTurn({
      userId, baseAgent: baselineAgent(), selectedSkillIds: ['coder'],
      allowedModels: ['gpt-5.4-mini'],
    });
    expect(result).toMatchObject({
      effective: { provider: 'openai-oauth', model: 'gpt-5.4-mini', reasoningEffort: 'low' },
      sourceSkillIds: { model: null, reasoningEffort: null },
      reason: 'no-allowed-execution-overrides', applied: false,
      contenders: [{
        skillId: 'coder', provider: 'openai-oauth', model: 'gpt-5.6-sol',
        reasoningEffort: 'high', eligible: false, reason: 'model-not-allowed',
      }],
    });
  });

  it('preserves explicit auto, ranked above medium and below high rather than treating it as inheritance', async () => {
    const userId = uniqueUser();
    await setSkillExecutionOverride(userId, 'medium-skill', {
      provider: 'provider-medium', model: 'model-medium', reasoningEffort: 'medium',
    });
    await setSkillExecutionOverride(userId, 'auto-skill', {
      provider: 'provider-auto', model: 'model-auto', reasoningEffort: 'auto',
    });
    await setSkillExecutionOverride(userId, 'high-skill', {
      provider: 'provider-high', model: 'model-high', reasoningEffort: 'high',
    });

    const autoWins = resolveSkillExecutionForTurn({
      userId, baseAgent: baselineAgent(), selectedSkillIds: ['medium-skill', 'auto-skill'],
    });
    expect(autoWins).toMatchObject({
      effective: { provider: 'provider-auto', model: 'model-auto', reasoningEffort: 'auto' },
      sourceSkillIds: { model: 'auto-skill', reasoningEffort: 'auto-skill' },
      reasoningEffortInherited: false,
    });

    const highWins = resolveSkillExecutionForTurn({
      userId, baseAgent: baselineAgent(), selectedSkillIds: ['auto-skill', 'high-skill'],
    });
    expect(highWins.effective).toEqual({
      provider: 'provider-high', model: 'model-high', reasoningEffort: 'high',
    });
  });
});

describe('execution text-model validation', () => {
  it('accepts bounded text models and rejects malformed or known media-only pairs', () => {
    expect(isExecutionTextModel('openai-oauth', 'gpt-5.6-sol')).toBe(true);
    expect(isExecutionTextModel(' openai-oauth', 'gpt-5.6-sol')).toBe(false);
    expect(isExecutionTextModel('openai-oauth', 'gpt-5.6-sol\n')).toBe(false);
    expect(isExecutionTextModel('p'.repeat(101), 'text-model')).toBe(false);
    expect(isExecutionTextModel('openai-oauth', 'm'.repeat(301))).toBe(false);
    expect(isExecutionTextModel('fireworks', 'accounts/fireworks/models/llama-v3')).toBe(false);
    expect(isExecutionTextModel('grok', 'grok-imagine-image')).toBe(false);
    expect(isExecutionTextModel('xai', 'grok-imagine-video')).toBe(false);
  });
});
