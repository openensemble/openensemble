import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runBinaryInsideSkillJail,
  validateJailedSkillBinary,
} from './skill-jail-runtime.mjs';

const roots = [];
afterAll(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

function fixture(source) {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-jailed-runtime-test-'));
  roots.push(skillDir);
  const binDir = path.join(skillDir, 'bin');
  fs.mkdirSync(binDir, { mode: 0o700 });
  const bin = path.join(binDir, 'fixture');
  fs.writeFileSync(bin, source, { mode: 0o700 });
  return { skillDir, bin };
}

describe('external runtime inside the dedicated skill jail', () => {
  it('runs only a real skill-owned binary with a cleared environment', async () => {
    const { skillDir, bin } = fixture('#!/bin/sh\nprintf "%s|%s" "$SAFE_VALUE" "${LEAK_ME-unset}"\n');
    const old = process.env.LEAK_ME;
    process.env.LEAK_ME = 'must-not-cross';
    try {
      expect(validateJailedSkillBinary(skillDir, bin)).toBe(bin);
      const result = await runBinaryInsideSkillJail(skillDir, bin, [], {
        env: { SAFE_VALUE: 'explicit' },
        timeoutMs: 2_000,
      });
      expect(result).toEqual({ code: 0, stdout: 'explicit|unset', stderr: '' });
    } finally {
      if (old == null) delete process.env.LEAK_ME;
      else process.env.LEAK_ME = old;
    }
  });

  it('rejects outside paths and symlinks', () => {
    const { skillDir, bin } = fixture('#!/bin/sh\nexit 0\n');
    const linked = path.join(skillDir, 'bin', 'linked');
    fs.symlinkSync(bin, linked);
    expect(() => validateJailedSkillBinary(skillDir, '/usr/bin/true')).toThrow(/outside/);
    expect(() => validateJailedSkillBinary(skillDir, linked)).toThrow(/outside/);
  });

  it('passes explicit trusted runtime environment values after clearing inherited env', async () => {
    const { skillDir, bin } = fixture('#!/bin/sh\nprintf "%s|%s" "$NODE_OPTIONS" "$LD_LIBRARY_PATH"\n');
    const result = await runBinaryInsideSkillJail(skillDir, bin, [], {
      env: { NODE_OPTIONS: '--trace-warnings', LD_LIBRARY_PATH: '/skill/lib' },
    });
    expect(result.stdout).toBe('--trace-warnings|/skill/lib');
  });

  it('kills an over-time binary', async () => {
    const { skillDir, bin } = fixture('#!/bin/sh\nsleep 2\n');
    await expect(runBinaryInsideSkillJail(skillDir, bin, [], { timeoutMs: 50 }))
      .rejects.toThrow(/timed out/);
  });

  it('retains the stock large-output default for yt-dlp-sized results', async () => {
    const { skillDir, bin } = fixture('#!/bin/sh\nhead -c 2097152 /dev/zero\n');
    const result = await runBinaryInsideSkillJail(skillDir, bin);
    expect(Buffer.byteLength(result.stdout)).toBe(2 * 1024 * 1024);
  });

  it('still honors an explicit caller output ceiling', async () => {
    const { skillDir, bin } = fixture('#!/bin/sh\nhead -c 2048 /dev/zero\n');
    await expect(runBinaryInsideSkillJail(skillDir, bin, [], { maxStdoutBytes: 1024 }))
      .rejects.toThrow(/output exceeded 1024 bytes/);
  });
});
