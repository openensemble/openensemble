import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';
import { isChatId } from './project-context.mjs';
import { getProjectSpace } from './project-spaces.mjs';

export class ChatError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function directory(userId, create = false) {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(userId)) throw new ChatError(400, 'Invalid profile');
  const userDir = path.join(USERS_DIR, userId);
  const dir = path.join(userDir, 'saved-chats');
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(dir) && path.relative(fs.realpathSync(userDir), fs.realpathSync(dir)) !== 'saved-chats') {
    throw new ChatError(400, 'Invalid chat storage');
  }
  return dir;
}
function filePath(userId, id) {
  if (!isChatId(id)) throw new ChatError(404, 'Saved chat not found');
  const file = path.join(directory(userId), `${id}.json`);
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new ChatError(400, 'Invalid chat storage'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
export function getSavedChat(userId, id, projectId = null) {
  const file = filePath(userId, id);
  let chat;
  try { chat = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new ChatError(error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Saved chat not found' : 'Saved chat could not be read'); }
  if (chat.id !== id || chat.version !== 1) throw new ChatError(500, 'Invalid saved chat');
  if ((chat.projectId || null) !== (projectId || null)) throw new ChatError(404, 'Saved chat not found in this space');
  if (projectId) getProjectSpace(userId, projectId);
  return chat;
}
export function listSavedChats(userId, projectId = null) {
  if (projectId) getProjectSpace(userId, projectId);
  const dir = directory(userId);
  let files;
  try { files = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter(file => file.endsWith('.json') && isChatId(file.slice(0, -5)))
    .map(file => {
      // Read through the same path guard even for records in other spaces.
      const data = JSON.parse(fs.readFileSync(filePath(userId, file.slice(0, -5)), 'utf8'));
      return data.projectId === projectId ? getSavedChat(userId, data.id, projectId) : null;
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}
function nameText(value) {
  if (typeof value !== 'string' || value.length > 100) throw new ChatError(400, 'Chat name must be at most 100 characters');
  return value.trim();
}
export async function createSavedChat(userId, { name = '', projectId = null, agentId } = {}) {
  name = nameText(name);
  if (typeof agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new ChatError(400, 'Choose an agent to start a chat');
  if (projectId) getProjectSpace(userId, projectId);
  const dir = directory(userId, true);
  return withLock(dir, () => {
    const chat = { version: 1, id: `chat_${randomBytes(12).toString('hex')}`, projectId, agentId,
      name: name || 'New chat', autoName: !name, preview: '', createdAt: Date.now(), updatedAt: Date.now() };
    atomicWriteSync(filePath(userId, chat.id), JSON.stringify(chat), { mode: 0o600 });
    return chat;
  });
}
export async function renameSavedChat(userId, id, projectId, name) {
  name = nameText(name);
  if (!name) throw new ChatError(400, 'Give your chat a name');
  return withLock(filePath(userId, id), () => {
    const chat = getSavedChat(userId, id, projectId);
    Object.assign(chat, { name, autoName: false });
    atomicWriteSync(filePath(userId, id), JSON.stringify(chat), { mode: 0o600 });
    return chat;
  });
}
export async function deleteSavedChat(userId, id, projectId = null) {
  const file = filePath(userId, id);
  const { deleteSavedChatHistory } = await import('./saved-chat-deletion.mjs');
  return withLock(file, async () => {
    const chat = getSavedChat(userId, id, projectId);
    await deleteSavedChatHistory(userId, chat, () => fs.unlinkSync(file));
    return { ok: true, id };
  });
}
export async function touchSavedChat(userId, id, projectId, agentId, text) {
  if (!id) return;
  return withLock(filePath(userId, id), () => {
    const chat = getSavedChat(userId, id, projectId);
    const preview = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (chat.autoName && preview) { chat.name = preview.slice(0, 100); chat.autoName = false; }
    Object.assign(chat, { agentId, preview, updatedAt: Date.now() });
    atomicWriteSync(filePath(userId, id), JSON.stringify(chat), { mode: 0o600 });
    return chat;
  });
}
