let _workData = { goals: [], items: [], metrics: {} };
let _workProjects = [];
let _workProjectId = null;
let _workEditing = null;
let _workBusy = false;
let _workProfile = null;
let _workLoadSequence = 0;

const _workArgs = (...args) => escHtml(JSON.stringify(args));
async function workApi(suffix = '', method = 'GET', body) {
  const response = await fetch(`/api/proactive-work${suffix}`, { method, cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not load saved work');
  return result;
}
function workMessage(text, error = false) {
  const message = $('proactiveWorkMessage');
  if (!message) return;
  message.textContent = text;
  message.classList.toggle('error', error);
}
async function openProactiveWork(projectId = null, itemId = null) {
  // Event delegation appends the DOM event even when no data-args were given.
  projectId = typeof projectId === 'string' && /^space_[a-f0-9]{24}$/.test(projectId) ? projectId : null;
  itemId = typeof itemId === 'string' ? itemId : null;
  const sequence = ++_workLoadSequence;
  const profile = typeof _currentUser !== 'undefined' ? _currentUser?.id : null;
  if (_workProfile !== profile) { _workData = { goals: [], items: [], metrics: {} }; _workEditing = null; _workProfile = profile; }
  _workProjectId = projectId || null;
  _workEditing = null;
  const dialog = $('proactiveWorkDialog');
  if (!dialog.open) dialog.showModal();
  $('sbtnWork')?.classList.remove('has-update');
  workMessage('Loading goals and prepared work…');
  try {
    const [data, response] = await Promise.all([workApi(_workProjectId ? `?projectId=${encodeURIComponent(_workProjectId)}` : ''), fetch('/api/project-spaces', { cache: 'no-store' })]);
    if (!response.ok) throw new Error('Could not load project choices');
    const projects = await response.json();
    if (sequence !== _workLoadSequence) return;
    _workProjects = projects; _workData = data;
    renderProactiveWork(); workMessage('');
    if (itemId) {
      const item = document.getElementById(`prepared-${itemId}`);
      if (item) { item.open = true; item.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    }
  } catch (error) { workMessage(error.message, true); }
}
function closeProactiveWork() { if (!_workBusy) $('proactiveWorkDialog').close(); }
function workDate(value) { return value ? new Date(value).toLocaleString() : 'No deadline'; }
function workKindLabel(kind) {
  return ({ 'meeting-prep': 'Meeting preparation', 'document-summary': 'Document summary', 'draft-reply': 'Reply draft', comparison: 'Comparison', 'project-next-step': 'Project next steps', 'task-recovery': 'Task recovery' })[kind] || kind;
}
function workArtifactHtml(markdown) {
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return `<pre>${escHtml(markdown)}</pre>`;
  return DOMPurify.sanitize(marked.parse(markdown), {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'a'],
    ALLOWED_ATTR: ['href', 'title'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
}
function renderProactiveWork() {
  const project = _workProjects.find(row => row.id === _workProjectId);
  $('proactiveWorkScope').textContent = project ? project.name : 'All projects and general goals';
  const metrics = _workData.metrics;
  $('proactiveWorkBody').innerHTML = `
    <div class="work-intro"><p>Keep track of unfinished work and review what OE has prepared.</p>
      <p>${!_workData.enabled ? 'Set up a personalization model to prepare drafts here. Goals remain available in chat.' : _workData.workMode === 'off' ? 'Background preparation is off. Goals still carry into chat; you can prepare individual drafts here.' : _workData.workMode === 'prepare' ? 'OE can prepare private drafts in the background. It checks goals, upcoming meetings, linked replies, and task failures.' : 'OE suggests useful preparation. Choose Prepare to create a draft.'}</p>
      <div class="work-actions"><button data-action="newWorkGoal">+ Add goal</button><button data-action="openWorkSettings">Preparation settings</button></div>
      <small>${metrics.prepared || 0} prepared · ${metrics.used || 0} used · ${metrics.useful || 0} marked useful · ${metrics.dismissed || 0} dismissed · ${metrics.completedGoals || 0} goals completed</small>
    </div><div id="workGoalEditor"></div>
    <section><h3>Goals</h3><div class="work-goals">${_workData.goals.map(goal => `<article class="work-goal"><div><strong>${escHtml(goal.title)}</strong><span class="work-tag">${escHtml(goal.status)}</span>
      <p>${escHtml(goal.nextStep || 'Choose the next step')}</p>${goal.blocker ? `<p>Blocked by: ${escHtml(goal.blocker)}</p>` : ''}
      <small>${escHtml(workDate(goal.dueAt))} · Done when: ${escHtml(goal.completionCriteria)}</small></div>
      <div class="work-actions"><button data-action="editWorkGoal" data-args='${_workArgs(goal.id)}'>Edit</button>
      ${goal.status === 'active' ? `<button data-action="prepareWorkGoal" data-args='${_workArgs(goal.id)}'>Prepare next step</button><button data-action="setWorkGoalStatus" data-args='${_workArgs(goal.id, 'paused')}'>Pause</button><button data-action="setWorkGoalStatus" data-args='${_workArgs(goal.id, 'completed')}'>Mark complete</button>` : `<button data-action="setWorkGoalStatus" data-args='${_workArgs(goal.id, 'active')}'>Resume</button><button data-action="removeWorkGoal" data-args='${_workArgs(goal.id)}'>Remove</button>`}</div></article>`).join('') || '<p class="work-empty">Add a goal with a clear completion condition, or ask your agent to track one in chat.</p>'}</div></section>
    <section><h3>Prepared work and suggestions</h3>${_workData.items.map(item => `<details class="work-item" id="prepared-${escHtml(item.id)}"><summary><span>${escHtml(item.title)}</span><span class="work-tag">${escHtml(item.status)}</span></summary>
      <p>${escHtml(item.summary || item.reason)}</p><small>${escHtml(workKindLabel(item.kind))} · ${escHtml(workDate(item.dueAt))}</small>
      <p class="work-why">Why this appeared: ${escHtml(item.reason)}${item.deliveryReason ? `. ${escHtml(item.deliveryReason)}` : ''}</p>
      ${item.error ? `<p class="error">${escHtml(item.error)}</p>` : ''}
      ${item.status === 'running' ? '<p role="status">Preparation is running. Reopen this view to see its result.</p>' : ''}
      ${item.markdown ? `<div class="work-artifact">${workArtifactHtml(item.markdown)}</div>` : ''}
      ${item.nextStep && item.projectId ? `<p><b>Proposed next steps:</b> ${escHtml(item.nextStep)}</p>${item.checklist?.length ? `<ul>${item.checklist.map(text => `<li>${escHtml(text)}</li>`).join('')}</ul>` : ''}` : ''}
      ${item.references?.some(ref => ref.truncated) ? '<small>Some references were shortened to fit the preparation limit.</small>' : ''}
      ${item.references?.length ? `<p class="work-why">Reference files: ${item.references.map(ref => escHtml(ref.id)).join(', ')}</p>` : ''}
      <div class="work-actions">${['suggested', 'failed'].includes(item.status) ? `<button data-action="prepareSavedWork" data-args='${_workArgs(item.id)}'>${item.status === 'failed' ? 'Retry preparation' : 'Prepare'}</button>` : ''}
      ${item.markdown ? `<button data-action="downloadPreparedWork" data-args='${_workArgs(item.id)}'>Download draft</button>` : ''}
      ${item.status === 'ready' ? `<button data-action="giveWorkFeedback" data-args='${_workArgs(item.id, 'useful')}'>Useful</button><button data-action="giveWorkFeedback" data-args='${_workArgs(item.id, 'acted')}'>I used this</button><button data-action="giveWorkFeedback" data-args='${_workArgs(item.id, 'not_useful')}'>Not useful</button>
      ${item.projectId && (item.nextStep || item.checklist?.length) && !item.appliedAt ? `<button data-action="applyPreparedProject" data-args='${_workArgs(item.id)}'>Use proposed next steps and add checklist</button>` : ''}` : ''}
      ${['suggested', 'ready', 'running', 'failed'].includes(item.status) ? `<button data-action="giveWorkFeedback" data-args='${_workArgs(item.id, 'snoozed')}'>Snooze 1 day</button><button data-action="giveWorkFeedback" data-args='${_workArgs(item.id, 'dismissed')}'>Dismiss</button>` : ''}</div>
      ${item.feedback ? `<small>Your feedback: ${escHtml(item.feedback)}</small>` : ''}${item.appliedAt ? '<small>Project suggestion applied.</small>' : ''}</details>`).join('') || '<p class="work-empty">Preparations will appear here with their sources and the reason they were suggested.</p>'}</section>`;
}
function workLocalDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function newWorkGoal() { editWorkGoal(null); }
function editWorkGoal(id) {
  _workEditing = id ? _workData.goals.find(goal => goal.id === id) : null;
  const goal = _workEditing || {};
  const projectId = goal.projectId || _workProjectId;
  $('workGoalEditor').innerHTML = `<section class="work-editor"><h3>${id ? 'Edit goal' : 'New goal'}</h3>
    <label>Goal<input id="workGoalTitle" maxlength="200" value="${escHtml(goal.title || '')}" required></label>
    <label>Project<select id="workGoalProject" ${id ? 'disabled' : ''}><option value="">General</option>${_workProjects.filter(project => !project.archived || project.id === projectId).map(project => `<option value="${escHtml(project.id)}" ${project.id === projectId ? 'selected' : ''}>${escHtml(project.name)}</option>`).join('')}</select></label>
    <label>Done when<textarea id="workGoalCompletion" maxlength="2000" placeholder="What result will mean this is finished?">${escHtml(goal.completionCriteria || '')}</textarea></label>
    <label>Next step<textarea id="workGoalNext" maxlength="2000">${escHtml(goal.nextStep || '')}</textarea></label>
    <label>Blocked by<input id="workGoalBlocker" maxlength="1000" value="${escHtml(goal.blocker || '')}"></label>
    <div class="work-fields"><label>Deadline (your local time)<input id="workGoalDue" type="datetime-local" value="${escHtml(workLocalDate(goal.dueAt))}"></label><label>Next check (optional)<input id="workGoalCheck" type="datetime-local" value="${escHtml(workLocalDate(goal.checkAt))}"></label></div>
    <label>Preparation<select id="workGoalKind">${['project-next-step', 'meeting-prep', 'document-summary', 'draft-reply', 'comparison', 'task-recovery'].map(kind => `<option value="${kind}" ${goal.kind === kind ? 'selected' : ''}>${workKindLabel(kind)}</option>`).join('')}</select></label>
    <label>Reference file IDs (optional, one per line)<textarea id="workGoalFiles" placeholder="documents:doc_…">${escHtml((goal.fileIds || []).join('\n'))}</textarea></label>
    <p class="work-why">Project preparations can use the saved project notes and linked files. An agent can attach an exact Gmail thread or scheduled task while tracking a goal in chat.</p>
    <div class="work-actions"><button data-action="saveWorkGoal">Save goal</button><button data-action="cancelWorkGoalEdit">Cancel</button></div></section>`;
  $('workGoalTitle').focus();
}
function cancelWorkGoalEdit() { if (!_workBusy) { $('workGoalEditor').innerHTML = ''; _workEditing = null; } }
async function workMutation(operation, success, { preserveEditor = false } = {}) {
  if (_workBusy) return;
  if (!preserveEditor && $('workGoalEditor')?.textContent) { workMessage('Save or cancel your goal edits first.', true); return; }
  _workBusy = true;
  $('proactiveWorkBody').querySelectorAll('button').forEach(button => { button.disabled = true; });
  workMessage('Working…');
  try {
    const result = await operation();
    const data = await workApi(_workProjectId ? `?projectId=${encodeURIComponent(_workProjectId)}` : '');
    _workData = data; _workEditing = null; renderProactiveWork(); workMessage(success);
    return result;
  } catch (error) { workMessage(error.message, true); }
  finally { _workBusy = false; $('proactiveWorkBody').querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
async function saveWorkGoal() {
  const date = id => $(id).value ? new Date($(id).value).toISOString() : null;
  try {
    const body = { title: $('workGoalTitle').value, completionCriteria: $('workGoalCompletion').value, nextStep: $('workGoalNext').value,
      blocker: $('workGoalBlocker').value, dueAt: date('workGoalDue'), checkAt: date('workGoalCheck'), kind: $('workGoalKind').value,
      fileIds: $('workGoalFiles').value.split('\n').map(value => value.trim()).filter(Boolean), projectId: $('workGoalProject').value || null };
    const goal = _workEditing;
    if (goal) body.revision = goal.revision;
    await workMutation(() => workApi(goal ? `/goals/${goal.id}` : '/goals', goal ? 'PATCH' : 'POST', body), 'Goal saved.', { preserveEditor: true });
  } catch (error) { workMessage(error.message, true); }
}
function setWorkGoalStatus(id, status) {
  const goal = _workData.goals.find(row => row.id === id);
  return workMutation(() => workApi(`/goals/${id}`, 'PATCH', { revision: goal.revision, status }), `Goal ${status}.`);
}
function removeWorkGoal(id) {
  const goal = _workData.goals.find(row => row.id === id);
  return workMutation(() => workApi(`/goals/${id}`, 'DELETE', { revision: goal.revision }), 'Goal and its preparations removed.');
}
function prepareWorkGoal(id) { return workMutation(() => workApi(`/goals/${id}/prepare`, 'POST', {}), 'Private draft prepared.'); }
function prepareSavedWork(id) { return workMutation(() => workApi(`/items/${id}/prepare`, 'POST', {}), 'Private draft prepared.'); }
function giveWorkFeedback(id, outcome) { return workMutation(() => workApi(`/items/${id}/feedback`, 'POST', { outcome }), outcome === 'snoozed' ? 'Snoozed for one day.' : 'Feedback saved.'); }
function applyPreparedProject(id) { return workMutation(() => workApi(`/items/${id}/apply-project`, 'POST', {}), 'Proposed next steps and checklist saved to the project.'); }
function downloadPreparedWork(id) {
  const item = _workData.items.find(row => row.id === id);
  if (!item?.markdown) return;
  const url = URL.createObjectURL(new Blob([item.markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${item.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 80) || 'prepared-work'}.md`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function openWorkSettings() {
  if (_workBusy) return;
  $('proactiveWorkDialog').close();
  if ($('projectSpacesDialog')?.open && typeof closeProjectSpaces === 'function') closeProjectSpaces();
  await openSettingsDrawer(); switchSettingsTab('personalization');
}
async function setWorkPreparationMode(mode) {
  if (!['off', 'suggest', 'prepare'].includes(mode)) return;
  return _pzPatchConfig({ workMode: mode }, 'Could not update preparation mode');
}
function showPreparedWorkNotice(message) {
  showToast(message.title || 'OE has prepared something for you.');
  const button = $('sbtnWork');
  if (button) button.classList.add('has-update');
}
