import fs from 'node:fs';
import path from 'node:path';
import { USERS_DIR } from './paths.mjs';
import { ProjectError } from './project-spaces.mjs';
import { listSavedChats, removeProjectSavedChatMetadata } from './saved-chats.mjs';
import { deleteSession, projectSessionKeys } from '../sessions.mjs';
import { projectSessionKey, projectIdFromSession } from './project-context.mjs';
import { tryAcquireUserTopologyTransition, finishUserTopologyTransition } from '../chat-dispatch/slot-registry.mjs';
import { getActiveTasks } from '../background-tasks.mjs';
import { loadTasksForOwner, removeTask } from '../scheduler.mjs';
import { cancelPendingCredentialPrompts } from './credentials.mjs';
import { clearPendingForProject } from './pending-approvals.mjs';
import { withProjectProgressLock } from './project-progress.mjs';
import { readWorkState, mutateWorkState, workFingerprint } from './personalization/work-store.mjs';
import { prunePreparedWorkEvents } from './personalization/proactive-inbox.mjs';
import { sendToUser } from '../ws-handler/delivery.mjs';

// The project metadata lock serializes edits; the topology gate prevents new
// turns until all histories and their epoch tombstones have been removed/reset.
export async function deleteProjectHistory(userId, space, markDeleting, removeMetadata) {
  const transition = tryAcquireUserTopologyTransition(userId);
  if (!transition) throw new ProjectError(409, 'Wait for running replies to finish before deleting a project.');
  try {
    const id = space.id;
    if (getActiveTasks().some(task => task.userId === userId && projectIdFromSession(task.sourceSessionKey) === id)) {
      throw new ProjectError(409, 'Stop or finish this project’s running tasks before deleting it.');
    }
    // Validate all storage before removing anything. Recursive removal never
    // follows child symlinks, and none of the project path components may link out.
    const userDir = path.join(USERS_DIR, userId);
    for (const dir of [userDir, path.join(userDir, 'project-spaces'), path.join(userDir, 'project-spaces', id)]) {
      try { if (fs.lstatSync(dir).isSymbolicLink()) throw new ProjectError(400, 'Invalid project storage'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const chats = listSavedChats(userId, id);
    readWorkState(userId);
    markDeleting();
    const keys = new Set(await projectSessionKeys(userId, id));
    for (const chat of chats) keys.add(projectSessionKey(userId, chat.agentId, id, chat.id));
    cancelPendingCredentialPrompts(userId, { projectId: id });
    for (const key of keys) await deleteSession(key, { strict: true });
    clearPendingForProject(userId, id);
    for (const task of loadTasksForOwner(userId).filter(task => task.projectId === id)) await removeTask(task.id, userId);
    await mutateWorkState(userId, state => {
      const goals = state.goals.filter(goal => goal.projectId === id);
      const goalIds = new Set(goals.map(goal => goal.id));
      const taskIds = new Set(state.items.filter(item => item.projectId === id).map(item => item.taskId).filter(Boolean));
      state.goals = state.goals.filter(goal => !goalIds.has(goal.id));
      state.items = state.items.filter(item => item.projectId !== id && !goalIds.has(item.goalId));
      state.events = state.events.filter(event => event.projectId !== id && !goalIds.has(event.goalId) && !taskIds.has(event.taskId));
      for (const goal of goals) if (goal.emailRef && state.mailChecks) delete state.mailChecks[workFingerprint([goal.id, goal.emailRef])];
    });
    await prunePreparedWorkEvents(userId);
    await removeProjectSavedChatMetadata(userId, id);
    // Progress summaries may finish after a turn. Share their lock and remove
    // the metadata last so late summaries cannot recreate the progress folder.
    await withProjectProgressLock(userId, id, dir => {
      fs.rmSync(dir, { recursive: true, force: true });
      removeMetadata();
    });
    sendToUser(userId, { type: 'project_deleted', projectId: id });
  } finally { finishUserTopologyTransition(transition); }
}
