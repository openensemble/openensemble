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

/** Return the preferred HTML/plain leaf parts from an IMAP BODYSTRUCTURE. */
export function selectImapTextParts(structure) {
  const leaves = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    const type = String(node.type || '').toLowerCase();
    if (type !== 'text/plain' && type !== 'text/html') return;
    leaves.push({
      part: String(node.part || 'TEXT'),
      type,
      encoding: String(node.encoding || '').toLowerCase(),
      charset: String(node.parameters?.charset || 'utf-8'),
    });
  };
  visit(structure);
  return {
    html: leaves.find(part => part.type === 'text/html') ?? null,
    plain: leaves.find(part => part.type === 'text/plain') ?? null,
  };
}

/** Decode the Content-Transfer-Encoding and declared charset for one part. */
export function decodeImapBodyPart(value, encoding = '', charset = 'utf-8') {
  let bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  const normalizedEncoding = String(encoding || '').toLowerCase();
  if (normalizedEncoding === 'base64') {
    bytes = Buffer.from(bytes.toString('ascii').replace(/\s+/g, ''), 'base64');
  } else if (normalizedEncoding === 'quoted-printable') {
    const unfolded = bytes.toString('latin1').replace(/=\r?\n/g, '');
    const decoded = unfolded.replace(/=([0-9a-f]{2})/gi, (_match, hex) =>
      String.fromCharCode(parseInt(hex, 16)));
    bytes = Buffer.from(decoded, 'latin1');
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function bodyPartValue(parts, part) {
  if (!parts || !part) return null;
  return parts.get(part) ?? parts.get(part.toLowerCase()) ?? parts.get(part.toUpperCase()) ?? null;
}

/**
 * Normalize ImapFlow's SEARCH result before it reaches callers.
 *
 * ImapFlow returns `false` when the server rejects a SEARCH command, while a
 * legitimate no-match result is an empty array. Keep those states distinct so
 * a provider compatibility error cannot masquerade as an empty mailbox (or
 * crash later as `uids.sort is not a function`).
 */
export function normalizeImapSearchUids(value) {
  if (value === false || value == null) {
    throw new Error('IMAP search failed: the mailbox server rejected the search command.');
  }
  if (!Array.isArray(value)) {
    throw new Error('IMAP search failed: the mailbox client returned an unexpected response.');
  }
  const seen = new Set();
  for (const uid of value) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffff_ffff) {
      throw new Error('IMAP search failed: the mailbox server returned an invalid UID.');
    }
    seen.add(uid);
  }
  return [...seen];
}

export function normalizeImapPageSize(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 10;
  return Math.min(parsed, 100);
}

function normalizeImapSearchTerm(value, label = 'query') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length > 512 || /[\0\r\n]/.test(raw)) {
    throw new Error(`Invalid IMAP ${label}.`);
  }
  return raw;
}

/**
 * Build a portable IMAP SEARCH query.
 *
 * Use standard SUBJECT, HEADER From, and BODY keys to preserve the tool's
 * documented search scope. GreenMail rejects multi-word FROM searches but
 * accepts the equivalent HEADER From form. Accept the three simple
 * field-qualified forms models commonly emit so
 * `subject:"..."`, `from:...`, and `body:...` do not become literal text.
 */
export function buildImapInboxSearch(uidRange, query) {
  const search = {};
  if (uidRange) search.uid = uidRange;
  const raw = normalizeImapSearchTerm(query);
  if (!raw) return search;

  const qualified = raw.match(/^(subject|from|body)\s*:\s*(?:"([^"]+)"|'([^']+)'|(.+))$/i);
  if (qualified) {
    const value = String(qualified[2] ?? qualified[3] ?? qualified[4] ?? '').trim();
    if (value) {
      const field = qualified[1].toLowerCase();
      // GreenMail rejects a quoted, multi-word FROM search but accepts the
      // equivalent standard HEADER search. Real IMAP servers support both.
      if (field === 'from') search.header = { From: value };
      else search[field] = value;
      return search;
    }
  }

  // Models also commonly quote an exact phrase without a field qualifier
  // (for example `"Quarterly invoice"`). Quotes are Gmail-style syntax, not
  // part of the text IMAP SEARCH should match. Preserve the existing portable
  // subject/From/body scope while removing only one balanced outer pair.
  const quotedPhrase = raw.match(/^"([^"]+)"$/)?.[1] ?? raw.match(/^'([^']+)'$/)?.[1];
  const text = String(quotedPhrase ?? raw).trim();
  search.or = [
    { subject: text },
    { header: { From: text } },
    { body: text },
  ];
  return search;
}

