import { randomUUID } from 'node:crypto';
import { withLock } from '../routes/_helpers/io-lock.mjs';
import { getProjectSpace, listProjectSpaces, ProjectError } from './project-spaces.mjs';
import { createSavedChat, getSavedChat } from './saved-chats.mjs';
import { projectContext, projectSessionKey } from './project-context.mjs';
import { listProjectConversations } from './project-work.mjs';
import { getWorkGoal, readWorkState, mutateWorkState, updateWorkGoal, deleteWorkGoal, validateWorkGoalPatch, WorkError } from './personalization/work-store.mjs';
import { signalWorkEvent } from './personalization/work-events.mjs';
import { prunePreparedWorkEvents } from './personalization/proactive-inbox.mjs';

// Launch state lives with the goal. The existing conversation and task records
// remain the source of truth for progress, permissions, results and recovery.
const launches = new Map();
const launchKey = (userId, goalId) => `${userId}:${goalId}`;
const goalInProject = (userId, projectId, goalId) => {
  getProjectSpace(userId, projectId);
  const goal = getWorkGoal(userId, goalId);
  if (goal.projectId !== projectId) throw new WorkError(404, 'Goal not found in this project');
  return goal;
};

export function listProjectsWithGoals(userId) {
  const state = readWorkState(userId);
  return listProjectSpaces(userId).map(project => {
    const goals = state.goals.filter(goal => goal.projectId === project.id);
    return { ...project, goalSummary: { total: goals.length, active: goals.filter(goal => goal.status === 'active').length,
      completed: goals.filter(goal => goal.status === 'completed').length } };
  });
}

export async function listProjectGoals(userId, projectId, agents) {
  getProjectSpace(userId, projectId);
  const goals = readWorkState(userId).goals.filter(goal => goal.projectId === projectId);
  if (!goals.some(goal => goal.run)) return { goals };
  const { conversations } = await listProjectConversations(userId, projectId, agents);
  return { goals: goals.map(goal => {
    if (!goal.run) return goal;
    const chat = conversations.find(row => row.chatId === goal.run.chatId && row.agentId === goal.run.agentId);
    const launch = launches.get(launchKey(userId, goal.id));
    const launching = Boolean(launch);
    const active = launching || ['working', 'waiting'].includes(chat?.status) && (chat?.workers > 0 || chat?.status === 'working');
    let status = active ? 'working' : goal.run.phase === 'failed' ? 'failed' : chat?.status || 'unavailable';
    if (chat?.status === 'waiting') status = 'waiting';
    else if (launch?.retry?.retryAt && !launch.stopped) status = 'retrying';
    if (!active && goal.status === 'paused') status = 'paused';
    else if (!active && goal.status === 'completed') status = 'completed';
    else if (!active && goal.run.phase === 'starting' && (!chat || chat.status === 'idle')) status = 'interrupted';
    else if (status === 'finished') status = 'review';
    return { ...goal, run: { ...goal.run, active, status, currentTool: chat?.currentTool || null,
      preview: chat?.preview || '', workers: chat?.workers || 0, ...(launch?.retry ? { retry: launch.retry } : {}) } };
  }) };
}

export function projectGoalPrompt(project, goal, instructions = '') {
  // Start authorizes the saved prompt, or the user's edited version for this
  // run. Quote saved context so a repeated title or an agent's next step cannot
  // become another authorized agent allocation. Legacy goals use their title.
  instructions = instructions.trim() || goal.prompt?.trim() || goal.title?.trim() || '';
  const context = `Project: ${project.name}\nProject ID: ${project.id}\nGoal: ${goal.title}\nGoal ID: ${goal.id}\nDone when: ${goal.completionCriteria}\nNext step: ${goal.nextStep || 'Determine the next concrete step.'}\nKnown blocker: ${goal.blocker || 'None recorded.'}${goal.dueAt ? `\nDeadline: ${goal.dueAt}` : ''}`
    .split('\n').map(line => `> ${line}`).join('\n');
  return `${instructions ? `${instructions}\n\n` : ''}Start work on this project goal in the background. Plan the remaining steps, carry out the authorized work, and review the results against the completion condition. You may delegate suitable independent tasks and must check their results yourself. Keep completed work; do not repeat completed actions. Use the project's saved context and linked files.\n\nSaved project context:\n${context}\n\nUse list_work_goals to read the current goal revision and update_work_goal to record verified progress, next steps, and blockers. Mark the goal completed only after checking the completion condition, and include the evidence in your final result. If it cannot be completed, leave it active with the remaining next step or blocker. If the user pauses the goal, stop. Saving a plan or receiving a worker's report alone does not prove completion. Report missing skills or permissions and use the normal approval flow; do not bypass them.`;
}

async function finishLaunch(userId, goalId, runId, error) {
  await mutateWorkState(userId, state => {
    const goal = state.goals.find(row => row.id === goalId);
    if (goal?.run?.id !== runId) return;
    // A completed chat turn can leave detached workers running. Do not mark
    // the goal complete here; live task state and verified goal updates decide.
    Object.assign(goal.run, { phase: error ? 'failed' : 'dispatched', error: error || '', dispatchedAt: new Date().toISOString() });
  });
}

