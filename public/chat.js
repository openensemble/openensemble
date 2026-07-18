// ── Attachment state ──────────────────────────────────────────────────────────
// Array, not a single slot — index.html's #chatFileInput now has `multiple`,
// and drag-drop/paste can each add one more on top. Each item is the raw
// /api/chat-upload response ({ name, mimeType, isImage, isFinanceFile,
// file_id, base64, extractedText }) plus a client-only `_localKey` (tray
// remove-button identity) and `_uploading` while its upload is in flight.
//
// send() puts the WHOLE tray on the wire as `attachments: [...]` (server-side
// entry-edge normalization lives in chat-dispatch.mjs's handleChatMessage —
// see normalizeAttachments in chat/providers/_shared.mjs — and threads through
// to chat.mjs's per-provider vision-message builder, which now accepts N
// images). MAX_CHAT_ATTACHMENTS_PER_MESSAGE below caps how many files one tray
// (and therefore one message) can hold; _uploadAndAddAttachment enforces it
// with a toast at the point a file would be added, so the cap is felt at
// upload time, not as a surprise at send time.
const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 6; // mirrors MAX_CHAT_ATTACHMENTS in chat/providers/_shared.mjs
let pendingAttachments = [];
// Outbox / pending attempts: public/chat-outbox.js (loaded before this file).

// ── Per-agent draft persistence ──────────────────────────────────────────────
// The composer is one shared <textarea> — without this, a half-typed message
// silently follows the user across agent tabs and evaporates on reload.
// Keyed by agent id in localStorage so it survives reload. Saved debounced on
// every keystroke; switchAgent (public/agents.js) also calls saveDraftForAgent
// synchronously right before it swaps activeAgent, so a fast switch can't
// lose the last few keystrokes to a pending debounce timer. Cleared once a
// message actually sends (see send()); restored on agent switch (same
// switchAgent hook) and on page load / reconnect (websocket.js session_loaded).
const DRAFT_STORAGE_KEY = 'oe.composerDrafts.v1';
const DRAFT_SAVE_DEBOUNCE_MS = 400;
let _draftSaveTimer = null;

function _loadDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}'); } catch { return {}; }
}
function _writeDrafts(drafts) {
  // localStorage can throw (Safari private mode, quota exceeded) — a draft
  // failing to save must never interrupt typing or sending.
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts)); } catch {}
}

function saveDraftForAgent(agentId) {
  if (!agentId) return;
  const text = $('input')?.value ?? '';
  const drafts = _loadDrafts();
  if (text) drafts[agentId] = text; else delete drafts[agentId];
  _writeDrafts(drafts);
}

function restoreDraftForAgent(agentId) {
  const input = $('input');
  if (!input || !agentId) return;
  input.value = _loadDrafts()[agentId] || '';
  resizeTextarea();
}

function clearDraftForAgent(agentId) {
  if (!agentId) return;
  const drafts = _loadDrafts();
  if (agentId in drafts) { delete drafts[agentId]; _writeDrafts(drafts); }
}

