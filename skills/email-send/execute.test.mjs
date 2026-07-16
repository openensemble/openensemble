import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ compose: vi.fn() }));

vi.mock('../email/execute.mjs', () => ({ default: mocks.compose }));

import execute from './execute.mjs';

describe('email_user', () => {
  beforeEach(() => {
    mocks.compose.mockReset();
    mocks.compose.mockResolvedValue('Email sent with 1 attachment(s): generated.png.');
  });

  it('passes attachment_doc_ids through the shared email_compose path', async () => {
    const result = await execute('email_user', {
      to: 'shawn@lab.local',
      subject: 'Generated image',
      body: 'Attached.',
      attachment_doc_ids: ['images:generated.png'],
    }, 'user_test');

    expect(result).toContain('Email sent');
    expect(mocks.compose).toHaveBeenCalledTimes(1);
    expect(mocks.compose).toHaveBeenCalledWith('email_compose', {
      to: 'shawn@lab.local',
      subject: 'Generated image',
      body: 'Attached.',
      attachment_doc_ids: ['images:generated.png'],
    }, 'user_test');
  });
});
