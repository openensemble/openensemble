import { currentProjectId } from '../project-context.mjs';
import { getConfig } from './config.mjs';
import { readWorkState, createWorkGoal, updateWorkGoal, getWorkItem, WorkError } from './work-store.mjs';
import { discoverWork, prepareWorkItem } from './work-engine.mjs';
import { signalWorkEvent } from './work-events.mjs';

export async function executeWorkTool(name, args, userId) {
  const projectId = currentProjectId(userId);
  if (name === 'track_goal') {
    const goal = await createWorkGoal(userId, { ...args, projectId });
    signalWorkEvent(userId, { kind: 'goal', goalId: goal.id });
    const config = await getConfig(userId);
    const followUp = !config.enabled || !config.setupComplete || config.model === 'off' || config.workMode === 'off' ? 'Background preparation is off. The goal is saved for future chats; no automatic follow-up was scheduled.'
      : config.workMode === 'prepare' ? 'Background checks may prepare private drafts from this goal and its references. They do not execute the next step or send anything.'
        : 'Background checks may suggest preparation. A user action is required to generate each draft.';
    return JSON.stringify({ goal, followUp });
  }
  const state = readWorkState(userId);
  if (name === 'list_work_goals') return JSON.stringify(state.goals.filter(goal => goal.projectId === projectId));
  if (name === 'list_prepared_work') {
    const rows = args.id ? [getWorkItem(userId, args.id)] : state.items.filter(item => item.projectId === projectId).slice(-15);
    if (rows.some(item => item.projectId !== projectId)) throw new WorkError(403, 'Prepared work belongs to a different project');
    return JSON.stringify(rows.map(({ leaseToken, leaseUntil, markdown, ...item }) => args.id ? { ...item, markdown } : item));
  }
  const goal = state.goals.find(row => row.id === args.id && row.projectId === projectId);
  if (!goal) throw new WorkError(404, 'Goal not found in this conversation’s project');
  if (name === 'update_work_goal') {
    const { id, ...patch } = args;
    const updated = await updateWorkGoal(userId, id, patch);
    signalWorkEvent(userId, { kind: 'goal', goalId: id });
    return JSON.stringify(updated);
  }
  if (name === 'prepare_work') {
    const items = await discoverWork(userId, { onlyGoalId: goal.id, manual: true });
    if (!items[0]) throw new WorkError(409, 'No active goal is available for preparation');
    const { leaseToken, leaseUntil, ...item } = await prepareWorkItem(userId, items[0].id, { manual: true });
    return JSON.stringify(item);
  }
  throw new WorkError(400, 'Unknown work tool');
}
