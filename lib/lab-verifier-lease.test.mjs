import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertActiveLabVerifierLeaseToken,
  assertLabVerifierLease,
  inspectLabVerifierLease,
} from './lab-verifier-lease.mjs';

const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);
let dir;
let leaseFile;
let priorLab;
let priorLeasePath;

function writeLease(overrides = {}) {
  fs.writeFileSync(leaseFile, JSON.stringify({
    version: 1,
    runTag: 'real_router_1700000000000_aaaaaaaa',
    token: TOKEN,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }), { mode: 0o600 });
  fs.chmodSync(leaseFile, 0o600);
}

beforeEach(() => {
  priorLab = process.env.OPENENSEMBLE_LAB;
  priorLeasePath = process.env.OE_LAB_VERIFIER_LEASE_PATH;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-lab-lease-'));
  leaseFile = path.join(dir, 'lease.json');
  process.env.OPENENSEMBLE_LAB = '1';
  process.env.OE_LAB_VERIFIER_LEASE_PATH = leaseFile;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (priorLab == null) delete process.env.OPENENSEMBLE_LAB;
  else process.env.OPENENSEMBLE_LAB = priorLab;
  if (priorLeasePath == null) delete process.env.OE_LAB_VERIFIER_LEASE_PATH;
  else process.env.OE_LAB_VERIFIER_LEASE_PATH = priorLeasePath;
});

describe('isolated lab verifier lease', () => {
  it('authenticates only the matching bounded capability', () => {
    writeLease();
    expect(inspectLabVerifierLease(TOKEN)).toBe('active');
    expect(inspectLabVerifierLease(OTHER_TOKEN)).toBe('mismatch');
    expect(assertLabVerifierLease({ leaseToken: TOKEN }, 'lab-verifier')).toBe(true);
    expect(() => assertActiveLabVerifierLeaseToken(OTHER_TOKEN))
      .toThrow(expect.objectContaining({ code: 'LAB_VERIFIER_LEASE_INVALID' }));
  });

  it('distinguishes absence from invalid or expired lease state', () => {
    expect(inspectLabVerifierLease(TOKEN)).toBe('absent');
    expect(() => assertLabVerifierLease({ leaseToken: TOKEN }, 'lab-verifier'))
      .toThrow(/without an active exclusive verifier lease/);

    writeLease({ expiresAt: Date.now() - 1 });
    expect(inspectLabVerifierLease(TOKEN)).toBe('invalid');
    expect(() => assertLabVerifierLease({ leaseToken: TOKEN }, 'lab-verifier'))
      .toThrow(/invalid or expired/);
  });

  it('rejects broad permissions and symlink replacement without reading through either', () => {
    writeLease();
    fs.chmodSync(leaseFile, 0o644);
    expect(inspectLabVerifierLease(TOKEN)).toBe('invalid');

    const target = path.join(dir, 'target.json');
    fs.renameSync(leaseFile, target);
    fs.chmodSync(target, 0o600);
    fs.symlinkSync(target, leaseFile);
    expect(inspectLabVerifierLease(TOKEN)).toBe('invalid');
  });
});
