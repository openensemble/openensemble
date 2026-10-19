// A single account-scoped queue, including pending proposal decisions.
// Loading or refreshing this view never retries an action.
let _attentionData = null;
let _attentionRequest = null;
let _attentionTimer = null;
let _attentionRefreshTimer = null;
let _attentionGeneration = 0;
let _attentionProposals = new Map();
let _attentionProposalError = '';
let _attentionActionRequest = null;
const _attentionBusy = new Set();
const _attentionLabels = { all: 'All', approval: 'Approvals', failure: 'Failures', connection: 'Connections', uncertain: 'Uncertain actions', paused: 'Paused work' };

function resetNeedsAttention() {
  ++_attentionGeneration;
  _attentionRequest?.abort(); _attentionRequest = null;
  _attentionActionRequest?.abort(); _attentionActionRequest = null;
  _attentionProposals.clear(); _attentionBusy.clear(); _attentionProposalError = '';
  clearTimeout(_attentionTimer); clearTimeout(_attentionRefreshTimer);
  _attentionData = null;
  $('attentionList')?.replaceChildren();
  if ($('attentionBadge')) $('attentionBadge').style.display = 'none';
}

async function openNeedsAttention({ proposalId } = {}) {
  const generation = _attentionGeneration;
  if (activeDrawerId !== 'drawerAttention') toggleDrawer('drawerAttention', 'sbtnAttention');
  if (proposalId) $('attentionFilter').value = 'approval';
  await refreshNeedsAttention({ force: true });
  if (generation !== _attentionGeneration || !_currentUser || _authSuspended) return;
  if (proposalId) {
    const card = document.querySelector(`[data-attention-id="${CSS.escape('approvals:' + proposalId)}"]`);
    if (card) { card.scrollIntoView({ block: 'center' }); card.querySelector('button')?.focus({ preventScroll: true }); return; }
    if (_currentUser && !_authSuspended) showToast('This suggestion is no longer pending or is outside the current page of the queue.');
  }
  $('attentionFilter')?.focus({ preventScroll: true });
}

async function readAttentionResponse(response) {
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || 'Could not update your work. Try again.');
  return data;
}

async function refreshNeedsAttention({ force = false } = {}) {
  if (!_currentUser || _authSuspended || document.visibilityState === 'hidden' || _attentionBusy.size || (_attentionRequest && !force)) return;
  _attentionRequest?.abort();
  const generation = _attentionGeneration;
  const request = new AbortController(); _attentionRequest = request;
  const status = $('attentionStatus');
  if (status) status.textContent = 'Checking your work…';
  try {
    const options = { cache: 'no-store', signal: request.signal };
    const [queue, proposals] = await Promise.allSettled([
      fetch('/api/needs-attention', options).then(readAttentionResponse),
      activeDrawerId === 'drawerAttention' ? fetch('/api/proposals', options).then(readAttentionResponse) : Promise.resolve(null),
    ]);
    if (request.signal.aborted || generation !== _attentionGeneration || !_currentUser || _authSuspended) return;
    if (queue.status === 'rejected') throw queue.reason;
    _attentionData = queue.value;
    _attentionProposals.clear(); _attentionProposalError = '';
    if (proposals.status === 'rejected' || proposals.value && !Array.isArray(proposals.value.pending)) {
      _attentionProposalError = 'Could not load suggestion details. Refresh to retry.';
    } else if (proposals.value) {
      _attentionProposals = new Map(proposals.value.pending.filter(p => p && typeof p.id === 'string').map(p => [p.id, p]));
    }
    renderNeedsAttention();
    return true;
  } catch (error) {
    if (request.signal.aborted || generation !== _attentionGeneration || error.name === 'AbortError') return;
    if (status) status.textContent = _attentionData ? 'Could not refresh. The items below may be out of date.' : error.message;
    const badge = $('attentionBadge');
    if (badge) { badge.textContent = '!'; badge.style.display = ''; }
    return false;
  } finally {
    if (_attentionRequest === request) {
      _attentionRequest = null;
      clearTimeout(_attentionTimer);
      if (generation === _attentionGeneration && activeDrawerId === 'drawerAttention' && document.visibilityState !== 'hidden') {
        _attentionTimer = setTimeout(refreshNeedsAttention, 30000);
      }
    }
  }
}

