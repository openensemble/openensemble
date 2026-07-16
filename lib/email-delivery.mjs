// @ts-check
/**
 * Programmatic email delivery for watchers + scheduled deliveries.
 *
 * The chat-facing email skill (skills/email/execute.mjs) is the right
 * surface when an LLM agent is composing on behalf of the user. This
 * helper is for the OTHER case: a watcher / scheduler / system event
 * needs to send a single email FROM the user's primary connected account
 * TO the user themselves (or an explicit address). No LLM round-trip,
 * no tool dispatch, no agent turn required.
 *
 * Routes through the same gmail / Microsoft Graph / IMAP+SMTP paths the
 * email skill uses — we just call its `execute('email_compose', ...)`
 * function with the user's own email as the recipient.
 */

import fs from 'fs';
import path from 'path';
import { BASE_DIR } from './paths.mjs';
import { looksLikeToolError } from './tool-error.mjs';
import { log } from '../logger.mjs';

function readUserProfile(userId) {
  try {
    const p = path.join(BASE_DIR, 'users', userId, 'profile.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

export function readUserEmail(userId) {
  return readUserProfile(userId)?.email || null;
}

/** Resolve the user's own mailbox without confusing an SMTP/IMAP login name
 * (often just `shawn`) for an RFC recipient address. */
export function resolveNotificationRecipient(account, profileEmail = null) {
  const login = String(account?.username || '').trim();
  return account?.email
    || account?.smtpFrom
    || (login.includes('@') ? login : null)
    || profileEmail
    || login
    || null;
}

/**
 * Send an email FROM the user's primary connected account TO the user
 * themselves (or an explicit recipient). Used by watcher onFire='email'
 * deliveries — no LLM, no agent turn.
 *
 * @param {string} userId
 * @param {object} opts
 * @param {string} opts.subject              — plain ASCII subject (no emoji)
 * @param {string} opts.body                 — plain-text body
 * @param {string} [opts.html]               optional HTML body
 * @param {string} [opts.to]                 override recipient; defaults to
 *                                            the user's own profile email
 * @param {string} [opts.account]            connected-account label or id;
 *                                            defaults to the first/primary
 * @param {string} [opts.idempotencyScope]   internal stable watcher/scheduler
 *                                            fire id; one scope sends at most once
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function sendEmailToUser(userId, opts) {
  if (!userId) return { ok: false, message: 'userId required' };
  const subject = String(opts?.subject || '').trim();
  const body    = String(opts?.body    || '').trim();
  if (!subject || !body) return { ok: false, message: 'subject + body required' };
  const html    = opts?.html ? String(opts.html) : undefined;
  let to = opts?.to;
  if (!to) {
    to = readUserEmail(userId);
    if (!to) return { ok: false, message: 'no email on user profile and no explicit recipient' };
  }
  try {
    // Email-skill executor handles account resolution + provider dispatch
    // (gmail / microsoft / imap+smtp) internally.
    const mod = await import('../skills/email/execute.mjs');
    const invoke = () => mod.default('email_compose', {
      to,
      subject,
      body,
      ...(html ? { html_body: html } : {}),
      ...(opts?.account ? { account: opts.account } : {}),
    }, userId);
    let result;
    if (opts?.idempotencyScope) {
      const { withEmailDeliveryScope } = await import('./email-idempotency.mjs');
      result = await withEmailDeliveryScope(opts.idempotencyScope, invoke);
    } else {
      result = await invoke();
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    // This helper only performs email_compose. Treat success as an explicit
    // provider/idempotency confirmation; prose refusals such as "No email
    // accounts connected" must never be promoted to a delivered=true result.
    const ok = !looksLikeToolError(text)
      && /^(?:Email sent\b|Duplicate email suppressed\b)/i.test(text.trim());
    return { ok, message: text };
  } catch (e) {
    log.warn('email-delivery', 'send failed', { userId, err: e.message });
    return { ok: false, message: `Send threw: ${e.message}` };
  }
}