export function buildImapPurgeSearch(sender, query) {
  const normalizedSender = normalizeImapSearchTerm(sender, 'sender');
  if (normalizedSender) return { header: { From: normalizedSender } };
  const normalizedQuery = normalizeImapSearchTerm(query);
  if (!normalizedQuery) {
    throw new Error('IMAP purge requires a non-empty sender or query.');
  }
  return buildImapInboxSearch(null, normalizedQuery);
}

/**
 * Resolve either the numeric UID shown by email_list or an RFC Message-ID
 * returned by SMTP into an INBOX UID. Models commonly confuse the two because
 * both were historically labelled "Message ID". Header search lets email_read
 * accept the SMTP identifier safely instead of issuing an invalid UID FETCH.
 *
 * @param {any} client connected ImapFlow client with INBOX already selected
 * @param {unknown} identifier numeric UID, bracketed UID, or RFC Message-ID
 * @returns {Promise<string>}
 */
export async function resolveImapUid(client, identifier) {
  const raw = String(identifier ?? '').trim();
  const bracketed = raw.match(/^\[(\d+)\]$/)?.[1] ?? raw;
  if (/^[1-9]\d*$/.test(bracketed)) return bracketed;
  if (!raw) throw new Error('No IMAP message identifier was provided. Use the numeric UID from email_list.');
  if (raw.length > 998 || /[\r\n]/.test(raw)) throw new Error('Invalid IMAP message identifier.');

  const found = await client.search({ header: { 'Message-ID': raw } }, { uid: true });
  const uids = normalizeImapSearchUids(found);
  if (!uids.length) {
    throw new Error(`No INBOX message matches RFC Message-ID ${raw}. Call email_list and use its numeric UID (for example "3").`);
  }
  // Message-ID should be globally unique. If a broken sender duplicated it,
  // prefer the newest copy rather than reading an arbitrary older message.
  return String(Math.max(...uids));
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
    const search = buildImapInboxSearch(uidRange, query);

    // Fetch UIDs in the range, sorted descending
    const limit = normalizeImapPageSize(max);
    const found = await client.search(search, { uid: true });
    const uids = normalizeImapSearchUids(found);
    // imapflow returns UIDs ascending; reverse and slice
    uids.sort((a, b) => b - a);
    const pageUids = uids.slice(0, limit);

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
    const nextPageToken = (uids.length > limit && lowestUid > 1) ? String(lowestUid) : null;

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
    const search = buildImapPurgeSearch(sender, query);
    const found = await client.search(search, { uid: true });
    const uids = normalizeImapSearchUids(found);
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
    const resolvedUid = await resolveImapUid(client, uid);
    let result = null;
    for await (const msg of client.fetch(resolvedUid, {
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
        uid: resolvedUid,
        replyTo,
        subject: env.subject ?? '',
        messageId: msgId,
        references: refs ? `${refs} ${msgId}` : msgId,
      };
    }
    return result;
  });
}

/** Stable reply identity shared by a numeric UID and its RFC Message-ID alias. */
export function canonicalImapReplyIdentity(headers) {
  const messageId = String(headers?.messageId || '').trim();
  if (messageId) return messageId;
  const uid = String(headers?.uid || '').trim();
  return uid ? `imap-uid:${uid}` : '';
}

/**
 * Fetch a single message body as HTML.
 */
export async function fetchImapMessageBody(userId, account, uid) {
  return withClient(userId, account, async (client) => {
    const resolvedUid = await resolveImapUid(client, uid);
    // BODYSTRUCTURE tells us the real leaf ids (1, 2, 1.1, ...). Fetching a
    // hard-coded ['1','2','TEXT'] missed single-part messages because ImapFlow
    // keys that response as lowercase `text`, and it missed nested MIME parts.
    const metadata = await client.fetchOne(resolvedUid, {
      uid: true,
      bodyStructure: true,
    }, { uid: true });
    if (!metadata?.bodyStructure) return '<p>No body content.</p>';

    const selected = selectImapTextParts(metadata.bodyStructure);
    const requested = [...new Set([selected.html?.part, selected.plain?.part].filter(Boolean))];
    if (!requested.length) return '<p>No body content.</p>';
    const message = await client.fetchOne(resolvedUid, {
      uid: true,
      bodyParts: requested,
    }, { uid: true });
    const htmlBuf = selected.html ? bodyPartValue(message?.bodyParts, selected.html.part) : null;
    if (htmlBuf) {
      return decodeImapBodyPart(htmlBuf, selected.html.encoding, selected.html.charset);
    }
    const textBuf = selected.plain ? bodyPartValue(message?.bodyParts, selected.plain.part) : null;
    if (textBuf) {
      const text = decodeImapBodyPart(textBuf, selected.plain.encoding, selected.plain.charset);
      return `<pre style="font-family:sans-serif;white-space:pre-wrap">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
    }
    return '<p>No body content.</p>';
  });
}