function renderNeedsAttention() {
  const body = $('attentionList'), data = _attentionData;
  if (!body || !data) return;
  body.replaceChildren();
  const filter = $('attentionFilter')?.value || 'all';
  const displayed = data.items.filter(item => filter === 'all' || item.category === filter);
  const unavailable = data.unavailable || [];
  $('attentionStatus').textContent = `${data.total} item${data.total === 1 ? '' : 's'} need attention.`
    + (unavailable.length ? ` Could not check: ${unavailable.join(', ')}. Refresh to retry.` : '')
    + (_attentionProposalError ? ` ${_attentionProposalError}` : '')
    + (data.truncated ? ' Showing the first 200 items; resolve these to see more.' : '');
  const badge = $('attentionBadge');
  if (badge) {
    badge.textContent = data.total ? `${Math.min(data.total, 99)}${data.total > 99 || data.truncated ? '+' : ''}` : unavailable.length ? '!' : '';
    badge.style.display = data.total || unavailable.length ? '' : 'none';
  }
  for (const option of $('attentionFilter')?.options || []) {
    const count = option.value === 'all' ? data.total : data.counts[option.value] || 0;
    option.textContent = `${_attentionLabels[option.value]} (${count})`;
  }
  if (!displayed.length) {
    const empty = document.createElement('p'); empty.className = 'attention-empty';
    empty.textContent = unavailable.length ? 'No items found in the sources that were checked.' : filter === 'all' ? 'Nothing needs your attention right now.' : 'No items in this category.';
    body.appendChild(empty);
  }
  const proposalIds = displayed.filter(item => item.action.type === 'proposal' && _attentionProposals.has(item.sourceId)).map(item => item.sourceId);
  if (proposalIds.length >= 2) {
    const actions = document.createElement('div'); actions.className = 'attention-proposal-actions';
    for (const action of ['accept', 'dismiss']) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'cdraw-btn';
      button.textContent = `${action === 'accept' ? 'Accept' : 'Dismiss'} shown suggestions (${proposalIds.length})`;
      button.disabled = _attentionBusy.size > 0;
      button.addEventListener('click', () => {
        if (confirm(`${action === 'accept' ? 'Accept' : 'Dismiss'} these ${proposalIds.length} suggestions?`)) attentionProposalAction(proposalIds, action, true);
      });
      actions.append(button);
    }
    body.append(actions);
  }
  for (const item of displayed) {
    const card = document.createElement('article'); card.className = 'attention-card';
    card.dataset.attentionId = item.id;
    const category = document.createElement('span'); category.className = 'attention-category'; category.textContent = _attentionLabels[item.category] || 'Review';
    const title = document.createElement('h3'); title.textContent = item.title;
    const owner = document.createElement('p'); owner.className = 'attention-owner';
    owner.textContent = `${item.owner}${item.project ? ` · ${item.project}` : ''}`;
    const detail = document.createElement('p'); detail.textContent = item.detail;
    card.append(category, title, owner, detail);
    if (item.action.type === 'proposal') {
      renderAttentionProposal(card, item, title, detail); body.append(card); continue;
    }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'cdraw-btn';
    button.textContent = item.action.label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await openAttentionItem(item); }
      catch (error) { showToast(error.message || 'Could not open this item. Refresh and try again.'); }
      finally { button.disabled = false; }
    });
    card.append(button); body.appendChild(card);
  }
}

