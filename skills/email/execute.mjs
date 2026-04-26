/**
 * Unified email skill executor.
 * Routes email_* tool calls to Gmail, Microsoft Graph, or IMAP
 * based on the user's connected account.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEmailAttachments, attachmentResolutionError } from '../../lib/email-attachments.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(SKILL_DIR, '../..');
const GMAIL_CLI = path.join(SKILL_DIR, 'gmail.mjs');

// ── Account resolution ────────────────────────────────────────────────────────

function loadAccounts(userId) {
  const p = path.join(BASE_DIR, 'users', userId, 'email-accounts.json');
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  return [];
}

function resolveAccount(accounts, accountParam) {
  if (!accountParam) return accounts[0] ?? null;
  const lower = accountParam.toLowerCase();
  return accounts.find(a =>
    a.label.toLowerCase() === lower || a.id === accountParam
  ) ?? accounts[0] ?? null;
}

// ── Gmail compose with attachments (direct API, no CLI) ───────────────────────

async function gmailComposeWithAttachments(args, userId, accountId) {
  const { getAccessToken } = await import('../../lib/google-auth.mjs');
  const token    = await getAccessToken('gmail', userId, accountId);
  const boundary = `boundary_${Date.now().toString(36)}`;

  const { attachments, errors } = loadEmailAttachments(args.attachment_doc_ids, userId);
  const resolveErr = attachmentResolutionError(args.attachment_doc_ids, errors);
  if (resolveErr) return resolveErr;

  let rawEmail;
  const htmlBody = args.html_body ?? null;
  const bodyParts = htmlBody
    ? [
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        args.body,
        ``,
        `--${boundary}`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        htmlBody,
        ``,
      ]
    : [
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        args.body,
        ``,
      ];

  if (!attachments.length) {
    rawEmail = [
      `To: ${args.to}`,
      `Subject: ${args.subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      ...bodyParts,
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    // multipart/mixed: body part(s) + file attachments
    const parts = [...bodyParts];
    for (const att of attachments) {
      const b64 = att.data.toString('base64');
      parts.push(
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        ``,
        b64.match(/.{1,76}/g).join('\r\n'),
        ``,
      );
    }
    parts.push(`--${boundary}--`);

    rawEmail = [
      `To: ${args.to}`,
      `Subject: ${args.subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      ...parts,
    ].join('\r\n');
  }

  const encoded = Buffer.from(rawEmail).toString('base64url');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${err}`);
  }
  const sent = await res.json();
  const attachNote = attachments.length
    ? ` with ${attachments.length} attachment(s): ${attachments.map(a => a.filename).join(', ')}`
    : '';
  return `Email sent${attachNote}. Message ID: ${sent.id}`;
}

// ── Gmail dispatch (via CLI subprocess) ───────────────────────────────────────

function spawnGmail(cmdArgs, userId, accountId) {
  return new Promise(resolve => {
    const proc = spawn('node', [GMAIL_CLI, ...cmdArgs], {
      env: { ...process.env, OE_USER_ID: userId, OE_ACCOUNT_ID: accountId ?? '' },
    });
    let out = '', err = '';
    const MAX_BUF = 512 * 1024; // 512KB max per stream
    proc.stdout.on('data', d => { if (out.length < MAX_BUF) out += d; });
    proc.stderr.on('data', d => { if (err.length < MAX_BUF) err += d; });
    proc.on('close', () => resolve((out || err || 'done').trim()));
    proc.on('error', e => resolve(`Error: ${e.message}`));
    // Kill subprocess after 30s to prevent hangs
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve('Error: subprocess timed out after 30s');
    }, 30000);
    proc.on('close', () => clearTimeout(timer));
  });
}

async function execGmail(name, args, userId, accountId) {
  switch (name) {
    case 'email_list':
      return spawnGmail(['list', args.query || 'in:inbox', String(args.maxResults || 10)], userId, accountId);
    case 'email_read':
      return spawnGmail(['read', args.messageId], userId, accountId);
    case 'email_thread':
      return spawnGmail(['thread', args.threadId], userId, accountId);
    case 'email_reply':
      return spawnGmail(['reply', args.messageId, args.body], userId, accountId);
    case 'email_compose': {
      // Guard: if body looks like HTML but html_body is not set, move it there
      if (!args.html_body && args.body && /<[a-z][\s\S]*>/i.test(args.body)) {
        const plainText = args.body
          .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')  // strip style/script/head blocks
          .replace(/<br\s*\/?>/gi, '\n')                               // br → newline
          .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, '\n')         // block elements → newline
          .replace(/<[^>]+>/g, '')                                     // strip remaining tags
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/[ \t]+/g, ' ')                                     // collapse spaces
          .replace(/\n{3,}/g, '\n\n')                                  // collapse blank lines
          .trim();
        args = { ...args, html_body: args.body, body: plainText };
      }
      return gmailComposeWithAttachments(args, userId, accountId);
    }
    case 'email_trash':
      return spawnGmail(['trash', args.messageId], userId, accountId);
    case 'email_batch_trash': {
      const ids = args.messageIds ?? [];
      if (!ids.length) return 'No message IDs provided.';
      if (ids.length === 1) return spawnGmail(['trash', ids[0]], userId, accountId);
      return spawnGmail(['batchtrash', ...ids], userId, accountId);
    }
    case 'email_batch_label': {
      const ids = args.messageIds ?? [];
      if (!ids.length) return 'No message IDs provided.';
      const addArgs = (args.addLabels ?? []).map(l => `add:${l}`);
      const rmArgs  = (args.removeLabels ?? []).map(l => `remove:${l}`);
      if (!addArgs.length && !rmArgs.length) return 'No labels specified to add or remove.';
      return spawnGmail(['batchlabel', ...addArgs, ...rmArgs, ...ids], userId, accountId);
    }
    case 'email_label_query': {
      if (!args.query) return 'No query specified.';
      const addArgs = (args.addLabels ?? []).map(l => `add:${l}`);
      const rmArgs  = (args.removeLabels ?? []).map(l => `remove:${l}`);
      if (!addArgs.length && !rmArgs.length) return 'No labels specified to add or remove.';
      return spawnGmail(['labelquery', args.query, ...addArgs, ...rmArgs], userId, accountId);
    }
    case 'email_purge_sender': {
      const query = args.query ?? (args.sender ? `from:${args.sender}` : null);
      if (!query) return 'Provide either sender or query.';
      return spawnGmail(['purge', query, ...(args.permanent ? ['--permanent'] : [])], userId, accountId);
    }
    case 'email_mark_read': {
      const mode = args.unread ? 'unread' : 'read';
      const ids = args.messageIds ?? [];
      if (!ids.length) return 'No message IDs provided.';
      if (ids.length === 1) return spawnGmail(['markread', ids[0], ...(args.unread ? ['unread'] : [])], userId, accountId);
      return spawnGmail(['batchmarkread', mode, ...ids], userId, accountId);
    }
    case 'email_inbox_stats':
      return spawnGmail(['inboxstats'], userId, accountId);
    default:
      return `Tool ${name} not supported for Gmail.`;
  }
}

// ── Microsoft Graph dispatch ──────────────────────────────────────────────────

async function execMicrosoft(name, args, userId, accountId) {
  // Lazy import to avoid loading ms-graph on every tool call
  const ms = await import('../../lib/ms-graph.mjs');
  switch (name) {
    case 'email_list': {
      const { emails } = await ms.fetchMsInboxPage(userId, accountId, null, args.maxResults || 10);
      if (!emails.length) return 'No messages found.';
      return emails.map(e => `[${e.id}] From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\n${e.snippet}`).join('\n\n---\n\n');
    }
    case 'email_read':
      return ms.fetchMsMessageBody(userId, accountId, args.messageId).then(html =>
        html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      );
    case 'email_thread':
      return ms.fetchMsThread(userId, accountId, args.threadId).then(msgs =>
        msgs.map(m => `From: ${m.from}\nDate: ${m.date}\n${m.body}`).join('\n\n---\n\n')
      );
    case 'email_reply':
      return ms.replyMsMessage(userId, accountId, args.messageId, args.body);
    case 'email_compose':
      return ms.composeMsMessage(userId, accountId, args);
    case 'email_trash':
      return ms.trashMsMessage(userId, accountId, args.messageId);
    case 'email_batch_trash': {
      const ids = args.messageIds ?? [];
      if (!ids.length) return 'No message IDs provided.';
      const results = await Promise.all(ids.map(id => ms.trashMsMessage(userId, accountId, id)));
      return `${results.length} email(s) moved to trash.`;
    }
    case 'email_batch_label':
    case 'email_label_query':
      return 'Label management is only supported for Gmail accounts.';
    case 'email_purge_sender':
      return 'Purge sender is only supported for Gmail accounts.';
    case 'email_mark_read':
      return ms.markMsRead(userId, accountId, args.messageIds ?? [], args.unread);
    case 'email_inbox_stats':
      return ms.fetchMsInboxStats(userId, accountId);
    default:
      return `Tool ${name} not supported for Microsoft accounts.`;
  }
}

// ── IMAP dispatch (read-only) ─────────────────────────────────────────────────

async function execImap(name, args, account, userId) {
  const { fetchInboxPage, fetchImapMessageBody, deleteImapMessages, markImapMessages, fetchImapReplyHeaders } = await import('../../lib/imap-client.mjs');

  if (name === 'email_compose') {
    if (!account.smtpHost) {
      return `"${account.label}" is an IMAP account with no SMTP configured — sending is not available. The user can add SMTP settings by removing and re-adding the account in Settings → Profile → Connected Accounts.`;
    }
    const { attachments, errors } = loadEmailAttachments(args.attachment_doc_ids, userId);
    const resolveErr = attachmentResolutionError(args.attachment_doc_ids, errors);
    if (resolveErr) return resolveErr;
    const { sendSmtpEmail } = await import('../../lib/smtp-client.mjs');
    return sendSmtpEmail(account, { to: args.to, subject: args.subject, body: args.body, html: args.html_body, attachments });
  }

  if (name === 'email_reply') {
    if (!account.smtpHost) {
      return `"${account.label}" has no SMTP configured — cannot send replies. Re-add the account with SMTP settings.`;
    }
    if (!args.messageId || !args.body) return 'messageId and body are required.';
    const headers = await fetchImapReplyHeaders(account, args.messageId);
    if (!headers?.replyTo) return `Could not find message ${args.messageId} to reply to.`;
    const subject = headers.subject.startsWith('Re:') ? headers.subject : `Re: ${headers.subject}`;
    const { sendSmtpEmail } = await import('../../lib/smtp-client.mjs');
    return sendSmtpEmail(account, {
      to: headers.replyTo,
      subject,
      body: args.body,
      inReplyTo: headers.messageId,
      references: headers.references,
    });
  }

  if (name === 'email_trash') {
    if (!args.messageId) return 'No messageId provided.';
    await deleteImapMessages(account, [args.messageId]);
    return `Message ${args.messageId} deleted.`;
  }

  if (name === 'email_batch_trash') {
    const ids = args.messageIds ?? [];
    if (!ids.length) return 'No message IDs provided.';
    const count = await deleteImapMessages(account, ids);
    return `${count} message(s) deleted.`;
  }

  if (name === 'email_mark_read') {
    const ids = args.messageIds ?? [];
    if (!ids.length) return 'No message IDs provided.';
    const count = await markImapMessages(account, ids, args.unread ?? false);
    return `${count} message(s) marked ${args.unread ? 'unread' : 'read'}.`;
  }

  const WRITE_OPS = ['email_batch_label', 'email_label_query', 'email_purge_sender'];
  if (WRITE_OPS.includes(name)) {
    return `"${account.label}" is an IMAP account — ${name} is not supported. Label management is Gmail-only.`;
  }
  switch (name) {
    case 'email_list': {
      const { emails } = await fetchInboxPage(account, null, args.maxResults || 10);
      if (!emails.length) return 'No messages found.';
      return emails.map(e => `[${e.id}] From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\n${e.snippet}`).join('\n\n---\n\n');
    }
    case 'email_read': {
      const html = await fetchImapMessageBody(account, args.messageId);
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    case 'email_thread':
      return 'Thread view is not supported for IMAP accounts.';
    case 'email_inbox_stats':
      return 'Inbox stats are not available for IMAP accounts.';
    default:
      return `Tool ${name} not supported for IMAP accounts.`;
  }
}

// ── Main executor ─────────────────────────────────────────────────────────────

export default async function execute(name, args, userId) {
  // List accounts — no account resolution needed
  if (name === 'email_list_accounts') {
    const accounts = loadAccounts(userId);
    if (!accounts.length) return 'No email accounts connected. The user can add accounts in Settings → Profile → Connected Accounts.';
    return accounts.map((a, i) =>
      `${i === 0 ? '★ ' : ''}${a.label} (${a.provider})${a.provider === 'imap' ? ' [read-only]' : ''}`
    ).join('\n');
  }

  const accounts = loadAccounts(userId);
  if (!accounts.length) return 'No email accounts connected. Ask the user to connect an account in Settings → Profile → Connected Accounts.';

  const account = resolveAccount(accounts, args.account);
  if (!account) return 'Could not find a matching email account.';

  try {
    switch (account.provider) {
      case 'gmail':
        return await execGmail(name, args, userId, account.id);
      case 'microsoft':
        return await execMicrosoft(name, args, userId, account.id);
      case 'imap':
        return await execImap(name, args, account, userId);
      default:
        return `Unknown provider: ${account.provider}`;
    }
  } catch (e) {
    return `Error (${account.label}): ${e.message}`;
  }
}
