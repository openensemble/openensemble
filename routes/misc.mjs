/**
 * Misc routes: /api/notes, /api/history/:id, /api/tasks, /api/dashboard
 */

import fs from 'fs';
import path from 'path';
import {
  requireAuth, getAuthToken, getSessionUserId, getUser, getUserRole, isPrivileged,
  loadUsers, loadNotes, saveNotes, withLock, NOTES_PATH, readBody, safeId, BASE_DIR, getUserDir,
  broadcastToUsers, getUserSessions, revokeSessionByPrefix,
} from './_helpers.mjs';

const MESSAGES_PATH = path.join(BASE_DIR, 'messages.json');
function loadMessages() {
  try { return JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8')); } catch { return []; }
}
async function saveMessages(msgs) {
  await withLock(MESSAGES_PATH, () => fs.writeFileSync(MESSAGES_PATH, JSON.stringify(msgs, null, 2)));
}

const THREADS_PATH = path.join(BASE_DIR, 'threads.json');
function loadThreads() {
  try { return JSON.parse(fs.readFileSync(THREADS_PATH, 'utf8')); } catch { return []; }
}
async function saveThreads(threads) {
  await withLock(THREADS_PATH, () => fs.writeFileSync(THREADS_PATH, JSON.stringify(threads, null, 2)));
}
import { loadSession } from '../sessions.mjs';
import { loadTasks, addTask, removeTask, updateTask, scheduleNewTask } from '../scheduler.mjs';
import { interceptScheduling } from '../lib/scheduler-intent.mjs';
import { getMemoryStats } from '../memory.mjs';
import { getGmailAuthHeader } from './gmail.mjs';

async function getEmailUnreadCount(userId) {
  // Load user's email accounts
  const acctPath = path.join(getUserDir(userId), 'email-accounts.json');
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(acctPath, 'utf8')); } catch (_) {}
  const gmailAcct = accounts.find(a => a.provider === 'gmail');
  if (!gmailAcct) return null;
  try {
    const authHdr = await getGmailAuthHeader(userId, gmailAcct.id);
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX', { headers: authHdr });
    const data = await r.json();
    return data.messagesUnread ?? 0;
  } catch (_) { return null; }
}

