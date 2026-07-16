import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

const { saveUser, getUser } = await import('../routes/_helpers.mjs');
const { createCustomAgent } = await import('../agents.mjs');
const {
  tryAcquireUserTurnLease,
  getUserTopologyState,
} = await import('../chat-dispatch/slot-registry.mjs');
const {
  getOrchestrationPolicy,
  setOrchestrationPolicy,
  stampOrchestrationDefaults,
  handleAgentDeleted,
  completePendingPrimary,
  getRequestedOrchestrationPolicy,
  newAccountOrchestrationPolicy,
  NEW_ACCOUNT_DEFAULT_MODE,
  ORCHESTRATION_MODES,
} = await import('./orchestration-policy.mjs');

const OWNER = 'user_orch_policy_owner';
const OTHER = 'user_orch_policy_other';
let ownerAgentA, ownerAgentB, otherAgent;

function seedUser(id, extra = {}) {
  fs.mkdirSync(path.join(USERS_DIR, id), { recursive: true });
  saveUser({ id, name: id, role: 'user', skills: [], skillAssignments: {}, ...extra });
}

function seedAgent(ownerId, name) {
  return createCustomAgent({
    name, emoji: 'T', description: 'orchestration policy test',
    provider: 'openai', model: 'gpt-4', toolSet: 'web',
    systemPrompt: 'Test agent.', ownerId,
  }).id;
}

beforeAll(() => {
  seedUser(OWNER);
  seedUser(OTHER);
  ownerAgentA = seedAgent(OWNER, 'Orch A');
  ownerAgentB = seedAgent(OWNER, 'Orch B');
  otherAgent = seedAgent(OTHER, 'Orch Foreign');
});

describe('getOrchestrationPolicy — D4 read semantics', () => {
  it('resolves a missing field to ensemble', () => {
    expect(getOrchestrationPolicy(OWNER)).toEqual({ mode: 'ensemble', primaryAgentId: null });
  });

  it('resolves a malformed mode to ensemble', () => {
    seedUser('user_orch_malformed', { orchestration: { mode: 'turbo' } });
    expect(getOrchestrationPolicy('user_orch_malformed').mode).toBe('ensemble');
  });

  it('resolves single-without-primary (hand-edited profile) to ensemble', () => {
    seedUser('user_orch_halfway', { orchestration: { mode: 'single' } });
    expect(getOrchestrationPolicy('user_orch_halfway').mode).toBe('ensemble');
  });

  it('rejects stale and foreign stored primaries at read time', () => {
    seedUser('user_orch_stale', { orchestration: { mode: 'single', primaryAgentId: 'missing_agent' } });
    seedUser('user_orch_foreign', { orchestration: { mode: 'single', primaryAgentId: otherAgent } });
    expect(getOrchestrationPolicy('user_orch_stale')).toEqual({ mode: 'ensemble', primaryAgentId: null });
    expect(getOrchestrationPolicy('user_orch_foreign')).toEqual({ mode: 'ensemble', primaryAgentId: null });
  });

  it('never infers from roster shape: a one-agent user with no policy is still ensemble', () => {
    const id = 'user_orch_oneagent';
    seedUser(id);
    seedAgent(id, 'Only Agent');
    expect(getOrchestrationPolicy(id).mode).toBe('ensemble');
  });

  it('resolves an unknown user to ensemble', () => {
    expect(getOrchestrationPolicy('user_orch_missing').mode).toBe('ensemble');
    expect(getOrchestrationPolicy(null).mode).toBe('ensemble');
  });
});

describe('new-account primary completion', () => {
  it('activates single mode exactly once with the first owned agent', async () => {
    const id = 'user_orch_pending_complete';
    seedUser(id, { orchestration: newAccountOrchestrationPolicy() });
    expect(getRequestedOrchestrationPolicy(id).pendingPrimary).toBe(true);
    expect(getOrchestrationPolicy(id).mode).toBe('ensemble');
    const first = seedAgent(id, 'First Primary');
    expect(await completePendingPrimary(id, first)).toBe(true);
    expect(getOrchestrationPolicy(id)).toEqual({ mode: 'single', primaryAgentId: first });
    const later = seedAgent(id, 'Later Agent');
    expect(await completePendingPrimary(id, later)).toBe(false);
    expect(getOrchestrationPolicy(id).primaryAgentId).toBe(first);
  });

  it('rejects a foreign agent and recovers a one-agent pending account at startup', async () => {
    const id = 'user_orch_pending_recover';
    seedUser(id, { orchestration: newAccountOrchestrationPolicy() });
    expect(await completePendingPrimary(id, otherAgent)).toBe(false);
    const only = seedAgent(id, 'Recovered Primary');
    await stampOrchestrationDefaults();
    expect(getOrchestrationPolicy(id)).toEqual({ mode: 'single', primaryAgentId: only });
  });
});

