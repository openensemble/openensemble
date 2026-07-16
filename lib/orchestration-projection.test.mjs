import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

const { saveUser, getUserCoordinatorAgentId } = await import('../routes/_helpers.mjs');
const { createCustomAgent } = await import('../agents.mjs');
const { getRoleAssignments, getAgentRoles, getAgentAssignedSkills } = await import('../roles.mjs');
const { getAgentsForUser, getAgentForUser } = await import('../routes/_helpers/agent-resolver.mjs');
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

const SKILLS = ['web'];

beforeAll(() => {
  fs.mkdirSync(path.join(USERS_DIR, USER), { recursive: true });
  saveUser({ id: USER, name: 'Projection Test', role: 'user', skills: SKILLS, skillAssignments: {} });
  coordId = agent('Coord');
  chefId = agent('Chef');
  tutorId = agent('Tutor');
  saveUser({
    id: USER, name: 'Projection Test', role: 'user', skills: SKILLS,
    skillAssignments: { coordinator: coordId, custom_chef: chefId, custom_tutor: tutorId },
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
    expect(getRoleAssignments(USER)).toEqual({ coordinator: coordId, custom_chef: chefId, custom_tutor: tutorId });
    expect(getUserCoordinatorAgentId(USER)).toBe(coordId);
    expect(getAgentAssignedSkills(chefId, USER)).toEqual(['custom_chef']);
  });
});
