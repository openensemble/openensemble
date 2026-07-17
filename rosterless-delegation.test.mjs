import { afterEach, describe, expect, it, vi } from 'vitest';

// Rosterless (single-agent / Jarvis) deployments have no specialists, so
// ask_agent must return one deterministic redirect toward direct action or
// spawn_worker — never the "not found" ladder (which invites the model to
// retry hallucinated agent names) and never a self-delegation via the
// agent_id="coordinator" skillCategory fallback.

const SOLO_ROSTER = [
  { id: 'jarvis_lab', name: 'Jarvis Lab', skillCategory: 'coordinator' },
];
const MULTI_ROSTER = [
  { id: 'jarvis_lab', name: 'Jarvis Lab', skillCategory: 'coordinator' },
  { id: 'agent_11aa22bb', name: 'Gina', skillCategory: 'email', role: 'email' },
];

let roster = SOLO_ROSTER;
// Stock lands the redirect behind the stored orchestration policy (plan D4):
// single mode triggers it, ensemble keeps the resolution ladder even for a
// one-agent roster. Mocked here so each case pins the mode explicitly.
let orchestrationMode = 'single';

vi.mock('./routes/_helpers.mjs', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, getAgentsForUser: () => roster };
});

vi.mock('./lib/orchestration-policy.mjs', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    getOrchestrationPolicy: () => ({
      mode: orchestrationMode,
      primaryAgentId: orchestrationMode === 'single' ? 'jarvis_lab' : null,
    }),
  };
});

const { executeSkillTool } = await import('./skills/delegate/execute.mjs');

const { default: fs } = await import('fs');
const { default: path } = await import('path');
const { SKILLS_DIR, USERS_DIR } = await import('./lib/paths.mjs');
const { loadRoleManifests } = await import('./roles.mjs');
const { composeSkillSpaBlock } = await import('./lib/skill-prompt-composer.mjs');

async function runAskAgent(args, callerAgentId) {
  const chunks = [];
  for await (const c of executeSkillTool('ask_agent', args, 'user_roster_test', callerAgentId)) {
    chunks.push(c);
  }
  return chunks;
}

afterEach(() => {
  roster = SOLO_ROSTER;
  orchestrationMode = 'single';
});

