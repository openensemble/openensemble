// Project views reuse chat identities; navigating never transfers a running turn.
let projectActivityData = null;
let projectAttentionItems = [];
let projectActivityLoading = false;
let projectAttentionLoading = false;
let projectResultSource = null;
const projectStatusLabels = { idle: 'Ready', working: 'Working', waiting: 'Needs your input', finished: 'Finished', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
const projectActionArgs = (...args) => escHtml(JSON.stringify(args));
function resetProjectWork() {
  rememberProjectDraft(); ++projectSpaceLoad;
  projectSpaces = []; selectedProjectSpace = null; projectSpaceDraft = null;
  deletedProjectSpaceIds.clear(); projectSpaceDeleting = null;
  if ($('projectSpacesDialog')?.open) $('projectSpacesDialog').close();
  if ($('projectSpaceDetail')) $('projectSpaceDetail').innerHTML = '';
  if ($('projectSpaceList')) $('projectSpaceList').innerHTML = '';
  projectActivityData = null; projectAttentionItems = []; projectResultSource = null;
  if ($('projectAttentionButton')) $('projectAttentionButton').hidden = true;
  for (const id of ['projectResultDialog', 'projectAttentionDialog']) { const dialog = $(id); if (dialog?.open) dialog.close(); if (dialog) dialog.innerHTML = ''; }
}

async function loadProjectActivity() {
  const id = selectedProjectSpace?.id;
  const userId = typeof _currentUser !== 'undefined' ? _currentUser?.id : null;
  if (!id || projectSpaceTab !== 'chats' || projectActivityLoading) return;
  projectActivityLoading = true;
  try {
    const data = await projectApi(`/${id}/activity`);
    if (selectedProjectSpace?.id !== id || projectSpaceTab !== 'chats' || (typeof _currentUser !== 'undefined' && _currentUser?.id !== userId)) return;
    projectActivityData = { ...data, projectId: id };
    filterProjectChats($('projectChatSearch')?.value || '');
  } catch (error) { if (selectedProjectSpace?.id === id) projectMessage(error.message, true); }
  finally { projectActivityLoading = false; }
}
function filterProjectChats(query = '') {
  const container = $('projectActivityRows'), data = projectActivityData;
  if (!container || data?.projectId !== selectedProjectSpace?.id) return;
  const chats = data.conversations.filter(chat => `${chat.name} ${chat.agentName} ${chat.preview}`.toLowerCase().includes(query.toLowerCase()));
  const html = chats.map(chat => `<article class="project-activity-card" data-status="${escHtml(chat.status)}">
    <div class="project-activity-heading"><strong>${escHtml(chat.emoji || '🤖')} ${escHtml(chat.name)}</strong><span class="project-status">${escHtml(projectStatusLabels[chat.status] || chat.status)}${chat.unread ? ` · ${chat.unread} new` : ''}</span></div>
    <p class="project-help">${escHtml(chat.agentName)}${chat.workers ? ` · ${chat.workers} active workers` : ''}${chat.lastAt ? ` · ${escHtml(new Date(chat.lastAt).toLocaleString())}` : ''}</p>
    <p class="project-chat-preview">${escHtml(chat.preview || 'Start a conversation in this project')}</p>
    ${chat.currentTool ? `<p class="project-help">Using ${escHtml(String(chat.currentTool))}</p>` : ''}
    <div class="project-card-actions"><button data-action="openProjectConversation" data-args='${projectActionArgs(data.projectId, chat.chatId, chat.agentId, chat.through)}'>Open chat</button><button data-action="saveConversationCheckpoint" data-args='${projectActionArgs(data.projectId, chat.chatId, chat.agentId)}' ${chat.count ? '' : 'disabled'}>Save checkpoint</button></div></article>`).join('') || '<p class="project-empty">No matching conversations.</p>';
  // Avoid replacing focused controls when nothing has changed.
  if (container.innerHTML !== html) container.innerHTML = html;
}
async function openProjectConversation(projectId, chatId, agentId, through = 0, messageTs = null) {
  if (typeof preserveChatDraft === 'function' && !preserveChatDraft()) return;
  if (through) await projectApi(`/${projectId}/read`, projectJson('POST', { agentId, chatId, through })).catch(() => {});
  const url = new URL(location.href);
  url.searchParams.set('project', projectId); url.searchParams.set('agent', agentId);
  if (chatId) url.searchParams.set('chat', chatId); else url.searchParams.delete('chat');
  if (messageTs) url.searchParams.set('projectMessage', String(messageTs)); else url.searchParams.delete('projectMessage');
  rememberProjectDraft();
  location.assign(url.pathname + url.search);
}
async function createProjectChat() {
  const id = selectedProjectSpace?.id;
  if (!id || !activeAgent) return;
  try {
    const response = await fetch(`/api/saved-chats?project=${encodeURIComponent(id)}`, projectJson('POST', { agentId: activeAgent }));
    const chat = await response.json(); if (!response.ok) throw new Error(chat.error || 'Could not create chat');
    await openProjectConversation(id, chat.id, chat.agentId);
  } catch (error) { projectMessage(error.message, true); }
}
async function saveConversationCheckpoint(projectId, chatId, agentId) {
  try {
    await projectApi(`/${projectId}/checkpoint`, projectJson('POST', { agentId, chatId }));
    if ($('projectSpacesDialog').open) projectMessage('Checkpoint saved. The conversation remains open.');
    else showToast('Project checkpoint saved');
  } catch (error) { if ($('projectSpacesDialog').open) projectMessage(error.message, true); else showToast(error.message); }
}

function renderProjectTaskEditor() {
  const tasks = projectSpaceDraft.tasks;
  $('projectChecklist').innerHTML = tasks.map(task => {
    const status = task.status || (task.done ? 'done' : 'todo');
    const change = field => `data-change-action="editProjectTask" data-change-args='${projectActionArgs(task.id, field, '$value')}'`;
    return `<div class="project-task-card"><div class="project-task"><label><input type="checkbox" ${task.done ? 'checked' : ''} data-change-action="toggleProjectTask" data-change-args='${projectActionArgs(task.id, '$checked')}'><span>${escHtml(task.text)}</span></label><button data-action="removeProjectTask" data-args='${projectActionArgs(task.id)}' aria-label="Remove ${escHtml(task.text)}">×</button></div>
      <details><summary>Assignment, dependencies and result${task.agentId ? ` · ${escHtml(agents.find(agent => agent.id === task.agentId)?.name || task.agentId)}` : ''}</summary><div class="project-task-fields">
        <label>Status<select ${change('status')}>${[['todo', 'To do'], ['working', 'Working'], ['blocked', 'Blocked'], ['done', 'Done']].map(([value, label]) => `<option value="${value}" ${status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Assigned agent<select ${change('agentId')}><option value="">Unassigned</option>${agents.map(agent => `<option value="${escHtml(agent.id)}" ${task.agentId === agent.id ? 'selected' : ''}>${escHtml(agent.name)}</option>`).join('')}</select></label>
        <label>Conversation<select ${change('chatId')} data-project-task-chat="${escHtml(task.id)}"><option value="">Original chat</option>${task.chatId ? `<option value="${escHtml(task.chatId)}" selected>Saved chat</option>` : ''}</select></label>
        <label>Prerequisites<select multiple size="${Math.min(4, Math.max(2, tasks.length - 1))}" data-change-action="editProjectDependencies" data-change-args='${projectActionArgs(task.id, '$el')}'>${tasks.filter(other => other.id !== task.id).map(other => `<option value="${escHtml(other.id)}" ${(task.dependsOn || []).includes(other.id) ? 'selected' : ''}>${escHtml(other.text)}</option>`).join('')}</select></label>
        <label class="project-task-wide">Workspace / file paths (one per line)<textarea rows="2" maxlength="25000" ${change('files')}>${escHtml((task.files || []).join('\n'))}</textarea></label>
        <label class="project-task-wide">Result link<input type="url" maxlength="2000" value="${escHtml(task.resultUrl || '')}" ${change('resultUrl')} placeholder="https://… or /?project=…"></label>
      </div><div class="project-card-actions">${selectedProjectSpace && task.agentId ? projectSourceButton(selectedProjectSpace.id, task, 'Assigned chat') : ''}${projectSafeLink(task.resultUrl) ? `<a href="${escHtml(task.resultUrl)}" target="_blank" rel="noopener noreferrer">View result</a>` : ''}</div></details></div>`;
  }).join('');
  renderProjectTaskWarnings();
  loadProjectTaskChats();
}
async function loadProjectTaskChats() {
  const id = selectedProjectSpace?.id;
  if (!id) return;
  try {
    const response = await fetch(`/api/saved-chats?project=${encodeURIComponent(id)}`);
    const chats = await response.json(); if (!response.ok || !Array.isArray(chats) || selectedProjectSpace?.id !== id) return;
    document.querySelectorAll('[data-project-task-chat]').forEach(select => {
      const task = projectSpaceDraft.tasks.find(task => task.id === select.dataset.projectTaskChat);
      if (!task) return;
      select.innerHTML = '<option value="">Original chat</option>' + chats.map(chat => `<option value="${escHtml(chat.id)}" ${task.chatId === chat.id ? 'selected' : ''}>${escHtml(chat.name)}</option>`).join('');
    });
  } catch { /* Existing assignments remain visible during a connection failure. */ }
}
function editProjectTask(id, field, value) {
  const task = projectSpaceDraft.tasks.find(task => task.id === id);
  if (!task || !['status', 'agentId', 'chatId', 'files', 'resultUrl'].includes(field)) return;
  task[field] = field === 'files' ? value.split('\n').map(line => line.trim()).filter(Boolean) : value || null;
  if (field === 'status') task.done = value === 'done';
  projectSpaceDraft.dirty = true; rememberProjectDraft(); renderProjectTaskWarnings();
}
function editProjectDependencies(id, select) {
  const task = projectSpaceDraft.tasks.find(task => task.id === id);
  if (!task) return;
  task.dependsOn = [...select.selectedOptions].map(option => option.value);
  projectSpaceDraft.dirty = true; rememberProjectDraft(); renderProjectTaskWarnings();
}
function renderProjectTaskWarnings() {
  const container = $('projectTaskWarnings'); if (!container) return;
  const tasks = projectSpaceDraft.tasks, warnings = [];
  for (const task of tasks) {
    const pending = (task.dependsOn || []).map(id => tasks.find(other => other.id === id)).filter(other => other && !other.done);
    if (pending.length && !task.done) warnings.push(`${task.text}: waiting for ${pending.map(other => other.text).join(', ')}`);
  }
  const working = tasks.filter(task => task.status === 'working' && !task.done);
  const normalize = file => file.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  for (let i = 0; i < working.length; i++) for (let j = i + 1; j < working.length; j++) {
    const overlap = (working[i].files || []).map(normalize).filter(a => (working[j].files || []).map(normalize).some(b => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')));
    if (overlap.length) warnings.push(`Overlapping work: “${working[i].text}” and “${working[j].text}” both claim ${overlap.join(', ')}. Coordinate edits before continuing.`);
  }
  container.innerHTML = warnings.map(text => `<p class="project-warning">${escHtml(text)}</p>`).join('');
}

function appendProjectReplyActions(element, content, ts) {
  if (!activeProjectSpaceId || !content?.trim() || element.querySelector('.project-reply-actions')) return;
  const actions = document.createElement('div'); actions.className = 'project-reply-actions';
  for (const [kind, label] of [['decision', 'Save as decision'], ['reference', 'Save as reference'], ['output', 'Save as output']]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    const source = { agentId: activeAgent, chatId: typeof activeSavedChatId === 'string' ? activeSavedChatId : null, content, ts };
    button.addEventListener('click', () => openProjectResult(kind, source)); actions.appendChild(button);
  }
  const checkpoint = document.createElement('button'); checkpoint.type = 'button'; checkpoint.textContent = 'Save checkpoint';
  const agentId = activeAgent, chatId = typeof activeSavedChatId === 'string' ? activeSavedChatId : null;
  checkpoint.addEventListener('click', () => saveConversationCheckpoint(activeProjectSpaceId, chatId, agentId)); actions.appendChild(checkpoint);
  element.appendChild(actions); element.dataset.projectMessage = String(ts);
  if (new URLSearchParams(location.search).get('projectMessage') === String(ts)) {
    element.classList.add('project-source-message');
    setTimeout(() => element.scrollIntoView({ block: 'center' }), 100);
  }
}
async function openProjectResult(kind, source) {
  const userId = _currentUser?.id;
  try {
    const space = await projectApi(`/${activeProjectSpaceId}`);
    if (_currentUser?.id !== userId) return;
    projectResultSource = { ...source, kind, projectId: space.id, revision: space.revision };
    const dialog = $('projectResultDialog');
    dialog.innerHTML = `<div class="project-mini-heading"><h2>Save ${kind === 'decision' ? 'a decision' : kind === 'reference' ? 'a reference' : 'an output'}</h2><button data-action="closeProjectResult" aria-label="Close">✕</button></div><p class="project-help">Keep a useful result with its source conversation. Saved decisions and references are included in future project messages.</p><label class="project-field"><span>Title</span><input id="projectResultTitle" maxlength="200" value="${escHtml(source.content.replace(/\s+/g, ' ').slice(0, 90))}"></label><label class="project-field"><span>Saved excerpt</span><textarea id="projectResultText" rows="10" maxlength="16000">${escHtml(source.content.slice(0, 16000))}</textarea></label><p id="projectResultError" role="status"></p><button id="projectResultSave" class="project-primary" data-action="saveProjectReply">Save to project</button>`;
    dialog.showModal(); $('projectResultTitle').focus();
  } catch (error) { showToast(error.message); }
}
function closeProjectResult() { $('projectResultDialog').close(); projectResultSource = null; }
async function saveProjectReply() {
  if (!projectResultSource || $('projectResultSave').disabled) return;
  const source = projectResultSource; $('projectResultSave').disabled = true;
  try {
    await projectApi(`/${source.projectId}/save-result`, projectJson('POST', { ...source, title: $('projectResultTitle').value.trim(), excerpt: $('projectResultText').value.trim() }));
    if (projectResultSource !== source) return;
    closeProjectResult(); showToast('Saved to project');
  } catch (error) {
    if (projectResultSource !== source || !$('projectResultError')) return;
    $('projectResultError').textContent = error.message;
    if (error.message.includes('changed elsewhere')) {
      try { const current = await projectApi(`/${source.projectId}`); source.revision = current.revision; $('projectResultError').textContent = 'The project changed elsewhere. Your excerpt is kept. Click Save again to add it to the latest version.'; } catch {}
    }
  }
  finally { if ($('projectResultSave')) $('projectResultSave').disabled = false; }
}
function projectSafeLink(value) {
  if (!value || /[\u0000-\u0020\\]/.test(value) || value.startsWith('//')) return false;
  try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function projectSourceButton(projectId, source, label = 'Source chat') {
  if (!source?.agentId) return '';
  return `<button data-action="openProjectConversation" data-args='${projectActionArgs(projectId, source.chatId || null, source.agentId, 0, source.ts || null)}'>${escHtml(label)}</button>`;
}
function renderProjectSavedResults(outputsOnly = false) {
  const space = selectedProjectSpace;
  const items = (space.savedItems || []).filter(item => outputsOnly ? item.kind === 'output' : item.kind !== 'output').slice().reverse();
  const html = items.map(item => `<details class="project-progress-entry"><summary>${escHtml(item.title)} <span class="project-help">· ${escHtml(item.kind)}</span></summary><p class="project-help">${escHtml(new Date(item.savedAt).toLocaleString())}</p><pre>${escHtml(item.content)}</pre><div class="project-card-actions">${projectSourceButton(space.id, item.source)}<button data-action="removeProjectSavedResult" data-args='${projectActionArgs(item.id)}'>Remove saved result</button></div></details>`).join('');
  if (outputsOnly) return html;
  $('projectSpaceTabBody').innerHTML = `<p class="project-help">Use “Save as decision” or “Save as reference” under a project reply. Saved excerpts stay linked to their source and are shared with agents on future turns.</p>${html || '<p class="project-empty">No saved decisions or references yet.</p>'}`;
}
async function removeProjectSavedResult(itemId) {
  const space = selectedProjectSpace;
  try {
    const updated = await projectApi(`/${space.id}/saved-result`, projectJson('DELETE', { itemId, revision: space.revision }));
    if (selectedProjectSpace?.id !== space.id) return;
    selectedProjectSpace = updated;
    if (projectSpaceDraft.revision === space.revision) projectSpaceDraft.revision = updated.revision;
    rememberProjectDraft(); renderProjectSpaceTab();
  } catch (error) { projectMessage(error.message, true); }
}
async function loadProjectOutputs() {
  const id = selectedProjectSpace?.id; if (!id) return;
  $('projectSpaceTabBody').innerHTML = '<p class="project-empty">Loading project outputs…</p>';
  try {
    const outputs = await projectApi(`/${id}/outputs`);
    if (selectedProjectSpace?.id !== id || projectSpaceTab !== 'outputs') return;
    $('projectSpaceTabBody').innerHTML = `<p class="project-help">Documents, media, and code links produced in project conversations. A document download opens its current file; the listed version records when it was produced.</p><button data-action="loadProjectOutputs">Refresh</button>${outputs.map(output => `<article class="project-activity-card"><strong>${escHtml(output.name)}</strong><p class="project-help">${escHtml(output.kind)}${output.version ? ` · version ${output.version}` : ''} · ${escHtml(agents.find(agent => agent.id === output.agentId)?.name || output.agentId)}${output.ts ? ` · ${escHtml(new Date(output.ts).toLocaleString())}` : ''}</p><div class="project-card-actions"><a href="${escHtml(output.fileId ? `/api/project-spaces/${id}/output-file?id=${encodeURIComponent(output.fileId)}` : output.url)}" target="_blank" rel="noopener noreferrer">${output.fileId ? 'Download' : 'Open link'}</a>${projectSourceButton(id, output)}</div></article>`).join('')}${renderProjectSavedResults(true) || ''}${!outputs.length && !(selectedProjectSpace.savedItems || []).some(item => item.kind === 'output') ? '<p class="project-empty">No outputs yet. Generated files appear here; use “Save as output” to keep a report from a reply.</p>' : ''}`;
  } catch (error) { if (selectedProjectSpace?.id === id) projectMessage(error.message, true); }
}

async function pollProjectAttention() {
  if (projectAttentionLoading || typeof _currentUser === 'undefined' || !_currentUser?.id) return;
  projectAttentionLoading = true;
  const userId = _currentUser.id;
  try {
    const items = (await projectApi('/attention')).filter(item => !deletedProjectSpaceIds.has(item.projectId));
    if (_currentUser?.id !== userId) return;
    projectAttentionItems = items;
    const button = $('projectAttentionButton'); if (!button) return;
    button.hidden = !items.length;
    button.textContent = `${items.length} project update${items.length === 1 ? '' : 's'}`;
    $('sbtnProjects')?.setAttribute('title', items.length ? `Project spaces · ${items.length} unread updates` : 'Project spaces');
    if ($('projectAttentionDialog').open) renderProjectAttention();
    const visible = !document.hidden && typeof activeAgent === 'string' && typeof sessionsLoaded !== 'undefined' && sessionsLoaded.has(activeAgent)
      ? items.filter(item => item.projectId === activeProjectSpaceId && item.chatId === activeSavedChatId && item.agentId === activeAgent) : [];
    if (visible.length) {
      await projectApi(`/${activeProjectSpaceId}/read`, projectJson('POST', { ids: visible.map(item => item.id) }));
    }
  } catch { /* The next poll retries; don't interrupt chat during reconnect. */ }
  finally { projectAttentionLoading = false; }
}
function showProjectAttention() { renderProjectAttention(); $('projectAttentionDialog').showModal(); }
function closeProjectAttention() { $('projectAttentionDialog').close(); }
function renderProjectAttention() {
  const html = `<div class="project-mini-heading"><h2>Project updates</h2><button data-action="closeProjectAttention" aria-label="Close">✕</button></div>${projectAttentionItems.map(item => `<article class="project-activity-card"><strong>${escHtml(item.projectName)} · ${escHtml(projectStatusLabels[item.status] || item.status)}</strong><p>${escHtml(item.agentName)} · ${escHtml(item.chatName)}</p><p class="project-help">${escHtml(new Date(item.ts).toLocaleString())}</p><div class="project-card-actions"><button data-action="openProjectConversation" data-args='${projectActionArgs(item.projectId, item.chatId, item.agentId, item.ts)}'>Open chat</button><button data-action="dismissProjectNotice" data-args='${projectActionArgs(item.projectId, item.id)}'>Dismiss</button></div></article>`).join('') || '<p class="project-empty">All caught up.</p>'}`;
  const dialog = $('projectAttentionDialog'); if (dialog.innerHTML !== html) dialog.innerHTML = html;
}
async function dismissProjectNotice(projectId, id) {
  try { await projectApi(`/${projectId}/read`, projectJson('POST', { ids: [id] })); await pollProjectAttention(); }
  catch (error) { showToast(error.message); }
}
document.addEventListener('DOMContentLoaded', () => {
  for (const id of ['projectResultDialog', 'projectAttentionDialog']) {
    const dialog = document.createElement('dialog'); dialog.id = id; dialog.className = 'project-mini-dialog project-spaces-dialog';
    dialog.setAttribute('aria-label', id === 'projectResultDialog' ? 'Save result to project' : 'Project updates'); document.body.appendChild(dialog);
  }
  const button = document.createElement('button'); button.id = 'projectAttentionButton'; button.className = 'project-attention-button';
  button.hidden = true; button.addEventListener('click', showProjectAttention); button.setAttribute('aria-live', 'polite'); document.body.appendChild(button);
  setInterval(() => {
    if (document.hidden) return;
    pollProjectAttention();
    if ($('projectSpacesDialog').open && projectSpaceTab === 'chats') loadProjectActivity();
  }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollProjectAttention(); });
  setTimeout(pollProjectAttention, 1500);
});
