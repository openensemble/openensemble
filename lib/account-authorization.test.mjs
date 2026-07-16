import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CFG_PATH, SKILLS_DIR, USERS_DIR, userSkillsDir } from './paths.mjs';

const { createCustomAgent } = await import('../agents.mjs');
const { getAgentsForUser } = await import('../routes/_helpers/agent-resolver.mjs');
const { getUser, saveUser } = await import('../routes/_helpers.mjs');
const {
  addRoleManifest,
  clearRoleAssignmentsForAgent,
  executeRoleTool,
  executeRoleToolForSkill,
  executeToolStreaming,
  getRoleAssignment,
  getRoleTools,
  isSandboxedSkill,
  isSkillAllowedForUser,
  isSkillRuntimeEnabledForUser,
  listRoles,
  removeRoleManifest,
  setRoleAssignment,
} = await import('../roles.mjs');
const {
  completePendingPrimary,
  getOrchestrationPolicy,
  newAccountOrchestrationPolicy,
  setOrchestrationPolicy,
} = await import('./orchestration-policy.mjs');

const SKILL = 'fixture_account_authorization';
const TOOL = 'fixture_account_authorization_run';
const COORDINATOR_TOOL = 'fixture_account_authorization_switch';
const touchedUsers = new Set();
let originalConfig = null;

function toolNames(agent) {
  return (agent?.tools ?? []).map(tool => tool?.function?.name ?? tool?.name).filter(Boolean);
}

function seedUser(id, role, allowedState = 'missing', extra = {}) {
  const profile = {
    id,
    name: id,
    role,
    skills: [SKILL, 'coordinator'],
    skillAssignments: {},
    orchestration: { mode: 'ensemble' },
    ...extra,
  };
  if (allowedState !== 'missing') profile.allowedSkills = allowedState;
  saveUser(profile);
  touchedUsers.add(id);
  return profile;
}

function seedAgent(userId, label = userId) {
  const agent = createCustomAgent({
    name: `Auth ${label}`,
    emoji: 'A',
    description: 'account authorization fixture',
    provider: 'openai',
    model: 'gpt-4',
    toolSet: 'web',
    systemPrompt: 'Account authorization fixture.',
    ownerId: userId,
  });
  const profile = getUser(userId);
  if (profile) {
    saveUser({
      ...profile,
      skillAssignments: {
        ...(profile.skillAssignments ?? {}),
        [SKILL]: agent.id,
        coordinator: agent.id,
      },
    });
    // The installation owner deliberately retains the legacy global map;
    // every other role uses its profile-local assignments.
    if (profile.role === 'owner') {
      setRoleAssignment(SKILL, agent.id, userId);
      setRoleAssignment('coordinator', agent.id, userId);
    }
  }
  return agent.id;
}

async function expectSkillUsable(userId, agentId) {
  expect(isSkillAllowedForUser(SKILL, userId)).toBe(true);
  expect(listRoles(userId).map(role => role.id)).toContain(SKILL);
  expect(getRoleTools(SKILL, userId).map(tool => tool.function?.name)).toContain(TOOL);
  expect(toolNames(getAgentsForUser(userId).find(agent => agent.id === agentId))).toContain(TOOL);
  expect(await executeRoleToolForSkill(SKILL, TOOL, {}, userId, agentId)).toBe('fixture ok');
}

async function expectSkillDenied(userId, { rosterExists = true } = {}) {
  expect(isSkillAllowedForUser(SKILL, userId)).toBe(false);
  expect(listRoles(userId).map(role => role.id)).not.toContain(SKILL);
  expect(getRoleTools(SKILL, userId)).toEqual([]);
  const roster = getAgentsForUser(userId);
  if (rosterExists) expect(roster.length).toBeGreaterThan(0);
  else expect(roster).toEqual([]);
  for (const agent of roster) expect(toolNames(agent)).not.toContain(TOOL);
  expect(await executeRoleToolForSkill(SKILL, TOOL, {}, userId, null))
    .toContain('not permitted for this account');
}

function installGlobalFixture(id, toolName) {
  const dir = path.join(SKILLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'execute.mjs'),
    `export default async function execute(name) { return name === ${JSON.stringify(toolName)} ? 'fixture ok' : null; }\n`);
  addRoleManifest({
    id,
    name: id,
    category: 'service',
    service: true,
    tools: [{
      type: 'function',
      function: {
        name: toolName,
        description: 'account authorization test fixture',
        parameters: { type: 'object', properties: {} },
      },
    }],
  });
}

