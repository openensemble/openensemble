import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import execute from '../skills/profiles/execute.mjs';
import { nodeDir, profilesDir } from '../lib/op-record.mjs';
import { loadProfile } from '../lib/service-profile.mjs';
import { openIncident } from '../lib/incident.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIHOLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pihole-profile.json'), 'utf8'));

const USER = 'user_skilltest';
const NODE = 'pihole-test';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

const fresh = () => JSON.parse(JSON.stringify(PIHOLE));

describe('profile_save', () => {
  it('persists a valid draft and reports success', async () => {
    const result = await execute('profile_save', {
      node_id: NODE, service_id: 'pihole', profile: fresh(),
    }, USER, null, {});
    expect(result).toMatch(/Saved profile "pihole"/);
    expect(loadProfile(USER, NODE, 'pihole')).toBeTruthy();
  });

  it('returns a clean validation error for malformed profiles', async () => {
    const bad = fresh();
    bad.trust_state = 'magic';
    const result = await execute('profile_save', {
      node_id: NODE, service_id: 'pihole', profile: bad,
    }, USER, null, {});
    expect(result).toMatch(/Validation error/);
    expect(result).toMatch(/trust_state/);
  });

  it('errors when required args missing', async () => {
    expect(await execute('profile_save', { node_id: NODE }, USER, null, {})).toMatch(/Error/);
  });
});

describe('profile_load', () => {
  it('returns JSON by default', async () => {
    await execute('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER, null, {});
    const result = await execute('profile_load', { node_id: NODE, service_id: 'pihole' }, USER, null, {});
    const parsed = JSON.parse(result);
    expect(parsed.service_id).toBe('pihole');
  });

  it('returns Markdown when render=true', async () => {
    await execute('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER, null, {});
    const result = await execute('profile_load', { node_id: NODE, service_id: 'pihole', render: true }, USER, null, {});
    expect(result).toContain('# pihole on pihole-test');
    expect(result).toContain('## Operations');
  });

  it('reports unknown service cleanly', async () => {
    expect(await execute('profile_load', { node_id: NODE, service_id: 'nope' }, USER, null, {}))
      .toMatch(/No profile found/);
  });
});

describe('profile_list', () => {
  it('lists saved profiles with summary line', async () => {
    await execute('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER, null, {});
    const result = await execute('profile_list', { node_id: NODE }, USER, null, {});
    expect(result).toContain('pihole');
    expect(result).toContain('unverified');
    expect(result).toMatch(/0\/5 ops verified/);
  });

  it('reports empty cleanly', async () => {
    expect(await execute('profile_list', { node_id: NODE }, USER, null, {}))
      .toMatch(/No profiles saved/);
  });
});

describe('profile_set_trust_state', () => {
  it('updates trust state', async () => {
    await execute('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER, null, {});
    const result = await execute('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'reviewed',
    }, USER, null, {});
    expect(result).toMatch(/now \*\*reviewed\*\*/);
    expect(loadProfile(USER, NODE, 'pihole').trust_state).toBe('reviewed');
  });

  it('errors on invalid state', async () => {
    await execute('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER, null, {});
    const result = await execute('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'magic',
    }, USER, null, {});
    expect(result).toMatch(/Error/);
  });
});

describe('profile_verify_readonly', () => {
  it('reports a clear error when no auth token resolves', async () => {
    await execute('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER, null, {});
    const result = await execute('profile_verify_readonly', {
      node_id: NODE, service_id: 'pihole',
    }, USER, null, {});
    expect(result).toMatch(/no token resolved/);
  });
});

describe('incident_list', () => {
  it('reports empty cleanly', async () => {
    expect(await execute('incident_list', { node_id: NODE }, USER, null, {}))
      .toMatch(/No.*incidents/);
  });

  it('lists incidents most-recent first', async () => {
    openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'service_up', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
    });
    const result = await execute('incident_list', { node_id: NODE }, USER, null, {});
    expect(result).toMatch(/inc_/);
    expect(result).toMatch(/service_up/);
  });

  it('respects open_only', async () => {
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'k', value: 'v', expected: 'e', fired_at: new Date().toISOString() },
    });
    const { closeIncident } = await import('../lib/incident.mjs');
    closeIncident(USER, NODE, inc.id, 'fixed');

    const all = await execute('incident_list', { node_id: NODE }, USER, null, {});
    expect(all).toContain(inc.id);

    const openOnly = await execute('incident_list', { node_id: NODE, open_only: true }, USER, null, {});
    expect(openOnly).toMatch(/No open incidents/);
  });
});

describe('unknown tool', () => {
  it('reports unknown tool gracefully', async () => {
    expect(await execute('not_a_tool', {}, USER, null, {})).toMatch(/Unknown tool/);
  });
});
