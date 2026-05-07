/**
 * Tests for auto-registration of health watchers on profile_set_trust_state.
 *
 * Going to reviewed/proven → watchers start.
 * Going back to unverified → watchers stop.
 * The result message includes the count for transparency.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import profilesSkill from '../skills/profiles/execute.mjs';
import { listWatchers, unregisterWatcher } from '../scheduler/watchers.mjs';
import { nodeDir } from '../lib/op-record.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIHOLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pihole-profile.json'), 'utf8'));

const USER = 'user_autowatch';
const NODE = 'pihole-test';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  // Wipe any stray watchers
  const w = listWatchers(USER);
  for (const x of [...w.active, ...w.recent]) unregisterWatcher(USER, x.id, 'test-cleanup');
});

const fresh = () => JSON.parse(JSON.stringify(PIHOLE));

function profileWatchers(userId, nodeId, serviceId) {
  return listWatchers(userId).active.filter(
    w => w.kind === 'profile_health' &&
         w.state.node_id === nodeId &&
         w.state.service_id === serviceId,
  );
}

describe('profile_set_trust_state auto-watcher management', () => {
  it('registers watchers when transitioning to reviewed', async () => {
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(0);

    const result = await profilesSkill('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'reviewed',
    }, USER);

    expect(result).toMatch(/now \*\*reviewed\*\*/);
    expect(result).toMatch(/Started 2 health watchers/);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(2);
  });

  it('also registers watchers when transitioning to proven', async () => {
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER);
    const result = await profilesSkill('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'proven',
    }, USER);
    expect(result).toMatch(/Started 2 health watchers/);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(2);
  });

  it('unregisters watchers when transitioning back to unverified', async () => {
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER);
    await profilesSkill('profile_set_trust_state', { node_id: NODE, service_id: 'pihole', state: 'reviewed' }, USER);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(2);

    const result = await profilesSkill('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'unverified',
    }, USER);
    expect(result).toMatch(/Stopped 2 health watchers/);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(0);
  });

  it('is idempotent when re-applying the same trust state', async () => {
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER);
    await profilesSkill('profile_set_trust_state', { node_id: NODE, service_id: 'pihole', state: 'reviewed' }, USER);
    await profilesSkill('profile_set_trust_state', { node_id: NODE, service_id: 'pihole', state: 'reviewed' }, USER);
    // Tear-down + re-register keeps the count at 2
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(2);
  });

  it('does not start watchers when profile has no health_signals', async () => {
    const noSignals = fresh();
    noSignals.health_signals = [];
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: noSignals }, USER);

    const result = await profilesSkill('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'reviewed',
    }, USER);
    expect(result).toMatch(/now \*\*reviewed\*\*/);
    expect(result).not.toMatch(/Started \d+ health watcher/);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(0);
  });
});