async function stopGoalRun(userId, projectId, run) {
  const [{ abortChat }, { getActiveTasks, cancelTask }] = await Promise.all([
    import('../chat-dispatch/slot-registry.mjs'), import('../background-tasks.mjs'),
  ]);
  projectContext.run({ userId, projectId, chatId: run.chatId }, () => abortChat(userId, run.agentId));
  const key = projectSessionKey(userId, run.agentId, projectId, run.chatId);
  const failures = getActiveTasks().filter(task => task.userId === userId && task.sourceSessionKey === key)
    .map(task => cancelTask(userId, task.taskId, 'Project goal paused'))
    .filter(result => !result.ok && !['not found', 'already finalizing'].includes(result.reason));
  if (failures.length) throw new WorkError(409, failures[0].reason || 'Could not stop the goal work. Open its conversation to stop it.');
}

export async function startProjectGoal(userId, projectId, input, agents) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId || '')
      || typeof input.instructions !== 'undefined' && (typeof input.instructions !== 'string' || input.instructions.length > 12000)) {
    throw new WorkError(400, 'Invalid goal work request');
  }
  return withLock(`project-goal:${launchKey(userId, input.goalId)}`, async () => {
    const project = getProjectSpace(userId, projectId);
    let goal = goalInProject(userId, projectId, input.goalId);
    if (goal.run?.id === input.requestId) return { goal, duplicate: true };
    if (project.archived) throw new ProjectError(409, 'Unarchive this project before starting work');
    if (goal.status === 'completed') throw new WorkError(409, 'This goal is already complete. Add another goal or reopen it first.');
    const current = (await listProjectGoals(userId, projectId, agents)).goals.find(row => row.id === goal.id);
    if (current?.run?.active) return { goal: current, duplicate: true };
    if (current?.run?.status === 'waiting') throw new WorkError(409, 'Open the work conversation to answer the pending request before starting more work.');
    if (goal.revision !== input.revision) throw new WorkError(409, 'This goal changed. Refresh the project before starting work.');
    if (!goal.completionCriteria?.trim()) throw new WorkError(400, 'Define when this goal is done before starting work.');
    const agent = agents.find(row => row.id === input.agentId);
    if (!agent) throw new WorkError(400, 'Choose an available lead agent');
    const [{ handleChatMessage }, { tryAcquireUserTurnLease, abortChat }, { sendToUser }, { broadcastAgentList }] = await Promise.all([
      import('../chat-dispatch.mjs'), import('../chat-dispatch/slot-registry.mjs'), import('../ws-handler/delivery.mjs'), import('../routes/_helpers/broadcast.mjs'),
    ]);
    const lease = tryAcquireUserTurnLease(userId, { label: 'project-goal-start' });
    if (!lease) throw new WorkError(409, 'Your agent setup is changing. Try again in a moment.');
    let leaseReleased = false;
    const releaseAdmission = () => { if (!leaseReleased) { leaseReleased = true; lease.release(); } };
    let handedOff = false;
    try {
      let chat;
      if (goal.run?.agentId === agent.id) {
        try { chat = getSavedChat(userId, goal.run.chatId, projectId); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      chat ||= await createSavedChat(userId, { projectId, agentId: agent.id, name: goal.title.slice(0, 100) });
      goal = await mutateWorkState(userId, state => {
        const saved = state.goals.find(row => row.id === goal.id && row.projectId === projectId);
        if (!saved || saved.revision !== input.revision) throw new WorkError(409, 'This goal changed. Refresh the project before starting work.');
        getProjectSpace(userId, projectId);
        const now = new Date().toISOString();
        Object.assign(saved, { status: 'active', revision: saved.revision + 1, updatedAt: now,
          run: { id: input.requestId, chatId: chat.id, agentId: agent.id, startedAt: now, phase: 'starting', error: '' } });
        return structuredClone(saved);
      });
      const key = launchKey(userId, goal.id);
      const control = { stopped: false };
      launches.set(key, control);
      const scope = { userId, projectId, chatId: chat.id };
      const text = projectGoalPrompt(project, goal, input.instructions?.trim());
      // A normal authenticated chat turn, in its own saved conversation. The
      // request returns immediately; permission UI and worker routing stay intact.
      const task = projectContext.run(scope, async () => {
        let failure = '';
        try {
          if (control.stopped) return;
          const execution = handleChatMessage({ userId, agentId: agent.id, text, source: 'chat-ui',
            messageId: `project_goal_${input.requestId}`, attemptId: randomUUID(),
            onEvent: event => {
              if (control.stopped) abortChat(userId, agent.id);
              if (event.type === 'provider_retry') control.retry = event.retryAt
                ? { attempt: event.attempt, maxAttempts: event.maxAttempts, retryAt: event.retryAt } : null;
              if (event.type === 'error') failure = String(event.message || 'Work could not finish.').slice(0, 1000);
              sendToUser(userId, event);
            },
            onBroadcast: broadcastAgentList,
            onNotify: (fromUserId, agentId, notification) => {
              import('../ws-handler.mjs').then(({ emitAgentNotification }) => emitAgentNotification(fromUserId, agentId, notification))
                .catch(error => console.warn('[project-goals] Notification failed:', error?.message));
            },
          });
          // The dispatcher acquires its own turn lease before its first await.
          // Release the admission lease so legitimate in-turn changes can upgrade it.
          releaseAdmission();
          await execution;
        } catch (error) {
          failure = 'The work conversation was interrupted. Open it to review progress before continuing.';
          console.warn('[project-goals] Work dispatch failed:', error?.message);
          sendToUser(userId, { type: 'error', agent: agent.id, message: failure });
        } finally {
          try {
            // A worker admission may finish after Pause took its first task
            // snapshot. Stop it once the launching turn has fully settled too.
            if (control.stopped) {
              try { await stopGoalRun(userId, projectId, goal.run); }
              catch (error) { failure = error.message; }
            }
            await finishLaunch(userId, goal.id, input.requestId, failure);
          }
          finally { if (launches.get(key) === control) launches.delete(key); releaseAdmission(); }
        }
      });
      task.catch(error => console.warn('[project-goals] Could not save launch outcome:', error?.message));
      handedOff = true;
      signalWorkEvent(userId, { kind: 'goal', goalId: goal.id });
      return { goal, duplicate: false };
    } finally { if (!handedOff) releaseAdmission(); }
  });
}

export async function pauseProjectGoal(userId, projectId, input) {
  return withLock(`project-goal:${launchKey(userId, input?.goalId)}`, async () => {
    const goal = goalInProject(userId, projectId, input?.goalId);
    if (goal.revision !== input?.revision) throw new WorkError(409, 'This goal changed. Refresh the project before pausing it.');
    if (goal.run) {
      const control = launches.get(launchKey(userId, goal.id));
      if (control) control.stopped = true;
      await stopGoalRun(userId, projectId, goal.run);
    }
    return mutateWorkState(userId, state => {
      const saved = state.goals.find(row => row.id === goal.id && row.projectId === projectId);
      if (!saved) throw new WorkError(404, 'Goal not found');
      saved.status = 'paused'; saved.revision++; saved.updatedAt = new Date().toISOString();
      return saved;
    });
  });
}

// Older clients edit status through the general goals endpoint. Keep those
// manual changes under the same launch lock and controls as project buttons.
// Agent tools still use updateWorkGoal to record their own verified completion.
export async function updateProjectGoal(userId, projectId, goalId, input, agents) {
  return withLock(`project-goal:${launchKey(userId, goalId)}`, async () => {
    const goal = goalInProject(userId, projectId, goalId);
    const patch = validateWorkGoalPatch(userId, input, goal);
    if (!Number.isInteger(input.revision) || goal.revision !== input.revision) throw new WorkError(409, 'This goal changed. Reload it before saving; keep your edits.');
    if (patch.status === 'completed') {
      const current = (await listProjectGoals(userId, projectId, agents)).goals.find(row => row.id === goal.id);
      if (current?.run?.active || current?.run?.status === 'waiting') throw new WorkError(409, 'Pause this goal’s work and wait for it to stop before completing the goal.');
    }
    if (patch.status === 'paused' && goal.run) {
      const control = launches.get(launchKey(userId, goal.id));
      if (control) control.stopped = true;
      await stopGoalRun(userId, projectId, goal.run);
    }
    return updateWorkGoal(userId, goal.id, input);
  });
}

// Serialize manual completion/removal with Start and Pause. A stale browser
// cannot finish or remove a goal whose conversation has since started work.
async function changeFinishedProjectGoal(userId, projectId, input, agents, remove) {
  return withLock(`project-goal:${launchKey(userId, input?.goalId)}`, async () => {
    const goal = goalInProject(userId, projectId, input?.goalId);
    if (!Number.isInteger(input?.revision) || goal.revision !== input.revision) throw new WorkError(409, 'This goal changed. Refresh the project before trying again.');
    const current = (await listProjectGoals(userId, projectId, agents)).goals.find(row => row.id === goal.id);
    if (current?.run?.active || current?.run?.status === 'waiting') {
      throw new WorkError(409, 'Pause this goal’s work and wait for it to stop before completing or removing the goal.');
    }
    if (remove) {
      if (!['paused', 'completed'].includes(goal.status)) throw new WorkError(409, 'Pause or complete this goal before removing it.');
      const result = await deleteWorkGoal(userId, goal.id, input.revision);
      await prunePreparedWorkEvents(userId);
      return result;
    }
    const result = await updateWorkGoal(userId, goal.id, { revision: input.revision, status: 'completed', nextStep: '', blocker: '' });
    signalWorkEvent(userId, { kind: 'goal', goalId: goal.id });
    return result;
  });
}

export function completeProjectGoal(userId, projectId, input, agents) {
  return changeFinishedProjectGoal(userId, projectId, input, agents, false);
}
export function removeProjectGoal(userId, projectId, input, agents) {
  return changeFinishedProjectGoal(userId, projectId, input, agents, true);
}
