#!/usr/bin/env node
/**
 * Gmail CLI — thin wrapper around Gmail REST API.
 * Usage:
 *   node gmail.mjs list [query] [maxResults]
 *   node gmail.mjs read <messageId>
 *   node gmail.mjs reply <messageId> <body>
 *   node gmail.mjs label <messageId> add:<LABEL> [remove:<LABEL>]
 *   node gmail.mjs trash <messageId>
 *   node gmail.mjs delete <messageId>
 *   node gmail.mjs labels
 */

import { getAccessToken as getGoogleAccessToken } from '../../lib/google-auth.mjs';

const BASE_URL   = 'https://gmail.googleapis.com/gmail/v1/users/me';

const _uid = process.env.OE_USER_ID;
const _aid = process.env.OE_ACCOUNT_ID;

async function getAccessToken() {
  return getGoogleAccessToken('gmail', _uid, _aid);
}

async function gmailFetch(endpoint, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Gmail API error ${res.status}: ${err}`);
    process.exit(1);
  }
  if (res.status === 204) return {};
  return res.json();
}

// Fetch multiple message endpoints in one HTTP round-trip using the Gmail Batch API.
// endpoints: array of strings like '/messages/<id>?format=metadata&...'
// Returns array of parsed JSON responses in the same order.
async function gmailBatchFetch(endpoints) {
  if (!endpoints.length) return [];
  const token    = await getAccessToken();
  const boundary = 'batch_gmail_boundary';
  const body     = endpoints.map((ep, i) => [
    `--${boundary}`,
    'Content-Type: application/http',
    `Content-ID: <item${i}>`,
    '',
    `GET ${ep}`,
    '',
  ].join('\r\n')).join('\r\n') + `\r\n--${boundary}--`;

  const res = await fetch('https://www.googleapis.com/batch/gmail/v1', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/mixed; boundary="${boundary}"`,
    },
    body,
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Gmail Batch API error ${res.status}: ${err}`);
    process.exit(1);
  }
  const text         = await res.text();
  const resBoundary  = res.headers.get('content-type').match(/boundary=([^\s;]+)/)?.[1];
  const parts        = text.split(`--${resBoundary}`).slice(1, -1);
  return parts.map(part => {
    const jsonStart = part.indexOf('{');
    if (jsonStart === -1) return null;
    try { return JSON.parse(part.slice(jsonStart)); } catch { return null; }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function decodeRfc2047(value) {
  // Decode =?charset?B?...?= (base64) and =?charset?Q?...?= (quoted-printable)
  return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      const buf = encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      return buf.toString(charset.toLowerCase().replace('utf-8', 'utf8'));
    } catch { return text; }
  });
}

function getHeader(headers, name) {
  const val = headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return decodeRfc2047(val);
}

function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|h[1-6]|blockquote|section|article|header|footer)[^>]*>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeBody(part) {
  if (!part) return '';
  // Single part with data
  if (part.body?.data) {
    const raw = Buffer.from(part.body.data, 'base64').toString('utf8');
    return part.mimeType === 'text/html' ? htmlToText(raw) : raw;
  }
  if (part.parts) {
    // Prefer plain text
    for (const p of part.parts) {
      if (p.mimeType === 'text/plain') { const t = decodeBody(p); if (t) return t; }
    }
    // Fall back to HTML (will be converted to text)
    for (const p of part.parts) {
      if (p.mimeType === 'text/html') { const t = decodeBody(p); if (t) return t; }
    }
    // Recurse into multipart containers
    for (const p of part.parts) { const t = decodeBody(p); if (t) return t; }
  }
  return '';
}

// ── Commands ──────────────────────────────────────────────────────────────────
async function cmdList(args) {
  const query = args[0] || 'is:unread';
  const max   = parseInt(args[1]) || 10;
  const data  = await gmailFetch(`/messages?q=${encodeURIComponent(query)}&maxResults=${max}`);
  if (!data.messages?.length) { console.log('No emails found.'); return; }
  const ids = data.messages.slice(0, max).map(m => m.id);
  // Use batch API — all metadata in one HTTP request (up to 100 per batch)
  const endpoints = ids.map(id => `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
  const details   = await gmailBatchFetch(endpoints);
  for (const [i, msg] of details.entries()) {
    if (!msg) continue;
    const h = msg.payload?.headers || [];
    console.log(`${i+1}. [${msg.id}]`);
    console.log(`   From:    ${getHeader(h, 'From')}`);
    console.log(`   Subject: ${getHeader(h, 'Subject')}`);
    console.log(`   Date:    ${getHeader(h, 'Date')}`);
    console.log(`   Preview: ${(msg.snippet||'').slice(0,120)}`);
    console.log('');
  }
}

