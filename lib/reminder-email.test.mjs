import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(async () => 'lab-password'),
  sendMail: vi.fn(),
  sendTelegram: vi.fn(async () => false),
}));

vi.mock('./email-crypto.mjs', () => ({ decrypt: mocks.decrypt }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: mocks.sendMail }),
  },
}));
vi.mock('../routes/telegram.mjs', () => ({ sendTelegramToUser: mocks.sendTelegram }));

const { USERS_DIR } = await import('./paths.mjs');
const { sendReminderEmail, reminderEmailDeliveryScope } = await import('./reminder-email.mjs');
const { sendUserNotification } = await import('./user-notify.mjs');
const { sendScheduledFailureEmail } = await import('../background-tasks.mjs');
const { browserFieldWatchHandler } = await import('./browser-field-watches.mjs');
const { handlerHelpers } = await import('../scheduler/watchers.mjs');

const createdUsers = new Set();

function makeUser(label) {
  const userId = `user_auto_email_${label}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const dir = path.join(USERS_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  const profile = {
    id: userId,
    name: 'Automatic Email Test',
    role: 'owner',
    email: 'shawn@lab.local',
    reminderEmailId: 'lab-mail',
  };
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile, null, 2));
  fs.writeFileSync(path.join(dir, 'email-accounts.json'), JSON.stringify([{
    id: 'lab-mail',
    label: 'Lab Mail',
    provider: 'imap',
    // Authentication login intentionally differs from the RFC mailbox.  The
    // reminder must select smtpFrom/profile for the recipient, not this value.
    username: 'shawn',
    smtpUsername: 'shawn',
    smtpFrom: 'shawn@lab.local',
    smtpHost: '127.0.0.1',
    smtpPort: 3025,
    encryptedPassword: 'encrypted-placeholder',
  }], null, 2));
  createdUsers.add(userId);
  return profile;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decrypt.mockResolvedValue('lab-password');
  mocks.sendTelegram.mockResolvedValue(false);
  mocks.sendMail.mockResolvedValue({ messageId: '<automatic@lab.local>' });
});

afterEach(() => {
  for (const userId of createdUsers) {
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
  createdUsers.clear();
});

describe('automatic reminder email delivery', () => {
  it('derives the same scope for one scheduler occurrence and a different scope for the next', () => {
    const task = { id: 'reminder-1', nextRunAt: '2026-07-13T12:00:00.000Z' };
    const first = reminderEmailDeliveryScope(task, {
      occurrenceId: '2026-07-13T12:00:00.000Z',
      scheduledRunRootId: 'scheduled:reminder-1:2026-07-13T12:00:00.000Z',
    });
    const retry = reminderEmailDeliveryScope(task, {
      occurrenceId: '2026-07-13T12:00:00.000Z',
      scheduledRunRootId: 'scheduled:reminder-1:2026-07-13T12:00:00.000Z',
    });
    const next = reminderEmailDeliveryScope(task, {
      occurrenceId: '2026-07-14T12:00:00.000Z',
      scheduledRunRootId: 'scheduled:reminder-1:2026-07-14T12:00:00.000Z',
    });
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
  });

  it('sends one email when the same reminder occurrence is retried', async () => {
    const user = makeUser('reminder_success');
    const task = { id: 'reminder-success', ownerId: user.id, label: 'Check the oven' };
    const runContext = {
      occurrenceId: '2026-07-13T12:00:00.000Z',
      scheduledRunRootId: 'scheduled:reminder-success:2026-07-13T12:00:00.000Z',
    };

    const first = await sendReminderEmail(task, user, runContext);
    const retry = await sendReminderEmail(task, user, runContext);

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(retry.message).toContain('Duplicate email suppressed');
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'shawn@lab.local' }));
  });

  it('fails closed after a transport error beyond the provider dispatch boundary', async () => {
    const user = makeUser('reminder_uncertain');
    const task = { id: 'reminder-uncertain', ownerId: user.id, label: 'Take medication' };
    const runContext = {
      occurrenceId: '2026-07-13T13:00:00.000Z',
      scheduledRunRootId: 'scheduled:reminder-uncertain:2026-07-13T13:00:00.000Z',
    };
    mocks.sendMail.mockRejectedValue(new Error('connection dropped after provider acceptance'));

    const first = await sendReminderEmail(task, user, runContext);
    const retry = await sendReminderEmail(task, user, runContext);

    expect(first.ok).toBe(false);
    expect(retry.ok).toBe(false);
    expect(retry.message).toMatch(/uncertain|no retry/i);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it('guards user-notify automatic events by their stable event scope', async () => {
    const user = makeUser('user_notify');
    const event = {
      subject: 'Alarm not acknowledged',
      body: 'The kitchen alarm was not acknowledged.',
      idempotencyScope: 'alarm-ack-fallback:alarm-123',
    };

    const first = await sendUserNotification(user.id, event);
    const retry = await sendUserNotification(user.id, {
      ...event,
      body: 'Changed wording after restart.',
    });

    expect(first.email).toBe(true);
    expect(retry.email).toBe(true);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it('durably suppresses duplicate scheduled-failure notices for one task/day', async () => {
    const user = makeUser('scheduled_failure');

    await sendScheduledFailureEmail({
      userId: user.id,
      taskId: 'bg_first',
      originScheduledTaskId: 'daily-briefing',
      originScheduledRunId: 'scheduled:daily-briefing:2026-07-13T23:59:59.000Z',
      pipeName: 'Research → Email',
      originalTask: 'Research the news and email it to me',
      reason: 'provider connection dropped',
    });
    await sendScheduledFailureEmail({
      userId: user.id,
      taskId: 'bg_retry',
      originScheduledTaskId: 'daily-briefing',
      originScheduledRunId: 'scheduled:daily-briefing:2026-07-13T23:59:59.000Z',
      pipeName: 'Research → Email',
      originalTask: 'Research the news and email it to me',
      reason: 'changed wording after restart',
    });

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it('retains a browser-watch event when captured email delivery fails', async () => {
    const user = makeUser('watcher_delivery_failure');
    mocks.sendMail.mockRejectedValue(new Error('SMTP capture unavailable'));
    const event = {
      id: 'price-change-1',
      label: 'Mower price',
      previous: { value: 500, currency: 'USD' },
      current: { value: 450, currency: 'USD', signature: 'usd-450' },
    };
    const record = {
      id: 'watcher-email-failure',
      userId: user.id,
      agentId: `${user.id}_jarvis_lab`,
      label: 'Mower price',
      kind: 'browser_field_watch',
      ticks: 7,
      onFire: { type: 'email', subject: 'Mower price changed' },
      state: { items: [{ id: 'mower', deliver: 'email' }] },
    };
    const state = {
      items: [{
        id: 'mower',
        status: 'active',
        label: 'Mower price',
        execution: { mode: 'browser' },
        nextDueAt: Number.MAX_SAFE_INTEGER,
        pendingEvent: event,
      }],
    };

    const result = await browserFieldWatchHandler(
      state,
      handlerHelpers(record),
      { now: 1_000 },
    );

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(result.newState.items[0].pendingEvent).toEqual(event);
    expect(result.newState.items[0].lastNotified).toBeUndefined();

    // A later supervisor tick replays the same durable event. Even if SMTP is
    // now healthy, the earlier timeout may have followed provider acceptance,
    // so the event-bound idempotency scope must fail closed without resending.
    mocks.sendMail.mockResolvedValue({ messageId: '<must-not-resend@lab.local>' });
    const retry = await browserFieldWatchHandler(
      result.newState,
      handlerHelpers({ ...record, ticks: 8 }),
      { now: 2_000 },
    );
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(retry.newState.items[0].pendingEvent).toEqual(event);
    expect(retry.newState.items[0].lastNotified).toBeUndefined();
  });
});
