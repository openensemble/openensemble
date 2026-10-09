// A space belongs to this browser tab. Navigation creates a fresh chat reducer
// and socket so late events and drafts cannot cross conversation boundaries.
const activeProjectSpaceId = new URLSearchParams(location.search).get('project') || null;
let projectSpaces = [];
let selectedProjectSpace = null;
let projectSpaceDraft = null;
let projectSpaceTab = 'overview';
let projectSpaceLoad = 0;
let projectSpaceSaving = false;
let projectSpaceDeleting = null;
const newProjectDrafts = new Map();
const deletedProjectSpaceIds = new Set();

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
  if (projectSpaceSaving) return;
  if (typeof id !== 'string') id = activeProjectSpaceId;
  const generation = ++projectSpaceLoad;
  const profileKey = projectDraftKey('new');
  const dialog = $('projectSpacesDialog');
  if (!dialog.open) dialog.showModal();
  projectMessage('Loading projects…');
  try {
    const spaces = await projectApi();
    if (profileKey !== projectDraftKey('new')) return;
    if (generation !== projectSpaceLoad) {
      // A click on Add Project wins over the default selection, but keep the list.
      if (!selectedProjectSpace && !projectSpaceSaving) {
        projectSpaces = spaces.filter(space => !deletedProjectSpaceIds.has(space.id));
        renderProjectSpaceList();
      }
      return;
    }
    projectSpaces = spaces.filter(space => !deletedProjectSpaceIds.has(space.id));
    renderProjectSpaceList();
    projectMessage('');
    if (id || projectSpaces.length) await selectProjectSpace(id || projectSpaces[0].id);
    else newProjectSpace();
  } catch (error) { if (generation === projectSpaceLoad) projectMessage(error.message, true); }
}
function closeProjectSpaces() { rememberProjectDraft(); $('projectSpacesDialog').close(); }
function projectArgs(value) { return escHtml(JSON.stringify([value])); }
function renderProjectSpaceList() {
  $('projectSpaceList').innerHTML = projectSpaces.map(space => `
    <button class="project-space-entry ${space.id === selectedProjectSpace?.id ? 'selected' : ''}" data-action="selectProjectSpace" data-args='${projectArgs(space.id)}'>
      <strong>${escHtml(space.name)}</strong><span>${space.archived ? 'Archived' : escHtml(projectGoalSummary(space))}${space.id === activeProjectSpaceId ? ' · Current' : ''}</span>
    </button>`).join('') || '<p class="project-empty">Your projects will appear here.</p>';
}
function rememberProjectDraft() {
  if (!projectSpaceDraft) return;
  if (!selectedProjectSpace) newProjectDrafts.set(projectDraftKey('new'), projectSpaceDraft);
  try { sessionStorage.setItem(projectDraftKey(selectedProjectSpace?.id || 'new'), JSON.stringify(projectSpaceDraft)); } catch {}
}
async function selectProjectSpace(id) {
  if (projectSpaceSaving) return;
  rememberProjectDraft();
  const generation = ++projectSpaceLoad;
  const profileKey = projectDraftKey('new');
  try {
    const space = await projectApi(`/${encodeURIComponent(id)}`);
    if (generation !== projectSpaceLoad || profileKey !== projectDraftKey('new') || deletedProjectSpaceIds.has(id)) return;
    selectedProjectSpace = space;
    projectSpaceDraft = { name: space.name, brief: space.brief, decisions: space.decisions, nextSteps: space.nextSteps, tasks: structuredClone(space.tasks), revision: space.revision };
    try {
      const draft = JSON.parse(sessionStorage.getItem(projectDraftKey(id)) || 'null');
      if (draft?.dirty && Number.isInteger(draft.revision) && Array.isArray(draft.tasks)) projectSpaceDraft = draft;
    } catch {}
    projectSpaceTab = 'overview';
    renderProjectSpaceList(); renderProjectSpaceDetail();
    projectMessage(projectSpaceDraft.dirty ? 'Restored your unsaved draft.' : '');
  } catch (error) { if (generation === projectSpaceLoad && profileKey === projectDraftKey('new')) projectMessage(error.message, true); }
}
function newProjectSpace() {
  if (projectSpaceSaving) return;
  rememberProjectDraft(); ++projectSpaceLoad;
  selectedProjectSpace = null;
  projectSpaceDraft = newProjectDrafts.get(projectDraftKey('new')) || { name: '', brief: '', decisions: '', nextSteps: '', tasks: [] };
  try {
    const draft = JSON.parse(sessionStorage.getItem(projectDraftKey('new')) || 'null');
    if (draft && typeof draft.name === 'string' && Array.isArray(draft.tasks)) projectSpaceDraft = draft;
  } catch {}
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
    <div class="project-detail-heading"><div><h2>${space ? escHtml(space.name) : 'New Project'}</h2><p>${space ? 'Your goals, files, work, and results in one place.' : 'Name your project, define what it should accomplish, and add the files your agent will need.'}</p></div>
    ${space ? `<button class="project-primary" data-action="enterProjectSpace" data-args='${projectArgs(space.id)}'>Open chat</button>` : ''}</div>
    ${space ? `<nav class="project-tabs" aria-label="Project sections">${[['overview', 'Overview'], ['files', 'Files'], ['outputs', 'Outputs'], ['chats', 'Chats & activity'], ['context', 'Context & tasks'], ['saved', 'Saved results'], ['progress', 'Checkpoints']].map(([tab, label]) => `<button aria-pressed="${tab === projectSpaceTab}" data-action="setProjectSpaceTab" data-args='${projectArgs(tab)}'>${label}</button>`).join('')}</nav>` : ''}
    ${space?.origin === 'general-goals-v1' ? '<p class="project-help">Goals from general chat are collected here with their saved progress and reference files. General chat can still access them; their earlier conversations remain in general chat. Prepared drafts remain available in the Projects drawer.</p>' : ''}
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
  if (projectSpaceTab === 'overview' && space) { renderProjectGoalOverview(); return; }
  if (projectSpaceTab === 'saved' && space) { renderProjectSavedResults(); return; }
  if (projectSpaceTab === 'outputs' && space) { loadProjectOutputs(); return; }
  if (projectSpaceTab === 'progress' && space) {
    loadProjectProgress();
    return;
  }
  if (projectSpaceTab === 'files' && space) {
    body.innerHTML = '<div id="projectFilesSection"></div>';
    renderProjectFiles();
    return;
  }
  if (projectSpaceTab === 'chats' && space) {
    body.innerHTML = '<div class="project-activity-toolbar"><input id="projectChatSearch" aria-label="Search project chats" placeholder="Search chats or agents" data-input-action="filterProjectChats" data-input-args=\'["$value"]\'><button data-action="loadProjectActivity">Refresh</button><button data-action="createProjectChat">+ New chat</button></div><div id="projectActivityRows" aria-live="polite">Loading conversations…</div>';
    loadProjectActivity();
    return;
  }
  body.innerHTML = `${projectField('name', 'Project name', 'Document review', 100, true)}
    ${!space ? initialProjectGoalFields() : ''}
    ${!space ? '<div id="projectFilesSection"></div><details><summary>Additional context and tasks (optional)</summary>' : ''}
    ${projectField('brief', 'Shared context', 'Add constraints and useful background for agents working toward this goal.', 12000)}
    ${projectField('decisions', 'Decisions', 'Record choices the agents should keep following.', 12000)}
    ${projectField('nextSteps', 'Current state and next steps', 'Where did we leave off? What should happen next?', 12000)}
    <section class="project-checklist"><h3>Tasks</h3><p class="project-help">Assign work, track prerequisites, and record results. Assignments do not start an agent automatically. Use the same workspace and file paths to spot overlapping work.</p><div id="projectTaskWarnings" role="status"></div><div id="projectChecklist"></div><div class="project-task-input"><input id="projectNewTask" maxlength="1000" placeholder="Add a task" aria-label="New project task"><button data-action="addProjectTask">Add</button></div></section>
    ${!space ? '</details>' : ''}
    <div class="project-save-row"><button id="projectSave" class="project-primary" data-action="saveProjectSpace">${space ? 'Save changes' : 'Create Project'}</button>
    ${space ? `<button data-action="reloadProjectDraft">Reload saved version</button><button data-action="archiveProjectSpace">${space.archived ? 'Unarchive' : 'Archive'}</button>` : ''}</div>
    ${space ? '<div class="project-delete-row"><button id="projectDelete" class="project-danger" data-action="deleteSelectedProjectSpace">Delete project</button><p class="project-help">Permanently remove this project and its conversations. Files in your profile are kept.</p></div>' : ''}`;
  renderProjectChecklist();
  if (!space) renderProjectFiles();
}
async function loadProjectProgress(offset = 0) {
  if (!Number.isInteger(offset)) offset = 0;
  const id = selectedProjectSpace?.id;
  const body = $('projectSpaceTabBody');
  body.innerHTML = '<p class="project-empty">Loading saved progress…</p>';
  try {
    const data = await projectApi(`/${id}/progress?offset=${offset}`);
    if (selectedProjectSpace?.id !== id || projectSpaceTab !== 'progress') return;
    body.innerHTML = `<p class="project-help">Save a checkpoint from Chats & activity at any time. Conversations are also saved before clearing context or trimming older history. Handoffs remain available to your agents.</p>
      <button data-action="loadProjectProgress">Refresh</button>
      ${data.checkpoints.map(item => `<details class="project-progress-entry"><summary>${escHtml(new Date(item.savedAt).toLocaleString())} · ${item.reason === 'clear' ? 'Context cleared' : item.reason === 'manual' ? 'Checkpoint saved' : 'Older conversation saved'}</summary>
        <p class="project-help">${escHtml(agents.find(agent => agent.id === item.agentId)?.name || item.agentId)} · ${item.messageCount} messages · ${item.summaryKind === 'generated' ? 'Handoff summary' : 'Conversation excerpts'}</p>
        <pre>${escHtml(item.summary)}</pre><a href="/api/project-spaces/${id}/progress-file?id=${item.id}">Download saved conversation</a></details>`).join('') || '<p class="project-empty">Your chat is saved as you work. A handoff will appear here when context is cleared or older history is trimmed.</p>'}
      <div class="project-save-row">${offset ? `<button data-action="loadProjectProgress" data-args='[${Math.max(0, offset - 20)}]'>Newer</button>` : ''}${data.nextOffset !== null ? `<button data-action="loadProjectProgress" data-args='[${data.nextOffset}]'>Older</button>` : ''}</div>`;
  } catch (error) {
    if (selectedProjectSpace?.id === id && projectSpaceTab === 'progress') {
      body.innerHTML = '<p class="project-empty">Saved progress could not be loaded.</p>';
      projectMessage(error.message, true);
    }
  }
}
function renderProjectChecklist() {
  renderProjectTaskEditor();
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
  if (task) task.status = done ? 'done' : 'todo';
  projectSpaceDraft.dirty = true; rememberProjectDraft();
}
function removeProjectTask(id) {
  projectSpaceDraft.tasks = projectSpaceDraft.tasks.filter(task => task.id !== id);
  for (const task of projectSpaceDraft.tasks) task.dependsOn = (task.dependsOn || []).filter(dependency => dependency !== id);
  projectSpaceDraft.dirty = true; rememberProjectDraft(); renderProjectChecklist();
}
async function saveProjectSpace() {
  if (!selectedProjectSpace) return createProjectGoalSpace();
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
async function deleteSelectedProjectSpace() {
  const space = selectedProjectSpace;
  const userId = typeof _currentUser !== 'undefined' ? _currentUser?.id : null;
  if (!space || projectSpaceDeleting || projectSpaceSaving) return;
  if (!confirm(`Permanently delete “${space.name}”?\n\nThis removes the project, all its chats, saved results, progress, notifications, goals, prepared work, and scheduled tasks. Unsaved project edits will be discarded.\n\nFiles in your profile and external workspaces are kept.\n\nThis cannot be undone.`)) return;
  projectSpaceDeleting = space.id;
  const button = $('projectDelete'); if (button) button.disabled = true;
  projectMessage('Deleting project…');
  try {
    await projectApi(`/${space.id}`, projectJson('DELETE', { revision: space.revision }));
    if (_currentUser?.id !== userId) return;
    handleProjectSpaceDeleted(space.id);
  } catch (error) { projectMessage(error.message, true); }
  finally { projectSpaceDeleting = null; if (button?.isConnected) button.disabled = false; }
}
function forgetProjectSpaceDrafts(id) {
  const userId = typeof _currentUser !== 'undefined' ? _currentUser?.id : null;
  if (!userId) return;
  try {
    sessionStorage.removeItem(projectDraftKey(id));
    projectFileQueues.delete(projectFileKey(id));
    sessionStorage.removeItem(`oe.projectGoalDraft.${userId}:${id}`);
    const composer = `oe.composerDrafts.v1.${id}.${userId}`;
    const attachments = `oe.chatAttachmentDraft.v1:${userId}:${id}`;
    const outbox = ['oe.chatOutbox.v2:', 'oe.chatOutboxDone.v2:'].map(prefix => `${prefix}${encodeURIComponent(userId)}@${id}`);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key === composer || key?.startsWith(composer + '.') || key === attachments || key?.startsWith(attachments + '.')
        || outbox.some(prefix => key?.startsWith(prefix + ':') || key?.startsWith(prefix + '.'))) localStorage.removeItem(key);
    }
  } catch {}
}
function handleProjectSpaceDeleted(id) {
  if (deletedProjectSpaceIds.has(id)) return;
  deletedProjectSpaceIds.add(id);
  forgetProjectSpaceDrafts(id);
  projectSpaces = projectSpaces.filter(space => space.id !== id);
  if (projectActivityData?.projectId === id) projectActivityData = null;
  projectAttentionItems = projectAttentionItems.filter(item => item.projectId !== id);
  renderProjectAttentionIndicators();
  if ($('projectAttentionDialog')?.open) renderProjectAttention();
  pollProjectAttention();
  if (selectedProjectSpace?.id === id) {
    ++projectSpaceLoad; selectedProjectSpace = null; projectSpaceDraft = null;
    if (projectSpaces.length) selectProjectSpace(projectSpaces[0].id).then(() => projectMessage('Project deleted.'));
    else { newProjectSpace(); projectMessage('Project deleted.'); }
  }
  renderProjectSpaceList();
  if (id !== activeProjectSpaceId) return;
  clearTimeout(_draftSaveTimer);
  $('input').value = ''; $('input').disabled = true; $('btnSend').disabled = true;
  pendingAttachments = []; pendingSentAttempts.clear();
  const url = new URL(location.href);
  for (const key of ['project', 'chat', 'projectMessage']) url.searchParams.delete(key);
  location.replace(url.pathname + url.search);
}
function enterProjectSpace(id) {
  rememberProjectDraft();
  if (id === activeProjectSpaceId && !(typeof activeSavedChatId === 'string' && activeSavedChatId)) { closeProjectSpaces(); return; }
  if (typeof preserveChatDraft === 'function' && !preserveChatDraft()) return;
  const url = new URL(location.href); url.searchParams.delete('agent'); url.searchParams.delete('chat');
  if (id) url.searchParams.set('project', id); else url.searchParams.delete('project');
  location.assign(url.pathname + url.search);
}
function enterProjectAgent(id, agent) {
  rememberProjectDraft();
  if (id === activeProjectSpaceId && !(typeof activeSavedChatId === 'string' && activeSavedChatId)) { closeProjectSpaces(); switchAgent(agent); return; }
  if (typeof preserveChatDraft === 'function' && !preserveChatDraft()) return;
  const url = new URL(location.href); url.searchParams.delete('chat'); url.searchParams.set('project', id); url.searchParams.set('agent', agent);
  location.assign(url.pathname + url.search);
}
document.addEventListener('DOMContentLoaded', () => {
  $('projectSpacesDialog').addEventListener('cancel', rememberProjectDraft);
  if (activeProjectSpaceId) refreshProjectSpaceBanner();
});