async function cmdRead(args) {
  const messageId = args[0];
  if (!messageId) { console.error('Usage: gmail.mjs read <messageId>'); process.exit(1); }
  const msg = await gmailFetch(`/messages/${messageId}?format=full`);
  const h   = msg.payload?.headers || [];
  const body = decodeBody(msg.payload);
  console.log(`From:    ${getHeader(h, 'From')}`);
  console.log(`To:      ${getHeader(h, 'To')}`);
  console.log(`Subject: ${getHeader(h, 'Subject')}`);
  console.log(`Date:    ${getHeader(h, 'Date')}`);
  console.log('');
  console.log(body.slice(0, 4000));
}

async function cmdReply(args) {
  const messageId = args[0];
  const body      = args.slice(1).join(' ');
  if (!messageId || !body) { console.error('Usage: gmail.mjs reply <messageId> <body text>'); process.exit(1); }

  const headerNames = ['From', 'Reply-To', 'Subject', 'To', 'Message-ID', 'References'];
  const qs = headerNames.map(n => `metadataHeaders=${encodeURIComponent(n)}`).join('&');
  const original = await gmailFetch(`/messages/${messageId}?format=metadata&${qs}`);
  const h        = original.payload?.headers || [];
  const replyTo  = getHeader(h, 'Reply-To');
  const from     = getHeader(h, 'From');
  const subject  = getHeader(h, 'Subject') || '';
  const msgId    = getHeader(h, 'Message-ID');
  const refs     = getHeader(h, 'References');
  const to       = replyTo || from;
  if (!to) { console.error(`Could not determine recipient — message ${messageId} has no From or Reply-To header.`); process.exit(1); }

  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const rawEmail = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    msgId ? `In-Reply-To: ${msgId}` : null,
    msgId ? `References: ${refs ? refs + ' ' : ''}${msgId}` : (refs ? `References: ${refs}` : null),
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].filter(Boolean).join('\r\n');

  const encoded = Buffer.from(rawEmail).toString('base64url');
  const sent = await gmailFetch('/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: encoded, threadId: original.threadId })
  });
  console.log(`Reply sent to ${to}. Message ID: ${sent.id}`);
}

