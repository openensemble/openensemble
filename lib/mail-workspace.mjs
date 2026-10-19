import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { getUserDir } from '../routes/_helpers/paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { withFileLock } from './file-lock.mjs';
import { sendToUser } from '../routes/_helpers/broadcast.mjs';
import { loadEmailAttachments, attachmentResolutionError } from './email-attachments.mjs';
import { mailFolders, mailManageFolder, mailList, mailRead, mailUpdate, mailSend, mailAttachment, mailAccountAddress } from './mail-workspace-provider.mjs';

export class MailWorkspaceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function fail(condition, message, status) { if (!condition) throw new MailWorkspaceError(message, status); }
const string = (value, max = 1000) => String(value ?? '').slice(0, max);
const safeHeader = value => string(value, 2000).replace(/[\r\n\0]/g, ' ');
const uiAction = new AsyncLocalStorage();
export const withMailUiAction = fn => uiAction.run(true, fn);
export const isMailUiAction = () => uiAction.getStore() === true;

export function workspaceAccount(userId, accountId) {
  let accounts;
  try { accounts = JSON.parse(fs.readFileSync(path.join(getUserDir(userId), 'email-accounts.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') accounts = []; else throw error; }
  const account = accounts.find(a => a.id === accountId || a.label?.toLowerCase() === String(accountId).toLowerCase());
  fail(account, 'Choose a connected email account.', 404);
  fail(['gmail', 'microsoft', 'imap'].includes(account.provider), 'Unsupported email provider.');
  return account;
}

function storage(userId) { return path.join(getUserDir(userId), 'mail-workspace.json'); }
function readStore(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, drafts: [] }; throw error; }
}
function writeStore(file, store) { atomicWriteSync(file, JSON.stringify(store), { mode: 0o600 }); }

export function validateRecipients(draft) {
  const parsed = [];
  for (const field of ['to', 'cc', 'bcc']) {
    const value = String(draft[field] || '');
    fail(!/[\r\n\0]/.test(value), `Invalid ${field} address.`);
    for (const address of addressparser(value, { flatten: true })) {
      fail(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address.address || ''), `Check the email addresses in ${field}.`);
      parsed.push(address.address);
    }
  }
  fail(parsed.length > 0 && parsed.length <= 100, 'Add between 1 and 100 recipients.');
}

export function normalizeDraft(input, existing, accountId) {
  fail(input && typeof input === 'object' && !Array.isArray(input), 'Draft fields are required.');
  const next = { ...existing, id: existing?.id || `draft_${randomBytes(16).toString('hex')}`, accountId, version: (existing?.version || 0) + 1, status: 'draft', updatedAt: new Date().toISOString() };
  for (const key of ['to', 'cc', 'bcc', 'subject', 'inReplyTo', 'references', 'threadId', 'replyMessageId']) next[key] = input[key] === undefined ? existing?.[key] || '' : safeHeader(input[key]);
  for (const key of ['body', 'html']) {
    fail(input[key] === undefined || (typeof input[key] === 'string' && input[key].length <= 200000), 'This message is too large for the editor. Attach it as a document instead.');
    next[key] = input[key] === undefined ? existing?.[key] || '' : input[key];
  }
  if (input.body !== undefined && input.html === undefined) next.html = '';
  const files = input.attachments ?? existing?.attachments ?? [];
  fail(Array.isArray(files) && files.length <= 15, 'Attach up to 15 files.');
  next.attachments = files.map(file => {
    fail(file && typeof file === 'object', 'Invalid attachment.');
    if (file.fileId) return { fileId: string(file.fileId, 1000), name: string(file.name, 200) };
    fail(file.source?.accountId === accountId && file.source.messageId && file.source.attachmentId, 'Forwarded attachments must belong to the sending account.');
    return { name: string(file.name, 200), source: { accountId, messageId: string(file.source.messageId, 2000), attachmentId: string(file.source.attachmentId, 2000), folder: string(file.source.folder, 1000) } };
  });
  return next;
}

export async function workspaceAction(userId, args = {}) {
  const result = await performWorkspaceAction(userId, args);
  if (['save_draft', 'delete_draft', 'send_draft', 'update', 'create_folder', 'rename_folder', 'create_label', 'update_label', 'delete_label'].includes(args.operation)) {
    const requested = [...new Set(args.messageIds || [])];
    const messageIds = result.completed || (result.count === requested.length ? requested : []);
    sendToUser(userId, { type: 'mail_changed', operation: args.operation, account: result.accountId || args.account || result.draft?.accountId || null, draftId: result.draft?.id || args.draftId || null, ...(args.operation === 'update' ? { action: args.action, messageIds, messageFolder: args.folder || 'INBOX' } : {}), ...(result.folder ? { folder: result.folder, renamedFolders: result.renamedFolders || [] } : {}), ...(result.updatedFolders ? { updatedFolders: result.updatedFolders } : {}), ...(result.deletedFolderIds ? { deletedFolderIds: result.deletedFolderIds } : {}) });
  }
  return result;
}

