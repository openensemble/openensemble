import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { USERS_DIR } from './paths.mjs';
import { projectMessageKey } from './project-message-key.mjs';
import { isChatId, isProjectId, chatIdFromSession, projectIdFromSession, withoutConversationSuffix } from './project-context.mjs';

const DEFAULT_LIMITS = { files: 1200, bytes: 32 * 1024 * 1024, sessionBytes: 2 * 1024 * 1024, textBytes: 256 * 1024, metadataBytes: 2 * 1024 * 1024, results: 50 };
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.jsonl', '.html', '.htm', '.xml', '.yaml', '.yml', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.css', '.log', '.sh', '.sql', '.svg']);
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const directoryFlags = readFlags | constants.O_DIRECTORY;
const descriptorPath = handle => `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${handle.fd}`;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const text = value => typeof value === 'string' ? value : '';
const timestamp = value => typeof value === 'number' ? value : Date.parse(value) || 0;
function unavailable() { return Object.assign(new Error('This search result is no longer available.'), { status: 404 }); }
function unsupportedFilesystem() {
  return Object.assign(new Error('Search is unavailable: this filesystem does not support secure directory-handle access.'), { status: 503, code: 'SEARCH_FILESYSTEM_UNAVAILABLE' });
}
function skippedSource(error, budget) {
  if (error?.code !== 'ENOENT' && error?.status !== 404) budget.truncated = true;
}
function snippet(content, query) {
  const at = content.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, at - 100);
  return `${start ? '…' : ''}${content.slice(start, start + 340)}${content.length > start + 340 ? '…' : ''}`;
}
function href(values) { return `/?${new URLSearchParams(Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== '')).toString()}`; }

