import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const learningMocks = vi.hoisted(() => ({
  recordToolObservation: vi.fn(),
  recordPinUsage: vi.fn(async () => {}),
  recordToolFailure: vi.fn(async () => ({ proposed: false })),
  recordDomainSkill: vi.fn(),
  maybeCascadeOnToolSuccess: vi.fn(async () => {}),
  registerLead: vi.fn(async () => ({ ok: true, announce: 'lead registered' })),
}));

vi.mock('./lib/personalization/recorder.mjs', () => ({
  recordToolObservation: learningMocks.recordToolObservation,
}));
vi.mock('./lib/tool-defaults.mjs', () => ({
  mergeDefaults: (_userId, _name, args) => args,
  recordPinUsage: learningMocks.recordPinUsage,
}));
vi.mock('./lib/tool-failures.mjs', () => ({
  recordToolFailure: learningMocks.recordToolFailure,
}));
vi.mock('./lib/memory-scope-context.mjs', () => ({
  recordDomainSkill: learningMocks.recordDomainSkill,
}));
vi.mock('./lib/skill-alias-framework.mjs', () => ({
  registerFromManifests: vi.fn(),
  registerAliasCatalog: vi.fn(),
  unregisterAliasCatalog: vi.fn(),
  maybeCascadeOnToolSuccess: learningMocks.maybeCascadeOnToolSuccess,
}));
vi.mock('./lib/personalization/lead-helper.mjs', () => ({
  buildRegisterLead: () => learningMocks.registerLead,
}));

const { addRoleManifest, executeToolStreaming, removeRoleManifest } = await import('./roles.mjs');
const { consumeToolsFor } = await import('./lib/tool-exec-log.mjs');
const { runWithTurnContext } = await import('./lib/turn-abort-context.mjs');
const { SKILLS_DIR, USERS_DIR } = await import('./lib/paths.mjs');

const SKILL_ID = 'nonlearning-executor-probe';
const TOOL_NAME = 'nonlearning_probe';
const SKILL_DIR = path.join(SKILLS_DIR, SKILL_ID);
const TEST_USER_DIRS = new Set();

function provisionUser(userId) {
  const dir = path.join(USERS_DIR, userId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    id: userId,
    role: 'owner',
    skills: [SKILL_ID],
  }));
  TEST_USER_DIRS.add(dir);
  return userId;
}

async function collectTool(args, userId, name = TOOL_NAME) {
  const events = [];
  for await (const event of executeToolStreaming(
    name,
    args,
    userId,
    'jarvis_lab',
    [name],
  )) events.push(event);
  return events;
}

describe('tool executor non-learning context', () => {
  beforeAll(() => {
    mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(path.join(SKILL_DIR, 'execute.mjs'), `
      export default async function execute(_name, args, _userId, _agentId, ctx) {
        if (args?.fail) throw new Error('forced fixture failure');
        if (args?.registerLead) {
          return JSON.stringify(await ctx.registerLead({
            query: 'fixture lead', toolName: 'nonlearning_probe', args: {},
          }));
        }
        return 'fixture executed';
      }
    `);
    addRoleManifest({
      id: SKILL_ID,
      name: 'Non-learning executor probe',
      category: 'utility',
      service: false,
      tools: [{
        type: 'function',
        function: {
          name: TOOL_NAME,
          description: 'Exercise the real role-tool executor in tests.',
          parameters: {
            type: 'object',
            properties: {
              fail: { type: 'boolean' },
              registerLead: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'remember_fact',
          description: 'Verifier-only explicit learning-mutator probe.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      }],
    });
  });

  afterAll(() => {
    removeRoleManifest(SKILL_ID);
    rmSync(SKILL_DIR, { recursive: true, force: true });
    for (const dir of TEST_USER_DIRS) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const mock of Object.values(learningMocks)) mock.mockClear();
  });

  it('executes real success and failure paths without leaking verifier learning into an ordinary turn', async () => {
    const verifierUser = provisionUser(`verifier-tool-user-${Date.now()}`);
    const success = await runWithTurnContext(
      { suppressLearning: true },
      () => collectTool({ registerLead: true }, verifierUser),
    );
    expect(success).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result', text: expect.stringMatching(/disabled during this verification run/i),
      }),
    ]));

    const verifierFailureUser = provisionUser(`verifier-failure-user-${Date.now()}`);
    const failed = await runWithTurnContext(
      { suppressLearning: true },
      () => collectTool({ fail: true }, verifierFailureUser),
    );
    expect(failed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result',
        text: expect.stringMatching(/forced fixture failure/i),
      }),
    ]));

    const ordinaryUser = provisionUser(`ordinary-tool-user-${Date.now()}`);
    const normal = await collectTool({ registerLead: true }, ordinaryUser);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(normal).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'result', text: expect.stringContaining('lead registered') }),
    ]));
    expect(consumeToolsFor(verifierUser)).toEqual([]);
    expect(consumeToolsFor(verifierFailureUser)).toEqual([]);
    expect(consumeToolsFor(ordinaryUser)).toEqual([TOOL_NAME]);
    expect(learningMocks.recordPinUsage).toHaveBeenCalledOnce();
    expect(learningMocks.recordToolObservation).toHaveBeenCalledOnce();
    expect(learningMocks.recordToolFailure).not.toHaveBeenCalled();
    expect(learningMocks.recordDomainSkill).not.toHaveBeenCalled();
    expect(learningMocks.maybeCascadeOnToolSuccess).toHaveBeenCalledOnce();
    expect(learningMocks.registerLead).toHaveBeenCalledOnce();
  });

  it('blocks explicit learning mutators only inside the non-learning context', async () => {
    const verifierUser = provisionUser(`verifier-mutator-user-${Date.now()}`);
    const blocked = await runWithTurnContext(
      { suppressLearning: true },
      () => collectTool({}, verifierUser, 'remember_fact'),
    );
    expect(blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result', isError: true,
        text: expect.stringMatching(/unavailable during this non-learning verification turn/i),
      }),
    ]));
    expect(consumeToolsFor(verifierUser)).toEqual([]);
    expect(learningMocks.recordPinUsage).not.toHaveBeenCalled();
    expect(learningMocks.recordToolObservation).not.toHaveBeenCalled();

    const ordinaryUser = provisionUser(`ordinary-mutator-user-${Date.now()}`);
    const ordinary = await collectTool({}, ordinaryUser, 'remember_fact');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ordinary).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'result', text: 'fixture executed' }),
    ]));
    expect(consumeToolsFor(ordinaryUser)).toEqual(['remember_fact']);
    expect(learningMocks.recordPinUsage).toHaveBeenCalledOnce();
    expect(learningMocks.recordToolObservation).toHaveBeenCalledOnce();
  });

  it('enforces an authenticated verifier case allowlist before tool execution', async () => {
    const deniedUser = provisionUser(`verifier-denied-tool-user-${Date.now()}`);
    const denied = await runWithTurnContext(
      { suppressLearning: true, verifierAllowedTools: [] },
      () => collectTool({}, deniedUser),
    );
    expect(denied).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result', isError: true,
        text: expect.stringMatching(/outside this verification case/i),
      }),
    ]));
    expect(consumeToolsFor(deniedUser)).toEqual([]);

    const allowedUser = provisionUser(`verifier-allowed-tool-user-${Date.now()}`);
    const allowed = await runWithTurnContext(
      { suppressLearning: true, verifierAllowedTools: [TOOL_NAME] },
      () => collectTool({}, allowedUser),
    );
    expect(allowed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'result', text: 'fixture executed' }),
    ]));
    expect(consumeToolsFor(allowedUser)).toEqual([]);
  });
});