function attentionProposalPreview(preview) {
  if (!preview || typeof preview !== 'object') return '';
  if (preview.effect === 'fills_missing_tool_arg') {
    return `Dry run: when ${preview.tool || 'this tool'} omits ${preview.arg || 'the arg'}, OE fills the proposed value; explicit user args still win.`;
  }
  if (preview.effect === 'force_route_on_contains_match') {
    return `Dry run: messages containing "${preview.pattern || ''}" route directly to ${preview.forcedAgent || 'the selected agent'}.`;
  }
  if (preview.effect === 'add_local_utterance_match') {
    return `Dry run: these phrases match ${preview.skillId || 'the skill'}/${preview.intentId || 'intent'} locally${preview.confirm ? ' with confirmation' : ''}.`;
  }
  if (preview.effect === 'bind_phrase_to_action') {
    return `Dry run: "${preview.trigger || ''}" runs ${preview.service || 'the action'} on ${preview.entityId || 'the target'}.`;
  }
  if (preview.effect === 'bind_phrase_to_entity') {
    return `Dry run: "${preview.phrase || ''}" resolves to ${preview.entityId || 'the target entity'}.`;
  }
  return `Dry run: ${preview.effect || 'review effect before accepting'}.`;
}

function renderAttentionProposal(card, item, title, detail) {
  const proposal = _attentionProposals.get(item.sourceId);
  if (!proposal) {
    detail.textContent = _attentionProposalError || 'This suggestion may have changed. Refresh to review its current details.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'cdraw-btn'; retry.textContent = 'Refresh suggestions';
    retry.addEventListener('click', () => refreshNeedsAttention({ force: true })); card.append(retry); return;
  }
  const policy = proposal.policy || {}, risk = policy.risk || proposal.risk;
  const score = policy.utilityScore ?? policy.confidence ?? proposal.utilityScore ?? proposal.confidence;
  title.textContent = proposal.title || 'Suggested ' + String(proposal.kind || 'change').replace(/[_-]+/g, ' ');
  detail.textContent = proposal.message || item.detail;
  detail.classList.add('attention-proposal-message');
  const note = text => {
    if (!text) return;
    const p = document.createElement('p'); p.className = 'attention-proposal-note'; p.textContent = text; card.append(p);
  };
  note([risk, Number.isFinite(score) ? `${Math.round(score * 100)}%` : '', proposal.createdAt ? new Date(proposal.createdAt).toLocaleString() : ''].filter(Boolean).join(' · '));
  note(proposal.personalizationWhy);
  note(attentionProposalPreview(policy.preview || proposal.preview));
  const actions = document.createElement('div'); actions.className = 'attention-proposal-actions';
  for (const [action, label] of [['accept', proposal.accept_label || 'Accept'], ['snooze', 'Snooze 7d'], ['dismiss', proposal.dismiss_label || 'Dismiss'], ['never', "Don't propose again"]]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'cdraw-btn';
    button.textContent = label; button.dataset.proposalAction = action;
    button.disabled = _attentionBusy.size > 0;
    if (action === 'never') button.title = 'Never suggest this again. A normal dismiss hides it for 24 hours.';
    button.addEventListener('click', () => attentionProposalAction([proposal.id], action)); actions.append(button);
  }
  if (proposal.editPreferenceId) {
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'cdraw-btn'; edit.textContent = 'Edit preference';
    edit.disabled = _attentionBusy.size > 0;
    edit.addEventListener('click', () => openLearnFactEditor(proposal.editPreferenceId)); actions.append(edit);
  }
  card.append(actions);
}

