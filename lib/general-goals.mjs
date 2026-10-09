import fs from 'node:fs';
import path from 'node:path';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { withGeneralGoalsProject, projectFilePath } from './project-spaces.mjs';
import { readWorkState, mutateWorkState, workFingerprint, goalPreparationKey, meetingPreparationKey, WorkError } from './personalization/work-store.mjs';

function rekeyPreparation(item) {
  let key;
  if (item.key?.startsWith('goal:')) key = goalPreparationKey(item.goalId, item.goalRevision, item.projectRevision,
    item.emailKey, item.taskRunAt, item.calendarStamp || null);
  else if (item.key?.startsWith('meeting:') && item.calendarRef) key = meetingPreparationKey(item.calendarRef, item.calendarStamp, item.goalRevision);
  if (key) item.key = `${key}:${workFingerprint(item.referenceVersions || [])}`;
}

// Project metadata is written first, then the existing work store is replaced
// atomically. A retry uses the same project ID if the second write was interrupted.
// Goal IDs, timestamps, statuses, drafts and unrelated records remain intact.
export async function migrateStandaloneGoals(userId, { newGoalId = null } = {}) {
  const snapshot = readWorkState(userId);
  if (!snapshot.goals.some(goal => !goal.projectId)) return { converted: 0, pending: 0, projectId: snapshot.generalGoalsProjectId || null };
  const generation = snapshot.generalGoalsGeneration || 0;
  return withGeneralGoalsProject(userId, (space, saveProject) => mutateWorkState(userId, state => {
    if ((state.generalGoalsGeneration || 0) !== generation) throw new WorkError(409, 'General goals changed during conversion. Please try again.');
    const standalone = state.goals.filter(goal => !goal.projectId);
    const busy = new Set(state.items.filter(item => item.status === 'running' && Date.parse(item.leaseUntil || '') > Date.now()).map(item => item.goalId));
    if (state.items.some(item => item.projectId === space.id && busy.has(item.goalId))) {
      return { converted: 0, pending: standalone.length, projectId: state.generalGoalsProjectId || null };
    }
    const goals = standalone.filter(goal => !busy.has(goal.id) && !goal.run);
    if (!goals.length) return { converted: 0, pending: standalone.length, projectId: state.generalGoalsProjectId || null };
    if (goals.some(goal => goal.id !== newGoalId)) {
      const file = path.join(USERS_DIR, userId, 'personalization', `proactive-work.before-project-goals-v1-${state.revision}-${workFingerprint(state)}.json`);
      // The parent storage path was validated by mutateWorkState. Never follow
      // an existing backup link or replace an earlier recovery snapshot.
      try { if (!fs.lstatSync(file).isFile()) throw new Error('Invalid goal conversion backup'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!fs.existsSync(file)) atomicWriteSync(file, JSON.stringify({ savedAt: new Date().toISOString(), work: state, project: space }, null, 2), { mode: 0o600 });
    }
    const previousRevision = space.revision;
    const previousFiles = space.files.length;
    const files = new Set(space.files.map(file => file.fileId));
    for (const goal of goals) for (const fileId of goal.fileIds || []) {
      if (files.has(fileId)) continue;
      let name = fileId;
      try { name = path.basename(projectFilePath(userId, fileId)); } catch { /* Keep missing references visible too. */ }
      space.files.push({ fileId, name, addedAt: Date.now() }); files.add(fileId);
    }
    if (space.files.length !== previousFiles) {
      const previousImport = space.generalGoalsImportRevisions;
      space.revision++; space.updatedAt = Date.now();
      // Preserve the range across a failed work-store write. Only consecutive
      // file imports can share it; an ordinary project edit breaks the range.
      space.generalGoalsImportRevisions = {
        from: previousImport?.to === previousRevision ? previousImport.from : previousRevision,
        to: space.revision,
      };
    }
    saveProject(space);
    // Adding imported file links must not invalidate an earlier converted
    // draft whose goal and own reference files have not changed.
    const imported = space.generalGoalsImportRevisions;
    if (imported?.to === space.revision) for (const item of state.items) {
      if (item.projectId === space.id && item.projectRevision >= imported.from && item.projectRevision < imported.to
          && state.goals.some(goal => goal.id === item.goalId && goal.fromGeneral)) {
        item.projectRevision = space.revision; rekeyPreparation(item);
      }
    }
    for (const goal of goals) {
      const previousGoalRevision = goal.revision;
      goal.projectId = space.id; goal.fromGeneral = true;
      for (const item of state.items.filter(item => item.goalId === goal.id)) {
        item.projectId = space.id; item.projectRevision = space.revision;
        if (item.goalRevision === previousGoalRevision) rekeyPreparation(item);
      }
      for (const event of state.events) if (event.goalId === goal.id && !event.projectId) event.projectId = space.id;
    }
    state.generalGoalsProjectId = space.id;
    return { converted: goals.length, pending: standalone.length - goals.length, projectId: space.id };
  }, { skipUnchanged: true }), generation);
}
