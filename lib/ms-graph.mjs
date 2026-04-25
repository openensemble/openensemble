/**
 * Microsoft Graph API helpers for inbox access.
 * Token files: ms-token-{userId}-{accountId}.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEmailAttachments, attachmentResolutionError } from './email-attachments.mjs';

const BASE_DIR   = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CREDS_PATH = path.join(BASE_DIR, 'microsoft-credentials.json');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function tokenPath(userId, accountId) {
  return path.join(BASE_DIR, 'users', userId, `ms-token-${accountId}.json`);
}

export async function getMsAuthHeader(userId, accountId) {
  const tp = tokenPath(userId, accountId);
  if (!fs.existsSync(tp)) throw new Error('Microsoft account not connected');
  let tokens = JSON.parse(fs.readFileSync(tp, 'utf8'));

  if (!tokens.expiry_date || Date.now() > tokens.expiry_date - 60000) {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    const r = await fetch(`https://login.microsoftonline.com/${creds.tenant ?? 'common'}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/Mail.Read offline_access',
      }),
    });
    const d = await r.json();
    if (!d.access_token) throw new Error(`MS token refresh failed: ${d.error_description ?? d.error}`);
    tokens.access_token = d.access_token;
    tokens.expiry_date = Date.now() + d.expires_in * 1000;
    if (d.refresh_token) tokens.refresh_token = d.refresh_token;
    fs.writeFileSync(tp, JSON.stringify(tokens, null, 2));
  }

  return { Authorization: `Bearer ${tokens.access_token}` };
}

export async function fetchMsInboxPage(userId, accountId, skipToken, max) {
  const headers = await getMsAuthHeader(userId, accountId);
  let url = `${GRAPH_BASE}/me/mailFolders/inbox/messages?$top=${max}&$select=id,from,subject,receivedDateTime,bodyPreview&$orderby=receivedDateTime desc`;
  if (skipToken) url += `&$skiptoken=${encodeURIComponent(skipToken)}`;

  const res = await fetch(url, { headers });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const emails = (data.value ?? []).map(m => ({
    id: m.id,
    from: m.from?.emailAddress
      ? `${m.from.emailAddress.name ?? ''} <${m.from.emailAddress.address ?? ''}>`.trim()
      : '',
    subject: m.subject ?? '(no subject)',
    date: m.receivedDateTime ?? '',
    snippet: (m.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
  }));

  // Extract $skiptoken from @odata.nextLink
  let nextPageToken = null;
  if (data['@odata.nextLink']) {
    try {
      const nextUrl = new URL(data['@odata.nextLink']);
      nextPageToken = nextUrl.searchParams.get('$skiptoken');
    } catch (_) {}
  }

  return { emails, nextPageToken };
}

export async function fetchMsMessageBody(userId, accountId, msgId) {
  const headers = await getMsAuthHeader(userId, accountId);
  const res = await fetch(`${GRAPH_BASE}/me/messages/${msgId}?$select=body`, { headers });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const body = data.body;
  if (!body) return '<p>No body content.</p>';
  if (body.contentType === 'html') return body.content;
  return `<pre style="font-family:sans-serif;white-space:pre-wrap">${(body.content ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
}

export async function fetchMsThread(userId, accountId, conversationId) {
  const headers = await getMsAuthHeader(userId, accountId);
  const url = `${GRAPH_BASE}/me/messages?$filter=conversationId eq '${conversationId}'&$select=id,from,subject,receivedDateTime,bodyPreview,body&$orderby=receivedDateTime asc`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.value ?? []).map(m => ({
    id: m.id,
    from: m.from?.emailAddress ? `${m.from.emailAddress.name ?? ''} <${m.from.emailAddress.address}>`.trim() : '',
    subject: m.subject ?? '',
    date: m.receivedDateTime ?? '',
    body: m.body?.contentType === 'html'
      ? m.body.content.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,500)
      : (m.body?.content ?? '').slice(0,500),
  }));
}

export async function replyMsMessage(userId, accountId, msgId, body) {
  const headers = await getMsAuthHeader(userId, accountId);
  const res = await fetch(`${GRAPH_BASE}/me/messages/${msgId}/reply`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: body }),
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message ?? 'Reply failed'); }
  return 'Reply sent.';
}

export async function composeMsMessage(userId, accountId, { to, subject, body, html_body, attachment_doc_ids }) {
  const headers = await getMsAuthHeader(userId, accountId);

  const { attachments, errors } = loadEmailAttachments(attachment_doc_ids, userId);
  const resolveErr = attachmentResolutionError(attachment_doc_ids, errors);
  if (resolveErr) return resolveErr;

  const message = {
    subject,
    body: { contentType: html_body ? 'HTML' : 'Text', content: html_body ?? body },
    toRecipients: to.split(',').map(a => ({ emailAddress: { address: a.trim() } })),
  };
  if (attachments.length) {
    message.attachments = attachments.map(att => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.filename,
      contentType: att.mimeType,
      contentBytes: att.data.toString('base64'),
    }));
  }

  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message ?? 'Send failed'); }
  const attachNote = attachments.length
    ? ` with ${attachments.length} attachment(s): ${attachments.map(a => a.filename).join(', ')}`
    : '';
  return `Email sent${attachNote}.`;
}

export async function trashMsMessage(userId, accountId, msgId) {
  const headers = await getMsAuthHeader(userId, accountId);
  const res = await fetch(`${GRAPH_BASE}/me/messages/${msgId}/move`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinationId: 'deleteditems' }),
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message ?? 'Trash failed'); }
  return 'Message moved to trash.';
}

export async function markMsRead(userId, accountId, msgIds, unread = false) {
  const headers = await getMsAuthHeader(userId, accountId);
  await Promise.all(msgIds.map(id => fetch(`${GRAPH_BASE}/me/messages/${id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isRead: !unread }),
  })));
  return `Marked ${msgIds.length} message${msgIds.length !== 1 ? 's' : ''} as ${unread ? 'unread' : 'read'}.`;
}

export async function fetchMsInboxStats(userId, accountId) {
  const headers = await getMsAuthHeader(userId, accountId);
  const [unread, total] = await Promise.all([
    fetch(`${GRAPH_BASE}/me/mailFolders/inbox?$select=unreadItemCount`, { headers }).then(r => r.json()),
    fetch(`${GRAPH_BASE}/me/mailFolders/inbox?$select=totalItemCount`, { headers }).then(r => r.json()),
  ]);
  return `Inbox: ${unread.unreadItemCount ?? '?'} unread, ${total.totalItemCount ?? '?'} total.`;
}

export function msTokenPath(userId, accountId) {
  return tokenPath(userId, accountId);
}
