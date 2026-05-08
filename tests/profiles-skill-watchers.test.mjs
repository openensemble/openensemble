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
  it('registers a single coalesced watcher when transitioning to reviewed', async () => {
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(0);

    const result = await profilesSkill('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'reviewed',
    }, USER);

    expect(result).toMatch(/now \*\*reviewed\*\*/);
    expect(result).toMatch(/Started health monitor \(2 signals\)/);
    const w = profileWatchers(USER, NODE, 'pihole');
    expect(w).toHaveLength(1);
    expect(w[0].state.signals).toHaveLength(2);
  });

  it('stages an APPROVE PROVEN confirmation before applying proven', async () => {
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER);
    const result = await profilesSkill('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'proven',
    }, USER);
    expect(result).toMatch(/APPROVE PROVEN/);
    // Watcher must not register until the user confirms
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(0);
  });

  it('registers when proven is applied via the confirmed path', async () => {
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER);
    const result = await profilesSkill('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'proven', _userApproved: true,
    }, USER);
    expect(result).toMatch(/Started health monitor \(2 signals\)/);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(1);
  });

  it('unregisters when transitioning back to unverified', async () => {
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER);
    await profilesSkill('profile_set_trust_state', { node_id: NODE, service_id: 'pihole', state: 'reviewed' }, USER);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(1);

    const result = await profilesSkill('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'unverified',
    }, USER);
    expect(result).toMatch(/Stopped health monitor/);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(0);
  });

  it('is idempotent when re-applying the same trust state', async () => {
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: fresh() }, USER);
    await profilesSkill('profile_set_trust_state', { node_id: NODE, service_id: 'pihole', state: 'reviewed' }, USER);
    await profilesSkill('profile_set_trust_state', { node_id: NODE, service_id: 'pihole', state: 'reviewed' }, USER);
    // Tear-down + re-register keeps the count at exactly 1
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(1);
  });

  it('does not start a watcher when profile has no health_signals', async () => {
    const noSignals = fresh();
    noSignals.health_signals = [];
    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: noSignals }, USER);

    const result = await profilesSkill('profile_set_trust_state', {
      node_id: NODE, service_id: 'pihole', state: 'reviewed',
    }, USER);
    expect(result).toMatch(/now \*\*reviewed\*\*/);
    expect(result).not.toMatch(/Started health monitor/);
    expect(profileWatchers(USER, NODE, 'pihole')).toHaveLength(0);
  });
});
