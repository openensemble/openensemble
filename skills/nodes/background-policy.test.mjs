import { describe, expect, it } from 'vitest';
import { runInTaskContext } from '../../lib/task-proxy-context.mjs';
import { runWithTurnContext } from '../../lib/turn-abort-context.mjs';
import { scheduledContext } from '../../lib/scheduled-context.mjs';
import { shouldDetachNodeExec } from './background-policy.mjs';

describe('node_exec eager background ownership policy', () => {
  it('keeps foreground long/explicit commands on the existing task-chip path', () => {
    expect(shouldDetachNodeExec({ command: 'apt-get update', timeout: 60 })).toBe(true);
    expect(shouldDetachNodeExec({ background: true, command: 'echo ready', timeout: 10 })).toBe(true);
    expect(shouldDetachNodeExec({ background: false, command: 'apt-get update', timeout: 120 })).toBe(false);
  });

  it('awaits commands when a worker, delegation, or isolated request already owns them', async () => {
    await runInTaskContext({ taskId: 'owned-command', watcherId: 'owner-chip' }, async () => {
      expect(shouldDetachNodeExec({ command: 'apt-get update', timeout: 60 })).toBe(false);
      expect(shouldDetachNodeExec({ background: true, command: 'echo ready', timeout: 10 })).toBe(false);
      await Promise.resolve();
      expect(shouldDetachNodeExec({ command: 'npm install', timeout: 120 })).toBe(false);
    });
  });

  it('does not bypass an exact selected foreground plan with its skill-owned chip', async () => {
    await runWithTurnContext({ awaitSlowTools: true }, async () => {
      expect(shouldDetachNodeExec({ command: 'apt-get update', timeout: 120 })).toBe(false);
      expect(shouldDetachNodeExec({ background: true, command: 'echo ready' })).toBe(false);
    });
  });

  it('leaves scheduled long commands under the scheduled child barrier', async () => {
    await scheduledContext.run({
      originTaskId: 'schedule_node_1',
      originTaskOwnerId: 'user_test',
      originTaskAgent: 'jarvis',
      runId: 'scheduled:schedule_node_1:run_1',
    }, async () => {
      expect(shouldDetachNodeExec({ command: 'apt-get update', timeout: 120 })).toBe(false);
      expect(shouldDetachNodeExec({ background: true, command: 'echo ready' })).toBe(false);
    });
  });
});
