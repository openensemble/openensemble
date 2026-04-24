/**
 * SMTP send helper using nodemailer.
 * Used by IMAP accounts that have SMTP configured.
 */

import { decrypt } from './email-crypto.mjs';

export async function sendSmtpEmail(account, { to, subject, body, html, attachments = [], inReplyTo, references }) {
  const { default: nodemailer } = await import('nodemailer');
  const password = await decrypt(account.encryptedPassword);

  const port   = account.smtpPort ?? 587;
  const secure = port === 465;

  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port,
    secure,
    auth: { user: account.smtpUsername || account.username, pass: password },
  });

  const mail = {
    from: account.smtpUsername || account.username,
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

  const info = await transporter.sendMail(mail);
  const attachNote = attachments.length
    ? ` with ${attachments.length} attachment(s): ${attachments.map(a => a.filename).join(', ')}`
    : '';
  return `Email sent${attachNote}. Message ID: ${info.messageId}`;
}
