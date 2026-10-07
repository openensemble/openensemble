import { requireAuth, isUserTimeBlocked, getAgentsForUser } from './_helpers.mjs';
import { getProjectSpace } from '../lib/project-spaces.mjs';
import { getSavedChat } from '../lib/saved-chats.mjs';
import { projectSessionKey } from '../lib/project-context.mjs';
import { readAgentWork } from '../lib/agent-work.mjs';

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/agent-work') return false;
  const userId = requireAuth(req, res);
  if (!userId) return true;
  const reply = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
    res.end(JSON.stringify(data));
  };
  if (req.method !== 'GET') { reply(405, { error: 'Read-only endpoint.' }); return true; }
  try {
    if (isUserTimeBlocked(userId)) { reply(403, { error: 'Access is currently outside your allowed hours.' }); return true; }
    const agentId = url.searchParams.get('agent');
    if (!getAgentsForUser(userId).some(agent => agent.id === agentId)) {
      reply(404, { error: 'Conversation not found.' }); return true;
    }
    const projectId = url.searchParams.get('project') || null;
    const chatId = url.searchParams.get('chat') || null;
    if (projectId) getProjectSpace(userId, projectId);
    if (chatId) getSavedChat(userId, chatId, projectId);
    const taskId = url.searchParams.get('task') || null;
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 50);
    if ((taskId && !/^[a-zA-Z0-9_-]{1,200}$/.test(taskId))
        || !Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      reply(400, { error: 'Invalid work history request.' }); return true;
    }
    reply(200, await readAgentWork(userId, projectSessionKey(userId, agentId, projectId, chatId), {
      taskId, epoch: url.searchParams.get('epoch') || null, offset, limit,
    }));
  } catch (error) {
    reply(error.status || 500, { error: error.status ? error.message : 'Work history could not be loaded.' });
  }
  return true;
}
