import { describe, expect, it } from 'vitest';

import {
  buildImapInboxSearch,
  buildImapPurgeSearch,
  canonicalImapReplyIdentity,
  decodeImapBodyPart,
  normalizeImapPageSize,
  normalizeImapSearchUids,
  resolveImapUid,
  selectImapTextParts,
} from './imap-client.mjs';

describe('IMAP search compatibility', () => {
  it('searches exactly subject, From header, and body for free text', () => {
    expect(buildImapInboxSearch('*:1', 'Quarterly invoice')).toEqual({
      uid: '*:1',
      or: [
        { subject: 'Quarterly invoice' },
        { header: { From: 'Quarterly invoice' } },
        { body: 'Quarterly invoice' },
      ],
    });
  });

  it('normalizes simple quoted field searches emitted by models', () => {
    expect(buildImapInboxSearch('*:1', 'subject:"READ EXPLICIT run-123"')).toEqual({
      uid: '*:1',
      subject: 'READ EXPLICIT run-123',
    });
    expect(buildImapInboxSearch('1:20', 'from:sender@example.test')).toEqual({
      uid: '1:20',
      header: { From: 'sender@example.test' },
    });
    expect(buildImapInboxSearch(null, 'body:"invoice total"')).toEqual({
      body: 'invoice total',
    });
  });

  it('removes balanced Gmail-style phrase quotes before portable IMAP search', () => {
    expect(buildImapInboxSearch('*:1', '"WORKER BETA run-123"')).toEqual({
      uid: '*:1',
      or: [
        { subject: 'WORKER BETA run-123' },
        { header: { From: 'WORKER BETA run-123' } },
        { body: 'WORKER BETA run-123' },
      ],
    });
    expect(buildImapInboxSearch(null, "'Quarterly invoice'")).toEqual({
      or: [
        { subject: 'Quarterly invoice' },
        { header: { From: 'Quarterly invoice' } },
        { body: 'Quarterly invoice' },
      ],
    });
  });

  it('keeps empty queries scoped only by the UID range', () => {
    expect(buildImapInboxSearch('1:20', '   ')).toEqual({ uid: '1:20' });
  });

  it('uses the same exact content semantics for purge and HEADER From for senders', () => {
    expect(buildImapPurgeSearch('Jane Doe', null)).toEqual({
      header: { From: 'Jane Doe' },
    });
    expect(buildImapPurgeSearch(null, 'Quarterly invoice')).toEqual({
      or: [
        { subject: 'Quarterly invoice' },
        { header: { From: 'Quarterly invoice' } },
        { body: 'Quarterly invoice' },
      ],
    });
    expect(() => buildImapPurgeSearch(null, null)).toThrow(/requires a non-empty/i);
    expect(() => buildImapPurgeSearch('  ', '  ')).toThrow(/requires a non-empty/i);
  });

  it('rejects control characters and oversized mailbox queries', () => {
    expect(() => buildImapInboxSearch('*:1', 'subject:ok\r\nBAD')).toThrow(/Invalid IMAP query/);
    expect(() => buildImapInboxSearch('*:1', `subject:${'x'.repeat(513)}`)).toThrow(/Invalid IMAP query/);
  });

  it('distinguishes no matches from rejected and malformed SEARCH responses', () => {
    expect(normalizeImapSearchUids([])).toEqual([]);
    expect(normalizeImapSearchUids([3, 1, 3])).toEqual([3, 1]);
    expect(() => normalizeImapSearchUids(false)).toThrow(/server rejected/i);
    expect(() => normalizeImapSearchUids(undefined)).toThrow(/server rejected/i);
    expect(() => normalizeImapSearchUids(new Set([3]))).toThrow(/unexpected response/i);
    expect(() => normalizeImapSearchUids({ 0: 3, length: 1 })).toThrow(/unexpected response/i);
    expect(() => normalizeImapSearchUids([3, 0])).toThrow(/invalid UID/i);
    expect(() => normalizeImapSearchUids([0x1_0000_0000])).toThrow(/invalid UID/i);
  });

  it('bounds IMAP list pages even when a caller bypasses tool-schema validation', () => {
    expect(normalizeImapPageSize(undefined)).toBe(10);
    expect(normalizeImapPageSize(-1)).toBe(10);
    expect(normalizeImapPageSize(2.5)).toBe(10);
    expect(normalizeImapPageSize('7')).toBe(7);
    expect(normalizeImapPageSize(10_000)).toBe(100);
  });
});

describe('IMAP body decoding', () => {
  it('uses TEXT for a single-part plain message', () => {
    expect(selectImapTextParts({
      type: 'text/plain',
      encoding: '7bit',
      parameters: { charset: 'utf-8' },
    })).toEqual({
      html: null,
      plain: { part: 'TEXT', type: 'text/plain', encoding: '7bit', charset: 'utf-8' },
    });
  });

  it('finds preferred text parts through nested MIME structures', () => {
    const selected = selectImapTextParts({
      type: 'multipart/mixed',
      childNodes: [{
        type: 'multipart/alternative',
        childNodes: [
          { part: '1.1', type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } },
          { part: '1.2', type: 'text/html', encoding: 'base64', parameters: { charset: 'utf-8' } },
        ],
      }, { part: '2', type: 'application/pdf' }],
    });
    expect(selected.plain?.part).toBe('1.1');
    expect(selected.html?.part).toBe('1.2');
  });

  it('decodes quoted-printable soft wraps and hex bytes', () => {
    expect(decodeImapBodyPart(Buffer.from('hello=\r\n world=21'), 'quoted-printable'))
      .toBe('hello world!');
  });

  it('decodes base64 text parts', () => {
    expect(decodeImapBodyPart(Buffer.from('aGVsbG8g8J+MjQ=='), 'base64'))
      .toBe('hello 🌍');
  });
});

describe('IMAP message identifier resolution', () => {
  it('uses the RFC Message-ID as the stable reply identity with UID fallback', () => {
    expect(canonicalImapReplyIdentity({ uid: '17', messageId: '<same@lab.local>' }))
      .toBe('<same@lab.local>');
    expect(canonicalImapReplyIdentity({ uid: '17', messageId: null }))
      .toBe('imap-uid:17');
  });

  it('accepts numeric and bracketed UIDs without searching', async () => {
    const client = { search: () => { throw new Error('search should not run'); } };
    await expect(resolveImapUid(client, '42')).resolves.toBe('42');
    await expect(resolveImapUid(client, '[43]')).resolves.toBe('43');
  });

  it('resolves an SMTP RFC Message-ID to the newest matching UID', async () => {
    const search = async () => [3, 9];
    const client = { search };
    await expect(resolveImapUid(client, '<generated@lab.local>')).resolves.toBe('9');
  });

  it('returns actionable guidance when an RFC Message-ID is absent', async () => {
    const client = { search: async () => [] };
    await expect(resolveImapUid(client, '<missing@lab.local>'))
      .rejects.toThrow(/Call email_list.*numeric UID/);
  });

  it('reports a rejected Message-ID search as a server failure', async () => {
    const client = { search: async () => false };
    await expect(resolveImapUid(client, '<missing@lab.local>'))
      .rejects.toThrow(/server rejected/i);
  });
});
