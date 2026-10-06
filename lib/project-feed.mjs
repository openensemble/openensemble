import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';
import { isProjectId, isChatId, withoutConversationSuffix } from './project-context.mjs';
import { parseDocumentMutationResult } from './document-artifacts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const projectThreadKey = (agentId, chatId) => `${agentId}:${chatId || ''}`;

// Separate from editable notes: activity never invalidates a user's draft.
function feedPath(userId, projectId) {
  if (!/^user_[a-zA-Z0-9]+$/.test(userId || '') || !isProjectId(projectId)) throw new Error('Invalid project activity scope');
  const userDir = path.join(USERS_DIR, userId);
  const spaces = path.join(userDir, 'project-spaces');
  const dir = path.join(spaces, projectId);
  const file = path.join(dir, 'activity.json');
  for (const entry of [userDir, spaces, path.join(spaces, `${projectId}.json`), dir, file]) {
    try { if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('Invalid project activity storage'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const project = JSON.parse(fs.readFileSync(path.join(spaces, `${projectId}.json`), 'utf8'));
  if (project.id !== projectId) throw new Error('Invalid project activity scope');
  return file;
}
function read(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || !state.threads || !Array.isArray(state.notices) || !Array.isArray(state.outputs)) throw new Error('Invalid project activity');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, threads: {}, notices: [], outputs: [] };
    throw error;
  }
}
export function readProjectFeed(userId, projectId) { return read(feedPath(userId, projectId)); }
async function change(userId, projectId, fn) {
  const file = feedPath(userId, projectId);
  return withLock(file, () => {
    // Revalidate after waiting, so deletion cannot resurrect a project.
    feedPath(userId, projectId);
    const state = read(file);
    if (fn(state) === false) return state;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteSync(file, JSON.stringify(state), { mode: 0o600 });
    return state;
  });
}

export function safeProjectOutputUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\\]/.test(value)) return null;
  if (/^\/(?!\/)/.test(value) && !/[?&](?:token|auth|key)=/i.test(value)) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function projectOutputsFromMessage(row) {
  if (!row || row.hidden) return [];
  const outputs = [];
  const document = row.documentArtifact;
  if (document?.docId || document?.id) {
    const id = document.docId || document.id;
    if (/^(?:research:)?doc_[A-Za-z0-9_-]+$/.test(id)) outputs.push({ kind: 'document', name: document.filename || 'Document',
      fileId: `${document.source === 'research' || id.startsWith('research:') ? 'research' : 'documents'}:${id.replace(/^research:/, '')}`, version: document.version || null });
  }
  for (const kind of ['image', 'video']) {
    const media = row[kind] || (row.type === kind ? row : null);
    if (media?.filename && /^[^/\\\u0000]+$/.test(media.filename) && media.filename !== '..') {
      outputs.push({ kind, name: media.filename, fileId: `${kind === 'image' ? 'images' : 'videos'}:${media.filename}` });
    }
  }
  for (const tool of row.toolResults || []) {
    const mutation = parseDocumentMutationResult(tool.name, tool.text);
    if (mutation) outputs.push(...projectOutputsFromMessage({ documentArtifact: mutation }));
  }
  return outputs;
}

const events = new Set(['turn_accepted', 'done', 'error', 'permission_request', 'credential_prompt', 'credential_resolved',
  'approval_pending', 'approval_resolved', 'agent_report', 'assistant_notification', 'image', 'video', 'tool_result', 'session_cleared', 'status']);

