import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

const sandbox = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./skill-subprocess.mjs', () => ({
  runSandboxedJob: sandbox.run,
}));

const { runSkillSmoke } = await import('./skill-smoke.mjs');
const { mayImportCustomCodeInProcess } = await import('./custom-code-policy.mjs');
const {
  PLUGINS_DIR,
  delegateDrawerRequest,
  registerDrawerManifest,
  unregisterDrawerManifest,
} = await import('../plugins.mjs');
const { createDrawerForSkill } = await import('../skills/skill-builder/execute.mjs');

const users = new Set();
const plugins = new Set();
const globals = new Set();

function seedProfile(userId, profile) {
  const dir = path.join(USERS_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ id: userId, name: userId, ...profile }));
  users.add(userId);
}

function corruptProfile(userId) {
  const dir = path.join(USERS_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), '{not-json');
  users.add(userId);
}

function writeSkill(userId, skillId, marker) {
  const dir = path.join(USERS_DIR, userId, 'skills', skillId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'execute.mjs'), `
globalThis[${JSON.stringify(marker)}] = (globalThis[${JSON.stringify(marker)}] || 0) + 1;
export async function executeSkillTool(name, args, userId, agentId, ctx) {
  if (name === '__unknown_tool_check__') return null;
  if (name === 'fixture_tool') return 'ok';
  return null;
}
`);
  users.add(userId);
  globals.add(marker);
  return dir;
}

function manifest(skillId) {
  return {
    id: skillId,
    custom: true,
    sandbox: { isolate: false },
    tools: [{
      type: 'function',
      function: {
        name: 'fixture_tool',
        description: 'fixture',
        parameters: { type: 'object', properties: {} },
      },
    }],
  };
}

