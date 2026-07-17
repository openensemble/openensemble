import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  _internal,
  scheduledTelegramDeliveryScope,
  sendTelegramIdempotently,
} from './telegram-delivery-idempotency.mjs';
import { USERS_DIR } from './paths.mjs';
import { turnTraceContext } from './turn-trace-context.mjs';

function unique(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

describe('Telegram delivery idempotency', () => {
  it('fails closed without an explicit automatic scope or interactive turn', async () => {
    const send = vi.fn(async mark => { mark(); return { ok: true, messageIds: [90] }; });
    await expect(sendTelegramIdempotently({ userId: unique('unscoped'), text: 'hello', send }))
      .resolves.toMatchObject({ ok: false, scopeMissing: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves implicit scoping for an interactive turn', async () => {
    const userId = unique('interactive');
    const send = vi.fn(async mark => { mark(); return { ok: true, messageIds: [89] }; });
    const first = await turnTraceContext.run({ messageId: 'browser-message-1' }, () =>
      sendTelegramIdempotently({ userId, text: 'first wording', send }));
    const replay = await turnTraceContext.run({ messageId: 'browser-message-1' }, () =>
      sendTelegramIdempotently({ userId, text: 'retry wording', send }));
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(replay).toMatchObject({ ok: false, duplicate: true, payloadMismatch: true });
    expect(send).toHaveBeenCalledOnce();
  });

  it('derives stable scheduled scopes across replay and separates occurrences', () => {
    const task = { id: 'reminder-7', nextRunAt: '2026-07-16T10:00:00.000Z' };
    const first = scheduledTelegramDeliveryScope('fire-reminder', task, {
      scheduledRunRootId: 'scheduled:reminder-7:2026-07-16T10:00:00.000Z',
    });
    const replay = scheduledTelegramDeliveryScope('fire-reminder', task, {
      scheduledRunRootId: 'scheduled:reminder-7:2026-07-16T10:00:00.000Z',
    });
    const next = scheduledTelegramDeliveryScope('fire-reminder', task, {
      scheduledRunRootId: 'scheduled:reminder-7:2026-07-17T10:00:00.000Z',
    });
    expect(replay).toBe(first);
    expect(next).not.toBe(first);
  });

  it('dispatches once and suppresses a changed browser retry under the same scope', async () => {
    const userId = unique('telegram_send');
    const send = vi.fn(async mark => { mark(); return { ok: true, messageIds: [91] }; });
    expect(await sendTelegramIdempotently({ userId, text: 'first', scopeId: 'message:one', send }))
      .toMatchObject({ ok: true, duplicate: false, messageIds: [91] });
    expect(await sendTelegramIdempotently({ userId, text: 'changed', scopeId: 'message:one', send }))
      .toMatchObject({ ok: false, duplicate: true, payloadMismatch: true, messageIds: [] });
    expect(await sendTelegramIdempotently({ userId, text: 'first', scopeId: 'message:one', send }))
      .toMatchObject({ ok: true, duplicate: true, messageIds: [91] });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails closed after an ambiguous transport boundary', async () => {
    const userId = unique('telegram_uncertain');
    const first = vi.fn(async mark => { mark(); throw new Error('socket lost'); });
    await expect(sendTelegramIdempotently({ userId, text: 'hello', scopeId: 'root:event', send: first }))
      .rejects.toThrow('socket lost');
    const retry = vi.fn(async mark => { mark(); return { ok: true, messageIds: [92] }; });
    expect(await sendTelegramIdempotently({ userId, text: 'hello', scopeId: 'root:event', send: retry }))
      .toMatchObject({ ok: false, duplicate: true, uncertain: true });
    expect(retry).not.toHaveBeenCalled();
  });

  it('allows a corrected retry after a safe pre-dispatch failure', async () => {
    const userId = unique('telegram_preflight');
    await expect(sendTelegramIdempotently({
      userId, text: 'hello', scopeId: 'message:preflight', send: async () => { throw new Error('not configured'); },
    })).rejects.toThrow('not configured');
    const retry = vi.fn(async mark => { mark(); return { ok: true, messageIds: [93] }; });
    expect(await sendTelegramIdempotently({ userId, text: 'hello', scopeId: 'message:preflight', send: retry }))
      .toMatchObject({ ok: true, duplicate: false });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('coalesces parallel duplicate model calls around one provider dispatch', async () => {
    const userId = unique('telegram_parallel');
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const send = vi.fn(async mark => { mark(); await waiting; return { ok: true, messageIds: [94] }; });
    const first = sendTelegramIdempotently({ userId, text: 'hello', scopeId: 'message:parallel', send });
    const second = sendTelegramIdempotently({ userId, text: 'hello', scopeId: 'message:parallel', send });
    release();
    const results = await Promise.all([first, second]);
    expect(send).toHaveBeenCalledOnce();
    expect(results.filter(result => result.duplicate === false)).toHaveLength(1);
    expect(results.filter(result => result.duplicate === true)).toHaveLength(1);
  });

  it('suppresses replay after the idempotency module is reloaded', async () => {
    const userId = unique('telegram_restart');
    const scopeId = `watcher:${unique('event')}`;
    const first = vi.fn(async mark => { mark(); return { ok: true, messageIds: [95] }; });
    await sendTelegramIdempotently({ userId, text: 'before restart', scopeId, send: first });

    const restarted = await import('./telegram-delivery-idempotency.mjs?restart-test');
    const replay = vi.fn(async mark => { mark(); return { ok: true, messageIds: [96] }; });
    await expect(restarted.sendTelegramIdempotently({
      userId, text: 'after restart', scopeId, send: replay,
    })).resolves.toMatchObject({ ok: false, duplicate: true, payloadMismatch: true, messageIds: [] });
    expect(replay).not.toHaveBeenCalled();
  });

  it('sweeps only old completed/preflight records and retains unsafe tombstones at capacity', async () => {
    const userId = unique('telegram_retention');
    const completedScope = unique('completed');
    const uncertainScope = unique('uncertain');
    const send = vi.fn(async mark => { mark(); return { ok: true, messageIds: [97] }; });
    await sendTelegramIdempotently({ userId, text: 'done', scopeId: completedScope, send });
    await expect(sendTelegramIdempotently({
      userId,
      text: 'uncertain',
      scopeId: uncertainScope,
      send: async mark => { mark(); throw new Error('lost acknowledgement'); },
    })).rejects.toThrow('lost acknowledgement');

    const dir = _internal.storeDir(userId);
    const files = fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const completedFile = files.find(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).status === 'completed');
    const uncertainFile = files.find(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).status === 'uncertain');
    const preflightFile = `${'a'.repeat(64)}.json`;
    const malformedFile = `${'b'.repeat(64)}.json`;
    fs.writeFileSync(path.join(dir, preflightFile), JSON.stringify({ status: 'preflight' }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, malformedFile), 'truncated', { mode: 0o600 });
    const now = Date.now();
    const old = new Date(now - 10_000);
    for (const name of [completedFile, uncertainFile, preflightFile, malformedFile]) {
      fs.utimesSync(path.join(dir, name), old, old);
    }

    const result = _internal.sweepDeliveryRecords(dir, userId, now, {
      force: true,
      minCompletedRetentionMs: 1_000,
      backgroundCompletedRetentionMs: 1_000,
      preflightRetentionMs: 1_000,
      maxRecords: 2,
    });
    expect(fs.existsSync(path.join(dir, completedFile))).toBe(false);
    expect(fs.existsSync(path.join(dir, preflightFile))).toBe(false);
    expect(fs.existsSync(path.join(dir, uncertainFile))).toBe(true);
    expect(fs.existsSync(path.join(dir, malformedFile))).toBe(true);
    expect(result).toMatchObject({ retained: 2, atCapacity: true, removed: 2 });
  });

  it('retains completed browser tombstones until their source message is no longer retriable', async () => {
    const userId = unique('telegram_source_retention');
    const messageId = unique('message');
    const sessionKey = `${userId}_jarvis`;
    const sessionsDir = path.join(USERS_DIR, userId, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'jarvis.session-epoch'), 'epoch-a', { mode: 0o600 });
    fs.writeFileSync(path.join(sessionsDir, 'jarvis.jsonl'), `${JSON.stringify({
      role: 'user', content: 'send telegram', messageId,
    })}\n`, { mode: 0o600 });
    await turnTraceContext.run({ messageId, sessionKey, sessionEpoch: 'epoch-a' }, () =>
      sendTelegramIdempotently({
        userId,
        text: 'hello',
        send: async mark => { mark(); return { ok: true, messageIds: [98] }; },
      }));

    const dir = _internal.storeDir(userId);
    const operation = fs.readdirSync(dir).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const now = Date.now();
    const old = new Date(now - 10_000);
    fs.utimesSync(path.join(dir, operation), old, old);
    _internal.sweepDeliveryRecords(dir, userId, now, {
      force: true,
      minCompletedRetentionMs: 1_000,
      backgroundCompletedRetentionMs: 1_000,
    });
    expect(fs.existsSync(path.join(dir, operation))).toBe(true);

    fs.writeFileSync(path.join(sessionsDir, 'jarvis.jsonl'), '', { mode: 0o600 });
    _internal.sweepDeliveryRecords(dir, userId, now + 1, {
      force: true,
      minCompletedRetentionMs: 1_000,
      backgroundCompletedRetentionMs: 1_000,
    });
    expect(fs.existsSync(path.join(dir, operation))).toBe(false);
  });
});
