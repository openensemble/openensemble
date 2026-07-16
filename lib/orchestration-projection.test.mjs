import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

const { saveUser, getUserCoordinatorAgentId } = await import('../routes/_helpers.mjs');
const { createCustomAgent } = await import('../agents.mjs');
const {
  getRoleAssignments, getAgentRoles, getAgentAssignedSkills,
  addRoleManifest, removeRoleManifest, resolveAgentTools, clearRoleAssignmentsForAgent,
} = await import('../roles.mjs');
const { setSkillOverride, clearSkillOverride } = await import('./skill-overrides.mjs');
const {
  getAgentsForUser,
  getAgentForUser,
  resolveRuntimeAgentForUser,
} = await import('../routes/_helpers/agent-resolver.mjs');
const { setOrchestrationPolicy } = await import('./orchestration-policy.mjs');

const USER = 'user_orch_projection';
let coordId, chefId, tutorId;

function agent(name) {
  return createCustomAgent({
    name, emoji: 'P', description: 'projection test agent',
    provider: 'openai', model: 'gpt-4', toolSet: 'web',
    systemPrompt: 'Test agent.', ownerId: USER,
  }).id;
}

// 'coordinator' is enabled_by_default in production and backfilled into every
// profile by getUserEnabledSkills; seeded explicitly here because role
// manifests aren't loaded in this unit-test process, so the backfill is empty.
const SKILLS = ['web', 'coordinator'];

beforeAll(() => {
  fs.mkdirSync(path.join(USERS_DIR, USER), { recursive: true });
  saveUser({ id: USER, name: 'Projection Test', role: 'user', skills: SKILLS, skillAssignments: {} });
  coordId = agent('Coord');
  chefId = agent('Chef');
  tutorId = agent('Tutor');
  saveUser({
    id: USER, name: 'Projection Test', role: 'user', skills: SKILLS,
    skillAssignments: { coordinator: coordId, custom_chef: chefId, custom_tutor: tutorId },
    agentOverrides: { [coordId]: { crossAgentRead: [chefId] } },
  });
});

describe('ensemble mode (default) — stock behavior byte-for-byte', () => {
  it('exposes the full roster and raw assignments', () => {
    const roster = getAgentsForUser(USER);
    expect(roster.map(a => a.id).sort()).toEqual([coordId, chefId, tutorId].sort());
    expect(roster.every(a => a._rosterSolo === false)).toBe(true);
    expect(getRoleAssignments(USER)).toEqual({ coordinator: coordId, custom_chef: chefId, custom_tutor: tutorId });
    expect(getUserCoordinatorAgentId(USER)).toBe(coordId);
  });
});

describe('single mode — read-time projection', () => {
  beforeAll(async () => {
    await setOrchestrationPolicy(USER, { mode: 'single', primaryAgentId: coordId });
  });

  it('roster is exactly the primary, flagged _rosterSolo', () => {
    const roster = getAgentsForUser(USER);
    expect(roster.map(a => a.id)).toEqual([coordId]);
    expect(roster[0]._rosterSolo).toBe(true);
    expect(roster[0]._composerInputs.rosterSolo).toBe(true);
    expect(roster[0].crossAgentRead).toBeNull();
  });

  it('dormant agents are not resolvable through the user scope', () => {
    expect(getAgentForUser(chefId, USER)).toBeNull();
    expect(getAgentForUser(coordId, USER)?.id).toBe(coordId);
  });

  it('every assigned and enabled skill projects onto the primary', () => {
    const projected = getRoleAssignments(USER);
    expect(projected.coordinator).toBe(coordId);
    expect(projected.custom_chef).toBe(coordId);
    expect(projected.custom_tutor).toBe(coordId);
    for (const skillId of SKILLS) expect(projected[skillId]).toBe(coordId);
  });

  it('dispatch default (coordinator lookup) resolves to the primary', () => {
    expect(getUserCoordinatorAgentId(USER)).toBe(coordId);
  });

  it('memory-scope universe: the primary holds every assigned skill, dormant agents hold none', () => {
    const primarySkills = getAgentAssignedSkills(coordId, USER);
    expect(primarySkills).toEqual(expect.arrayContaining(['custom_chef', 'custom_tutor', 'coordinator']));
    expect(getAgentAssignedSkills(chefId, USER)).toEqual([]);
    expect(getAgentRoles(chefId, USER)).toEqual([]);
  });

  it('primary that is not the ensemble coordinator still becomes the projected coordinator', async () => {
    await setOrchestrationPolicy(USER, { mode: 'single', primaryAgentId: chefId });
    expect(getUserCoordinatorAgentId(USER)).toBe(chefId);
    const roster = getAgentsForUser(USER);
    expect(roster.map(a => a.id)).toEqual([chefId]);
    expect(roster[0].skillCategory).toBe('coordinator');
    await setOrchestrationPolicy(USER, { mode: 'single', primaryAgentId: coordId });
  });
});

