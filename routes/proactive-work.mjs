import { requireAuth, readBody, isUserTimeBlocked } from './_helpers.mjs';
import { getConfig } from '../lib/personalization/config.mjs';
import { getProjectSpace } from '../lib/project-spaces.mjs';
import { isProjectId } from '../lib/project-context.mjs';
import { readWorkState, createWorkGoal, updateWorkGoal, deleteWorkGoal, getWorkItem, WorkError } from '../lib/personalization/work-store.mjs';
import { discoverWork, prepareWorkItem, feedbackWorkItem, applyWorkProjectSuggestion } from '../lib/personalization/work-engine.mjs';
import { signalWorkEvent } from '../lib/personalization/work-events.mjs';
import { prunePreparedWorkEvents } from '../lib/personalization/proactive-inbox.mjs';

const reply = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const publicItem = item => { const { leaseToken, leaseUntil, ...safe } = item; return safe; };

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/proactive-work' && !url.pathname.startsWith('/api/proactive-work/')) return false;
  const userId = requireAuth(req, res);
  if (!userId) return true;
  if (isUserTimeBlocked(userId)) { reply(res, 403, { error: 'Access is currently outside your allowed hours' }); return true; }
  try {
    const [kind, id, action, extra] = url.pathname.slice('/api/proactive-work'.length).split('/').filter(Boolean);
    if (extra) throw new WorkError(404, 'Not found');
    if (!kind && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      if (projectId && !isProjectId(projectId)) throw new WorkError(400, 'Invalid project');
      if (projectId) getProjectSpace(userId, projectId);
      const state = readWorkState(userId);
      const config = await getConfig(userId);
      const matches = row => !projectId || row.projectId === projectId;
      const goals = state.goals.filter(matches);
      const items = state.items.filter(matches).map(publicItem).reverse();
      reply(res, 200, { goals, items, workMode: config.workMode, enabled: config.enabled && config.setupComplete && config.model !== 'off',
        metrics: { prepared: items.filter(item => item.preparedAt).length, used: items.filter(item => item.feedback === 'acted').length,
          useful: items.filter(item => item.feedback === 'useful').length, dismissed: items.filter(item => ['dismissed', 'not_useful'].includes(item.feedback)).length,
          completedGoals: goals.filter(goal => goal.status === 'completed').length } });
    } else if (kind === 'goals' && !id && req.method === 'POST') {
      const goal = await createWorkGoal(userId, JSON.parse(await readBody(req)));
      signalWorkEvent(userId, { kind: 'goal', goalId: goal.id });
      reply(res, 201, goal);
    } else if (kind === 'goals' && id && !action && req.method === 'PATCH') {
      const goal = await updateWorkGoal(userId, id, JSON.parse(await readBody(req)));
      signalWorkEvent(userId, { kind: 'goal', goalId: id });
      reply(res, 200, goal);
    } else if (kind === 'goals' && id && !action && req.method === 'DELETE') {
      const body = JSON.parse(await readBody(req));
      const result = await deleteWorkGoal(userId, id, body.revision);
      await prunePreparedWorkEvents(userId);
      reply(res, 200, result);
    } else if (kind === 'goals' && id && action === 'prepare' && req.method === 'POST') {
      const goal = readWorkState(userId).goals.find(row => row.id === id);
      if (!goal) throw new WorkError(404, 'Goal not found');
      const items = await discoverWork(userId, { onlyGoalId: id, manual: true });
      if (!items[0]) throw new WorkError(409, 'This goal is paused, completed, or unavailable for preparation');
      reply(res, 200, publicItem(await prepareWorkItem(userId, items[0].id, { manual: true })));
    } else if (kind === 'items' && id && !action && req.method === 'GET') reply(res, 200, publicItem(getWorkItem(userId, id)));
    else if (kind === 'items' && id && action === 'prepare' && req.method === 'POST') reply(res, 200, publicItem(await prepareWorkItem(userId, id, { manual: true })));
    else if (kind === 'items' && id && action === 'feedback' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      reply(res, 200, publicItem(await feedbackWorkItem(userId, id, body.outcome)));
    } else if (kind === 'items' && id && action === 'apply-project' && req.method === 'POST') reply(res, 200, publicItem(await applyWorkProjectSuggestion(userId, id)));
    else throw new WorkError(405, 'Method not allowed');
  } catch (error) {
    reply(res, error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.status || error instanceof SyntaxError ? error.message : 'Could not complete the work request' });
  }
  return true;
}
