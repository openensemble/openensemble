import fs from 'node:fs';
import { requireAuth, readBody, isUserTimeBlocked, getAgentsForUser } from './_helpers.mjs';
import { createProjectSpace, listProjectSpaces, getProjectSpace, updateProjectSpace, changeProjectFile, projectFilePath, ProjectError } from '../lib/project-spaces.mjs';
import { projectSessionKey } from '../lib/project-context.mjs';
import { loadSession } from '../sessions.mjs';
import { listProjectProgress, readProjectCheckpoint } from '../lib/project-progress.mjs';

const reply = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/project-spaces' && !url.pathname.startsWith('/api/project-spaces/')) return false;
  const userId = requireAuth(req, res);
  if (!userId) return true;
  if (isUserTimeBlocked(userId)) { reply(res, 403, { error: 'Access is currently outside your allowed hours' }); return true; }
  try {
    const parts = url.pathname.slice('/api/project-spaces'.length).split('/').filter(Boolean);
    const [id, action] = parts;
    if (parts.length > 2) throw new ProjectError(404, 'Not found');
    if (!id && req.method === 'GET') reply(res, 200, listProjectSpaces(userId));
    else if (!id && req.method === 'POST') reply(res, 201, await createProjectSpace(userId, JSON.parse(await readBody(req))));
    else if (id) {
      const space = getProjectSpace(userId, id);
      if (!action && req.method === 'GET') reply(res, 200, space);
      else if (!action && req.method === 'PATCH') reply(res, 200, await updateProjectSpace(userId, id, JSON.parse(await readBody(req))));
      else if (action === 'progress' && req.method === 'GET') {
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isInteger(offset) || offset < 0) throw new ProjectError(400, 'Invalid progress page');
        reply(res, 200, listProjectProgress(userId, id, { offset }));
      } else if (action === 'progress-file' && req.method === 'GET') {
        const checkpoint = url.searchParams.get('id');
        if (!/^checkpoint_[a-f0-9]{32}$/.test(checkpoint || '')) throw new ProjectError(400, 'Invalid saved conversation');
        const record = readProjectCheckpoint(userId, id, checkpoint);
        res.writeHead(200, { 'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${checkpoint}.json"`,
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(record, null, 2));
      }
      else if (action === 'files' && ['POST', 'DELETE'].includes(req.method)) {
        reply(res, 200, await changeProjectFile(userId, id, JSON.parse(await readBody(req)), req.method === 'DELETE'));
      } else if (action === 'file' && req.method === 'GET') {
        const file = space.files.find(item => item.fileId === url.searchParams.get('id'));
        if (!file) throw new ProjectError(404, 'File not linked to this project');
        const location = projectFilePath(userId, file.fileId);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", '%27')}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        fs.createReadStream(location).on('error', () => res.destroy()).pipe(res);
      } else if (action === 'chats' && req.method === 'GET') {
        const chats = await Promise.all(getAgentsForUser(userId).map(async agent => {
          const messages = await loadSession(projectSessionKey(userId, agent.id, id), 60);
          const visible = messages.filter(row => ['user', 'assistant'].includes(row.role) && !row.hidden);
          return { agentId: agent.id, name: agent.name, emoji: agent.emoji, count: visible.length, preview: String(visible.at(-1)?.content || '').slice(0, 200), lastAt: visible.at(-1)?.ts || null };
        }));
        reply(res, 200, chats);
      } else throw new ProjectError(405, 'Method not allowed');
    } else throw new ProjectError(405, 'Method not allowed');
  } catch (error) { reply(res, error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.status || error instanceof SyntaxError ? error.message : 'Project request failed' }); }
  return true;
}
