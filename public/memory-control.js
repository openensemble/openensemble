let _memoryItems = [];
let _memoryStats = 0;
let _memoryFilter = 'all';
let _memorySearch = '';
let _memoryControlTarget = 'memoryControlBody';
let _memorySelectedKey = '';

function memDate(ts) {
  if (!ts) return 'unknown';
  try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return ts; }
}

function memScore(v) {
  return Number.isFinite(v) ? Math.round(v * 100) + '%' : '—';
}

async function loadMemoryControl(targetId = _memoryControlTarget) {
  _memoryControlTarget = targetId;
  const body = $(_memoryControlTarget);
  if (!body) return;
  body.innerHTML = '<div class="cdraw-empty">Loading memories…</div>';
  try {
    const [items, stats] = await Promise.all([
      fetch('/api/memory/browse?limit=200', { cache: 'no-store' }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch('/api/memory/stats', { cache: 'no-store' }).then(r => r.ok ? r.json() : 0).catch(() => 0),
    ]);
    _memoryItems = items || [];
    _memoryStats = stats;
    renderMemoryControl();
  } catch (e) {
    body.innerHTML = `<div class="cdraw-empty" style="color:var(--red)">Failed to load memories: ${escHtml(e.message)}</div>`;
  }
}

function showMemoryActionError(e) {
  const msg = e?.message || 'Memory action failed';
  console.error('[memory-control]', e);
  alert(msg);
}

function setMemoryFilter(filter) {
  _memoryFilter = filter || 'all';
  renderMemoryControl();
}

function updateMemorySearch(value) {
  _memorySearch = value || '';
  renderMemoryControl();
}

function memoryMatches(m) {
  if (_memoryFilter === 'pinned' && !m.immortal) return false;
  if (_memoryFilter === 'shared' && m.table !== 'user_facts') return false;
  if (_memoryFilter === 'episodes' && m.type !== 'episodes') return false;
  if (_memoryFilter === 'params' && m.type !== 'params') return false;
  if (_memoryFilter === 'facts' && m.type !== 'user_facts') return false;
  const q = _memorySearch.trim().toLowerCase();
  if (q && !String(m.text || '').toLowerCase().includes(q)) return false;
  return true;
}

function renderMemoryControl() {
  const body = $(_memoryControlTarget);
  if (!body) return;
  const filtered = _memoryItems.filter(memoryMatches);
  const counts = {
    pinned: _memoryItems.filter(m => m.immortal).length,
    shared: _memoryItems.filter(m => m.table === 'user_facts').length,
    episodes: _memoryItems.filter(m => m.type === 'episodes').length,
    params: _memoryItems.filter(m => m.type === 'params').length,
  };
  const filters = [
    ['all', 'All'],
    ['pinned', `Pinned ${counts.pinned}`],
    ['shared', `Shared ${counts.shared}`],
    ['episodes', `Episodes ${counts.episodes}`],
    ['params', `Params ${counts.params}`],
  ];
  body.innerHTML = `
    <div class="mem-toolbar">
      <div class="mem-summary">
        <b>${escHtml(_memoryStats)}</b> active memories
        <span>${_memoryItems.length} loaded</span>
      </div>
      <input class="mem-search" value="${escHtml(_memorySearch)}" placeholder="Search loaded memories…" data-input-action="updateMemorySearch" data-input-args='["$value"]'>
      <div class="mem-filters">
        ${filters.map(([id, label]) => `<button class="mem-filter ${_memoryFilter === id ? 'active' : ''}" data-action="setMemoryFilter" data-args='[${JSON.stringify(id)}]'>${escHtml(label)}</button>`).join('')}
      </div>
    </div>
    <div class="mem-list">
      ${filtered.length ? filtered.map(renderMemoryCard).join('') : '<div class="cdraw-empty">No memories match this filter.</div>'}
    </div>
  `;
  bindMemoryCardSelection(body);
  if (window.lucide) lucide.createIcons();
}

function bindMemoryCardSelection(body) {
  body.querySelectorAll('.mem-card').forEach(card => {
    const key = card.dataset.memKey || '';
    card.open = !!key && key === _memorySelectedKey;
    card.addEventListener('toggle', () => {
      if (!card.open) {
        if (_memorySelectedKey === key) _memorySelectedKey = '';
        return;
      }
      _memorySelectedKey = key;
      body.querySelectorAll('.mem-card').forEach(other => {
        if (other !== card) other.open = false;
      });
    });
  });
}

function renderMemoryCard(m) {
  const args = JSON.stringify([m.id, m.table]).replace(/'/g, '&#39;');
  const key = `${m.table || ''}:${m.id || ''}`;
  const pinAction = m.immortal ? 'unpinMemoryItem' : 'pinMemoryItem';
  const pinLabel = m.immortal ? 'Unpin' : 'Pin';
  const scope = m.table === 'user_facts' ? 'shared' : (m.agent_id || m.table_agent_id || 'agent');
  return `
    <details class="mem-card" data-mem-key="${escHtml(key)}">
      <summary>
        <div class="mem-card-main">
          <div class="mem-card-top">
            <span class="mem-kind">${escHtml(m.type || 'memory')}</span>
            ${m.immortal ? '<span class="mem-pin">pinned</span>' : ''}
            <span class="mem-scope">${escHtml(scope)}</span>
            <span class="mem-date">${escHtml(memDate(m.created_at))}</span>
          </div>
          <div class="mem-text">${escHtml(m.text || '')}</div>
        </div>
      </summary>
      <div class="mem-detail">
        <div class="mem-metrics">
          <div><span>Confidence</span><b>${escHtml(memScore(m.confidence))}</b></div>
          <div><span>Salience</span><b>${escHtml(memScore(m.salience_composite))}</b></div>
          <div><span>Retention</span><b>${escHtml(memScore(m.retention_score))}</b></div>
          <div><span>Recalls</span><b>${escHtml(m.recall_count ?? 0)}</b></div>
          <div><span>Source</span><b>${escHtml(m.source || 'unknown')}</b></div>
          <div><span>Table</span><b>${escHtml(m.table || '')}</b></div>
        </div>
        <div class="mem-meta">
          <span>category: ${escHtml(m.category || '')}</span>
          <span>last recalled: ${escHtml(memDate(m.last_recalled_at))}</span>
          ${m.role_scope ? `<span>role: ${escHtml(m.role_scope)}</span>` : ''}
          ${m.host_scope ? `<span>host: ${escHtml(m.host_scope)}</span>` : ''}
          ${m.superseded_by ? `<span>superseded by: ${escHtml(m.superseded_by)}</span>` : ''}
        </div>
        <div class="mem-actions">
          <button data-action="editMemoryItem" data-args='${args}'>Edit</button>
          <button data-action="${pinAction}" data-args='${args}'>${pinLabel}</button>
          <button class="danger" data-action="forgetMemoryItem" data-args='${args}'>Forget</button>
        </div>
      </div>
    </details>
  `;
}

async function editMemoryItem(id, table) {
  try {
    const item = _memoryItems.find(m => m.id === id && m.table === table);
    if (!item) return;
    const next = prompt('Edit memory text', item.text || '');
    if (next == null) return;
    const text = next.trim();
    if (!text || text === item.text) return;
    await fetch(`/api/memory/${encodeURIComponent(id)}/table`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, text }),
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error || r.statusText); });
    loadMemoryControl();
  } catch (e) {
    showMemoryActionError(e);
  }
}

async function pinMemoryItem(id, table) {
  try {
    await fetch(`/api/memory/${encodeURIComponent(id)}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table }),
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error || r.statusText); });
    loadMemoryControl();
  } catch (e) {
    showMemoryActionError(e);
  }
}

async function unpinMemoryItem(id, table) {
  try {
    await fetch(`/api/memory/${encodeURIComponent(id)}/unpin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table }),
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error || r.statusText); });
    loadMemoryControl();
  } catch (e) {
    showMemoryActionError(e);
  }
}

async function forgetMemoryItem(id, table) {
  try {
    const item = _memoryItems.find(m => m.id === id && m.table === table);
    if (item?.immortal) {
      if (!confirm('This memory is pinned. Forget it anyway?')) return;
    } else {
      if (!confirm('Forget this memory?')) return;
    }
    const params = new URLSearchParams({ table });
    if (item?.immortal) params.set('force', '1');
    await fetch(`/api/memory/${encodeURIComponent(id)}/table?${params.toString()}`, {
      method: 'DELETE',
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error || r.statusText); });
    loadMemoryControl();
  } catch (e) {
    showMemoryActionError(e);
  }
}
