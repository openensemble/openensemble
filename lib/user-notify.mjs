/**
 * Send a notification to a user via their available channels (Telegram +
 * email). Best-effort: failures are logged, not thrown — callers should
 * treat this as fire-and-hope.
 *
 * Picks the user's preferred email sender (user.reminderEmailId if set,
 * otherwise the first sendable account in their email-accounts.json).
 * Branches per-provider for the actual send.
 *
 * Automatic callers should pass idempotencyScope: a stable event identity
 * (alarm id, device episode id, etc.) so email remains at-most-once across
 * process restart and overlapping monitor ticks.
 *
 * Returns { telegram: bool, email: bool } indicating which channels
 * succeeded. Caller can decide whether either was sufficient.
 *
 * Used by alarm ack-timeout fallback (lib/alarms.mjs Phase A4). Could
 * replace the duplicated block in server.mjs fireReminder in a future
 * refactor; for now it stands alone.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { sendTelegramToUser } from '../routes/telegram.mjs';
import { loadUsers } from '../routes/_helpers.mjs';
import { resolveNotificationRecipient, sendEmailToUser } from './email-delivery.mjs';

function loadUser(userId) {
  try { return loadUsers().find(u => u.id === userId) ?? null; }
  catch { return null; }
}

function loadEmailAccounts(userId) {
  try {
    const p = path.join(USERS_DIR, userId, 'email-accounts.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  } catch { return []; }
}

const isSendable = (a) => a.provider === 'gmail' ||
                           a.provider === 'microsoft' ||
                           (a.smtpHost && a.encryptedPassword);

export async function sendUserNotification(userId, { subject, body, idempotencyScope } = {}) {
  const results = { telegram: false, email: false };
  if (!userId || !subject) return results;

  // Telegram first — cheap and fast when configured.
  try {
    const ok = await sendTelegramToUser(userId, `${subject}\n\n${body || ''}`.trim());
    if (ok) results.telegram = true;
  } catch (e) { console.warn(`[notify] telegram failed for ${userId}: ${e.message}`); }

  // Email via the user's preferred sender, mirroring the reminder fallback in
  // server.mjs:fireReminder. Provider-specific send paths follow the same
  // shape used there.
  try {
    const user = loadUser(userId);
    const accts = loadEmailAccounts(userId);
    const preferredId = user?.reminderEmailId;
    const preferred = preferredId ? accts.find(a => a.id === preferredId) : null;
    const sender = (preferred && isSendable(preferred)) ? preferred : accts.find(isSendable);
    if (!sender) return results;
    const to = resolveNotificationRecipient(sender, user?.email);
    if (!to) return results;

    const delivery = await sendEmailToUser(userId, {
      to,
      subject,
      body: body || '',
      account: sender.id,
      ...(idempotencyScope ? { idempotencyScope } : {}),
    });
    results.email = delivery.ok;
    if (!delivery.ok) console.warn(`[notify] email send failed for ${userId}: ${delivery.message}`);
  } catch (e) { console.warn(`[notify] email failed for ${userId}: ${e.message}`); }

  return results;
}