describe('setOrchestrationPolicy — write validation', () => {
  it('returns a stable busy error instead of racing an active turn', async () => {
    const id = 'user_orch_busy_transition';
    seedUser(id);
    const primary = seedAgent(id, 'Busy Primary');
    const reader = tryAcquireUserTurnLease(id, { allowUpgrade: true, label: 'test-turn' });
    expect(reader).toBeTruthy();
    try {
      await expect(setOrchestrationPolicy(id, { mode: 'single', primaryAgentId: primary }))
        .rejects.toMatchObject({ code: 'ORCHESTRATION_BUSY' });
      expect(getOrchestrationPolicy(id)).toEqual({ mode: 'ensemble', primaryAgentId: null });
      expect(getUserTopologyState(id)).toEqual({ readers: 1, writer: false });
    } finally {
      reader.release();
    }
    expect(getUserTopologyState(id)).toEqual({ readers: 0, writer: false });
  });

  it('rejects an unknown mode', async () => {
    await expect(setOrchestrationPolicy(OWNER, { mode: 'hybrid' })).rejects.toThrow(/Unknown orchestration mode/);
  });

  it('rejects single mode with no primary available', async () => {
    seedUser('user_orch_noprimary');
    await expect(setOrchestrationPolicy('user_orch_noprimary', { mode: 'single' }))
      .rejects.toThrow(/requires primaryAgentId/);
  });

  it("rejects a primaryAgentId the user doesn't own", async () => {
    await expect(setOrchestrationPolicy(OWNER, { mode: 'single', primaryAgentId: otherAgent }))
      .rejects.toThrow(/not an agent owned by/);
    await expect(setOrchestrationPolicy(OWNER, { mode: 'single', primaryAgentId: 'agent_nope' }))
      .rejects.toThrow(/not an agent owned by/);
  });

  it('accepts single mode with an owned agent and reads back verbatim', async () => {
    const p = await setOrchestrationPolicy(OWNER, { mode: 'single', primaryAgentId: ownerAgentA });
    expect(p).toEqual({ mode: 'single', primaryAgentId: ownerAgentA });
    expect(getOrchestrationPolicy(OWNER)).toEqual({ mode: 'single', primaryAgentId: ownerAgentA });
  });

  it('D5: switching to ensemble keeps the stored primary, and switching back restores it', async () => {
    await setOrchestrationPolicy(OWNER, { mode: 'ensemble' });
    expect(getOrchestrationPolicy(OWNER)).toEqual({ mode: 'ensemble', primaryAgentId: ownerAgentA });
    const back = await setOrchestrationPolicy(OWNER, { mode: 'single' });
    expect(back).toEqual({ mode: 'single', primaryAgentId: ownerAgentA });
  });

  it('allows re-pointing the primary explicitly', async () => {
    const p = await setOrchestrationPolicy(OWNER, { mode: 'single', primaryAgentId: ownerAgentB });
    expect(p.primaryAgentId).toBe(ownerAgentB);
  });
});

describe('stampOrchestrationDefaults — D4 startup migration', () => {
  it('stamps ensemble onto profiles missing a valid mode and leaves valid ones alone', async () => {
    seedUser('user_orch_stamp_a');
    seedUser('user_orch_stamp_b', { orchestration: { mode: 'bogus' } });
    const before = getUser(OWNER).orchestration;

    const stamped = await stampOrchestrationDefaults();
    expect(stamped).toBeGreaterThanOrEqual(2);

    expect(getUser('user_orch_stamp_a').orchestration.mode).toBe('ensemble');
    expect(getUser('user_orch_stamp_b').orchestration.mode).toBe('ensemble');
    // Valid single-mode policy untouched by the migration.
    expect(getUser(OWNER).orchestration).toEqual(before);

    // Idempotent: second run stamps nothing.
    expect(await stampOrchestrationDefaults()).toBe(0);
  });
});

describe('handleAgentDeleted — dangling primary cascade', () => {
  it('reverts the owner to ensemble when their primary is deleted', async () => {
    await setOrchestrationPolicy(OWNER, { mode: 'single', primaryAgentId: ownerAgentB });
    expect(await handleAgentDeleted(OWNER, ownerAgentB)).toBe(true);
    expect(getOrchestrationPolicy(OWNER)).toEqual({ mode: 'ensemble', primaryAgentId: null });
  });

  it('is a no-op for a non-primary agent or unaffected user', async () => {
    expect(await handleAgentDeleted(OWNER, ownerAgentA)).toBe(false);
    expect(await handleAgentDeleted(OTHER, ownerAgentA)).toBe(false);
  });
});

describe('constants', () => {
  it('new accounts request single mode while existing accounts migrate independently', () => {
    expect(ORCHESTRATION_MODES).toContain(NEW_ACCOUNT_DEFAULT_MODE);
    expect(NEW_ACCOUNT_DEFAULT_MODE).toBe('single');
  });
});
