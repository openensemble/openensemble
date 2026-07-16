import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workerScenarios: [],
  primaryCalls: [],
  primaryFailures: 0,
  sessions: new Map(),
  runtimeAgentByUser: new Map(),
  failReportIds: new Set(),
  sendToUser: vi.fn(() => 0),
  appendTaskOutcome: vi.fn(async () => {}),
  completeWatcher: vi.fn(),
}));

function session(agentId) {
  const rows = mocks.sessions.get(agentId) || [];
  mocks.sessions.set(agentId, rows);
  return rows;
}

vi.mock('./scheduler/watchers.mjs', () => ({
  registerWatcher: vi.fn(() => `watcher_${Math.random().toString(36).slice(2, 8)}`),
  pushWatcherStatus: vi.fn(),
  completeWatcher: mocks.completeWatcher,
}));
vi.mock('./lib/tool-plan-memory.mjs', () => ({
  learnToolPlanFromToolEvents: vi.fn(() => []),
  matchToolPlan: vi.fn(() => null),
}));
vi.mock('./lib/scheduled-child-barrier.mjs', () => ({
  registerScheduledChild: vi.fn(),
  completeScheduledChild: vi.fn(),
}));
vi.mock('./lib/task-outcomes.mjs', () => ({
  appendTaskOutcome: mocks.appendTaskOutcome,
  loadTaskOutcomes: vi.fn(() => []),
}));
// The routes helper barrel may be evaluated by concurrent dynamic imports
// before Vitest substitutes the direct mock below. Keep its heavyweight
// resolver dependencies inert so this lifecycle test never needs MCP/mDNS.
vi.mock('./lib/mcp-tools.mjs', () => ({
  getCachedMcpToolDefsForAgent: vi.fn(() => []),
  getCachedMcpToolDefsForAgents: vi.fn(() => new Map()),
}));
vi.mock('./discovery.mjs', () => ({ getLanAddress: vi.fn(() => '127.0.0.1') }));
vi.mock('./sessions.mjs', () => ({
  appendToSession: vi.fn(async (agentId, ...rows) => { session(agentId).push(...rows); }),
  appendSessionReportOnce: vi.fn(async (agentId, row) => {
    if (mocks.failReportIds.has(row.reportId)) throw new Error(`forced persistence failure: ${row.reportId}`);
    const rows = session(agentId);
    if (rows.some(existing => existing?.reportId === row.reportId)) return 'existing';
    rows.push(row);
    return 'appended';
  }),
  loadSession: vi.fn(async agentId => session(agentId).slice()),
}));
vi.mock('./routes/_helpers.mjs', () => ({
  isUserTimeBlocked: vi.fn(() => false),
  getUser: vi.fn(userId => ({ id: userId, role: 'user', skills: [], skillAssignments: {} })),
  modifyUser: vi.fn(async () => null),
  resolveRuntimeAgentId: vi.fn((userId, requested) => mocks.runtimeAgentByUser.get(userId) || requested),
  getAgentForUser: vi.fn((agentId, userId) => ({
    id: agentId,
    name: `Primary ${userId}`,
    emoji: 'J',
    provider: 'openai',
    model: 'gpt-test',
    systemPrompt: `Persistent primary prompt for ${userId}`,
    tools: [{ type: 'function', function: { name: 'must_not_reach_completion' } }],
  })),
}));
vi.mock('./ws-handler.mjs', () => ({ noteDeviceBackgroundWork: vi.fn() }));
vi.mock('./chat.mjs', () => ({
  streamChat: vi.fn(async function* (...args) {
    const [agent, task, signal, , userId, , , silent, , turnOpts] = args;
    if (silent) {
      const { getTurnContext } = await import('./lib/turn-abort-context.mjs');
      mocks.primaryCalls.push({
        agent, task, signal, userId, turnOpts, turnContext: getTurnContext(),
      });
      if (mocks.primaryFailures > 0) {
        mocks.primaryFailures--;
        yield { type: 'error', message: 'forced primary authoring failure' };
        return;
      }
      yield { type: 'token', text: 'provisional primary text' };
      yield { type: 'replace', text: 'Primary-authored completion.' };
      yield { type: '__content', content: 'Primary-authored completion.' };
      yield { type: 'done' };
      return;
    }
    const scenario = mocks.workerScenarios.shift();
    if (scenario) {
      yield* scenario(...args);
      return;
    }
    yield { type: 'token', text: 'Worker result.' };
    yield { type: 'done' };
  }),
}));

