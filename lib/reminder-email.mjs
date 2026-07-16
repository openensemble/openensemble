/**
 * Durable email delivery for the scheduler's fireReminder builtin.
 *
 * A reminder is an automatic side effect: the provider can accept the
 * message and the process can stop before scheduler state is persisted.  The
 * scheduler therefore supplies one stable identity per authorized fire, and
 * this module binds the outbound email to that identity before dispatch.
 */

import fs from 'node:fs';
import path from 'node:path';

import { USERS_DIR } from './paths.mjs';
import { resolveNotificationRecipient, sendEmailToUser } from './email-delivery.mjs';

function loadEmailAccounts(userId) {
  try {
    const file = path.join(USERS_DIR, userId, 'email-accounts.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  } catch {
    return [];
  }
}

const isSendable = account => account?.provider === 'gmail'
  || account?.provider === 'microsoft'
  || (account?.smtpHost && account?.encryptedPassword);

/**
 * One durable key per scheduler occurrence.  A missing run context is an
 * unsupported legacy call, but still fails safe: it collapses onto a stable
 * task-derived key instead of silently sending without a guard.
 */
export function reminderEmailDeliveryScope(task, runContext = {}) {
  const taskId = String(task?.id || 'unknown-task');
  const occurrence = String(
    runContext.scheduledRunRootId
      || runContext.occurrenceId
      || task?.datetime
      || task?.nextRunAt
      || `legacy:${taskId}`,
  );
  return `fire-reminder-email:${taskId}:${occurrence}`;
}

/**
 * Send a reminder through the unified, idempotent email executor.
 * Returns the same {ok,message} shape as sendEmailToUser plus `skipped` for
 * configuration-only no-op cases.
 */
export async function sendReminderEmail(task, user, runContext = {}) {
  const userId = String(task?.ownerId || '');
  if (!userId) return { ok: false, skipped: true, message: 'reminder owner is missing' };

  const accounts = loadEmailAccounts(userId);
  const preferredId = user?.reminderEmailId;
  const preferred = preferredId ? accounts.find(account => account.id === preferredId) : null;
  const sender = (preferred && isSendable(preferred)) ? preferred : accounts.find(isSendable);
  if (!sender) {
    return {
      ok: false,
      skipped: true,
      message: 'no sendable account (need Gmail OAuth, Microsoft OAuth, or SMTP)',
    };
  }

  // Preserve the historical reminder recipient policy: the selected account's
  // mailbox address wins, then the user's profile address.
  const to = resolveNotificationRecipient(sender, user?.email);
  if (!to) {
    return {
      ok: false,
      skipped: true,
      message: `sender account "${sender.label || sender.id}" has no recipient address`,
    };
  }

  const label = String(task?.label || 'Reminder');
  const subject = `Reminder: ${label}`;
  const body = `This is your reminder:\n\n${label}\n\nFired at ${new Date().toLocaleString()}.`;
  return sendEmailToUser(userId, {
    to,
    subject,
    body,
    account: sender.id,
    idempotencyScope: reminderEmailDeliveryScope(task, runContext),
  });
}
