// ── Dashboard ─────────────────────────────────────────────────────────────────
function openDashboard() { toggleDrawer('drawerDashboard', 'sbtnDash'); }
function closeDashboard() { closeAllDrawers(); }

async function loadDashboard() {
  const body = $('dashBody');
  body.innerHTML = '<div style="color:var(--muted);padding:20px">Loading…</div>';
  let data;
  try { data = await fetch('/api/dashboard').then(r => r.json()); }
  catch { body.innerHTML = '<div style="color:var(--red);padding:20px">Failed to load dashboard.</div>'; return; }
  body.innerHTML = '';

  // System Health card (admin/owner only)
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  if (isPriv) {
    try {
      const health = await fetch('/api/admin/health').then(r => r.json());
      const hc = document.createElement('div');
      hc.className = 'dash-card';
      hc.style.borderColor = health.ok ? '#43b89c55' : '#e05c5c55';
      hc.style.gridColumn = '1 / -1';

      const dot = (ok) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ok ? 'var(--green,#43b89c)' : 'var(--red,#e05c5c)'};margin-right:4px"></span>`;
      const fmtUptime = (s) => {
        if (s < 60) return `${s}s`;
        if (s < 3600) return `${Math.floor(s/60)}m`;
        if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
        return `${Math.floor(s/86400)}d ${Math.floor((s%86400)/3600)}h`;
      };

      let gmailHtml = '';
      if (health.gmail) {
        const entries = Object.values(health.gmail);
        gmailHtml = entries.map(g =>
          `<div style="font-size:12px">${dot(g.tokenValid)}${escHtml(g.name)} — token ${g.tokenValid ? 'valid' : 'expired'}, autolabel ${g.autolabel ? 'running' : 'stopped'}</div>`
        ).join('');
      } else {
        gmailHtml = '<div style="font-size:12px;color:var(--muted)">No Gmail accounts configured</div>';
      }

      hc.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">
          <span style="font-size:24px">🩺</span>
          <div class="dash-card-title">System Health</div>
          <span class="dash-card-badge ${health.ok ? 'on' : ''}" style="margin-left:auto">${health.ok ? '● Healthy' : '⚠ Degraded'}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:6px">
          <div>
            <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Providers</div>
            ${(() => {
              const labels = {
                anthropic: 'Anthropic',
                ollama: 'Ollama',
                lmstudio: 'LM Studio',
                openai: 'OpenAI',
                'openai-oauth': 'OpenAI (ChatGPT login)',
                gemini: 'Google Gemini',
                deepseek: 'DeepSeek',
                groq: 'Groq',
                mistral: 'Mistral AI',
                together: 'Together AI',
                perplexity: 'Perplexity',
                zai: 'Z.AI',
                grok: 'xAI Grok',
                openrouter: 'OpenRouter',
                fireworks: 'Fireworks',
              };
              const entries = Object.entries(health.providers || {});
              if (!entries.length) return '<div style="font-size:12px;color:var(--muted)">None configured</div>';
              return entries.map(([k, ok]) => `<div style="font-size:12px">${dot(ok)}${labels[k] ?? k}</div>`).join('');
            })()}
          </div>
          <div>
            <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Cortex</div>
            <div style="font-size:12px">${dot(health.cortex.embed)}Embeddings <span style="color:var(--muted)">(${escHtml(health.cortex.embedProvider)})</span></div>
            <div style="font-size:12px">${dot(health.cortex.reason)}Reasoning <span style="color:var(--muted)">(${escHtml(health.cortex.reasonProvider)})</span></div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Gmail</div>
            ${gmailHtml}
          </div>
          <div>
            <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">System</div>
            <div style="font-size:12px">${icon('clock', 12)} Uptime: <b>${fmtUptime(health.uptime)}</b></div>
            <div style="font-size:12px">${icon('users', 12)} Users: <b>${health.users}</b></div>
            <div style="font-size:12px">${icon('list-checks', 12)} Tasks: <b>${health.scheduler.active}</b>/${health.scheduler.tasks} active</div>
            <div style="font-size:12px">${icon('message-square', 12)} Sessions: <b>${health.disk.sessionsCount}</b> files, ${(health.disk.sessionLines ?? 0).toLocaleString()} lines</div>
            <div style="font-size:12px">${icon('wallet', 12)} Expenses: <b>${(health.disk.expensesTxnCount ?? 0).toLocaleString()}</b> transactions</div>
            <div style="font-size:12px">${icon('brain', 12)} Cortex DBs: <b>${health.disk.cortexUsers.length}</b> user${health.disk.cortexUsers.length !== 1 ? 's' : ''}</div>
          </div>
        </div>`;
      body.appendChild(hc);
    } catch {}
  }

  const mc = document.createElement('div');
  mc.className = 'dash-card memory-card';
  mc.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span>${icon('brain', 28)}</span><div>
    <div class="dash-card-title">Memory</div>
    <div class="dash-card-meta">${data.memoryCount ?? 0} stored memories across all agents</div>
  </div></div>
  <button class="dash-tool-btn" data-action="openDashboardTool" data-args='["memory"]'>Open Memory Control</button>`;
  body.appendChild(mc);

  const inspector = document.createElement('div');
  inspector.className = 'dash-card';
  inspector.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span>${icon('scan-search', 28)}</span><div>
    <div class="dash-card-title">Run Inspector</div>
    <div class="dash-card-meta">Recent agent runs, tools, payload sizes, and injected memory</div>
  </div></div>
  <button class="dash-tool-btn" data-action="openDashboardTool" data-args='["runs"]'>Open Run Inspector</button>`;
  body.appendChild(inspector);

  const perms = document.createElement('div');
  perms.className = 'dash-card';
  perms.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span>${icon('shield-check', 28)}</span><div>
    <div class="dash-card-title">Skill Permissions</div>
    <div class="dash-card-meta">What each skill's tools can do, grouped by capability and risk</div>
  </div></div>
  <button class="dash-tool-btn" data-action="openDashboardTool" data-args='["skill-permissions"]'>Open Skill Permissions</button>`;
  body.appendChild(perms);

  // Token usage card (admin/owner only)
  if (_currentUser?.role === 'owner' || _currentUser?.role === 'admin') {
    try {
      const activity = await fetch('/api/admin/activity').then(r => r.json());
      const tc = document.createElement('div');
      tc.className = 'dash-card';
      tc.style.borderColor = '#43b89c55';

      const todayStr = new Date().toISOString().slice(0, 10);
      const dateNDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

      function aggregateUserRange(info, startDate, endDate) {
        let messages = 0, totalCost = 0;
        const tokensByModel = {};
        for (const [date, dayData] of Object.entries(info.data || {})) {
          if (date < startDate || date > endDate) continue;
          messages += dayData.messages ?? 0;
          totalCost += dayData.totalEstimatedCost ?? 0;
          for (const [key, d] of Object.entries(dayData.tokensByModel || {})) {
            if (!tokensByModel[key]) tokensByModel[key] = { input: 0, output: 0, cost: 0 };
            tokensByModel[key].input += d.input ?? 0;
            tokensByModel[key].output += d.output ?? 0;
            tokensByModel[key].cost += d.cost ?? 0;
          }
        }
        return { messages, totalCost, tokensByModel };
      }

      function renderTokenRows(activity, startDate, endDate) {
        let rows = '';
        let grandTotal = 0;
        for (const [uid, info] of Object.entries(activity)) {
          const agg = aggregateUserRange(info, startDate, endDate);
          const models = Object.entries(agg.tokensByModel);
          if (!models.length) continue;
          grandTotal += agg.totalCost;
          const modelRows = models.map(([key, d]) => {
            const [prov, model] = key.split('||');
            const shortModel = model?.length > 30 ? model.slice(0, 27) + '...' : model;
            const provBadge = prov === 'anthropic' ? icon('cloud', 12) : (prov === 'ollama' || prov === 'lmstudio') ? icon('server', 12) : icon('globe', 12);
            return `<div style="display:flex;gap:8px;font-size:10px;color:var(--muted);padding:2px 0">
              <span>${provBadge}</span>
              <span style="flex:1">${escHtml(shortModel)}</span>
              <span>↓${d.input.toLocaleString()}</span>
              <span>↑${d.output.toLocaleString()}</span>
              <span style="color:${d.cost > 0 ? 'var(--text)' : 'var(--muted)'}">$${d.cost.toFixed(4)}</span>
            </div>`;
          }).join('');
          rows += `<div style="margin-bottom:8px">
            <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:2px">${escHtml(info.name)} <span style="font-weight:400;font-size:11px;color:var(--muted)">${agg.messages} msgs · $${agg.totalCost.toFixed(4)}</span></div>
            ${modelRows}
          </div>`;
        }
        return { rows, grandTotal };
      }

      const periods = [
        { label: 'Today', start: todayStr, end: todayStr },
        { label: '7 Days', start: dateNDaysAgo(6), end: todayStr },
        { label: '30 Days', start: dateNDaysAgo(29), end: todayStr },
      ];
      let activePeriod = 0;

      function renderCard() {
        const p = periods[activePeriod];
        const { rows, grandTotal } = renderTokenRows(activity, p.start, p.end);
        const tabs = periods.map((t, i) =>
          `<span data-period="${i}" style="padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;${i === activePeriod ? 'background:var(--accent);color:#fff' : 'color:var(--muted)'}">${t.label}</span>`
        ).join('');
        tc.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span>${icon('bar-chart-2', 24)}</span>
          <div style="flex:1">
            <div class="dash-card-title">Token Usage (${p.label})</div>
            <div class="dash-card-meta">Total estimated cost: $${grandTotal.toFixed(4)}</div>
          </div>
          <div style="display:flex;gap:4px">${tabs}</div>
        </div>
        ${rows || '<div style="font-size:11px;color:var(--muted)">No token data for this period</div>'}`;
        tc.querySelectorAll('[data-period]').forEach(el => {
          el.onclick = () => { activePeriod = parseInt(el.dataset.period); renderCard(); };
        });
      }
      renderCard();
      body.appendChild(tc);
    } catch {}
  }

}

const DASH_TOOLS = {
  memory: { title: 'Memory Control', icon: 'brain', panelId: 'dashboardMemoryControlBody', panelClass: 'memory-control' },
  runs: { title: 'Run Inspector', icon: 'scan-search', panelId: 'dashboardRunInspectorBody', panelClass: 'run-inspector' },
  'skill-permissions': { title: 'Skill Permissions', icon: 'shield-check', panelId: 'dashboardSkillPermissionsBody', panelClass: 'skill-permissions' },
};

function openDashboardTool(tool) {
  const body = $('dashBody');
  if (!body) return;
  const cfg = DASH_TOOLS[tool];
  if (!cfg) return;
  body.innerHTML = `
    <div class="dash-tool-shell">
      <div class="dash-tool-head">
        <button class="dash-tool-back" data-action="loadDashboard">${icon('arrow-left', 14)} Back</button>
        <div class="dash-tool-title">${icon(cfg.icon, 18)} ${escHtml(cfg.title)}</div>
      </div>
      <div class="dash-tool-panel ${cfg.panelClass}" id="${cfg.panelId}">
        <div class="cdraw-empty">Loading…</div>
      </div>
    </div>
  `;
  if (tool === 'memory' && typeof loadMemoryControl === 'function') loadMemoryControl(cfg.panelId);
  if (tool === 'runs' && typeof loadRunInspector === 'function') loadRunInspector(null, cfg.panelId);
  if (tool === 'skill-permissions' && typeof loadSkillPermissions === 'function') loadSkillPermissions(cfg.panelId);
  if (window.lucide) lucide.createIcons();
}

function handleTaskComplete(msg) {
  fetch(`/api/history/${msg.agent}`).then(r => r.json()).then(messages => {
    sessions[msg.agent] = messages;
    if (msg.agent === activeAgent) renderSession();
    // Flash tasks badge
    const badge = $('tasksBadge');
    const origBg = badge.style.background;
    badge.style.background = 'var(--green)';
    setTimeout(() => { badge.style.background = origBg; }, 4000);
    loadTaskList();
    if (agents.find(a => a.skillCategory === 'expenses')?.id === msg.agent && $('drawerExpenses')?.classList.contains('open')) loadExpTxns();
  });
}
