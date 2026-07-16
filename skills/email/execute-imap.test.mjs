import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchInboxPage: vi.fn(),
}));

vi.mock('../../lib/imap-client.mjs', () => ({
  fetchInboxPage: mocks.fetchInboxPage,
  fetchImapMessageBody: vi.fn(),
  deleteImapMessages: vi.fn(),
  markImapMessages: vi.fn(),
  fetchImapReplyHeaders: vi.fn(),
  purgeImapBySender: vi.fn(),
  fetchImapInboxStats: vi.fn(),
}));

import { execImap } from './execute.mjs';

beforeEach(() => {
  mocks.fetchInboxPage.mockReset();
  mocks.fetchInboxPage.mockResolvedValue({
    emails: [{
      id: '37',
      from: 'sender@example.test',
      subject: 'Quarterly invoice',
      date: 'today',
      snippet: 'Invoice body',
    }],
    nextPageToken: null,
  });
});

describe('IMAP email dispatch', () => {
  it('forwards an email_list query to the mailbox search client', async () => {
    const account = { id: 'imap_test', label: 'Lab Mail', provider: 'imap' };
    const result = await execImap('email_list', {
      account: 'Lab Mail',
      query: 'Quarterly invoice',
      maxResults: 7,
    }, account, 'user_test');

    expect(mocks.fetchInboxPage).toHaveBeenCalledOnce();
    expect(mocks.fetchInboxPage).toHaveBeenCalledWith(
      'user_test', account, null, 7, 'Quarterly invoice',
    );
    expect(result).toContain('Subject: Quarterly invoice');
  });
});
