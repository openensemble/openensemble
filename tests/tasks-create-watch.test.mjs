import { describe, expect, it } from 'vitest';
import execute from '../skills/tasks/execute.mjs';

const USER = 'user_tasks_watch_test';
const AGENT = `${USER}_coordinator`;

function makeCtx(calls) {
  return {
    watch: async (opts) => {
      calls.push(opts);
      return 'watch_test_id';
    },
  };
}

describe('tasks create_watch delivery', () => {
  it('passes email delivery through to watcher onFire', async () => {
    const calls = [];
    const result = await execute('create_watch', {
      label: 'Price alert',
      source: 'http_jsonpath',
      params: { url: 'https://example.com/price.json', json_path: '$.price' },
      comparator: 'lte',
      target: 100,
      on_fire: { type: 'email', subject: 'Price hit', to: 'me@example.com', account: 'Personal' },
    }, USER, AGENT, makeCtx(calls));

    expect(result).toContain('will email when it fires');
    expect(calls).toHaveLength(1);
    expect(calls[0].onFire).toEqual({
      type: 'email',
      subject: 'Price hit',
      to: 'me@example.com',
      account: 'Personal',
    });
  });

  it('passes Telegram delivery through to watcher onFire', async () => {
    const calls = [];
    const result = await execute('create_watch', {
      label: 'Deploy done',
      source: 'file_stat',
      params: { path: '/tmp/deploy-done', attribute: 'exists' },
      on_fire: { type: 'telegram', prefix: 'Deploy monitor' },
    }, USER, AGENT, makeCtx(calls));

    expect(result).toContain('will send Telegram when it fires');
    expect(calls).toHaveLength(1);
    expect(calls[0].onFire).toEqual({ type: 'telegram', prefix: 'Deploy monitor' });
  });

  it('continues to reject agent-created exec watches', async () => {
    const calls = [];
    const result = await execute('create_watch', {
      label: 'Shell watch',
      source: 'exec',
      params: { command: 'echo ok' },
      comparator: 'eq',
      target: 'ok',
    }, USER, AGENT, makeCtx(calls));

    expect(result).toContain('exec watchers cannot be created from agent context');
    expect(calls).toHaveLength(0);
  });

  it('rejects risky silent scheduled tasks', async () => {
    const result = await execute('schedule_task', {
      label: 'Silent email',
      prompt: 'Send an email to the team with the latest numbers.',
      datetime: new Date(Date.now() + 60_000).toISOString(),
      silent: true,
    }, USER, AGENT, makeCtx([]));

    expect(result).toContain('silent scheduled tasks cannot perform external side effects');
  });

  it('reports autonomy status', async () => {
    const result = await execute('autonomy_status', {}, USER, AGENT, makeCtx([]));

    expect(result).toContain('Autonomy status:');
    expect(result).toContain('Policy:');
  });
});
