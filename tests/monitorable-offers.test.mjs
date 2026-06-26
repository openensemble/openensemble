import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';

const USER = 'user_monitorable_offer_test';
const AGENT = 'coordinator';

function cleanupUser() {
  const dir = path.join(USERS_DIR, USER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => cleanupUser());
afterAll(() => cleanupUser());

describe('monitorable offer ledger', () => {
  it('asks once, then escalates repeated monitorable topics to a watch proposal', async () => {
    const { recordMonitorableHit } = await import('../lib/monitorable-classifier.mjs');
    const { getProposal } = await import('../lib/proposals.mjs');
    const hit = { monitorable: true, score: 0.8, matched: 'is the item back in stock' };

    const first = await recordMonitorableHit({
      userId: USER,
      agentId: AGENT,
      userText: 'Is the item back in stock?',
      hit,
    });
    expect(first).toMatchObject({ action: 'ask', count: 1 });

    const second = await recordMonitorableHit({
      userId: USER,
      agentId: AGENT,
      userText: 'Is the item back in stock?',
      hit,
    });
    expect(second.action).toBe('proposal');
    expect(second.proposalId).toBeTruthy();
    expect(getProposal(second.proposalId)).toMatchObject({
      kind: 'watch',
      evidenceCount: 2,
      status: 'pending',
    });
  });

  it('prunes stale topics on write but keeps ones with a live proposal', async () => {
    const { recordMonitorableHit } = await import('../lib/monitorable-classifier.mjs');
    const userDir = path.join(USERS_DIR, USER);
    fs.mkdirSync(userDir, { recursive: true });
    const offersPath = path.join(userDir, 'monitorable-offers.json');
    const now = Date.now();
    const FORTY_DAYS = 40 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(offersPath, JSON.stringify({
      topics: {
        'old stale topic': { count: 1, firstSeenAt: now - FORTY_DAYS, lastSeenAt: now - FORTY_DAYS, lastAskedAt: now - FORTY_DAYS, proposalId: null },
        'old but proposed': { count: 3, firstSeenAt: now - FORTY_DAYS, lastSeenAt: now - FORTY_DAYS, lastAskedAt: now - FORTY_DAYS, proposalId: 'p_keepme' },
      },
    }, null, 2));

    // Any monitorable hit triggers a write, which prunes the ledger.
    await recordMonitorableHit({
      userId: USER,
      agentId: AGENT,
      userText: 'Any new videos on that channel?',
      hit: { monitorable: true, score: 0.8, matched: 'are there new videos on that youtube channel' },
    });

    const after = JSON.parse(fs.readFileSync(offersPath, 'utf8'));
    expect(after.topics['old stale topic']).toBeUndefined();  // stale + no proposal → pruned
    expect(after.topics['old but proposed']).toBeDefined();    // live proposal → kept despite age
    expect(Object.keys(after.topics).length).toBe(2);          // kept proposal + the fresh hit
  });
});
