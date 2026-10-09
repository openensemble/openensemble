import fs from 'node:fs';
import { requireAuth, readBody, isUserTimeBlocked, getAgentsForUser } from './_helpers.mjs';
import { createProjectSpace, getProjectSpace, updateProjectSpace, changeProjectFile, projectFilePath, ProjectError, saveProjectItem, removeProjectItem } from '../lib/project-spaces.mjs';
import { projectContext } from '../lib/project-context.mjs';
import { saveProjectCheckpoint } from '../sessions.mjs';
import { listProjectProgress, readProjectCheckpoint } from '../lib/project-progress.mjs';
import { checkProjectConversation, readProjectMessage, listProjectConversations, projectAttention } from '../lib/project-work.mjs';
import { markProjectRead } from '../lib/project-feed.mjs';
import { getSavedChat } from '../lib/saved-chats.mjs';
import { deleteProjectSpace } from '../lib/project-spaces.mjs';
import { listProjectsWithGoals, listProjectGoals, startProjectGoal, pauseProjectGoal, completeProjectGoal, removeProjectGoal } from '../lib/project-goals.mjs';
import { migrateStandaloneGoals } from '../lib/general-goals.mjs';

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
    const agents = getAgentsForUser(userId);
    if (parts.length > 2) throw new ProjectError(404, 'Not found');
    if (id === 'attention' && !action && req.method === 'GET') reply(res, 200, projectAttention(userId, agents));
    else if (!id && req.method === 'GET') {
      // Keep existing projects accessible even if damaged legacy data needs
      // repair; Prepared work reports the conversion problem with the old goals.
      try { await migrateStandaloneGoals(userId); }
      catch (error) { console.warn('[project-goals] General goal conversion deferred:', error.message); }
      reply(res, 200, listProjectsWithGoals(userId));
    }
    else if (!id && req.method === 'POST') reply(res, 201, await createProjectSpace(userId, JSON.parse(await readBody(req))));
    else if (id) {
      const space = getProjectSpace(userId, id);
      if (!action && req.method === 'GET') reply(res, 200, space);
      else if (action === 'goals' && req.method === 'GET') reply(res, 200, await listProjectGoals(userId, id, agents));
      else if (action === 'start-work' && req.method === 'POST') reply(res, 202, await startProjectGoal(userId, id, JSON.parse(await readBody(req)), agents));
      else if (action === 'pause-work' && req.method === 'POST') reply(res, 200, await pauseProjectGoal(userId, id, JSON.parse(await readBody(req))));
      else if (action === 'complete-goal' && req.method === 'POST') reply(res, 200, await completeProjectGoal(userId, id, JSON.parse(await readBody(req)), agents));
      else if (action === 'goals' && req.method === 'DELETE') reply(res, 200, await removeProjectGoal(userId, id, JSON.parse(await readBody(req)), agents));
      else if (!action && req.method === 'DELETE') reply(res, 200, await deleteProjectSpace(userId, id, JSON.parse(await readBody(req))));
      else if (!action && req.method === 'PATCH') {
        const input = JSON.parse(await readBody(req));
        if (Array.isArray(input?.tasks)) for (const task of input.tasks) {
          if (task?.agentId && !agents.some(agent => agent.id === task.agentId)
              && !space.tasks.some(old => old.id === task.id && old.agentId === task.agentId)) throw new ProjectError(400, 'Choose an available task agent');
          if (task?.chatId) getSavedChat(userId, task.chatId, id);
        }
        reply(res, 200, await updateProjectSpace(userId, id, input));
      }
      else if (action === 'read' && req.method === 'POST') {
        const input = JSON.parse(await readBody(req));
        if (!input || !Array.isArray(input.ids || []) || (input.ids || []).length > 200 || !Number.isFinite(input.through ?? 0)) throw new ProjectError(400, 'Invalid activity receipt');
        await markProjectRead(userId, id, input); reply(res, 200, { ok: true });
      }
      else if (action === 'save-result' && req.method === 'POST') {
        const input = JSON.parse(await readBody(req));
        const { row, source } = await readProjectMessage(userId, id, input, agents);
        reply(res, 200, await saveProjectItem(userId, id, { revision: input.revision, kind: input.kind,
          title: input.title, content: input.excerpt ?? row.content, source }));
      }
      else if (action === 'saved-result' && req.method === 'DELETE') reply(res, 200, await removeProjectItem(userId, id, JSON.parse(await readBody(req))));
      else if (action === 'checkpoint' && req.method === 'POST') {
        const input = JSON.parse(await readBody(req));
        const key = checkProjectConversation(userId, id, input, agents);
        const { getActiveStreamForClient } = await import('../chat-dispatch/slot-registry.mjs');
        const result = await projectContext.run({ userId, projectId: id, chatId: input.chatId || null },
          () => saveProjectCheckpoint(key, getActiveStreamForClient(userId, input.agentId)));
        if (!result) throw new ProjectError(400, 'This conversation has no messages to save yet');
        reply(res, 200, result);
      }
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
      } else if (['chats', 'activity', 'outputs', 'output-file'].includes(action) && req.method === 'GET') {
        const data = await listProjectConversations(userId, id, agents, { includeOutputs: ['outputs', 'output-file'].includes(action) });
        if (action === 'output-file') {
          const fileId = url.searchParams.get('id');
          const output = data.outputs.find(item => item.fileId === fileId);
          if (!output) throw new ProjectError(404, 'Output not found in this project');
          const location = projectFilePath(userId, fileId);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(output.name).replaceAll("'", '%27')}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
          fs.createReadStream(location).on('error', () => res.destroy()).pipe(res);
        } else reply(res, 200, action === 'chats' ? data.conversations : action === 'outputs' ? data.outputs : data);
      } else throw new ProjectError(405, 'Method not allowed');
    } else throw new ProjectError(405, 'Method not allowed');
  } catch (error) { reply(res, error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.status || error instanceof SyntaxError ? error.message : 'Project request failed' }); }
  return true;
}
