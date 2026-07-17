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
    // message/rfc822 wraps a nested structure under childNodes; walk into it.
    // Other multiparts also use childNodes. Only treat a node as a leaf when
    // it has no children (or an empty child list).
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    const type = String(node.type || '').toLowerCase();
    if (type !== 'text/plain' && type !== 'text/html') return;
    const disposition = String(node.disposition || '').toLowerCase();
    leaves.push({
      part: String(node.part || 'TEXT'),
      type,
      encoding: String(node.encoding || '').toLowerCase(),
      charset: String(node.parameters?.charset || 'utf-8'),
      // Prefer inline body parts over attached .eml / forwarded text blobs.
      attachment: disposition === 'attachment',
    });
  };
  visit(structure);
  const pick = mime => {
    const matches = leaves.filter(part => part.type === mime);
    return matches.find(part => !part.attachment) ?? matches[0] ?? null;
  };
  return {
    html: pick('text/html'),
    plain: pick('text/plain'),
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
  // ImapFlow stores keys as the server echoed them — often lowercase for
  // TEXT, sometimes with residual partial-fetch suffixes. Try exact, case
  // folds, then a single fuzzy match on the base part id.
  const direct = parts.get(part) ?? parts.get(part.toLowerCase()) ?? parts.get(part.toUpperCase());
  if (direct != null) return direct;
  const want = String(part).toLowerCase();
  for (const [key, value] of parts) {
    const base = String(key).toLowerCase().replace(/]<.*$/, '').replace(/\.mime$/, '');
    if (base === want || base.startsWith(`${want}<`) || base.startsWith(`${want} `)) return value;
  }
  return null;
}

/** Escape plain text for safe HTML display in the email iframe. */
export function plainTextToHtml(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<pre style="font-family:sans-serif;white-space:pre-wrap">${escaped}</pre>`;
}

/**
 * Last-resort extract of a displayable body from a raw RFC822 source buffer.
 * Handles simple single-part and multipart/alternative|mixed messages without
 * pulling in a full MIME parser dependency.
 */
export function extractBodyFromRfc822(source) {
  const raw = Buffer.isBuffer(source) ? source.toString('binary') : String(source ?? '');
  if (!raw.trim()) return null;

  const splitHeaders = buf => {
    const m = buf.match(/\r?\n\r?\n/);
    if (!m) return { headers: buf, body: '' };
    const idx = m.index ?? 0;
    return { headers: buf.slice(0, idx), body: buf.slice(idx + m[0].length) };
  };

  const headerValue = (headers, name) => {
    const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, 'im');
    const m = headers.match(re);
    return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
  };

  const decodePart = (headers, body) => {
    const encoding = headerValue(headers, 'Content-Transfer-Encoding');
    const ct = headerValue(headers, 'Content-Type');
    const charsetMatch = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
    const charset = charsetMatch?.[1] || 'utf-8';
    return decodeImapBodyPart(Buffer.from(body, 'binary'), encoding, charset);
  };

  const looksHtml = s => /<(?:html|body|div|p|br|table|span)[\s>]/i.test(s);

  const walk = (buf) => {
    const { headers, body } = splitHeaders(buf);
    const ct = headerValue(headers, 'Content-Type') || 'text/plain';
    const type = ct.split(';')[0].trim().toLowerCase();
    const boundaryMatch = ct.match(/boundary\s*=\s*"?([^";\s]+)"?/i);

    if (type.startsWith('multipart/') && boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = body.split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?(?:\\r?\\n|$)`));
      let html = null;
      let plain = null;
      for (const part of parts) {
        if (!part || !part.trim() || part.trim() === '--') continue;
        const found = walk(part);
        if (!found) continue;
        if (found.kind === 'html' && !html) html = found;
        else if (found.kind === 'plain' && !plain) plain = found;
      }
      return html || plain;
    }

    if (type === 'text/html') {
      const text = decodePart(headers, body);
      return text.trim() ? { kind: 'html', text } : null;
    }
    if (type === 'text/plain' || type === 'text') {
      const text = decodePart(headers, body);
      return text.trim() ? { kind: 'plain', text } : null;
    }
    // No Content-Type (or unknown): treat body as plain/html by sniffing.
    if (!headerValue(headers, 'Content-Type') && body.trim()) {
      const text = decodePart(headers, body);
      if (!text.trim()) return null;
      return { kind: looksHtml(text) ? 'html' : 'plain', text };
    }
    return null;
  };

  const found = walk(raw);
  if (!found) return null;
  if (found.kind === 'html') return found.text;
  return plainTextToHtml(found.text);
}

async function readDownloadStream(stream) {
  if (!stream) return null;
  // download() may return a Buffer in some paths; prefer stream iteration.
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream === 'string') return Buffer.from(stream);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
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
//
// Connect setup is also serialized via `connecting` so concurrent first calls
// (list page + open message, or two UI tabs) do not race-create two sockets
// and leave the pool pointing at the loser while the winner is abandoned mid-fetch.
const POOL_IDLE_MS = 30_000;
const _pool = new Map(); // key -> { client, chain, timer, connecting }

function _dropPooled(key, entry) {
  if (_pool.get(key) === entry) _pool.delete(key);
  clearTimeout(entry?.timer);
  entry?.client?.logout?.().catch(() => {});
}

