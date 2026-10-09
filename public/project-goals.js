let projectGoalData = null;
let projectGoalLoad = 0;
let projectGoalBusy = false;
const projectGoalEditors = new Map();
const projectGoalRunDrafts = new Map();
const projectGoalFields = ['title', 'prompt', 'completionCriteria', 'nextStep', 'blocker', 'dueAt'];
const projectGoalValues = goal => Object.fromEntries(projectGoalFields.map(field => [field, goal[field] || (field === 'dueAt' ? null : '')]));
const projectGoalLabels = { working: 'Working', waiting: 'Needs your input', review: 'Review results', failed: 'Needs attention', interrupted: 'Interrupted', unavailable: 'Conversation unavailable', paused: 'Paused', completed: 'Completed', idle: 'Ready', stopped: 'Stopped' };
const projectGoalArgs = (...args) => escHtml(JSON.stringify(args));
function projectGoalKey() { return `${typeof _currentUser !== 'undefined' ? _currentUser?.id || '' : ''}:${selectedProjectSpace?.id || 'new'}`; }
function projectGoalEditorDraft() {
  const key = projectGoalKey();
  if (!projectGoalEditors.has(key)) {
    try {
      const draft = JSON.parse(sessionStorage.getItem(`oe.projectGoalDraft.${key}`) || 'null');
      if (draft && (draft.id === null || /^goal_[a-f0-9]{32}$/.test(draft.id)) && typeof draft.title === 'string') projectGoalEditors.set(key, draft);
    } catch {}
  }
  return projectGoalEditors.get(key);
}
function rememberProjectGoalEditor(key = projectGoalKey()) {
  try {
    const draft = projectGoalEditors.get(key);
    if (draft) sessionStorage.setItem(`oe.projectGoalDraft.${key}`, JSON.stringify(draft));
    else sessionStorage.removeItem(`oe.projectGoalDraft.${key}`);
  } catch {}
}
function resetProjectGoals() {
  ++projectGoalLoad; projectGoalData = null; projectGoalEditors.clear(); projectGoalRunDrafts.clear();
}
function projectGoalSummary(space) {
  const goals = projectGoalData?.projectId === space.id ? projectGoalData.goals : null;
  const summary = goals ? { total: goals.length, active: goals.filter(goal => goal.status === 'active').length, completed: goals.filter(goal => goal.status === 'completed').length } : space.goalSummary;
  if (!summary?.total) return 'Define a goal';
  if (summary.active) return `${summary.active} active ${summary.active === 1 ? 'goal' : 'goals'}`;
  return `${summary.completed} of ${summary.total} goals completed`;
}
function initialProjectGoalFields() {
  const initial = projectSpaceDraft.initialGoal || {};
  const goal = { ...initial, prompt: initial.prompt ?? initial.title ?? '' };
  const field = (key, label, hint, max, single = false) => {
    const attrs = `id="projectInitial${key}" maxlength="${max}" data-input-action="editInitialProjectGoal" data-input-args='${projectGoalArgs(key, '$value')}' placeholder="${escHtml(hint)}"`;
    return `<label class="project-field"><span>${label}</span>${single ? `<input ${attrs} value="${escHtml(goal[key] || '')}">` : `<textarea ${attrs} rows="${key === 'prompt' ? 6 : 3}">${escHtml(goal[key] || '')}</textarea>`}</label>`;
  };
  return `<section class="project-goal-setup"><h3>Goals</h3>${field('prompt', 'What should this project accomplish?', 'Enter your full prompt. For example: Use four agents to research these options, compare their findings, and write a final recommendation.', 12000)}<p class="project-help">Include the task, constraints, and any agents you want to use. Your prompt is saved and sent to the lead agent when you choose Start work.</p>${field('completionCriteria', 'Done when', 'For example, a final recommendation compares the options and includes sources.', 2000)}<details class="project-run-options" ${goal.nextStep ? 'open' : ''}><summary>Set a first step (optional)</summary>${field('nextStep', 'First step', 'Where should the agent begin?', 2000, true)}</details><p class="project-help">You can add more goals inside the project.</p></section>`;
}
function editInitialProjectGoal(field, value) {
  if (!['prompt', 'completionCriteria', 'nextStep'].includes(field)) return;
  projectSpaceDraft.initialGoal ||= {};
  projectSpaceDraft.initialGoal[field] = value;
  rememberProjectDraft();
}
async function createProjectGoalSpace() {
  if (projectSpaceSaving) return false;
  const draft = structuredClone(projectSpaceDraft);
  const initial = draft.initialGoal || {};
  const prompt = (initial.prompt ?? initial.title ?? '').trim();
  if (!draft.name.trim() || !prompt || !initial.completionCriteria?.trim()) {
    projectMessage('Give the project a name, a prompt, and a clear “Done when” condition.', true); return false;
  }
  const summary = prompt.replace(/\s+/g, ' ');
  const goalInput = { title: summary.length > 200 ? `${summary.slice(0, 199)}…` : summary,
    prompt, completionCriteria: initial.completionCriteria, nextStep: initial.nextStep || '' };
  projectSpaceSaving = true;
  const generation = projectSpaceLoad;
  const draftKey = projectDraftKey('new'), filesKey = projectFileKey(null);
  const fields = [...$('projectSpaceDetail').querySelectorAll('input, textarea, button, select')].filter(field => !field.disabled);
  fields.forEach(field => { field.disabled = true; });
  projectMessage('Creating project…');
  let space;
  let goalSaved = false;
  try {
    space = await projectApi('', projectJson('POST', draft));
    if (draftKey !== projectDraftKey('new')) return false;
    newProjectDrafts.delete(draftKey);
    try { sessionStorage.removeItem(draftKey); } catch {}
    projectFileQueues.set(projectFileKey(space.id), projectFileQueues.get(filesKey) || []);
    projectFileQueues.delete(filesKey);
    // Once the project exists, retries must save its goal, not create a second project.
    if (generation === projectSpaceLoad) {
      selectedProjectSpace = space;
      projectSpaceDraft = { ...space, dirty: false };
      projectSpaces = [space, ...projectSpaces.filter(row => row.id !== space.id)];
    }
    await workApi('/goals', 'POST', { projectId: space.id, ...goalInput });
    goalSaved = true;
    if (generation !== projectSpaceLoad) return true;
    projectSpaceTab = 'overview'; renderProjectSpaceList(); renderProjectSpaceDetail();
    if (!await flushProjectFiles(space.id)) return false;
    projectMessage('Project saved with its goal and files. Add more goals or choose a lead agent and Start work.');
    return true;
  } catch (error) {
    if (generation !== projectSpaceLoad) return false;
    if (space && !goalSaved) {
      projectGoalEditors.set(projectGoalKey(), { ...goalInput, id: null });
      rememberProjectGoalEditor();
      renderProjectSpaceList(); renderProjectSpaceDetail();
    }
    projectMessage(`${space ? 'Project saved; the goal still needs saving. ' : ''}${error.message}`, true);
    return false;
  } finally {
    projectSpaceSaving = false;
    fields.forEach(field => { if (field.isConnected) field.disabled = false; });
  }
}
function renderProjectGoalOverview() {
  $('projectSpaceTabBody').innerHTML = `<div id="projectFilesSection"></div><div class="project-goal-toolbar"><h3>Goals</h3><button data-action="editProjectGoal">Add Goal</button><button data-action="refreshProjectGoals">Refresh</button></div><div id="projectGoalEditor"></div><div id="projectGoalCards" aria-live="polite"><p class="project-empty">Loading goals…</p></div>`;
  renderProjectFiles();
  if (projectGoalData?.projectId === selectedProjectSpace.id) renderProjectGoalCards();
  renderProjectGoalEditor();
  refreshProjectGoals();
}
async function refreshProjectGoals() {
  const id = selectedProjectSpace?.id, key = projectGoalKey();
  if (!id || projectSpaceTab !== 'overview') return;
  const generation = ++projectGoalLoad;
  try {
    const data = await projectApi(`/${id}/goals`);
    if (generation !== projectGoalLoad || key !== projectGoalKey() || projectSpaceTab !== 'overview') return;
    projectGoalData = { ...data, projectId: id };
    const space = projectSpaces.find(row => row.id === id);
    if (space) space.goalSummary = { total: data.goals.length, active: data.goals.filter(goal => goal.status === 'active').length, completed: data.goals.filter(goal => goal.status === 'completed').length };
    renderProjectSpaceList();
    // Polling must never erase an editor, lead-agent selection or run instructions.
    if (!$('projectGoalCards')?.contains(document.activeElement)) renderProjectGoalCards();
  } catch (error) {
    if (generation !== projectGoalLoad || key !== projectGoalKey()) return;
    projectMessage(error.message, true);
    if ((!projectGoalData || projectGoalData.projectId !== id) && $('projectGoalCards')) $('projectGoalCards').innerHTML = '<p class="project-empty">Goals could not be loaded. Choose Refresh to retry.</p>';
  }
}
function goalRunDraft(goal) {
  const key = `${projectGoalKey()}:${goal.id}`;
  const savedPrompt = goal.prompt || '';
  if (!projectGoalRunDrafts.has(key)) projectGoalRunDrafts.set(key, { agentId: goal.run?.agentId || (typeof activeAgent === 'string' ? activeAgent : '') || agents[0]?.id || '', instructions: savedPrompt, savedPrompt });
  const draft = projectGoalRunDrafts.get(key);
  if (draft.savedPrompt !== savedPrompt) {
    if (draft.instructions === draft.savedPrompt) { draft.instructions = savedPrompt; delete draft.requestId; }
    draft.savedPrompt = savedPrompt;
  }
  return draft;
}
function editProjectGoalRun(id, field, value) {
  const goal = projectGoalData?.goals.find(row => row.id === id);
  if (!goal || !['agentId', 'instructions'].includes(field)) return;
  const draft = goalRunDraft(goal); draft[field] = value; delete draft.requestId;
}
function renderProjectGoalCards() {
  const container = $('projectGoalCards');
  if (!container || projectGoalData?.projectId !== selectedProjectSpace?.id) return;
  const goals = [...projectGoalData.goals].sort((a, b) => Number(b.run?.active || false) - Number(a.run?.active || false)
    || Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt.localeCompare(a.updatedAt));
  const completed = goals.filter(goal => goal.status === 'completed').length;
  const disabled = projectGoalBusy ? 'disabled' : '';
  container.innerHTML = `<p class="project-help">${completed} of ${goals.length} goals completed</p>${goals.map((goal, index) => {
    const run = goal.run, draft = goalRunDraft(goal);
    const status = run?.active || run?.status === 'waiting' ? projectGoalLabels[run.status] : goal.status === 'completed' ? 'Completed' : goal.status === 'paused' ? 'Paused' : goal.blocker ? 'Blocked' : projectGoalLabels[run?.status] || 'Ready to start';
    const settled = !run?.active && run?.status !== 'waiting';
    const startable = settled && goal.status !== 'completed' && !selectedProjectSpace.archived;
    return `<article class="project-goal-card" data-goal-id="${escHtml(goal.id)}" data-status="${escHtml(run?.status || goal.status)}"><div class="project-activity-heading"><span class="project-help">${index === 0 && goal.status === 'active' ? 'Current goal' : 'Goal'}</span><span class="project-status">${escHtml(status)}</span></div><h3>${escHtml(goal.title)}</h3><p class="project-goal-condition"><b>Done when</b><br>${escHtml(goal.completionCriteria)}</p>${goal.status !== 'completed' ? `<p><b>Next step:</b> ${escHtml(goal.nextStep || 'The lead agent will plan the first step.')}</p>` : ''}${goal.blocker ? `<p class="project-warning"><b>Blocker:</b> ${escHtml(goal.blocker)}</p>` : ''}${goal.dueAt ? `<p class="project-help">Due ${escHtml(new Date(goal.dueAt).toLocaleString())}</p>` : ''}
      ${run ? `<div class="project-goal-activity"><p class="project-help">${escHtml(agents.find(agent => agent.id === run.agentId)?.name || run.agentId)}${run.currentTool ? ` · ${escHtml(run.currentTool)}` : ''}${run.workers ? ` · ${run.workers} background ${run.workers === 1 ? 'agent' : 'agents'}` : ''}</p>${run.error ? `<p class="project-warning">${escHtml(run.error)}</p>` : ''}${run.preview ? `<p class="project-chat-preview">${escHtml(run.preview)}</p>` : ''}${run.status === 'review' ? '<p class="project-help">The work returned a result. The goal stays open until its completion condition is verified.</p>' : ''}</div>` : ''}
      ${startable ? `<label class="project-field"><span>Lead agent</span><select aria-label="Lead agent for ${escHtml(goal.title)}" data-change-action="editProjectGoalRun" data-change-args='${projectGoalArgs(goal.id, 'agentId', '$value')}'>${agents.map(agent => `<option value="${escHtml(agent.id)}" ${agent.id === draft.agentId ? 'selected' : ''}>${escHtml(agent.name)}${agent.model ? ` · ${escHtml(agent.model)}` : ''}</option>`).join('')}</select></label><label class="project-field project-run-options"><span>Instructions for this run</span><textarea aria-label="Instructions for this run" maxlength="12000" rows="6" placeholder="Enter instructions, constraints, or which agents should help." data-input-action="editProjectGoalRun" data-input-args='${projectGoalArgs(goal.id, 'instructions', '$value')}'>${escHtml(draft.instructions)}</textarea></label><p class="project-help">Adjust these instructions for this run. Leave blank to use the saved prompt, or choose Edit goal to change it.</p>` : ''}
      <div class="project-card-actions">${startable ? `<button class="project-primary" data-action="startProjectGoalWork" data-args='${projectGoalArgs(goal.id)}' ${disabled || (!agents.length ? 'disabled' : '')}>${run ? 'Continue work' : 'Start work'}</button>` : ''}${run ? `<button data-action="openProjectConversation" data-args='${projectGoalArgs(selectedProjectSpace.id, run.chatId, run.agentId)}'>${run.status === 'waiting' ? 'Respond in chat' : 'Open work conversation'}</button>` : ''}<button data-action="editProjectGoal" data-args='${projectGoalArgs(goal.id)}' ${disabled}>Edit goal</button>${run?.active || run?.status === 'waiting' || goal.status === 'active' ? `<button data-action="pauseProjectGoalWork" data-args='${projectGoalArgs(goal.id)}' ${disabled}>${!settled ? 'Pause work' : 'Pause goal'}</button>` : ''}${goal.status === 'completed' && settled ? `<button data-action="reopenProjectGoal" data-args='${projectGoalArgs(goal.id)}' ${disabled}>Reopen goal</button>` : ''}${goal.status !== 'completed' && settled ? `<button data-action="completeProjectGoalWork" data-args='${projectGoalArgs(goal.id)}' ${disabled}>Mark complete</button>` : ''}${goal.status !== 'active' && settled ? `<button data-action="removeProjectGoalWork" data-args='${projectGoalArgs(goal.id)}' ${disabled}>Remove goal</button>` : ''}</div>${startable ? '<p class="project-help">Runs in a separate project conversation so you can keep chatting. Results and requests for approval stay with this project.</p>' : ''}</article>`;
  }).join('') || '<p class="project-empty">Add a goal and define what finished means, then start work here.</p>'}`;
}
function editProjectGoal(id = null) {
  if (projectGoalBusy) return;
  if (typeof id !== 'string') id = null;
  const previous = projectGoalEditorDraft();
  if (previous && previous.id !== id) { projectMessage('Save or cancel your goal edits first.', true); return; }
  if (!previous) {
    const saved = id ? projectGoalData?.goals.find(goal => goal.id === id) : null;
    if (id && !saved) { projectMessage('This goal is no longer available. Refresh the project.', true); return; }
    projectGoalEditors.set(projectGoalKey(), saved ? { ...structuredClone(saved), _base: projectGoalValues(saved) } : { id: null, title: '', prompt: '', completionCriteria: '', nextStep: '', blocker: '', dueAt: null });
  }
  rememberProjectGoalEditor();
  renderProjectGoalEditor(); $('projectGoalTitle')?.focus();
}
function editProjectGoalField(field, value) {
  const goal = projectGoalEditorDraft();
  if (!goal || projectGoalBusy || !projectGoalFields.includes(field)) return;
  if (field === 'dueAt' && value && !Number.isFinite(Date.parse(value))) return;
  goal[field] = field === 'dueAt' ? (value ? new Date(value).toISOString() : null) : value;
  rememberProjectGoalEditor();
}
function projectGoalConflictField(goal, field) {
  if (!Object.hasOwn(goal._conflicts || {}, field)) return '';
  const value = goal._conflicts[field];
  return `<div class="project-warning project-goal-conflict"><b>Latest saved value</b><p>${escHtml(field === 'dueAt' && value ? new Date(value).toLocaleString() : value || '(empty)')}</p><div class="project-card-actions"><button data-action="resolveProjectGoalField" data-args='${projectGoalArgs(field, false)}'>Keep my edit</button><button data-action="resolveProjectGoalField" data-args='${projectGoalArgs(field, true)}'>Use saved value</button></div></div>`;
}
function resolveProjectGoalField(field, useSaved) {
  const goal = projectGoalEditorDraft();
  if (projectGoalBusy || !goal || !Object.hasOwn(goal._conflicts || {}, field)) return;
  if (useSaved) goal[field] = goal._conflicts[field];
  delete goal._conflicts[field];
  rememberProjectGoalEditor(); renderProjectGoalEditor();
}
async function reviewProjectGoalEdits() {
  const goal = projectGoalEditorDraft(), key = projectGoalKey(), id = selectedProjectSpace?.id;
  if (!goal?.id || projectGoalBusy || !id) return;
  projectGoalBusy = true;
  renderProjectGoalEditor();
  try {
    const data = await projectApi(`/${id}/goals`);
    if (key !== projectGoalKey()) return;
    const saved = data.goals.find(row => row.id === goal.id);
    if (!saved) throw new Error('This goal was removed. Your edits are still here; copy them before cancelling.');
    const latest = projectGoalValues(saved), mine = projectGoalValues(goal);
    const conflicts = {};
    for (const field of projectGoalFields) {
      if (goal._base && mine[field] === goal._base[field]) goal[field] = latest[field];
      else if (mine[field] !== latest[field] && (!goal._base || latest[field] !== goal._base[field])) conflicts[field] = latest[field];
    }
    Object.assign(goal, { revision: saved.revision, _base: latest, _conflicts: conflicts, _needsReview: false });
    projectGoalData = { ...data, projectId: id };
    rememberProjectGoalEditor();
    projectMessage(Object.keys(conflicts).length ? 'Choose which value to keep for each conflict, then save.' : 'Your edits and the latest saved progress have been combined. Review them, then save.');
  } catch (error) { if (key === projectGoalKey()) projectMessage(error.message, true); }
  finally { projectGoalBusy = false; renderProjectGoalEditor(); renderProjectGoalCards(); }
}
function renderProjectGoalEditor() {
  const container = $('projectGoalEditor'); if (!container) return;
  const goal = projectGoalEditorDraft();
  if (!goal) { container.innerHTML = ''; return; }
  const field = (key, label, limit, single = false) => {
    const attrs = `id="projectGoal${key === 'title' ? 'Title' : key}" maxlength="${limit}" data-input-action="editProjectGoalField" data-input-args='${projectGoalArgs(key, '$value')}'`;
    return `<label class="project-field"><span>${label}</span>${single ? `<input ${attrs} value="${escHtml(goal[key] || '')}">` : `<textarea ${attrs} rows="3">${escHtml(goal[key] || '')}</textarea>`}</label>${projectGoalConflictField(goal, key)}`;
  };
  const conflicts = Object.keys(goal._conflicts || {}).length;
  container.innerHTML = `<section class="project-goal-editor"><h3>${goal.id ? 'Edit goal' : 'Add a goal'}</h3>${goal._needsReview ? '<p class="project-warning">This goal changed while you were editing. Your edits are kept. Review the saved changes before saving again.</p><button data-action="reviewProjectGoalEdits">Review saved changes</button>' : ''}${field('title', 'Goal', 200, true)}${field('prompt', 'Prompt and instructions', 12000)}${field('completionCriteria', 'Done when', 2000)}${field('nextStep', 'Next step', 2000)}${field('blocker', 'Blocker (optional)', 1000, true)}<label class="project-field"><span>Deadline (optional, your local time)</span><input type="datetime-local" value="${escHtml(workLocalDate(goal.dueAt))}" data-change-action="editProjectGoalField" data-change-args='["dueAt","$value"]'></label>${projectGoalConflictField(goal, 'dueAt')}<div class="project-card-actions"><button class="project-primary" data-action="saveProjectGoal" ${projectGoalBusy || goal._needsReview || conflicts ? 'disabled' : ''}>Save goal</button><button data-action="cancelProjectGoalEdit">Cancel</button></div></section>`;
  if (projectGoalBusy) container.querySelectorAll('input, textarea, select, button').forEach(element => { element.disabled = true; });
}
function cancelProjectGoalEdit() { if (!projectGoalBusy) { projectGoalEditors.delete(projectGoalKey()); rememberProjectGoalEditor(); renderProjectGoalEditor(); } }
async function projectGoalMutation(operation, success, { editing = false } = {}) {
  if (projectGoalBusy) return;
  if (!editing && projectGoalEditorDraft()) { projectMessage('Save or cancel your goal edits first.', true); return; }
  const key = projectGoalKey(), editor = editing ? projectGoalEditorDraft() : null;
  projectGoalBusy = true;
  const fields = [...($('projectSpaceTabBody')?.querySelectorAll('#projectGoalEditor input, #projectGoalEditor textarea, #projectGoalEditor button, #projectGoalCards button, #projectGoalCards select, #projectGoalCards textarea, .project-goal-toolbar button') || [])].filter(field => !field.disabled);
  fields.forEach(field => { field.disabled = true; });
  try {
    const result = await operation();
    if (editing && projectGoalEditors.get(key) === editor) { projectGoalEditors.delete(key); rememberProjectGoalEditor(key); }
    if (key !== projectGoalKey()) return result;
    if (editing) renderProjectGoalEditor();
    await refreshProjectGoals();
    if (key === projectGoalKey()) projectMessage(typeof success === 'function' ? success(result) : success);
    return result;
  } catch (error) {
    if (editing && error.status === 409 && editor?.id && projectGoalEditors.get(key) === editor) {
      editor._needsReview = true; rememberProjectGoalEditor(key);
    }
    if (key === projectGoalKey()) projectMessage(error.message, true);
  }
  finally {
    projectGoalBusy = false;
    fields.forEach(field => { if (field.isConnected) field.disabled = false; });
    renderProjectGoalCards(); renderProjectGoalEditor();
  }
}
function saveProjectGoal() {
  const goal = projectGoalEditorDraft(); if (!goal) return;
  if (goal._needsReview || Object.keys(goal._conflicts || {}).length) { projectMessage('Review the saved changes and resolve each conflict before saving.', true); return; }
  const body = { title: goal.title, prompt: goal.prompt || '', completionCriteria: goal.completionCriteria, nextStep: goal.nextStep || '', blocker: goal.blocker || '', dueAt: goal.dueAt || null, projectId: selectedProjectSpace.id, ...(goal.id ? { revision: goal.revision } : {}) };
  return projectGoalMutation(() => workApi(goal.id ? `/goals/${goal.id}` : '/goals', goal.id ? 'PATCH' : 'POST', body), 'Goal saved. Start work when you are ready.', { editing: true });
}
function startProjectGoalWork(id) {
  const goal = projectGoalData?.goals.find(row => row.id === id); if (!goal) return;
  if (projectSpaceSaving || projectFileBusyKey === projectFileKey() || pendingProjectFiles().length) { projectMessage('Finish uploading your project files before starting work. Use Retry upload for any files still waiting.', true); return; }
  if (projectSpaceDraft?.dirty) { projectMessage('Save your project context in Context & tasks before starting work.', true); return; }
  const draft = goalRunDraft(goal); draft.requestId ||= crypto.randomUUID();
  return projectGoalMutation(async () => {
    const result = await projectApi(`/${selectedProjectSpace.id}/start-work`, projectJson('POST', { goalId: id, revision: goal.revision, agentId: draft.agentId, instructions: draft.instructions, requestId: draft.requestId }));
    delete draft.requestId;
    return result;
  }, result => result.duplicate ? 'This request already has a work conversation. Open it to see progress.' : 'Work started in the background. You can keep chatting; progress and results stay here.');
}
function pauseProjectGoalWork(id) {
  const goal = projectGoalData?.goals.find(row => row.id === id); if (!goal) return;
  return projectGoalMutation(() => projectApi(`/${selectedProjectSpace.id}/pause-work`, projectJson('POST', { goalId: id, revision: goal.revision })), 'Goal paused. Any running work has been asked to stop.');
}
function reopenProjectGoal(id) {
  const goal = projectGoalData?.goals.find(row => row.id === id); if (!goal) return;
  return projectGoalMutation(() => workApi(`/goals/${id}`, 'PATCH', { status: 'active', revision: goal.revision }), 'Goal reopened. Start work when you are ready.');
}
function completeProjectGoalWork(id) {
  const goal = projectGoalData?.goals.find(row => row.id === id);
  if (!goal || projectGoalBusy) return;
  if (!confirm(`Mark “${goal.title}” complete?\n\nConfirm that this condition has been met:\n${goal.completionCriteria}`)) return;
  return projectGoalMutation(() => projectApi(`/${selectedProjectSpace.id}/complete-goal`, projectJson('POST', { goalId: id, revision: goal.revision })), 'Goal completed.');
}
function removeProjectGoalWork(id) {
  const goal = projectGoalData?.goals.find(row => row.id === id);
  if (!goal || projectGoalBusy) return;
  if (!confirm(`Remove “${goal.title}”?\n\nThis removes the goal and its prepared drafts. Its work conversations and project files are kept.`)) return;
  return projectGoalMutation(() => projectApi(`/${selectedProjectSpace.id}/goals`, projectJson('DELETE', { goalId: id, revision: goal.revision })), 'Goal removed. Its work conversations and project files are kept.');
}
document.addEventListener('DOMContentLoaded', () => {
  setInterval(() => {
    if (!document.hidden && $('projectSpacesDialog')?.open && projectSpaceTab === 'overview' && selectedProjectSpace && !projectGoalBusy) refreshProjectGoals();
  }, 5000);
});
