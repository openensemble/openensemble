// ── Agent pill update ──────────────────────────────────────────────────────────
function updateAgentPill() {
  const a = agents.find(x => x.id === activeAgent);
  if (!a) return;
  $('agentPillEmoji').textContent = a.emoji;
  $('agentPillName').textContent  = a.name;
}

// ── Agent tabs (mobile) + drawer list ─────────────────────────────────────────
function checkEmptyState() {
  const empty = agents.length === 0;
  $('emptyState').style.display = empty ? 'flex' : 'none';
  $('input').disabled = empty;
  $('btnSend').disabled = empty;
  if (!empty) { $('input').placeholder = 'Message…'; return; }

  const hasProviders = _hasAnyProviderConfigured();
  const isAdmin = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  const noProvAdmin = $('emptyStateNoProviders');
  const noProvUser  = $('emptyStateNoProvidersUser');
  const noAgents    = $('emptyStateNoAgents');
  if (!hasProviders && isAdmin) {
    noProvAdmin.style.display = '';
    noProvUser.style.display  = 'none';
    noAgents.style.display    = 'none';
    $('input').placeholder = 'Connect a provider to start chatting…';
  } else if (!hasProviders) {
    noProvAdmin.style.display = 'none';
    noProvUser.style.display  = '';
    noAgents.style.display    = 'none';
    $('input').placeholder = 'No providers configured…';
  } else {
    noProvAdmin.style.display = 'none';
    noProvUser.style.display  = 'none';
    noAgents.style.display    = '';
    $('input').placeholder = 'Create an agent to start chatting…';
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function _hasAnyProviderConfigured() {
  // Non-admin users don't configure providers themselves — they're granted
  // specific models by the admin (allowedModels). For them, the welcome state
  // should reflect that grant directly: do they have any models to pick from?
  // Looking at provider toggles instead would gate them on admin-side state
  // they can't see or change.
  const allowed = _currentUser?.allowedModels;
  if (Array.isArray(allowed)) return allowed.length > 0;
  // Admin or unrestricted user: check whether any provider is configured.
  //   (a) the admin flipped a toggle on, OR
  //   (b) a real API key is set (covers keys written directly to config.json
  //       or env without the UI flipping the toggle).
  // lmstudio is excluded from (b) because the shipped template seeds
  // `lmstudioApiKey` with the literal string "lmstudio" — its *KeySet flag is
  // unreliable on fresh installs.
  const ep = (typeof _enabledProviders !== 'undefined') ? _enabledProviders : {};
  if (Object.values(ep).some(v => v === true)) return true;
  const ks = (typeof _providerKeyStatus !== 'undefined' && _providerKeyStatus) ? _providerKeyStatus : {};
  for (const [prov, keySet] of Object.entries(ks)) {
    if (prov === 'lmstudio') continue;
    if (keySet === true) return true;
  }
  return false;
}

function buildTabs() {
  // Mobile bottom bar: current-agent chip + busy signals. The full agent list
  // lives in the bottom-sheet switcher (drawers.js buildAgentSheet).
  const a = agents.find(x => x.id === activeAgent);
  const em = $('bnAgentEmoji'), nm = $('bnAgentName');
  if (em) em.textContent = a?.emoji ?? '🤖';
  if (nm) nm.textContent = a?.name ?? 'Agent';
  const selfBusy = $('bnAgentBusy');
  if (selfBusy) selfBusy.style.display = agentStreams[activeAgent]?.active ? '' : 'none';
  const othersBusy = $('bnOthersBusy');
  if (othersBusy) othersBusy.style.display =
    agents.some(x => x.id !== activeAgent && agentStreams[x.id]?.active) ? '' : 'none';
  if (typeof refreshAgentSheetIfOpen === 'function') refreshAgentSheetIfOpen();
  updateAgentPill();
  checkEmptyState();
}

function buildAgentDrawer() {
  const container = $('agentListContainer');
  container.innerHTML = '';
  agents.forEach(a => {
    const item = document.createElement('div');
    item.className = 'agent-list-item' + (a.id === activeAgent ? ' active' : '');
    const busy = agentStreams[a.id]?.active ? '<span class="busy-dot"></span>' : '';
    const roleMap = { coordinator: 'Coordinator', email: 'Email', finance: 'Finance', expenses: 'Finance', web: 'Assistant', coding: 'Coder', code: 'Coder', coder: 'Coder', image_generator: 'Image Generator', role_video_generator: 'Video Generator', role_tutor: 'Tutor', deep_research: 'Deep Research', delegate: 'Delegate', gcal: 'Calendar', tasks: 'Tasks', 'self-mgmt': 'Self Management', 'user-admin': 'User Admin' };
    const agRole = (a.skillCategory && a.skillCategory !== 'general') ? (roleMap[a.skillCategory] ?? a.skillCategory) : (a.description ? a.description.slice(0, 40) : '');
    item.innerHTML = `
      <span class="ag-emoji">${escHtml(a.emoji ?? '')}</span>
      <div class="ag-info">
        <div class="ag-name">${escHtml(a.name)}</div>
        <div class="ag-model">${agRole ? escHtml(agRole) + ' · ' : ''}${escHtml(a.model ?? '')}</div>
      </div>
      ${busy}
      ${a.custom ? `<button class="ag-edit" title="Edit ${escHtml(a.name)}" data-action="_editAgentById" data-args='${JSON.stringify([a.id]).replace(/'/g, "&#39;")}' data-stop-propagation>✏️</button><button class="ag-del" title="Delete ${escHtml(a.name)}" data-action="deleteAgent" data-args='${JSON.stringify([a.id, a.name]).replace(/'/g, "&#39;")}' data-stop-propagation>✕</button>` : ''}
    `;
    item.addEventListener('click', () => switchAgent(a.id));
    if (a.custom) {
      item.addEventListener('contextmenu', e => { e.preventDefault(); openNewAgentModal(a); });
    }
    container.appendChild(item);
  });
}

function switchAgent(id) {
  if (id === activeAgent) { closeAllDrawers(); return; }
  if (typeof saveDraftForAgent === 'function') saveDraftForAgent(activeAgent); // chat.js: per-agent composer draft
  // A reply streaming into a tutor widget must be released before we leave —
  // otherwise _activeWidgetTarget stays armed and the next reply (on any
  // agent) routes into a widget element that no longer exists. If the turn is
  // still running, its widget buffer becomes the background stream buffer so
  // the reply survives as a normal bubble on switch-back.
  let widgetBuf = '';
  if (typeof getActiveWidgetTarget === 'function' && getActiveWidgetTarget()) {
    widgetBuf = widgetStreamFinish() || '';
  }
  // Save current agent's streaming state if still active
  if (streaming) {
    // Capture tool pill names from DOM before clearing
    const savedToolNames = [];
    if (toolPillsEl) {
      toolPillsEl.querySelectorAll('.tool-pill').forEach(p => {
        const name = p.textContent.replace(/^⚙\s*/, '').trim();
        if (name) savedToolNames.push(name);
      });
    }
    agentStreams[activeAgent] = { buf: widgetBuf || streamBuf, toolNames: savedToolNames, active: true };
  }
  activeAgent = id;
  if (typeof restoreDraftForAgent === 'function') restoreDraftForAgent(id); // chat.js: per-agent composer draft
  streamEl = null; streamBuf = ''; toolPillsEl = null;
  // Clear the in-flight tool run too — otherwise a turn already streaming on the
  // NEW agent commits the previous agent's tool events onto it.
  resetToolRun();
  _historyWindow = HISTORY_RENDER_WINDOW; // new pane starts at the base window
  buildTabs();
  buildAgentDrawer();
  // Fetch real history unless it's been genuinely loaded. `id in sessions` isn't
  // enough: a status / agent_report push may have seeded an empty array, which
  // would otherwise leave the agent showing only the stray push with no history.
  if (!sessionsLoaded.has(id)) {
    if (!(id in sessions)) sessions[id] = [];
    ws?.send(JSON.stringify({ type: 'load_session', agent: id }));
  }

  renderSession();
  scrollToBottom(true); // switching agents always lands at the latest message
  // Restore streaming state if the new agent is still generating
  const bg = agentStreams[id];
  if (bg?.active) {
    streamBuf = bg.buf;
    streamEl = appendStreamingBubble();
    if (streamBuf) streamEl.innerHTML = renderMarkdown(streamBuf);
    for (const tn of bg.toolNames) showToolPill(tn);
    setStreaming(true); setTyping(!streamBuf);
    delete agentStreams[id];
    scrollToBottom();
  } else {
    setStreaming(false); setTyping(false);
  }
  closeAllDrawers();
  updateSessionWarning();
}

function updateSessionWarning() {
  const msgs = sessions[activeAgent] ?? [];
  const agent = agents.find(a => a.id === activeAgent);
  const ctxWindow = agent?.contextSize ?? 32768;
  // Mirror backend chars/4 heuristic in chat.mjs
  let chars = 0;
  for (const m of msgs) chars += (m.content?.length ?? 0);
  const tokens = Math.round(chars / 4);
  const pct = tokens / ctxWindow;
  // Backend trims history at 55% of ctx; warn at 40%, alert at 50% so users
  // get a heads-up before old turns start dropping.
  const cls = pct >= 0.50 ? 'alert' : pct >= 0.40 ? 'warn' : '';
  const kTok = (tokens / 1000).toFixed(1) + 'k';
  const kCtx = Math.round(ctxWindow / 1000) + 'k';
  const tip = pct >= 0.50 ? `Session is very long (~${kTok} / ${kCtx} tokens) — older turns will start dropping soon`
            : pct >= 0.40 ? `Session is getting long (~${kTok} / ${kCtx} tokens) — consider clearing` : '';
  const sdot = $('sessionDot');
  if (sdot) {
    sdot.className = 'session-dot' + (cls ? ' ' + cls : '');
    sdot.title = tip;
  }
  $('sbtnClear').title = tip || 'Clear session';
}

function clearSession() {
  const agentName = agents.find(a => a.id === activeAgent)?.name ?? activeAgent;
  if (!confirm(`Clear ${agentName} session?`)) return;
  sessions[activeAgent] = [];
  renderSession();
  ws?.send(JSON.stringify({ type: 'clear_session', agent: activeAgent }));
  updateSessionWarning();
}

// ── New Agent ─────────────────────────────────────────────────────────────────
function _populateAgentModelSelect(agent, { preserveCurrent = false } = {}) {
  const sel = $('aModel');
  if (!sel) return;
  // On the async Fireworks refresh we want to keep whatever the user just picked;
  // on initial open we always seed from agent.model so we don't inherit a stale
  // selection left over from the previous agent the modal was opened for.
  const curVal = preserveCurrent ? sel.value : '';
  let curModel, curProvider;
  if (curVal) {
    [curModel, curProvider] = curVal.split('||');
  } else if (agent) {
    curModel = agent.model;
    curProvider = agent.provider;
  } else {
    curModel = 'qwen2.5:7b';
    curProvider = 'ollama';
  }
  const all = allAvailableModels();
  const mkOpt = m => {
    const selected = m.name === curModel && m.provider === curProvider ? 'selected' : '';
    return `<option value="${escHtml(m.name)}||${m.provider}" ${selected}>${escHtml(m.displayName ?? m.name)}</option>`;
  };
  const byProv = p => all.filter(m => m.provider === p);
  const ollamaAll       = byProv('ollama');
  const ollamaLocalOpts = ollamaAll.filter(m => (m.tier ?? 'local') === 'local');
  const ollamaCloudOpts = ollamaAll.filter(m => m.tier === 'cloud');
  const groups = [
    ['Anthropic',                  byProv('anthropic')],
    ['OpenAI ✨',                   byProv('openai')],
    ['OpenAI (ChatGPT login) 🔐',  byProv('openai-oauth')],
    ['Google Gemini 💎',           byProv('gemini')],
    ['DeepSeek 🧠',                byProv('deepseek')],
    ['Mistral AI 🌬',              byProv('mistral')],
    ['Groq ⚡',                     byProv('groq')],
    ['Together AI 👥',             byProv('together')],
    ['Perplexity 🔍',              byProv('perplexity')],
    ['Ollama (local)',             ollamaLocalOpts],
    ['Ollama (cloud) ☁',           ollamaCloudOpts],
    ['LM Studio',                  byProv('lmstudio')],
    ['Fireworks AI 🎨',            byProv('fireworks')],
    ['xAI Grok ⚡',                 byProv('grok')],
    ['OpenRouter 🔀',              byProv('openrouter')],
  ];
  sel.innerHTML = all.length
    ? groups.map(([label, list]) => list.length ? `<optgroup label="${label}">${list.map(mkOpt).join('')}</optgroup>` : '').join('')
    : `<option value="qwen2.5:7b||ollama">qwen2.5:7b</option>`;
  // If the agent's saved model isn't in the dropdown (provider disabled / not yet loaded),
  // inject it so the select reflects reality instead of silently defaulting to option 0.
  if (agent?.model && !all.some(m => m.name === curModel && m.provider === curProvider)) {
    const orphan = `<option value="${escHtml(curModel)}||${escHtml(curProvider ?? '')}" selected>${escHtml(curModel)} (unavailable)</option>`;
    sel.innerHTML = orphan + sel.innerHTML;
  }
}
const EMOJI_PICKS = ['🤖','🔬','📧','📈','🎯','🛠','📝','🎓','💡','🔐','🧑‍💻','🎨',
  '🏋️','🍕','🚀','⚡','🧠','📊','🗂','🔎','💬','🌍','🎵','📱','🏠','💰','⚽','🎮',
  '💻','⌨️','🖥️','🐛','🔧','⚙️','🧬','🔮','🦊','🐙','🦉','👾','🥷','🧙‍♂️','🌙','🔥'];

let editingAgentId = null;

// Wrapper for the event-delegation harness — looks up the agent record by id
// and forwards to openNewAgentModal. Replaces inline `agents.find(x=>x.id==='id')`.
function _editAgentById(id) {
  const agent = agents.find(x => x.id === id);
  if (agent) openNewAgentModal(agent);
}

async function openNewAgentModal(agent = null) {
  // Refresh provider model lists in the background, then re-populate if already open
  const refresh = () => {
    if ($('newAgentModal').classList.contains('open')) _populateAgentModelSelect(agent, { preserveCurrent: true });
  };
  loadFireworksModels().then(refresh).catch(() => {});
  loadAnthropicModels().then(refresh).catch(() => {});
  loadGrokModels().then(refresh).catch(() => {});
  editingAgentId = agent?.id ?? null;
  $('newAgentModalTitle').innerHTML = agent ? `${icon('pencil', 16)} Edit ${escHtml(agent.name)}` : `${icon('sparkles', 16)} New Agent`;
  $('btnCreateAgent').textContent = agent ? 'Save Changes' : 'Create Agent';
  $('aName').value   = agent?.name    ?? '';
  $('aEmoji').value  = agent?.emoji   ?? '🤖';
  $('aDesc').value   = agent?.description ?? '';
  $('aPersonality').value = agent?.personality ?? '';
  $('aToolSet').value = agent?.toolSet ?? 'web';

  // Populate role picker (creation only). Includes both built-in roles
  // (s.service === true) AND user-installed custom skills (userScope set
  // and non-service). Custom skills are first-class assignments via the
  // same skillAssignments map, so picking one at creation time has the
  // same effect as assigning it later via Settings → Skills.
  const roleLabel = $('aRoleLabel');
  const roleSel = $('aRole');
  if (agent) {
    roleLabel.style.display = 'none';
  } else {
    roleLabel.style.display = '';
    roleSel.innerHTML = '<option value="">— General Assistant —</option>';
    fetch('/api/roles').then(r => r.json()).then(skills => {
      const visible = skills.filter(s => !s.hidden && s.category !== 'delegate');
      const roles = visible.filter(s => s.service);
      const customs = visible.filter(s => !!s.userScope && !s.service);
      const addOpt = (s) => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.icon ?? ''} ${s.name}`.trim();
        return opt;
      };
      if (roles.length) {
        const g = document.createElement('optgroup');
        g.label = 'Roles';
        for (const s of roles) g.appendChild(addOpt(s));
        roleSel.appendChild(g);
      }
      if (customs.length) {
        const g = document.createElement('optgroup');
        g.label = 'Custom skills';
        for (const s of customs) g.appendChild(addOpt(s));
        roleSel.appendChild(g);
      }
    }).catch(() => {});
  }

  const picker = $('emojiPicker');
  picker.classList.remove('open');
  picker.innerHTML = EMOJI_PICKS.map(e =>
    `<span class="emoji-opt${e === (agent?.emoji ?? '🤖') ? ' selected' : ''}" data-e="${e}">${e}</span>`
  ).join('');
  picker.querySelectorAll('.emoji-opt').forEach(el => {
    el.addEventListener('click', () => {
      picker.querySelectorAll('.emoji-opt').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      $('aEmoji').value = el.dataset.e;
      picker.classList.remove('open');
    });
  });

  _populateAgentModelSelect(agent);

  $('aMaxTokens').value = agent?.maxTokens ?? '';
  if ($('aReasoningEffort')) $('aReasoningEffort').value = agent?.reasoningEffort ?? 'auto';
  // contextSize: show blank if the value is the default 32768 (agentToWire always populates it)
  const cs = agent?.contextSize;
  $('aContextSize').value = (cs && cs !== 32768) ? cs : '';

  closeAllDrawers();
  $('newAgentModal').classList.add('open');
  $('aName').focus();
}

$('btnCreateAgent').addEventListener('click', async () => {
  const name = $('aName').value.trim();
  const desc = $('aDesc').value.trim();
  if (!name) { $('aName').focus(); return; }
  const [model, provider] = $('aModel').value.split('||');
  const selectedRole = !editingAgentId ? ($('aRole').value || null) : null;
  const maxTokensRaw = parseInt($('aMaxTokens').value, 10);
  const maxTokens = maxTokensRaw >= 256 ? maxTokensRaw : null;
  const contextSizeRaw = parseInt($('aContextSize').value, 10);
  const contextSize = contextSizeRaw >= 1024 ? contextSizeRaw : null;
  const payload = { name, emoji: $('aEmoji').value.trim() || '🤖', description: desc, model, provider, toolSet: $('aToolSet').value };
  // Always send — PATCH uses 'in changes' so an emptied field clears the stored value.
  payload.personality = $('aPersonality').value.trim();
  if (selectedRole) payload.skillCategory = selectedRole;
  // Always send — PATCH uses 'in changes' to detect clears. For POST, null is harmless.
  payload.maxTokens = maxTokens;
  payload.contextSize = contextSize;
  payload.reasoningEffort = $('aReasoningEffort')?.value || 'auto';

  if (editingAgentId) {
    await fetch(`/api/agents/${editingAgentId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } else {
    const res = await fetch('/api/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const created = await res.json();
    activeAgent = created.id;
    // If a role was selected, try to assign it (succeeds for admins; silently skipped for regular users)
    if (selectedRole) {
      fetch('/api/roles/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: selectedRole, agentId: created.id }),
      }).catch(() => {});
    }
  }
  closeAllDrawers();
  // agent_list broadcast will refresh
});

async function deleteAgent(id, name) {
  if (!confirm(`Delete agent "${name}"? This cannot be undone.`)) return;
  await fetch(`/api/agents/${id}`, { method: 'DELETE' });
  if (activeAgent === id) activeAgent = agents[0]?.id ?? null;
  buildTabs();
  buildAgentDrawer();
}
