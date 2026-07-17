/**
 * SMTP send helper using nodemailer.
 * Used by IMAP accounts that have SMTP configured.
 */

import { decrypt } from './email-crypto.mjs';

/**
 * SMTP login names are not necessarily mailbox addresses. Self-hosted servers
 * commonly authenticate as `alex` while requiring an RFC-style envelope
 * sender such as `alex@example.com`. Keep those concepts separate when an
 * account provides smtpFrom, while preserving the historical username
 * fallback for existing account records.
 */
export function resolveSmtpFrom(account) {
  const from = String(
    account?.smtpFrom
      || account?.email
      || account?.smtpUsername
      || account?.username
      || '',
  ).trim();
  if (!from) throw new Error('SMTP sender address is not configured');
  if (/\r|\n/.test(from)) throw new Error('SMTP sender address is invalid');
  return from;
}

export async function sendSmtpEmail(userId, account, { to, subject, body, html, attachments = [], inReplyTo, references }, markDispatchStarted = () => {}) {
  const { default: nodemailer } = await import('nodemailer');
  const password = await decrypt(userId, account.encryptedPassword);

  const port   = account.smtpPort ?? 587;
  const secure = port === 465;

  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port,
    secure,
    auth: { user: account.smtpUsername || account.username, pass: password },
  });

  const mail = {
    from: resolveSmtpFrom(account),
    to,
    subject,
    text: body,
  };
  if (html) mail.html = html;

  if (inReplyTo)  mail.inReplyTo  = inReplyTo;
  if (references) mail.references = references;

  if (attachments.length) {
    mail.attachments = attachments.map(att => ({
      filename: att.filename,
      content: att.data,
      contentType: att.mimeType,
    }));
  }

  markDispatchStarted();
  const info = await transporter.sendMail(mail);
  const attachNote = attachments.length
    ? ` with ${attachments.length} attachment(s): ${attachments.map(a => a.filename).join(', ')}`
    : '';
  return `Email sent${attachNote}. RFC Message-ID: ${info.messageId}. Use email_list to obtain an inbox UID if a copy is delivered to this mailbox.`;
}
