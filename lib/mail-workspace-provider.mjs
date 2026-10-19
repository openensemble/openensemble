import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { createGmailReader } from './gmail-read.mjs';
import { getGmailAuthHeader } from './google-auth.mjs';
import { getMsAuthHeader } from './ms-graph.mjs';
import { withImapMailbox, selectImapTextParts, decodeImapBodyPart, buildImapInboxSearch } from './imap-client.mjs';
import { decrypt } from './email-crypto.mjs';
import { resolveSmtpFrom } from './smtp-client.mjs';

const enc = encodeURIComponent;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GMAIL_VIEWS = { __archive__: '-in:inbox -in:sent -in:trash -in:spam -is:draft', __all__: '-in:trash -in:spam', __snoozed__: 'in:snoozed', __purchases__: 'category:purchases' };
const esc = text => String(text || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const asHtml = text => `<pre style="white-space:pre-wrap;font:14px/1.7 system-ui">${esc(text)}</pre>`;
const addr = values => (values || []).map(v => `${v.name || ''} <${v.address || ''}>`.trim()).join(', ');
const graphAddr = values => addr((values || []).map(v => v.emailAddress || {}));

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw Object.assign(new Error(data.error?.message || `Mail provider returned HTTP ${response.status}.`), { status: response.status });
  return data;
}
async function gmailWrite(userId, account, endpoint, body, method = 'POST') {
  return request(GMAIL + endpoint, { method, headers: { ...await getGmailAuthHeader(userId, account.id), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function graph(userId, account, endpoint, options = {}) {
  return request(GRAPH + endpoint, { ...options, headers: { ...await getMsAuthHeader(userId, account.id), ...options.headers } });
}

export async function mailAccountAddress(userId, account) {
  if (account.provider === 'gmail') return (await (await createGmailReader(userId, account.id))('/profile')).emailAddress || '';
  if (account.provider === 'imap') return resolveSmtpFrom(account);
  // This identity is only for display/reply-all exclusions, never authorization.
  // The existing Microsoft grant has Mail scopes but not User.Read.
  const { Authorization } = await getMsAuthHeader(userId, account.id);
  try {
    const claims = JSON.parse(Buffer.from(Authorization.split('.')[1], 'base64url').toString());
    for (const field of ['preferred_username', 'email', 'upn', 'unique_name']) if (typeof claims[field] === 'string' && /^[^\s@]+@[^\s@]+$/.test(claims[field])) return claims[field];
  } catch {}
  return account.email || account.username || '';
}

function gmailMessage(message) {
  const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  const files = [];
  let html = '', plain = '';
  function part(p) {
    if (p.filename) files.push({ id: p.body?.attachmentId || `part:${p.partId}`, name: p.filename, type: p.mimeType, size: p.body?.size || 0 });
    else if (p.body?.data) {
      const body = Buffer.from(p.body.data, 'base64url').toString('utf8');
      if (p.mimeType === 'text/html') html += body;
      if (p.mimeType === 'text/plain') plain += body;
    }
    for (const child of p.parts || []) part(child);
  }
  if (message.payload) part(message.payload);
  return { id: message.id, threadId: message.threadId, from: headers.from || '', to: headers.to || '', cc: headers.cc || '', replyTo: headers['reply-to'] || headers.from || '', subject: headers.subject || '(No subject)', date: headers.date || '', snippet: message.snippet || '', unread: message.labelIds?.includes('UNREAD') || false, starred: message.labelIds?.includes('STARRED') || false, labels: message.labelIds || [], html: html || asHtml(plain), text: plain, messageId: headers['message-id'] || '', references: headers.references || '', attachments: files };
}
function graphMessage(m) {
  const headers = Object.fromEntries((m.internetMessageHeaders || []).map(h => [h.name.toLowerCase(), h.value]));
  return { id: m.id, threadId: m.conversationId, from: graphAddr(m.from ? [m.from] : []), to: graphAddr(m.toRecipients), cc: graphAddr(m.ccRecipients), replyTo: graphAddr(m.replyTo?.length ? m.replyTo : m.from ? [m.from] : []), subject: m.subject || '(No subject)', date: m.receivedDateTime || m.sentDateTime || '', snippet: m.bodyPreview || '', unread: !m.isRead, starred: m.flag?.flagStatus === 'flagged', folder: m.parentFolderId, html: m.body?.contentType?.toLowerCase() === 'html' ? m.body.content : asHtml(m.body?.content), text: m.body?.contentType?.toLowerCase() === 'text' ? m.body.content : '', messageId: m.internetMessageId || '', references: headers.references || '', attachments: (m.attachments || []).filter(a => !a.isInline).map(a => ({ id: a.id, name: a.name, type: a.contentType, size: a.size })) };
}

const MS_FOLDER_KINDS = { inbox: 'inbox', sentitems: 'sent', archive: 'archive', deleteditems: 'trash', junkemail: 'junk', drafts: 'provider-drafts', outbox: 'outbox' };
const MS_FOLDER_FIELDS = 'id,displayName,parentFolderId,childFolderCount,unreadItemCount';

async function microsoftFolders(userId, account) {
  // Share one refreshed token across the hierarchy requests.
  const headers = await getMsAuthHeader(userId, account.id);
  const read = endpoint => request(GRAPH + endpoint, { headers });
  async function collection(endpoint) {
    const values = [], seen = new Set();
    const expectedPath = decodeURIComponent(new URL(GRAPH + endpoint).pathname);
    while (endpoint) {
      if (seen.has(endpoint) || seen.size >= 100) throw new Error('Microsoft returned an invalid folder page sequence.');
      seen.add(endpoint);
      const data = await read(endpoint);
      if (!Array.isArray(data.value)) throw new Error('Microsoft returned an incomplete folder list.');
      values.push(...data.value);
      endpoint = null;
      if (data['@odata.nextLink']) {
        const next = new URL(data['@odata.nextLink']);
        if (next.origin !== 'https://graph.microsoft.com' || decodeURIComponent(next.pathname) !== expectedPath) throw new Error('Microsoft returned an invalid folder page.');
        endpoint = next.pathname.slice('/v1.0'.length) + next.search;
      }
    }
    return values;
  }
  const kinds = new Map();
  const aliases = Object.entries(MS_FOLDER_KINDS);
  for (let i = 0; i < aliases.length; i += 4) {
    await Promise.all(aliases.slice(i, i + 4).map(async ([alias, kind]) => {
      try {
        const folder = await read(`/me/mailFolders/${alias}?$select=id`);
        if (!folder.id) throw new Error('Microsoft returned an incomplete system folder.');
        kinds.set(folder.id, kind);
      } catch (error) { if (error.status !== 404) throw error; }
    }));
  }
  const records = new Map();
  let pending = [{ endpoint: `/me/mailFolders?$top=100&$select=${MS_FOLDER_FIELDS}`, depth: 0 }];
  while (pending.length) {
    const batch = pending.splice(0, 4);
    const results = await Promise.all(batch.map(async item => ({ ...item, folders: await collection(item.endpoint) })));
    for (const { folders, depth } of results) for (const folder of folders) {
      if (!folder.id || typeof folder.displayName !== 'string') throw new Error('Microsoft returned an incomplete folder.');
      if (records.has(folder.id)) continue;
      if (depth > 40 || records.size >= 5000) throw new Error('This mailbox exceeds the supported folder hierarchy size.');
      records.set(folder.id, folder);
      if (folder.childFolderCount > 0) pending.push({ endpoint: `/me/mailFolders/${enc(folder.id)}/childFolders?$top=100&$select=${MS_FOLDER_FIELDS}`, depth: depth + 1 });
    }
  }
  const folders = [...records.values()].map(folder => {
    const kind = kinds.get(folder.id) || 'folder';
    const searchFolder = folder['@odata.type'] === '#microsoft.graph.mailSearchFolder';
    return { id: folder.id, name: folder.displayName, kind, parentId: records.has(folder.parentFolderId) ? folder.parentFolderId : null, unreadCount: folder.unreadItemCount || 0, canRename: !kinds.has(folder.id) && !searchFolder, canCreateChildren: !searchFolder && kind !== 'outbox', canMoveMessages: !searchFolder && !['provider-drafts', 'outbox'].includes(kind) };
  });
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  function describe(folder, seen = new Set()) {
    if (seen.has(folder.id)) throw new Error('Microsoft returned a circular folder hierarchy.');
    seen.add(folder.id);
    const parent = byId.get(folder.parentId);
    return parent ? [...describe(parent, seen), folder.name] : [folder.name];
  }
  for (const folder of folders) { const parts = describe(folder); folder.path = parts.join(' / '); folder.depth = parts.length - 1; }
  return folders.sort((a, b) => a.path.localeCompare(b.path));
}

const IMAP_FOLDER_KINDS = { '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Archive': 'archive', '\\Trash': 'trash', '\\Junk': 'junk', '\\Drafts': 'provider-drafts', '\\All': 'all-mail', '\\Flagged': 'starred' };

function imapFolderTree(client, records) {
  const folders = new Map(), prefix = client.namespace?.prefix || '';
  for (const record of records) {
    if (typeof record.path !== 'string' || !record.path) throw new Error('IMAP returned an incomplete folder list.');
    const delimiter = record.delimiter || null, parts = delimiter ? record.path.split(delimiter) : [record.path];
    if (parts.length > 40 || folders.size >= 5000) throw new Error('This mailbox exceeds the supported folder hierarchy size.');
    const kind = record.path.toUpperCase() === 'INBOX' ? 'inbox' : IMAP_FOLDER_KINDS[record.specialUse] || 'folder';
    const selectable = !record.flags?.has('\\Noselect') && !record.flags?.has('\\NonExistent');
    folders.set(record.path, { id: record.path, name: kind === 'inbox' ? 'Inbox' : parts.at(-1), kind, parentId: parts.length > 1 ? parts.slice(0, -1).join(delimiter) : null, delimiter, selectable, unreadCount: record.status?.unseen || 0, canRename: selectable && kind === 'folder' && !record.specialUse && (!prefix || record.path.startsWith(prefix)), canCreateChildren: !!delimiter && !record.flags?.has('\\Noinferiors') && (!prefix || `${record.path}${delimiter}`.startsWith(prefix)), canMoveMessages: selectable && !['provider-drafts', 'all-mail', 'starred'].includes(kind) });
  }
  // LIST can omit parent containers. Keep their children reachable without
  // pretending those containers are selectable mailboxes.
  for (const folder of [...folders.values()]) {
    let parent = folder.parentId;
    while (parent && !folders.has(parent)) {
      if (folders.size >= 5000) throw new Error('This mailbox exceeds the supported folder hierarchy size.');
      const parts = parent.split(folder.delimiter);
      folders.set(parent, { id: parent, name: parts.at(-1), kind: 'folder', parentId: parts.length > 1 ? parts.slice(0, -1).join(folder.delimiter) : null, delimiter: folder.delimiter, selectable: false, canRename: false, canCreateChildren: !prefix || `${parent}${folder.delimiter}`.startsWith(prefix), canMoveMessages: false });
      parent = folders.get(parent).parentId;
    }
  }
  for (const folder of folders.values()) {
    const names = [folder.name]; let parent = folders.get(folder.parentId);
    while (parent) { names.unshift(parent.name); if (folder.kind !== 'folder') parent.canRename = false; parent = folders.get(parent.parentId); }
    folder.path = names.join(' / '); folder.depth = names.length - 1;
  }
  return [...folders.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function imapManageFolder(userId, account, { operation, folder, parentFolder, name }) {
  // Keep LIST, validation and mutation in one connection queue. INBOX stays
  // selected so renaming a custom folder never invokes IMAP CLOSE/expunge.
  return withImapMailbox(userId, account, 'INBOX', async client => {
    const records = await client.list(), folders = imapFolderTree(client, records);
    const existing = operation === 'rename_folder' ? folders.find(f => f.id === folder) : null;
    if (operation === 'rename_folder' && !existing?.canRename) throw new Error('Choose a custom folder in this account to rename. System folders and folder groups cannot be renamed here.');
    const parentId = existing ? existing.parentId : parentFolder || null;
    const parent = parentId ? folders.find(f => f.id === parentId) : null;
    if (parentId && (!parent || (operation === 'create_folder' && !parent.canCreateChildren))) throw new Error('Choose a parent folder in this account that accepts subfolders.');
    const delimiter = existing ? existing.delimiter : parent ? parent.delimiter : client.namespace?.delimiter;
    if (delimiter && name.includes(delimiter)) throw new Error(`Folder names cannot contain this server's separator (${delimiter}). Choose a parent using Location instead.`);
    if (parent && !delimiter) throw new Error('This IMAP server does not support subfolders in that location.');
    const target = parent ? `${parent.id}${delimiter}${name}` : `${client.namespace?.prefix || ''}${name}`;
    if (target.toUpperCase() === 'INBOX') throw new Error('Inbox is a system folder. Choose another name.');
    if (folders.some(f => f.id !== existing?.id && f.id.toLowerCase() === target.toLowerCase())) throw new Error('A folder with that name already exists in this location.');
    if (existing?.id === target) return { accountId: account.id, folder: existing, renamedFolders: [] };
    let saved;
    try { saved = existing ? await client.mailboxRename(existing.id, target) : await client.mailboxCreate(target); }
    catch (error) { throw new Error(`IMAP could not confirm the folder ${existing ? 'rename' : 'creation'}: ${error.responseText || error.message}. Refresh folders before retrying.`); }
    if (!saved || (existing ? !saved.newPath : !saved.path)) throw new Error('IMAP did not confirm the folder change. Refresh folders before retrying.');
    if (!existing && !saved.created) throw new Error('A folder with that name already exists in this location. Refresh your folders.');
    const id = existing ? saved.newPath : saved.path;
    const renamedFolders = existing ? folders.filter(f => f.id === existing.id || (delimiter && f.id.startsWith(`${existing.id}${delimiter}`))).map(f => ({ oldId: f.id, id: id + f.id.slice(existing.id.length) })) : [];
    let subscriptionFailed = false;
    for (const change of renamedFolders) {
      if (!records.find(r => r.path === change.oldId)?.subscribed) continue;
      try {
        // RENAME does not update subscriptions on many servers. Subscribe the
        // new path before removing the old one, including subscribed children.
        if (!await client.mailboxSubscribe(change.id)) { subscriptionFailed = true; continue; }
        if (!await client.mailboxUnsubscribe(change.oldId)) subscriptionFailed = true;
      } catch { subscriptionFailed = true; }
    }
    const actualParentId = delimiter && id.includes(delimiter) ? id.slice(0, id.lastIndexOf(delimiter)) : null;
    const actualParent = folders.find(f => f.id === actualParentId);
    return { accountId: account.id, folder: { ...existing, id, name, kind: 'folder', parentId: actualParentId, delimiter: delimiter || null, selectable: true, path: [actualParent?.path, name].filter(Boolean).join(' / '), depth: actualParent ? actualParent.depth + 1 : 0, canRename: true, canCreateChildren: existing ? existing.canCreateChildren : !!delimiter, canMoveMessages: true }, renamedFolders, ...(subscriptionFailed ? { warning: 'Folder renamed, but some subscriptions could not be updated. Other mail apps may need their folder subscriptions refreshed.' } : {}) };
  });
}

function gmailLabel(label, parentId = null) {
  return { id: label.id, name: label.name, kind: 'label', path: label.name, parentId, canCreateChildren: true, canRename: true, canDelete: true, canMoveMessages: true };
}

async function gmailManageLabel(userId, account, { operation, folder, name, parentFolder }) {
  if (account.provider !== 'gmail') throw new Error('Managing labels is available for Gmail accounts.');
  const editing = operation !== 'create_label';
  if (operation !== 'delete_label' && (name !== undefined || !editing)) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 225 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Use a label name between 1 and 225 characters without control characters.');
    name = name.trim();
    if (name.includes('/')) throw new Error('Use a single label name. Choose a parent with Nest under instead of using a slash.');
  }
  const read = await createGmailReader(userId, account.id);
  const data = await read('/labels');
  if (!Array.isArray(data.labels)) throw new Error('Gmail returned an incomplete label list. Refresh labels before retrying.');
  const labels = data.labels.map(label => ({ ...label }));
  const existing = editing ? labels.find(label => label.id === folder && label.type === 'user') : null;
  if (editing && !existing) throw new Error('Choose a custom Gmail label in this account. System labels cannot be edited or deleted.');
  if (operation === 'delete_label') {
    await gmailWrite(userId, account, `/labels/${enc(existing.id)}`, undefined, 'DELETE');
    return { accountId: account.id, deletedFolderIds: [existing.id] };
  }
  const previousPrefix = existing?.name.includes('/') ? existing.name.slice(0, existing.name.lastIndexOf('/')) : '';
  const previousParent = previousPrefix ? labels.find(l => l.type === 'user' && l.name === previousPrefix) : null;
  const parentId = parentFolder === undefined ? previousParent?.id : parentFolder;
  const parent = parentId ? labels.find(label => label.id === parentId && label.type === 'user') : null;
  if (parentId && !parent) throw new Error('Choose an existing custom parent label in this account.');
  if (existing && parent && (parent.id === existing.id || parent.name.startsWith(`${existing.name}/`))) throw new Error('A label cannot be nested under itself or one of its children.');
  name = name ?? existing.name.split('/').at(-1);
  const parentName = parent?.name || (parentFolder === undefined ? previousPrefix : '');
  const fullName = parentName ? `${parentName}/${name}` : name;
  const affected = existing ? labels.filter(l => l.type === 'user' && (l.id === existing.id || l.name.startsWith(`${existing.name}/`))).sort((a, b) => a.name.length - b.name.length) : [];
  const changes = affected.map(label => ({ label, name: fullName + label.name.slice(existing.name.length) }));
  const affectedIds = new Set(affected.map(l => l.id));
  for (const target of changes.length ? changes : [{ name: fullName }]) {
    if (target.name.length > 225) throw new Error('The full label name, including its parent, must be 225 characters or fewer.');
    const collision = labels.find(l => !affectedIds.has(l.id) && l.name.toLowerCase() === target.name.toLowerCase());
    if (collision) throw new Error(collision.type === 'system' ? 'That name is reserved for a Gmail system label. Choose another name.' : 'A label with that name already exists in this location.');
  }
  if (!existing) {
    const saved = await gmailWrite(userId, account, '/labels', { name: fullName, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
    if (!saved.id || typeof saved.name !== 'string' || !saved.name) throw new Error('Gmail did not confirm the new label. Refresh labels before retrying.');
    return { accountId: account.id, folder: gmailLabel(saved, parent?.id || null) };
  }
  let completed = 0, warning;
  for (const change of changes) {
    if (change.label.name === change.name) continue;
    try {
      const saved = await gmailWrite(userId, account, `/labels/${enc(change.label.id)}`, { name: change.name }, 'PATCH');
      if (saved.id !== change.label.id || saved.name !== change.name) throw new Error('Gmail did not confirm the label change.');
      change.label.name = saved.name; completed++;
    } catch (error) {
      if (!completed) throw error;
      warning = `Gmail updated ${completed} of ${changes.length} labels before an error: ${error.message} Refresh labels and review the remaining nested labels.`;
      break;
    }
  }
  const byName = new Map(labels.filter(l => l.type === 'user').map(l => [l.name, l.id]));
  const updatedFolders = affected.map(l => gmailLabel(l, l.name.includes('/') ? byName.get(l.name.slice(0, l.name.lastIndexOf('/'))) || null : null));
  return { accountId: account.id, folder: updatedFolders.find(l => l.id === existing.id), updatedFolders, ...(warning ? { partial: true, warning } : {}) };
}

export async function mailManageFolder(userId, account, { operation, folder, parentFolder, name }) {
  if (['create_label', 'update_label', 'delete_label'].includes(operation)) return gmailManageLabel(userId, account, { operation, folder, name, parentFolder });
  if (!['microsoft', 'imap'].includes(account.provider)) throw new Error('Creating and renaming folders is currently available for Microsoft and IMAP accounts.');
  if (!['create_folder', 'rename_folder'].includes(operation)) throw new Error('Unsupported folder action.');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 255 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Use a folder name between 1 and 255 characters without control characters.');
  name = name.trim();
  if (account.provider === 'imap') return imapManageFolder(userId, account, { operation, folder, parentFolder, name });
  const folders = await microsoftFolders(userId, account);
  const existing = operation === 'rename_folder' ? folders.find(f => f.id === folder) : null;
  if (operation === 'rename_folder' && !existing?.canRename) throw new Error('Choose a custom folder in this account to rename. Outlook system folders cannot be renamed here.');
  const parentId = existing ? existing.parentId : parentFolder || null;
  const parent = parentId ? folders.find(f => f.id === parentId) : null;
  if (parentId && (!parent || (operation === 'create_folder' && !parent.canCreateChildren))) throw new Error('Choose a parent folder in this account that accepts subfolders.');
  if (folders.some(f => f.id !== existing?.id && f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase())) throw new Error('A folder with that name already exists in this location.');
  const endpoint = existing ? `/me/mailFolders/${enc(existing.id)}` : parentId ? `/me/mailFolders/${enc(parentId)}/childFolders` : '/me/mailFolders';
  const saved = await graph(userId, account, endpoint, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) });
  if (!saved.id) throw new Error('Microsoft did not return a folder ID. Refresh your folders before retrying.');
  return { folder: { ...existing, id: saved.id, name: saved.displayName || name, kind: 'folder', parentId, path: [parent?.path, saved.displayName || name].filter(Boolean).join(' / '), depth: parent ? parent.depth + 1 : 0, unreadCount: saved.unreadItemCount || 0, canRename: true, canCreateChildren: true, canMoveMessages: true } };
}

export async function mailFolders(userId, account) {
  if (account.provider === 'gmail') {
    const read = await createGmailReader(userId, account.id);
    const { labels = [] } = await read('/labels');
    const userLabels = labels.filter(l => l.type === 'user'), byName = new Map(userLabels.map(l => [l.name, l.id]));
    return [
      { id: 'INBOX', name: 'Inbox', kind: 'inbox' }, { id: 'STARRED', name: 'Starred', kind: 'starred' },
      { id: 'SENT', name: 'Sent', kind: 'sent' }, { id: '__archive__', name: 'Archive', kind: 'archive' },
      { id: 'TRASH', name: 'Trash', kind: 'trash' },
      ...labels.filter(l => l.type === 'system' && !['INBOX', 'STARRED', 'SENT', 'TRASH', 'CHAT', 'YELLOW_STAR', 'UNREAD'].includes(l.id)).map(l => ({ id: l.id, name: ({ IMPORTANT: 'Important', SPAM: 'Spam', DRAFT: 'Drafts (Gmail)', CATEGORY_PERSONAL: 'Primary', CATEGORY_SOCIAL: 'Social', CATEGORY_PROMOTIONS: 'Promotions', CATEGORY_UPDATES: 'Updates', CATEGORY_FORUMS: 'Forums', CATEGORY_PURCHASES: 'Purchases' })[l.id] || l.name, kind: l.id === 'DRAFT' ? 'provider-drafts' : l.id.startsWith('CATEGORY_') ? 'category' : 'system-label', canRename: false, canDelete: false, canCreateChildren: false, canMoveMessages: l.id !== 'DRAFT' })),
      { id: '__all__', name: 'All Mail', kind: 'view', canMoveMessages: false },
      { id: '__snoozed__', name: 'Snoozed', kind: 'view', canMoveMessages: false },
      ...labels.some(l => l.id === 'CATEGORY_PURCHASES') ? [] : [{ id: '__purchases__', name: 'Purchases', kind: 'view', canMoveMessages: false }],
      ...userLabels.map(l => gmailLabel(l, l.name.includes('/') ? byName.get(l.name.slice(0, l.name.lastIndexOf('/'))) || null : null)),
    ];
  }
  if (account.provider === 'microsoft') {
    return microsoftFolders(userId, account);
  }
  return withImapMailbox(userId, account, 'INBOX', async client => imapFolderTree(client, await client.list()));
}

export async function mailList(userId, account, { folder, query = '', pageToken = '', max = 30 }) {
  max = Math.max(1, Math.min(50, Number(max) || 30));
  if (account.provider === 'gmail') {
    const read = await createGmailReader(userId, account.id);
    const view = Object.hasOwn(GMAIL_VIEWS, folder) ? GMAIL_VIEWS[folder] : '';
    const params = new URLSearchParams({ maxResults: String(max), q: [view, query && (view ? `(${query})` : query)].filter(Boolean).join(' ') });
    if (!view) params.set('labelIds', folder || 'INBOX');
    if (folder === 'TRASH' || folder === 'SPAM') params.set('includeSpamTrash', 'true');
    if (pageToken) params.set('pageToken', pageToken);
    const data = await read(`/messages?${params}`);
    const emails = [];
    const ids = data.messages || [];
    for (let index = 0; index < ids.length; index += 5) {
      const batch = await Promise.all(ids.slice(index, index + 5).map(async ({ id }) => {
        try {
          const item = gmailMessage(await read(`/messages/${enc(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`));
          delete item.html; delete item.text;
          return item;
        } catch (error) { if (error.status === 404) return null; throw error; }
      }));
      emails.push(...batch.filter(Boolean));
    }
    return { emails, nextPageToken: data.nextPageToken || null };
  }
  if (account.provider === 'microsoft') {
    const params = new URLSearchParams({ '$top': String(max), '$select': 'id,conversationId,from,toRecipients,subject,receivedDateTime,bodyPreview,isRead,flag,hasAttachments,parentFolderId' });
    if (query) params.set('$search', `"${String(query).replace(/"/g, '\\"')}"`);
    else params.set('$orderby', 'receivedDateTime desc');
    let endpoint = `/me/mailFolders/${enc(folder || 'inbox')}/messages?${params}`;
    if (pageToken) {
      const next = new URL(Buffer.from(pageToken, 'base64url').toString());
      if (next.origin !== 'https://graph.microsoft.com' || !next.pathname.startsWith('/v1.0/me/mailFolders/')) throw new Error('Invalid mailbox page.');
      endpoint = next.pathname.slice('/v1.0'.length) + next.search;
    }
    const data = await graph(userId, account, endpoint, { headers: query ? { ConsistencyLevel: 'eventual' } : {} });
    return { emails: (data.value || []).map(m => { const item = graphMessage(m); delete item.html; delete item.text; item.hasAttachments = m.hasAttachments; return item; }), nextPageToken: data['@odata.nextLink'] ? Buffer.from(data['@odata.nextLink']).toString('base64url') : null };
  }
  return withImapMailbox(userId, account, folder || 'INBOX', async client => {
    const upper = pageToken ? Number(pageToken) - 1 : Number(client.mailbox.uidNext) - 1;
    if (!Number.isSafeInteger(upper) || upper < 1) return { emails: [], nextPageToken: null };
    const uids = ((await client.search(buildImapInboxSearch(`1:${upper}`, query), { uid: true })) || []).sort((a, b) => b - a);
    const page = uids.slice(0, max), emails = [];
    if (page.length) for await (const message of client.fetch(page.join(','), { uid: true, envelope: true, flags: true }, { uid: true })) {
      const envelope = message.envelope || {};
      emails.push({ id: String(message.uid), from: addr(envelope.from), to: addr(envelope.to), subject: envelope.subject || '(No subject)', date: envelope.date?.toISOString() || '', snippet: '', unread: !message.flags.has('\\Seen'), starred: message.flags.has('\\Flagged'), attachments: [] });
    }
    emails.sort((a, b) => Number(b.id) - Number(a.id));
    return { emails, nextPageToken: uids.length > max ? String(page.at(-1)) : null };
  });
}

export async function mailRead(userId, account, { messageId, folder = 'INBOX' }) {
  if (account.provider === 'gmail') {
    const read = await createGmailReader(userId, account.id);
    const message = await read(`/messages/${enc(messageId)}?format=full`);
    const thread = message.threadId ? await read(`/threads/${enc(message.threadId)}?format=full`) : { messages: [message] };
    return { messages: (thread.messages || [message]).map(gmailMessage) };
  }
  if (account.provider === 'microsoft') {
    const message = await graph(userId, account, `/me/messages/${enc(messageId)}?$expand=attachments($select=id,name,contentType,size,isInline)`);
    // Read the full selected message; adjacent messages retain complete bodies.
    const conversation = String(message.conversationId || '').replace(/'/g, "''");
    if (!conversation) return { messages: [graphMessage(message)] };
    const thread = await graph(userId, account, `/me/messages?$filter=${enc(`conversationId eq '${conversation}'`)}&$top=100&$expand=attachments($select=id,name,contentType,size,isInline)`);
    return { messages: (thread.value || [message]).map(graphMessage).sort((a, b) => a.date.localeCompare(b.date)) };
  }
  return withImapMailbox(userId, account, folder, async client => {
    if (!/^\d+$/.test(String(messageId))) throw new Error('Invalid IMAP message ID.');
    const message = await client.fetchOne(messageId, { envelope: true, flags: true, bodyStructure: true, headers: ['references'] }, { uid: true });
    if (!message) throw new Error('This message is no longer available.');
    const parts = selectImapTextParts(message.bodyStructure);
    const selected = parts.html || parts.plain;
    let body = '';
    if (selected) {
      const result = await client.download(messageId, selected.part || '1', { uid: true, maxBytes: 4 * 1024 * 1024 });
      const chunks = []; let size = 0;
      for await (const chunk of result.content) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('Message body is too large.'); chunks.push(chunk); }
      // download() already decodes transfer encodings.
      body = decodeImapBodyPart(Buffer.concat(chunks), '', selected.charset);
    }
    const files = [];
    function visit(part) { if (!part) return; const name = part.dispositionParameters?.filename || part.parameters?.name; if (name) files.push({ id: part.part, name, type: part.type, size: part.size || 0 }); for (const child of part.childNodes || []) visit(child); }
    visit(message.bodyStructure);
    const e = message.envelope || {};
    return { messages: [{ id: String(messageId), from: addr(e.from), to: addr(e.to), cc: addr(e.cc), replyTo: addr(e.replyTo?.length ? e.replyTo : e.from), subject: e.subject || '(No subject)', date: e.date?.toISOString() || '', unread: !message.flags.has('\\Seen'), starred: message.flags.has('\\Flagged'), html: parts.html ? body : asHtml(body), text: parts.html ? '' : body, messageId: e.messageId || '', references: message.headers?.toString().match(/^references:\s*(.+)$/im)?.[1] || '', attachments: files }] };
  });
}

export async function mailAttachment(userId, account, { messageId, attachmentId, folder = 'INBOX' }) {
  if (account.provider === 'gmail') {
    const read = await createGmailReader(userId, account.id);
    const raw = await read(`/messages/${enc(messageId)}?format=full`);
    const file = gmailMessage(raw).attachments.find(a => a.id === attachmentId);
    if (!file) throw new Error('Attachment not found.');
    let body;
    if (attachmentId.startsWith('part:')) {
      function find(p) { return p.partId === attachmentId.slice(5) ? p : (p.parts || []).map(find).find(Boolean); }
      body = find(raw.payload)?.body;
    } else body = await read(`/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`);
    return { ...file, data: Buffer.from(body?.data || '', 'base64url') };
  }
  if (account.provider === 'microsoft') {
    const file = await graph(userId, account, `/me/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`);
    if (typeof file.contentBytes !== 'string') throw new Error('This attachment must be opened in your mail provider.');
    return { name: file.name, type: file.contentType, data: Buffer.from(file.contentBytes, 'base64') };
  }
  return withImapMailbox(userId, account, folder, async client => {
    if (!/^\d+$/.test(String(messageId)) || !/^\d+(\.\d+)*$/.test(attachmentId)) throw new Error('Invalid attachment.');
    const { meta, content } = await client.download(messageId, attachmentId, { uid: true });
    const chunks = []; let size = 0;
    for await (const chunk of content) { size += chunk.length; if (size > 25 * 1024 * 1024) { content.destroy(); throw new Error('Attachment is larger than 25 MB.'); } chunks.push(chunk); }
    return { name: meta.filename || 'attachment', type: meta.contentType, data: Buffer.concat(chunks) };
  });
}

export async function mailUpdate(userId, account, { messageIds, folder = 'INBOX', action, destination }) {
  const ids = [...new Set(messageIds || [])];
  if (!ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Select between 1 and 100 messages.');
  if (!['archive', 'trash', 'move', 'read', 'unread', 'star', 'unstar', 'restore'].includes(action)) throw new Error('Unsupported mailbox action.');
  if (action === 'move' && !destination) throw new Error('Choose a destination folder.');
  if (account.provider === 'gmail') {
    const addLabelIds = [], removeLabelIds = [];
    if (action === 'archive') removeLabelIds.push('INBOX');
    if (action === 'trash') { addLabelIds.push('TRASH'); removeLabelIds.push('INBOX'); }
    if (action === 'restore') { addLabelIds.push('INBOX'); removeLabelIds.push('TRASH'); }
    if (action === 'read') removeLabelIds.push('UNREAD');
    if (action === 'unread') addLabelIds.push('UNREAD');
    if (action === 'star') addLabelIds.push('STARRED');
    if (action === 'unstar') removeLabelIds.push('STARRED');
    if (action === 'move') { addLabelIds.push(destination); if (Object.hasOwn(GMAIL_VIEWS, folder)) removeLabelIds.push('INBOX'); else if (folder !== destination && !['SENT', 'STARRED'].includes(folder)) removeLabelIds.push(folder); }
    await gmailWrite(userId, account, '/messages/batchModify', { ids, addLabelIds, removeLabelIds });
    return { count: ids.length };
  }
  const completed = []; const errors = [];
  if (account.provider === 'microsoft') {
    for (const id of ids) {
      try {
        if (['archive', 'trash', 'move', 'restore'].includes(action)) {
          const destinationId = ({ archive: 'archive', trash: 'deleteditems', restore: 'inbox' })[action] || destination;
          await graph(userId, account, `/me/messages/${enc(id)}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId }) });
        } else await graph(userId, account, `/me/messages/${enc(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(['read', 'unread'].includes(action) ? { isRead: action === 'read' } : { flag: { flagStatus: action === 'star' ? 'flagged' : 'notFlagged' } }) });
        completed.push(id);
      } catch (e) { errors.push({ id, error: e.message }); }
    }
  } else await withImapMailbox(userId, account, folder, async client => {
    if (ids.some(id => !/^\d+$/.test(id))) throw new Error('Invalid IMAP message ID.');
    if (['read', 'unread', 'star', 'unstar'].includes(action)) {
      const flags = [action === 'read' || action === 'unread' ? '\\Seen' : '\\Flagged'];
      await client[['read', 'star'].includes(action) ? 'messageFlagsAdd' : 'messageFlagsRemove'](ids.join(','), flags, { uid: true });
    } else {
      const list = await client.list();
      const target = action === 'move' ? destination : action === 'restore' ? 'INBOX' : list.find(f => f.specialUse === (action === 'trash' ? '\\Trash' : '\\Archive'))?.path;
      if (!target || !list.some(f => f.path === target && !f.flags?.has('\\Noselect'))) throw new Error('This server has no destination folder for that action. Choose a folder with Move instead.');
      // Never EXPUNGE/delete: mail must remain recoverable in a real folder.
      await client.messageMove(ids.join(','), target, { uid: true });
    }
    completed.push(...ids);
  });
  return { count: completed.length, completed, errors };
}

export async function mailSend(userId, account, draft, attachments, markDispatchStarted) {
  if (account.provider === 'microsoft') {
    if (attachments.reduce((n, a) => n + a.data.length, 0) > 3 * 1024 * 1024) throw new Error('Microsoft attachments are limited to 3 MB in this version. Send larger files as links.');
    const recipients = value => addressparser(value || '', { flatten: true }).map(a => ({ emailAddress: { name: a.name || '', address: a.address } }));
    const message = { subject: draft.subject, body: { contentType: draft.html ? 'HTML' : 'Text', content: draft.html || draft.body }, toRecipients: recipients(draft.to), ccRecipients: recipients(draft.cc), bccRecipients: recipients(draft.bcc) };
    const files = attachments.map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.mimeType, contentBytes: a.data.toString('base64') }));
    const headers = { ...await getMsAuthHeader(userId, account.id), 'Content-Type': 'application/json' };
    if (draft.replyMessageId) {
      const reply = await request(`${GRAPH}/me/messages/${enc(draft.replyMessageId)}/createReply`, { method: 'POST', headers, body: '{}' });
      await request(`${GRAPH}/me/messages/${enc(reply.id)}`, { method: 'PATCH', headers, body: JSON.stringify(message) });
      for (const file of files) await request(`${GRAPH}/me/messages/${enc(reply.id)}/attachments`, { method: 'POST', headers, body: JSON.stringify(file) });
      markDispatchStarted();
      await request(`${GRAPH}/me/messages/${enc(reply.id)}/send`, { method: 'POST', headers });
    } else {
      if (files.length) message.attachments = files;
      markDispatchStarted();
      await request(`${GRAPH}/me/sendMail`, { method: 'POST', headers, body: JSON.stringify({ message }) });
    }
    return 'Message accepted by Microsoft for sending.';
  }
  let from = account.email || account.username || account.smtpFrom || '';
  if (account.provider === 'gmail') from = (await (await createGmailReader(userId, account.id))('/profile')).emailAddress;
  if (account.provider === 'imap') from = resolveSmtpFrom(account);
  const options = { ...(from ? { from } : {}), to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, text: draft.body, ...(draft.html ? { html: draft.html } : {}), inReplyTo: draft.inReplyTo || undefined, references: draft.references || undefined, attachments: attachments.map(a => ({ filename: a.filename, content: a.data, contentType: a.mimeType })), disableFileAccess: true, disableUrlAccess: true };
  if (account.provider === 'imap') {
    if (!account.smtpHost) throw new Error('Configure SMTP for this account before sending.');
    const transporter = nodemailer.createTransport({ host: account.smtpHost, port: account.smtpPort || 587, secure: account.smtpPort === 465, auth: { user: account.smtpUsername || account.username, pass: await decrypt(userId, account.encryptedPassword) } });
    markDispatchStarted();
    const result = await transporter.sendMail(options);
    let sentCopy = '';
    try {
      const compiled = new MailComposer({ ...options, messageId: result.messageId }).compile(); compiled.keepBcc = true;
      const raw = await compiled.build();
      sentCopy = await withImapMailbox(userId, account, 'INBOX', async client => {
        const sent = (await client.list()).find(folder => folder.specialUse === '\\Sent');
        if (!sent) return ' No Sent folder was advertised by this IMAP server.';
        await client.append(sent.path, raw, ['\\Seen']); return ' A copy was saved to Sent.';
      });
    } catch { sentCopy = ' The server accepted the email, but saving its Sent copy failed.'; }
    return `Message accepted by SMTP. Message ID: ${result.messageId}.${sentCopy}`;
  }
  const compiled = new MailComposer(options).compile();
  compiled.keepBcc = true;
  const raw = await compiled.build();
  const headers = await getGmailAuthHeader(userId, account.id);
  markDispatchStarted();
  if (account.provider === 'gmail') {
    const sent = await request(`${GMAIL}/messages/send`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: raw.toString('base64url'), ...(draft.threadId ? { threadId: draft.threadId } : {}) }) });
    return `Message sent. Message ID: ${sent.id}`;
  }
  throw new Error('Unsupported sending provider.');
}
