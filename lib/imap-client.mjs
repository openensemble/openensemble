/**
 * IMAP inbox fetcher using imapflow.
 * Pagination uses the lowest UID from the last batch as a numeric cursor.
 */

import { ImapFlow } from 'imapflow';
import { decrypt } from './email-crypto.mjs';

/**
 * Decrypt stored IMAP credentials and return a plain object.
 * Per-user encryption: callers must pass userId so the right master key is used.
 */
async function decryptCreds(userId, account) {
  const password = await decrypt(userId, account.encryptedPassword);
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

// ── Short-lived connection pool ──────────────────────────────────────────────
// Every exported operation used to do a fresh TCP + TLS + LOGIN and a LOGOUT —
// a multi-hundred-ms handshake tax per call, and an email sort session makes
// many calls back to back. Pool one connection per (user, account), reused
// while warm and closed after 30s idle. Operations on a shared connection are
// serialized through a per-entry promise chain (interleaving two fetches on
// one IMAP socket via imapflow is not safe across mailboxOpen boundaries).
const POOL_IDLE_MS = 30_000;
const _pool = new Map(); // key -> { client, chain, timer }

function _dropPooled(key, entry) {
  if (_pool.get(key) === entry) _pool.delete(key);
  clearTimeout(entry.timer);
  entry.client.logout().catch(() => {});
}

async function withClient(userId, account, fn) {
  const key = `${userId}:${account.host}:${account.username}`;
  let entry = _pool.get(key);
  if (!entry || !entry.client.usable) {
    if (entry) _dropPooled(key, entry);
    const creds = await decryptCreds(userId, account);
    const client = makeClient(creds);
    await client.connect();
    entry = { client, chain: Promise.resolve(), timer: null };
    _pool.set(key, entry);
    client.on('close', () => { if (_pool.get(key) === entry) _pool.delete(key); });
    client.on('error', () => { if (_pool.get(key) === entry) _pool.delete(key); });
  }
  clearTimeout(entry.timer);
  const run = entry.chain.then(async () => {
    await entry.client.mailboxOpen('INBOX');
    return fn(entry.client);
  });
  // Keep the chain alive even when this op fails; a dead connection is
  // dropped so the next call reconnects instead of reusing a broken socket.
  entry.chain = run.catch(() => {});
  try {
    return await run;
  } catch (e) {
    if (!entry.client.usable) _dropPooled(key, entry);
    throw e;
  } finally {
    if (_pool.get(key) === entry) {
      entry.timer = setTimeout(() => _dropPooled(key, entry), POOL_IDLE_MS);
      entry.timer.unref?.();
    }
  }
}

/**
 * Test that a connection can be established. Throws on failure.
 */
export async function testConnection(plainCreds) {
  const client = makeClient(plainCreds);
  await client.connect();
  await client.logout();
}

// Snippets need ~200 chars; BODY.PEEK[TEXT]<0.2048> caps the transfer at 2 KB
// per message instead of pulling entire multipart bodies (MBs of base64 on
// attachment-heavy mail) just to slice a preview.
const SNIPPET_FETCH_BYTES = 2048;

/**
 * Fetch a page of inbox messages.
 * @param {string} userId - owner of the account (used to resolve the per-user encryption key)
 * @param {object} account - account record (with encryptedPassword)
 * @param {string|null} pageToken - lowest UID from previous batch, or null for first page
 * @param {number} max - number of messages to fetch
 * @returns {{ emails: Array, nextPageToken: string|null }}
 */
export async function fetchInboxPage(userId, account, pageToken, max, query) {
  return withClient(userId, account, async (client) => {
    // Build UID search range — descending by UID, optionally capped by cursor.
    // When `query` is set, AND it with the UID range so the server filters
    // server-side (faster + works on huge mailboxes) instead of fetching
    // everything and filtering locally.
    let uidRange = pageToken ? `1:${parseInt(pageToken, 10) - 1}` : '*:1';
    const search = { uid: uidRange };
    if (query && String(query).trim()) {
      const q = String(query).trim();
      // OR across subject / from / body so the user's term hits any of them.
      search.or = [{ subject: q }, { from: q }, { body: q }];
    }

    // Fetch UIDs in the range, sorted descending
    const uids = await client.search(search, { uid: true });
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
      // Byte-capped partial fetch — see SNIPPET_FETCH_BYTES above.
      bodyParts: [{ key: 'TEXT', start: 0, maxLength: SNIPPET_FETCH_BYTES }],
    }, { uid: true })) {
      const env = msg.envelope ?? {};
      const from = env.from?.[0]
        ? `${env.from[0].name ?? ''} <${env.from[0].address ?? ''}>`.trim()
        : '';
      const subject = env.subject ?? '(no subject)';
      const date = env.date ? env.date.toUTCString() : '';
      // Partial responses come back under a server-echoed key like
      // "text]<0>" (imapflow's partKey strip only handles the plain form),
      // so take the first value — we requested exactly one part.
      const textBuf = msg.bodyParts ? msg.bodyParts.values().next().value : null;
      const rawText = textBuf ? textBuf.toString('utf8') : '';
      const snippet = rawText.replace(/\s+/g, ' ').trim().slice(0, 200);
      emails.push({ id: String(msg.uid), from, subject, date, snippet });
    }

    const lowestUid = pageUids[pageUids.length - 1];
    const nextPageToken = (uids.length > max && lowestUid > 1) ? String(lowestUid) : null;

    return { emails, nextPageToken };
  });
}

