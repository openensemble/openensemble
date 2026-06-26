import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';

const USER = 'user_tool_defaults_test';

function cleanupUser() {
  const dir = path.join(USERS_DIR, USER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => cleanupUser());
afterAll(() => cleanupUser());

describe('tool default-arg safety gates', () => {
  it('does not count or propose defaults for destructive tools like email_trash', async () => {
    const { recordToolCall } = await import('../lib/tool-defaults.mjs');

    for (let i = 0; i < 3; i++) {
      const res = await recordToolCall(USER, 'email_trash', {
        account: 'Renovo',
        messageId: `msg_${i}`,
      });
      expect(res.proposed).toBe(false);
    }

    const countsPath = path.join(USERS_DIR, USER, 'tool-arg-counts.json');
    const counts = fs.existsSync(countsPath)
      ? JSON.parse(fs.readFileSync(countsPath, 'utf8'))
      : {};
    expect(counts['email_trash.account']).toBeUndefined();
  });

  it('does not count account selectors as defaults on non-destructive email tools', async () => {
    const { recordToolCall } = await import('../lib/tool-defaults.mjs');

    for (let i = 0; i < 3; i++) {
      const res = await recordToolCall(USER, 'email_list', {
        account: 'Renovo',
        maxResults: 10,
      });
      expect(res.tool === 'email_list' && res.arg === 'account').toBe(false);
    }

    const counts = JSON.parse(fs.readFileSync(path.join(USERS_DIR, USER, 'tool-arg-counts.json'), 'utf8'));
    expect(counts['email_list.account']).toBeUndefined();
    expect(counts['email_list.maxResults']).toBeTruthy();
  });

  it('suppresses stale default_arg proposals for destructive tools and account args', async () => {
    const { proposeDefaultArg, proposeAlias } = await import('../lib/proposals.mjs');

    await expect(proposeDefaultArg({
      userId: USER,
      agentId: 'agent_test',
      tool: 'email_trash',
      arg: 'account',
      value: 'Renovo',
      count: 3,
    })).resolves.toBeNull();

    await expect(proposeDefaultArg({
      userId: USER,
      agentId: 'agent_test',
      tool: 'email_list',
      arg: 'account',
      value: 'Renovo',
      count: 3,
    })).resolves.toBeNull();

    await expect(proposeAlias({
      userId: USER,
      agentId: 'agent_test',
      phrase: 'latest',
      entityId: 'renovo',
    })).resolves.toBeNull();
  });

  it('refuses to accept stale pins for destructive tools or account args', async () => {
    const { pinDefault, loadDefaults } = await import('../lib/tool-defaults.mjs');

    await expect(pinDefault(USER, 'email_trash', 'account', 'Renovo'))
      .resolves.toMatchObject({ ok: false, error: 'not pinnable' });
    await expect(pinDefault(USER, 'email_list', 'account', 'Renovo'))
      .resolves.toMatchObject({ ok: false, error: 'not pinnable' });

    expect(loadDefaults(USER)).toEqual({});
  });

  it('does not merge or display stale account pins already on disk', async () => {
    const { mergeDefaults, listDefaults } = await import('../lib/tool-defaults.mjs');
    const userDir = path.join(USERS_DIR, USER);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'tool-defaults.json'), JSON.stringify({
      email_read: { account: 'Personal' },
      email_trash: { account: 'Renovo' },
      web_search: { count: 5 },
    }));

    expect(mergeDefaults(USER, 'email_read', { messageId: 'm1' }))
      .toEqual({ messageId: 'm1' });
    expect(mergeDefaults(USER, 'email_trash', { messageId: 'm1' }))
      .toEqual({ messageId: 'm1' });
    expect(listDefaults(USER)).toEqual([{ tool: 'web_search', arg: 'count', value: 5 }]);
  });

  it('uses shared learning safety for non-email defaults', async () => {
    const { recordToolCall } = await import('../lib/tool-defaults.mjs');
    const { isDefaultArgNoise, isLearnableAliasPhrase } = await import('../lib/learning-safety.mjs');

    expect(isDefaultArgNoise('node_exec', 'node_id', 'node_prod')).toBe(true);
    expect(isDefaultArgNoise('web_search', 'query', 'weather')).toBe(true);
    expect(isDefaultArgNoise('remember_fact', 'scope', 'shared')).toBe(true);
    expect(isDefaultArgNoise('watch_create', 'pollSeconds', 300)).toBe(false);
    expect(isLearnableAliasPhrase('latest', 'email')).toBe(false);
    expect(isLearnableAliasPhrase('Renovo', 'account')).toBe(true);

    for (let i = 0; i < 4; i++) {
      const res = await recordToolCall(USER, 'watch_create', {
        path: `/tmp/check-${i}`,
        pollSeconds: 300,
      });
      if (i < 3) expect(res.proposed).toBe(false);
      else expect(res).toMatchObject({
        proposed: true,
        tool: 'watch_create',
        arg: 'pollSeconds',
        value: 300,
      });
    }

    const counts = JSON.parse(fs.readFileSync(path.join(USERS_DIR, USER, 'tool-arg-counts.json'), 'utf8'));
    expect(counts['watch_create.path']).toBeUndefined();
    expect(counts['watch_create.pollSeconds']).toBeTruthy();
  });
});
