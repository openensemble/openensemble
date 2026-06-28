// @ts-check
/**
 * email-send — a universal "deliver email" primitive.
 *
 * always_on, so EVERY agent gets `email_user`: a send-only tool to email the
 * user (or a recipient) directly from the user's primary connected account, with
 * NO hand-off to the email specialist. This is the email counterpart to
 * send_telegram_message — an output channel, not the email domain. Reading,
 * triage, labels, and bulk inbox ops stay on the full `email` skill.
 *
 * It delegates the actual compose to the email skill's email_compose executor,
 * so it inherits account resolution, provider dispatch (gmail / microsoft /
 * imap+smtp), body_doc_id inlining (markdown→HTML) and transient-doc cleanup —
 * one code path, no duplication.
 */

import { readUserEmail } from '../../lib/email-delivery.mjs';

// "email me" / "send it to myself" → resolve to the user's own address rather
// than treating the literal word as a recipient.
const SELF_RECIPIENTS = /^(?:me|myself|self|owner|user|the user)$/i;

export default async function execute(name, args, userId) {
  if (name !== 'email_user') return `Unknown tool: ${name}`;
  args = args || {};

  // Recipient resolution: explicit address wins; otherwise the user's own
  // profile email. If neither exists we cannot guess — return a message that
  // tells an interactive agent to ask, and reads as a clear failure on a
  // no-human run.
  let to = typeof args.to === 'string' ? args.to.trim() : '';
  if (!to || SELF_RECIPIENTS.test(to)) {
    to = readUserEmail(userId) || '';
    if (!to) {
      return 'No email address is on file for the user, so I can\'t set a recipient. If we\'re in a live chat, ask which address to use and resend; on an automated run I can\'t guess (the user can set it in Settings → Profile).';
    }
  }

  const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
  if (!subject) return 'A subject is required.';
  if (!args.body && !args.body_doc_id && !args.html_body) {
    return 'Nothing to send — provide `body` (plain text) or `body_doc_id` (a research/documents doc to inline as the body).';
  }

  const composeArgs = {
    to,
    subject,
    ...(args.body ? { body: String(args.body) } : {}),
    ...(args.html_body ? { html_body: String(args.html_body) } : {}),
    ...(args.body_doc_id ? { body_doc_id: String(args.body_doc_id) } : {}),
    ...(args.account ? { account: String(args.account) } : {}),
  };

  try {
    const mod = await import('../email/execute.mjs');
    const result = await mod.default('email_compose', composeArgs, userId);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (e) {
    return `Email send failed: ${e?.message || String(e)}`;
  }
}