async function performWorkspaceAction(userId, args = {}) {
  const operation = args.operation;
  const file = storage(userId);
  if (operation === 'list_drafts') return { drafts: readStore(file).drafts.filter(d => d.status !== 'sent' && (!args.account || d.accountId === args.account)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  if (['save_draft', 'delete_draft', 'send_draft'].includes(operation)) {
    return withFileLock(`${file}.lock`, async () => {
      const store = readStore(file);
      const existing = args.draftId ? store.drafts.find(d => d.id === args.draftId) : null;
      if (args.draftId) fail(existing, 'This draft is no longer available.', 404);
      if (operation === 'send_draft' && existing?.status === 'sent') return { sent: true, result: existing.result, duplicate: true };
      if (existing) {
        fail(existing.status === 'draft', 'This send may already have reached the provider. Check Sent before composing another message.', 409);
        fail(args.version === existing.version, 'This draft changed elsewhere. Reopen it to load the latest version.', 409);
      }
      if (operation === 'save_draft') {
        const account = workspaceAccount(userId, args.account || existing?.accountId);
        fail(!existing || existing.accountId === account.id || !existing.inReplyTo, 'Replies must use the original sending account.');
        fail(existing || store.drafts.filter(d => d.status !== 'sent').length < 200, 'You have 200 saved drafts. Discard a draft before creating another.');
        const draft = normalizeDraft(args.draft, existing, account.id);
        store.drafts = store.drafts.filter(d => d.id !== draft.id).concat(draft);
        writeStore(file, store);
        return { draft };
      }
      fail(existing, 'Choose a saved draft.');
      if (operation === 'delete_draft') {
        store.drafts = store.drafts.filter(d => d.id !== existing.id);
        writeStore(file, store);
        return { deleted: true };
      }
      const account = workspaceAccount(userId, existing.accountId);
      validateRecipients(existing);
      fail(existing.body.trim() || existing.html.trim() || existing.attachments.length, 'Write a message or attach a file.');
      const docIds = existing.attachments.filter(a => a.fileId).map(a => a.fileId);
      const { attachments, errors } = loadEmailAttachments(docIds, userId);
      const attachmentError = attachmentResolutionError(docIds, errors);
      fail(!attachmentError, attachmentError);
      for (const attachment of existing.attachments.filter(a => a.source)) {
        const value = await mailAttachment(userId, account, attachment.source);
        attachments.push({ filename: value.name, mimeType: value.type || 'application/octet-stream', data: value.data });
      }
      fail(attachments.reduce((n, a) => n + a.data.length, 0) <= 20 * 1024 * 1024, 'Attachments exceed 20 MB. Send fewer files.');
      let dispatched = false;
      try {
        const result = await mailSend(userId, account, existing, attachments, () => {
          // Persist before network dispatch. A crash or ambiguous timeout cannot
          // turn a retry into a second real email.
          existing.status = 'sending'; writeStore(file, store); dispatched = true;
        });
        existing.status = 'sent'; existing.result = result; existing.sentAt = new Date().toISOString();
        store.drafts = store.drafts.filter(d => d.status !== 'sent' || Date.now() - Date.parse(d.sentAt) < 30 * 86400000);
        writeStore(file, store);
        return { sent: true, result };
      } catch (error) {
        if (dispatched) { existing.status = 'uncertain'; writeStore(file, store); throw new MailWorkspaceError('The provider did not confirm the send. Check Sent before trying again; this draft is protected against duplicate sending.', 409); }
        throw error;
      }
    }, { timeoutMs: 120000 });
  }
  const account = workspaceAccount(userId, args.account);
  if (operation === 'folders') {
    const [folders, address] = await Promise.all([mailFolders(userId, account), mailAccountAddress(userId, account).catch(() => '')]);
    return { folders, address };
  }
  if (operation === 'list') return mailList(userId, account, args);
  if (['create_folder', 'rename_folder', 'create_label', 'update_label', 'delete_label'].includes(operation)) {
    const manage = async () => ({ ...await mailManageFolder(userId, account, args), accountId: account.id });
    if (account.provider !== 'imap' || operation !== 'rename_folder') return manage();
    // Saved forwards refer to IMAP attachment sources by mailbox path. Keep
    // those references in step with RENAME, serialized against draft sends.
    return withFileLock(`${file}.lock`, async () => {
      const store = readStore(file), result = await manage();
      const renamed = new Map((result.renamedFolders || []).map(f => [f.oldId, f.id]));
      let changed = false;
      for (const draft of store.drafts) {
        if (draft.status !== 'draft') continue;
        let edited = false;
        for (const attachment of draft.attachments || []) {
          if (attachment.source?.accountId === account.id && renamed.has(attachment.source.folder)) {
            attachment.source.folder = renamed.get(attachment.source.folder); edited = true;
          }
        }
        if (edited) { draft.version++; draft.updatedAt = new Date().toISOString(); changed = true; }
      }
      if (changed) {
        try { writeStore(file, store); }
        catch { result.warning = [result.warning, 'Folder renamed, but saved forward attachments could not be updated. Reattach them before sending.'].filter(Boolean).join(' '); }
      }
      return result;
    }, { timeoutMs: 120000 });
  }
  if (operation === 'read') { fail(typeof args.messageId === 'string' && args.messageId, 'Choose a message.'); return mailRead(userId, account, args); }
  if (operation === 'update') return { ...await mailUpdate(userId, account, args), accountId: account.id };
  throw new MailWorkspaceError('Unknown Mail workspace operation.');
}