function installDeniedCustomFixture(userId, profileState) {
  const skillId = `fixture_denied_custom_${profileState}`;
  const marker = `__oe_denied_custom_import_${profileState}`;
  const dir = path.join(userSkillsDir(userId), skillId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'execute.mjs'), `
globalThis[${JSON.stringify(marker)}] = true;
export default async function execute() { return 'unsafe import'; }
`);
  addRoleManifest({
    id: skillId,
    name: skillId,
    custom: true,
    sandbox: { isolate: false },
    tools: [{
      type: 'function',
      function: {
        name: `${skillId}_run`,
        description: 'denied custom import fixture',
        parameters: { type: 'object', properties: {} },
      },
    }],
  }, userId);
  return { skillId, marker, toolName: `${skillId}_run` };
}

beforeAll(() => {
  try { originalConfig = fs.readFileSync(CFG_PATH, 'utf8'); } catch { originalConfig = null; }
  installGlobalFixture(SKILL, TOOL);
  installGlobalFixture('coordinator', COORDINATOR_TOOL);
});

afterAll(() => {
  removeRoleManifest(SKILL);
  removeRoleManifest('coordinator');
  fs.rmSync(path.join(SKILLS_DIR, SKILL), { recursive: true, force: true });
  fs.rmSync(path.join(SKILLS_DIR, 'coordinator'), { recursive: true, force: true });
  for (const userId of touchedUsers) {
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
  if (originalConfig === null) fs.rmSync(CFG_PATH, { force: true });
  else fs.writeFileSync(CFG_PATH, originalConfig);
});

describe('account-level skill authorization matrix', () => {
  it.each(['owner', 'admin'])('%s remains unrestricted even with an empty allowlist', async role => {
    const userId = `user_auth_privileged_${role}`;
    seedUser(userId, role, []);
    const agentId = seedAgent(userId, role);
    await expectSkillUsable(userId, agentId);
  });

  it('a child receives only skills in its explicit array', async () => {
    const allowedId = 'user_auth_child_allowed';
    seedUser(allowedId, 'child', [SKILL]);
    const allowedAgent = seedAgent(allowedId, 'child allowed');
    await expectSkillUsable(allowedId, allowedAgent);

    const deniedId = 'user_auth_child_explicit_empty';
    seedUser(deniedId, 'child', []);
    seedAgent(deniedId, 'child denied');
    await expectSkillDenied(deniedId);
  });

  it.each([
    ['missing', 'missing'],
    ['malformed', { accidentally: 'not an array' }],
  ])('a child with a %s allowlist fails closed', async (_label, allowedState) => {
    const userId = `user_auth_child_${_label}`;
    seedUser(userId, 'child', allowedState);
    seedAgent(userId, `child ${_label}`);
    await expectSkillDenied(userId);
  });

  it('a regular-user allowlist is an authoritative ceiling, including []', async () => {
    const allowedId = 'user_auth_regular_allowed';
    seedUser(allowedId, 'user', [SKILL]);
    const allowedAgent = seedAgent(allowedId, 'regular allowed');
    await expectSkillUsable(allowedId, allowedAgent);

    const deniedId = 'user_auth_regular_empty';
    seedUser(deniedId, 'user', []);
    seedAgent(deniedId, 'regular denied');
    await expectSkillDenied(deniedId);
  });

  it('does not expose or execute an allowed-but-disabled skill', async () => {
    const userId = 'user_auth_regular_allowed_disabled';
    seedUser(userId, 'user', [SKILL], { skills: ['coordinator'] });
    const agentId = seedAgent(userId, 'regular allowed but disabled');
    expect(isSkillAllowedForUser(SKILL, userId)).toBe(true);
    expect(isSkillRuntimeEnabledForUser(SKILL, userId)).toBe(false);
    expect(toolNames(getAgentsForUser(userId).find(agent => agent.id === agentId))).not.toContain(TOOL);
    expect(await executeRoleToolForSkill(SKILL, TOOL, {}, userId, agentId))
      .toContain('disabled skill');
    expect(await executeRoleTool(TOOL, {}, userId, agentId))
      .toContain('disabled skill');
    const streamed = [];
    for await (const event of executeToolStreaming(TOOL, {}, userId, agentId)) streamed.push(event);
    expect(streamed).toEqual([{ type: 'result', text: `Tool "${TOOL}" is from a disabled skill.` }]);
  });

  it.each([
    ['absent', 'missing'],
    ['null', null],
  ])('a regular user with an %s allowlist retains legacy unrestricted behavior', async (_label, allowedState) => {
    const userId = `user_auth_regular_legacy_${_label}`;
    seedUser(userId, 'user', allowedState);
    const agentId = seedAgent(userId, `regular ${_label}`);
    await expectSkillUsable(userId, agentId);
  });

  it('a malformed regular-user allowlist fails closed rather than becoming legacy-unrestricted', async () => {
    const userId = 'user_auth_regular_malformed';
    seedUser(userId, 'user', 'not-an-array');
    seedAgent(userId, 'regular malformed');
    await expectSkillDenied(userId);
  });
});

describe('missing account authority', () => {
  it.each([
    ['missing', false],
    ['unreadable', true],
  ])('%s profiles expose no roster/schema, deny direct execution, and force custom code into the sandbox', async (state, unreadable) => {
    const userId = `user_auth_profile_${state}`;
    touchedUsers.add(userId);
    createCustomAgent({
      name: `Missing Profile ${state}`,
      emoji: 'M',
      description: 'missing profile fixture',
      provider: 'openai',
      model: 'gpt-4',
      toolSet: 'web',
      ownerId: userId,
    });
    if (unreadable) {
      fs.writeFileSync(path.join(USERS_DIR, userId, 'profile.json'), '{not-json');
    }
    const custom = installDeniedCustomFixture(userId, state);

    await expectSkillDenied(userId, { rosterExists: false });
    expect(isSandboxedSkill(custom.skillId, userId)).toBe(true);
    expect(await executeRoleToolForSkill(custom.skillId, custom.toolName, {}, userId, null))
      .toContain('not permitted for this account');
    expect(globalThis[custom.marker]).toBeUndefined();

    removeRoleManifest(custom.skillId, userId);
    delete globalThis[custom.marker];
  });
});

describe('first-primary completion preserves an ensemble coordinator', () => {
  it('durably assigns the first primary as coordinator and keeps it working after switching to ensemble', async () => {
    const userId = 'user_auth_pending_primary';
    seedUser(userId, 'user', 'missing', {
      orchestration: newAccountOrchestrationPolicy(),
      skillAssignments: {},
    });
    const primaryId = createCustomAgent({
      name: 'Durable Primary',
      emoji: 'D',
      description: 'pending primary fixture',
      provider: 'openai',
      model: 'gpt-4',
      toolSet: 'web',
      ownerId: userId,
    }).id;

    expect(await completePendingPrimary(userId, primaryId)).toBe(true);
    expect(getOrchestrationPolicy(userId)).toEqual({ mode: 'single', primaryAgentId: primaryId });
    expect(getRoleAssignment('coordinator', userId)).toBe(primaryId);
    expect(JSON.parse(fs.readFileSync(path.join(USERS_DIR, userId, 'profile.json'), 'utf8'))
      .skillAssignments.coordinator).toBe(primaryId);

    await setOrchestrationPolicy(userId, { mode: 'ensemble' });
    expect(getRoleAssignment('coordinator', userId)).toBe(primaryId);
    const coordinator = getAgentsForUser(userId).find(agent => agent.id === primaryId);
    expect(coordinator?.skillCategory).toBe('coordinator');
    expect(toolNames(coordinator)).toContain(COORDINATOR_TOOL);
  });

  it('stores an admin primary per-profile without overwriting the owner/global coordinator', async () => {
    const ownerId = 'user_auth_pending_owner';
    seedUser(ownerId, 'owner');
    const ownerAgent = seedAgent(ownerId, 'global owner');
    setRoleAssignment('coordinator', ownerAgent, ownerId);

    const adminId = 'user_auth_pending_admin';
    seedUser(adminId, 'admin', 'missing', {
      orchestration: newAccountOrchestrationPolicy(),
      skillAssignments: {},
    });
    const adminAgent = createCustomAgent({
      name: 'Admin Primary',
      emoji: 'P',
      description: 'admin pending primary fixture',
      provider: 'openai',
      model: 'gpt-4',
      toolSet: 'web',
      ownerId: adminId,
    }).id;

    expect(await completePendingPrimary(adminId, adminAgent)).toBe(true);
    expect(getRoleAssignment('coordinator', ownerId)).toBe(ownerAgent);
    expect(getRoleAssignment('coordinator', adminId)).toBe(adminAgent);
    expect(JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')).skillAssignments.coordinator).toBe(ownerAgent);
    expect(JSON.parse(fs.readFileSync(path.join(USERS_DIR, adminId, 'profile.json'), 'utf8'))
      .skillAssignments.coordinator).toBe(adminAgent);

    await setOrchestrationPolicy(adminId, { mode: 'ensemble' });
    const coordinator = getAgentsForUser(adminId).find(agent => agent.id === adminAgent);
    expect(coordinator?.skillCategory).toBe('coordinator');
    expect(toolNames(coordinator)).toContain(COORDINATOR_TOOL);
  });
});

describe('role-assignment storage boundaries', () => {
  it.each(['missing', 'unreadable'])(
    'does not fall back to global assignments when a named profile is %s',
    state => {
      const userId = `user_auth_assignment_${state}`;
      touchedUsers.add(userId);
      fs.mkdirSync(path.join(USERS_DIR, userId), { recursive: true });
      if (state === 'unreadable') {
        fs.writeFileSync(path.join(USERS_DIR, userId, 'profile.json'), '{not-json');
      }
      const before = fs.existsSync(CFG_PATH) ? fs.readFileSync(CFG_PATH, 'utf8') : null;

      expect(() => setRoleAssignment('fixture_never_global', 'fixture_agent', userId))
        .toThrow(/unknown or unreadable user/);
      expect(fs.existsSync(CFG_PATH) ? fs.readFileSync(CFG_PATH, 'utf8') : null).toBe(before);
    },
  );

  it('clears a deleted admin agent from both profile-local and legacy global assignments', () => {
    const userId = 'user_auth_admin_assignment_cleanup';
    const target = 'fixture_deleted_admin_agent';
    const keep = 'fixture_kept_admin_agent';
    const configBefore = fs.existsSync(CFG_PATH) ? fs.readFileSync(CFG_PATH, 'utf8') : null;
    seedUser(userId, 'admin', 'missing', {
      skillAssignments: {
        fixture_profile_one: target,
        fixture_profile_two: target,
        fixture_profile_keep: keep,
      },
    });

    try {
      const cfg = configBefore ? JSON.parse(configBefore) : {};
      cfg.skillAssignments = {
        ...(cfg.skillAssignments ?? {}),
        fixture_global_one: target,
        fixture_global_two: target,
        fixture_global_keep: keep,
      };
      fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));

      expect(clearRoleAssignmentsForAgent(target, userId)).toBe(4);

      const profile = JSON.parse(fs.readFileSync(path.join(USERS_DIR, userId, 'profile.json'), 'utf8'));
      expect(profile.skillAssignments).toEqual({ fixture_profile_keep: keep });
      const globalAssignments = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')).skillAssignments;
      expect(globalAssignments.fixture_global_one).toBeUndefined();
      expect(globalAssignments.fixture_global_two).toBeUndefined();
      expect(globalAssignments.fixture_global_keep).toBe(keep);
    } finally {
      if (configBefore === null) fs.rmSync(CFG_PATH, { force: true });
      else fs.writeFileSync(CFG_PATH, configBefore);
    }
  });

  it('keeps regular-user cleanup profile-local and owner cleanup global-only', () => {
    const target = 'fixture_deleted_scoped_agent';
    const configBefore = fs.existsSync(CFG_PATH) ? fs.readFileSync(CFG_PATH, 'utf8') : null;
    const regularId = 'user_auth_regular_assignment_cleanup';
    const ownerId = 'user_auth_owner_assignment_cleanup';
    seedUser(regularId, 'user', 'missing', {
      skillAssignments: { fixture_regular: target },
    });
    seedUser(ownerId, 'owner', 'missing', {
      // Owner profile-local data is not an assignment source and must not be
      // rewritten by the global-owner cleanup path.
      skillAssignments: { fixture_owner_profile_stale: target },
    });

    try {
      const cfg = configBefore ? JSON.parse(configBefore) : {};
      cfg.skillAssignments = {
        ...(cfg.skillAssignments ?? {}),
        fixture_global_scoped: target,
      };
      fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));

      expect(clearRoleAssignmentsForAgent(target, regularId)).toBe(1);
      expect(JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')).skillAssignments.fixture_global_scoped)
        .toBe(target);

      expect(clearRoleAssignmentsForAgent(target, ownerId)).toBe(1);
      expect(JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')).skillAssignments.fixture_global_scoped)
        .toBeUndefined();
      expect(JSON.parse(fs.readFileSync(path.join(USERS_DIR, ownerId, 'profile.json'), 'utf8'))
        .skillAssignments.fixture_owner_profile_stale).toBe(target);
    } finally {
      if (configBefore === null) fs.rmSync(CFG_PATH, { force: true });
      else fs.writeFileSync(CFG_PATH, configBefore);
    }
  });
});
