// Navigation gives each chat its own socket and reducer, including live work.
const activeSavedChatId = new URLSearchParams(location.search).get('chat') || null;
let savedChats = [];
let savedChatsLoading = 0;
let savedChatCreating = false;
const savedChatsDeleting = new Set();
const deletedSavedChatIds = new Set();
let activeSavedChatDeleted = false;

function conversationStorageScope() {
  return [typeof activeProjectSpaceId === 'string' ? activeProjectSpaceId : '', activeSavedChatId].filter(Boolean).join('.');
}
let restoredAttachmentDraftUser = null;
function chatAttachmentDraftKey() {
  const userId = typeof _currentUser !== 'undefined' ? _currentUser?.id : null;
  return userId ? `oe.chatAttachmentDraft.v1:${userId}:${conversationStorageScope()}` : null;
}
function saveChatAttachmentDraft() {
  const key = chatAttachmentDraftKey();
  if (!key || typeof pendingAttachments === 'undefined') return;
  try {
    const files = pendingAttachments.filter(item => item.file_id && !item._uploading).map(({ base64, ...item }) => item);
    if (files.length) localStorage.setItem(key, JSON.stringify(files)); else localStorage.removeItem(key);
  } catch {}
}
function restoreChatAttachmentDraft() {
  const key = chatAttachmentDraftKey();
  if (!key || restoredAttachmentDraftUser === key) return;
  restoredAttachmentDraftUser = key;
  try {
    const files = JSON.parse(localStorage.getItem(key) || '[]');
    if (!pendingAttachments.length && Array.isArray(files)) {
      pendingAttachments = files.filter(item => item?.file_id && !item._uploading).slice(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE);
      renderAttachmentTray();
    }
  } catch {}
}
function chatScopeQuery() {
  const query = new URLSearchParams();
  if (typeof activeProjectSpaceId === 'string' && activeProjectSpaceId) query.set('project', activeProjectSpaceId);
  if (activeSavedChatId) query.set('chat', activeSavedChatId);
  return query;
}
async function savedChatApi(suffix = '', options = {}) {
  const query = chatScopeQuery(); query.delete('chat');
  const response = await fetch(`/api/saved-chats${suffix}${query.size ? '?' + query : ''}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load saved chats');
  return data;
}
function savedChatsMessage(text) {
  $('savedChatsMessage').textContent = text;
  if (text && !$('savedChatsDialog').open) showToast(text);
}
function showSavedChatUnavailable(message) {
  $('savedChatLabel').textContent = message || 'Chat unavailable';
  $('btnSend').disabled = true;
  $('input').disabled = true;
}
async function refreshSavedChatLabel() {
  if (!activeSavedChatId) return;
  try {
    const chat = await savedChatApi(`/${encodeURIComponent(activeSavedChatId)}`);
    $('savedChatLabel').textContent = chat.name;
    $('btnChats').title = `Saved chats · ${chat.name}`;
  } catch (error) { showSavedChatUnavailable(error.message); }
}
async function openSavedChats() {
  const dialog = $('savedChatsDialog');
  if (!dialog.open) dialog.showModal();
  $('btnChats').setAttribute('aria-expanded', 'true');
  const generation = ++savedChatsLoading;
  savedChatsMessage('Loading chats…');
  $('savedChatsList').replaceChildren();
  try {
    const chats = await savedChatApi();
    if (generation !== savedChatsLoading) return;
    savedChats = chats;
    renderSavedChats(); savedChatsMessage('');
  } catch (error) { if (generation === savedChatsLoading) savedChatsMessage(error.message); }
}
async function runSavedChatCommand(action = '') {
  action = action.trim();
  if (action.toLowerCase() === 'new') {
    consumeSavedChatCommand();
    await newSavedChat();
  } else {
    $('input').value = '/chat' + (action && action.toLowerCase() !== 'list' ? ' ' + action : '');
    slashMenuIdx = 0;
    updateSlashMenu();
    resizeTextarea();
    $('input').focus();
  }
}
function consumeSavedChatCommand() {
  hideSlashMenu();
  clearTimeout(_draftSaveTimer);
  $('input').value = '';
  clearDraftForAgent(activeAgent);
  resizeTextarea();
}
function closeSavedChats() { $('savedChatsDialog').close(); }
function savedChatChoices(chats = savedChats) {
  return [{ id: null, name: 'Original chat', preview: 'Your conversation from before saved chats', agentId: activeAgent }, ...chats];
}
function renderSavedChats() {
  const chats = savedChatChoices();
  const query = $('savedChatsSearch').value.trim().toLowerCase();
  const visible = chats.filter(chat => `${chat.name} ${chat.preview}`.toLowerCase().includes(query));
  $('savedChatsList').innerHTML = visible.map(chat => {
    const current = chat.id === activeSavedChatId;
    const agent = agents.find(item => item.id === chat.agentId);
    const args = escHtml(JSON.stringify([chat.id, chat.agentId]));
    return `<div class="saved-chat-row"><button class="saved-chat-entry" data-action="enterSavedChat" data-args='${args}' ${current ? 'aria-current="true"' : ''}>
      <span class="saved-chat-entry-heading"><strong>${escHtml(chat.name)}</strong>${current ? '<span class="saved-chat-current">Current</span>' : ''}</span>
      <span class="saved-chat-preview">${escHtml(chat.preview || 'Start a conversation')}</span>
      <small>${escHtml(agent?.name || '')}${chat.updatedAt ? ' · ' + escHtml(new Date(chat.updatedAt).toLocaleString()) : ''}</small>
    </button>${chat.id ? `<button class="saved-chat-delete" data-action="deleteSavedChat" data-args='${escHtml(JSON.stringify([chat.id]))}' aria-label="Delete ${escHtml(chat.name)}" ${savedChatsDeleting.has(chat.id) ? 'disabled' : ''}>Delete</button>` : ''}</div>`;
  }).join('') || '<p class="saved-chat-empty">No matching chats.</p>';
}
async function deleteSavedChat(id) {
  const chat = savedChats.find(item => item.id === id);
  if (!chat || savedChatsDeleting.has(id)) return;
  if (id === activeSavedChatId && !preserveChatDraft()) return;
  if (!confirm(`Delete “${chat.name}” and its message history and drafts?\n\nScheduled tasks from this chat will be paused. This cannot be undone.`)) return;
  savedChatsDeleting.add(id);
  renderSavedChats();
  savedChatsMessage('Deleting chat…');
  try {
    await savedChatApi(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
    handleSavedChatDeleted(id, chat.projectId);
    if (!activeSavedChatDeleted) savedChatsMessage('Chat deleted.');
  } catch (error) { savedChatsMessage(error.message); }
  finally { savedChatsDeleting.delete(id); if ($('savedChatsDialog').open) renderSavedChats(); }
}
function forgetSavedChatDrafts(id, projectId) {
  const userId = typeof _currentUser !== 'undefined' ? _currentUser?.id : null;
  if (!userId) return;
  const scope = [projectId, id].filter(Boolean).join('.');
  const drafts = `oe.composerDrafts.v1${projectId ? '.' + projectId : ''}.${userId}.${id}`;
  const attachments = `oe.chatAttachmentDraft.v1:${userId}:${scope}`;
  const outbox = ['oe.chatOutbox.v2:', 'oe.chatOutboxDone.v2:'].map(prefix => `${prefix}${encodeURIComponent(userId)}@${encodeURIComponent(scope)}:`);
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key === drafts || key === attachments || outbox.some(prefix => key?.startsWith(prefix))) localStorage.removeItem(key);
    }
  } catch {}
}
function handleSavedChatDeleted(id, projectId) {
  if (deletedSavedChatIds.has(id)) return;
  deletedSavedChatIds.add(id);
  forgetSavedChatDrafts(id, projectId);
  savedChats = savedChats.filter(chat => chat.id !== id);
  if (id === activeSavedChatId) {
    if (activeSavedChatDeleted) return;
    activeSavedChatDeleted = true;
    clearTimeout(_draftSaveTimer);
    $('input').value = '';
    pendingAttachments = [];
    pendingSentAttempts.clear();
    $('input').disabled = true;
    $('btnSend').disabled = true;
    const url = new URL(location.href);
    url.searchParams.delete('chat');
    location.replace(url.pathname + url.search);
  } else {
    if ($('savedChatsDialog').open) openSavedChats();
    if ($('slashMenu').classList.contains('saved-chat-menu') && $('slashMenu').style.display === 'block') {
      _chatMenuState = null;
      updateSlashMenu();
    }
  }
}
function preserveChatDraft() {
  if (typeof pendingAttachments !== 'undefined' && pendingAttachments.some(item => item._uploading)) {
    const message = 'Wait for attachments to finish uploading before switching chats.';
    if ($('savedChatsDialog').open) savedChatsMessage(message); else showToast(message);
    return false;
  }
  if (typeof saveDraftForAgent === 'function') saveDraftForAgent(activeAgent);
  if (typeof saveChatAttachmentDraft === 'function') saveChatAttachmentDraft();
  return true;
}
function enterSavedChat(id, agentId = activeAgent) {
  if ((id || null) === activeSavedChatId) { closeSavedChats(); return; }
  if (!preserveChatDraft()) return;
  const url = new URL(location.href);
  if (id) url.searchParams.set('chat', id); else url.searchParams.delete('chat');
  if (agentId && agents.some(agent => agent.id === agentId)) url.searchParams.set('agent', agentId);
  else url.searchParams.delete('agent');
  location.assign(url.pathname + url.search);
}
async function newSavedChat() {
  if (savedChatCreating || !preserveChatDraft()) return;
  if (!activeAgent) { savedChatsMessage('Choose an agent to start a chat.'); return; }
  savedChatCreating = true;
  $('newSavedChat').disabled = true;
  savedChatsMessage('Creating chat…');
  try {
    const chat = await savedChatApi('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: activeAgent }) });
    enterSavedChat(chat.id, chat.agentId);
  } catch (error) { savedChatsMessage(error.message); }
  finally { savedChatCreating = false; $('newSavedChat').disabled = false; }
}
async function renameCurrentChat() {
  if (!activeSavedChatId) return;
  const name = $('savedChatRename').value.trim();
  if (!name) { savedChatsMessage('Give your chat a name.'); return; }
  try {
    await savedChatApi(`/${activeSavedChatId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    await refreshSavedChatLabel(); await openSavedChats();
    savedChatsMessage('Chat renamed.');
  } catch (error) { savedChatsMessage(error.message); }
}
document.addEventListener('DOMContentLoaded', () => {
  $('savedChatsDialog').addEventListener('keydown', event => {
    // Keep shortcuts for background drawers out of this modal's keyboard flow.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); closeSavedChats(); }
  });
  $('savedChatsDialog').addEventListener('close', () => { ++savedChatsLoading; $('btnChats').setAttribute('aria-expanded', 'false'); $('btnChats').focus(); });
  $('savedChatRenameRow').hidden = !activeSavedChatId;
});
window.addEventListener('pagehide', () => {
  if (activeSavedChatDeleted) return;
  if (typeof saveDraftForAgent === 'function') saveDraftForAgent(activeAgent);
  if (typeof saveChatAttachmentDraft === 'function') saveChatAttachmentDraft();
});
