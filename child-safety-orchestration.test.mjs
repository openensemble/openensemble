import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SKILLS_DIR, USERS_DIR } from './lib/paths.mjs';

// D7 ship-blocker suite (single-agent-mode integration plan §3.4): child
// safety derives from the ACCOUNT, so switching orchestration modes must not
// widen a child's effective tool surface, and the user-level gates must hold
// (1) at roster/tool resolution and (2) again at tool execution — in BOTH
// modes. These tests run the real resolver and the real execution gate.

const { saveUser } = await import('./routes/_helpers.mjs');
const { createCustomAgent } = await import('./agents.mjs');
const { loadRoleManifests, executeToolStreaming, getRoleManifest } = await import('./roles.mjs');
const { getAgentsForUser } = await import('./routes/_helpers/agent-resolver.mjs');
const { setOrchestrationPolicy } = await import('./lib/orchestration-policy.mjs');
const { getDefaultChildSafetyPrompt } = await import('./routes/_helpers/agent-resolver.mjs');

const CHILD = 'user_child_orch_test';
// fixture_allowed is a synthetic skill created below; the two fixtures give
// the execution-gate tests a loadable executor with no relative imports
// (real skill executors can't be lazily loaded from the disposable test
// SKILLS_DIR — their ../../lib imports resolve against the temp tree).
const ALLOWED = ['web', 'deep_research', 'fixture_allowed'];
// Service skills a child in this configuration must NEVER see schemas from,
// in either mode (email/gcal/expenses are outside allowedSkills; coder is
// enabled_by_default and gets backfilled into `skills`, which is exactly the
// widening path the projection's allowedSkills intersection closes).
const FORBIDDEN_SKILLS = ['email', 'gcal', 'expenses', 'coder', 'fixture_blocked'];
let coordId, helperId;

const toolNames = a => (a.tools ?? []).map(t => t.function?.name).filter(Boolean);
const ownerOf = (name) => {
  for (const skillId of FORBIDDEN_SKILLS) {
    if (getRoleManifest(skillId)?.tools?.some(t => t.function?.name === name)) return skillId;
  }
  return null;
};

async function collect(gen) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

function writeFixtureSkill(id, toolName) {
  const dir = path.join(SKILLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, category: 'utility', service: true,
    tools: [{ type: 'function', function: { name: toolName, description: 'test fixture', parameters: { type: 'object', properties: {} } } }],
  }));
  fs.writeFileSync(path.join(dir, 'execute.mjs'),
    "export default async function execute(name) { return 'fixture ok: ' + name; }\n");
}

beforeAll(() => {
  // Real manifests (copied, executors omitted): the execution gate resolves a
  // tool's owning skill by scanning manifests, and the surface assertions
  // need real tool→skill ownership. Plus two synthetic skills whose trivial
  // executors CAN load from the temp tree, so the gate-2 tests reach the
  // child gate rather than dying at executor resolution.
  const sourceSkills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'skills');
  fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  for (const entry of fs.readdirSync(sourceSkills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = path.join(sourceSkills, entry.name, 'manifest.json');
    if (!fs.existsSync(m)) continue;
    fs.mkdirSync(path.join(SKILLS_DIR, entry.name), { recursive: true });
    fs.copyFileSync(m, path.join(SKILLS_DIR, entry.name, 'manifest.json'));
  }
  writeFixtureSkill('fixture_blocked', 'fixture_blocked_tool');
  writeFixtureSkill('fixture_allowed', 'fixture_allowed_tool');
  loadRoleManifests();

  fs.mkdirSync(path.join(USERS_DIR, CHILD), { recursive: true });
  saveUser({ id: CHILD, name: 'Kid', role: 'child', skills: ['web', 'fixture_allowed'], allowedSkills: ALLOWED, skillAssignments: {} });
  coordId = createCustomAgent({
    name: 'Kid Coordinator', emoji: 'K', description: 'child safety test',
    provider: 'openai', model: 'gpt-4', toolSet: 'web',
    systemPrompt: 'Kid coordinator.', ownerId: CHILD,
  }).id;
  helperId = createCustomAgent({
    name: 'Kid Helper', emoji: 'H', description: 'child safety test',
    provider: 'openai', model: 'gpt-4', toolSet: 'web',
    systemPrompt: 'Kid helper.', ownerId: CHILD,
  }).id;
  saveUser({ id: CHILD, name: 'Kid', role: 'child', skills: ['web', 'fixture_allowed'], allowedSkills: ALLOWED, skillAssignments: { coordinator: coordId } });
});

