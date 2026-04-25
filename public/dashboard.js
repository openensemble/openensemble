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

  // Claude Code usage card
  try {
    const usage = await fetch('/api/claude-usage').then(r => r.json());
    const uc = document.createElement('div');
    uc.className = 'dash-card';
    uc.style.borderColor = '#a78bfa55';
    const fmtTokens = n => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : n;
    function usageBar(used, limit, label) {
      if (!limit) return `<div style="font-size:12px;color:var(--muted)">${label}: <b style="color:var(--text)">${fmtTokens(used)}</b> tokens <span style="color:var(--muted);font-size:11px">(no limit set)</span></div>`;
      const pct = Math.min(100, Math.round(used / limit * 100));
      const color = pct >= 90 ? 'var(--red,#e05c5c)' : pct >= 70 ? 'var(--yellow,#f0c040)' : 'var(--accent)';
      const left = fmtTokens(Math.max(0, limit - used));
      return `<div style="font-size:12px;color:var(--muted);margin-bottom:4px">${label}: <b style="color:var(--text)">${fmtTokens(used)}</b> / ${fmtTokens(limit)} — <b style="color:${color}">${pct}% used</b> · ${left} remaining</div>
        <div style="height:6px;background:var(--bg3);border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width .4s"></div></div>`;
    }
    uc.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><span>${icon('zap', 24)}</span><div class="dash-card-title">Claude Code Usage</div></div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${usageBar(usage.today, usage.dailyLimit, 'Today')}
        ${usageBar(usage.week,  usage.weeklyLimit, 'This week')}
      </div>
      ${!usage.dailyLimit && !usage.weeklyLimit ? '<div style="font-size:11px;color:var(--muted);margin-top:4px">Set limits in Settings → System to see usage %</div>' : ''}`;
    body.appendChild(uc);
  } catch {}

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
  </div></div>`;
  body.appendChild(mc);

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

  for (const task of data.tasks.filter(t => t.type !== 'reminder')) {
    const card = document.createElement('div');
    card.className = 'dash-card';

    const isOnce = task.repeat === 'once';
    const isDone = isOnce && task.enabled === false;
    const enabled = task.enabled !== false;

    let schedDesc, noOutputMsg;
    if (isOnce) {
      const runAt = task.datetime
        ? new Date(task.datetime).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
        : '?';
      schedDesc = isDone ? `Ran once · ${runAt}` : `Runs once at ${runAt}`;
      noOutputMsg = isDone ? 'Completed — no output captured' : `Pending · runs at ${runAt}`;
    } else {
      schedDesc = `Daily at ${escHtml(task.time ?? '?')}`;
      noOutputMsg = `No output yet — runs daily at ${escHtml(task.time ?? '?')}`;
    }

    let badgeClass = '', badgeText;
    if (isOnce && isDone)      { badgeClass = '';    badgeText = '✓ Done'; }
    else if (isOnce && enabled){ badgeClass = 'on';  badgeText = '◷ Pending'; }
    else if (enabled)          { badgeClass = 'on';  badgeText = '● Active'; }
    else                       { badgeClass = '';    badgeText = '○ Paused'; }

    const lastRun = task.lastRun
      ? new Date(task.lastRun).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
      : null;

    let outputSection;
    if (task.lastOutput) {
      outputSection = `<div class="dash-card-output" title="Click to expand" onclick="this.classList.toggle('expanded')">${renderMarkdown(task.lastOutput)}</div>
        <div style="font-size:10px;color:var(--muted);text-align:right">click to expand</div>`;
    } else {
      outputSection = `<div style="font-size:13px;color:var(--muted);font-style:italic">${noOutputMsg}</div>`;
    }

    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div>
          <div class="dash-card-title">📋 ${escHtml(task.label)}</div>
          <div class="dash-card-meta">${escHtml(agents.find(a=>a.id===task.agent)?.name ?? task.agent)} · ${schedDesc}</div>
        </div>
        <span class="dash-card-badge ${badgeClass}">${badgeText}</span>
      </div>
      ${outputSection}
      <div class="dash-card-footer">
        <span style="font-size:11px;color:var(--muted)">${lastRun ? `Last run: ${lastRun}` : (isOnce && !isDone ? 'Not run yet' : '')}</span>
        <button class="btn-dash-go" onclick="switchAgent('${escHtml(task.agent)}');closeDashboard()">View in Chat →</button>
      </div>`;
    body.appendChild(card);
  }

  if (!data.tasks.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--muted);font-size:14px;padding:20px';
    empty.textContent = 'No scheduled tasks yet. Add one via Tasks.';
    body.appendChild(empty);
  }
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

