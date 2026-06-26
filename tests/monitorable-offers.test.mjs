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
});