const bg = await import('./background-tasks.mjs');
const { BASE_DIR } = await import('./lib/paths.mjs');
const { getTurnContext, runWithTurnContext } = await import('./lib/turn-abort-context.mjs');
const { toolRouterContext } = await import('./lib/tool-router-context.mjs');
const JOURNAL_PATH = path.join(BASE_DIR, 'background-task-journal.json');
const originalJournal = fs.existsSync(JOURNAL_PATH) ? fs.readFileSync(JOURNAL_PATH) : null;
const originalLab = process.env.OPENENSEMBLE_LAB;
const originalLeasePath = process.env.OE_LAB_VERIFIER_LEASE_PATH;

function writeJournal(entries) {
  fs.writeFileSync(JOURNAL_PATH, JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600 });
}

function readJournal() {
  const parsed = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
  return parsed?.version === 1 ? parsed.entries : parsed;
}

function writeVerifierLease(leasePath, token) {
  fs.writeFileSync(leasePath, JSON.stringify({
    version: 1,
    runTag: 'real_router_1700000000000_aaaaaaaa',
    token,
    expiresAt: Date.now() + 60_000,
  }), { mode: 0o600 });
  fs.chmodSync(leasePath, 0o600);
}

function restoreVerifierEnv() {
  if (originalLab == null) delete process.env.OPENENSEMBLE_LAB;
  else process.env.OPENENSEMBLE_LAB = originalLab;
  if (originalLeasePath == null) delete process.env.OE_LAB_VERIFIER_LEASE_PATH;
  else process.env.OE_LAB_VERIFIER_LEASE_PATH = originalLeasePath;
}

function spawn(userId, task = 'Inspect the background queue.', ownerKey = 'jarvis') {
  return bg.spawnWorker({
    workerAgent: {
      id: `ephemeral_worker_${userId}_${Date.now()}_${ownerKey}`,
      workerOwnerId: ownerKey,
      name: 'Private worker',
      emoji: 'J',
      ephemeral: true,
      tools: [],
    },
    task,
    userId,
    chipOwnerId: `${userId}_${ownerKey}`,
    ownerKey,
    workerName: 'Private worker',
    emoji: 'J',
  });
}

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

function rowsForTask(taskId) {
  return [...mocks.sessions.values()].flat().filter(row => row?.taskId === taskId || row?.backgroundTaskId === taskId);
}

beforeEach(async () => {
  restoreVerifierEnv();
  mocks.workerScenarios.length = 0;
  mocks.primaryCalls.length = 0;
  mocks.primaryFailures = 0;
  mocks.sessions.clear();
  mocks.runtimeAgentByUser.clear();
  mocks.failReportIds.clear();
  mocks.sendToUser.mockClear();
  mocks.appendTaskOutcome.mockClear();
  mocks.completeWatcher.mockClear();
  bg.setBackgroundUserSendFn(mocks.sendToUser);
  for (const task of bg.getActiveTasks()) bg.cancelTask(task.userId, task.taskId, 'test_cleanup');
  await waitFor(() => bg.getActiveTasks().length === 0).catch(() => {});
  writeJournal({});
});

afterAll(() => {
  restoreVerifierEnv();
  if (originalJournal) fs.writeFileSync(JOURNAL_PATH, originalJournal, { mode: 0o600 });
  else fs.rmSync(JOURNAL_PATH, { force: true });
});