// Sanity: the forbidden probe tool must exist and belong to a skill outside
// the child's allowedSkills, or the whole suite proves nothing.
it('fixture sanity: email_list_accounts exists and email is not allowed', () => {
  expect(ownerOf('email_list_accounts')).toBe('email');
  expect(ALLOWED).not.toContain('email');
});

describe('gate 1 — tool surface at resolution', () => {
  it('ensemble: no roster agent carries tools from non-enabled service skills', () => {
    const roster = getAgentsForUser(CHILD);
    expect(roster.length).toBeGreaterThan(1);
    for (const a of roster) {
      for (const n of toolNames(a)) expect(ownerOf(n), `${n} on ${a.name}`).toBeNull();
    }
  });

  it('single: the primary carries every-enabled-skill tools but still nothing outside the child account scope', async () => {
    await setOrchestrationPolicy(CHILD, { mode: 'single', primaryAgentId: coordId });
    const roster = getAgentsForUser(CHILD);
    expect(roster.map(a => a.id)).toEqual([coordId]);
    for (const n of toolNames(roster[0])) expect(ownerOf(n), `${n} on primary`).toBeNull();
  });

  it('mode switch cannot reach forbidden service skills, even via backfilled defaults', async () => {
    // coder is enabled_by_default, so it lands in the child's `skills` via
    // backfill — but it is NOT in allowedSkills, and the projection's
    // allowedSkills intersection must keep its schemas off the primary.
    await setOrchestrationPolicy(CHILD, { mode: 'single', primaryAgentId: coordId });
    const single = getAgentsForUser(CHILD)[0];
    for (const n of toolNames(single)) {
      expect(ownerOf(n), `single mode surfaced forbidden tool ${n}`).toBeNull();
    }
    // And an allowed skill's expansion is intact: the primary carries the
    // fixture_allowed schema, proving the intersection filters rather than
    // disabling the enabled-skill expansion wholesale.
    const kidSkills = JSON.parse(fs.readFileSync(path.join(USERS_DIR, CHILD, 'profile.json'), 'utf8')).skills;
    expect(kidSkills).toContain('coder');            // backfill actually happened
    expect(toolNames(single)).toContain('fixture_allowed_tool');
  });
});

describe('gate 2 — execution-time allowedSkills enforcement (defense in depth)', () => {
  // Simulates a hallucinated/injected tool call that bypassed the roster
  // filter entirely (allowedTools = null): the account-level gate must
  // still refuse, identically in both modes.
  it('blocks a non-allowed skill tool in ensemble mode', async () => {
    await setOrchestrationPolicy(CHILD, { mode: 'ensemble' });
    const events = await collect(executeToolStreaming('fixture_blocked_tool', {}, CHILD, coordId, null));
    expect(events).toHaveLength(1);
    expect(events[0].text).toContain('not permitted for this account');
  });

  it('blocks the same tool in single mode with the identical refusal', async () => {
    await setOrchestrationPolicy(CHILD, { mode: 'single', primaryAgentId: coordId });
    const events = await collect(executeToolStreaming('fixture_blocked_tool', {}, CHILD, coordId, null));
    expect(events).toHaveLength(1);
    expect(events[0].text).toContain('not permitted for this account');
  });

  it('allows an allowed-skill tool through the child gate in single mode', async () => {
    const events = await collect(executeToolStreaming('fixture_allowed_tool', {}, CHILD, coordId, null));
    const text = events.map(e => e.text ?? '').join(' ');
    expect(text).toContain('fixture ok: fixture_allowed_tool');
    expect(text).not.toContain('not permitted for this account');
  });
});

describe('child prompt and containment ride the account into both modes', () => {
  it('single mode: primary gets the child-safety prefix and crossAgentRead null', () => {
    const [primary] = getAgentsForUser(CHILD);
    expect(primary.systemPrompt.startsWith(getDefaultChildSafetyPrompt())).toBe(true);
    expect(primary.crossAgentRead).toBeNull();
  });

  it('ensemble mode: every agent gets the child-safety prefix and crossAgentRead null', async () => {
    await setOrchestrationPolicy(CHILD, { mode: 'ensemble' });
    for (const a of getAgentsForUser(CHILD)) {
      expect(a.systemPrompt.startsWith(getDefaultChildSafetyPrompt())).toBe(true);
      expect(a.crossAgentRead).toBeNull();
    }
  });
});