describe('rosterless ask_agent redirect', () => {
  it('redirects a hallucinated specialist id to direct action / spawn_worker', async () => {
    const chunks = await runAskAgent(
      { agent_id: 'email', task: 'send the report to alex' },
      'user_roster_test_jarvis_lab',
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('result');
    expect(chunks[0].text).toContain('single agent');
    expect(chunks[0].text).toContain('spawn_worker');
    expect(chunks[0].text).not.toContain('not found');
  });

  it('redirects agent_id="coordinator" instead of matching the caller itself', async () => {
    const chunks = await runAskAgent(
      { agent_id: 'coordinator', task: 'summarize the inbox' },
      'user_roster_test_jarvis_lab',
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('spawn_worker');
  });

  it('tells a background worker to finish and report, not to escalate', async () => {
    const chunks = await runAskAgent(
      { agent_id: 'coordinator', task: 'I am stuck, take over' },
      'ephemeral_worker_1700000000000_ab1cd_jarvis_lab',
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('background worker');
    expect(chunks[0].text).toContain('delivered to your owner automatically');
    expect(chunks[0].text).not.toContain('spawn_worker');
  });

  it('still validates missing args before the redirect', async () => {
    const chunks = await runAskAgent({ agent_id: 'email' }, 'user_roster_test_jarvis_lab');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Missing agent_id or task.');
  });

  it('leaves ensemble accounts on the existing not-found path', async () => {
    roster = MULTI_ROSTER;
    orchestrationMode = 'ensemble';
    const chunks = await runAskAgent(
      { agent_id: 'agent_nope9999', task: 'do something' },
      'user_roster_test_jarvis_lab',
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('not found');
    expect(chunks[0].text).not.toContain('spawn_worker');
  });

  it('D4: an ensemble account with ONE agent still gets the ladder, never the redirect', async () => {
    roster = SOLO_ROSTER;
    orchestrationMode = 'ensemble';
    const chunks = await runAskAgent(
      { agent_id: 'agent_nope9999', task: 'do something' },
      'user_roster_test_jarvis_lab',
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('not found');
    expect(chunks[0].text).not.toContain('spawn_worker');
  });
});

// The delegate SPA is written for the multi-agent world (named specialists,
// ask_agent forward pipelines). A rosterless Jarvis reading it wastes turns
// attempting delegations the redirect above has to bounce — so solo rosters
// get the manifest's `systemPromptAdditionSolo` instead, selected in
// lib/skill-prompt-composer.mjs off the rosterSolo flag that
// routes/_helpers/agent-resolver.mjs puts in composerInputs.
describe('rosterless delegate SPA variant', () => {
  // Vitest redirects BASE_DIR/SKILLS_DIR to an empty per-process temp dir, so
  // seed it with the REAL shipped delegate skill (this test must hold against
  // the actual manifest text, not a fixture) plus one synthetic skill that has
  // no solo variant, to prove the fallback.
  fs.cpSync(path.resolve('skills/delegate'), path.join(SKILLS_DIR, 'delegate'), { recursive: true });
  fs.mkdirSync(path.join(USERS_DIR, 'user_roster_test'), { recursive: true });
  fs.writeFileSync(path.join(USERS_DIR, 'user_roster_test', 'profile.json'), JSON.stringify({
    id: 'user_roster_test', role: 'owner', skills: ['delegate', 'nosolo_fixture'],
  }));
  fs.mkdirSync(path.join(SKILLS_DIR, 'nosolo_fixture'), { recursive: true });
  fs.writeFileSync(path.join(SKILLS_DIR, 'nosolo_fixture', 'manifest.json'), JSON.stringify({
    id: 'nosolo_fixture',
    name: 'No Solo Fixture',
    category: 'utility',
    tools: [{ type: 'function', function: { name: 'nosolo_fixture_tool', description: 'x', parameters: { type: 'object', properties: {} } } }],
    systemPromptAddition: 'Standard-only guidance for {{AGENT_NAME}}.',
  }));
  loadRoleManifests({ runMigrations: false });

  const compose = (extra = {}) => composeSkillSpaBlock({
    tools: [{ type: 'function', function: { name: 'spawn_worker' } }],
    userId: 'user_roster_test',
    userName: 'Alex',
    agentName: 'Jarvis',
    agentEmoji: '',
    serverIp: '127.0.0.1',
    emailNoConfirm: false,
    ...extra,
  });

  it('solo roster gets the solo SPA: workers + request_tools, zero specialist coaching', () => {
    const spa = compose({ rosterSolo: true });
    expect(spa).toContain('ONLY agent');
    expect(spa).toContain('spawn_worker');
    expect(spa).toContain('request_tools');
    for (const banned of ['ask_agent', 'handoff_to', 'handoff_directive', 'Gina', 'email specialist']) {
      expect(spa).not.toContain(banned);
    }
  });

  it('multi-agent roster keeps the standard SPA byte-for-byte behavior', () => {
    const spa = compose({ rosterSolo: false });
    expect(spa).toContain('handoff_to');
    expect(spa).toContain('ask_agent');
    expect(spa).not.toContain('ONLY agent');
  });

  it('omitting rosterSolo behaves as multi-agent (back-compat default)', () => {
    const spa = compose();
    expect(spa).toContain('handoff_to');
  });

  it('a skill with no solo variant falls back to its standard SPA under solo rosters', () => {
    const spa = composeSkillSpaBlock({
      tools: [{ type: 'function', function: { name: 'nosolo_fixture_tool' } }],
      userId: 'user_roster_test',
      userName: 'Alex',
      agentName: 'Jarvis',
      agentEmoji: '',
      serverIp: '127.0.0.1',
      emailNoConfirm: false,
      rosterSolo: true,
    });
    expect(spa).toContain('Standard-only guidance for Jarvis.');
  });
});