export async function handle(req, res) {
  // ── Conversation search ──────────────────────────────────────────────────
  if (req.url.startsWith('/api/search') && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const params = new URL(req.url, 'http://x').searchParams;
    const q = (params.get('q') ?? '').trim().toLowerCase();
    if (!q || q.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query must be at least 2 characters' }));
      return true;
    }
    const sessDir = path.join(getUserDir(authId), 'sessions');
    const results = [];
    const MAX_RESULTS = 50;
    try {
      if (fs.existsSync(sessDir)) {
        for (const file of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))) {
          const agentLocalId = file.replace('.jsonl', '');
          const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').trim().split('\n').filter(Boolean);
          for (const line of lines) {
            if (results.length >= MAX_RESULTS) break;
            try {
              const msg = JSON.parse(line);
              const content = typeof msg.content === 'string' ? msg.content : '';
              if (content.toLowerCase().includes(q)) {
                results.push({ agent: agentLocalId, role: msg.role, content: content.slice(0, 300), ts: msg.ts });
              }
            } catch {}
          }
          if (results.length >= MAX_RESULTS) break;
        }
      }
    } catch (e) { console.warn('[search]', e.message); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results, total: results.length }));
    return true;
  }

  // ── Active session management ────────────────────────────────────────────
  if (req.url === '/api/sessions' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const currentToken = getAuthToken(req);
    // Node-agent tokens (kind: 'node') represent long-lived remote machine
    // registrations. They're managed by the Nodes UI; revoking one from the
    // Profile page would silently break the remote node. Hide them here.
    const sessions = getUserSessions(authId)
      .filter(s => s.kind !== 'node')
      .map(s => ({
        ...s,
        current: currentToken?.startsWith(s.tokenPrefix.replace('…', '')) ?? false,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return true;
  }

  if (req.url === '/api/sessions/revoke' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { tokenPrefix } = JSON.parse(await readBody(req));
      if (!tokenPrefix || tokenPrefix.length < 8) throw new Error('Invalid token prefix');
      const prefix = tokenPrefix.replace('…', '');
      // Prevent revoking your own current session
      const currentToken = getAuthToken(req);
      if (currentToken?.startsWith(prefix)) throw new Error('Cannot revoke your current session');
      const ok = revokeSessionByPrefix(authId, prefix);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'Session not found' }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Session history for an agent
  const histMatch = req.url.match(/^\/api\/history\/(\w+)$/);
  if (histMatch) {
    const authId = requireAuth(req, res); if (!authId) return true;
    const sessionId = `${authId}_${histMatch[1]}`;
    const messages = loadSession(sessionId, 60);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messages));
    return true;
  }

  // Tasks
  if (req.url === '/api/tasks' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const priv = isPrivileged(authId);
    res.end(JSON.stringify(loadTasks().filter(t => priv || t.ownerId === authId)));
    return true;
  }

  if (req.url === '/api/tasks' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    if (!isPrivileged(authId)) {
      const user = getUser(authId);
      if (Array.isArray(user?.allowedFeatures) && !user.allowedFeatures.includes('tasks')) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Task scheduling not enabled for your account' })); return true;
      }
    }
    try {
      const body = JSON.parse(await readBody(req));
      const { label, agent, cron, prompt, timezone, enabled } = body;
      // Per-user task cap — prevents a misbehaving account from scheduling
      // thousands of frequent-cron jobs that would swamp the scheduler.
      const MAX_TASKS_PER_USER = 100;
      const existing = loadTasks().filter(t => t.ownerId === authId).length;
      if (existing >= MAX_TASKS_PER_USER) {
        res.writeHead(429); res.end(JSON.stringify({ error: `Task limit reached (${MAX_TASKS_PER_USER}). Delete some before adding more.` })); return true;
      }
      const task = await addTask({ label, agent, cron, prompt, timezone, enabled, ownerId: authId });
      scheduleNewTask(task);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Natural-language task creation: form sends {agent, text}, plan model
  // turns it into a fully-shaped task. Same pipeline the chat path uses, but
  // forced past the regex filter since the user is explicitly in the create
  // form. Returns the new task on success, or {error} when parsing fails.
  if (req.url === '/api/tasks/parse' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    if (!isPrivileged(authId)) {
      const user = getUser(authId);
      if (Array.isArray(user?.allowedFeatures) && !user.allowedFeatures.includes('tasks')) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Task scheduling not enabled for your account' })); return true;
      }
    }
    try {
      const body = JSON.parse(await readBody(req));
      const text = String(body.text || '').trim();
      const agent = String(body.agent || '').trim();
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'Empty prompt' })); return true; }
      const MAX_TASKS_PER_USER = 100;
      const existing = loadTasks().filter(t => t.ownerId === authId).length;
      if (existing >= MAX_TASKS_PER_USER) {
        res.writeHead(429); res.end(JSON.stringify({ error: `Task limit reached (${MAX_TASKS_PER_USER}). Delete some before adding more.` })); return true;
      }
      const before = new Set(loadTasks().map(t => t.id));
      const result = await interceptScheduling({ userId: authId, agentId: agent || null, text, force: true });
      const created = loadTasks().find(t => !before.has(t.id) && t.ownerId === authId);
      if (created) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(created));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result?.outcome || 'Could not parse a schedule from that prompt. Try including a time, e.g. "in 5 minutes" or "every day at 9am".' }));
      }
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  const taskMatch = req.url.match(/^\/api\/tasks\/([\w-]+)$/);
  if (taskMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const t = loadTasks().find(t => t.id === taskMatch[1]);
    if (!t) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (t.ownerId && t.ownerId !== authId) { res.writeHead(403); res.end(JSON.stringify({ error: 'Not your task' })); return true; }
    await removeTask(taskMatch[1]);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    return true;
  }
  if (taskMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const t = loadTasks().find(t => t.id === taskMatch[1]);
    if (!t) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (t.ownerId && t.ownerId !== authId) { res.writeHead(403); res.end(JSON.stringify({ error: 'Not your task' })); return true; }
    try {
      const patch = JSON.parse(await readBody(req));
      await updateTask(taskMatch[1], patch);
      // Any field that affects firing needs the timer re-registered. For a
      // once-task that already ran, revising the datetime should also reopen
      // it — flip enabled and wipe lastRun unless the caller specified them.
      const touchesSchedule = 'datetime' in patch || 'time' in patch || 'cron' in patch;
      if (touchesSchedule && t.repeat === 'once' && t.lastRun && !('enabled' in patch)) {
        await updateTask(taskMatch[1], { enabled: true, lastRun: null });
      }
      if (touchesSchedule || 'enabled' in patch) {
        const updated = loadTasks().find(x => x.id === taskMatch[1]);
        if (updated) scheduleNewTask(updated);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Dashboard
  if (req.url === '/api/dashboard' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const priv = isPrivileged(authId);
    const tasks = loadTasks().filter(t => priv || t.ownerId === authId);
    const tasksWithOutput = tasks.map(task => {
      const sessionId = task.ownerId ? `${task.ownerId}_${task.agent}` : task.agent;
      const messages = loadSession(sessionId, 200);
      let lastOutput = null, lastRunTs = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].scheduled) {
          lastRunTs = messages[i].ts;
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role === 'assistant') { lastOutput = messages[j].content; break; }
          }
          break;
        }
      }
      return { ...task, lastOutput, lastRunTs };
    });
    const [memoryCount, emailUnread] = await Promise.all([
      getMemoryStats(authId).catch(() => 0),
      getEmailUnreadCount(authId).catch(() => null),
    ]);
    const messagesUnread = loadThreads()
      .filter(t => t.participants.includes(authId) &&
        (t.messages ?? []).some(m => m.from !== authId && !(m.readBy ?? []).includes(authId)))
      .length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: tasksWithOutput, memoryCount, emailUnread, messagesUnread }));
    return true;
  }

  // Notes — owner/admin share global file; user/child get per-user files
  function resolveNotesPath(userId) {
    const role = getUserRole(userId);
    if (role === 'owner' || role === 'admin') return NOTES_PATH;
    return path.join(getUserDir(userId), 'shared-notes.json');
  }
  function loadNotesForUser(userId) {
    const p = resolveNotesPath(userId);
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    return { content: '', updatedAt: null, updatedBy: null };
  }
  function saveNotesForUser(userId, notes) {
    fs.writeFileSync(resolveNotesPath(userId), JSON.stringify(notes, null, 2));
  }

  if (req.url === '/api/notes' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const notes = loadNotesForUser(authId);
    const updaterName = notes.updatedBy ? (loadUsers().find(u => u.id === notes.updatedBy)?.name ?? notes.updatedBy) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...notes, updatedByName: updaterName }));
    return true;
  }

  if (req.url === '/api/notes' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { content } = JSON.parse(await readBody(req));
      if (typeof content !== 'string') throw new Error('content required');
      if (content.length > 65536) throw new Error('Notes too large (max 64KB)');
      const notes = { content, updatedAt: new Date().toISOString(), updatedBy: authId };
      const notesPath = resolveNotesPath(authId);
      await withLock(notesPath, () => saveNotesForUser(authId, notes));
      const updaterName = loadUsers().find(u => u.id === authId)?.name ?? authId;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...notes, updatedByName: updaterName }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // ── Threads (iMessage-style conversations) ────────────────────────────────────
  const threadBase = req.url === '/api/threads';

  if (threadBase && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const users = loadUsers();
    const getName  = id => users.find(u => u.id === id)?.name  ?? id;
    const getEmoji = id => users.find(u => u.id === id)?.emoji ?? '🧑';
    const result = loadThreads()
      .filter(t => t.participants.includes(authId))
      .map(t => {
        const msgs = t.messages ?? [];
        const last = msgs[msgs.length - 1] ?? null;
        const unread = msgs.filter(m => m.from !== authId && !(m.readBy ?? []).includes(authId)).length;
        const others = t.participants.filter(id => id !== authId);
        return {
          id: t.id,
          participants: t.participants,
          name: t.name,
          displayName: t.name ?? (others.length === 1 ? getName(others[0]) : others.map(getName).join(', ')),
          displayEmoji: others.length === 1 ? getEmoji(others[0]) : '👥',
          isGroup: t.participants.length > 2,
          lastMessage: last ? { from: last.from, fromName: getName(last.from), content: last.content, sentAt: last.sentAt } : null,
          unread,
          createdAt: t.createdAt,
        };
      })
      .sort((a, b) => (b.lastMessage?.sentAt ?? b.createdAt).localeCompare(a.lastMessage?.sentAt ?? a.createdAt));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  if (threadBase && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { participants, name, message } = JSON.parse(await readBody(req));
      if (!Array.isArray(participants) || participants.length === 0) throw new Error('participants required');
      const users = loadUsers();
      const validIds = new Set(users.map(u => u.id));
      const others = [...new Set(participants)].filter(id => id !== authId && validIds.has(id));
      if (others.length === 0) throw new Error('No valid participants');
      const allP = [authId, ...others].sort();
      const threads = loadThreads();
      let thread;
      if (others.length === 1 && !name) {
        thread = threads.find(t => t.participants.length === 2 && allP.every(id => t.participants.includes(id)));
      }
      if (!thread) {
        thread = { id: `thread_${Date.now()}`, participants: allP, name: name?.trim() || null, createdAt: new Date().toISOString(), createdBy: authId, messages: [] };
        threads.push(thread);
      }
      if (message?.trim()) {
        thread.messages.push({ id: `tmsg_${Date.now()}`, from: authId, content: message.trim(), sentAt: new Date().toISOString(), readBy: [authId] });
      }
      await saveThreads(threads);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: thread.id }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  const threadMsgsMatch = req.url.match(/^\/api\/threads\/(thread_[\w]+)\/messages$/);
  if (threadMsgsMatch && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const threads = loadThreads();
    const t = threads.find(t => t.id === threadMsgsMatch[1]);
    if (!t) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (!t.participants.includes(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    const users = loadUsers();
    const getName = id => users.find(u => u.id === id)?.name ?? id;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify((t.messages ?? []).map(m => ({ ...m, fromName: getName(m.from), isMine: m.from === authId }))));
    return true;
  }

  if (threadMsgsMatch && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { content } = JSON.parse(await readBody(req));
      if (typeof content !== 'string' || !content.trim()) throw new Error('content required');
      if (content.length > 10240) throw new Error('Message too large');
      const threads = loadThreads();
      const idx = threads.findIndex(t => t.id === threadMsgsMatch[1]);
      if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
      if (!threads[idx].participants.includes(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
      const msg = { id: `tmsg_${Date.now()}`, from: authId, content: content.trim(), sentAt: new Date().toISOString(), readBy: [authId] };
      if (!threads[idx].messages) threads[idx].messages = [];
      threads[idx].messages.push(msg);
      await saveThreads(threads);
      const users = loadUsers();
      const fromName = users.find(u => u.id === authId)?.name ?? authId;
      const recipients = threads[idx].participants.filter(id => id !== authId);
      // Push to all other participants via WebSocket
      broadcastToUsers(recipients, {
        type: 'new_thread_message',
        threadId: threads[idx].id,
        message: { ...msg, fromName, isMine: false },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...msg, fromName, isMine: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  const threadDeleteMatch = req.url.match(/^\/api\/threads\/(thread_[\w]+)$/);
  if (threadDeleteMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const threads = loadThreads();
    const idx = threads.findIndex(t => t.id === threadDeleteMatch[1]);
    if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (!threads[idx].participants.includes(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    threads[idx].participants = threads[idx].participants.filter(id => id !== authId);
    if (threads[idx].participants.length === 0) {
      threads.splice(idx, 1);
    }
    await saveThreads(threads);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    return true;
  }

  const threadReadMatch = req.url.match(/^\/api\/threads\/(thread_[\w]+)\/read$/);
  if (threadReadMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const threads = loadThreads();
    const idx = threads.findIndex(t => t.id === threadReadMatch[1]);
    if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (!threads[idx].participants.includes(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    (threads[idx].messages ?? []).forEach(m => {
      if (!m.readBy) m.readBy = [];
      if (!m.readBy.includes(authId)) m.readBy.push(authId);
    });
    await saveThreads(threads);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    return true;
  }

  return false;
}