async function cmdLabel(args) {
  const messageId  = args[0];
  const addLabels  = args.filter(a => a.startsWith('add:')).map(a => a.slice(4));
  const rmLabels   = args.filter(a => a.startsWith('remove:')).map(a => a.slice(7));
  if (!messageId) { console.error('Usage: gmail.mjs label <messageId> add:<LABEL> remove:<LABEL>'); process.exit(1); }

  const labelsData = await gmailFetch('/labels');
  const labelMap   = {};
  for (const l of labelsData.labels || []) labelMap[l.name.toUpperCase()] = l.id;

  const addIds = addLabels.map(n => labelMap[n.toUpperCase()] || n);
  const rmIds  = rmLabels.map(n => labelMap[n.toUpperCase()] || n);

  await gmailFetch(`/messages/${messageId}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: addIds, removeLabelIds: rmIds })
  });
  console.log(`Labels updated on ${messageId}. Added: [${addLabels}] Removed: [${rmLabels}]`);
}

async function cmdLabels() {
  const data = await gmailFetch('/labels');
  for (const l of data.labels || []) console.log(`${l.id}  ${l.name}`);
}

async function cmdTrash(args) {
  const messageId = args[0];
  if (!messageId) { console.error('Usage: gmail.mjs trash <messageId>'); process.exit(1); }
  await gmailFetch(`/messages/${messageId}/trash`, { method: 'POST' });
  console.log(`Email ${messageId} moved to trash.`);
}

async function cmdPurgeSender(args) {
  // Paginate through ALL messages matching the query, then trash in batches of 1000.
  // This handles inboxes with thousands of emails from a single sender.
  const query   = args[0];
  const permanent = args[1] === '--permanent'; // pass --permanent for hard delete instead of trash
  if (!query) { console.error('Usage: gmail.mjs purge <query> [--permanent]'); process.exit(1); }

  // ── Phase 1: collect all IDs (full pagination, no cap) ──────────────────────
  const ids = [];
  let pageToken = '';
  process.stderr.write(`[purge] Scanning for: ${query}\n`);
  while (true) {
    const qs = `/messages?q=${encodeURIComponent(query)}&maxResults=500` + (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await gmailFetch(qs);
    for (const m of data.messages || []) ids.push(m.id);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    process.stderr.write(`[purge] Collected ${ids.length} so far…\n`);
  }

  if (!ids.length) { console.log('No emails found matching query.'); return; }
  process.stderr.write(`[purge] Total found: ${ids.length}. Processing…\n`);

  // ── Phase 2: process in batches of 1000 ─────────────────────────────────────
  const BATCH = 1000;
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    if (permanent) {
      // batchDelete — permanent, cannot be undone
      await gmailFetch('/messages/batchDelete', {
        method: 'POST',
        body: JSON.stringify({ ids: chunk }),
      });
    } else {
      // batchModify — moves to trash (recoverable)
      await gmailFetch('/messages/batchModify', {
        method: 'POST',
        body: JSON.stringify({ ids: chunk, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }),
      });
    }
    done += chunk.length;
    process.stderr.write(`[purge] ${done}/${ids.length} ${permanent ? 'deleted' : 'trashed'}…\n`);
  }

  const action = permanent ? 'permanently deleted' : 'moved to trash';
  console.log(`Done. ${ids.length} email(s) from "${query}" ${action}.`);
}

async function cmdListIds(args) {
  // Returns all message IDs matching a query, paginating through all results.
  // Used to select emails en-masse before a batch operation.
  const query = args[0] || 'in:inbox';
  const max   = parseInt(args[1]) || 500; // hard ceiling to avoid accidents
  const ids   = [];
  let pageToken = '';
  while (ids.length < max) {
    const remaining = max - ids.length;
    const batchSize = Math.min(remaining, 500);
    const qs = `/messages?q=${encodeURIComponent(query)}&maxResults=${batchSize}` + (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await gmailFetch(qs);
    for (const m of data.messages || []) ids.push(m.id);
    if (!data.nextPageToken || ids.length >= max) break;
    pageToken = data.nextPageToken;
  }
  if (!ids.length) { console.log('No emails found.'); return; }
  console.log(`Found ${ids.length} email(s).\n` + ids.join('\n'));
}

async function cmdLabelQuery(args) {
  // Paginate through ALL messages matching a query, then apply label changes in batches of 1000.
  // args: [query, add:<L1>, add:<L2>, ..., remove:<L1>, ...]
  const query     = args[0];
  const addLabels = args.filter(a => a.startsWith('add:')).map(a => a.slice(4));
  const rmLabels  = args.filter(a => a.startsWith('remove:')).map(a => a.slice(7));
  if (!query) { console.error('Usage: gmail.mjs labelquery <query> add:<L> remove:<L>'); process.exit(1); }
  if (!addLabels.length && !rmLabels.length) { console.error('No labels specified.'); process.exit(1); }

  // Resolve label names to IDs
  const labelsData = await gmailFetch('/labels');
  const labelMap   = {};
  for (const l of labelsData.labels || []) labelMap[l.name.toUpperCase()] = l.id;
  const addIds = addLabels.map(n => labelMap[n.toUpperCase()] || n);
  const rmIds  = rmLabels.map(n => labelMap[n.toUpperCase()] || n);

  // Phase 1: collect all matching IDs
  const ids = [];
  let pageToken = '';
  process.stderr.write(`[labelquery] Scanning for: ${query}\n`);
  while (true) {
    const qs = `/messages?q=${encodeURIComponent(query)}&maxResults=500` + (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await gmailFetch(qs);
    for (const m of data.messages || []) ids.push(m.id);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    process.stderr.write(`[labelquery] Collected ${ids.length} so far…\n`);
  }

  if (!ids.length) { console.log('No emails found matching query.'); return; }
  process.stderr.write(`[labelquery] Total found: ${ids.length}. Applying labels…\n`);

  // Phase 2: apply in batches of 1000
  const body = {};
  if (addIds.length) body.addLabelIds = addIds;
  if (rmIds.length)  body.removeLabelIds = rmIds;

  const BATCH = 1000;
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    await gmailFetch('/messages/batchModify', { method: 'POST', body: JSON.stringify({ ids: chunk, ...body }) });
    done += chunk.length;
    process.stderr.write(`[labelquery] ${done}/${ids.length} updated…\n`);
  }

  console.log(`Done. ${ids.length} email(s) updated. Added: [${addLabels}] Removed: [${rmLabels}]`);
}

async function cmdBatchLabel(args) {
  // args: [add:<L1>,add:<L2>,...,remove:<L1>,..., id1, id2, ...]
  const addLabels = args.filter(a => a.startsWith('add:')).map(a => a.slice(4));
  const rmLabels  = args.filter(a => a.startsWith('remove:')).map(a => a.slice(7));
  const ids       = args.filter(a => !a.startsWith('add:') && !a.startsWith('remove:'));
  if (!ids.length) { console.error('Usage: gmail.mjs batchlabel add:<L> remove:<L> <id1> <id2> ...'); process.exit(1); }

  const labelsData = await gmailFetch('/labels');
  const labelMap   = {};
  for (const l of labelsData.labels || []) labelMap[l.name.toUpperCase()] = l.id;
  const addIds = addLabels.map(n => labelMap[n.toUpperCase()] || n);
  const rmIds  = rmLabels.map(n => labelMap[n.toUpperCase()] || n);

  const body = {};
  if (addIds.length) body.addLabelIds = addIds;
  if (rmIds.length)  body.removeLabelIds = rmIds;

  await gmailFetch('/messages/batchModify', { method: 'POST', body: JSON.stringify({ ids, ...body }) });
  console.log(`Labels updated on ${ids.length} email(s). Added: [${addLabels}] Removed: [${rmLabels}]`);
}

async function cmdBatchTrash(args) {
  // args: space-separated list of message IDs
  const ids = args.filter(Boolean);
  if (!ids.length) { console.error('Usage: gmail.mjs batchtrash <id1> <id2> ...'); process.exit(1); }
  await gmailFetch('/messages/batchModify', {
    method: 'POST',
    body: JSON.stringify({ ids, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }),
  });
  console.log(`${ids.length} email(s) moved to trash.`);
}

async function cmdDelete(args) {
  const messageId = args[0];
  if (!messageId) { console.error('Usage: gmail.mjs delete <messageId>'); process.exit(1); }
  await gmailFetch(`/messages/${messageId}`, { method: 'DELETE' });
  console.log(`Email ${messageId} permanently deleted.`);
}

async function cmdTopSenders(args) {
  // Fetch up to `limit` messages from the inbox (metadata only — just From header)
  // and return a ranked list of senders by email count.
  const limit = parseInt(args[0]) || 500;
  const query = args[1] || 'in:inbox';

  const ids = [];
  let pageToken = '';
  while (ids.length < limit) {
    const max = Math.min(500, limit - ids.length);
    const qs = `/messages?q=${encodeURIComponent(query)}&maxResults=${max}` + (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await gmailFetch(qs);
    for (const m of data.messages || []) ids.push(m.id);
    if (!data.nextPageToken || ids.length >= limit) break;
    pageToken = data.nextPageToken;
  }

  if (!ids.length) { console.log(JSON.stringify([])); return; }

  // Use batch API in chunks of 100 (Gmail batch limit)
  const counts = {};
  const BATCH  = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk     = ids.slice(i, i + BATCH);
    const endpoints = chunk.map(id => `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From`);
    const results   = await gmailBatchFetch(endpoints);
    for (const msg of results) {
      if (!msg) continue;
      const fromHeader = msg.payload?.headers?.find(h => h.name === 'From')?.value ?? '';
      // Normalise to "Name <email>" → extract email address
      const emailMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/(\S+@\S+)/);
      const email = emailMatch ? emailMatch[1].toLowerCase() : fromHeader.toLowerCase().trim();
      const name  = fromHeader.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || email;
      const key   = email;
      if (!counts[key]) counts[key] = { email, name, count: 0 };
      counts[key].count++;
    }
  }

  const ranked = Object.values(counts).sort((a, b) => b.count - a.count);
  console.log(JSON.stringify(ranked.slice(0, 30)));
}

function markdownToHtml(md) {
  const lines  = md.split('\n');
  const out    = [];
  let inTable  = false;
  let inUl     = false;
  let inOl     = false;

  function closeList() {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }
  function closeTable() {
    if (inTable) { out.push('</tbody></table>'); inTable = false; }
  }
  function inline(s) {
    return s
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Heading
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) {
      closeList(); closeTable();
      const level = hm[1].length;
      out.push(`<h${level} style="margin:20px 0 8px">${inline(hm[2])}</h${level}>`);
      continue;
    }
    // HR
    if (/^---+$/.test(line.trim())) {
      closeList(); closeTable();
      out.push('<hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0">');
      continue;
    }
    // Table row
    if (line.trim().startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      const isSep = cells.every(c => /^[-: ]+$/.test(c));
      if (isSep) continue; // separator row
      closeList();
      if (!inTable) {
        // First row = header
        out.push('<table style="border-collapse:collapse;width:100%;margin:12px 0"><thead><tr>' +
          cells.map(c => `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd;background:#f5f5f5">${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>');
        inTable = true;
      } else {
        out.push('<tr>' + cells.map(c => `<td style="padding:8px 12px;border-bottom:1px solid #eee">${inline(c)}</td>`).join('') + '</tr>');
      }
      continue;
    }
    // Unordered list
    const ulm = line.match(/^(\s*)[*\-]\s+(.+)/);
    if (ulm) {
      closeTable();
      if (!inUl) { out.push('<ul style="margin:8px 0;padding-left:24px">'); inUl = true; }
      out.push(`<li style="margin:4px 0">${inline(ulm[2])}</li>`);
      continue;
    }
    // Ordered list
    const olm = line.match(/^\d+\.\s+(.+)/);
    if (olm) {
      closeTable();
      if (!inOl) { out.push('<ol style="margin:8px 0;padding-left:24px">'); inOl = true; }
      out.push(`<li style="margin:4px 0">${inline(olm[1])}</li>`);
      continue;
    }
    // Blank line
    if (!line.trim()) {
      closeList(); closeTable();
      out.push('');
      continue;
    }
    // Normal paragraph
    closeList(); closeTable();
    out.push(`<p style="margin:6px 0">${inline(line)}</p>`);
  }
  closeList(); closeTable();

  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px;margin:0 auto;padding:20px">${out.join('\n')}</body></html>`;
}