describe('private durable worker lifecycle', () => {
  it('starts no producer when durable journal registration fails', () => {
    const userId = `worker-journal-${Date.now()}`;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('forced journal rename failure');
    });
    let error;
    try { spawn(userId, 'Must not start.'); } catch (caught) { error = caught; }
    rename.mockRestore();
    expect(error).toMatchObject({ code: 'WORKER_NOT_STARTED' });
    expect(bg.getActiveTasks().filter(task => task.userId === userId)).toEqual([]);
    expect(mocks.workerScenarios).toHaveLength(0);
    expect(mocks.primaryCalls).toHaveLength(0);
  });

  it('fails closed without overwriting an invalid journal shape', () => {
    const userId = `worker-invalid-journal-${Date.now()}`;
    fs.writeFileSync(JOURNAL_PATH, '[]', { mode: 0o600 });

    expect(() => spawn(userId, 'Must not overwrite unknown durable state.'))
      .toThrow(expect.objectContaining({ code: 'WORKER_NOT_STARTED' }));
    expect(JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'))).toEqual([]);
    expect(bg.getActiveTasks().filter(task => task.userId === userId)).toEqual([]);
    expect(mocks.primaryCalls).toHaveLength(0);
  });

  it('stores hidden raw context and one buffered completion authored with the live primary configuration', async () => {
    const userId = `worker-owner-${Date.now()}`;
    const taskId = spawn(userId, 'Compile private quarterly notes.');
    await waitFor(() => !bg.isTaskActive(taskId));

    const rows = rowsForTask(taskId);
    expect(rows.filter(row => row.reportId === taskId)).toEqual([
      expect.objectContaining({ kind: 'agent_report', hidden: true, status: 'done' }),
    ]);
    expect(rows.filter(row => row.reportId === `${taskId}:primary-completion`)).toEqual([
      expect.objectContaining({
        content: 'Primary-authored completion.', primaryAuthored: true,
        authorAgentId: 'jarvis', asyncNotification: true,
      }),
    ]);
    expect(mocks.primaryCalls).toHaveLength(1);
    expect(mocks.primaryCalls[0]).toMatchObject({
      userId,
      agent: { id: 'jarvis', tools: [] },
      turnOpts: {
        readOnlyTurn: true,
        isolatedTaskRun: true,
        toolPlan: { mode: 'none', source: 'worker-completion', maxProviderRequests: 1 },
        rootTaskId: taskId,
      },
    });
    expect(mocks.primaryCalls[0].task).toContain('Compile private quarterly notes.');
    expect(mocks.primaryCalls[0].task).toContain('Worker result.');
    expect(mocks.sendToUser.mock.calls.every(([recipient]) => recipient === userId)).toBe(true);
    expect(mocks.sendToUser.mock.calls.some(([, event]) => event?.type === 'agent_report')).toBe(false);
    expect(mocks.sendToUser.mock.calls.filter(([, event]) => event?.type === 'assistant_notification')).toHaveLength(1);
    expect(readJournal()[taskId]).toBeUndefined();
  });

  it('keeps a verifier lease capability memory-only and revalidates it for one tool-less completion call', async () => {
    const token = 'c'.repeat(64);
    const leasePath = path.join(BASE_DIR, `worker-verifier-${Date.now()}.lease.json`);
    process.env.OPENENSEMBLE_LAB = '1';
    process.env.OE_LAB_VERIFIER_LEASE_PATH = leasePath;
    writeVerifierLease(leasePath, token);
    let release;
    let markStarted;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    mocks.workerScenarios.push(async function* () {
      markStarted();
      await gate;
      yield { type: 'token', text: 'Verifier worker result.' };
    });

    let taskId;
    try {
      taskId = await runWithTurnContext({
        suppressLearning: true,
        verifierLeaseRequired: true,
        verifierAllowedTools: ['spawn_worker'],
        verifierLeaseToken: token,
      }, () => spawn(`worker-verifier-${Date.now()}`, 'Verify a detached task.'));
      await started;

      const journalText = fs.readFileSync(JOURNAL_PATH, 'utf8');
      expect(readJournal()[taskId]).toMatchObject({ verifierLeaseRequired: true });
      expect(journalText).not.toContain(token);
      expect(JSON.stringify(bg.getActiveTasks())).not.toContain(token);
      release();
      await waitFor(() => !bg.isTaskActive(taskId));

      expect(mocks.primaryCalls).toHaveLength(1);
      expect(mocks.primaryCalls[0]).toMatchObject({
        agent: { tools: [] },
        turnOpts: {
          readOnlyTurn: true,
          isolatedTaskRun: true,
          toolPlan: { mode: 'none', source: 'worker-completion', maxProviderRequests: 1 },
        },
        turnContext: {
          suppressLearning: true,
          verifierLeaseRequired: true,
          verifierAllowedTools: [],
          verifierLeaseToken: token,
        },
      });
      expect(mocks.primaryCalls[0].task).not.toContain(token);
      expect(JSON.stringify(rowsForTask(taskId))).not.toContain(token);
      expect(JSON.stringify(mocks.sendToUser.mock.calls)).not.toContain(token);
    } finally {
      release?.();
      if (taskId) await waitFor(() => !bg.isTaskActive(taskId)).catch(() => {});
      fs.rmSync(leasePath, { force: true });
      restoreVerifierEnv();
    }
  });

  it('makes zero completion model calls after a verifier lease is removed', async () => {
    const token = 'd'.repeat(64);
    const leasePath = path.join(BASE_DIR, `worker-verifier-expired-${Date.now()}.lease.json`);
    process.env.OPENENSEMBLE_LAB = '1';
    process.env.OE_LAB_VERIFIER_LEASE_PATH = leasePath;
    writeVerifierLease(leasePath, token);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mocks.workerScenarios.push(async function* () {
      await gate;
      yield { type: 'token', text: 'Result after lease removal.' };
    });

    let taskId;
    try {
      taskId = await runWithTurnContext({
        suppressLearning: true,
        verifierLeaseRequired: true,
        verifierAllowedTools: ['spawn_worker'],
        verifierLeaseToken: token,
      }, () => spawn(`worker-verifier-removed-${Date.now()}`, 'Finish after lease removal.'));
      fs.rmSync(leasePath, { force: true });
      release();
      await waitFor(() => !bg.isTaskActive(taskId));

      expect(mocks.primaryCalls).toHaveLength(0);
      expect(rowsForTask(taskId).filter(row => row.reportId === `${taskId}:primary-completion`))
        .toEqual([expect.objectContaining({
          role: 'notification', degradedSystemNotice: true, primaryAuthored: false,
        })]);
      expect(JSON.stringify(rowsForTask(taskId))).not.toContain(token);
    } finally {
      release?.();
      if (taskId) await waitFor(() => !bg.isTaskActive(taskId)).catch(() => {});
      fs.rmSync(leasePath, { force: true });
      restoreVerifierEnv();
    }
  });

  it('does not retry a verifier completion after one provider-authoring failure', async () => {
    const token = 'e'.repeat(64);
    const leasePath = path.join(BASE_DIR, `worker-verifier-failure-${Date.now()}.lease.json`);
    process.env.OPENENSEMBLE_LAB = '1';
    process.env.OE_LAB_VERIFIER_LEASE_PATH = leasePath;
    writeVerifierLease(leasePath, token);
    mocks.primaryFailures = 1;
    let taskId;
    try {
      taskId = await runWithTurnContext({
        suppressLearning: true,
        verifierLeaseRequired: true,
        verifierAllowedTools: ['spawn_worker'],
        verifierLeaseToken: token,
      }, () => spawn(`worker-verifier-failure-${Date.now()}`, 'Use one author attempt.'));
      await waitFor(() => !bg.isTaskActive(taskId));

      expect(mocks.primaryCalls).toHaveLength(1);
      expect(rowsForTask(taskId).filter(row => row.reportId === `${taskId}:primary-completion`))
        .toEqual([expect.objectContaining({
          role: 'notification', degradedSystemNotice: true, primaryAuthored: false,
        })]);
    } finally {
      fs.rmSync(leasePath, { force: true });
      restoreVerifierEnv();
    }
  });

  it('detaches abort and tool-router async context from the spawning foreground turn', async () => {
    const parentAbort = new AbortController();
    const parentRouter = { capabilitySentinel: 'must-not-leak' };
    let observed = null;
    mocks.workerScenarios.push(async function* (_agent, _task, signal) {
      observed = { signal, turn: getTurnContext(), router: toolRouterContext.getStore() };
      yield { type: 'token', text: 'Detached result.' };
    });
    const userId = `worker-als-${Date.now()}`;
    const taskId = await runWithTurnContext(
      { signal: parentAbort.signal, deviceId: 'device-a', conversationMode: true },
      () => toolRouterContext.run(parentRouter, () => spawn(userId, 'Detached context task.')),
    );
    parentAbort.abort('foreground-ended');
    await waitFor(() => !bg.isTaskActive(taskId));

    expect(observed.signal).not.toBe(parentAbort.signal);
    expect(observed.signal.aborted).toBe(false);
    expect(observed.turn).toMatchObject({
      signal: observed.signal, deviceId: 'device-a', conversationMode: true,
    });
    expect(observed.router).toBeNull();
    expect(JSON.stringify(rowsForTask(taskId))).not.toContain('must-not-leak');
  });

  it('keeps simultaneous reverse-order completions isolated by user, task, and session', async () => {
    let releaseA;
    let releaseB;
    const gateA = new Promise(resolve => { releaseA = resolve; });
    const gateB = new Promise(resolve => { releaseB = resolve; });
    mocks.workerScenarios.push(
      async function* () { await gateA; yield { type: 'token', text: 'Alpha secret.' }; },
      async function* () { await gateB; yield { type: 'token', text: 'Beta secret.' }; },
    );
    const userA = `worker-a-${Date.now()}`;
    const userB = `worker-b-${Date.now()}`;
    const taskA = spawn(userA, 'Alpha private task.');
    const taskB = spawn(userB, 'Beta private task.');
    releaseB(); releaseA();
    await waitFor(() => !bg.isTaskActive(taskA) && !bg.isTaskActive(taskB));

    const promptA = mocks.primaryCalls.find(call => call.userId === userA)?.task || '';
    const promptB = mocks.primaryCalls.find(call => call.userId === userB)?.task || '';
    expect(promptA).toContain('Alpha secret.');
    expect(promptA).not.toContain('Beta secret.');
    expect(promptB).toContain('Beta secret.');
    expect(promptB).not.toContain('Alpha secret.');
    expect(mocks.sessions.get(`${userA}_jarvis`).every(row => !String(row.content).includes('Beta secret.'))).toBe(true);
    expect(mocks.sessions.get(`${userB}_jarvis`).every(row => !String(row.content).includes('Alpha secret.'))).toBe(true);
    expect(new Set(mocks.sendToUser.mock.calls.map(([recipient]) => recipient)))
      .toEqual(new Set([userA, userB]));
  });

  it('lets cancellation beat a provider that ignores abort and returns late', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mocks.workerScenarios.push(async function* () {
      await gate;
      yield { type: 'token', text: 'Late success that must lose.' };
    });
    const userId = `worker-cancel-${Date.now()}`;
    const taskId = spawn(userId, 'Cancellable job.');
    expect(bg.stopWorker(userId, taskId, 'jarvis').ok).toBe(true);
    release();
    await waitFor(() => !bg.isTaskActive(taskId));

    expect(mocks.appendTaskOutcome.mock.calls.map(([, row]) => row).filter(row => row.taskId === taskId))
      .toEqual([expect.objectContaining({ status: 'stopped' })]);
    expect(rowsForTask(taskId).filter(row => row.reportId === taskId))
      .toEqual([expect.objectContaining({ status: 'cancelled', hidden: true })]);
    expect(bg.listRecentWorkersForOwner(userId, 'jarvis').filter(row => row.taskId === taskId))
      .toHaveLength(1);
  });

  it('aborts and finalizes a stale producer once; its later callback is a no-op', async () => {
    mocks.workerScenarios.push(async function* (_agent, _task, signal) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('already aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted by reaper')), { once: true });
      });
    });
    const userId = `worker-ttl-${Date.now()}`;
    const taskId = spawn(userId, 'Hang until TTL.');
    expect(await bg.reapStaleTasks(Date.now() + 25 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
    await waitFor(() => !bg.isTaskActive(taskId));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(mocks.appendTaskOutcome.mock.calls.map(([, row]) => row).filter(row => row.taskId === taskId))
      .toHaveLength(1);
    expect(rowsForTask(taskId).filter(row => row.reportId === taskId)).toHaveLength(1);
  });

  it('recovers running and completed journal entries without rerunning producers or duplicating publication', async () => {
    const userId = `worker-restart-${Date.now()}`;
    const runningId = `wkr_running_${Date.now()}`;
    const completedId = `wkr_completed_${Date.now()}`;
    const verifierCompletedId = `wkr_verifier_completed_${Date.now()}`;
    writeJournal({
      [runningId]: {
        userId, kind: 'worker', agentId: 'ephemeral_worker_running', agentName: 'Private worker',
        summary: 'Interrupted work', ownerKey: 'jarvis', coordinatorAgentId: `${userId}_jarvis`,
        visibleAgentId: `${userId}_jarvis`, startedAt: Date.now() - 10_000,
      },
      [completedId]: {
        userId, kind: 'worker', agentId: 'ephemeral_worker_completed', agentName: 'Private worker',
        summary: 'Durable completed work', ownerKey: 'jarvis', coordinatorAgentId: `${userId}_jarvis`,
        visibleAgentId: `${userId}_jarvis`, startedAt: Date.now() - 10_000,
        completion: { status: 'done', result: 'Recovered durable result.', error: '', images: [], completedAt: Date.now() - 500 },
      },
      [verifierCompletedId]: {
        userId, kind: 'worker', agentId: 'ephemeral_worker_verifier', agentName: 'Private worker',
        summary: 'Verifier work', ownerKey: 'jarvis', coordinatorAgentId: `${userId}_jarvis`,
        visibleAgentId: `${userId}_jarvis`, startedAt: Date.now() - 10_000,
        verifierLeaseRequired: true,
        completion: { status: 'done', result: 'Recovered verifier result.', error: '', images: [], completedAt: Date.now() - 500 },
      },
    });

    expect(await bg.bootRecoverInterruptedTasks()).toBe(3);
    expect(await bg.bootRecoverInterruptedTasks()).toBe(0);
    expect(readJournal()).toEqual({});
    expect(rowsForTask(runningId).filter(row => row.reportId === runningId)).toHaveLength(1);
    expect(rowsForTask(completedId).filter(row => row.reportId === completedId)).toHaveLength(1);
    expect(rowsForTask(runningId).filter(row => row.reportId === `${runningId}:primary-completion`)).toHaveLength(1);
    expect(rowsForTask(completedId).filter(row => row.reportId === `${completedId}:primary-completion`)).toHaveLength(1);
    expect(rowsForTask(verifierCompletedId).filter(row => row.reportId === `${verifierCompletedId}:primary-completion`))
      .toEqual([expect.objectContaining({
        role: 'notification', degradedSystemNotice: true, primaryAuthored: false,
      })]);
    // The two ordinary recovered workers are authored; the verifier capability
    // was intentionally not journaled, so its recovery makes no model call.
    expect(mocks.primaryCalls).toHaveLength(2);
    expect(mocks.sendToUser.mock.calls.every(([recipient]) => recipient === userId)).toBe(true);
  });

  it('resolves a mode-switched primary at publication time', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mocks.workerScenarios.push(async function* () { await gate; yield { type: 'token', text: 'Mode-switch result.' }; });
    const userId = `worker-mode-${Date.now()}`;
    const taskId = spawn(userId, 'Finish across mode switch.', 'old-primary');
    mocks.runtimeAgentByUser.set(userId, 'new-primary');
    release();
    await waitFor(() => !bg.isTaskActive(taskId));

    expect(mocks.primaryCalls[0].agent.id).toBe('new-primary');
    expect(mocks.sessions.get(`${userId}_new-primary`).some(row => row.reportId === taskId)).toBe(true);
    expect(mocks.sessions.get(`${userId}_new-primary`).some(row => row.reportId === `${taskId}:primary-completion`)).toBe(true);
  });

  it('uses one deterministic system notice only after two primary-authoring failures', async () => {
    mocks.primaryFailures = 2;
    const userId = `worker-fallback-${Date.now()}`;
    const taskId = spawn(userId, 'Report through an authoring outage.');
    await waitFor(() => !bg.isTaskActive(taskId));

    expect(mocks.primaryCalls).toHaveLength(2);
    const fallbackRows = rowsForTask(taskId)
      .filter(row => row.reportId === `${taskId}:primary-completion`);
    expect(fallbackRows).toEqual([expect.objectContaining({
      role: 'notification', from: 'OpenEnsemble', agentName: 'OpenEnsemble',
      degradedSystemNotice: true, primaryAuthored: false,
    })]);
    expect(fallbackRows[0]).not.toHaveProperty('authorAgentId');
    const live = mocks.sendToUser.mock.calls
      .filter(([, event]) => event?.type === 'assistant_notification');
    expect(live).toHaveLength(1);
    expect(live[0][1]).toMatchObject({
      role: 'notification', from: 'OpenEnsemble', primary_authored: false,
    });
  });

  it('retains a completed journal entry when durable raw-report publication fails, then recovers once', async () => {
    const userId = `worker-persist-${Date.now()}`;
    // The task id is minted inside spawn; fail every raw report by adding the
    // concrete id immediately, before the async producer reaches completion.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mocks.workerScenarios.push(async function* () { await gate; yield { type: 'token', text: 'Durable result.' }; });
    const taskId = spawn(userId, 'Retry publication after storage returns.');
    mocks.failReportIds.add(taskId);
    release();
    await waitFor(() => !bg.isTaskActive(taskId));
    expect(readJournal()[taskId]?.completion?.result)
      .toContain('Durable result.');

    mocks.failReportIds.delete(taskId);
    const authoredBefore = mocks.primaryCalls.length;
    expect(await bg.bootRecoverInterruptedTasks()).toBe(1);
    expect(readJournal()[taskId]).toBeUndefined();
    expect(rowsForTask(taskId).filter(row => row.reportId === taskId)).toHaveLength(1);
    // The primary row was already durable before the raw-report failure; boot
    // repairs the missing raw row without spending another model call.
    expect(rowsForTask(taskId).filter(row => row.reportId === `${taskId}:primary-completion`)).toHaveLength(1);
    expect(mocks.primaryCalls).toHaveLength(authoredBefore);
  });

  it('keeps hidden worker rows out of the browser renderer and uses no global background broadcast hook', () => {
    const chatSource = fs.readFileSync(new URL('./public/chat.js', import.meta.url), 'utf8');
    const serverSource = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
    const filter = chatSource.indexOf('.filter(m => !m?.hidden)');
    const window = chatSource.indexOf('ordered.slice(start)', filter);
    expect(filter).toBeGreaterThanOrEqual(0);
    expect(window).toBeGreaterThan(filter);
    expect(serverSource).toContain('setBackgroundUserSendFn(sendToUser)');
    expect(serverSource).not.toContain('setBackgroundBroadcastFn(broadcast)');
  });
});
