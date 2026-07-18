// Tool display labels / live tool events — extracted from chat-render.js.
// Globals intentional.

function formatToolDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  const sec = n / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return rem ? `${min}m ${rem}s` : `${min}m`;
}
// Resolve an agent id (or an already-a-name string) to its human display name,
// so delegation pills read "Asking Coordinator" instead of "ask_agent → agent_2df…".
function friendlyAgentName(idOrName) {
  if (!idOrName) return 'agent';
  const needle = String(idOrName).toLowerCase();
  const list = (typeof agents !== 'undefined' && Array.isArray(agents)) ? agents : [];
  const a = list.find(x => x.id === idOrName
    || x.name?.toLowerCase() === needle
    || x.role?.toLowerCase() === needle);
  if (a?.name) return a.name;
  if (needle === 'coordinator') return 'Coordinator';
  return String(idOrName);
}

// Human-readable label for a tool pill. Most tools just show their raw name; the
// jargon-y delegation tools get a plain-language label so the user can tell what
// is happening without reading internal code names.
function toolDisplayLabel(name, args) {
  if (name === 'ask_agent' && args?.agent_id) return `Asking ${friendlyAgentName(args.agent_id)}`;
  if (name === 'waiting_for_agent')           return `Waiting for ${friendlyAgentName(args?.agent)}`;
  if (name === 'request_tools')               return 'Loading tools';
  // Email tools get plain-language labels so a long sort reads as a running
  // narration ("Auto-sorting inbox", "Labeling email → Promotions · 12") instead
  // of a row of identical "email_batch_label" pills.
  if (name === 'email_sort_local')     return 'Auto-sorting inbox';
  if (name === 'email_batch_label')    return 'Labeling email';
  if (name === 'email_list')           return 'Reading inbox';
  if (name === 'email_list_labels')    return 'Reading labels';
  if (name === 'email_learned_labels') return 'Checking learned labels';
  if (name === 'email_correct_label')  return 'Saving label rule';
  if (name === 'email_remove_label_correction') return 'Removing label rule';
  return name;
}

function toolGroupLabel(name) {
  if (!name) return 'Tools';
  if (name.startsWith('email_')) return 'Email';
  if (name.startsWith('node_')) return 'Node';
  if (name.startsWith('ha_')) return 'Home';
  if (name.startsWith('task_') || name === 'set_reminder' || name === 'schedule_task') return 'Tasks';
  if (name === 'ask_agent' || name === 'waiting_for_agent') return 'Delegation';
  if (name === 'web_search' || name === 'fetch_url') return 'Web';
  return 'Tools';
}

function toolUiHidden(name) {
  return name === 'request_tools';
}

// Pull the most informative arg for a tool into a one-line subtitle.
// Returns '' if nothing useful is available — the pill stays as just the name.
function toolPillSubtitle(name, args) {
  if (!args || typeof args !== 'object') return '';
  // Delegation: the label already names the target agent, so the subtitle carries
  // the actual task being handed off — this is the "what is she doing?" the user
  // was missing when an ask_agent call just showed "ask_agent → coordinator".
  if (name === 'ask_agent') {
    return typeof args.task === 'string' ? args.task : '';
  }
  // Email tools — narrate the actual work so a multi-call sort shows progress.
  if (name === 'email_batch_label') {
    const add = Array.isArray(args.addLabels) ? args.addLabels.join(', ') : '';
    const n   = Array.isArray(args.messageIds) ? args.messageIds.length : 0;
    const arch = Array.isArray(args.removeLabels) && args.removeLabels.includes('INBOX') ? ' · archived' : '';
    return `${add ? '→ ' + add : ''}${n ? ` · ${n} email${n === 1 ? '' : 's'}` : ''}${arch}`.trim();
  }
  if (name === 'email_sort_local') {
    return `latest ${args.maxResults || 50}${args.apply === false ? ' (preview)' : ''}${args.archive === false ? ' · keep in inbox' : ''}`;
  }
  if (name === 'email_correct_label' && args.sender) {
    const labels = Array.isArray(args.labels) ? args.labels.join('+') : (args.label || '');
    return `${args.sender} → ${labels}`;
  }
  if (name === 'email_remove_label_correction' && args.sender) return args.sender;
  if (name === 'email_list' && typeof args.query === 'string' && args.query) return args.query;
  if (name === 'node_exec' && typeof args.command === 'string') return args.command;
  if (name === 'node_push_project' && typeof args.dest_path === 'string') {
    return `${args.node_id || ''} → ${args.dest_path}`.trim();
  }
  if (name === 'node_start_service' && typeof args.command === 'string') {
    const cwd = args.cwd ? `(${args.cwd}) ` : '';
    return `${cwd}${args.command}`;
  }
  if (name === 'node_stop_service') return `pid ${args.pid} on ${args.node_id || ''}`.trim();
  if (name === 'node_status' || name === 'node_list') return args.node_id || '';
  if (name === 'request_tools') return args.reason || '';
  return '';
}

let liveToolRun = null;

function resetToolRun(removeRun = false) {
  if (toolStreamBubbleEl) {
    try { toolStreamBubbleEl.remove(); } catch {}
  }
  if (removeRun && liveToolRun?.el) {
    try { liveToolRun.el.remove(); } catch {}
  }
  toolPillsEl = null;
  toolStreamBubbleEl = null;
  toolStreamBubbleTool = null;
  liveToolRun = null;
}

function scrubToolArgsForSession(value) {
  if (Array.isArray(value)) return value.map(scrubToolArgsForSession);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|password|api[_-]?key|authorization|credential/i.test(k)) out[k] = '[redacted]';
    else out[k] = scrubToolArgsForSession(v);
  }
  return out;
}

function currentLiveToolEvents() {
  return liveToolRun?.events?.map(ev => ({
    name: ev.name,
    args: ev.args ? scrubToolArgsForSession(ev.args) : null,
    startedAt: ev.startedAt,
    endedAt: ev.endedAt ?? null,
    durationMs: ev.durationMs ?? (ev.endedAt && ev.startedAt ? ev.endedAt - ev.startedAt : null),
    status: ev.status || 'running',
    preview: ev.preview || '',
    text: ev.text ? String(ev.text).slice(0, 10000) : '',
    progressPreview: ev.progressPreview || '',
  })) ?? [];
}

// Tool-run UI lives in public/chat-tool-run.js (loaded before this file).

