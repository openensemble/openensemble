let _runInspectorTraces = [];
let _runInspectorSelected = null;
let _runInspectorTarget = 'runInspectorBody';

function fmtRunTime(ts) {
  if (!ts) return 'unknown';
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

async function loadRunInspector(selectId = null, targetId = 'runInspectorBody') {
  _runInspectorTarget = targetId;
  const body = $(_runInspectorTarget);
  if (!body) return;
  body.innerHTML = '<div class="cdraw-empty">Loading runs…</div>';
  try {
    const data = await fetch('/api/run-inspector?limit=80').then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    _runInspectorTraces = data.traces || [];
    _runInspectorSelected = selectId || _runInspectorSelected || _runInspectorTraces[0]?.id || null;
    renderRunInspector();
  } catch (e) {
    body.innerHTML = `<div class="cdraw-empty" style="color:var(--red)">Failed to load runs: ${escHtml(e.message)}</div>`;
  }
}

function renderRunInspector() {
  const body = $(_runInspectorTarget);
  if (!body) return;
  if (!_runInspectorTraces.length) {
    body.innerHTML = '<div class="cdraw-empty">No runs recorded yet.</div>';
    return;
  }
  const selected = _runInspectorTraces.find(t => t.id === _runInspectorSelected) || _runInspectorTraces[0];
  _runInspectorSelected = selected.id;
  body.innerHTML = `
    <div class="run-inspector-list">
      ${_runInspectorTraces.map(t => renderRunInspectorRow(t, t.id === selected.id)).join('')}
    </div>
    <div class="run-inspector-detail" id="${escHtml(_runInspectorTarget)}Detail">
      <div class="cdraw-empty">Loading run…</div>
    </div>
  `;
  loadRunInspectorDetail(selected.id);
  if (window.lucide) lucide.createIcons();
}

function renderRunInspectorRow(t, active) {
  const statusClass = t.status === 'error' ? 'error' : 'ok';
  const tools = (t.toolsUsed || []).slice(0, 3).join(', ');
  return `
    <button class="run-row ${active ? 'active' : ''}" data-action="selectRunInspectorTrace" data-args='[${JSON.stringify(t.id)}]'>
      <div class="run-row-top">
        <span class="run-status ${statusClass}">${escHtml(t.status || 'complete')}</span>
        <span class="run-time">${escHtml(fmtRunTime(t.ts))}</span>
      </div>
      <div class="run-agent">${escHtml(t.agentName || t.agentId || 'Agent')}</div>
      <div class="run-model">${escHtml(t.provider || 'provider')} / ${escHtml(t.model || 'model')} · ${escHtml(fmtDuration(t.durationMs))}</div>
      <div class="run-preview">${escHtml(t.inputPreview || '')}</div>
      ${tools ? `<div class="run-tools">${escHtml(tools)}${(t.toolsUsed || []).length > 3 ? '…' : ''}</div>` : ''}
    </button>
  `;
}

async function selectRunInspectorTrace(id) {
  _runInspectorSelected = id;
  renderRunInspector();
}

async function loadRunInspectorDetail(id) {
  const detail = $(`${_runInspectorTarget}Detail`);
  if (!detail) return;
  try {
    const t = await fetch(`/api/run-inspector/${encodeURIComponent(id)}`).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    detail.innerHTML = renderRunInspectorDetail(t);
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    detail.innerHTML = `<div class="cdraw-empty" style="color:var(--red)">Failed to load run: ${escHtml(e.message)}</div>`;
  }
}

function metric(label, value) {
  return `<div class="run-metric"><span>${escHtml(label)}</span><b>${escHtml(value ?? '—')}</b></div>`;
}

function renderRunInspectorDetail(t) {
  const sizes = t.sizes || {};
  const routing = t.routing || {};
  const tools = t.tools || {};
  const meta = t.meta || {};
  return `
    <div class="run-detail-head">
      <div>
        <div class="run-detail-title">${escHtml(t.agentName || t.agentId || 'Agent run')}</div>
        <div class="run-detail-sub">${escHtml(fmtRunTime(t.ts))} · ${escHtml(t.source || 'web')}</div>
      </div>
      <span class="run-status ${t.status === 'error' ? 'error' : 'ok'}">${escHtml(t.status || 'complete')}</span>
    </div>

    <div class="run-metrics">
      ${metric('Provider', `${t.provider || '—'} / ${t.model || '—'}`)}
      ${metric('Duration', fmtDuration(t.durationMs))}
      ${metric('Tools Shipped', sizes.toolCount)}
      ${metric('Tools Used', (tools.usedNames || []).length)}
      ${metric('History', `${sizes.historyMessages ?? 0} msgs`)}
      ${metric('Prompt Chars', sizes.systemPromptChars)}
    </div>

    ${t.error ? `<div class="run-error">${escHtml(t.error)}</div>` : ''}

    <div class="run-section">
      <div class="run-section-title">User Input</div>
      <pre>${escHtml(t.inputPreview || '')}</pre>
    </div>
    <div class="run-section">
      <div class="run-section-title">Assistant Output</div>
      <pre>${escHtml(t.outputPreview || '')}</pre>
    </div>

    <div class="run-section-grid">
      <div class="run-section">
        <div class="run-section-title">Routing</div>
        <pre>${escHtml(JSON.stringify({
          initialSkills: routing.initialSkills || [],
          addedSkills: routing.addedSkills || [],
          recoveredMissingTools: Boolean(routing.recoveredMissingTools),
          fullToolCount: routing.fullToolCount ?? null,
        }, null, 2))}</pre>
      </div>
      <div class="run-section">
        <div class="run-section-title">Payload Sizes</div>
        <pre>${escHtml(JSON.stringify(sizes, null, 2))}</pre>
      </div>
    </div>

    <div class="run-section">
      <div class="run-section-title">Tools</div>
      ${(tools.used || []).length ? tools.used.map(tool => `
        <details class="run-tool" open>
          <summary>${escHtml(tool.name)}</summary>
          <div class="run-tool-label">Args</div>
          <pre>${escHtml(tool.argsPreview || '')}</pre>
          <div class="run-tool-label">Result</div>
          <pre>${escHtml(tool.resultPreview || '')}</pre>
        </details>
      `).join('') : '<div class="run-muted">No tools used.</div>'}
    </div>

    <div class="run-section">
      <div class="run-section-title">Injected Memory</div>
      ${(meta.memory?.injectedMemoryIds || []).length ? `
        <div class="run-memory-list">
          ${meta.memory.injectedMemoryIds.map(mem => `
            <div class="run-memory-hit">
              <code>${escHtml(mem.table || '')}/${escHtml(mem.id || '')}</code>
              <span>${escHtml(mem.text || '')}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="run-muted">No memories injected.</div>'}
    </div>

    <div class="run-section">
      <div class="run-section-title">Flags</div>
      <pre>${escHtml(JSON.stringify({
        attachment: t.attachment || null,
        silent: Boolean(meta.silent),
        ephemeral: Boolean(meta.ephemeral),
        hideTurn: Boolean(meta.hideTurn),
        skippedSignals: Boolean(meta.skippedSignals),
        skippedEpisodes: Boolean(meta.skippedEpisodes),
      }, null, 2))}</pre>
    </div>
  `;
}

async function clearRunInspector() {
  if (!confirm('Clear saved run inspector traces for this profile?')) return;
  await fetch('/api/run-inspector', { method: 'DELETE' });
  _runInspectorTraces = [];
  _runInspectorSelected = null;
  renderRunInspector();
}
