import { describe, expect, it, vi } from 'vitest';

import { sendTelegramIdempotently } from './telegram-delivery-idempotency.mjs';

function unique(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

describe('Telegram delivery idempotency', () => {
  it('dispatches once and suppresses a changed browser retry under the same scope', async () => {
    const userId = unique('telegram_send');
    const send = vi.fn(async mark => { mark(); return { ok: true, messageIds: [91] }; });
    expect(await sendTelegramIdempotently({ userId, text: 'first', scopeId: 'message:one', send }))
      .toMatchObject({ ok: true, duplicate: false, messageIds: [91] });
    expect(await sendTelegramIdempotently({ userId, text: 'changed', scopeId: 'message:one', send }))
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
});