describe('switch-back — D5 non-destructive restore', () => {
  it('ensemble roster and raw assignments come back exactly', async () => {
    await setOrchestrationPolicy(USER, { mode: 'ensemble' });
    const roster = getAgentsForUser(USER);
    expect(roster.map(a => a.id).sort()).toEqual([coordId, chefId, tutorId].sort());
    expect(roster.find(a => a.id === coordId)?.crossAgentRead).toEqual([chefId]);
    expect(getRoleAssignments(USER)).toEqual({ coordinator: coordId, custom_chef: chefId, custom_tutor: tutorId });
    expect(getUserCoordinatorAgentId(USER)).toBe(coordId);
    expect(getAgentAssignedSkills(chefId, USER)).toEqual(['custom_chef']);
  });
});

describe('persisted runtime agent references', () => {
  it('redirects only owned parked agents in single mode and restores the exact target in ensemble', async () => {
    const id = 'user_orch_runtime_redirect';
    const foreignUser = 'user_orch_runtime_foreign';
    fs.mkdirSync(path.join(USERS_DIR, id), { recursive: true });
    fs.mkdirSync(path.join(USERS_DIR, foreignUser), { recursive: true });
    saveUser({ id, name: 'Runtime Redirect', role: 'user', skills: [], skillAssignments: {} });
    saveUser({ id: foreignUser, name: 'Runtime Foreign', role: 'user', skills: [], skillAssignments: {} });
    const primary = agentForDeletion(id, 'Runtime Primary');
    const parked = agentForDeletion(id, 'Runtime Parked');
    const foreign = agentForDeletion(foreignUser, 'Runtime Foreign Agent');
    saveUser({
      id, name: 'Runtime Redirect', role: 'user', skills: [],
      skillAssignments: { coordinator: primary, fixture_runtime_parked: parked },
    });

    await setOrchestrationPolicy(id, { mode: 'ensemble' });
    expect(resolveRuntimeAgentForUser(id, parked)?.id).toBe(parked);
    expect(resolveRuntimeAgentForUser(id, `${id}_${parked}`)?.id).toBe(parked);
    expect(resolveRuntimeAgentForUser(id, 'stale_runtime_agent')).toBeNull();
    expect(resolveRuntimeAgentForUser(id, foreign)).toBeNull();

    await setOrchestrationPolicy(id, { mode: 'single', primaryAgentId: primary });
    expect(resolveRuntimeAgentForUser(id, parked)?.id).toBe(primary);
    expect(resolveRuntimeAgentForUser(id, `${id}_${parked}`)?.id).toBe(primary);
    expect(resolveRuntimeAgentForUser(id, 'stale_runtime_agent')).toBeNull();
    expect(resolveRuntimeAgentForUser(id, foreign)).toBeNull();

    await setOrchestrationPolicy(id, { mode: 'ensemble' });
    expect(resolveRuntimeAgentForUser(id, parked)?.id).toBe(parked);
  });
});

