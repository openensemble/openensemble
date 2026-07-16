import { describe, expect, it } from 'vitest';
import { buildSandboxArgs } from './skill-sandbox.mjs';

describe('custom-skill Bubblewrap profiles', () => {
  it('keeps the existing private procfs profile by default', () => {
    const args = buildSandboxArgs('/usr/bin/true');
    const proc = args.indexOf('--proc');
    expect(proc).toBeGreaterThanOrEqual(0);
    expect(args.slice(proc, proc + 2)).toEqual(['--proc', '/proc']);
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--unshare-user');
  });

  it('lets the capability-free Docker runner omit procfs without dropping PID isolation', () => {
    const args = buildSandboxArgs('/usr/bin/true', [], { procMount: false, net: false });
    expect(args).not.toContain('--proc');
    expect(args).toContain('--dev');
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--unshare-user');
    expect(args).toContain('--unshare-net');
  });
});
