import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendEmailIdempotently, withEmailDeliveryScope } from './email-idempotency.mjs';
import { USERS_DIR } from './paths.mjs';
import { looksLikeToolError } from './tool-error.mjs';
import { beginTurn, getTurn, turnTraceContext } from './turn-trace-context.mjs';

const payload = {
  accountId: 'lab-mail',
  provider: 'imap',
  to: 'Shawn@Lab.Local',
  subject: 'Generated image',
  body: 'Attached.',
  attachment_doc_ids: ['images:test.png'],
};

function unique(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

afterEach(() => vi.useRealTimers());

describe('email delivery idempotency', () => {
  it('coalesces parallel identical sends within one logical turn', async () => {
    let sends = 0;
    const send = async markDispatchStarted => {
      markDispatchStarted();
      sends++;
      await new Promise(resolve => setTimeout(resolve, 25));
      return 'Email sent with 1 attachment(s): test.png. RFC Message-ID: <one@lab.local>.';
    };
    const scopeId = unique('parallel');
    const userId = unique('user');

    const [first, duplicate] = await Promise.all([
      sendEmailIdempotently({ userId, scopeId, payload, send }),
      sendEmailIdempotently({ userId, scopeId, payload, send }),
    ]);

    expect(sends).toBe(1);
    expect(first).toContain('Email sent with 1 attachment');
    expect(duplicate).toContain('Duplicate email suppressed');
    expect(duplicate).toContain('<one@lab.local>');
  });

  it('shares one durable boundary across email_user and email_compose retries', async () => {
    let sends = 0;
    const userId = unique('user');
    const scopeId = unique('cross_tool');

    // The public tool name is intentionally absent from the guard contract.
    // Both executors arrive here with the same normalized compose payload.
    const fromEmailUser = await sendEmailIdempotently({
      userId,
      scopeId,
      payload,
      send: async markDispatchStarted => {
        markDispatchStarted();
        sends++;
        return 'Email sent. RFC Message-ID: <cross-tool@lab.local>.';
      },
    });
    const fromEmailComposeAfterRestart = await sendEmailIdempotently({
      userId,
      scopeId,
      payload: { ...payload, to: ' shawn@lab.local ' },
      send: async markDispatchStarted => {
        markDispatchStarted();
        sends++;
        return 'SHOULD NOT SEND';
      },
    });

    expect(sends).toBe(1);
    expect(fromEmailUser).toContain('<cross-tool@lab.local>');
    expect(fromEmailComposeAfterRestart).toContain('Duplicate email suppressed');
    expect(fromEmailComposeAfterRestart).toContain('<cross-tool@lab.local>');
  });

  it('allows the same payload in a different logical turn', async () => {
    let sends = 0;
    const userId = unique('user');
    const send = async markDispatchStarted => {
      markDispatchStarted();
      return `Email sent. RFC Message-ID: <turn-${++sends}@lab.local>.`;
    };

    await sendEmailIdempotently({ userId, scopeId: unique('turn_a'), payload, send });
    await sendEmailIdempotently({ userId, scopeId: unique('turn_b'), payload, send });

    expect(sends).toBe(2);
  });

  it('does not cache a known pre-dispatch validation failure', async () => {
    const userId = unique('user');
    const scopeId = unique('validation');
    let sends = 0;
    const rejected = await sendEmailIdempotently({
      userId,
      scopeId,
      payload,
      send: async () => {
        sends++;
        return 'Attachment could not be resolved.';
      },
    });
    const retried = await sendEmailIdempotently({
      userId,
      scopeId,
      payload,
      send: async markDispatchStarted => {
        markDispatchStarted();
        sends++;
        return 'Email sent. RFC Message-ID: <retry@lab.local>.';
      },
    });

    expect(rejected).toBe('Attachment could not be resolved.');
    expect(retried).toContain('<retry@lab.local>');
    expect(sends).toBe(2);
  });

  it('uses the ambient root turn id for inline coordinator/specialist calls', async () => {
    const userId = unique('user');
    let sends = 0;
    await turnTraceContext.run(undefined, async () => {
      beginTurn({ userId, turnId: unique('root') });
      await sendEmailIdempotently({
        userId,
        payload,
        send: async markDispatchStarted => {
          markDispatchStarted();
          return `Email sent. RFC Message-ID: <ambient-${++sends}@lab.local>.`;
        },
      });
      const duplicate = await sendEmailIdempotently({
        userId,
        payload,
        send: async markDispatchStarted => {
          markDispatchStarted();
          return `Email sent. RFC Message-ID: <ambient-${++sends}@lab.local>.`;
        },
      });
      expect(duplicate).toContain('Duplicate email suppressed');
    });
    expect(sends).toBe(1);
  });

  it('fails closed after an indeterminate crash boundary', async () => {
    const userId = unique('user');
    const scopeId = unique('uncertain');
    let sends = 0;

    await expect(sendEmailIdempotently({
      userId,
      scopeId,
      payload,
      send: async markDispatchStarted => {
        markDispatchStarted();
        sends++;
        throw new Error('connection dropped after DATA');
      },
    })).rejects.toThrow('connection dropped after DATA');

    const retry = await sendEmailIdempotently({
      userId,
      scopeId,
      payload,
      send: async markDispatchStarted => {
        markDispatchStarted();
        sends++;
        return 'Email sent.';
      },
    });
    expect(sends).toBe(1);
    expect(looksLikeToolError(retry)).toBe(true);
    expect(retry).toContain('no retry was made');
  });

  it('suppresses an explicit browser retry with the same message id and a new attempt id', async () => {
    const userId = unique('user');
    const messageId = unique('message');
    let sends = 0;
    const runAttempt = attemptId => turnTraceContext.run(undefined, async () => {
      beginTurn({ userId, source: 'web', turnId: attemptId, attemptId, messageId });
      return sendEmailIdempotently({
        userId,
        payload,
        send: async markDispatchStarted => {
          markDispatchStarted();
          return `Email sent. RFC Message-ID: <retry-${++sends}@lab.local>.`;
        },
      });
    });

    const first = await runAttempt(unique('attempt_a'));
    const retry = await runAttempt(unique('attempt_b'));

    expect(first).toContain('Email sent');
    expect(retry).toContain('Duplicate email suppressed');
    expect(sends).toBe(1);
  });

  it('suppresses a changed payload on browser Retry after any email dispatched', async () => {
    const userId = unique('user');
    const scopeId = `message:${unique('message')}`;
    let sends = 0;
    const first = await sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-a', payload,
      send: async markDispatchStarted => {
        markDispatchStarted();
        sends++;
        return 'Email sent. RFC Message-ID: <first@lab.local>.';
      },
    });
    const changedRetry = await sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-b',
      payload: { ...payload, subject: 'Model rewrote this on Retry', body: 'Different body' },
      send: async markDispatchStarted => {
        markDispatchStarted();
        sends++;
        return 'Email sent. RFC Message-ID: <unsafe@lab.local>.';
      },
    });

    expect(first).toContain('<first@lab.local>');
    expect(changedRetry).toContain('retry of a request that already dispatched email');
    expect(looksLikeToolError(changedRetry)).toBe(true);
    expect(sends).toBe(1);
  });

  it('allows multiple distinct sends in the originating attempt but freezes new ones on Retry', async () => {
    const userId = unique('user');
    const scopeId = `message:${unique('message')}`;
    let sends = 0;
    const send = async markDispatchStarted => {
      markDispatchStarted();
      return `Email sent. RFC Message-ID: <distinct-${++sends}@lab.local>.`;
    };
    await sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-a',
      payload: { ...payload, to: 'one@example.test' }, send,
    });
    await sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-a',
      payload: { ...payload, to: 'two@example.test' }, send,
    });
    const retry = await sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-b',
      payload: { ...payload, to: 'three@example.test' }, send,
    });

    expect(sends).toBe(2);
    expect(looksLikeToolError(retry)).toBe(true);
  });

  it('lets a new browser attempt take over after a definite pre-dispatch failure', async () => {
    const userId = unique('user');
    const scopeId = `message:${unique('message')}`;
    await expect(sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-a', payload,
      send: async () => { throw new Error('credentials unavailable'); },
    })).rejects.toThrow('credentials unavailable');

    let sends = 0;
    const retry = await sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-b',
      payload: { ...payload, subject: 'Corrected after safe preflight failure' },
      send: async markDispatchStarted => {
        markDispatchStarted();
        sends++;
        return 'Email sent.';
      },
    });
    expect(retry).toContain('Email sent');
    expect(sends).toBe(1);
  });

  it('fails closed when a durable authorization ledger is unreadable', async () => {
    const userId = unique('user');
    const scopeId = `message:${unique('message')}`;
    let sends = 0;
    const send = async markDispatchStarted => {
      markDispatchStarted();
      sends++;
      return 'Email sent.';
    };
    await sendEmailIdempotently({ userId, scopeId, attemptId: 'attempt-a', payload, send });
    const scopesDir = path.join(USERS_DIR, userId, 'email-idempotency', '.scopes');
    const ledger = fs.readdirSync(scopesDir).find(name => name.endsWith('.json'));
    fs.writeFileSync(path.join(scopesDir, ledger), '{not-json', { mode: 0o600 });

    const retry = await sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-b',
      payload: { ...payload, subject: 'changed' }, send,
    });
    expect(looksLikeToolError(retry)).toBe(true);
    expect(sends).toBe(1);
  });

  it('allows distinct browser message ids even when their payloads match', async () => {
    const userId = unique('user');
    let sends = 0;
    const runMessage = messageId => turnTraceContext.run(undefined, async () => {
      const attemptId = unique('attempt');
      beginTurn({ userId, source: 'web', turnId: attemptId, attemptId, messageId });
      return sendEmailIdempotently({
        userId,
        payload,
        send: async markDispatchStarted => {
          markDispatchStarted();
          return `Email sent. RFC Message-ID: <message-${++sends}@lab.local>.`;
        },
      });
    });

    await runMessage(unique('message_a'));
    await runMessage(unique('message_b'));
    expect(sends).toBe(2);
  });

  it('normalizes recipient and attachment order plus repeated values', async () => {
    const userId = unique('user');
    const scopeId = unique('recipients');
    let sends = 0;
    const send = async markDispatchStarted => {
      markDispatchStarted();
      return `Email sent. RFC Message-ID: <recipients-${++sends}@lab.local>.`;
    };
    await sendEmailIdempotently({
      userId,
      scopeId,
      payload: {
        ...payload,
        to: 'b@example.test, a@example.test, B@example.test',
        attachment_doc_ids: ['images:b.png', 'images:a.png', 'images:b.png'],
      },
      send,
    });
    const duplicate = await sendEmailIdempotently({
      userId,
      scopeId,
      payload: {
        ...payload,
        to: 'a@example.test,b@example.test',
        attachment_doc_ids: ['images:a.png', 'images:b.png'],
      },
      send,
    });
    expect(sends).toBe(1);
    expect(duplicate).toContain('Duplicate email suppressed');
  });

  it('deduplicates confirmed replies without conflating them with compose', async () => {
    const userId = unique('user');
    const scopeId = unique('reply');
    let sends = 0;
    const replyPayload = { ...payload, action: 'reply', messageId: 'provider-message-7', to: '', subject: '' };
    const sendReply = async markDispatchStarted => {
      markDispatchStarted();
      sends++;
      return 'Reply sent.';
    };
    await sendEmailIdempotently({ userId, scopeId, payload: replyPayload, send: sendReply });
    const duplicate = await sendEmailIdempotently({ userId, scopeId, payload: replyPayload, send: sendReply });
    expect(duplicate).toContain('Duplicate email suppressed');

    await sendEmailIdempotently({
      userId,
      scopeId,
      payload: { ...payload, action: 'compose' },
      send: async markDispatchStarted => {
        markDispatchStarted();
        sends++;
        return 'Email sent.';
      },
    });
    expect(sends).toBe(2);
  });

  it('deduplicates IMAP reply UID and RFC Message-ID aliases after canonical preflight', async () => {
    const userId = unique('user');
    const scopeId = `message:${unique('reply_alias')}`;
    let sends = 0;
    const send = async markDispatchStarted => {
      markDispatchStarted();
      sends++;
      return 'Reply sent.';
    };
    await sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-a',
      payload: { ...payload, action: 'reply', messageId: '17', canonicalReplyId: '<same@lab.local>' },
      send,
    });
    const retry = await sendEmailIdempotently({
      userId, scopeId, attemptId: 'attempt-b',
      payload: { ...payload, action: 'reply', messageId: '<same@lab.local>', canonicalReplyId: '<same@lab.local>' },
      send,
    });
    expect(sends).toBe(1);
    expect(retry).toContain('Duplicate email suppressed');
  });

  it('treats one programmatic watcher scope as one send even if retry payload changes', async () => {
    const userId = unique('user');
    const fireScope = unique('watcher_fire');
    let sends = 0;
    const run = nextPayload => withEmailDeliveryScope(fireScope, () =>
      sendEmailIdempotently({
        userId,
        payload: nextPayload,
        send: async markDispatchStarted => {
          markDispatchStarted();
          return `Email sent. RFC Message-ID: <watcher-${++sends}@lab.local>.`;
        },
      }));

    await run({ ...payload, subject: 'Initial watcher update' });
    const retry = await run({ ...payload, subject: 'Changed after restart' });
    expect(sends).toBe(1);
    expect(retry).toContain('Duplicate email suppressed');
  });

  it('retains completed tombstones while the durable source message remains retryable', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const userId = unique('user');
    const messageId = unique('message');
    const agentId = 'jarvis_test';
    const sessionsDir = path.join(USERS_DIR, userId, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${agentId}.session-epoch`), 'epoch-a', { mode: 0o600 });
    fs.writeFileSync(path.join(sessionsDir, `${agentId}.jsonl`), `${JSON.stringify({
      role: 'user', content: 'send it', messageId,
    })}\n`, { mode: 0o600 });

    await turnTraceContext.run(undefined, async () => {
      beginTurn({ userId, turnId: 'attempt-a', attemptId: 'attempt-a', messageId });
      Object.assign(getTurn(), { sessionKey: `${userId}_${agentId}`, sessionEpoch: 'epoch-a' });
      await sendEmailIdempotently({
        userId, payload,
        send: async markDispatchStarted => {
          markDispatchStarted();
          return 'Email sent. RFC Message-ID: <retained@lab.local>.';
        },
      });
    });

    const storeDir = path.join(USERS_DIR, userId, 'email-idempotency');
    const operation = fs.readdirSync(storeDir).find(name => name.endsWith('.json'));
    expect(operation).toBeTruthy();
    const scopeFile = fs.readdirSync(path.join(storeDir, '.scopes'))
      .find(name => name.endsWith('.json'));
    expect(scopeFile).toBeTruthy();
    const old = new Date(start.getTime() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(storeDir, operation), old, old);
    fs.utimesSync(path.join(storeDir, '.scopes', scopeFile), old, old);
    vi.setSystemTime(new Date(start.getTime() + 2 * 60 * 60 * 1000));

    await sendEmailIdempotently({
      userId, scopeId: unique('sweep'), payload,
      send: async markDispatchStarted => {
        markDispatchStarted();
        return 'Email sent.';
      },
    });
    expect(fs.existsSync(path.join(storeDir, operation))).toBe(true);

    // Once the exact source row leaves the bounded session history, both the
    // operation tombstone and its authorization ledger can be reclaimed.
    fs.writeFileSync(path.join(sessionsDir, `${agentId}.jsonl`), '', { mode: 0o600 });
    vi.setSystemTime(new Date(start.getTime() + 4 * 60 * 60 * 1000));
    await sendEmailIdempotently({
      userId, scopeId: unique('sweep_after_prune'), payload,
      send: async markDispatchStarted => {
        markDispatchStarted();
        return 'Email sent.';
      },
    });
    expect(fs.existsSync(path.join(storeDir, operation))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, '.scopes', scopeFile))).toBe(false);
  });

  it('allows retry after a definite pre-dispatch failure', async () => {
    const userId = unique('user');
    const scopeId = unique('preflight');
    let providerSends = 0;
    await expect(sendEmailIdempotently({
      userId,
      scopeId,
      payload,
      send: async () => { throw new Error('credential decrypt failed'); },
    })).rejects.toThrow('credential decrypt failed');

    const retried = await sendEmailIdempotently({
      userId,
      scopeId,
      payload,
      send: async markDispatchStarted => {
        markDispatchStarted();
        providerSends++;
        return 'Email sent.';
      },
    });
    expect(retried).toContain('Email sent');
    expect(providerSends).toBe(1);
  });
});