async function cmdCompose(args) {
  const to      = args[0];
  const subject = args[1];
  const body    = args.slice(2).join(' ');
  if (!to || !subject || !body) { console.error('Usage: gmail.mjs compose <to> <subject> <body>'); process.exit(1); }

  const htmlBody  = markdownToHtml(body);
  const boundary  = `boundary_${Date.now().toString(36)}`;
  const rawEmail  = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ].join('\r\n');

  const encoded = Buffer.from(rawEmail).toString('base64url');
  const sent = await gmailFetch('/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: encoded }),
  });
  console.log(`Email sent. Message ID: ${sent.id}`);
}

async function cmdThread(args) {
  const threadId = args[0];
  if (!threadId) { console.error('Usage: gmail.mjs thread <threadId>'); process.exit(1); }
  const thread = await gmailFetch(`/threads/${threadId}?format=full`);
  const messages = thread.messages || [];
  console.log(`Thread — ${messages.length} message(s)\n`);
  for (const [i, msg] of messages.entries()) {
    const h    = msg.payload?.headers || [];
    const body = decodeBody(msg.payload);
    console.log(`─── ${i + 1}/${messages.length} [${msg.id}] ───`);
    console.log(`From:    ${getHeader(h, 'From')}`);
    console.log(`Date:    ${getHeader(h, 'Date')}`);
    console.log(body.slice(0, 2000));
    console.log('');
  }
}

