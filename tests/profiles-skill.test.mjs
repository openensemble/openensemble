import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import execute from '../skills/profiles/execute.mjs';
import { nodeDir, profilesDir } from '../lib/op-record.mjs';
import { loadProfile } from '../lib/service-profile.mjs';
import { openIncident, loadIncident } from '../lib/incident.mjs';

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

describe('profile_patch', () => {
  beforeEach(async () => {
    await execute('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER, null, {});
  });

  it('applies a single set edit to a nested array path', async () => {
    const result = await execute('profile_patch', {
      node_id: NODE, service_id: 'pihole',
      edits: [{ op: 'set', path: 'health_signals[0].expect', value: { contains: 'active' } }],
    }, USER, null, {});
    expect(result).toMatch(/applied 1 edit/);
    const p = loadProfile(USER, NODE, 'pihole');
    expect(p.health_signals[0].expect).toEqual({ contains: 'active' });
  });

  it('applies multiple edits in one call (set + remove)', async () => {
    const result = await execute('profile_patch', {
      node_id: NODE, service_id: 'pihole',
      edits: [
        { op: 'set',    path: 'health_signals[0].cadence_sec', value: 30 },
        { op: 'set',    path: 'known_quirks',                  value: ['quirk-a', 'quirk-b'] },
        { op: 'remove', path: 'health_signals[1]' },
      ],
    }, USER, null, {});
    expect(result).toMatch(/applied 3 edits/);
    const p = loadProfile(USER, NODE, 'pihole');
    expect(p.health_signals[0].cadence_sec).toBe(30);
    expect(p.known_quirks).toEqual(['quirk-a', 'quirk-b']);
    expect(p.health_signals).toHaveLength(1); // pihole fixture has 2; we removed [1]
  });

  it('rolls back atomically when an edit produces an invalid profile', async () => {
    const before = loadProfile(USER, NODE, 'pihole');
    const result = await execute('profile_patch', {
      node_id: NODE, service_id: 'pihole',
      edits: [
        { op: 'set', path: 'health_signals[0].cadence_sec', value: 99 }, // valid
        { op: 'set', path: 'trust_state', value: 'totally-bogus' },       // invalid
      ],
    }, USER, null, {});
    expect(result).toMatch(/Validation error/);
    expect(result).toMatch(/Original profile preserved/);
    const after = loadProfile(USER, NODE, 'pihole');
    expect(after).toEqual(before); // unchanged on disk
  });

  it('errors on missing or empty edits', async () => {
    expect(await execute('profile_patch', { node_id: NODE, service_id: 'pihole' }, USER, null, {})).toMatch(/Error/);
    expect(await execute('profile_patch', { node_id: NODE, service_id: 'pihole', edits: [] }, USER, null, {})).toMatch(/Error/);
  });

  it('errors clearly on a bad path', async () => {
    const result = await execute('profile_patch', {
      node_id: NODE, service_id: 'pihole',
      edits: [{ op: 'set', path: 'health_signals[notanumber].expect', value: 'x' }],
    }, USER, null, {});
    expect(result).toMatch(/Error/);
    expect(result).toMatch(/edit #1/);
  });

  it('errors when patching a profile that does not exist', async () => {
    const result = await execute('profile_patch', {
      node_id: NODE, service_id: 'never-saved',
      edits: [{ op: 'set', path: 'trust_state', value: 'reviewed' }],
    }, USER, null, {});
    expect(result).toMatch(/Error/);
    expect(result).toMatch(/no profile/);
  });

  it('auto-refreshes the live watcher when health_signals are patched on a reviewed profile', async () => {
    const { listWatchers, unregisterWatcher } = await import('../scheduler/watchers.mjs');
    // Ensure we start clean so the watcher we observe came from this test.
    for (const x of [...listWatchers(USER).active, ...listWatchers(USER).recent]) {
      unregisterWatcher(USER, x.id, 'cleanup');
    }
    // Save + review so a watcher is registered, then patch.
    await execute('profile_set_trust_state', { node_id: NODE, service_id: 'pihole', state: 'reviewed' }, USER, null, {});
    const beforeWatchers = listWatchers(USER).active.filter(w => w.kind === 'profile_health' && w.state.service_id === 'pihole');
    expect(beforeWatchers).toHaveLength(1);
    const oldWatcherId = beforeWatchers[0].id;

    const result = await execute('profile_patch', {
      node_id: NODE, service_id: 'pihole',
      edits: [{ op: 'set', path: 'health_signals[0].cadence_sec', value: 30 }],
    }, USER, null, {});
    expect(result).toMatch(/Health monitor refreshed/);

    const afterWatchers = listWatchers(USER).active.filter(w => w.kind === 'profile_health' && w.state.service_id === 'pihole');
    expect(afterWatchers).toHaveLength(1);
    expect(afterWatchers[0].id).not.toBe(oldWatcherId); // fresh watcher, not the stale one
    expect(afterWatchers[0].state.signals[0].cadence_sec).toBe(30); // new value picked up
  });

  it('does NOT refresh the watcher when patching a non-signal field', async () => {
    await execute('profile_set_trust_state', { node_id: NODE, service_id: 'pihole', state: 'reviewed' }, USER, null, {});
    const result = await execute('profile_patch', {
      node_id: NODE, service_id: 'pihole',
      edits: [{ op: 'set', path: 'detected_version', value: '6.0.0' }],
    }, USER, null, {});
    expect(result).not.toMatch(/Health monitor refreshed/);
  });

  it('does NOT refresh the watcher when profile is unverified (no monitoring active)', async () => {
    // Save without setting trust state — defaults to unverified.
    const result = await execute('profile_patch', {
      node_id: NODE, service_id: 'pihole',
      edits: [{ op: 'set', path: 'health_signals[0].cadence_sec', value: 30 }],
    }, USER, null, {});
    expect(result).not.toMatch(/Health monitor refreshed/);
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

describe('incident_resolve', () => {
  it('closes an open incident with default resolved status', async () => {
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'service_up', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
    });
    const result = await execute('incident_resolve', {
      node_id: NODE, incident_id: inc.id, summary: 'manual close',
    }, USER, null, {});
    expect(result).toMatch(/Closed incident/);
    expect(result).toMatch(/resolved/);
    const reloaded = loadIncident(USER, NODE, inc.id);
    expect(reloaded.status).toBe('resolved');
    expect(reloaded.ts_closed).toBeTruthy();
  });

  it('supports the abandoned status', async () => {
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'k', value: 'v', expected: 'e', fired_at: new Date().toISOString() },
    });
    const result = await execute('incident_resolve', {
      node_id: NODE, incident_id: inc.id, summary: 'false positive', status: 'abandoned',
    }, USER, null, {});
    expect(result).toMatch(/abandoned/);
    expect(loadIncident(USER, NODE, inc.id).status).toBe('abandoned');
  });

  it('rejects an invalid status', async () => {
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'k', value: 'v', expected: 'e', fired_at: new Date().toISOString() },
    });
    const result = await execute('incident_resolve', {
      node_id: NODE, incident_id: inc.id, status: 'magic',
    }, USER, null, {});
    expect(result).toMatch(/Error/);
    expect(loadIncident(USER, NODE, inc.id).status).toBe('open');
  });

  it('reports already-closed without changing the incident', async () => {
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'k', value: 'v', expected: 'e', fired_at: new Date().toISOString() },
    });
    await execute('incident_resolve', { node_id: NODE, incident_id: inc.id }, USER, null, {});
    const result = await execute('incident_resolve', { node_id: NODE, incident_id: inc.id }, USER, null, {});
    expect(result).toMatch(/already closed/);
  });

  it('errors when the incident does not exist', async () => {
    expect(await execute('incident_resolve', {
      node_id: NODE, incident_id: 'inc_nonexistent_xxx',
    }, USER, null, {})).toMatch(/not found/);
  });

  it('errors on missing args', async () => {
    expect(await execute('incident_resolve', { node_id: NODE }, USER, null, {})).toMatch(/Error/);
  });
});

describe('unknown tool', () => {
  it('reports unknown tool gracefully', async () => {
    expect(await execute('not_a_tool', {}, USER, null, {})).toMatch(/Unknown tool/);
  });
});
