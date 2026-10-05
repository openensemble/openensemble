import { requireAuth, readBody, isUserTimeBlocked, getAgentsForUser } from './_helpers.mjs';
import { createSavedChat, listSavedChats, getSavedChat, renameSavedChat, deleteSavedChat, ChatError } from '../lib/saved-chats.mjs';

const reply = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/saved-chats' && !url.pathname.startsWith('/api/saved-chats/')) return false;
  const userId = requireAuth(req, res);
  if (!userId) return true;
  if (isUserTimeBlocked(userId)) { reply(res, 403, { error: 'Access is currently outside your allowed hours' }); return true; }
  try {
    const id = url.pathname.slice('/api/saved-chats'.length).replace(/^\//, '');
    const projectId = url.searchParams.get('project') || null;
    if (!id && req.method === 'GET') reply(res, 200, listSavedChats(userId, projectId));
    else if (!id && req.method === 'POST') {
      const input = JSON.parse(await readBody(req));
      if (!input || !getAgentsForUser(userId).some(agent => agent.id === input.agentId)) throw new ChatError(400, 'Choose an available agent');
      reply(res, 201, await createSavedChat(userId, { name: input.name ?? '', agentId: input.agentId, projectId }));
    } else if (id && req.method === 'GET') reply(res, 200, getSavedChat(userId, id, projectId));
    else if (id && req.method === 'PATCH') reply(res, 200, await renameSavedChat(userId, id, projectId, JSON.parse(await readBody(req))?.name));
    else if (id && req.method === 'DELETE') reply(res, 200, await deleteSavedChat(userId, id, projectId));
    else throw new ChatError(405, 'Method not allowed');
  } catch (error) { reply(res, error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.status ? error.message : error instanceof SyntaxError ? 'Invalid request' : 'Saved chat request failed' }); }
  return true;
}
