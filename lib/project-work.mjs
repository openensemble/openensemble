import { createHash } from 'node:crypto';
import { getProjectSpace, listProjectSpaces, ProjectError, projectTaskConflicts } from './project-spaces.mjs';
import { getSavedChat, listSavedChats } from './saved-chats.mjs';
import { projectContext, projectSessionKey, projectIdFromSession, chatIdFromSession, withoutConversationSuffix } from './project-context.mjs';
import { loadSession, hasSession } from '../sessions.mjs';
import { readProjectFeed, projectThreadKey, projectOutputsFromMessage, safeProjectOutputUrl } from './project-feed.mjs';

export const projectMessageKey = row => createHash('sha256').update(JSON.stringify([row.role, row.ts, row.turnId || null, row.content || '', row.documentArtifact || null, row.image?.filename || null])).digest('hex').slice(0, 32);
export function checkProjectConversation(userId, projectId, input, agents) {
  getProjectSpace(userId, projectId);
  if (!input || !agents.some(agent => agent.id === input.agentId)) throw new ProjectError(400, 'Choose an available agent');
  const chatId = input.chatId || null;
  if (chatId) getSavedChat(userId, chatId, projectId);
  return projectSessionKey(userId, input.agentId, projectId, chatId);
}
export async function readProjectMessage(userId, projectId, input, agents) {
  const key = checkProjectConversation(userId, projectId, input, agents);
  const rows = await loadSession(key, 1000);
  const replies = rows.filter(row => !row.hidden && row.role === 'assistant');
  const row = input.messageKey ? replies.find(row => projectMessageKey(row) === input.messageKey)
    : replies.find(row => row.ts === input.ts && row.content === input.content)
      || [...replies].reverse().find(row => row.content === input.content);
  if (!row || !row.content?.trim()) throw new ProjectError(404, 'That reply is no longer available. Reopen the conversation and try again');
  return { row, source: { agentId: input.agentId, chatId: input.chatId || null, messageKey: projectMessageKey(row), ts: row.ts, turnId: row.turnId || null } };
}

async function runtime(userId) {
  const [{ getActiveStreams }, { getActiveTasks }] = await Promise.all([
    import('../chat-dispatch/slot-registry.mjs'), import('../background-tasks.mjs'),
  ]);
  return { streams: getActiveStreams(userId, { allProjects: true }), tasks: getActiveTasks().filter(task => task.userId === userId) };
}
function conversationTasks(tasks, userId, projectId, agentId, chatId) {
  return tasks.filter(task => projectIdFromSession(task.sourceSessionKey) === projectId
    && chatIdFromSession(task.sourceSessionKey) === chatId
    && withoutConversationSuffix(task.sourceSessionKey) === `${userId}_${agentId}`);
}

export async function listProjectConversations(userId, projectId, agents, { includeOutputs = false } = {}) {
  const space = getProjectSpace(userId, projectId);
  if (!agents.length) return { conversations: [], outputs: [], conflicts: projectTaskConflicts(space.tasks) };
  const chats = listSavedChats(userId, projectId);
  const feed = readProjectFeed(userId, projectId);
  const { streams, tasks } = await runtime(userId);
  const conversations = [];
  const outputs = [...feed.outputs];
  for (const chat of [null, ...chats]) for (const agent of agents) {
    const sessionKey = projectSessionKey(userId, agent.id, projectId, chat?.id || null);
    // Named chats can contain several agents. Avoid creating empty sessions
    // for agents that have never participated in that chat.
    if (chat && chat.agentId !== agent.id && !hasSession(sessionKey)) continue;
    const rows = await loadSession(sessionKey, includeOutputs ? 1000 : 60);
    const visible = rows.filter(row => !row.hidden && ['user', 'assistant', 'turn_error', 'agent_report'].includes(row.role));
    const last = visible.at(-1);
    const chatId = chat?.id || null;
    const entry = feed.threads[projectThreadKey(agent.id, chatId)];
    const stream = streams.find(item => item.projectId === projectId && (item.chatId || null) === chatId && item.agentId === agent.id);
    const workers = conversationTasks(tasks, userId, projectId, agent.id, chatId);
    let status = entry?.status || (last?.role === 'turn_error' ? 'failed' : last ? 'finished' : 'idle');
    if (stream) status = /permission/.test(stream.phase) || Object.keys(entry?.pending || {}).length ? 'waiting' : 'working';
    else if (workers.length) status = workers.some(worker => /paused|permission|review/.test(worker.status || worker.phase)) ? 'waiting' : 'working';
    else if (status === 'working') status = 'interrupted';
    const notices = feed.notices.filter(item => item.agentId === agent.id && item.chatId === chatId && !item.read);
    conversations.push({ agentId: agent.id, chatId, name: chat?.name || 'Original chat', agentName: agent.name, emoji: agent.emoji,
      count: visible.length, preview: String(last?.content || chat?.preview || '').slice(0, 200),
      lastAt: Math.max(Number(last?.ts) || 0, entry?.updatedAt || 0, chat?.updatedAt || 0),
      status, unread: notices.length, through: notices.reduce((max, item) => Math.max(max, item.ts), 0),
      workers: workers.length, currentTool: stream?.toolEvents?.filter(tool => tool.status !== 'done').at(-1)?.name || workers[0]?.currentTool || null });
    if (includeOutputs) for (const row of rows.filter(row => row.role === 'assistant' && !row.hidden)) {
      for (const output of projectOutputsFromMessage(row)) outputs.push({ ...output, agentId: agent.id, chatId, ts: row.ts, turnId: row.turnId || null });
      for (const match of String(row.content || '').matchAll(/\[([^\]\n]{1,200})\]\(([^\s)]+)\)/g)) {
        const url = safeProjectOutputUrl(match[2]);
        if (url && /(?:github\.com|gitlab\.com|\.(?:pdf|docx?|xlsx?|zip|html|csv|png|svg)(?:[?#]|$)|^\/api\/)/i.test(url)) outputs.push({ kind: 'link', name: match[1], url, agentId: agent.id, chatId, ts: row.ts });
      }
    }
  }
  const available = new Set(agents.map(agent => agent.id));
  const chatIds = new Set(chats.map(chat => chat.id));
  const deduped = new Map();
  for (const output of outputs.filter(item => available.has(item.agentId) && (!item.chatId || chatIds.has(item.chatId)))) {
    const key = JSON.stringify([output.fileId || output.url, output.version || null, output.agentId, output.chatId]);
    if (!deduped.has(key) || Number(output.ts) > Number(deduped.get(key).ts)) deduped.set(key, output);
  }
  return { conversations: conversations.sort((a, b) => b.lastAt - a.lastAt), outputs: [...deduped.values()].sort((a, b) => b.ts - a.ts).slice(0, 500),
    conflicts: projectTaskConflicts(space.tasks) };
}

export function projectAttention(userId, agents) {
  const available = new Set(agents.map(agent => agent.id));
  return listProjectSpaces(userId).flatMap(space => {
    const feed = readProjectFeed(userId, space.id);
    const chats = new Map(listSavedChats(userId, space.id).map(chat => [chat.id, chat]));
    return feed.notices.filter(item => !item.read && available.has(item.agentId) && (!item.chatId || chats.has(item.chatId)))
      .map(item => ({ ...item, projectId: space.id, projectName: space.name,
        chatName: chats.get(item.chatId)?.name || 'Original chat', agentName: agents.find(agent => agent.id === item.agentId)?.name || item.agentId }));
  }).sort((a, b) => b.ts - a.ts).slice(0, 200);
}
