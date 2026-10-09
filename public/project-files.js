const projectFileQueues = new Map();
let projectFileBusyKey = null;
function projectFileKey(id = selectedProjectSpace?.id) {
  return `${typeof _currentUser !== 'undefined' ? _currentUser?.id || '' : ''}:${id || 'new'}`;
}
function pendingProjectFiles(id = selectedProjectSpace?.id) {
  const key = projectFileKey(id);
  if (!projectFileQueues.has(key)) projectFileQueues.set(key, []);
  return projectFileQueues.get(key);
}
function renderProjectFiles() {
  const container = $('projectFilesSection');
  if (!container) return;
  const space = selectedProjectSpace, pending = pendingProjectFiles();
  const busy = projectFileBusyKey === projectFileKey();
  container.innerHTML = `<section class="project-files"><div class="project-goal-toolbar"><h3>Files${space?.files.length ? ` (${space.files.length})` : ''}</h3><label class="project-upload-button">${space ? 'Upload files' : 'Choose files'}<input id="projectFileUpload" type="file" multiple data-change-action="uploadProjectFiles" data-change-args='["$files"]' ${busy ? 'disabled' : ''}></label></div>
    <p class="project-help">${!space || !space.files.length ? 'Add a document to summarize or other reference files (optional).' : 'Available to agents working on this project.'}</p>
    <div class="project-file-list">${(space?.files || []).map(file => `<div class="project-file"><a href="/api/project-spaces/${space.id}/file?id=${encodeURIComponent(file.fileId)}">${escHtml(file.name)}</a><button data-action="removeProjectFile" data-args='${projectArgs(file.fileId)}' aria-label="Remove ${escHtml(file.name)} from project" ${busy ? 'disabled' : ''}>Remove link</button></div>`).join('')}
    ${pending.map(file => `<div class="project-file project-file-pending"><span>${escHtml(file.file.name)}<small>${file.uploaded ? 'Uploaded; waiting to attach' : busy ? 'Uploading…' : space ? 'Waiting to upload' : 'Ready to upload'}</small></span><button data-action="removePendingProjectFile" data-args='${projectArgs(file.id)}' aria-label="Remove ${escHtml(file.file.name)} from upload queue" ${busy ? 'disabled' : ''}>Remove</button></div>`).join('')}</div>
    ${space && pending.length && !busy ? '<div class="project-card-actions"><button data-action="retryProjectFiles">Retry upload</button><span class="project-help">Finish uploading before starting work.</span></div>' : ''}
    ${!space && pending.length ? '<p class="project-help">Uploads when you create the project. Keep this tab open until it finishes.</p>' : ''}
    ${space?.files.length && projectSpaceTab === 'files' ? '<p class="project-help">Click a file to download it. Remove link keeps the original file in your profile.</p>' : ''}</section>`;
}
function removePendingProjectFile(id) {
  if (projectFileBusyKey === projectFileKey() || projectSpaceSaving) return;
  const pending = pendingProjectFiles(), index = pending.findIndex(row => row.id === id);
  if (index >= 0) pending.splice(index, 1);
  renderProjectFiles();
}
async function uploadProjectFiles(files) {
  if (projectFileBusyKey || projectSpaceSaving) return;
  const chosen = Array.from(files || []), pending = pendingProjectFiles();
  if (!chosen.length) return;
  if (pending.length + chosen.length + (selectedProjectSpace?.files.length || 0) > 100) {
    projectMessage('A project can have up to 100 files.', true); return;
  }
  if (chosen.some(file => file.size >= 500 * 1024 * 1024)) {
    projectMessage('Each file must be smaller than 500 MB.', true); return;
  }
  for (const file of chosen) pending.push({ id: crypto.randomUUID(), file });
  renderProjectFiles();
  if (selectedProjectSpace) await flushProjectFiles(selectedProjectSpace.id);
}
function retryProjectFiles() {
  if (selectedProjectSpace && !projectSpaceSaving) return flushProjectFiles(selectedProjectSpace.id);
}
function acceptProjectFileUpdate(space, priorRevision) {
  if (selectedProjectSpace?.id !== space.id) return;
  if (projectSpaceDraft.revision === priorRevision) projectSpaceDraft.revision = space.revision;
  selectedProjectSpace = space;
  projectSpaces = projectSpaces.map(row => row.id === space.id ? space : row);
  rememberProjectDraft(); renderProjectFiles();
}
async function flushProjectFiles(id) {
  const key = projectFileKey(id), pending = pendingProjectFiles(id);
  if (projectFileBusyKey) return false;
  if (!pending.length) return true;
  projectFileBusyKey = key;
  const currentProfile = () => key === projectFileKey(id);
  const visible = () => currentProfile() && selectedProjectSpace?.id === id;
  if (visible()) renderProjectFiles();
  try {
    while (pending.length && currentProfile()) {
      const item = pending[0];
      if (visible()) projectMessage(`Uploading ${item.file.name}…`);
      if (!item.uploaded) {
        const data = new FormData(); data.append('file', item.file);
        const response = await fetch('/api/chat-upload', { method: 'POST', body: data });
        const uploaded = await response.json();
        if (!response.ok || !uploaded.file_id) throw new Error(uploaded.error || 'Upload failed');
        item.uploaded = uploaded.file_id;
      }
      if (!currentProfile()) return false;
      // Refresh only the file link revision; unsaved project context stays intact.
      const latest = await projectApi(`/${id}`);
      if (!currentProfile()) return false;
      const space = latest.files.some(file => file.fileId === item.uploaded) ? latest
        : await projectApi(`/${id}/files`, projectJson('POST', { revision: latest.revision, fileId: item.uploaded, name: item.file.name }));
      pending.shift();
      if (visible()) acceptProjectFileUpdate(space, latest.revision);
    }
    if (visible()) projectMessage('Files added. Your agent can use them when you start work.');
    return currentProfile();
  } catch (error) {
    if (visible()) projectMessage(`Some files still need attaching. ${error.message} Use Retry upload; files already added are kept.`, true);
    return false;
  } finally {
    projectFileBusyKey = null;
    if (visible()) renderProjectFiles();
  }
}
async function removeProjectFile(fileId) {
  if (projectFileBusyKey || projectSpaceSaving || !selectedProjectSpace) return;
  const id = selectedProjectSpace.id, key = projectFileKey(id);
  projectFileBusyKey = key; renderProjectFiles();
  try {
    const priorRevision = selectedProjectSpace.revision;
    const space = await projectApi(`/${id}/files`, projectJson('DELETE', { revision: priorRevision, fileId }));
    if (key !== projectFileKey() || selectedProjectSpace?.id !== id) return;
    acceptProjectFileUpdate(space, priorRevision);
    projectMessage('File link removed. The original file is still in your profile.');
  } catch (error) { if (key === projectFileKey()) projectMessage(error.message, true); }
  finally { projectFileBusyKey = null; renderProjectFiles(); }
}