async function attentionProposalAction(ids, action, bulk = false) {
  if (!_currentUser || _authSuspended || _attentionBusy.size || !ids.length
    || !ids.every(id => _attentionProposals.has(id)) || !['accept', 'dismiss', 'snooze', 'never'].includes(action)
    || bulk && !['accept', 'dismiss'].includes(action)) return;
  const generation = _attentionGeneration;
  const request = new AbortController(); _attentionActionRequest = request;
  _attentionRequest?.abort(); _attentionRequest = null;
  for (const id of ids) _attentionBusy.add(id);
  renderNeedsAttention();
  try {
    const url = bulk ? `/api/proposals/bulk/${action}` : `/api/proposals/${encodeURIComponent(ids[0])}/${action}`;
    const result = await fetch(url, { method: 'POST', signal: request.signal,
      ...(bulk ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) } : {}),
    }).then(readAttentionResponse);
    if (generation !== _attentionGeneration || request.signal.aborted) return;
    const results = bulk ? result.results : [{ id: ids[0], ok: true }];
    if (!Array.isArray(results)) throw new Error('Could not confirm the result. Refresh before trying again.');
    const failures = results.filter(row => !row.ok);
    if (failures.length) showToast(`${failures.length} suggestion(s) could not be updated: ${[...new Set(failures.map(row => row.error || 'Unknown error'))].join('; ')}`);
    else showToast(action === 'snooze' ? 'Suggestion snoozed for 7 days.' : action === 'accept' ? 'Suggestion accepted. Progress and results appear in its conversation.' : action === 'never' ? 'This suggestion will not be proposed again.' : 'Suggestion dismissed.');
  } catch (error) {
    if (generation === _attentionGeneration && !request.signal.aborted) showToast(`Suggestion update failed: ${error.message}`);
  } finally {
    if (_attentionActionRequest === request) _attentionActionRequest = null;
    if (generation === _attentionGeneration) {
      _attentionBusy.clear();
      const refreshed = await refreshNeedsAttention({ force: true });
      if (generation === _attentionGeneration && refreshed !== true) {
        const status = $('attentionStatus')?.textContent;
        renderNeedsAttention();
        if (status && $('attentionStatus')) $('attentionStatus').textContent = status;
      }
    }
  }
}

async function openAttentionItem(item) {
  if (!_currentUser || _authSuspended) return;
  switch (item.action.type) {
    case 'conversation': {
      const query = new URLSearchParams();
      if (item.context.agentId) query.set('agent', item.context.agentId);
      if (item.context.projectId) query.set('project', item.context.projectId);
      if (item.context.chatId) query.set('chat', item.context.chatId);
      location.assign('/?' + query); break;
    }
    case 'proposal': {
      await openNeedsAttention({ proposalId: item.sourceId }); break;
    }
    case 'schedule':
    case 'watcher': {
      toggleDrawer('drawerTasks', 'sbtnTasks');
      if (item.action.type === 'schedule') { expandedTaskId = item.sourceId; taskViews.taskList = 'schedules'; }
      else { expandedWatcherId = item.sourceId; taskViews.taskList = 'monitors'; }
      await loadTaskList();
      if (item.action.type === 'watcher') await loadWatcherDetail(item.sourceId);
      renderTasks();
      const target = item.action.type === 'schedule' ? document.querySelector(`[data-task-editor="${CSS.escape(item.sourceId)}"]`) : document.getElementById('taskList');
      target?.scrollIntoView({ block: 'center' }); break;
    }
    case 'job': await reviewJobRecovery(item.sourceId); break;
    case 'mail': await openMailWorkspace({ draftId: item.sourceId }); break;
    case 'budget': await openRunBudgets({ runId: item.sourceId }); break;
    case 'node':
      toggleDrawer('drawerNodes', 'sbtnNodes'); await loadNodes();
      document.getElementById(`nodeCard_${item.sourceId}`)?.scrollIntoView({ block: 'center' }); break;
    case 'share':
    case 'backup':
      toggleDrawer('drawerSettings', 'sbtnSettings'); switchSettingsTab(item.action.type === 'share' ? 'shares' : 'backup'); break;
  }
}

function notifyNeedsAttention(type) {
  if (!['auth_ok', 'connected', 'active_streams', 'permission_request', 'credential_prompt', 'credential_resolved', 'proposal', 'proposal_outcome', 'task_complete', 'task_created', 'task_ledger_updated', 'task_status', 'node_health', 'nodes_updated', 'done', 'error', 'mail_changed', 'run_budget_updated', 'budget_paused'].includes(type)) return;
  if (!_currentUser || _authSuspended || document.visibilityState === 'hidden') return;
  clearTimeout(_attentionRefreshTimer);
  _attentionRefreshTimer = setTimeout(refreshNeedsAttention, 800);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { clearTimeout(_attentionTimer); clearTimeout(_attentionRefreshTimer); }
  else if (_currentUser && !_authSuspended) refreshNeedsAttention();
});