// The index is ephemeral and scoped to one profile. Re-enumerate authorized
// sources on every query; deleted chats/files cannot linger in a stale index.
export function createWorkSearch({ usersDir = USERS_DIR, limits: overrides = {} } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const cache = new Map();
  let cacheBytes = 0;
  async function checkDescriptorAccess(directory) {
    let probe;
    try {
      probe = await fs.open(`${descriptorPath(directory)}/.`, directoryFlags);
      const [expected, actual] = await Promise.all([directory.stat(), probe.stat()]);
      if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw unsupportedFilesystem();
    } catch { throw unsupportedFilesystem(); }
    finally { await probe?.close(); }
  }
  async function scope(userId) {
    if (!validId(userId)) throw Object.assign(new Error('Invalid profile.'), { status: 400 });
    if (![constants.O_NOFOLLOW, constants.O_DIRECTORY, constants.O_NONBLOCK].every(value => Number.isInteger(value) && value > 0)) throw unsupportedFilesystem();
    let directory;
    try {
      // The configured users root may be a Docker storage link. Resolve that
      // trusted root, then pin every component and the exact profile directory.
      const absolute = await fs.realpath(usersDir), base = path.parse(absolute).root;
      directory = await fs.open(base, directoryFlags);
      await checkDescriptorAccess(directory);
      for (const part of [...absolute.slice(base.length).split(path.sep).filter(Boolean), userId]) {
        const next = await fs.open(`${descriptorPath(directory)}/${part}`, directoryFlags);
        await directory.close(); directory = next;
      }
      const stat = await directory.stat();
      return { handle: directory, key: `${path.resolve(usersDir, userId)}:${stat.dev}:${stat.ino}` };
    } catch (error) {
      await directory?.close();
      if (error.code === 'ENOENT') return { handle: null, key: path.resolve(usersDir, userId) };
      if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw unavailable();
      if (['ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(error.code)) throw unsupportedFilesystem();
      throw error;
    }
  }
  async function openBound(root, relative, directory = false) {
    const parts = relative.split('/');
    if (!root.handle || !parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part))) throw unavailable();
    let current = root.handle, owned = false;
    try {
      for (let index = 0; index < parts.length; index++) {
        const next = await fs.open(`${descriptorPath(current)}/${parts[index]}`, index < parts.length - 1 || directory ? directoryFlags : readFlags);
        if (owned) await current.close();
        current = next; owned = true;
      }
      return current;
    } catch (error) { if (owned) await current.close(); throw error; }
  }
  async function list(root, relative, budget) {
    let directory;
    try {
      directory = await openBound(root, relative, true);
      const entries = [];
      for await (const entry of await fs.opendir(descriptorPath(directory))) {
        if (++budget.entries > limits.files) { budget.truncated = true; break; }
        entries.push(entry);
      }
      return entries;
    }
    catch (error) { skippedSource(error, budget); return []; }
    finally { await directory?.close(); }
  }
  async function read(root, relative, budget, cap, tail = false) {
    if (++budget.files > limits.files || budget.bytes >= limits.bytes) { budget.truncated = true; return null; }
    let handle;
    try {
      handle = await openBound(root, relative);
      const stat = await handle.stat();
      if (!stat.isFile()) { budget.truncated = true; return null; }
      const size = Math.min(stat.size, cap, limits.bytes - budget.bytes);
      budget.bytes += size;
      if (size < stat.size) budget.truncated = true;
      const offset = tail ? Math.max(0, stat.size - size) : 0;
      const signature = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${offset}:${size}`;
      const key = `${root.key}/${relative}`;
      const old = cache.get(key);
      if (old?.signature === signature) { if (old.limited) budget.truncated = true; cache.delete(key); cache.set(key, old); return old.value; }
      const data = Buffer.alloc(size); const { bytesRead } = await handle.read(data, 0, size, offset);
      if (bytesRead < size) budget.truncated = true;
      let value = data.subarray(0, bytesRead).toString('utf8');
      if (tail && offset) value = value.slice(value.indexOf('\n') + 1);
      if (old) { cache.delete(key); cacheBytes -= old.bytes; }
      const bytes = value.length * 2;
      cache.set(key, { signature, value, bytes, limited: bytesRead < size }); cacheBytes += bytes;
      while (cacheBytes > 48 * 1024 * 1024 || cache.size > 2400) { const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first); }
      return value;
    } catch (error) { skippedSource(error, budget); return null; }
    finally { await handle?.close(); }
  }
  async function json(root, relative, budget) {
    const value = await read(root, relative, budget, limits.metadataBytes);
    try { return JSON.parse(value); } catch { budget.truncated = true; return null; }
  }
  async function catalog(userId, agents, budget) {
    const root = await scope(userId), projects = new Map(), chats = new Map();
    const available = new Map((Array.isArray(agents) ? agents : []).filter(a => validId(a.id)).map(a => [a.id, a]));
    for (const file of await list(root, 'project-spaces', budget)) {
      if (!file.isFile() || !file.name.endsWith('.json') || !isProjectId(file.name.slice(0, -5))) continue;
      const project = await json(root, `project-spaces/${file.name}`, budget);
      if (project?.id === file.name.slice(0, -5) && project.version === 1) projects.set(project.id, project);
    }
    for (const file of await list(root, 'saved-chats', budget)) {
      if (!file.isFile() || !file.name.endsWith('.json') || !isChatId(file.name.slice(0, -5))) continue;
      const chat = await json(root, `saved-chats/${file.name}`, budget);
      if (chat?.id === file.name.slice(0, -5) && chat.version === 1 && (!chat.projectId || projects.has(chat.projectId))) chats.set(chat.id, chat);
    }
    return { root, projects, chats, available };
  }
  function conversation(name, state) {
    const agent = withoutConversationSuffix(name), projectId = projectIdFromSession(name), chatId = chatIdFromSession(name);
    if (!state.available.has(agent) || (projectId && !state.projects.has(projectId)) || (chatId && (!state.chats.has(chatId) || (state.chats.get(chatId).projectId || null) !== projectId))) return null;
    if (`${agent}${chatId ? `__${chatId}` : ''}${projectId ? `__${projectId}` : ''}` !== name) return null;
    return { agent, agentId: agent, agentName: state.available.get(agent).name || agent, projectId, chatId,
      projectName: state.projects.get(projectId)?.name || '', chatName: state.chats.get(chatId)?.name || 'Original chat' };
  }
  function rows(raw) {
    return text(raw).split('\n').flatMap(line => {
      if (line.length > 1000000) return [];
      try { const row = JSON.parse(line); return !row.hidden && ['user', 'assistant'].includes(row.role) && typeof row.content === 'string' ? [row] : []; }
      catch { return []; }
    });
  }
  function messageResult(row, context) {
    const messageKey = projectMessageKey(row);
    return { kind: 'message', ...context, messageKey, role: row.role, ts: timestamp(row.ts), title: `${context.projectName || 'General'} · ${context.chatName} · ${context.agentName}`,
      content: row.content, url: href({ project: context.projectId, chat: context.chatId, agent: context.agent, searchMessage: messageKey }) };
  }
  function outputResult(item, project) {
    return { kind: 'output', outputId: item.id, projectId: project.id, projectName: project.name, title: item.title || 'Saved result', content: text(item.content), role: item.kind, ts: timestamp(item.savedAt),
      source: item.source || null, url: href({ project: project.id, searchOutput: item.id }) };
  }
  async function fileEntries(state, budget) {
    const files = [];
    for (const [kind, index] of [['documents', 'docs-index.json'], ['research', 'index.json']]) {
      const entries = await json(state.root, `${kind}/${index}`, budget);
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (++budget.entries > limits.files) { budget.truncated = true; break; }
        if (!validId(entry.id)) continue;
        const storedName = kind === 'documents' ? entry.id + (entry.ext || '') : entry.filename;
        if (!storedName || path.basename(storedName) !== storedName || storedName.includes('\\')) continue;
        files.push({ kind: 'file', fileId: `${kind}:${entry.id}`, documentId: entry.id, filename: entry.title || entry.filename || entry.id, title: entry.title || entry.filename || entry.id,
          source: kind === 'research' ? 'research' : '', mimeType: entry.mimeType || (kind === 'research' ? 'text/markdown' : 'application/octet-stream'), ts: timestamp(entry.createdAt || entry.date),
          content: text(entry.description), relative: `${kind}/${storedName}`, textFile: TEXT_EXTENSIONS.has(path.extname(storedName).toLowerCase()) });
      }
    }
    for (const kind of ['images', 'videos', 'audio']) for (const entry of await list(state.root, kind, budget)) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      files.push({ kind: 'file', fileId: `${kind}:${entry.name}`, documentId: `${kind === 'images' ? 'ai_img_' : kind === 'videos' ? 'ai_vid_' : 'audio_'}${entry.name}`,
        filename: entry.name, title: entry.name, source: kind === 'images' ? 'ai-image' : kind === 'videos' ? 'ai-video' : 'audio', mimeType: `${kind === 'images' ? 'image' : kind === 'videos' ? 'video' : 'audio'}/${path.extname(entry.name).slice(1) || '*'}`, content: '', relative: `${kind}/${entry.name}` });
    }
    return files;
  }
  async function fileResult(entry, state, budget, includeText) {
    let file;
    try { file = await openBound(state.root, entry.relative); const stat = await file.stat(); if (!stat.isFile()) { budget.truncated = true; return null; } entry.ts ||= stat.mtimeMs; }
    catch (error) { skippedSource(error, budget); return null; }
    finally { await file?.close(); }
    const content = includeText && entry.textFile ? await read(state.root, entry.relative, budget, limits.textBytes) : '';
    const projects = [...state.projects.values()].filter(p => p.files?.some(f => f.fileId === entry.fileId)).map(p => ({ id: p.id, name: p.name }));
    const { relative, textFile, ...result } = entry;
    return { ...result, projects, content: `${entry.content}${content ? `\n${content}` : ''}`, url: href({ searchFile: entry.fileId }) };
  }
  async function search(userId, query, agents, { kind = 'all', limit = limits.results } = {}) {
    query = text(query).trim();
    if (query.length < 2 || query.length > 200) throw Object.assign(new Error('Search for 2–200 characters.'), { status: 400 });
    if (!['all', 'message', 'file', 'output'].includes(kind)) throw Object.assign(new Error('Invalid search category.'), { status: 400 });
    const budget = { files: 0, entries: 0, bytes: 0, truncated: false }, state = await catalog(userId, agents, budget), found = [];
    try {
      const match = value => value.toLowerCase().includes(query.toLowerCase());
      if (kind === 'all' || kind === 'message') {
        const files = (await list(state.root, 'sessions', budget)).filter(f => f.isFile() && f.name.endsWith('.jsonl')).sort((a, b) => a.name.localeCompare(b.name));
        for (const file of files) {
          const context = conversation(file.name.slice(0, -6), state); if (!context) continue;
          const raw = await read(state.root, `sessions/${file.name}`, budget, limits.sessionBytes, true);
          for (const row of rows(raw)) if (match(row.content)) found.push(messageResult(row, context));
        }
      }
      if (kind === 'all' || kind === 'output') for (const project of state.projects.values()) for (const item of Array.isArray(project.savedItems) ? project.savedItems : []) {
        if (!/^item_[a-f0-9]{24}$/.test(item.id || '')) continue;
        if (match(`${text(item.title)}\n${text(item.content)}`)) found.push(outputResult(item, project));
      }
      if (kind === 'all' || kind === 'file') for (const entry of await fileEntries(state, budget)) {
        const result = await fileResult(entry, state, budget, true);
        if (result && match(`${result.title}\n${result.content}`)) found.push(result);
      }
      found.sort((a, b) => Number(match(b.title)) - Number(match(a.title)) || b.ts - a.ts);
      const results = found.slice(0, Math.max(1, Math.min(limits.results, Number(limit) || limits.results))).map(result => ({ ...result, content: snippet(result.content || result.title, query) }));
      return { results, total: found.length, truncated: budget.truncated || results.length < found.length, coverage: { files: Math.min(budget.files, limits.files), bytes: budget.bytes, limited: budget.truncated }, query };
    } finally { await state.root.handle?.close(); }
  }
  async function item(userId, args, agents) {
    const budget = { files: 0, entries: 0, bytes: 0, truncated: false }, state = await catalog(userId, agents, budget);
    try {
      if (args.kind === 'message') {
        const name = `${args.agent || ''}${args.chat ? `__${args.chat}` : ''}${args.project ? `__${args.project}` : ''}`;
        const context = conversation(name, state); if (!context || !/^[a-f0-9]{32}$/.test(args.key || '')) throw unavailable();
        const messages = rows(await read(state.root, `sessions/${name}.jsonl`, budget, limits.sessionBytes, true));
        const index = messages.findIndex(row => projectMessageKey(row) === args.key); if (index < 0) throw unavailable();
        return { ...messageResult(messages[index], context), context: messages.slice(Math.max(0, index - 2), index + 3).map(row => ({role:row.role,content:row.content.slice(0,200000),ts:row.ts,messageKey:projectMessageKey(row)})) };
      }
      if (args.kind === 'output') {
        const project = state.projects.get(args.project), saved = project?.savedItems?.find(value => value.id === args.id);
        if (!saved) throw unavailable(); return outputResult(saved, project);
      }
      if (args.kind === 'file') {
        const entry = (await fileEntries(state, budget)).find(value => value.fileId === args.fileId);
        if (!entry) throw unavailable(); const result = await fileResult(entry, state, budget, false); if (!result) throw unavailable(); return result;
      }
      throw unavailable();
    } finally { await state.root.handle?.close(); }
  }
  return { search, item };
}
const service = createWorkSearch();
export const searchWork = service.search;
export const readSearchItem = service.item;
