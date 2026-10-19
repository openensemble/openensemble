/* Mail is a primary workspace; the ordinary OE chat can remain beside it. */
(() => {
  const icon = (name, size = 18) => {
    const node = lucide.icons[name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('')];
    return node ? lucide.createElement(node, { class: 'icon', width: size, height: size, 'aria-hidden': 'true' }).outerHTML : '';
  };
  const M = { accounts: [], account: 'all', folders: {}, folderRequests: new Map(), collapsedFolders: new Set(), folderMutation: false, folder: 'inbox', query: '', filter: 'all', emails: [], drafts: [], cursors: {}, selected: new Set(), detail: null, draft: null, dirty: false, saving: null, timer: null, poll: null, generation: 0, detailGeneration: 0, session: 0, busy: false, sending: false, upload: false, images: false };
  const e = value => escHtml(String(value ?? ''));
  const editorHtml = value => DOMPurify.sanitize(value, { ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a', 'pre', 'code', 'h1', 'h2', 'h3', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan'] });
  const key = mail => `${mail.accountId}\n${mail.id}`;
  const active = () => document.querySelector('.desk')?.classList.contains('mail-mode');
  const command = (cmd, label, glyph, value = '', classes = '') => `<button type="button" class="mail-btn ${classes}" data-mail="${cmd}" data-value="${e(value)}" title="${e(label)}" aria-label="${e(label)}">${glyph ? icon(glyph, 17) : ''}<span>${e(label)}</span></button>`;
  const account = id => M.accounts.find(a => a.id === id);
  const name = from => String(from || '').replace(/<[^>]*>/g, '').replace(/"/g, '').trim() || String(from || 'Unknown sender');
  const email = from => String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '').trim();
  const initials = from => name(from).split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
  function date(value, full = false) { const d = new Date(value); if (Number.isNaN(d.getTime())) return ''; return full ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
  async function api(operation, args = {}, mutation = false) {
    const response = await fetch(mutation ? '/api/mail/action' : `/api/mail/read?${new URLSearchParams({ operation, ...args })}`, mutation ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, ...args }) } : { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `Mail request failed (${response.status}).`);
    return data;
  }
  function notice(text, error = false, warning = false) {
    const el = $('mailNotice'); if (!el) return;
    el.textContent = text; el.classList.toggle('error', error); el.classList.toggle('warning', warning); el.hidden = !text;
  }
  function shell() {
    if ($('mailWorkspace')) return;
    const section = document.createElement('section');
    section.id = 'mailWorkspace'; section.className = 'mail-workspace'; section.hidden = true;
    section.setAttribute('aria-label', 'Mail workspace');
    section.innerHTML = `<header class="mail-header"><div class="mail-brand">${icon('mail', 22)}<strong>Mail</strong><span>OpenEnsemble</span></div><form id="mailSearchForm" class="mail-search" role="search">${icon('search', 17)}<input id="mailSearch" type="search" placeholder="Search this mailbox" aria-label="Search mail" autocomplete="off"><kbd>/</kbd></form><div class="mail-header-actions">${command('refresh', 'Refresh', 'refresh-cw', '', 'mail-icon-btn')}${command('assistant', 'Assistant', 'sparkles')}${command('close', 'Back to OE', 'x', '', 'mail-icon-btn')}</div></header>
      <div id="mailNotice" class="mail-notice" role="status" hidden></div>
      <div class="mail-layout"><nav id="mailNavigation" class="mail-navigation" aria-label="Mailboxes"></nav><section class="mail-list-pane" aria-label="Messages"><div class="mail-list-heading"><div><span class="mail-eyebrow" id="mailScope">YOUR MAIL</span><h1 id="mailFolderTitle">Inbox</h1></div>${command('navigation', 'Mailboxes', 'panel-left', '', 'mail-mobile-nav mail-icon-btn')}</div><div class="mail-list-controls"><label class="mail-select-all"><input id="mailSelectAll" type="checkbox" aria-label="Select loaded messages"></label><div class="mail-filter"><button data-mail="filter" data-value="all" class="active">All</button><button data-mail="filter" data-value="unread">Unread</button></div><span id="mailLoadedCount"></span></div><div id="mailBulk" class="mail-bulk" hidden></div><div id="mailList" class="mail-message-list" role="list" tabindex="-1"></div><div id="mailListFooter" class="mail-list-footer"></div></section><section id="mailReading" class="mail-reading" aria-label="Reading pane"></section></div>`;
    $('workspace').before(section);
    const assistantClose = document.createElement('button');
    assistantClose.id = 'mailAssistantClose'; assistantClose.type = 'button'; assistantClose.className = 'mail-assistant-close';
    assistantClose.title = 'Close AI panel'; assistantClose.setAttribute('aria-label', 'Close AI panel');
    assistantClose.innerHTML = icon('x', 18);
    assistantClose.addEventListener('click', closeMailAssistant);
    $('workspace').append(assistantClose);
    setMailAssistantOpen(false);
    section.addEventListener('click', event => {
      const button = event.target.closest('[data-mail]'); if (!button || button.disabled) return;
      handle(button.dataset.mail, button.dataset.value, event).catch(error => notice(error.message, true));
    });
    section.addEventListener('change', event => {
      if (event.target.id === 'mailSelectAll') {
        M.selected = event.target.checked ? new Set(visible().map(key)) : new Set(); renderList();
      } else if (event.target.id === 'mailMove') {
        if (event.target.value && M.detail) update('move', event.target.value, M.detail).catch(error => notice(error.message, true));
      } else if (event.target.id === 'mailFiles') uploadFiles(event.target.files).catch(error => notice(error.message, true));
      else if (event.target.closest('#mailComposer')) changed();
    });
    section.addEventListener('input', event => { if (event.target.closest('#mailComposer')) changed(); });
    section.addEventListener('submit', event => { if (event.target.id === 'mailFolderForm') { event.preventDefault(); saveFolderForm(); } });
    section.addEventListener('paste', event => {
      if (event.target.id !== 'mailEditor') return;
      event.preventDefault();
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    });
    section.addEventListener('pointerdown', event => { if (event.target.closest('[data-mail="format"]')) event.preventDefault(); });
    $('mailSearchForm').addEventListener('submit', event => { event.preventDefault(); M.query = $('mailSearch').value.trim(); load().catch(error => notice(error.message, true)); });
    $('mailSearch').addEventListener('search', () => { if (!$('mailSearch').value) { M.query = ''; load().catch(error => notice(error.message, true)); } });
    M.events = new AbortController();
    window.addEventListener('beforeunload', event => { if (M.dirty || M.saving || M.upload || M.sending) { event.preventDefault(); event.returnValue = ''; } }, { signal: M.events.signal });
    document.addEventListener('keydown', event => {
      if (!active() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,dialog,[contenteditable="true"]')) return;
      if (event.key === '/') { event.preventDefault(); $('mailSearch').focus(); }
      if (event.key.toLowerCase() === 'n') handle('compose').catch(error => notice(error.message, true));
      if (event.key === 'Escape') handle(M.draft ? 'save-close' : M.detail ? 'back' : 'close').catch(error => notice(error.message, true));
    }, { signal: M.events.signal });
  }
  async function openMailWorkspace() {
    shell();
    if (active()) return closeMailWorkspace();
    closeAllDrawers();
    document.querySelector('.desk').classList.add('mail-mode'); $('mailWorkspace').hidden = false;
    $('sbtnInbox').classList.add('active'); $('sbtnInbox').setAttribute('aria-expanded', 'true');
    if (typeof syncPrimaryViewToggle === 'function') syncPrimaryViewToggle();
    renderEmpty(); notice('Connecting to your mailboxes…');
    const generation = ++M.generation;
    try {
      const response = await fetch('/api/email-accounts', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load your accounts.');
      const accounts = await response.json();
      if (generation !== M.generation || !active()) return;
      M.accounts = Array.isArray(accounts) ? accounts : [];
      if (M.account !== 'all' && !account(M.account)) M.account = 'all';
      renderNavigation();
      const errors = await refreshFolders();
      if (generation !== M.generation) return;
      renderNavigation(); await load();
      if (errors.length) notice(errors.join(' · '), true);
      clearInterval(M.poll);
      M.poll = setInterval(() => { if (active() && !document.hidden) refreshDrafts().catch(() => {}); }, 5000);
    } catch (error) { if (generation === M.generation) notice(error.message, true); }
  }
  async function closeMailWorkspace() {
    if (M.sending) { notice('Wait for this message to finish sending.', true); return; }
    if (M.upload) { notice('Wait for attachments to finish uploading.', true); return; }
    if (M.draft) { await saveDraft(); M.draft = null; }
    M.readerResize?.disconnect();
    M.generation++; M.detailGeneration++; M.detail = null; clearInterval(M.poll);
    document.querySelector('.desk')?.classList.remove('mail-mode', 'mail-chat');
    setMailAssistantOpen(false);
    if ($('mailWorkspace')) { $('mailWorkspace').classList.remove('mail-reading-open', 'mail-navigation-open'); $('mailWorkspace').hidden = true; }
    $('sbtnInbox')?.classList.remove('active'); $('sbtnInbox')?.setAttribute('aria-expanded', 'false');
    if (typeof syncPrimaryViewToggle === 'function') syncPrimaryViewToggle();
  }
  function resetMailWorkspace() {
    M.readerResize?.disconnect();
    clearTimeout(M.timer); clearTimeout(changeTimer); clearTimeout(folderChangeTimer); pendingFolderAccounts.clear(); clearInterval(M.poll); M.events?.abort(); M.generation++; M.detailGeneration++; M.session++;
    Object.assign(M, { accounts: [], account: 'all', folders: {}, folderRequests: new Map(), collapsedFolders: new Set(), folderMutation: false, folder: 'inbox', query: '', filter: 'all', cursors: {}, emails: [], drafts: [], selected: new Set(), draft: null, detail: null, dirty: false, saving: null, conflict: false, busy: false, sending: false, deletingDraft: false, upload: false, images: false });
    document.querySelector('.desk')?.classList.remove('mail-mode', 'mail-chat');
    $('mailAssistantClose')?.remove();
    $('mailWorkspace')?.remove();
  }
  function folderFor(a) {
    if (M.folder.startsWith('custom:')) return M.account === a.id ? M.folder.slice(7) : null;
    return M.folders[a.id]?.find(f => f.kind === M.folder)?.id || (M.folder === 'inbox' ? a.provider === 'microsoft' ? 'inbox' : 'INBOX' : null);
  }
  function folderTitle() {
    if (M.folder.startsWith('custom:')) return M.folders[M.account]?.find(f => f.id === M.folder.slice(7))?.name || 'Folder';
    return ({ inbox: M.account === 'all' ? 'All inboxes' : 'Inbox', drafts: 'Drafts', sent: 'Sent', archive: 'Archive', trash: 'Trash', starred: 'Starred' })[M.folder] || 'Mail';
  }
  async function refreshFolders(accountId = null) {
    const session = M.session;
    const accounts = M.accounts.filter(a => !accountId || a.id === accountId || a.label === accountId);
    const results = await Promise.allSettled(accounts.map(async a => {
      const revision = (M.folderRequests.get(a.id) || 0) + 1; M.folderRequests.set(a.id, revision);
      const result = await api('folders', { account: a.id });
      if (session !== M.session || revision !== M.folderRequests.get(a.id)) return;
      M.folders[a.id] = result.folders || []; if (result.address) a.email = result.address;
      if (M.account === a.id && M.folder.startsWith('custom:') && !M.folders[a.id].some(f => f.id === M.folder.slice(7))) {
        M.folder = 'inbox'; M.detailGeneration++; M.detail = null; renderEmpty();
      }
    }));
    if (session !== M.session) return [];
    if (active()) { renderNavigation(); if (M.detail && !M.draft) renderReader(); }
    return results.flatMap((result, i) => result.status === 'rejected' ? [`${accounts[i].label}: ${result.reason.message}`] : []);
  }
  function applyFolderChange(accountId, result) {
    const renamed = new Map((result.renamedFolders || []).map(f => [f.oldId, f.id]));
    const map = id => renamed.get(id) || id;
    M.folderRequests.set(accountId, (M.folderRequests.get(accountId) || 0) + 1);
    M.folders[accountId] = (M.folders[accountId] || []).map(f => ({ ...f, id: map(f.id), parentId: map(f.parentId) }));
    if (result.folder) M.folders[accountId] = M.folders[accountId].filter(f => f.id !== result.folder.id).concat(result.folder);
    for (const folder of result.updatedFolders || []) M.folders[accountId] = M.folders[accountId].filter(f => f.id !== folder.id).concat(folder);
    const deleted = new Set(result.deletedFolderIds || []);
    M.folders[accountId] = M.folders[accountId].filter(f => !deleted.has(f.id));
    const deletedSelection = M.account === accountId && M.folder.startsWith('custom:') && deleted.has(M.folder.slice(7));
    if (deletedSelection) { M.folder = 'inbox'; M.detail = null; M.detailGeneration++; M.generation++; renderEmpty(); }
    for (const [oldId, id] of renamed) if (M.collapsedFolders.delete(`${accountId}\n${oldId}`)) M.collapsedFolders.add(`${accountId}\n${id}`);
    const selected = M.account === accountId && M.folder.startsWith('custom:') && renamed.has(M.folder.slice(7));
    if (selected) { M.folder = `custom:${map(M.folder.slice(7))}`; M.generation++; }
    for (const mail of M.emails) if (mail.accountId === accountId) mail.folder = map(mail.folder);
    if (M.detail?.accountId === accountId && renamed.has(M.detail.folder)) {
      M.detail.folder = map(M.detail.folder); M.detailGeneration++;
      if (!M.detail.messages?.length) { M.detail = null; renderEmpty(); }
    }
    for (const attachment of M.draft?.attachments || []) if (attachment.source?.accountId === accountId) attachment.source.folder = map(attachment.source.folder);
    const form = $('mailFolderForm');
    if (form?.dataset.account === accountId) {
      form.dataset.folder = map(form.dataset.folder);
      form.querySelectorAll('option').forEach(option => { option.value = map(option.value); });
    }
    return selected || deletedSelection;
  }
  function folderTree(folders) {
    const children = new Map();
    for (const folder of folders) { const parent = folder.parentId || null; if (!children.has(parent)) children.set(parent, []); children.get(parent).push(folder); }
    for (const group of children.values()) group.sort((a, b) => a.name.localeCompare(b.name));
    const row = (folder, depth = 0, preferredValue = null) => {
      const value = preferredValue || (['inbox', 'sent', 'archive', 'trash'].includes(folder.kind) ? folder.kind : `custom:${folder.id}`), nested = children.get(folder.id) || [];
      const collapsed = M.collapsedFolders.has(`${M.account}\n${folder.id}`), label = folder.kind === 'provider-drafts' ? `${folder.name} (${account(M.account)?.provider === 'microsoft' ? 'Outlook' : 'server'})` : folder.name;
      const glyph = ({ inbox: 'inbox', sent: 'send', archive: 'archive', trash: 'trash-2', junk: 'shield-alert', 'provider-drafts': 'file-pen-line' })[folder.kind] || 'folder';
      return `<div class="mail-folder-branch"><div class="mail-folder-row ${M.folder === value ? 'active' : ''}" style="--folder-depth:${Math.min(depth, 7)}">${nested.length ? `<button class="mail-folder-toggle" data-mail="folder-toggle" data-value="${e(folder.id)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${e(label)}" aria-expanded="${!collapsed}">${icon(collapsed ? 'chevron-right' : 'chevron-down', 13)}</button>` : '<span class="mail-folder-spacer"></span>'}<button class="mail-folder-open" ${folder.selectable === false ? 'disabled aria-label="Folder group"' : ''} data-mail="folder" data-value="${e(value)}" title="${e(folder.path || label)}" ${M.folder === value ? 'aria-current="page"' : ''}>${icon(glyph, 15)}<span>${e(label)}</span>${folder.unreadCount ? `<small>${folder.unreadCount}</small>` : ''}</button><span class="mail-folder-actions">${folder.canCreateChildren ? command('folder-new', `New subfolder in ${label}`, 'folder-plus', folder.id, 'mail-icon-btn') : ''}${folder.canRename ? command('folder-rename', `Rename ${label}`, 'pencil', folder.id, 'mail-icon-btn') : ''}</span></div>${nested.length && !collapsed ? nested.map(child => row(child, depth + 1)).join('') : ''}</div>`;
    };
    return { row, roots: children.get(null) || [] };
  }
  function showFolderDialog(rename = false, folderId = '') {
    const a = account(M.account); if (!['gmail', 'microsoft', 'imap'].includes(a?.provider)) throw new Error('Select an account to manage its folders or labels.');
    const label = a.provider === 'gmail';
    const folders = M.folders[a.id] || [], folder = folders.find(f => f.id === folderId);
    if (rename && !folder?.canRename) throw new Error('Choose a custom folder to rename.');
    if (!rename && folderId && !folder?.canCreateChildren) throw new Error('Choose a folder that accepts subfolders.');
    $('mailFolderDialog')?.remove();
    const dialog = document.createElement('dialog'); dialog.id = 'mailFolderDialog'; dialog.className = 'mail-folder-dialog';
    dialog.setAttribute('aria-labelledby', 'mailFolderDialogTitle');
    dialog.innerHTML = `<form id="mailFolderForm" data-account="${e(a.id)}" data-folder="${e(rename ? folderId : '')}" data-operation="${label ? rename ? 'update_label' : 'create_label' : rename ? 'rename_folder' : 'create_folder'}"><div class="mail-folder-dialog-heading"><h2 id="mailFolderDialogTitle">${label ? rename ? 'Edit label' : 'New label' : rename ? 'Rename folder' : folder ? 'New subfolder' : 'New folder'}</h2>${command('folder-cancel', 'Close', 'x', '', 'mail-icon-btn')}</div><p>${e(a.label)} · Changes sync with ${label ? 'Gmail' : a.provider === 'microsoft' ? 'Outlook' : 'your mail server'}</p><label>${label ? 'Label' : 'Folder'} name<input id="mailFolderName" name="name" required maxlength="${label ? 225 : 255}" autocomplete="off" value="${e(rename ? label ? folder.name.split('/').at(-1) : folder.name : '')}" autofocus></label><label>${label ? 'Nest under' : 'Location'}<select id="mailFolderParent" aria-label="${label ? 'Nest under' : 'Location'}" ${rename && !label ? 'disabled' : ''}><option value="">Top level</option>${folders.filter(f => f.canCreateChildren && !(label && rename && (f.id === folder.id || f.name.startsWith(`${folder.name}/`)))).map(f => `<option value="${e(f.id)}" ${f.id === (rename ? folder.parentId : folderId) ? 'selected' : ''}>${e(f.path || f.name)}</option>`).join('')}</select></label><p id="mailFolderError" class="mail-error-text" role="alert" hidden></p><div class="mail-folder-dialog-footer">${command('folder-cancel', 'Cancel', '', '', '')}<button type="submit" class="mail-btn mail-primary">${label ? rename ? 'Save label' : 'Create label' : rename ? 'Save name' : 'Create folder'}</button></div></form>`;
    // Keep background workspace shortcuts from consuming the modal's Escape.
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.addEventListener('cancel', event => { if (M.folderMutation) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove());
    $('mailWorkspace').append(dialog); dialog.showModal(); $('mailFolderName').select();
  }
  async function saveFolderForm() {
    const form = $('mailFolderForm'); if (!form || M.folderMutation || !form.reportValidity()) return;
    const session = M.session, accountId = form.dataset.account, operation = form.dataset.operation;
    const args = { account: accountId, ...(operation !== 'delete_label' ? { name: $('mailFolderName').value } : {}), ...(['rename_folder', 'update_label', 'delete_label'].includes(operation) ? { folder: form.dataset.folder } : {}), ...(['create_folder', 'create_label', 'update_label'].includes(operation) ? { parentFolder: $('mailFolderParent').value } : {}) };
    const mutation = {}; M.folderMutation = mutation; $('mailFolderError').hidden = true;
    form.querySelectorAll('input,select,button').forEach(el => { el.disabled = true; });
    try {
      const result = await api(operation, args, true);
      if (session !== M.session) return;
      const reload = applyFolderChange(accountId, result), folders = M.folders[accountId] || [];
      let parentId = result.folder?.parentId;
      const seen = new Set();
      while (parentId && !seen.has(parentId)) { seen.add(parentId); M.collapsedFolders.delete(`${accountId}\n${parentId}`); parentId = folders.find(f => f.id === parentId)?.parentId; }
      form.closest('dialog')?.close(); M.folderMutation = false; renderNavigation();
      const providerName = ({ gmail: 'Gmail', microsoft: 'Outlook', imap: 'your mail server' })[account(accountId)?.provider];
      const message = `${result.partial ? 'Some labels updated' : operation === 'delete_label' ? 'Label deleted' : operation === 'update_label' ? 'Label updated' : operation === 'create_label' ? 'Label created' : operation === 'rename_folder' ? 'Folder renamed' : 'Folder created'} in ${providerName}.`;
      notice(message);
      const errors = await refreshFolders(accountId);
      if (reload) await load();
      notice([message, result.warning].filter(Boolean).join(' '), !!result.warning);
      if (errors.length) notice(`${message} Refresh to reload the complete ${operation.endsWith('_label') ? 'label list' : 'folder tree'}. ${errors.join(' · ')}`, true);
    } catch (error) {
      if (session === M.session && form.isConnected) { const errorElement = form.querySelector('#mailFolderError'); errorElement.textContent = error.message; errorElement.hidden = false; }
    } finally {
      if (session === M.session) {
        if (M.folderMutation === mutation) M.folderMutation = false;
        form.querySelectorAll('input,select,button').forEach(el => { el.disabled = el.id === 'mailFolderParent' && operation === 'rename_folder'; });
      }
    }
  }
  function showLabelDelete(id) {
    const a = account(M.account), label = M.folders[M.account]?.find(f => f.id === id && f.kind === 'label');
    if (a?.provider !== 'gmail' || !label) throw new Error('Choose a custom Gmail label.');
    $('mailFolderDialog')?.remove();
    const dialog = document.createElement('dialog'); dialog.id = 'mailFolderDialog'; dialog.className = 'mail-folder-dialog'; dialog.setAttribute('aria-labelledby', 'mailFolderDialogTitle');
    dialog.innerHTML = `<form id="mailFolderForm" data-account="${e(a.id)}" data-folder="${e(id)}" data-operation="delete_label"><div class="mail-folder-dialog-heading"><h2 id="mailFolderDialogTitle">Delete label</h2>${command('folder-cancel', 'Close', 'x', '', 'mail-icon-btn')}</div><p>Remove <strong>${e(label.name)}</strong> from Gmail and its messages? Your emails are kept. Nested labels keep their names.</p><p id="mailFolderError" class="mail-error-text" role="alert" hidden></p><div class="mail-folder-dialog-footer">${command('folder-cancel', 'Cancel', '', '', '')}<button type="submit" class="mail-btn mail-primary">Delete label</button></div></form>`;
    // Keep background workspace shortcuts from consuming the modal's Escape.
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.addEventListener('cancel', event => { if (M.folderMutation) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove()); $('mailWorkspace').append(dialog); dialog.showModal();
  }
  function renderNavigation() {
    const a = account(M.account);
    const folders = M.folders[M.account] || [], tree = ['microsoft', 'imap'].includes(a?.provider) ? folderTree(folders) : null;
    const standard = [['inbox', 'Inbox', 'inbox'], ['drafts', 'Drafts', 'file-pen-line'], ['sent', 'Sent', 'send'], ['archive', 'Archive', 'archive'], ['trash', 'Trash', 'trash-2']];
    if (a?.provider === 'gmail') standard.splice(1, 0, ['starred', 'Starred', 'star']);
    const folderButtons = standard.filter(([kind]) => kind === 'inbox' || kind === 'drafts' || M.account === 'all' || folders.some(f => f.kind === kind)).map(([id, label, glyph]) => {
      const folder = tree && folders.find(f => f.kind === id);
      if (folder?.parentId) return '';
      if (folder) return tree.row(folder, 0, id);
      return `<button class="mail-nav-item ${M.folder === id ? 'active' : ''}" data-mail="folder" data-value="${id}" ${M.folder === id ? 'aria-current="page"' : ''}>${icon(glyph, 18)}<span>${label}</span>${id === 'drafts' && M.drafts.length ? `<b>${M.drafts.length}</b>` : ''}</button>`;
    }).join('');
    const folderButton = (f, controls = false) => `<div class="mail-label-row"><button class="mail-nav-item ${M.folder === `custom:${f.id}` ? 'active' : ''}" data-mail="folder" data-value="${e(`custom:${f.id}`)}" title="${e(f.name)}">${icon(f.kind === 'label' ? 'tag' : ({ SPAM: 'shield-alert', IMPORTANT: 'bookmark', DRAFT: 'file-pen-line', __snoozed__: 'clock', __all__: 'mails', __purchases__: 'shopping-bag' })[f.id] || 'folder', 16)}<span>${e(f.name)}</span></button>${controls ? `<span class="mail-label-actions">${command('label-edit', `Edit label ${f.name}`, 'pencil', f.id, 'mail-icon-btn')}${command('label-delete', `Delete label ${f.name}`, 'trash-2', f.id, 'mail-icon-btn')}</span>` : ''}</div>`;
    const extraFolders = tree ? tree.roots.filter(f => !['inbox', 'sent', 'archive', 'trash'].includes(f.kind)).map(f => tree.row(f)).join('') : folders.filter(f => ['label', 'folder'].includes(f.kind)).map(f => folderButton(f, a?.provider === 'gmail' && f.kind === 'label')).join('');
    const gmailViews = a?.provider === 'gmail' ? folders.filter(f => ['system-label', 'category', 'provider-drafts', 'view'].includes(f.kind)).map(f => folderButton(f)).join('') : '';
    $('mailNavigation').innerHTML = `${command('compose', 'New message', 'plus', '', 'mail-primary mail-new')}<div class="mail-nav-group"><span class="mail-eyebrow">MAILBOXES</span><button class="mail-account ${M.account === 'all' ? 'active' : ''}" data-mail="account" data-value="all">${icon('layers', 17)}<span>All accounts</span>${M.account === 'all' ? icon('check', 14) : ''}</button>${M.accounts.map((a, i) => `<button class="mail-account ${M.account === a.id ? 'active' : ''}" data-mail="account" data-value="${e(a.id)}"><span class="mail-account-dot tone-${i % 4}"></span><span>${e(a.label || a.provider)}<small>${e(a.email || a.username || ({ gmail: 'Gmail', microsoft: 'Microsoft', imap: 'IMAP' })[a.provider])}</small></span>${M.account === a.id ? icon('check', 14) : ''}</button>`).join('')}</div><div class="mail-nav-group mail-folder-nav">${folderButtons}${gmailViews}</div>${a ? `<div class="mail-nav-group"><div class="mail-folder-section-heading"><span class="mail-eyebrow">${a.provider === 'gmail' ? 'LABELS' : 'FOLDERS'}</span></div>${tree ? command('folder-new', 'New folder', 'folder-plus', '', 'mail-folder-create') : a.provider === 'gmail' ? command('label-new', 'New label', 'tag', '', 'mail-folder-create') : ''}${extraFolders || `<p class="mail-nav-hint">${a.provider === 'gmail' ? 'No labels yet' : 'No additional folders'}</p>`}</div>` : ''}<div class="mail-nav-bottom">${command('settings', 'Manage accounts', 'settings-2')}<p>Connected to your mail providers</p></div>`;
    $('mailFolderTitle').textContent = folderTitle(); $('mailScope').textContent = a?.label || 'YOUR MAIL';
  }
  function visible() { return M.filter === 'unread' ? M.emails.filter(m => m.unread) : M.emails; }
  function renderList() {
    const drafts = M.folder === 'drafts';
    const list = drafts ? M.drafts.filter(d => M.account === 'all' || d.accountId === M.account).filter(d => !M.query || `${d.subject} ${d.body} ${d.to}`.toLowerCase().includes(M.query.toLowerCase())) : visible();
    $('mailLoadedCount').textContent = `${list.length} ${drafts ? 'saved' : 'loaded'}`;
    document.querySelectorAll('.mail-filter button').forEach(button => { button.classList.toggle('active', button.dataset.value === M.filter); button.disabled = drafts; });
    $('mailSelectAll').disabled = drafts || !list.length;
    $('mailSelectAll').checked = !drafts && list.length > 0 && list.every(m => M.selected.has(key(m)));
    $('mailSelectAll').indeterminate = !drafts && M.selected.size > 0 && !list.every(m => M.selected.has(key(m)));
    $('mailList').innerHTML = list.map((mail, index) => {
      if (drafts) return `<article class="mail-row mail-draft-row ${M.draft?.id === mail.id ? 'selected' : ''}" role="listitem"><button class="mail-row-main" data-mail="edit-draft" data-value="${e(mail.id)}" aria-label="Open draft: ${e(mail.subject || 'Untitled message')}"><div class="mail-row-heading"><span class="mail-draft-label">Draft</span><time>${date(mail.updatedAt)}</time></div><strong>${e(mail.subject || 'Untitled message')}</strong><p>${e(mail.to || 'No recipients yet')}</p><p>${e(mail.body?.slice(0, 100) || 'Continue writing…')}</p>${mail.status !== 'draft' ? '<small class="mail-error-text">Check Sent · delivery unconfirmed</small>' : ''}</button>${mail.status === 'draft' ? command('delete-draft', `Delete draft: ${mail.subject || 'Untitled message'}`, 'trash-2', mail.id, 'mail-icon-btn mail-draft-delete') : ''}</article>`;
      const k = key(mail), selected = M.detail && key(M.detail) === k;
      const tone = M.accounts.findIndex(a => a.id === mail.accountId) % 4;
      return `<article class="mail-row ${mail.unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${M.selected.has(k) ? 'checked' : ''}" role="listitem"><button class="mail-row-select ${M.selected.has(k) ? 'is-checked' : ''}" data-mail="select" data-value="${e(k)}" aria-label="Select ${e(mail.subject)}" aria-pressed="${M.selected.has(k)}">${icon(M.selected.has(k) ? 'square-check' : 'square', 15)}</button><button class="mail-row-main" data-mail="read" data-value="${e(k)}" aria-label="${e(name(mail.from))}: ${e(mail.subject)}" ${selected ? 'aria-current="true"' : ''}><div class="mail-row-heading"><span>${e(name(mail.from))}</span><time>${date(mail.date)}</time></div><strong>${e(mail.subject || '(No subject)')}</strong><p>${e(mail.snippet || 'Open to read this message')}</p><div class="mail-row-foot"><span class="mail-mailbox-tag"><i class="tone-${tone}"></i>${e(account(mail.accountId)?.label || '')}</span>${mail.hasAttachments || mail.attachments?.length ? icon('paperclip', 13) : ''}${mail.unread ? '<span class="mail-unread-dot" aria-label="Unread"></span>' : ''}</div></button><button class="mail-row-star ${mail.starred ? 'starred' : ''}" data-mail="star" data-value="${e(k)}" aria-label="${mail.starred ? 'Unstar' : 'Star'} message">${icon('star', 15)}</button></article>`;
    }).join('') || `<div class="mail-list-empty">${icon(M.query ? 'search' : 'inbox', 30)}<strong>${M.query ? 'No matches here' : drafts ? 'Your drafts will live here' : M.filter === 'unread' ? 'No unread mail loaded' : 'You’re all caught up'}</strong><p>${M.query ? 'Try another search or choose a different mailbox.' : drafts ? 'Start a message. We’ll save it as you write.' : 'Refresh to check for new messages.'}</p></div>`;
    $('mailListFooter').innerHTML = !drafts && Object.values(M.cursors).some(Boolean) ? command('more', 'Load more messages', 'chevron-down') : `<span>${list.length ? 'You’re viewing the latest loaded mail' : ''}</span>`;
    const bulk = $('mailBulk'); bulk.hidden = !M.selected.size || drafts;
    bulk.innerHTML = `<span>${M.selected.size} selected</span>${command('archive', 'Archive', 'archive', '', 'mail-icon-btn')}${command('unread', 'Mark unread', 'mail', '', 'mail-icon-btn')}${command('trash', 'Move to Trash', 'trash-2', '', 'mail-icon-btn')}${command('clear-selection', 'Clear selection', 'x', '', 'mail-icon-btn')}`;
  }
  async function refreshDrafts() {
    const generation = M.generation;
    const data = await api('list_drafts');
    if (generation !== M.generation) return;
    M.drafts = data.drafts || [];
    if (M.draft && !M.dirty && !M.saving && !M.upload && !M.busy && !M.deletingDraft) {
      const fresh = M.drafts.find(d => d.id === M.draft.id);
      if (fresh && (fresh.version > M.draft.version || fresh.status !== M.draft.status)) {
        const edited = fresh.version > M.draft.version;
        M.draft = fresh; renderComposer();
        if (edited) notice('This draft was updated in OE.');
      }
      else if (!fresh) { M.draft = null; M.detail ? renderReader() : renderEmpty(); notice('This draft was sent or discarded elsewhere.'); }
    }
    if (M.folder === 'drafts') renderList();
    renderNavigation();
  }
  async function load(more = false) {
    const generation = ++M.generation;
    notice('');
    if (!more) { M.selected.clear(); M.emails = []; M.cursors = {}; renderList(); }
    if (M.folder === 'drafts') { await refreshDrafts(); return; }
    if (!M.accounts.length) { renderEmpty('Connect your first mailbox', 'Bring your Gmail, Microsoft or IMAP accounts together in one place.', true); return; }
    $('mailListFooter').innerHTML = '<span class="mail-loading">Loading messages…</span>';
    const accounts = M.accounts.filter(a => (M.account === 'all' || a.id === M.account) && folderFor(a) && (!more || M.cursors[a.id]));
    const result = await Promise.allSettled(accounts.map(async a => {
      const folder = folderFor(a);
      const data = await api('list', { account: a.id, folder, query: M.query, ...(more ? { pageToken: M.cursors[a.id] } : {}) });
      return { id: a.id, folder, data };
    }));
    if (generation !== M.generation || !active()) return;
    const errors = [];
    result.forEach((r, i) => {
      if (r.status === 'rejected') { errors.push(`${accounts[i].label}: ${r.reason.message}`); return; }
      const { id, folder, data } = r.value;
      for (const mail of data.emails || []) {
        const item = { ...mail, accountId: id, folder };
        if (!M.emails.some(m => key(m) === key(item))) M.emails.push(item);
      }
      M.cursors[id] = data.nextPageToken || null;
    });
    M.emails.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    renderList();
    if (errors.length) notice(errors.join(' · '), true);
    refreshDrafts().catch(error => notice(error.message, true));
  }
  function renderEmpty(title = 'A little room for your mail', message = 'Select a conversation to read, reply, or work on it with your assistant.', connect = false) {
    if (M.draft) return;
    M.readerResize?.disconnect();
    $('mailWorkspace').classList.toggle('mail-reading-open', !!M.detail);
    $(connect ? 'mailList' : 'mailReading').innerHTML = `<div class="mail-reader-empty"><div class="mail-empty-symbol">${icon('mail-open', 38)}</div><span class="mail-eyebrow">OPENENSEMBLE MAIL</span><h2>${e(title)}</h2><p>${e(message)}</p>${connect ? command('settings', 'Connect an account', 'plus', '', 'mail-primary') : M.detail ? command('back', 'Back to messages', 'arrow-left') : `<div class="mail-empty-shortcuts"><span><kbd>N</kbd> New message</span><span><kbd>/</kbd> Search mail</span></div>`}</div>`;
  }
  async function read(k) {
    if (M.draft) { await saveDraft(); M.draft = null; }
    const meta = M.emails.find(m => key(m) === k); if (!meta) return;
    M.readerResize?.disconnect();
    const generation = ++M.detailGeneration;
    M.detail = { ...meta, messages: [] }; M.images = false;
    $('mailWorkspace').classList.add('mail-reading-open'); $('mailWorkspace').classList.remove('mail-navigation-open');
    $('mailReading').innerHTML = '<div class="mail-reader-empty"><span class="mail-loading">Opening conversation…</span></div>'; renderList();
    try {
      const data = await api('read', { account: meta.accountId, messageId: meta.id, folder: meta.folder });
      if (generation !== M.detailGeneration || !active()) return;
      M.detail = { ...meta, messages: data.messages || [] }; renderReader(true);
    } catch (error) { if (generation === M.detailGeneration) { renderEmpty('Couldn’t open this message', error.message); notice(error.message, true); } }
  }
  function renderReader(markOnDisplay = false) {
    if (!M.detail || M.draft) return;
    M.readerResize?.disconnect();
    $('mailWorkspace').classList.add('mail-reading-open');
    const detail = M.detail, messages = detail.messages || [];
    const folders = M.folders[detail.accountId] || [];
    $('mailReading').innerHTML = `<div class="mail-conversation"><article class="mail-message-card" aria-label="Email conversation"><header class="mail-message-header"><div class="mail-reader-toolbar">${command('back', 'Back to messages', 'arrow-left', '', 'mail-reader-back mail-icon-btn')}${command('archive', 'Archive', 'archive')}${command(M.folder === 'trash' ? 'restore' : 'trash', M.folder === 'trash' ? 'Restore' : 'Trash', M.folder === 'trash' ? 'inbox' : 'trash-2')}${command(detail.unread ? 'read-state' : 'unread', detail.unread ? 'Mark read' : 'Mark unread', detail.unread ? 'mail-open' : 'mail', '', 'mail-icon-btn')}<select id="mailMove" aria-label="Move to folder"><option value="">Move to…</option>${folders.filter(f => f.canMoveMessages !== false && !['starred', 'trash', 'sent'].includes(f.kind) && f.id !== '__archive__').map(f => `<option value="${e(f.id)}">${e(f.path || f.name)}</option>`).join('')}</select><span class="mail-toolbar-space"></span>${command('summarize', 'Summarize', 'sparkles', '', 'mail-summarize')}</div><div class="mail-subject"><span class="mail-eyebrow">${e(account(detail.accountId)?.label || 'MAIL')}<span> / </span>${messages.length} ${messages.length === 1 ? 'MESSAGE' : 'MESSAGES'}</span><h2>${e(detail.subject)}</h2></div></header><div class="mail-thread">${messages.map((message, index) => `<details class="mail-thread-message" ${message.id === detail.id || index === messages.length - 1 ? 'open' : ''}><summary><span class="mail-avatar tone-${index % 4}">${e(initials(message.from))}</span><span class="mail-sender"><strong>${e(name(message.from))}</strong><small>${e(email(message.from))}</small></span><time>${e(date(message.date, true))}</time>${icon('chevron-down', 14)}</summary><div class="mail-recipient-line">To: ${e(message.to || 'You')}${message.cc ? `<br>Cc: ${e(message.cc)}` : ''}</div><iframe class="mail-body-frame" title="${e(message.subject || 'Message content')}" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" data-message-index="${index}"></iframe>${message.attachments?.length ? `<div class="mail-attachments">${message.attachments.map(file => `<a class="mail-attachment" href="/api/mail/attachment?${e(new URLSearchParams({ account: detail.accountId, folder: detail.folder, messageId: message.id, attachmentId: file.id }).toString())}" download="${e(file.name)}">${icon('file', 18)}<span>${e(file.name)}<small>${file.size ? `${Math.max(1, Math.round(file.size / 1024))} KB` : 'Download attachment'}</small></span>${icon('download', 15)}</a>`).join('')}</div>` : ''}</details>`).join('')}</div><footer class="mail-message-footer"><div class="mail-reply-actions">${command('reply', 'Reply', 'reply')}${command('reply-all', 'Reply all', 'reply-all')}${command('forward', 'Forward', 'forward')}${command('draft-ai', 'Draft with AI', 'sparkles')}</div><button class="mail-images-control" data-mail="images">${M.images ? 'External images enabled for this conversation' : 'Load external images'}</button></footer></article></div>`;
    document.querySelectorAll('#mailReading .mail-body-frame').forEach(frame => {
      const message = messages[Number(frame.dataset.messageIndex)];
      if (markOnDisplay && detail.unread && message.id === detail.id) {
        const generation = M.detailGeneration;
        frame.addEventListener('load', () => markDisplayedRead(detail, generation, frame), { once: true });
      }
      const clean = DOMPurify.sanitize(message.html || `<p>${e(message.text).replace(/\n/g, '<br>')}</p>`, { FORBID_TAGS: ['script', 'iframe', 'form', 'object', 'embed', 'link', 'meta', 'base'], FORBID_ATTR: ['srcdoc', 'srcset'] });
      const content = document.createElement('template'); content.innerHTML = clean;
      content.content.querySelectorAll('a').forEach(link => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${M.images ? 'https: http:' : ''}; style-src 'unsafe-inline';"><style>html{color-scheme:light}body{margin:0;padding:16px;font:16px/1.65 system-ui,sans-serif;color:#243041;background:white;overflow-wrap:anywhere}img,table{max-width:100%!important}img{height:auto}a{color:#356abb}pre{white-space:pre-wrap}blockquote{border-left:2px solid #dbe1e9;margin-left:0;padding-left:16px;color:#667085}</style></head><body>${content.innerHTML}</body></html>`;
    });
    sizeMailBodies();
  }
  const readingUpdates = new Map();
  const readKey = mail => `${mail.accountId}\n${mail.folder}\n${mail.id}`;
  function applyMessageFlags({ account: accountId, messageFolder, messageIds, action }) {
    const ids = new Set(messageIds), isRead = ['read', 'unread'].includes(action), unread = action === 'unread';
    const matches = mail => mail && mail.accountId === accountId && ids.has(mail.id) && (account(accountId)?.provider !== 'imap' || mail.folder === messageFolder);
    for (const mail of M.emails.filter(matches)) {
      if (isRead) mail.unread = unread; else mail.starred = action === 'star';
      const row = [...$('mailList').querySelectorAll('[data-mail="read"]')].find(button => button.dataset.value === key(mail))?.closest('.mail-row');
      if (!row) continue;
      if (isRead) {
        row.classList.toggle('unread', unread);
        const dot = row.querySelector('.mail-unread-dot');
        if (!unread) dot?.remove();
        else if (!dot) row.querySelector('.mail-row-foot').insertAdjacentHTML('beforeend', '<span class="mail-unread-dot" aria-label="Unread"></span>');
      } else {
        const star = row.querySelector('.mail-row-star');
        star.classList.toggle('starred', mail.starred); star.setAttribute('aria-label', `${mail.starred ? 'Unstar' : 'Star'} message`);
      }
      if (M.filter === 'unread' && !mail.unread) M.selected.delete(key(mail));
    }
    if (matches(M.detail)) {
      if (isRead) {
        M.detail.unread = unread;
        for (const message of M.detail.messages || []) if (ids.has(message.id)) message.unread = unread;
        const toggle = $('mailReading')?.querySelector('.mail-reader-toolbar [data-mail="read-state"],.mail-reader-toolbar [data-mail="unread"]');
        const cmd = unread ? 'read-state' : 'unread';
        if (toggle && toggle.dataset.mail !== cmd) toggle.replaceWith(document.createRange().createContextualFragment(command(cmd, unread ? 'Mark read' : 'Mark unread', unread ? 'mail-open' : 'mail', '', 'mail-icon-btn')));
      } else M.detail.starred = action === 'star';
    }
    if (isRead && M.filter === 'unread' && M.folder !== 'drafts') renderList();
  }
  function markDisplayedRead(detail, generation, frame) {
    if (!active() || M.draft || generation !== M.detailGeneration || M.detail !== detail || !frame.isConnected || !frame.closest('details').open || !frame.getClientRects().length) return;
    const session = M.session, id = `${session}\n${readKey(detail)}`;
    if (readingUpdates.has(id)) return;
    const pending = (async () => {
      try {
        const result = await api('update', { account: detail.accountId, folder: detail.folder, messageIds: [detail.id], action: 'read' }, true);
        if (result.count !== 1 || result.errors?.length) throw new Error(result.errors?.map(error => error.error).join(' · ') || 'The provider did not confirm the read status.');
        if (session !== M.session) return;
        if (active()) applyMessageFlags({ account: detail.accountId, messageFolder: detail.folder, messageIds: [detail.id], action: 'read' });
        if (generation === M.detailGeneration && $('mailNotice')?.textContent.startsWith('Couldn’t mark this message as read.')) notice('');
      } catch (error) {
        if (session === M.session && generation === M.detailGeneration && active()) notice(`Couldn’t mark this message as read. ${error.message}`, true);
      } finally { readingUpdates.delete(id); }
    })();
    readingUpdates.set(id, pending);
  }
  function sizeMailBodies() {
    const pane = $('mailReading'), card = pane.querySelector('.mail-message-card');
    const conversation = card.parentElement;
    const resize = () => {
      if (!card.isConnected || !pane.clientHeight) return;
      const padding = getComputedStyle(conversation);
      const chrome = [...card.querySelectorAll('.mail-message-header,.mail-message-footer,.mail-thread-message>summary,.mail-recipient-line,.mail-attachments')].reduce((height, el) => height + (el.getClientRects().length && (!el.closest('details') || el.matches('summary') || el.closest('details').open) ? el.getBoundingClientRect().height : 0), 0);
      const height = Math.max(320, Math.floor(pane.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom) - chrome - 8));
      card.style.setProperty('--mail-body-height', `${height}px`);
    };
    M.readerResize = new ResizeObserver(resize);
    M.readerResize.observe(pane);
    card.querySelectorAll('.mail-message-header,.mail-message-footer').forEach(el => M.readerResize.observe(el));
    card.querySelectorAll('details').forEach(el => el.addEventListener('toggle', resize));
    resize();
  }
  async function update(action, destination, single) {
    if (M.busy) return;
    const session = M.session;
    const chosen = single ? [single] : M.emails.filter(m => M.selected.has(key(m)));
    if (!chosen.length) return;
    M.busy = true; notice('Updating your mailbox…');
    try {
      // An explicit action after opening a message must run after its automatic
      // read update, so Mark unread cannot be overwritten by the earlier request.
      await Promise.all(chosen.map(mail => readingUpdates.get(`${session}\n${readKey(mail)}`)));
      if (session !== M.session) return;
      const groups = new Map();
      for (const mail of chosen) { const k = `${mail.accountId}\n${mail.folder}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(mail); }
      const results = await Promise.allSettled([...groups.values()].map(group => api('update', { account: group[0].accountId, folder: group[0].folder, messageIds: group.map(m => m.id), action, ...(destination ? { destination } : {}) }, true)));
      if (session !== M.session) return;
      let count = 0; const errors = [];
      for (const result of results) { if (result.status === 'rejected') errors.push(result.reason.message); else { count += result.value.count || 0; errors.push(...(result.value.errors || []).map(error => error.error)); } }
      if (['read', 'unread', 'star', 'unstar'].includes(action)) {
        [...groups.values()].forEach((group, index) => {
          const result = results[index]; if (result.status !== 'fulfilled') return;
          const messageIds = result.value.completed || (result.value.count === group.length ? group.map(m => m.id) : []);
          applyMessageFlags({ account: group[0].accountId, messageFolder: group[0].folder, messageIds, action });
        });
      } else {
        if (!errors.length) { M.detail = null; M.detailGeneration++; renderEmpty(); $('mailWorkspace').classList.remove('mail-reading-open'); }
        await load();
      }
      notice(`${count} message${count === 1 ? '' : 's'} updated.${errors.length ? ` ${errors.join(' · ')}` : ''}`, !!errors.length);
    } finally { if (session === M.session) M.busy = false; }
  }
  function captureDraft() {
    if (!M.draft || !$('mailComposer')) return;
    for (const key of ['to', 'cc', 'bcc', 'subject']) M.draft[key] = $(`mailDraft_${key}`).value;
    M.draft.accountId = $('mailDraftAccount').value;
    M.draft.body = $('mailEditor').innerText;
    M.draft.html = editorHtml($('mailEditor').innerHTML);
  }
  function changed() { captureDraft(); M.dirty = true; $('mailSaveStatus').textContent = 'Unsaved changes'; clearTimeout(M.timer); if (!M.conflict) M.timer = setTimeout(() => saveDraft().catch(error => notice(error.message, true)), 700); }
  function draftConflict() {
    M.conflict = true;
    if ($('mailDraftConflict') || !$('mailComposer')) return;
    const bar = document.createElement('div'); bar.id = 'mailDraftConflict'; bar.className = 'mail-notice error';
    bar.innerHTML = `This draft changed elsewhere. Your text is still here.<div>${command('draft-copy', 'Keep mine as a new draft', 'copy')}${command('draft-latest', 'Load latest version', 'refresh-cw')}</div>`;
    $('mailComposer').prepend(bar);
  }
  async function saveDraft() {
    clearTimeout(M.timer);
    if (M.saving) await M.saving;
    if (!M.draft || !M.dirty) return;
    if (M.conflict) throw new Error('Choose which draft version to keep before continuing.');
    captureDraft();
    const draft = structuredClone(M.draft), generation = M.detailGeneration;
    M.dirty = false;
    $('mailSaveStatus').textContent = 'Saving…';
    M.saving = (async () => {
      try {
        const result = await api('save_draft', { account: draft.accountId, ...(draft.id ? { draftId: draft.id, version: draft.version } : {}), draft: { to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, html: draft.html, inReplyTo: draft.inReplyTo, references: draft.references, threadId: draft.threadId, replyMessageId: draft.replyMessageId || '', attachments: draft.attachments } }, true);
        if (generation !== M.detailGeneration || !M.draft) return;
        M.draft.id = result.draft.id; M.draft.version = result.draft.version;
        M.drafts = M.drafts.filter(d => d.id !== result.draft.id).concat(result.draft);
        $('mailSaveStatus').textContent = M.dirty ? 'Unsaved changes' : 'Saved in OE';
        renderNavigation(); if (M.folder === 'drafts') renderList();
      } catch (error) { if (generation === M.detailGeneration) { M.dirty = true; if ($('mailSaveStatus')) $('mailSaveStatus').textContent = 'Not saved — retry'; if (/changed elsewhere|no longer available/i.test(error.message)) draftConflict(); } throw error; }
      finally { if (generation === M.detailGeneration) M.saving = null; }
    })();
    await M.saving;
    if (M.dirty) await saveDraft();
  }
  async function compose(mode = 'new') {
    if (M.upload) throw new Error('Wait for attachments to finish uploading.');
    if (M.draft) await saveDraft();
    const detail = M.detail, message = detail?.messages?.find(m => m.id === detail.id);
    if (mode !== 'new' && !message) throw new Error('The selected message is unavailable. Reopen it before replying or forwarding.');
    const accountId = mode !== 'new' && detail ? detail.accountId : M.account === 'all' ? M.accounts[0]?.id : M.account;
    if (!accountId) { notice('Connect an email account to start writing.', true); return; }
    M.detailGeneration++;
    const draft = { accountId, to: '', cc: '', bcc: '', subject: '', body: '', html: '', attachments: [], status: 'draft', inReplyTo: '', references: '', threadId: '' };
    if (mode !== 'new' && message) {
      const text = message.text || new DOMParser().parseFromString(DOMPurify.sanitize(message.html), 'text/html').body.textContent || '';
      if (mode === 'forward') {
        draft.subject = /^Fwd:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`;
        draft.body = `\n\n---------- Forwarded message ----------\nFrom: ${message.from}\nDate: ${date(message.date, true)}\nSubject: ${message.subject}\nTo: ${message.to}\n\n${text}`;
        draft.html = `<p><br></p><p>---------- Forwarded message ----------<br>From: ${e(message.from)}<br>Date: ${e(date(message.date, true))}<br>Subject: ${e(message.subject)}<br>To: ${e(message.to)}</p><blockquote>${DOMPurify.sanitize(message.html || e(text).replace(/\n/g, '<br>'))}</blockquote>`;
        draft.attachments = (message.attachments || []).map(file => ({ name: file.name, source: { accountId, messageId: message.id, attachmentId: file.id, folder: detail.folder } }));
      } else {
        const own = new Set(M.accounts.map(a => String(a.email || a.username || '').toLowerCase()).filter(Boolean));
        draft.to = message.replyTo || message.from;
        if (mode === 'reply-all') {
          const seen = new Set([email(draft.to).toLowerCase(), ...own]);
          const addresses = `${message.to || ''},${message.cc || ''}`.match(/(?:"[^"]*"|[^,])+/g) || [];
          draft.cc = addresses.map(a => a.trim()).filter(a => { const address = email(a).toLowerCase(); if (!address || seen.has(address)) return false; seen.add(address); return true; }).join(', ');
        }
        draft.subject = /^Re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`;
        draft.inReplyTo = message.messageId; draft.references = [message.references, message.messageId].filter(Boolean).join(' '); draft.replyMessageId = message.id;
        draft.threadId = account(accountId)?.provider === 'gmail' ? message.threadId || '' : '';
      }
    }
    M.draft = draft; M.dirty = true; M.conflict = false; renderComposer(); await saveDraft();
    (mode === 'new' || mode === 'forward' ? $('mailDraft_to') : $('mailEditor'))?.focus();
  }
  function renderComposer() {
    M.readerResize?.disconnect();
    const d = M.draft; if (!d) return;
    const locked = M.sending || (d.status && d.status !== 'draft');
    $('mailWorkspace').classList.add('mail-reading-open');
    $('mailReading').innerHTML = `<div id="mailComposer" class="mail-composer"><div class="mail-compose-heading"><div><span class="mail-eyebrow">${locked ? 'DELIVERY UNCONFIRMED' : 'YOUR DRAFT'}</span><h2>${d.inReplyTo ? 'Reply' : 'New message'}</h2></div><span id="mailSaveStatus">${d.id ? 'Saved in OE' : 'Saving…'}</span>${command('save-close', 'Save & close', 'x', '', 'mail-icon-btn')}</div><div class="mail-compose-fields"><label><span>From</span><select id="mailDraftAccount" ${d.inReplyTo || d.attachments.some(a => a.source) || locked ? 'disabled' : ''}>${M.accounts.map(a => `<option value="${e(a.id)}" ${a.id === d.accountId ? 'selected' : ''}>${e(a.label)}${a.email || a.username ? ` · ${e(a.email || a.username)}` : ''}</option>`).join('')}</select></label>${['to', 'cc', 'bcc', 'subject'].map(field => `<label><span>${({ to: 'To', cc: 'Cc', bcc: 'Bcc', subject: 'Subject' })[field]}</span><input id="mailDraft_${field}" value="${e(d[field] || '')}" placeholder="${field === 'subject' ? 'Add a subject' : field === 'to' ? 'Recipients' : 'Optional'}" ${locked ? 'disabled' : ''} aria-label="${field}"></label>`).join('')}</div><div class="mail-formatting" role="toolbar" aria-label="Text formatting">${command('format', 'Bold', 'bold', 'bold', 'mail-icon-btn')}${command('format', 'Italic', 'italic', 'italic', 'mail-icon-btn')}${command('format', 'Bulleted list', 'list', 'insertUnorderedList', 'mail-icon-btn')}<span class="mail-format-divider"></span>${command('attach', 'Attach file', 'paperclip')}${command('assist-draft', 'Ask assistant', 'sparkles')}</div><div id="mailEditor" class="mail-editor" contenteditable="${!locked}" role="textbox" aria-multiline="true" aria-label="Message body" data-placeholder="Write something…"></div><div id="mailDraftAttachments" class="mail-draft-attachments"></div><input type="file" id="mailFiles" multiple hidden><div class="mail-compose-footer">${locked ? '<p>Check your provider’s Sent folder before composing another message.</p>' : `${command('send', 'Send message', 'send', '', 'mail-primary')}<span>Draft saved to your OE profile</span>${command('discard', 'Discard draft', 'trash-2', '', 'mail-icon-btn')}`}</div></div>`;
    $('mailEditor').innerHTML = editorHtml(d.html || e(d.body || '').replace(/\n/g, '<br>'));
    renderDraftAttachments();
    if (locked) $('mailComposer').querySelectorAll('.mail-formatting button,.mail-draft-file button').forEach(button => { button.disabled = true; });
    if (M.sending) { $('mailComposer').querySelector('.mail-eyebrow').textContent = 'SENDING MESSAGE'; $('mailComposer').querySelector('.mail-compose-footer').textContent = 'Waiting for your mail provider…'; }
  }
  function renderDraftAttachments() {
    if (!$('mailDraftAttachments')) return;
    $('mailDraftAttachments').innerHTML = (M.draft?.attachments || []).map((file, index) => `<span class="mail-draft-file">${icon('paperclip', 14)}${e(file.name || file.fileId)}<button data-mail="remove-attachment" data-value="${index}" aria-label="Remove ${e(file.name)}">${icon('x', 13)}</button></span>`).join('');
  }
  async function uploadFiles(files) {
    if (!M.draft || M.upload || M.sending || M.draft.status !== 'draft') return;
    const session = M.session;
    const list = [...files];
    if (M.draft.attachments.length + list.length > 15) throw new Error('Attach up to 15 files.');
    if (list.some(file => file.size > 20 * 1024 * 1024)) throw new Error('Choose files smaller than 20 MB.');
    M.upload = true; notice('Uploading attachments…');
    try {
      for (const file of list) {
        const data = new FormData(); data.append('file', file);
        const response = await fetch('/api/chat-upload', { method: 'POST', body: data });
        const result = await response.json();
        if (session !== M.session) return;
        if (!response.ok || !result.file_id) throw new Error(result.error || 'Attachment upload failed.');
        M.draft.attachments.push({ fileId: result.file_id, name: result.name || file.name });
        changed(); renderDraftAttachments();
      }
      changed(); renderDraftAttachments(); await saveDraft(); notice('Attachments added.');
    } finally { if (session === M.session) { M.upload = false; if ($('mailFiles')) $('mailFiles').value = ''; } }
  }
  async function deleteDraft(id) {
    if (!id || M.deletingDraft) return;
    const session = M.session, open = M.draft?.id === id;
    M.deletingDraft = true;
    if (open) {
      captureDraft(); clearTimeout(M.timer);
      $('mailComposer')?.querySelectorAll('input,select,button').forEach(el => { el.disabled = true; });
      $('mailEditor')?.setAttribute('contenteditable', 'false');
    }
    try {
      if (open && M.saving) await M.saving;
      if (session !== M.session) return;
      const draft = open ? M.draft : M.drafts.find(d => d.id === id);
      if (!draft || draft.status !== 'draft') throw new Error('Reopen this draft to check its current status before deleting it.');
      const result = await api('delete_draft', { draftId: id, version: draft.version }, true);
      if (session !== M.session) return;
      if (!result.deleted) throw new Error('OE did not confirm the draft deletion.');
      if (open) { M.draft = null; M.dirty = false; M.conflict = false; M.detailGeneration++; M.detail ? renderReader() : renderEmpty(); }
      M.drafts = M.drafts.filter(d => d.id !== id);
      if (M.folder === 'drafts') renderList();
      renderNavigation(); notice('Draft deleted.');
    } catch (error) {
      if (session === M.session) {
        await refreshDrafts().catch(() => {});
        notice(error.message, true);
      }
    } finally {
      if (session === M.session) { M.deletingDraft = false; if (open && M.draft) renderComposer(); }
    }
  }
  function setMailAssistantOpen(open) {
    document.querySelector('.desk')?.classList.toggle('mail-chat', open);
    const toggle = document.querySelector('#mailWorkspace [data-mail="assistant"]');
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-controls', 'workspace');
      toggle.title = open ? 'Close AI panel' : 'Open AI panel'; toggle.setAttribute('aria-label', toggle.title);
    }
  }
  function closeMailAssistant() {
    setMailAssistantOpen(false);
    document.querySelector('#mailWorkspace [data-mail="assistant"]')?.focus();
  }
  function mailWorkspaceChatContext() {
    if (!active() || !document.querySelector('.desk')?.classList.contains('mail-chat')) return null;
    const detail = M.detail?.messages?.length ? M.detail : null;
    if (M.draft) {
      if (!M.draft.id) return null;
      const context = { accountId: M.draft.accountId, draftId: M.draft.id };
      if (detail && detail.accountId === M.draft.accountId && M.draft.replyMessageId === detail.id) {
        Object.assign(context, { messageId: detail.id, folder: detail.folder });
      }
      return context;
    }
    return detail ? { accountId: detail.accountId, messageId: detail.id, folder: detail.folder } : null;
  }
  async function assistant(task) {
    if (!task && document.querySelector('.desk').classList.contains('mail-chat')) { closeMailAssistant(); return; }
    if (task === 'draft-ai') { await compose('reply'); task = 'assist-draft'; }
    if (M.draft) await saveDraft();
    if (typeof switchView === 'function') switchView('chat', true);
    setMailAssistantOpen(true);
    if (!task) { $('input')?.focus(); return; }
    if (streaming && !awaitingPermission) { notice('Your assistant is working. You can ask about this message when it finishes.'); return; }
    const emailAgent = agents.find(a => a.skillCategory === 'email');
    if (emailAgent && activeAgent !== emailAgent.id) switchAgent(emailAgent.id);
    $('sbtnInbox').classList.add('active');
    if ($('input').value.trim()) { notice('Send or clear your current chat draft before using this shortcut.'); return; }
    const detail = M.detail;
    const context = detail ? `Account ID: ${detail.accountId}; folder ID: ${detail.folder}; message ID: ${detail.id}. Use email_workspace read to get the conversation.` : '';
    const prompt = task === 'summarize' ? `Summarize this email conversation and identify anything I need to do. ${context}` : `Help me write this email. ${context} Use email_workspace list_drafts to read draft ${M.draft?.id}, then save_draft with the latest version to write your proposed reply into that draft in the Mail workspace. Preserve its recipients, attachments and thread headers. Save the draft for me to review; do not send it.`;
    $('input').value = prompt; resizeTextarea(); await send();
  }
  async function handle(cmd, value, event) {
    if (cmd === 'assistant' && document.querySelector('.desk').classList.contains('mail-chat')) { closeMailAssistant(); return; }
    if (M.sending) throw new Error('Wait for this message to finish sending.');
    if (M.deletingDraft) throw new Error('Wait for the draft deletion to finish.');
    if (cmd === 'folder-new' || cmd === 'label-new') return showFolderDialog(false, value);
    if (cmd === 'folder-rename' || cmd === 'label-edit') return showFolderDialog(true, value);
    if (cmd === 'label-delete') return showLabelDelete(value);
    if (cmd === 'folder-cancel') { if (!M.folderMutation) $('mailFolderDialog')?.close(); return; }
    if (cmd === 'folder-toggle') {
      const id = `${M.account}\n${value}`;
      M.collapsedFolders.has(id) ? M.collapsedFolders.delete(id) : M.collapsedFolders.add(id);
      renderNavigation(); return;
    }
    if (cmd === 'draft-copy') {
      captureDraft(); delete M.draft.id; delete M.draft.version; M.conflict = false; M.dirty = true;
      $('mailDraftConflict')?.remove(); await saveDraft(); notice('Your version was saved as a separate draft.'); return;
    }
    if (cmd === 'draft-latest') {
      const result = await api('list_drafts');
      const fresh = result.drafts.find(d => d.id === M.draft?.id);
      if (!fresh) throw new Error('The original draft is no longer available. Keep your version as a new draft.');
      M.draft = fresh; M.drafts = result.drafts; M.dirty = false; M.conflict = false; renderComposer(); notice('Loaded the latest saved version.'); return;
    }
    if (['send', 'discard', 'delete-draft', 'save-close', 'edit-draft', 'compose', 'read', 'close', 'account', 'folder', 'settings'].includes(cmd) && M.upload) throw new Error('Wait for attachments to finish uploading.');
    if (cmd === 'close') return closeMailWorkspace();
    if (cmd === 'navigation') return $('mailWorkspace').classList.toggle('mail-navigation-open');
    if (cmd === 'settings') { await closeMailWorkspace(); _openSettingsTab('profile'); return; }
    if (cmd === 'refresh') { const errors = await refreshFolders(); await load(); if (errors.length) notice(errors.join(' · '), true); return; }
    if (cmd === 'more') return load(true);
    if (cmd === 'account' || cmd === 'folder') {
      if (M.draft) { await saveDraft(); M.draft = null; }
      if (cmd === 'account') { M.account = value; M.folder = 'inbox'; }
      else M.folder = value;
      M.detailGeneration++; M.detail = null; M.query = ''; $('mailSearch').value = ''; M.filter = 'all';
      $('mailWorkspace').classList.remove('mail-reading-open', 'mail-navigation-open');
      renderNavigation(); renderEmpty(); return load();
    }
    if (cmd === 'filter') { M.filter = value; M.selected.clear(); renderList(); return; }
    if (cmd === 'select') { M.selected.has(value) ? M.selected.delete(value) : M.selected.add(value); renderList(); return; }
    if (cmd === 'clear-selection') { M.selected.clear(); renderList(); return; }
    if (cmd === 'read') return read(value);
    if (cmd === 'back') { M.detailGeneration++; M.detail = null; $('mailWorkspace').classList.remove('mail-reading-open'); renderEmpty(); renderList(); return; }
    if (cmd === 'star') { const mail = M.emails.find(m => key(m) === value); return mail && update(mail.starred ? 'unstar' : 'star', null, mail); }
    if (['archive', 'trash', 'unread', 'restore', 'read-state'].includes(cmd)) {
      const readerAction = !!event?.target?.closest('.mail-reader-toolbar');
      if (readerAction && !M.detail) return;
      return update(cmd === 'read-state' ? 'read' : cmd, null, readerAction ? M.detail : null);
    }
    if (cmd === 'images') { M.images = true; renderReader(); return; }
    if (cmd === 'compose') return compose();
    if (['reply', 'reply-all', 'forward'].includes(cmd)) return compose(cmd);
    if (['assistant', 'summarize', 'draft-ai', 'assist-draft'].includes(cmd)) return assistant(cmd === 'assistant' ? '' : cmd);
    if (cmd === 'format') { $('mailEditor')?.focus(); document.execCommand(value); changed(); return; }
    if (cmd === 'attach') { $('mailFiles').click(); return; }
    if (cmd === 'remove-attachment') { M.draft.attachments.splice(Number(value), 1); changed(); renderDraftAttachments(); return; }
    if (cmd === 'edit-draft') {
      if (M.draft) await saveDraft();
      const draft = M.drafts.find(d => d.id === value); if (!draft) return;
      M.detailGeneration++; M.draft = structuredClone(draft); M.dirty = false; renderComposer(); renderList(); return;
    }
    if (cmd === 'save-close') { await saveDraft(); M.draft = null; M.detailGeneration++; M.detail ? renderReader() : renderEmpty(); $('mailWorkspace').classList.toggle('mail-reading-open', !!M.detail); return; }
    if (cmd === 'delete-draft' || cmd === 'discard') return deleteDraft(cmd === 'discard' ? M.draft?.id : value);
    if (cmd === 'send' && M.draft && !M.busy) {
      const session = M.session;
      M.busy = true; M.sending = true; event?.target.closest('button')?.setAttribute('disabled', '');
      try {
        await saveDraft();
        if (session !== M.session) return;
        renderComposer();
        const result = await api('send_draft', { draftId: M.draft.id, version: M.draft.version }, true);
        if (session !== M.session) return;
        if (!result.sent) throw new Error('The provider did not confirm sending.');
        M.draft = null; M.dirty = false; M.detailGeneration++; M.detail = null;
        renderEmpty(result.partial ? 'Message partially submitted' : 'Message submitted', result.result);
        await load(); notice(result.result, false, result.partial === true);
      } catch (error) { if (session === M.session) notice(error.message, true); }
      finally {
        if (session === M.session) {
          M.busy = false; M.sending = false;
          if (M.draft) { renderComposer(); if (M.conflict) draftConflict(); }
          await refreshDrafts().catch(() => {});
        }
      }
    }
  }
  let changeTimer, folderChangeTimer;
  const pendingFolderAccounts = new Set();
  function refreshChangedFolders() {
    if (!active()) { pendingFolderAccounts.clear(); return; }
    if (M.folderMutation) { folderChangeTimer = setTimeout(refreshChangedFolders, 500); return; }
    const accounts = [...pendingFolderAccounts]; pendingFolderAccounts.clear();
    Promise.all(accounts.map(id => refreshFolders(id))).then(results => {
      const errors = results.flat(); if (errors.length) notice(errors.join(' · '), true);
    }).catch(error => notice(error.message, true));
  }
  function mailWorkspaceChanged(message) {
    if (!active()) return;
    if (message.operation === 'update' && ['read', 'unread', 'star', 'unstar'].includes(message.action) && Array.isArray(message.messageIds)) {
      applyMessageFlags(message); return;
    }
    if (message.operation === 'update' && ['trash', 'archive', 'move'].includes(message.action)
      && M.detail?.accountId === message.account && message.messageIds?.includes(M.detail.id)
      && (account(message.account)?.provider !== 'imap' || M.detail.folder === message.messageFolder)) {
      M.detail = null; M.detailGeneration++;
      if (!M.draft) { renderEmpty(); $('mailWorkspace').classList.remove('mail-reading-open'); }
    }
    if (['create_folder', 'rename_folder', 'create_label', 'update_label', 'delete_label'].includes(message.operation)) {
      const accountId = M.accounts.find(a => a.id === message.account || a.label === message.account)?.id;
      if (accountId && (message.folder || message.deletedFolderIds)) {
        const reload = applyFolderChange(accountId, message); renderNavigation();
        if (reload) load().catch(error => notice(error.message, true));
        else if (M.detail && !M.draft) renderReader();
        refreshDrafts().catch(error => notice(error.message, true));
      }
      pendingFolderAccounts.add(message.account || null); clearTimeout(folderChangeTimer);
      folderChangeTimer = setTimeout(refreshChangedFolders, 400); return;
    }
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (!active() || M.busy || M.saving) return;
      (message.operation === 'update' || message.operation === 'send_draft' ? load() : refreshDrafts()).catch(error => notice(error.message, true));
    }, 400);
  }
  Object.assign(window, { openMailWorkspace: () => openMailWorkspace().catch(error => notice(error.message, true)), closeMailWorkspace, resetMailWorkspace, mailWorkspaceChanged, mailWorkspaceIsOpen: active, mailWorkspaceChatContext });
})();
