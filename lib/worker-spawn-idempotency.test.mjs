import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { USERS_DIR } from './paths.mjs';
import { turnTraceContext } from './turn-trace-context.mjs';
import { _internal, spawnWorkerIdempotently } from './worker-spawn-idempotency.mjs';

function unique(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function taskId(call) {
  return `wkr_${Date.now()}_${call.toString(36)}`;
}

describe('worker spawn idempotency', () => {
  it('coalesces a repeated same-job call across later tool rounds', async () => {
    const userId = unique('worker_dedupe_user');
    let calls = 0;
    const spawn = async () => taskId(++calls);
    const first = await spawnWorkerIdempotently({
      userId, ownerKey: 'jarvis', scopeId: 'message:one', ordinal: 1,
      label: 'Audit beta email', task: 'Read the beta email.', spawn,
    });
    const repeat = await spawnWorkerIdempotently({
      userId, ownerKey: 'jarvis', scopeId: 'message:one', ordinal: 2,
      label: 'Audit beta email', task: 'Read the beta email and report it.', spawn,
    });
    expect(repeat).toEqual({ duplicate: true, taskId: first.taskId });
    expect(calls).toBe(1);
  });

  it('uses ambient source-turn ordinals to map browser Retry to original workers', async () => {
    const userId = unique('worker_retry_user');
    let calls = 0;
    const spawn = async () => taskId(++calls);
    const firstTurn = { messageId: 'stable-browser-message', rootId: 'attempt-one' };
    const original = await turnTraceContext.run(firstTurn, async () => [
      await spawnWorkerIdempotently({
        userId, ownerKey: 'jarvis', label: 'Alpha', task: 'Research alpha.', spawn,
      }),
      await spawnWorkerIdempotently({
        userId, ownerKey: 'jarvis', label: 'Beta', task: 'Research beta.', spawn,
      }),
    ]);

    const retryTurn = { messageId: 'stable-browser-message', rootId: 'attempt-two' };
    const retried = await turnTraceContext.run(retryTurn, async () => [
      await spawnWorkerIdempotently({
        userId, ownerKey: 'jarvis', label: 'Changed alpha wording', task: 'Investigate alpha deeply.', spawn,
      }),
      await spawnWorkerIdempotently({
        userId, ownerKey: 'jarvis', label: 'Changed beta wording', task: 'Investigate beta deeply.', spawn,
      }),
    ]);

    expect(retried[0]).toEqual({ duplicate: true, taskId: original[0].taskId });
    expect(retried[1]).toEqual({ duplicate: true, taskId: original[1].taskId });
    expect(calls).toBe(2);
  });

  it('allows distinct workers in one logical message', async () => {
    const userId = unique('worker_parallel_user');
    let calls = 0;
    const spawn = async () => taskId(++calls);
    const alpha = await spawnWorkerIdempotently({
      userId, ownerKey: 'jarvis', scopeId: 'message:three', ordinal: 1,
      label: 'Alpha', task: 'Research alpha.', spawn,
    });
    const beta = await spawnWorkerIdempotently({
      userId, ownerKey: 'jarvis', scopeId: 'message:three', ordinal: 2,
      label: 'Beta', task: 'Research beta.', spawn,
    });
    expect(alpha.taskId).not.toBe(beta.taskId);
    expect(calls).toBe(2);
  });

  it('serializes distinct admissions per user so the quota reservation is atomic', async () => {
    const userId = unique('worker_atomic_user');
    let active = 0;
    let dispatches = 0;
    const launch = (scopeId, label) => spawnWorkerIdempotently({
      userId, ownerKey: 'jarvis', scopeId, ordinal: 1, label, task: `Run ${label}`,
      beforeSpawn: () => {
        if (active >= 1) throw new Error('capacity reached');
      },
      spawn: async () => {
        const call = ++dispatches;
        await new Promise(resolve => setTimeout(resolve, 20));
        active += 1;
        return taskId(call);
      },
    });

    const settled = await Promise.allSettled([
      launch('message:atomic-one', 'Atomic one'),
      launch('message:atomic-two', 'Atomic two'),
    ]);
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(settled.find(result => result.status === 'rejected')?.reason?.message).toBe('capacity reached');
    expect(dispatches).toBe(1);

    const dir = path.join(USERS_DIR, userId, 'worker-spawn-idempotency');
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.json'))).toHaveLength(1);
  });

  it('fails closed after an ambiguous dispatch error', async () => {
    const userId = unique('worker_uncertain_user');
    await expect(spawnWorkerIdempotently({
      userId, ownerKey: 'jarvis', scopeId: 'message:four', ordinal: 1,
      label: 'Uncertain', task: 'Do work.',
      spawn: async () => { throw new Error('lost acknowledgement'); },
    })).rejects.toThrow(/lost acknowledgement/);
    await expect(spawnWorkerIdempotently({
      userId, ownerKey: 'jarvis', scopeId: 'message:four', ordinal: 1,
      label: 'Uncertain', task: 'Do work.',
      spawn: async () => 'wkr_12345_retry',
    })).rejects.toThrow(/may already have started/);
    const dir = path.join(USERS_DIR, userId, 'worker-spawn-idempotency');
    expect(fs.readdirSync(dir).some(name => name.endsWith('.json'))).toBe(true);
  });

  it('allows retry when the dispatcher proves no producer was started', async () => {
    const userId = unique('worker_not_started_user');
    await expect(spawnWorkerIdempotently({
      userId, ownerKey: 'jarvis', scopeId: 'message:not-started', ordinal: 1,
      label: 'Retryable admission', task: 'Do durable work.',
      spawn: async () => { throw Object.assign(new Error('journal unavailable'), { code: 'WORKER_NOT_STARTED' }); },
    })).rejects.toThrow(/journal unavailable/);
    const retry = await spawnWorkerIdempotently({
      userId, ownerKey: 'jarvis', scopeId: 'message:not-started', ordinal: 1,
      label: 'Retryable admission', task: 'Do durable work.',
      spawn: async () => 'wkr_12345_retry',
    });
    expect(retry).toEqual({ duplicate: false, taskId: 'wkr_12345_retry' });
  });

  it('normalizes Unicode letters and numbers without erasing non-Latin jobs', () => {
    expect(_internal.normalizeText('  调研：Ｅメール １２３  ')).toBe('调研 eメール 123');
    expect(_internal.jobFingerprint('調査：電子メール', 'first task'))
      .toBe(_internal.jobFingerprint('調査 電子メール', 'different wording'));
    expect(() => _internal.jobFingerprint('', '研究电子邮件')).not.toThrow();
  });
});
