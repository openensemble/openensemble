import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock('./email-crypto.mjs', () => ({ decrypt: mocks.decrypt }));
vi.mock('nodemailer', () => ({
  default: { createTransport: mocks.createTransport },
}));

import { resolveSmtpFrom, sendSmtpEmail } from './smtp-client.mjs';

beforeEach(() => {
  mocks.decrypt.mockReset();
  mocks.createTransport.mockReset();
  mocks.sendMail.mockReset();
});

describe('SMTP envelope sender resolution', () => {
  it('keeps authentication identity separate from an explicit From address', () => {
    expect(resolveSmtpFrom({
      username: 'shawn',
      smtpUsername: 'shawn',
      smtpFrom: 'shawn@lab.local',
    })).toBe('shawn@lab.local');
  });

  it('preserves existing email and username fallbacks', () => {
    expect(resolveSmtpFrom({ email: 'person@example.com', username: 'login' }))
      .toBe('person@example.com');
    expect(resolveSmtpFrom({ username: 'legacy-login' })).toBe('legacy-login');
  });

  it('rejects missing and header-injected sender values', () => {
    expect(() => resolveSmtpFrom({})).toThrow(/not configured/);
    expect(() => resolveSmtpFrom({ smtpFrom: 'ok@example.com\r\nBcc: attacker@example.com' }))
      .toThrow(/invalid/);
  });
});

describe('SMTP dispatch boundary', () => {
  const account = {
    smtpHost: 'mail.example.test',
    smtpPort: 587,
    smtpUsername: 'login',
    smtpFrom: 'sender@example.test',
    encryptedPassword: 'encrypted',
  };

  it('marks the durable boundary after preflight and before sendMail', async () => {
    const events = [];
    mocks.decrypt.mockImplementation(async () => {
      events.push('decrypt');
      return 'secret';
    });
    mocks.createTransport.mockImplementation(() => {
      events.push('transport');
      return { sendMail: mocks.sendMail };
    });
    mocks.sendMail.mockImplementation(async () => {
      events.push('sendMail');
      return { messageId: '<one@example.test>' };
    });

    const result = await sendSmtpEmail('user_test', account, {
      to: 'recipient@example.test',
      subject: 'Boundary',
      body: 'Test',
    }, () => events.push('mark'));

    expect(events).toEqual(['decrypt', 'transport', 'mark', 'sendMail']);
    expect(result).toContain('Email sent');
  });

  it('does not mark or dispatch when preflight fails', async () => {
    const mark = vi.fn();
    mocks.decrypt.mockRejectedValue(new Error('decrypt failed'));

    await expect(sendSmtpEmail('user_test', account, {
      to: 'recipient@example.test',
      subject: 'Boundary',
      body: 'Test',
    }, mark)).rejects.toThrow('decrypt failed');

    expect(mark).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
});
