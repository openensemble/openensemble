/**
 * IMAP inbox fetcher using imapflow.
 * Pagination uses the lowest UID from the last batch as a numeric cursor.
 */

import { ImapFlow } from 'imapflow';
import { decrypt } from './email-crypto.mjs';

/**
 * Decrypt stored IMAP credentials and return a plain object.
 */
async function decryptCreds(account) {
  const password = await decrypt(account.encryptedPassword);
  return { host: account.host, port: account.port, tls: account.tls, username: account.username, password };
}

/**
 * Build an ImapFlow client from a credentials object (plain, not encrypted).
 */
function makeClient(creds) {
  return new ImapFlow({
    host: creds.host,
    port: creds.port ?? 993,
    secure: creds.tls !== false,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
  });
}

/**
 * Test that a connection can be established. Throws on failure.
 */
export async function testConnection(plainCreds) {
  const client = makeClient(plainCreds);
  await client.connect();
  await client.logout();
}

/**
 * Fetch a page of inbox messages.
 * @param {object} account - account record (with encryptedPassword)
 * @param {string|null} pageToken - lowest UID from previous batch, or null for first page
 * @param {number} max - number of messages to fetch
 * @returns {{ emails: Array, nextPageToken: string|null }}
 */
export async function fetchInboxPage(account, pageToken, max) {
  const creds = await decryptCreds(account);
  const client = makeClient(creds);
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    // Build UID search range — descending by UID, optionally capped by cursor
    let searchCriteria = { seen: false };
    // Actually fetch all (seen+unseen) — use 'all' flag equivalent
    // imapflow: pass array for AND, use { all: true } equivalent via uid range
    let uidRange = pageToken ? `1:${parseInt(pageToken, 10) - 1}` : '*:1';

    // Fetch UIDs in the range, sorted descending
    const uids = await client.search({ uid: uidRange }, { uid: true });
    // imapflow returns UIDs ascending; reverse and slice
    uids.sort((a, b) => b - a);
    const pageUids = uids.slice(0, max);

    if (!pageUids.length) {
      return { emails: [], nextPageToken: null };
    }

    const emails = [];
    for await (const msg of client.fetch(pageUids.join(','), {
      uid: true,
      envelope: true,
      bodyStructure: true,
      bodyParts: ['TEXT'],
    }, { uid: true })) {
      const env = msg.envelope ?? {};
      const from = env.from?.[0]
        ? `${env.from[0].name ?? ''} <${env.from[0].address ?? ''}>`.trim()
        : '';
      const subject = env.subject ?? '(no subject)';
      const date = env.date ? env.date.toUTCString() : '';
      // Get snippet from TEXT body part
      const textBuf = msg.bodyParts?.get('TEXT');
      const rawText = textBuf ? textBuf.toString('utf8') : '';
      const snippet = rawText.replace(/\s+/g, ' ').trim().slice(0, 200);
      emails.push({ id: String(msg.uid), from, subject, date, snippet });
    }

    const lowestUid = pageUids[pageUids.length - 1];
    const nextPageToken = (uids.length > max && lowestUid > 1) ? String(lowestUid) : null;

    return { emails, nextPageToken };
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

/**
 * Delete one or more messages by UID.
 * Uses imapflow's messageDelete which flags + expunges.
 */
export async function deleteImapMessages(account, uids) {
  const creds = await decryptCreds(account);
  const client = makeClient(creds);
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    await client.messageDelete(uids.join(','), { uid: true });
    return uids.length;
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

/**
 * Mark one or more messages as read or unread.
 */
export async function markImapMessages(account, uids, unread = false) {
  const creds = await decryptCreds(account);
  const client = makeClient(creds);
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    const uidRange = uids.join(',');
    if (unread) {
      await client.messageFlagsRemove(uidRange, ['\\Seen'], { uid: true });
    } else {
      await client.messageFlagsAdd(uidRange, ['\\Seen'], { uid: true });
    }
    return uids.length;
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

/**
 * Fetch the headers needed to construct a reply (envelope + Message-ID header).
 * Returns { replyTo, subject, messageId, references } or null.
 */
export async function fetchImapReplyHeaders(account, uid) {
  const creds = await decryptCreds(account);
  const client = makeClient(creds);
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    let result = null;
    for await (const msg of client.fetch(String(uid), {
      uid: true,
      envelope: true,
      headers: ['message-id', 'references'],
    }, { uid: true })) {
      const env = msg.envelope ?? {};
      const replyToAddr = env.replyTo?.[0] ?? env.from?.[0];
      const replyTo = replyToAddr
        ? (replyToAddr.name ? `${replyToAddr.name} <${replyToAddr.address}>` : replyToAddr.address)
        : null;
      const rawHeaders = msg.headers ? msg.headers.toString() : '';
      const msgIdMatch = rawHeaders.match(/^message-id:\s*(.+)$/im);
      const refsMatch  = rawHeaders.match(/^references:\s*(.+)$/im);
      const msgId = msgIdMatch?.[1]?.trim() ?? null;
      const refs  = refsMatch?.[1]?.trim() ?? null;
      result = {
        replyTo,
        subject: env.subject ?? '',
        messageId: msgId,
        references: refs ? `${refs} ${msgId}` : msgId,
      };
    }
    return result;
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

/**
 * Fetch a single message body as HTML.
 */
export async function fetchImapMessageBody(account, uid) {
  const creds = await decryptCreds(account);
  const client = makeClient(creds);
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    let html = null;
    let text = null;

    for await (const msg of client.fetch(String(uid), {
      uid: true,
      bodyStructure: true,
      bodyParts: ['1', '2', 'TEXT'],
    }, { uid: true })) {
      // Try to find HTML part
      const htmlBuf = msg.bodyParts?.get('1');
      if (htmlBuf) {
        const str = htmlBuf.toString('utf8');
        if (/<html/i.test(str)) { html = str; break; }
      }
      const textBuf = msg.bodyParts?.get('TEXT');
      if (textBuf) text = textBuf.toString('utf8');
    }

    if (html) return html;
    if (text) return `<pre style="font-family:sans-serif;white-space:pre-wrap">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
    return '<p>No body content.</p>';
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}