(function _initDraftPersistence() {
  const attach = () => {
    const input = $('input');
    if (!input) return;
    input.addEventListener('input', () => {
      clearTimeout(_draftSaveTimer);
      _draftSaveTimer = setTimeout(() => saveDraftForAgent(activeAgent), DRAFT_SAVE_DEBOUNCE_MS);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();

// ── Pre-send tool planning ───────────────────────────────────────────────────
const TOOL_PLAN_STORAGE_KEY = 'oe.toolPlanRecipes.v1';
const TOOL_PLAN_MIN_SCORE = 0.58;
const TOOL_PLAN_MAX_RECIPES = 80;
const TOOL_PLAN_CATALOG = [
  { name: 'email_list', label: 'Fetch recent emails', desc: 'Reads recent inbox messages for the selected/default account.', group: 'Email', re: /\b(?:show|check|read|list|summari[sz]e|triage|any|new|latest|recent)\b.{0,45}\b(?:emails?|mail|inbox|messages?)\b/i },
  { name: 'email_read', label: 'Read one email', desc: 'Opens the full body of a specific email when an ID is already known.', group: 'Email', re: /\b(?:read|open|show)\b.{0,25}\b(?:that|it|email|message)\b/i },
  { name: 'email_thread', label: 'Read email thread', desc: 'Gets the full conversation thread for an email.', group: 'Email', re: /\b(?:thread|conversation|full chain|whole email)\b/i },
  { name: 'email_batch_trash', label: 'Delete selected emails', desc: 'Moves multiple already-known email IDs to trash in one call.', group: 'Email', re: /\b(?:delete|trash|remove)\b.{0,35}\b(?:emails?|messages?|mail|ones?|them|\d)\b/i },
  { name: 'email_trash', label: 'Delete one email', desc: 'Moves one already-known email to trash.', group: 'Email', re: /\b(?:delete|trash|remove)\b.{0,20}\b(?:it|that|email|message)\b/i },
  { name: 'email_count', label: 'Count emails', desc: 'Gets an exact Gmail count, useful for “how many are left”.', group: 'Email', re: /\b(?:how many|count|left|remaining|to go|still need)\b.{0,50}\b(?:emails?|mail|labels?|labeling|unsorted)\b/i },
  { name: 'email_sort_local', label: 'Sort using learned rules', desc: 'Uses local learned sender rules before asking the model to judge emails.', group: 'Email', re: /\b(?:sort|organize|file|label)\b.{0,35}\b(?:emails?|mail|inbox)\b/i },
  { name: 'email_list_labels', label: 'List email labels', desc: 'Reads existing Gmail labels so the agent can reuse them.', group: 'Email', re: /\b(?:labels?|folders?)\b/i },
  { name: 'email_learned_labels', label: 'Show learned label rules', desc: 'Shows what OE has learned about sender-to-label mappings.', group: 'Email', re: /\b(?:learned|remembered|rules?|corrections?|mapping)\b.{0,45}\b(?:labels?|email|sender|budget)\b/i },
  { name: 'email_correct_label', label: 'Save label rule', desc: 'Stores a correction for how future mail from a sender should be labeled.', group: 'Email', re: /\b(?:should go|belongs?|label|file)\b.{0,65}\b(?:as|to|under|in)\b/i },
  { name: 'email_remove_label_correction', label: 'Delete learned label rule', desc: 'Removes explicit saved label corrections while keeping observed learning.', group: 'Email', re: /\b(?:delete|remove|forget|undo|clear)\b.{0,55}\b(?:learned|label|correction|rule|mapping|budget)\b/i },
  { name: 'email_label_query', label: 'Relabel matching emails', desc: 'Applies label changes to all Gmail messages matching a search.', group: 'Email', re: /\b(?:move|label|archive|relabel)\b.{0,55}\b(?:all|everything|from|matching)\b/i },
  { name: 'email_batch_label', label: 'Label selected emails', desc: 'Adds or removes labels on already-known email IDs.', group: 'Email', re: /\b(?:move|label|archive|file)\b.{0,35}\b(?:emails?|messages?|them|these|selected|\d)\b/i },
  { name: 'email_purge_sender', label: 'Bulk delete matching emails', desc: 'Finds all messages from a sender/query and trashes them in one operation.', group: 'Email', re: /\b(?:purge|delete all|trash all|get rid of|clean up)\b.{0,45}\b(?:from|sender|emails?|mail)\b/i },
  { name: 'email_list_accounts', label: 'List email accounts', desc: 'Only needed when the account is unknown or the user asks about accounts.', group: 'Email', re: /\b(?:email accounts?|which account|work email|personal email)\b/i },
  { name: 'email_compose', label: 'Send email', desc: 'Composes and sends an email when an email-capable agent has this tool.', group: 'Email', re: /\b(?:send|email|mail|forward)\b.{0,60}\b(?:to\s+my\s+email|to\s+me|me|myself|my\s+address)\b/i },
  { name: 'ask_agent', label: 'Ask another agent', desc: 'Delegates work to another agent, usually in the background.', group: 'Agents', re: /\b(?:(?:ask|delegate|have|tell)\b.{0,45}\b(?:agent|assistant|specialist|someone|email|send|mail)|(?:send|email|mail|forward)\b.{0,60}\b(?:to\s+my\s+email|to\s+me|me|myself|my\s+address))\b/i },
  { name: 'request_tools', label: 'Load more tools', desc: 'Lets the model request another tool group mid-turn if the first set is missing something.', group: 'System', re: /\b(?:tool|tools|access|available)\b/i },
  { name: 'web_search', label: 'Search the web', desc: 'Looks up current information on the web.', group: 'Web', re: /\b(?:search|look up|google|latest|news|current|today)\b/i },
  { name: 'fetch_url', label: 'Fetch a web page', desc: 'Reads a specific URL the user supplied.', group: 'Web', re: /https?:\/\/\S+/i },
  { name: 'set_reminder', label: 'Set reminder', desc: 'Creates a reminder.', group: 'Tasks', re: /\b(?:remind me|set a reminder|reminder)\b/i },
  { name: 'schedule_task', label: 'Schedule task', desc: 'Creates a scheduled or repeating task/watch.', group: 'Tasks', re: /\b(?:schedule|every day|every week|watch|monitor|check .* later)\b/i },
  { name: 'list_watches', label: 'List watches', desc: 'Shows active watches/monitors.', group: 'Tasks', re: /\b(?:list|show|what)\b.{0,35}\b(?:watches|monitors|scheduled)\b/i },
  { name: 'cancel_watch', label: 'Cancel watch', desc: 'Cancels an active watch/monitor.', group: 'Tasks', re: /\b(?:cancel|stop|delete)\b.{0,35}\b(?:watch|monitor)\b/i },
  { name: 'remember_fact', label: 'Remember fact', desc: 'Stores a durable user memory/fact.', group: 'Memory', re: /\b(?:remember|save this|keep in mind)\b/i },
  { name: 'recall_facts', label: 'Recall memory', desc: 'Searches stored memories/facts.', group: 'Memory', re: /\b(?:what do you remember|recall|memory|memories)\b/i },
  { name: 'forget_fact', label: 'Forget memory', desc: 'Removes a stored memory/fact.', group: 'Memory', re: /\b(?:forget|delete memory|remove memory)\b/i },
];

// ask_agent is a mode-gated control-plane capability, not an ordinary tool.
// Keep every picker path (suggestions, add menu, remembered recipes, manual
// exact-name entry, and the final send payload) aligned with the stored
// orchestration setting. Never infer this from `agents.length`: a one-agent
// ensemble still has ask_agent, while single mode does not.
function toolPlanToolAvailable(name, policy = (typeof _currentUser !== 'undefined' ? _currentUser?.orchestration : null)) {
  return name !== 'ask_agent' || policy?.mode !== 'single';
}

function availableToolPlanCatalog(policy = (typeof _currentUser !== 'undefined' ? _currentUser?.orchestration : null)) {
  return TOOL_PLAN_CATALOG.filter(tool => toolPlanToolAvailable(tool.name, policy));
}

function availableToolPlanNames(toolNames, policy = (typeof _currentUser !== 'undefined' ? _currentUser?.orchestration : null)) {
  const candidates = toolNames != null
    && typeof toolNames !== 'string'
    && typeof toolNames[Symbol.iterator] === 'function'
    ? Array.from(toolNames)
    : [];
  return [...new Set(candidates.filter(name => typeof name === 'string' && name && toolPlanToolAvailable(name, policy)))];
}

let toolPlanState = {
  mode: 'auto',
  expanded: false,
  selected: new Set(),
  suggestions: [],
  recipe: null,
  remember: false,
  dirty: false,
};

function normalizeToolPhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[^\w@.]+/g, ' ')
    .replace(/\b\d+\b/g, ' number ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toolPhraseTokens(text) {
  const stop = new Set(['the', 'a', 'an', 'to', 'for', 'my', 'me', 'i', 'you', 'and', 'or', 'that', 'this', 'it', 'please']);
  return normalizeToolPhrase(text).split(' ').filter(t => t.length > 1 && !stop.has(t));
}

function tokenScore(a, b) {
  const at = new Set(toolPhraseTokens(a));
  const bt = new Set(toolPhraseTokens(b));
  if (!at.size || !bt.size) return 0;
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap++;
  return overlap / Math.max(at.size, bt.size);
}

// Parsed once and reused — matchToolRecipe runs on every picker render
// (every composer keystroke) and used to JSON.parse the whole store each
// time. Invalidated on save and on cross-tab storage events.
let _toolRecipesCache = null;
window.addEventListener('storage', (e) => {
  if (e.key === TOOL_PLAN_STORAGE_KEY) _toolRecipesCache = null;
});
function loadToolRecipes() {
  if (_toolRecipesCache) return _toolRecipesCache;
  try {
    const parsed = JSON.parse(localStorage.getItem(TOOL_PLAN_STORAGE_KEY) || '[]');
    return (_toolRecipesCache = Array.isArray(parsed) ? parsed : []);
  } catch { return (_toolRecipesCache = []); }
}

function saveToolRecipes(recipes) {
  _toolRecipesCache = null;
  try { localStorage.setItem(TOOL_PLAN_STORAGE_KEY, JSON.stringify(recipes.slice(0, TOOL_PLAN_MAX_RECIPES))); } catch {}
}

function matchToolRecipe(text, agentId = activeAgent) {
  let best = null;
  for (const r of loadToolRecipes()) {
    if (r.agentId && r.agentId !== agentId) continue;
    const examples = Array.isArray(r.examples) ? r.examples : [];
    for (const ex of examples) {
      const score = tokenScore(text, ex);
      if (score >= TOOL_PLAN_MIN_SCORE && (!best || score > best.score)) best = { ...r, score };
    }
  }
  return best;
}

function rememberToolRecipe(text, selectedTools, mode = 'selected', agentId = activeAgent) {
  const cleanTools = availableToolPlanNames(selectedTools);
  if (!text?.trim()) return;
  if (mode === 'selected' && !cleanTools.length) return;
  const norm = normalizeToolPhrase(text);
  const recipes = loadToolRecipes();
  const targetAgentId = agentId || activeAgent;
  const existing = recipes.find(r => r.agentId === targetAgentId && (r.examples || []).some(ex => tokenScore(ex, norm) >= 0.8));
  const entry = existing || {
    id: `tool_recipe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    agentId: targetAgentId,
    examples: [],
    createdAt: Date.now(),
  };
  entry.examples = [text.trim(), ...(entry.examples || []).filter(ex => normalizeToolPhrase(ex) !== norm)].slice(0, 6);
  entry.mode = mode;
  entry.selectedTools = cleanTools;
  entry.updatedAt = Date.now();
  if (!existing) recipes.unshift(entry);
  saveToolRecipes(recipes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'tool_plan_remember',
        agentId: targetAgentId,
        phrase: text.trim(),
        selectedTools: cleanTools,
        mode,
        source: 'chat-ui',
      }));
    }
  } catch {}
}

function toolCatalogEntry(name) {
  return TOOL_PLAN_CATALOG.find(t => t.name === name) || {
    name,
    label: toolDisplayLabel(name, {}),
    desc: 'Tool used by this agent.',
    group: 'Other',
  };
}

function renderToolPlanAddOptions(excludedNames = new Set()) {
  const groups = new Map();
  for (const item of availableToolPlanCatalog()) {
    if (excludedNames.has(item.name)) continue;
    const group = item.group || 'Other';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  const html = ['<option value="">Add tool...</option>'];
  for (const [group, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    html.push(`<optgroup label="${escHtml(group)}">`);
    for (const item of items.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name))) {
      html.push(`<option value="${escHtml(item.name)}">${escHtml(item.label || item.name)} (${escHtml(item.name)})</option>`);
    }
    html.push('</optgroup>');
  }
  return html.join('');
}

function detectToolSuggestions(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('@')) return { suggestions: [], recipe: null };
  const recipe = matchToolRecipe(trimmed);
  const hits = [];
  for (const item of availableToolPlanCatalog()) {
    if (item.re?.test(trimmed)) hits.push({ ...item, source: 'suggested' });
  }
  if (/^\s*(?:ok|yes|do it|delete them|trash them|move them|label them)\s*$/i.test(trimmed)) {
    hits.push({ ...toolCatalogEntry('email_batch_trash'), source: 'context' });
    hits.push({ ...toolCatalogEntry('email_batch_label'), source: 'context' });
  }
  if (recipe?.selectedTools?.length) {
    for (const name of availableToolPlanNames(recipe.selectedTools)) {
      if (!hits.some(h => h.name === name)) hits.unshift({ ...toolCatalogEntry(name), source: 'remembered' });
    }
  }
  const byName = new Map();
  for (const h of hits) byName.set(h.name, h);
  return { suggestions: [...byName.values()].slice(0, 8), recipe };
}

function renderToolPlanPicker() {
  const el = $('toolPlanPicker');
  if (!el) return;
  const text = $('input')?.value?.trim() || '';
  const availableSelected = availableToolPlanNames(toolPlanState.selected);
  if (availableSelected.length !== toolPlanState.selected.size) {
    toolPlanState.selected = new Set(availableSelected);
    if (toolPlanState.mode === 'selected' && !toolPlanState.selected.size) toolPlanState.mode = 'auto';
  }
  const shouldShow = !!text && !text.startsWith('/') && !text.startsWith('@');
  if (!shouldShow) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const { suggestions, recipe } = detectToolSuggestions(text);
  if (!toolPlanState.dirty || toolPlanState._text !== text) {
    const textChanged = toolPlanState._text !== text;
    toolPlanState._text = text;
    toolPlanState.suggestions = suggestions;
    toolPlanState.recipe = recipe;
    toolPlanState.remember = false;
    if (textChanged) toolPlanState.dirty = false;
    // RESTORED DEFAULT: do NOT auto-pin tools. OE gets the full toolset and the
    // agent picks the right one — the way it worked before per-turn tool plans.
    // Auto-selecting from a saved recipe or keyword suggestion was sending a hard
    // tool constraint with every message, which stripped specialists of the tools
    // they actually needed (e.g. a research agent left without research tools) and
    // forced them to escalate via ask_agent. Suggestions and any saved recipe are
    // still shown below so the user can opt in MANUALLY, but nothing is
    // pre-selected; a manual pick sets dirty=true and is preserved as before.
    toolPlanState.mode = 'auto';
    toolPlanState.selected = new Set();
  }
  const selectedCount = toolPlanState.mode === 'selected' ? toolPlanState.selected.size : 0;
  const summary = toolPlanState.mode === 'none'
    ? 'No tools'
    : toolPlanState.mode === 'selected'
      ? `${selectedCount} selected`
      : 'OE decides';
  const source = recipe ? 'remembered' : suggestions.length ? 'suggested' : 'manual';
  const allVisible = [...suggestions];
  for (const name of toolPlanState.selected) {
    if (!allVisible.some(t => t.name === name)) allVisible.push(toolCatalogEntry(name));
  }
  const visibleNames = new Set(allVisible.map(t => t.name));
  el.style.display = 'block';
  el.innerHTML = `
    <div class="tool-plan-head">
      <button class="tool-plan-toggle" type="button" aria-expanded="${toolPlanState.expanded ? 'true' : 'false'}">
        ${icon('wrench', 14)}
        <span>Tools</span>
        <strong>${escHtml(summary)}</strong>
        <em>${escHtml(source)}</em>
        ${icon('chevron-down', 13)}
      </button>
      <div class="tool-plan-modes" role="group" aria-label="Tool mode">
        <button type="button" class="${toolPlanState.mode === 'selected' ? 'active' : ''}" data-tool-plan-mode="selected">Selected</button>
        <button type="button" class="${toolPlanState.mode === 'auto' ? 'active' : ''}" data-tool-plan-mode="auto">OE decides</button>
        <button type="button" class="${toolPlanState.mode === 'none' ? 'active' : ''}" data-tool-plan-mode="none">None</button>
      </div>
    </div>
    <div class="tool-plan-body" ${toolPlanState.expanded ? '' : 'hidden'}>
      ${allVisible.length ? allVisible.map(t => {
        const checked = toolPlanState.selected.has(t.name) ? 'checked' : '';
        return `<label class="tool-plan-row">
          <input type="checkbox" data-tool-plan-tool="${escHtml(t.name)}" ${checked}>
          <span class="tool-plan-row-main">
            <span class="tool-plan-row-label">${escHtml(t.label || t.name)}</span>
            <span class="tool-plan-row-desc">${escHtml(t.desc || '')}</span>
          </span>
          <code>${escHtml(t.name)}</code>
        </label>`;
      }).join('') : `<div class="tool-plan-empty">No obvious tools matched. Choose “OE decides” or type a clearer action.</div>`}
      <div class="tool-plan-add">
        <select id="toolPlanAddSelect" aria-label="Add a known tool">
          ${renderToolPlanAddOptions(visibleNames)}
        </select>
        <input id="toolPlanAddName" type="text" inputmode="text" autocomplete="off" placeholder="Exact tool name">
        <button type="button" data-tool-plan-add title="Add tool">${icon('plus', 13)}<span>Add</span></button>
      </div>
      <label class="tool-plan-remember">
        <input type="checkbox" id="toolPlanRemember" ${toolPlanState.remember ? 'checked' : ''}>
        <span>Remember this tool choice for similar wording</span>
      </label>
    </div>`;
  el.querySelector('.tool-plan-toggle')?.addEventListener('click', () => {
    toolPlanState.expanded = !toolPlanState.expanded;
    renderToolPlanPicker();
  });
  el.querySelectorAll('[data-tool-plan-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      toolPlanState.mode = btn.dataset.toolPlanMode;
      toolPlanState.dirty = true;
      if (toolPlanState.mode === 'selected' && !toolPlanState.selected.size && toolPlanState.suggestions.length) {
        toolPlanState.selected = new Set(toolPlanState.suggestions.map(s => s.name));
      }
      renderToolPlanPicker();
    });
  });
  el.querySelectorAll('[data-tool-plan-tool]').forEach(input => {
    input.addEventListener('change', () => {
      const name = input.dataset.toolPlanTool;
      if (input.checked) toolPlanState.selected.add(name);
      else toolPlanState.selected.delete(name);
      toolPlanState.mode = toolPlanState.selected.size ? 'selected' : 'auto';
      toolPlanState.dirty = true;
      renderToolPlanPicker();
    });
  });
  const addTool = () => {
    const select = el.querySelector('#toolPlanAddSelect');
    const input = el.querySelector('#toolPlanAddName');
    const raw = (input?.value || select?.value || '').trim();
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(raw) || !toolPlanToolAvailable(raw)) {
      input?.focus();
      return;
    }
    toolPlanState.selected.add(raw);
    toolPlanState.mode = 'selected';
    toolPlanState.expanded = true;
    toolPlanState.dirty = true;
    renderToolPlanPicker();
  };
  el.querySelector('[data-tool-plan-add]')?.addEventListener('click', addTool);
  el.querySelector('#toolPlanAddSelect')?.addEventListener('change', (e) => {
    const input = el.querySelector('#toolPlanAddName');
    if (input) input.value = e.target.value || '';
  });
  el.querySelector('#toolPlanAddName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTool();
    }
  });
  el.querySelector('#toolPlanRemember')?.addEventListener('change', (e) => {
    toolPlanState.remember = e.target.checked;
    toolPlanState.dirty = true;
  });
}

function selectedToolPlanForSend(text) {
  if (!text?.trim()) return null;
  const selectedTools = availableToolPlanNames(toolPlanState.selected);
  if (toolPlanState.remember && (toolPlanState.mode === 'none' || selectedTools.length)) {
    rememberToolRecipe(text, selectedTools, toolPlanState.mode);
  }
  if (toolPlanState.mode === 'none') return { mode: 'none', source: 'user', phrase: text.slice(0, 240), selectedTools: [] };
  if (toolPlanState.mode === 'selected' && selectedTools.length) {
    return { mode: 'selected', source: toolPlanState.recipe ? 'remembered' : 'user', phrase: text.slice(0, 240), selectedTools };
  }
  return null;
}

function resetToolPlanPicker() {
  toolPlanState = { mode: 'auto', expanded: false, selected: new Set(), suggestions: [], recipe: null, remember: false, dirty: false };
  renderToolPlanPicker();
}

// Mirrors MAX_UPLOAD in routes/expenses.mjs's /api/chat-upload handler — a
// client-side pre-check so an oversized file fails instantly with a clear
// message instead of uploading for a while first. Never raise this without
// also raising the server-side cap (see feedback_upload_caps_4_places).
const CHAT_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

function clearAttachment() {
  pendingAttachments = [];
  $('chatFileInput').value = '';
  renderAttachmentTray();
}

function removeAttachmentAt(localKey) {
  pendingAttachments = pendingAttachments.filter(a => a._localKey !== localKey);
  if (!pendingAttachments.length) $('chatFileInput').value = '';
  renderAttachmentTray();
}

function formatAttachmentSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderAttachmentTray() {
  const p = $('attachPreview');
  if (!pendingAttachments.length) {
    p.style.display = 'none';
    p.innerHTML = '';
    return;
  }
  p.style.display = 'flex';
  p.style.flexWrap = 'wrap';
  p.style.gap = '6px';
  p.innerHTML = '';
  // Every tray item goes out together on the next send (see send()) — no
  // "only the first" caveat anymore, so every row renders identically.
  pendingAttachments.forEach((a) => {
    const row = document.createElement('span');
    row.className = 'attach-preview-item';
    row.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);font-size:12px;max-width:220px';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'attach-preview-name';
    nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px';
    if (a._uploading) {
      row.innerHTML = '<span style="font-size:14px">⏳</span>';
      nameSpan.textContent = a.name || 'uploading…';
    } else {
      const thumbWrap = document.createElement('span');
      thumbWrap.innerHTML = a.isImage && a.base64
        ? `<img src="data:${a.mimeType};base64,${a.base64}" alt="" style="width:18px;height:18px;object-fit:cover;border-radius:3px;vertical-align:middle">`
        : `<span style="font-size:14px">${a.mimeType?.includes('pdf') ? icon('file-text', 14) : icon('paperclip', 14)}</span>`;
      row.appendChild(thumbWrap);
      nameSpan.textContent = a.name;
    }
    row.appendChild(nameSpan);
    const sizeLabel = formatAttachmentSize(a.size);
    if (sizeLabel && !a._uploading) {
      const sizeSpan = document.createElement('span');
      sizeSpan.style.cssText = 'color:var(--muted)';
      sizeSpan.textContent = sizeLabel;
      row.appendChild(sizeSpan);
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'attach-preview-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeAttachmentAt(a._localKey));
    row.appendChild(removeBtn);
    p.appendChild(row);
  });
}

let _attachmentUploadSeq = 0;

// Upload one file and add it to the tray. Called once per file — see the
// #chatFileInput 'change' listener below and init.js's paste/drag-drop call
// sites (handleChatFileSelect stays a thin wrapper for compatibility with
// those existing single-file callers).
async function _uploadAndAddAttachment(file) {
  if (!file) return;
  // Count cap, not a size cap — per-file size limits are unchanged (see
  // CHAT_UPLOAD_MAX_BYTES below). Checked at add-time so the tray never grows
  // past the limit in the first place, rather than truncating silently at
  // send() — a friendly toast here is only guaranteed to be seen once, unlike
  // a note baked into a follow-up send.
  if (pendingAttachments.length >= MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
    showToast(`You can attach up to ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} files per message.`);
    return;
  }
  if (file.size > CHAT_UPLOAD_MAX_BYTES) {
    alert(`"${file.name}" is too large — limit is ${CHAT_UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
    return;
  }
  const localKey = `att_${Date.now()}_${_attachmentUploadSeq++}`;
  pendingAttachments.push({ _localKey: localKey, _uploading: true, name: file.name, size: file.size });
  renderAttachmentTray();
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/chat-upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const idx = pendingAttachments.findIndex(a => a._localKey === localKey);
    if (idx === -1) return; // removed from the tray while the upload was in flight
    pendingAttachments[idx] = { ...data, _localKey: localKey, size: file.size };
    renderAttachmentTray();
  } catch (e) {
    pendingAttachments = pendingAttachments.filter(a => a._localKey !== localKey);
    renderAttachmentTray();
    alert('Upload failed: ' + e.message);
  }
}

async function handleChatFileSelect(file) {
  await _uploadAndAddAttachment(file);
}

// #chatFileInput's 'change' listener (init.js) calls handleChatFileSelect
// with just `files[0]` for backward compatibility with its existing
// single-file call signature. index.html now sets `multiple` on that input,
// so a picker action can select several files at once — this second
// listener picks up files[1..] so every selection gets uploaded, not just
// the first. Index-disjoint with init.js's call (0 vs 1+), so registration
// order between the two listeners doesn't matter.
(function _initMultiFileAttach() {
  const attach = () => {
    const input = $('chatFileInput');
    if (!input) return;
    input.addEventListener('change', (e) => {
      const files = e.target.files;
      for (let i = 1; i < files.length; i++) _uploadAndAddAttachment(files[i]);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();

// send() lives in public/chat-send.js (loaded before this file).

// Render, scroll, credentials: public/chat-render.js (loaded before this file).
// Slash / @ menus: public/chat-menus.js (loaded before this file).
