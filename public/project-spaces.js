// A space belongs to this browser tab. Navigation creates a fresh chat reducer
// and socket so late events and drafts cannot cross conversation boundaries.
const activeProjectSpaceId = new URLSearchParams(location.search).get('project') || null;
let projectSpaces = [];
let selectedProjectSpace = null;
let projectSpaceDraft = null;
let projectSpaceTab = 'overview';
let projectSpaceLoad = 0;
let projectSpaceSaving = false;

function projectDraftKey(id) {
  return `oe.projectDraft.${typeof _currentUser !== 'undefined' ? _currentUser?.id || '' : ''}.${id}`;
}
async function projectApi(suffix = '', options = {}) {
  const response = await fetch(`/api/project-spaces${suffix}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Project request failed');
  return data;
}
function projectJson(method, body) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function projectMessage(message, error = false) {
  const element = $('projectSpaceMessage');
  element.textContent = message;
  element.classList.toggle('error', error);
}
function showProjectUnavailable(message) {
  $('projectSpaceBanner').hidden = false;
  $('projectSpaceName').textContent = message || 'Project unavailable';
  $('btnSend').disabled = true;
}
async function refreshProjectSpaceBanner() {
  if (!activeProjectSpaceId) return;
  try {
    const space = await projectApi(`/${encodeURIComponent(activeProjectSpaceId)}`);
    $('projectSpaceBanner').hidden = false;
    $('projectSpaceName').textContent = space.name;
    document.title = `${space.name} · OpenEnsemble`;
  } catch (error) { showProjectUnavailable(error.message); }
}
async function openProjectSpaces(id = activeProjectSpaceId) {
  if (typeof id !== 'string') id = activeProjectSpaceId;
  const dialog = $('projectSpacesDialog');
  if (!dialog.open) dialog.showModal();
  projectMessage('Loading projects…');
  try {
    projectSpaces = await projectApi();
    renderProjectSpaceList();
    if (id || projectSpaces.length) await selectProjectSpace(id || projectSpaces[0].id);
    else newProjectSpace();
    projectMessage('');
  } catch (error) { projectMessage(error.message, true); }
}
function closeProjectSpaces() { rememberProjectDraft(); $('projectSpacesDialog').close(); }
function projectArgs(value) { return escHtml(JSON.stringify([value])); }
function renderProjectSpaceList() {
  $('projectSpaceList').innerHTML = projectSpaces.map(space => `
    <button class="project-space-entry ${space.id === selectedProjectSpace?.id ? 'selected' : ''}" data-action="selectProjectSpace" data-args='${projectArgs(space.id)}'>
      <strong>${escHtml(space.name)}</strong><span>${space.archived ? 'Archived' : `${space.tasks.filter(t => !t.done).length} open ${space.tasks.filter(t => !t.done).length === 1 ? 'task' : 'tasks'}`}${space.id === activeProjectSpaceId ? ' · Current' : ''}</span>
    </button>`).join('') || '<p class="project-empty">Your projects will appear here.</p>';
}
function rememberProjectDraft() {
  if (!projectSpaceDraft || !selectedProjectSpace) return;
  try { sessionStorage.setItem(projectDraftKey(selectedProjectSpace.id), JSON.stringify(projectSpaceDraft)); } catch {}
}
async function selectProjectSpace(id) {
  rememberProjectDraft();
  const generation = ++projectSpaceLoad;
  try {
    const space = await projectApi(`/${encodeURIComponent(id)}`);
    if (generation !== projectSpaceLoad) return;
    selectedProjectSpace = space;
    projectSpaceDraft = { name: space.name, brief: space.brief, decisions: space.decisions, nextSteps: space.nextSteps, tasks: structuredClone(space.tasks), revision: space.revision };
    try {
      const draft = JSON.parse(sessionStorage.getItem(projectDraftKey(id)) || 'null');
      if (draft?.dirty && Number.isInteger(draft.revision) && Array.isArray(draft.tasks)) projectSpaceDraft = draft;
    } catch {}
    projectSpaceTab = 'overview';
    renderProjectSpaceList(); renderProjectSpaceDetail();
    projectMessage(projectSpaceDraft.dirty ? 'Restored your unsaved draft.' : '');
  } catch (error) { projectMessage(error.message, true); }
}
function newProjectSpace() {
  rememberProjectDraft(); ++projectSpaceLoad;
  selectedProjectSpace = null;
  projectSpaceDraft = { name: '', brief: '', decisions: '', nextSteps: '', tasks: [] };
  projectSpaceTab = 'overview';
  renderProjectSpaceList(); renderProjectSpaceDetail(); projectMessage('');
  $('projectFieldName')?.focus();
}
function editProjectField(field, value) {
  if (!['name', 'brief', 'decisions', 'nextSteps'].includes(field)) return;
  projectSpaceDraft[field] = value;
  projectSpaceDraft.dirty = true;
  rememberProjectDraft();
}
function projectField(field, label, placeholder, limit, single = false) {
  const attrs = `id="projectField${field[0].toUpperCase() + field.slice(1)}" maxlength="${limit}" data-input-action="editProjectField" data-input-args='["${field}","$value"]' placeholder="${escHtml(placeholder)}"`;
  return `<label class="project-field"><span>${label}</span>${single ? `<input ${attrs} value="${escHtml(projectSpaceDraft[field] || '')}">` : `<textarea ${attrs} rows="4">${escHtml(projectSpaceDraft[field] || '')}</textarea>`}</label>`;
}
function renderProjectSpaceDetail() {
  const space = selectedProjectSpace;
  $('projectSpaceDetail').innerHTML = `
    <div class="project-detail-heading"><div><h2>${space ? escHtml(space.name) : 'New project'}</h2><p>Keep your conversations and shared context together.</p></div>
    ${space ? `<button class="project-primary" data-action="enterProjectSpace" data-args='${projectArgs(space.id)}'>Open chat</button>` : ''}</div>
    ${space ? `<nav class="project-tabs" aria-label="Project sections">${[['overview', 'Overview'], ['files', 'Files'], ['chats', 'Chats']].map(([tab, label]) => `<button aria-pressed="${tab === projectSpaceTab}" data-action="setProjectSpaceTab" data-args='${projectArgs(tab)}'>${label}</button>`).join('')}</nav>` : ''}
    <div id="projectSpaceTabBody"></div>`;
  renderProjectSpaceTab();
  $('projectSpaceDetail').scrollTop = 0;
}
function setProjectSpaceTab(tab) {
  rememberProjectDraft(); projectSpaceTab = tab; renderProjectSpaceDetail();
}
function renderProjectSpaceTab() {
  const body = $('projectSpaceTabBody');
  const space = selectedProjectSpace;
  if (projectSpaceTab === 'files' && space) {
    body.innerHTML = `<p class="project-help">Files stay in your profile and are available to every agent working in this space. Removing a link keeps the original file.</p>
      <label class="project-upload">Add files<input type="file" multiple data-change-action="uploadProjectFiles" data-change-args='["$files"]'></label>
      <div class="project-file-list">${space.files.map(file => `<div class="project-file"><a href="/api/project-spaces/${space.id}/file?id=${encodeURIComponent(file.fileId)}">${escHtml(file.name)}</a><button data-action="removeProjectFile" data-args='${projectArgs(file.fileId)}' aria-label="Remove ${escHtml(file.name)} from project">Remove link</button></div>`).join('') || '<p class="project-empty">Add reference documents, images, or other project files.</p>'}</div>`;
    return;
  }
  if (projectSpaceTab === 'chats' && space) {
    const id = space.id;
    body.innerHTML = '<p class="project-empty">Loading conversations…</p>';
    projectApi(`/${id}/chats`).then(chats => {
      if (selectedProjectSpace?.id !== id || projectSpaceTab !== 'chats') return;
      body.innerHTML = chats.map(chat => `<button class="project-chat" data-action="enterProjectAgent" data-args='${escHtml(JSON.stringify([id, chat.agentId]))}'><strong>${escHtml(chat.emoji || '🤖')} ${escHtml(chat.name)}</strong><span>${chat.count ? escHtml(chat.preview) : 'Start a conversation in this project'}</span></button>`).join('') || '<p class="project-empty">Create an agent to start chatting.</p>';
    }).catch(error => projectMessage(error.message, true));
    return;
  }
  body.innerHTML = `${projectField('name', 'Project name', 'Voice firmware', 100, true)}
    ${projectField('brief', 'Shared brief', 'What are we building? Include the goal, important constraints, and useful background.', 12000)}
    ${projectField('decisions', 'Decisions', 'Record choices the agents should keep following.', 12000)}
    ${projectField('nextSteps', 'Current state and next steps', 'Where did we leave off? What should happen next?', 12000)}
    <section class="project-checklist"><h3>Checklist</h3><div id="projectChecklist"></div><div class="project-task-input"><input id="projectNewTask" maxlength="1000" placeholder="Add a task" aria-label="New project task"><button data-action="addProjectTask">Add</button></div></section>
    <div class="project-save-row"><button id="projectSave" class="project-primary" data-action="saveProjectSpace">${space ? 'Save changes' : 'Create project'}</button>
    ${space ? `<button data-action="reloadProjectDraft">Reload saved version</button><button data-action="archiveProjectSpace">${space.archived ? 'Unarchive' : 'Archive'}</button>` : ''}</div>`;
  renderProjectChecklist();
}
function renderProjectChecklist() {
  $('projectChecklist').innerHTML = projectSpaceDraft.tasks.map(task => `<div class="project-task"><label><input type="checkbox" ${task.done ? 'checked' : ''} data-change-action="toggleProjectTask" data-change-args='${escHtml(JSON.stringify([task.id, '$checked']))}'><span>${escHtml(task.text)}</span></label><button data-action="removeProjectTask" data-args='${projectArgs(task.id)}' aria-label="Remove task">×</button></div>`).join('');
}
function addProjectTask() {
  const text = $('projectNewTask').value.trim();
  if (!text) return;
  if (projectSpaceDraft.tasks.length >= 100) { projectMessage('You can keep up to 100 checklist items.', true); return; }
  projectSpaceDraft.tasks.push({ id: crypto.randomUUID(), text, done: false });
  projectSpaceDraft.dirty = true; rememberProjectDraft(); renderProjectChecklist(); $('projectNewTask').value = '';
}
function toggleProjectTask(id, done) {
  const task = projectSpaceDraft.tasks.find(task => task.id === id);
  if (task) task.done = done;
  projectSpaceDraft.dirty = true; rememberProjectDraft();
}
function removeProjectTask(id) {
  projectSpaceDraft.tasks = projectSpaceDraft.tasks.filter(task => task.id !== id);
  projectSpaceDraft.dirty = true; rememberProjectDraft(); renderProjectChecklist();
}
async function saveProjectSpace() {
  if (projectSpaceSaving) return false;
  projectSpaceSaving = true;
  const before = selectedProjectSpace?.id;
  const sent = JSON.stringify(projectSpaceDraft);
  try {
    const space = await projectApi(before ? `/${before}` : '', projectJson(before ? 'PATCH' : 'POST', projectSpaceDraft));
    if (selectedProjectSpace?.id !== before) return true;
    selectedProjectSpace = space;
    const editedDuringSave = sent !== JSON.stringify(projectSpaceDraft);
    projectSpaceDraft.revision = space.revision;
    projectSpaceDraft.dirty = editedDuringSave;
    rememberProjectDraft();
    projectSpaces = [space, ...projectSpaces.filter(p => p.id !== space.id)];
    renderProjectSpaceList(); renderProjectSpaceDetail();
    projectMessage(editedDuringSave ? 'Saved. Your newer edits still need saving.' : 'Project saved. Shared context applies to the next message.');
    refreshProjectSpaceBanner(); return true;
  } catch (error) { projectMessage(error.message, true); return false; }
  finally { projectSpaceSaving = false; }
}
function reloadProjectDraft() {
  if (projectSpaceDraft?.dirty && !confirm('Discard your unsaved project edits and load the saved version?')) return;
  projectSpaceDraft.dirty = false;
  try { sessionStorage.removeItem(projectDraftKey(selectedProjectSpace.id)); } catch {}
  selectProjectSpace(selectedProjectSpace.id);
}
async function archiveProjectSpace() {
  projectSpaceDraft.archived = !selectedProjectSpace.archived;
  projectSpaceDraft.dirty = true; rememberProjectDraft(); await saveProjectSpace();
}
function enterProjectSpace(id) {
  rememberProjectDraft();
  if (id === activeProjectSpaceId) { closeProjectSpaces(); return; }
  const url = new URL(location.href); url.searchParams.delete('agent');
  if (id) url.searchParams.set('project', id); else url.searchParams.delete('project');
  location.assign(url.pathname + url.search);
}
function enterProjectAgent(id, agent) {
  rememberProjectDraft();
  if (id === activeProjectSpaceId) { closeProjectSpaces(); switchAgent(agent); return; }
  const url = new URL(location.href); url.searchParams.set('project', id); url.searchParams.set('agent', agent);
  location.assign(url.pathname + url.search);
}
async function uploadProjectFiles(files) {
  const id = selectedProjectSpace?.id;
  if (!id) return;
  try {
    for (const file of Array.from(files || [])) {
      if (selectedProjectSpace?.id !== id) return;
      projectMessage(`Uploading ${file.name}…`);
      const priorRevision = selectedProjectSpace.revision;
      const data = new FormData(); data.append('file', file);
      const response = await fetch('/api/chat-upload', { method: 'POST', body: data });
      const uploaded = await response.json();
      if (!response.ok) throw new Error(uploaded.error || 'Upload failed');
      const space = await projectApi(`/${id}/files`, projectJson('POST', { revision: priorRevision, fileId: uploaded.file_id, name: file.name }));
      if (selectedProjectSpace?.id !== id) return;
      if (projectSpaceDraft.revision === priorRevision) projectSpaceDraft.revision = space.revision;
      selectedProjectSpace = space; rememberProjectDraft();
    }
    renderProjectSpaceTab(); projectMessage('Files added to the project.');
  } catch (error) { projectMessage(error.message, true); }
}
async function removeProjectFile(fileId) {
  try {
    const id = selectedProjectSpace.id;
    const priorRevision = selectedProjectSpace.revision;
    const space = await projectApi(`/${id}/files`, projectJson('DELETE', { revision: selectedProjectSpace.revision, fileId }));
    if (selectedProjectSpace?.id !== id) return;
    if (projectSpaceDraft.revision === priorRevision) projectSpaceDraft.revision = space.revision;
    selectedProjectSpace = space; rememberProjectDraft(); renderProjectSpaceTab();
    projectMessage('File link removed. The original file is still in your profile.');
  } catch (error) { projectMessage(error.message, true); }
}
document.addEventListener('DOMContentLoaded', () => {
  $('projectSpacesDialog').addEventListener('cancel', rememberProjectDraft);
  if (activeProjectSpaceId) refreshProjectSpaceBanner();
});
