import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { userSkillsDir } from './paths.mjs';

const childHarness = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('child_process', () => ({ spawn: childHarness.spawn }));
vi.mock('./skill-sandbox.mjs', () => ({
  BWRAP_BIN: '/usr/bin/bwrap',
  sandboxAvailable: vi.fn(() => true),
  buildSandboxArgs: vi.fn(() => ['--mock-sandbox']),
}));

const { runSandboxedJobLocal } = await import('./skill-subprocess.mjs');

const USER = 'skill_subprocess_abort_user';
const SKILL = 'abort-skill';

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 987654321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn((_frame, callback) => callback?.());
  child.kill = vi.fn();
  return child;
}

function prepareSkill() {
  const dir = path.join(userSkillsDir(USER), SKILL);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'execute.mjs'), 'export default async () => null;\n');
}

afterEach(() => {
  vi.restoreAllMocks();
  childHarness.spawn.mockReset();
});

afterAll(() => {
  fs.rmSync(path.join(userSkillsDir(USER), '..'), { recursive: true, force: true });
});

describe('local custom-skill subprocess cancellation', () => {
  it('rejects promptly, kills the process group, and ignores late RPC output', async () => {
    prepareSkill();
    const child = fakeChild();
    childHarness.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const handleRpc = vi.fn(async () => 'late-secret');
    const controller = new AbortController();

    const pending = runSandboxedJobLocal({
      userId: USER,
      skillId: SKILL,
      jobPayload: { t: 'job', mode: 'watcher' },
      handleRpc,
      signal: controller.signal,
      net: true,
    });
    expect(childHarness.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: process.platform !== 'win32' }),
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    if (process.platform !== 'win32') {
      expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    } else {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    }

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      t: 'rpc', id: 'late', method: 'helper.credentials.get', args: ['token'],
    })}\n`));
    await Promise.resolve();
    expect(handleRpc).not.toHaveBeenCalled();
  });

  it('does not spawn when its signal is already aborted', async () => {
    prepareSkill();
    const controller = new AbortController();
    controller.abort();

    await expect(runSandboxedJobLocal({
      userId: USER,
      skillId: SKILL,
      jobPayload: { t: 'job', mode: 'watcher' },
      handleRpc: async () => null,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(childHarness.spawn).not.toHaveBeenCalled();
  });

  it('preserves an authorization abort reason for supervisor revocation', async () => {
    prepareSkill();
    const child = fakeChild();
    childHarness.spawn.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const controller = new AbortController();
    const authorizationError = new Error('managed watcher authorization changed');
    authorizationError.code = 'PREFERENCE_WATCHER_AUTHORIZATION';
    const pending = runSandboxedJobLocal({
      userId: USER,
      skillId: SKILL,
      jobPayload: { t: 'job', mode: 'watcher' },
      handleRpc: async () => null,
      signal: controller.signal,
    });

    controller.abort(authorizationError);
    await expect(pending).rejects.toBe(authorizationError);
  });
});

