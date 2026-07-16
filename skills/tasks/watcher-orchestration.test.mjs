import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { USERS_DIR } from '../../lib/paths.mjs';

const { saveUser } = await import('../../routes/_helpers.mjs');
const { createCustomAgent } = await import('../../agents.mjs');
const { setOrchestrationPolicy } = await import('../../lib/orchestration-policy.mjs');
const { getWatcher, registerWatcher } = await import('../../scheduler/watchers.mjs');
const { default: executeTasksTool } = await import('./execute.mjs');

const USER = 'user_tasks_watcher_orchestration';
let ensembleCoordinator;
let singlePrimary;
let updateWatcherId;
let cancelWatcherId;

function createAgent(name) {
  return createCustomAgent({
    name,
    emoji: 'T',
    description: 'watcher control fixture',
    provider: 'openai',
    model: 'gpt-4',
    toolSet: 'none',
    systemPrompt: 'Watcher control test agent.',
    ownerId: USER,
  }).id;
}

function createCoordinatorWatcher(label) {
  return registerWatcher({
    userId: USER,
    agentId: `${USER}_coordinator`,
    kind: 'fixture_orchestration_control',
    label,
    expiresAt: null,
    state: {},
    onFire: { type: 'notify' },
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(USERS_DIR, USER), { recursive: true });
  saveUser({ id: USER, name: 'Watcher Control', role: 'user', skills: [], skillAssignments: {} });
  ensembleCoordinator = createAgent('Watcher Control Coordinator');
  singlePrimary = createAgent('Watcher Control Primary');
  saveUser({
    id: USER,
    name: 'Watcher Control',
    role: 'user',
    skills: [],
    skillAssignments: { coordinator: ensembleCoordinator },
    orchestration: { mode: 'ensemble' },
  });
  updateWatcherId = createCoordinatorWatcher('Update fixture');
  cancelWatcherId = createCoordinatorWatcher('Cancel fixture');
});

describe('single-mode primary controls projected durable watchers', () => {
  it('denies cross-agent mutation in ensemble, allows it in single, and preserves storage', async () => {
    const caller = `${USER}_${singlePrimary}`;
    const denied = await executeTasksTool(
      'update_watch',
      { id: updateWatcherId, label: 'Denied ensemble update' },
      USER,
      caller,
    );
    expect(denied).toMatch(/^Permission denied:/);

    await setOrchestrationPolicy(USER, { mode: 'single', primaryAgentId: singlePrimary });
    const updated = await executeTasksTool(
      'update_watch',
      { id: updateWatcherId, label: 'Updated by single primary' },
      USER,
      caller,
    );
    expect(updated).toContain('Updated');
    expect(getWatcher(USER, updateWatcherId)).toMatchObject({
      label: 'Updated by single primary',
      agentId: `${USER}_coordinator`,
    });
    const status = await executeTasksTool('autonomy_status', {}, USER, caller);
    expect(status).toContain('This agent owns 2 active watcher(s).');

    const cancelled = await executeTasksTool('cancel_watch', { id: cancelWatcherId }, USER, caller);
    expect(cancelled).toContain('cancelled');
    expect(getWatcher(USER, cancelWatcherId)).toMatchObject({
      status: 'cancelled',
      agentId: `${USER}_coordinator`,
    });

    await setOrchestrationPolicy(USER, { mode: 'ensemble' });
    const deniedAgain = await executeTasksTool(
      'update_watch',
      { id: updateWatcherId, label: 'Denied after switch-back' },
      USER,
      caller,
    );
    expect(deniedAgain).toMatch(/^Permission denied:/);
    expect(getWatcher(USER, updateWatcherId).label).toBe('Updated by single primary');
  });
});