describe('new-account default-skill projection', () => {
  it('projects enabled-by-default skills even when a fresh profile has no skills field', async () => {
    const id = 'user_orch_default_projection';
    const skillId = 'fixture_default_projection';
    addRoleManifest({
      id: skillId,
      name: 'Default Projection Fixture',
      category: 'utility',
      enabled_by_default: true,
      tools: [{ type: 'function', function: { name: 'fixture_default_projection_tool', description: 'fixture', parameters: { type: 'object', properties: {} } } }],
    });
    try {
      fs.mkdirSync(path.join(USERS_DIR, id), { recursive: true });
      saveUser({ id, name: 'Fresh Owner', role: 'owner', skillAssignments: {} });
      const primary = createCustomAgent({
        name: 'Fresh Primary', emoji: 'N', description: 'new owner fixture',
        provider: 'openai', model: 'gpt-4', toolSet: 'web',
        systemPrompt: 'Test agent.', ownerId: id,
      }).id;
      await setOrchestrationPolicy(id, { mode: 'single', primaryAgentId: primary });
      expect(getRoleAssignments(id)[skillId]).toBe(primary);
      const resolved = getAgentsForUser(id)[0];
      expect(resolved.tools.map(tool => tool.function?.name)).toContain('fixture_default_projection_tool');
    } finally {
      removeRoleManifest(skillId);
    }
  });
});

describe('primary-role tool overrides', () => {
  it('does not advertise a hidden tool from the agent primary skill', async () => {
    const id = 'user_orch_hidden_primary';
    const skillId = 'fixture_hidden_primary';
    fs.mkdirSync(path.join(USERS_DIR, id), { recursive: true });
    saveUser({ id, name: 'Hidden Tool User', role: 'user', skills: [skillId], skillAssignments: {} });
    addRoleManifest({
      id: skillId,
      name: 'Hidden Primary Fixture',
      category: 'service',
      tools: [
        { type: 'function', function: { name: 'fixture_primary_visible', description: 'visible', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'fixture_primary_hidden', description: 'hidden', parameters: { type: 'object', properties: {} } } },
      ],
    });
    try {
      await setSkillOverride(id, skillId, { hiddenTools: ['fixture_primary_hidden'] });
      const names = resolveAgentTools(skillId, [skillId], 'fixture_agent', id)
        .map(tool => tool.function?.name);
      expect(names).toContain('fixture_primary_visible');
      expect(names).not.toContain('fixture_primary_hidden');
    } finally {
      await clearSkillOverride(id, skillId).catch(() => {});
      removeRoleManifest(skillId);
    }
  });
});

describe('agent deletion assignment cascade', () => {
  it('clears only stored references, not every role projected onto a single primary', async () => {
    const id = 'user_orch_delete_assignments';
    fs.mkdirSync(path.join(USERS_DIR, id), { recursive: true });
    saveUser({ id, name: 'Delete Fixture', role: 'user', skills: [], skillAssignments: {} });
    const primary = agentForDeletion(id, 'Delete Primary');
    const parked = agentForDeletion(id, 'Delete Parked');
    saveUser({
      id, name: 'Delete Fixture', role: 'user', skills: [],
      skillAssignments: { coordinator: primary, fixture_primary_role: primary, fixture_parked_role: parked },
    });
    await setOrchestrationPolicy(id, { mode: 'single', primaryAgentId: primary });
    expect(Object.values(getRoleAssignments(id)).every(value => value === primary)).toBe(true);
    expect(clearRoleAssignmentsForAgent(primary, id)).toBe(2);
    await setOrchestrationPolicy(id, { mode: 'ensemble', primaryAgentId: null });
    expect(getRoleAssignments(id)).toEqual({ fixture_parked_role: parked });
  });
});

function agentForDeletion(ownerId, name) {
  return createCustomAgent({
    name, emoji: 'D', description: 'delete assignment fixture',
    provider: 'openai', model: 'gpt-4', toolSet: 'web',
    systemPrompt: 'Test agent.', ownerId,
  }).id;
}