// Called only with outward, conversation-scoped events. Never persist tokens,
// tool arguments, credential values, or private worker context here.
export async function recordProjectEvent(userId, event) {
  if (!event || !events.has(event.type) || !isProjectId(event.projectId) || event.hidden || event.silent) return;
  const taskStatus = event.type === 'status' && event.kind === 'task_proxy' ? event.state?.status || event.state?.phase || (event.stuck ? 'stuck' : '') : null;
  if (event.type === 'status' && !['paused', 'stuck', 'running', 'done', 'error', 'cancelled'].includes(taskStatus)) return;
  const agentId = withoutConversationSuffix(String(event.agent || '')).replace(new RegExp(`^${userId}_`), '');
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(agentId)) return;
  const chatId = event.chatId || null;
  if (chatId && !isChatId(chatId)) return;
  const mutation = event.type === 'tool_result' ? parseDocumentMutationResult(event.name, event.text) : null;
  if (event.type === 'tool_result' && !mutation) return;
  const outputs = projectOutputsFromMessage(mutation ? { documentArtifact: mutation } : event);
  return change(userId, event.projectId, state => {
    if (chatId) {
      const file = path.join(USERS_DIR, userId, 'saved-chats', `${chatId}.json`);
      if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return false;
      const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (chat.projectId !== event.projectId) return false;
    }
    const key = projectThreadKey(agentId, chatId);
    if (event.type === 'session_cleared') {
      delete state.threads[key];
      state.notices = state.notices.filter(item => item.agentId !== agentId || item.chatId !== chatId);
      return;
    }
    const previous = state.threads[key] || {};
    if (taskStatus) {
      const taskId = event.watcherId || event.state?.taskId;
      if (!taskId) return false;
      const waiting = ['paused', 'stuck'].includes(taskStatus);
      const pending = { ...(previous.pending || {}) };
      if (waiting && pending[taskId] === 'task') return false;
      if (!waiting && pending[taskId] !== 'task') return false;
      if (waiting) pending[taskId] = 'task'; else delete pending[taskId];
      const now = Date.now();
      state.threads[key] = { ...previous, agentId, chatId, pending, updatedAt: now,
        status: Object.keys(pending).length ? 'waiting' : previous.terminalStatus || 'working' };
      if (waiting) state.notices = [...state.notices, { id: hash(`${taskId}:${now}`), agentId, chatId, status: 'waiting', kind: 'work', ts: now, read: false }].slice(-200);
      return;
    }
    const report = ['agent_report', 'assistant_notification'].includes(event.type);
    const turnId = report ? previous.turnId || null : event.turn_id || event.turnId || previous.turnId || null;
    if (previous.turnId && turnId !== previous.turnId && event.type !== 'turn_accepted' && event.type !== 'agent_report') return false;
    if (!report && turnId === previous.turnId && Number.isFinite(event.seq) && event.seq <= (previous.seq || 0)) return false;
    const fingerprint = hash(JSON.stringify([turnId, event.type, event.opId, event.credentialId, event.reportId || event.notification_id, outputs]));
    if ((previous.events || []).includes(fingerprint)) return false;
    const now = Date.now();
    const thread = { ...previous, agentId, chatId, updatedAt: now, turnId, seq: Number.isFinite(event.seq) ? event.seq : previous.seq || 0,
      events: [...(previous.events || []).slice(-39), fingerprint], pending: { ...(previous.pending || {}) } };
    if (event.type === 'turn_accepted') {
      thread.status = 'working'; thread.pending = {}; thread.terminalStatus = null;
    }
    const promptId = event.opId || event.credentialId || event.kind || 'permission';
    if (['credential_prompt', 'approval_pending'].includes(event.type)) thread.pending[promptId] = event.type;
    if (['credential_resolved', 'approval_resolved'].includes(event.type)) delete thread.pending[promptId];
    if (event.type === 'done' || report) thread.terminalStatus = /error|failed/.test(event.status || '') ? 'failed' : /cancel/.test(event.status || '') ? 'stopped' : 'finished';
    if (event.type === 'error') thread.terminalStatus = /cancel|abort|stop/i.test(event.code || '') ? 'stopped' : 'failed';
    thread.status = Object.keys(thread.pending).length ? 'waiting' : thread.terminalStatus || 'working';
    if (event.type === 'permission_request') thread.status = 'waiting';
    state.threads[key] = thread;
    if (['done', 'error', 'agent_report', 'assistant_notification', 'permission_request', 'credential_prompt', 'approval_pending'].includes(event.type)) {
      const status = thread.status;
      state.notices = [...state.notices, { id: fingerprint, agentId, chatId, turnId, status, kind: report ? 'work' : 'reply', ts: now, read: false }].slice(-200);
    }
    for (const output of outputs) {
      const id = hash(JSON.stringify([key, turnId, output]));
      if (!state.outputs.some(item => item.id === id)) state.outputs.push({ ...output, id, agentId, chatId, turnId, ts: now });
    }
    state.outputs = state.outputs.slice(-500);
  });
}

export function markProjectRead(userId, projectId, { ids = [], agentId, chatId = null, through = 0 } = {}) {
  if (!Array.isArray(ids) || ids.length > 200 || !Number.isFinite(through)) throw new Error('Invalid activity receipt');
  return change(userId, projectId, state => {
    let changed = false;
    for (const notice of state.notices) {
      if (!notice.read && (ids.includes(notice.id) || (agentId && notice.agentId === agentId && notice.chatId === chatId && notice.ts <= through))) {
        notice.read = true; changed = true;
      }
    }
    return changed;
  });
}

export function forgetProjectChat(userId, projectId, chatId) {
  if (!projectId) return;
  return change(userId, projectId, state => {
    state.threads = Object.fromEntries(Object.entries(state.threads).filter(([, item]) => item.chatId !== chatId));
    state.notices = state.notices.filter(item => item.chatId !== chatId);
    state.outputs = state.outputs.filter(item => item.chatId !== chatId);
  });
}