async function cmdMarkRead(args) {
  const messageId = args[0];
  const unread    = args[1] === 'unread';
  if (!messageId) { console.error('Usage: gmail.mjs markread <messageId> [unread]'); process.exit(1); }
  const body = unread ? { addLabelIds: ['UNREAD'] } : { removeLabelIds: ['UNREAD'] };
  await gmailFetch(`/messages/${messageId}/modify`, { method: 'POST', body: JSON.stringify(body) });
  console.log(`Email ${messageId} marked as ${unread ? 'unread' : 'read'}.`);
}

async function cmdBatchMarkRead(args) {
  // args: [read|unread, id1, id2, ...]
  const mode = args[0]; // 'read' or 'unread'
  const ids  = args.slice(1).filter(Boolean);
  if (!ids.length) { console.error('Usage: gmail.mjs batchmarkread <read|unread> <id1> ...'); process.exit(1); }
  const body = mode === 'unread'
    ? { ids, addLabelIds: ['UNREAD'] }
    : { ids, removeLabelIds: ['UNREAD'] };
  await gmailFetch('/messages/batchModify', { method: 'POST', body: JSON.stringify(body) });
  console.log(`${ids.length} email(s) marked as ${mode}.`);
}

// Returns the label ID for labelName, creating the label if it doesn't exist.
async function resolveOrCreateLabel(labelName) {
  const labelsData = await gmailFetch('/labels');
  const labelMap   = {};
  for (const l of labelsData.labels || []) labelMap[l.name.toUpperCase()] = l.id;
  const existing = labelMap[labelName.toUpperCase()];
  if (existing) return { id: existing, created: false };
  const created = await gmailFetch('/labels', {
    method: 'POST',
    body: JSON.stringify({ name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  });
  return { id: created.id, created: true };
}

async function cmdMove(args) {
  // Move single email to a label, remove from INBOX by default
  const messageId  = args[0];
  const labelName  = args[1];
  const keepInbox  = args[2] === '--keep-inbox';
  if (!messageId || !labelName) { console.error('Usage: gmail.mjs move <messageId> <labelName> [--keep-inbox]'); process.exit(1); }
  const { id: labelId, created } = await resolveOrCreateLabel(labelName);
  if (created) console.log(`Label "${labelName}" not found — created it.`);
  const payload = keepInbox
    ? { addLabelIds: [labelId] }
    : { addLabelIds: [labelId], removeLabelIds: ['INBOX'] };
  await gmailFetch(`/messages/${messageId}/modify`, { method: 'POST', body: JSON.stringify(payload) });
  console.log(`Email ${messageId} moved to "${labelName}".`);
}

async function cmdBatchMove(args) {
  // args: [labelName, id1, id2, ...]
  const labelName = args[0];
  const ids       = args.slice(1).filter(Boolean);
  if (!labelName || !ids.length) { console.error('Usage: gmail.mjs batchmove <labelName> <id1> <id2> ...'); process.exit(1); }
  const { id: labelId, created } = await resolveOrCreateLabel(labelName);
  if (created) console.log(`Label "${labelName}" not found — created it.`);
  await gmailFetch('/messages/batchModify', {
    method: 'POST',
    body: JSON.stringify({ ids, addLabelIds: [labelId], removeLabelIds: ['INBOX'] }),
  });
  console.log(`${ids.length} email(s) moved to "${labelName}".`);
}

async function cmdCreateLabel(args) {
  const name = args.join(' ').trim();
  if (!name) { console.error('Usage: gmail.mjs createlabel <name>'); process.exit(1); }
  const label = await gmailFetch('/labels', {
    method: 'POST',
    body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  });
  console.log(`Label created: "${label.name}" (ID: ${label.id})`);
}

async function cmdGetUnsubscribe(args) {
  const messageId = args[0];
  if (!messageId) { console.error('Usage: gmail.mjs unsubscribelink <messageId>'); process.exit(1); }
  const msg  = await gmailFetch(`/messages/${messageId}?format=full`);
  const h    = msg.payload?.headers || [];
  const body = decodeBody(msg.payload);
  const unsubHeader = getHeader(h, 'List-Unsubscribe');
  const links = [];
  if (unsubHeader) {
    const httpMatches   = unsubHeader.match(/<(https?[^>]+)>/g) || [];
    const mailtoMatches = unsubHeader.match(/<(mailto:[^>]+)>/g) || [];
    links.push(...httpMatches.map(m => m.slice(1, -1)));
    links.push(...mailtoMatches.map(m => m.slice(1, -1)));
  }
  const bodyLinks = body.match(/https?:\/\/[^\s<>"]*unsubscribe[^\s<>"]*/gi) || [];
  links.push(...bodyLinks.slice(0, 3));
  const unique = [...new Set(links)];
  if (!unique.length) {
    console.log('No unsubscribe link found in this email.');
  } else {
    console.log('Unsubscribe links:');
    unique.forEach((l, i) => console.log(`${i + 1}. ${l}`));
  }
}

async function cmdInboxStats() {
  // Parallel estimate counts across categories
  const queries = [
    { label: 'Unread (inbox)',  q: 'is:unread in:inbox' },
    { label: 'Primary',        q: 'in:inbox category:primary' },
    { label: 'Promotions',     q: 'in:inbox category:promotions' },
    { label: 'Updates',        q: 'in:inbox category:updates' },
    { label: 'Social',         q: 'in:inbox category:social' },
    { label: 'Forums',         q: 'in:inbox category:forums' },
  ];
  const results = await Promise.all(queries.map(async ({ label, q }) => {
    const data = await gmailFetch(`/messages?q=${encodeURIComponent(q)}&maxResults=1`);
    return `  ${label}: ~${data.resultSizeEstimate ?? 0}`;
  }));
  console.log('Inbox stats:\n' + results.join('\n'));
}

// ── Main ──────────────────────────────────────────────────────────────────────
const [,, cmd, ...rest] = process.argv;
switch (cmd) {
  case 'list':           await cmdList(rest);           break;
  case 'listids':        await cmdListIds(rest);         break;
  case 'purge':          await cmdPurgeSender(rest);     break;
  case 'topsenders':     await cmdTopSenders(rest);      break;
  case 'read':           await cmdRead(rest);            break;
  case 'reply':          await cmdReply(rest);           break;
  case 'compose':        await cmdCompose(rest);         break;
  case 'thread':         await cmdThread(rest);          break;
  case 'label':          await cmdLabel(rest);           break;
  case 'labels':         await cmdLabels();              break;
  case 'move':           await cmdMove(rest);            break;
  case 'batchmove':      await cmdBatchMove(rest);       break;
  case 'markread':       await cmdMarkRead(rest);        break;
  case 'batchmarkread':  await cmdBatchMarkRead(rest);   break;
  case 'createlabel':    await cmdCreateLabel(rest);     break;
  case 'unsubscribelink': await cmdGetUnsubscribe(rest); break;
  case 'inboxstats':     await cmdInboxStats();          break;
  case 'trash':          await cmdTrash(rest);           break;
  case 'batchlabel':     await cmdBatchLabel(rest);      break;
  case 'labelquery':     await cmdLabelQuery(rest);      break;
  case 'batchtrash':     await cmdBatchTrash(rest);      break;
  case 'delete':         await cmdDelete(rest);          break;
  default:
    console.log('Gmail CLI');
    console.log('Commands: list | read | reply | compose | thread | label | labels | move | batchmove | markread | batchmarkread | createlabel | unsubscribelink | inboxstats | trash | batchtrash | delete | topsenders | purge | listids');
}
