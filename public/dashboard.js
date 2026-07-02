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

  const agskills = document.createElement('div');
  agskills.className = 'dash-card';
  agskills.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span>${icon('users', 28)}</span><div>
    <div class="dash-card-title">Agents & Skills</div>
    <div class="dash-card-meta">Which skills and tools each agent has assigned</div>
  </div></div>
  <button class="dash-tool-btn" data-action="openDashboardTool" data-args='["agent-skills"]'>Open Agents &amp; Skills</button>`;
  body.appendChild(agskills);

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

  // Local-First card (admin/owner only) — the complement of Token Usage: how
  // many turns OE handled WITHOUT a cloud LLM call (fast-paths + local models).
  // Range-parameterized, so it re-fetches /api/admin/turn-metrics per toggle.
  if (_currentUser?.role === 'owner' || _currentUser?.role === 'admin') {
    const lc = document.createElement('div');
    lc.className = 'dash-card';
    lc.style.borderColor = '#43b89c55';
    body.appendChild(lc);

    const lfRanges = [
      { label: '1h', range: '1h' },
      { label: '24h', range: '24h' },
      { label: '7d', range: '7d' },
    ];
    let lfActive = 1; // default 24h

    const tile = (label, value, sub) =>
      `<div>
        <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px">${label}</div>
        <div style="font-size:20px;font-weight:700;color:var(--text)">${value}</div>
        ${sub ? `<div style="font-size:11px;color:var(--muted)">${sub}</div>` : ''}
      </div>`;

    function lfHead(metaHtml) {
      const tabs = lfRanges.map((t, i) =>
        `<span data-lfrange="${i}" style="padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;${i === lfActive ? 'background:var(--accent);color:#fff' : 'color:var(--muted)'}">${t.label}</span>`
      ).join('');
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span>${icon('zap', 24)}</span>
          <div style="flex:1">
            <div class="dash-card-title">Local-First (last ${lfRanges[lfActive].label})</div>
            <div class="dash-card-meta">${metaHtml}</div>
          </div>
          <div style="display:flex;gap:4px">${tabs}</div>
        </div>`;
    }
    function lfWireTabs() {
      lc.querySelectorAll('[data-lfrange]').forEach(el => {
        el.onclick = () => { lfActive = parseInt(el.dataset.lfrange); renderLocalFirst(); };
      });
    }

    async function renderLocalFirst() {
      lc.innerHTML = lfHead('Loading…');
      lfWireTabs();
      let m;
      try { m = await fetch(`/api/admin/turn-metrics?range=${lfRanges[lfActive].range}`).then(x => x.json()); }
      catch { lc.innerHTML = lfHead('<span style="color:var(--red)">Failed to load metrics</span>'); lfWireTabs(); return; }

      const t = m.totals || {};
      const lat = m.latencyMs || {};
      const cache = m.cache || {};
      const tr = m.toolRouter || {};
      const secs = (ms) => ((ms || 0) / 1000).toFixed(1) + 's';
      const fmtK = (n) => (n || 0) >= 1000 ? ((n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k') : String(n || 0);
      if (!t.turns) { lc.innerHTML = lfHead('No turns recorded in this window.'); lfWireTabs(); return; }

      const localTurns = (t.llmAvoidedTurns || 0) + (t.localLlmTurns || 0);
      const meta = `<b>${t.cloudCallsAvoided}</b> of <b>${t.turns}</b> turns avoided a cloud call · <b>${t.cloudCallsAvoidedPct}%</b>`;

      const breakdown = [
        ['Fast-path (no LLM)', t.llmAvoidedTurns, 'var(--green,#43b89c)'],
        ['Local LLM', t.localLlmTurns, '#5b9bd5'],
        ['Cloud', t.cloudTurns, '#e0a05c'],
        ['Unknown', t.unknownTurns, 'var(--muted)'],
      ].filter(([, n]) => n > 0).map(([label, n, color]) => {
        const pct = Math.round((n / t.turns) * 100);
        return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:1px 0">
          <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color}"></span>
          <span style="flex:1">${label}</span>
          <span style="color:var(--muted)">${n} · ${pct}%</span>
        </div>`;
      }).join('');

      const handlers = (m.byLocalHandler || []).slice(0, 5).map(h =>
        `<div style="display:flex;font-size:11px;color:var(--muted);padding:1px 0"><span style="flex:1">${escHtml(h.handler)}</span><span>${h.turns}</span></div>`
      ).join('') || '<div style="font-size:11px;color:var(--muted)">No local-handler hits yet</div>';

      const slowAgents = (m.slowestAgents || []).slice(0, 3).map(a =>
        `<div style="display:flex;font-size:11px;color:var(--muted);padding:1px 0"><span style="flex:1">${escHtml(a.agent)}</span><span>${secs(a.avgMs)} avg</span></div>`
      ).join('') || '<div style="font-size:11px;color:var(--muted)">—</div>';

      lc.innerHTML = lfHead(meta) + `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin:8px 0">
          ${tile('Avoided', t.cloudCallsAvoidedPct + '%', t.cloudCallsAvoided + ' of ' + t.turns)}
          ${tile('Local', localTurns, 'fast-path + local')}
          ${tile('Cloud', t.cloudTurns, t.unknownTurns ? t.unknownTurns + ' unknown' : '')}
          ${tile('Latency', secs(lat.p95), 'p95 · p50 ' + secs(lat.p50))}
          ${(cache.cacheReadTok || 0) > 0 ? tile('Cache hit', cache.hitPct + '%', fmtK(cache.cacheReadTok) + ' tok read') : ''}
          ${(tr.fullTools || 0) > 0 ? tile('Tools cut', tr.trimmedPct + '%', tr.droppedTools + ' of ' + tr.fullTools) : ''}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <div>
            <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Routing</div>
            ${breakdown}
          </div>
          <div>
            <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Top local handlers</div>
            ${handlers}
          </div>
        </div>
        <div style="margin-top:10px">
          <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Slowest agents</div>
          ${slowAgents}
        </div>`;
      lfWireTabs();
    }
    renderLocalFirst();
  }

  // Reliability card (admin/owner only) — the trust complement of Local-First:
  // tool failure rates by skill and provider plus recent errors, over the same
  // turn-trace spine (per-tool ok is honest since the trace-honesty fix).
  if (_currentUser?.role === 'owner' || _currentUser?.role === 'admin') {
    const rc = document.createElement('div');
    rc.className = 'dash-card';
    rc.style.borderColor = '#43b89c55';
    body.appendChild(rc);

    const rlRanges = [
      { label: '1h', range: '1h' },
      { label: '24h', range: '24h' },
      { label: '7d', range: '7d' },
    ];
    let rlActive = 1; // default 24h

    const rlTile = (label, value, sub) =>
      `<div>
        <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px">${label}</div>
        <div style="font-size:20px;font-weight:700;color:var(--text)">${value}</div>
        ${sub ? `<div style="font-size:11px;color:var(--muted)">${sub}</div>` : ''}
      </div>`;
    const rlCol = (title, rowsHtml) =>
      `<div>
        <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">${title}</div>
        ${rowsHtml}
      </div>`;
    const rlAgo = (iso) => {
      const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    };

    function rlHead(metaHtml) {
      const tabs = rlRanges.map((t, i) =>
        `<span data-rlrange="${i}" style="padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;${i === rlActive ? 'background:var(--accent);color:#fff' : 'color:var(--muted)'}">${t.label}</span>`
      ).join('');
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span>${icon('activity', 24)}</span>
          <div style="flex:1">
            <div class="dash-card-title">Reliability (last ${rlRanges[rlActive].label})</div>
            <div class="dash-card-meta">${metaHtml}</div>
          </div>
          <div style="display:flex;gap:4px">${tabs}</div>
        </div>`;
    }
    function rlWireTabs() {
      rc.querySelectorAll('[data-rlrange]').forEach(el => {
        el.onclick = () => { rlActive = parseInt(el.dataset.rlrange); renderReliability(); };
      });
    }

    async function renderReliability() {
      rc.innerHTML = rlHead('Loading…');
      rlWireTabs();
      let m;
      try { m = await fetch(`/api/admin/reliability?range=${rlRanges[rlActive].range}`).then(x => x.json()); }
      catch { rc.innerHTML = rlHead('<span style="color:var(--red)">Failed to load metrics</span>'); rlWireTabs(); return; }

      const t = m.totals || {};
      if (!t.turns) { rc.innerHTML = rlHead('No turns recorded in this window.'); rlWireTabs(); return; }
      const anyFailures = (t.toolFailures || 0) + (t.providerErrors || 0) > 0;
      rc.style.borderColor = anyFailures ? '#e0a05c55' : '#43b89c55';

      const meta = anyFailures
        ? `<b>${t.toolFailures}</b> of <b>${t.toolCalls}</b> tool calls failed · <b>${t.providerErrors}</b> provider error${t.providerErrors === 1 ? '' : 's'}`
        : `All <b>${t.toolCalls}</b> tool calls ok across <b>${t.turns}</b> turns`;

      const statRow = (name, calls, failures, failPct) =>
        `<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:1px 0">
          <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${failures > 0 ? '#e0a05c' : 'var(--green,#43b89c)'}"></span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(name)}</span>
          <span style="color:${failures > 0 ? 'var(--text)' : 'var(--muted)'}">${failures > 0 ? `${failures} of ${calls} · ${failPct}%` : `${calls} ok`}</span>
        </div>`;

      const skillRows = (m.bySkill || []).slice(0, 6)
        .map(s => statRow(s.skill, s.calls, s.failures, s.failPct)).join('')
        || '<div style="font-size:11px;color:var(--muted)">No tool calls in this window</div>';
      const providerRows = (m.byProvider || []).slice(0, 6)
        .map(p => statRow(p.provider, p.toolCalls, p.toolFailures + p.providerErrors,
          p.providerErrors ? Math.round(((p.toolFailures + p.providerErrors) / Math.max(1, p.spans + p.toolCalls)) * 100) : p.toolFailPct)).join('')
        || '<div style="font-size:11px;color:var(--muted)">—</div>';

      const failingTools = (m.byTool || []).filter(x => x.failures > 0).slice(0, 5);
      const failingHtml = failingTools.length ? failingTools.map(x =>
        `<div style="padding:2px 0">
          <div style="display:flex;gap:8px;font-size:12px">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${escHtml(x.tool)}</b> <span style="color:var(--muted)">· ${escHtml(x.skill)}</span></span>
            <span>${x.failures} of ${x.calls} · ${x.failPct}%</span>
          </div>
          ${x.lastError ? `<div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">↳ ${escHtml(x.lastError)}</div>` : ''}
        </div>`).join('') : '';

      const recentHtml = (m.recentErrors || []).slice(0, 4).map(e =>
        `<div style="display:flex;gap:8px;font-size:11px;color:var(--muted);padding:1px 0">
          <span style="white-space:nowrap">${e.atIso ? rlAgo(e.atIso) : '—'}</span>
          <span style="white-space:nowrap">${escHtml(e.agent || '?')}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(e.error)}</span>
        </div>`).join('');

      rc.innerHTML = rlHead(meta) + `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin:8px 0">
          ${rlTile('Tool success', t.toolSuccessPct + '%', t.toolCalls + ' calls')}
          ${rlTile('Failures', t.toolFailures, t.toolFailurePct + '% of calls')}
          ${rlTile('Provider errors', t.providerErrors, t.spans + ' LLM runs')}
          ${rlTile('Turns w/ errors', t.turnsWithErrors, 'of ' + t.turns)}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          ${rlCol('By skill', skillRows)}
          ${rlCol('By provider', providerRows)}
        </div>
        ${failingHtml ? `<div style="margin-top:10px">${rlCol('Failing tools', failingHtml)}</div>` : ''}
        ${recentHtml ? `<div style="margin-top:10px">${rlCol('Recent errors', recentHtml)}</div>` : ''}`;
      rlWireTabs();
    }
    renderReliability();
  }

}

const DASH_TOOLS = {
  memory: { title: 'Memory Control', icon: 'brain', panelId: 'dashboardMemoryControlBody', panelClass: 'memory-control' },
  runs: { title: 'Run Inspector', icon: 'scan-search', panelId: 'dashboardRunInspectorBody', panelClass: 'run-inspector' },
  'skill-permissions': { title: 'Skill Permissions', icon: 'shield-check', panelId: 'dashboardSkillPermissionsBody', panelClass: 'skill-permissions' },
  'agent-skills': { title: 'Agents & Skills', icon: 'users', panelId: 'dashboardAgentSkillsBody', panelClass: 'agent-skills' },
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
  if (tool === 'agent-skills' && typeof loadAgentSkills === 'function') loadAgentSkills(cfg.panelId);
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