function writeDrawer(pluginId, source) {
  const dir = path.join(PLUGINS_DIR, pluginId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.mjs'), source);
  plugins.add(pluginId);
  return dir;
}

beforeEach(() => {
  sandbox.run.mockReset();
  sandbox.run.mockResolvedValue({
    ok: true,
    result: { ok: true, results: [{ tool: 'fixture_tool', outcome: 'pass', durationMs: 0 }] },
  });
});

afterEach(() => {
  for (const userId of users) fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  users.clear();
  for (const pluginId of plugins) {
    unregisterDrawerManifest(pluginId);
    fs.rmSync(path.join(PLUGINS_DIR, pluginId), { recursive: true, force: true });
  }
  plugins.clear();
  for (const marker of globals) delete globalThis[marker];
  globals.clear();
});

describe('custom-skill smoke import boundary', () => {
  it.each([
    ['child account', 'child', 'valid'],
    ['missing profile', 'user', 'missing'],
    ['unreadable profile', 'user', 'malformed'],
  ])('forces %s through the subprocess even when manifest opts out', async (_label, role, profileState) => {
    const nonce = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const userId = `smoke_${nonce}`;
    const skillId = `fixture-${nonce.replaceAll('_', '-')}`;
    const marker = `__oe_smoke_import_${nonce}`;
    if (profileState === 'valid') {
      seedProfile(userId, { role, skills: [skillId], allowedSkills: [skillId] });
    } else if (profileState === 'malformed') {
      corruptProfile(userId);
    } else {
      users.add(userId);
    }
    const skillDir = writeSkill(userId, skillId, marker);

    const report = await runSkillSmoke(skillDir, manifest(skillId), { userId });

    expect(report.ok).toBe(true);
    expect(sandbox.run).toHaveBeenCalledOnce();
    expect(globalThis[marker]).toBeUndefined();
  });

  it('preserves the explicit in-process path for a trusted owner', async () => {
    const nonce = `${process.pid}_${Date.now()}`;
    const userId = `owner_smoke_${nonce}`;
    const skillId = `owner-smoke-${nonce}`;
    const marker = `__oe_owner_smoke_${nonce}`;
    seedProfile(userId, { role: 'owner', skills: [skillId] });
    const skillDir = writeSkill(userId, skillId, marker);

    const report = await runSkillSmoke(skillDir, manifest(skillId), { userId });

    expect(report.ok).toBe(true);
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(globalThis[marker]).toBe(1);
  });

  it('uses custom-skill ownership rather than a privileged editor identity', async () => {
    const nonce = `${process.pid}_${Date.now()}`;
    const childId = `child_owned_smoke_${nonce}`;
    const adminId = `admin_editing_smoke_${nonce}`;
    const skillId = `child-owned-${nonce}`;
    const marker = `__oe_child_owned_smoke_${nonce}`;
    seedProfile(childId, { role: 'child', skills: [skillId], allowedSkills: [skillId] });
    seedProfile(adminId, { role: 'admin', skills: [] });
    const skillDir = writeSkill(childId, skillId, marker);
    const childManifest = { ...manifest(skillId), createdBy: childId };

    const report = await runSkillSmoke(skillDir, childManifest, { userId: adminId });

    expect(report.ok).toBe(true);
    expect(sandbox.run).toHaveBeenCalledOnce();
    expect(sandbox.run).toHaveBeenCalledWith(expect.objectContaining({ userId: childId, skillId }));
    expect(globalThis[marker]).toBeUndefined();
  });
});

describe('custom drawer server import boundary', () => {
  it('rejects child drawer serverCode before writing or sanity-importing it', async () => {
    const nonce = `${process.pid}_${Date.now()}`;
    const userId = `drawer_child_${nonce}`;
    const skillId = `drawer-skill-${nonce}`;
    const pluginId = `drawer_child_plugin_${nonce}`;
    const marker = `__oe_drawer_create_${nonce}`;
    seedProfile(userId, { role: 'child', skills: [skillId], allowedSkills: [skillId] });
    globals.add(marker);
    plugins.add(pluginId);

    const error = await createDrawerForSkill(pluginId, 'Fixture', 'F', userId, skillId, {
      html: '<div>fixture</div>',
      serverCode: `globalThis[${JSON.stringify(marker)}] = true; export async function handleRequest() { return false; }`,
    });

    expect(error).toMatch(/serverCode is unavailable/i);
    expect(fs.existsSync(path.join(PLUGINS_DIR, pluginId))).toBe(false);
    expect(globalThis[marker]).toBeUndefined();
  });

  it.each([
    ['missing', false],
    ['unreadable', true],
  ])('does not lazy-import a custom handler whose owner profile is %s', async (_label, malformed) => {
    const nonce = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const userId = `drawer_missing_${nonce}`;
    const skillId = `drawer-skill-${nonce}`;
    const pluginId = `drawer_missing_plugin_${nonce}`;
    const marker = `__oe_drawer_missing_${nonce}`;
    if (malformed) corruptProfile(userId);
    else users.add(userId);
    globals.add(marker);
    writeDrawer(pluginId, `
globalThis[${JSON.stringify(marker)}] = true;
export async function handleRequest() { return false; }
`);
    registerDrawerManifest({ id: pluginId, custom: true, createdBy: userId, skillId });

    await expect(delegateDrawerRequest({}, {}, { userId })).resolves.toBe(false);
    expect(globalThis[marker]).toBeUndefined();
  });

  it('re-checks authorization before invoking a cached custom handler', async () => {
    const nonce = `${process.pid}_${Date.now()}`;
    const userId = `drawer_revoke_${nonce}`;
    const skillId = `drawer-skill-${nonce}`;
    const pluginId = `drawer_revoke_plugin_${nonce}`;
    const marker = `__oe_drawer_revoke_${nonce}`;
    seedProfile(userId, { role: 'user', skills: [skillId], allowedSkills: [skillId] });
    globals.add(marker);
    writeDrawer(pluginId, `
globalThis[${JSON.stringify(marker)}] = (globalThis[${JSON.stringify(marker)}] || 0) + 1;
export async function handleRequest() {
  globalThis[${JSON.stringify(marker)}] += 10;
  return false;
}
`);
    registerDrawerManifest({ id: pluginId, custom: true, createdBy: userId, skillId });

    await expect(delegateDrawerRequest({}, {}, { userId })).resolves.toBe(false);
    expect(globalThis[marker]).toBe(11);

    seedProfile(userId, { role: 'child', skills: [skillId], allowedSkills: [skillId] });
    await expect(delegateDrawerRequest({}, {}, { userId })).resolves.toBe(false);
    expect(globalThis[marker]).toBe(11);
  });

  it('fails closed for malformed managed-account restrictions', () => {
    const nonce = `${process.pid}_${Date.now()}`;
    const userId = `drawer_managed_${nonce}`;
    const skillId = `drawer-skill-${nonce}`;
    seedProfile(userId, { role: 'user', skills: [skillId], allowedSkills: 'not-an-array' });
    expect(mayImportCustomCodeInProcess(userId, skillId)).toBe(false);
  });
});