/**
 * Delete one or more messages by UID.
 * Uses imapflow's messageDelete which flags + expunges.
 */
export async function deleteImapMessages(userId, account, uids) {
  return withClient(userId, account, async (client) => {
    await client.messageDelete(uids.join(','), { uid: true });
    return uids.length;
  });
}

/**
 * Purge every inbox message matching a sender (substring on the From header)
 * or a query (OR across subject/from/body). IMAP's only "delete" verb is
 * \Deleted + EXPUNGE — whether the server retains a Trash copy is
 * server-specific, so `permanent` is accepted for API parity with Gmail but
 * does not change behavior.
 */
export async function purgeImapBySender(userId, account, { sender, query }) {
  return withClient(userId, account, async (client) => {
    const search = sender
      ? { from: sender }
      : { or: [{ subject: query }, { from: query }, { body: query }] };
    const uids = await client.search(search, { uid: true });
    if (!uids.length) return 0;
    await client.messageDelete(uids.join(','), { uid: true });
    return uids.length;
  });
}

/**
 * Get inbox unread + total counts via the IMAP STATUS command (RFC 3501).
 */
export async function fetchImapInboxStats(userId, account) {
  return withClient(userId, account, async (client) => {
    const s = await client.status('INBOX', { messages: true, unseen: true });
    const unread = s.unseen ?? '?';
    const total  = s.messages ?? '?';
    return `Inbox: ${unread} unread, ${total} total.`;
  });
}

/**
 * Mark one or more messages as read or unread.
 */
export async function markImapMessages(userId, account, uids, unread = false) {
  return withClient(userId, account, async (client) => {
    const uidRange = uids.join(',');
    if (unread) {
      await client.messageFlagsRemove(uidRange, ['\\Seen'], { uid: true });
    } else {
      await client.messageFlagsAdd(uidRange, ['\\Seen'], { uid: true });
    }
    return uids.length;
  });
}

/**
 * Fetch the headers needed to construct a reply (envelope + Message-ID header).
 * Returns { replyTo, subject, messageId, references } or null.
 */
export async function fetchImapReplyHeaders(userId, account, uid) {
  return withClient(userId, account, async (client) => {
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
  });
}

/**
 * Fetch a single message body as HTML.
 */
export async function fetchImapMessageBody(userId, account, uid) {
  return withClient(userId, account, async (client) => {
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
  });
}