async function _ensurePooledClient(key, userId, account) {
  let entry = _pool.get(key);
  if (entry?.client?.usable && !entry.connecting) return entry;

  // Another caller is already connecting — await that result.
  if (entry?.connecting) {
    await entry.connecting;
    entry = _pool.get(key);
    if (entry?.client?.usable) return entry;
  }

  // We are the connector. Mark the slot before any await so races join us.
  let resolveConnect;
  const connecting = new Promise(r => { resolveConnect = r; });
  if (entry) _dropPooled(key, entry);
  entry = { client: null, chain: Promise.resolve(), timer: null, connecting };
  _pool.set(key, entry);

  try {
    const creds = await decryptCreds(userId, account);
    const client = makeClient(creds);
    await client.connect();
    entry.client = client;
    entry.connecting = null;
    client.on('close', () => { if (_pool.get(key) === entry) _pool.delete(key); });
    client.on('error', () => { if (_pool.get(key) === entry) _pool.delete(key); });
    return entry;
  } catch (e) {
    if (_pool.get(key) === entry) _pool.delete(key);
    throw e;
  } finally {
    resolveConnect();
  }
}

async function withClient(userId, account, fn) {
  const key = `${userId}:${account.host}:${account.username}`;
  const entry = await _ensurePooledClient(key, userId, account);
  clearTimeout(entry.timer);
  const run = entry.chain.then(async () => {
    if (!entry.client?.usable) {
      throw new Error('IMAP connection closed before the operation started.');
    }
    await entry.client.mailboxOpen('INBOX');
    return fn(entry.client);
  });
  // Keep the chain alive even when this op fails; a dead connection is
  // dropped so the next call reconnects instead of reusing a broken socket.
  entry.chain = run.catch(() => {});
  try {
    return await run;
  } catch (e) {
    if (!entry.client?.usable) _dropPooled(key, entry);
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
 *
 * Prefers BODYSTRUCTURE-selected leaf parts, but falls back aggressively:
 * partial/empty bodyParts responses, missing structure, and single-part
 * TEXT-vs-1 key mismatches previously surfaced as a permanent
 * "No body content." even when the message was fully present on the server.
 * Concurrent list+open traffic on a pooled connection made that more likely.
 */
export async function fetchImapMessageBody(userId, account, uid) {
  return withClient(userId, account, async (client) => {
    const resolvedUid = await resolveImapUid(client, uid);

    // BODYSTRUCTURE tells us the real leaf ids (1, 2, 1.1, ...). Fetching a
    // hard-coded ['1','2','TEXT'] missed nested MIME parts and single-part
    // messages (ImapFlow keys TEXT as lowercase `text`).
    const metadata = await client.fetchOne(resolvedUid, {
      uid: true,
      bodyStructure: true,
    }, { uid: true });
    if (!metadata) {
      throw new Error(`IMAP message UID ${resolvedUid} was not found in INBOX.`);
    }

    const selected = metadata.bodyStructure
      ? selectImapTextParts(metadata.bodyStructure)
      : { html: null, plain: null };

    // Candidate part ids in preference order. Include TEXT↔1 aliases because
    // some servers answer one form and not the other for non-multipart mail.
    const partAliases = part => {
      const id = String(part || '').trim();
      if (!id) return [];
      if (id === 'TEXT' || id === '1') return ['TEXT', '1'];
      return [id];
    };
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (part, kind) => {
      for (const id of partAliases(part)) {
        const key = `${kind}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ part: id, kind });
      }
    };
    if (selected.html) pushCandidate(selected.html.part, 'html');
    if (selected.plain) pushCandidate(selected.plain.part, 'plain');
    // Structure missing or only attachments — still try common roots.
    if (!candidates.length) {
      pushCandidate('TEXT', 'unknown');
      pushCandidate('1', 'unknown');
    }

    // 1) Structured bodyParts fetch (fast, one round-trip for all candidates).
    const requested = [...new Set(candidates.map(c => c.part))];
    let bodyParts = null;
    try {
      const message = await client.fetchOne(resolvedUid, {
        uid: true,
        bodyParts: requested,
      }, { uid: true });
      bodyParts = message?.bodyParts ?? null;
    } catch {
      bodyParts = null;
    }

    for (const { part, kind } of candidates) {
      const meta = kind === 'html' ? selected.html
        : kind === 'plain' ? selected.plain
          : null;
      const buf = bodyPartValue(bodyParts, part);
      if (!buf || !buf.length) continue;
      const text = decodeImapBodyPart(
        buf,
        meta?.encoding || '',
        meta?.charset || 'utf-8',
      );
      if (!String(text).trim()) continue;
      if (kind === 'html' || (kind === 'unknown' && /<(?:html|body|div|p|br|table)[\s>]/i.test(text))) {
        return text;
      }
      return plainTextToHtml(text);
    }

    // 2) ImapFlow download() — decodes CTE/charset and remaps single-part "1"→TEXT.
    for (const { part, kind } of candidates) {
      try {
        const dl = await client.download(resolvedUid, part, { uid: true });
        const buf = await readDownloadStream(dl?.content);
        if (!buf?.length) continue;
        const text = buf.toString('utf8');
        if (!text.trim()) continue;
        if (kind === 'html' || (kind === 'unknown' && /<(?:html|body|div|p|br|table)[\s>]/i.test(text))) {
          return text;
        }
        if (kind === 'plain' || kind === 'unknown') return plainTextToHtml(text);
        return text;
      } catch {
        // try next candidate
      }
    }

    // 3) Full RFC822 source — survives servers that omit BODYSTRUCTURE leaves
    // or return empty bodyParts for otherwise-valid messages.
    try {
      const full = await client.fetchOne(resolvedUid, {
        uid: true,
        source: true,
      }, { uid: true });
      const extracted = extractBodyFromRfc822(full?.source);
      if (extracted) return extracted;
    } catch {
      // fall through
    }

    return '<p>No body content.</p>';
  });
}
