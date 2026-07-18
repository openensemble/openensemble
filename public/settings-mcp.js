// Extracted from settings.js — pure move. Globals intentional.
// Section loaded via index.html before/after settings core as needed.

// ── MCP Servers panel ─────────────────────────────────────────────────────────
// Lists user's MCP servers with live status, lets the user add/remove and
// assign to agents. Mutations require non-child role (server enforces too).
async function loadMcpServers() {
  const body = $('mcpServersBody');
  if (!body) return;
  try {
    const r = await fetch('/api/mcp/servers').then(r => r.json());
    renderMcpServers(r.servers ?? []);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Failed to load MCP servers: ${escHtml(e.message)}</div>`;
  }
}

function renderMcpServers(servers) {
  const body = $('mcpServersBody');
  if (!body) return;
  const statusBadge = (s) => {
    const colorMap = {
      ready:      'var(--green, #4caf50)',
      connecting: 'var(--accent)',
      idle:       'var(--muted)',
      unknown:    'var(--muted)',
      error:      'var(--red, #e05c5c)',
    };
    const labelMap = {
      ready:      '✓ ready',
      connecting: '… connecting',
      idle:       'idle',
      unknown:    'not connected',
      error:      '⚠ error',
    };
    const color = colorMap[s.status] ?? 'var(--muted)';
    const label = labelMap[s.status] ?? s.status;
    return `<span style="font-size:11px;color:${color};font-weight:600">${escHtml(label)}</span>`;
  };
  // `agents` is declared in core.js (let-scoped, module-level), reachable
  // directly here without a window. prefix.
  const agentList = (typeof agents !== 'undefined' && Array.isArray(agents) ? agents : []).filter(a => a.id);

  const listHtml = servers.length === 0
    ? `<div style="font-size:12px;color:var(--muted);padding:10px 0">No MCP servers registered. Browse the catalog or add one manually below.</div>`
    : `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${servers.map(s => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap">
            <div style="font-size:13px;font-weight:600">${escHtml(s.displayName ?? s.id)}</div>
            <div style="display:flex;gap:6px;align-items:center">${statusBadge(s)}
              <button data-action="openMcpEditDialog" data-args='${escHtml(JSON.stringify([s.id]))}' title="Edit this server's command/url" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer">Edit</button>
              ${s.status !== 'connecting' ? `<button data-action="reconnectMcpServer" data-args='${escHtml(JSON.stringify([s.id]))}' title="Disconnect and respawn this server" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer">Reconnect</button>` : ''}
              <button data-action="removeMcpServer" data-args='${escHtml(JSON.stringify([s.id]))}' style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer">Remove</button>
            </div>
          </div>
          ${s.transport === 'http'
            ? `<div style="font-size:11px;color:var(--muted);font-family:'Fira Code',monospace;word-break:break-all">${escHtml(s.url ?? '')}</div>${s.auth === 'oauth' ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">Auth: OAuth ${s.oauthScope ? `(scope: ${escHtml(s.oauthScope)})` : ''}</div>` : ''}`
            : `<div style="font-size:11px;color:var(--muted);font-family:'Fira Code',monospace;word-break:break-all">${escHtml(s.command ?? '')} ${escHtml((s.args ?? []).join(' '))}</div>`}
          ${s.transport === 'http' && s.auth === 'oauth' ? `
          <div style="margin-top:6px">
            <button data-action="authorizeMcpOAuth" data-args='${escHtml(JSON.stringify([s.id]))}' style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:4px 12px;font-size:11px;cursor:pointer;font-weight:600">${s.status === 'error' ? 'Re-authorize' : 'Authorize'}</button>
          </div>` : ''}
          ${s.toolCount != null ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">${s.toolCount} tools exposed</div>` : ''}
          ${s.lastError ? `<div style="font-size:11px;color:var(--red,#e05c5c);margin-top:4px">Last error: ${escHtml(s.lastError)}</div>` : ''}
          <div style="font-size:11px;color:var(--muted);margin-top:6px">Assigned to:
            ${(s.assignedToAgents ?? []).length === 0
              ? '<span style="opacity:0.6">none</span>'
              : (s.assignedToAgents ?? []).map(aid => `<span style="margin-left:4px;padding:1px 6px;background:var(--bg3);border-radius:4px">${escHtml(aid)} <button data-action="unassignMcpServer" data-args='${escHtml(JSON.stringify([s.id, aid]))}' title="Remove" style="background:none;border:none;color:var(--muted);cursor:pointer">×</button></span>`).join('')}
          </div>
          <div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <select id="mcpAssignSelect-${escHtml(s.id)}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:2px 6px;font-size:11px">
              <option value="">+ assign agent…</option>
              ${agentList.filter(a => !(s.assignedToAgents ?? []).includes(a.id)).map(a => `<option value="${escHtml(a.id)}">${escHtml(a.name ?? a.id)}</option>`).join('')}
            </select>
            <button data-action="assignMcpServer" data-args='${escHtml(JSON.stringify([s.id]))}' style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:600">Assign</button>
          </div>
        </div>
      `).join('')}</div>`;

  const formHtml = `
    <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
      <button data-action="openMcpCatalog" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600">Browse catalog</button>
      <button data-action="refreshMcpServers" title="Reconnect to every server (use after fixing a config or starting a server that was offline)" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer">Reconnect all</button>
      <span style="font-size:11px;color:var(--muted)">or add manually:</span>
    </div>
    <details style="border:1px dashed var(--border);border-radius:8px;padding:10px">
      <summary style="cursor:pointer;font-size:12px;font-weight:600">+ Add a server manually</summary>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
        <label style="font-size:11px;color:var(--muted)">Server id (alphanumeric + hyphen, no underscores)</label>
        <input id="mcpAddId" placeholder="github" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">Transport</label>
        <select id="mcpAddTransport" data-change-action="onMcpTransportChange" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <option value="stdio">stdio (local subprocess)</option>
          <option value="http">http (remote server)</option>
        </select>
        <div id="mcpStdioFields" style="display:flex;flex-direction:column;gap:6px">
          <label style="font-size:11px;color:var(--muted)">Command</label>
          <input id="mcpAddCommand" placeholder="npx" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <label style="font-size:11px;color:var(--muted)">Args (one per line)</label>
          <textarea id="mcpAddArgs" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-github" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;font-family:'Fira Code',monospace"></textarea>
          <label style="font-size:11px;color:var(--muted)">Environment variables (KEY=value, one per line — encrypted on disk)</label>
          <textarea id="mcpAddEnv" rows="3" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..." style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;font-family:'Fira Code',monospace"></textarea>
        </div>
        <div id="mcpHttpFields" style="display:none;flex-direction:column;gap:6px">
          <label style="font-size:11px;color:var(--muted)">URL</label>
          <input id="mcpAddUrl" placeholder="https://mcp.example.com/sse" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <label style="font-size:11px;color:var(--muted)">Authentication</label>
          <select id="mcpAddAuth" data-change-action="onMcpAuthChange" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
            <option value="headers">Static headers (PAT, API key)</option>
            <option value="oauth">OAuth (server runs the flow)</option>
          </select>
          <div id="mcpAuthHeadersFields" style="display:flex;flex-direction:column;gap:6px">
            <label style="font-size:11px;color:var(--muted)">Headers (HeaderName: value, one per line — encrypted on disk)</label>
            <textarea id="mcpAddHeaders" rows="3" placeholder="Authorization: Bearer xxx" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;font-family:'Fira Code',monospace"></textarea>
          </div>
          <div id="mcpAuthOauthFields" style="display:none;flex-direction:column;gap:6px">
            <label style="font-size:11px;color:var(--muted)">OAuth scope (optional — leave blank to use the server's default)</label>
            <input id="mcpAddOauthScope" placeholder="e.g. read write" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
            <div style="font-size:10px;color:var(--muted);line-height:1.4">After you save, an <strong>Authorize</strong> button appears on the server card. Click it to open the provider's consent screen in a new tab; tokens are stored encrypted under your account.</div>
          </div>
        </div>
        <button data-action="addMcpServer" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600;margin-top:6px;align-self:flex-start">Add server</button>
        <div id="mcpAddStatus" style="font-size:11px;color:var(--muted);min-height:14px"></div>
      </div>
    </details>`;
  body.innerHTML = listHtml + formHtml;
}

function onMcpTransportChange() {
  const t = $('mcpAddTransport')?.value ?? 'stdio';
  const stdioFields = $('mcpStdioFields');
  const httpFields = $('mcpHttpFields');
  if (stdioFields) stdioFields.style.display = t === 'stdio' ? 'flex' : 'none';
  if (httpFields)  httpFields.style.display  = t === 'http'  ? 'flex' : 'none';
}

function onMcpAuthChange() {
  const a = $('mcpAddAuth')?.value ?? 'headers';
  const hdr = $('mcpAuthHeadersFields');
  const oa  = $('mcpAuthOauthFields');
  if (hdr) hdr.style.display = a === 'headers' ? 'flex' : 'none';
  if (oa)  oa.style.display  = a === 'oauth'   ? 'flex' : 'none';
}

async function addMcpServer() {
  const id = $('mcpAddId')?.value.trim();
  const transport = $('mcpAddTransport')?.value ?? 'stdio';
  const status = $('mcpAddStatus');
  if (!id) {
    if (status) status.textContent = 'id is required.';
    return;
  }
  const body = { id, transport };
  if (transport === 'stdio') {
    const command = $('mcpAddCommand')?.value.trim();
    if (!command) { if (status) status.textContent = 'command is required for stdio.'; return; }
    body.command = command;
    body.args = ($('mcpAddArgs')?.value ?? '').split('\n').map(s => s.trim()).filter(Boolean);
    const envObj = {};
    for (const line of ($('mcpAddEnv')?.value ?? '').split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1);
      if (k) envObj[k] = v;
    }
    body.env = envObj;
  } else if (transport === 'http') {
    const url = $('mcpAddUrl')?.value.trim();
    if (!url) { if (status) status.textContent = 'url is required for http.'; return; }
    body.url = url;
    const authMode = $('mcpAddAuth')?.value ?? 'headers';
    if (authMode === 'oauth') {
      body.auth = 'oauth';
      const scope = $('mcpAddOauthScope')?.value.trim();
      if (scope) body.oauthScope = scope;
      body.headers = {};
    } else {
      const hdrs = {};
      for (const line of ($('mcpAddHeaders')?.value ?? '').split('\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const k = line.slice(0, colon).trim();
        const v = line.slice(colon + 1).trim();
        if (k) hdrs[k] = v;
      }
      body.headers = hdrs;
    }
  }
  if (status) status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error ?? 'add failed');
    if (status) status.textContent = `Added "${id}". Watching for connection…`;
    setTimeout(loadMcpServers, 800);
    setTimeout(loadMcpServers, 5000);
    setTimeout(loadMcpServers, 20000);
  } catch (e) {
    if (status) status.textContent = `Add failed: ${e.message}`;
  }
}

async function removeMcpServer(id) {
  if (!confirm(`Remove MCP server "${id}"? Its tools will disappear from all assigned agents.`)) return;
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`Remove failed: ${data.error ?? r.status}`);
      return;
    }
    loadMcpServers();
  } catch (e) {
    alert(`Remove failed: ${e.message}`);
  }
}

async function assignMcpServer(serverId) {
  const sel = $(`mcpAssignSelect-${serverId}`);
  const agentId = sel?.value;
  if (!agentId) return;
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`Assign failed: ${data.error ?? r.status}`);
      return;
    }
    loadMcpServers();
  } catch (e) {
    alert(`Assign failed: ${e.message}`);
  }
}

async function authorizeMcpOAuth(serverId) {
  // Start the flow via the server, then open the returned authorization
  // URL in a popup. The callback page will postMessage on success.
  let authUrl;
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/oauth/start`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
    if (data.alreadyAuthorized) { alert('Already authorized — no action needed.'); return; }
    authUrl = data.authUrl;
  } catch (e) {
    alert(`Couldn’t start OAuth: ${e.message}`);
    return;
  }
  const popup = window.open(authUrl, 'mcp-oauth', 'width=560,height=720');
  if (!popup) { alert('Pop-up blocked. Allow popups for this site and try again.'); return; }
  const onMessage = (ev) => {
    if (ev?.data?.type === 'mcp-oauth-done' && ev.data.serverId === serverId) {
      window.removeEventListener('message', onMessage);
      setTimeout(loadMcpServers, 400);
    }
  };
  window.addEventListener('message', onMessage);
  // Safety: poll the panel a few times in case postMessage was blocked.
  setTimeout(loadMcpServers, 3000);
  setTimeout(loadMcpServers, 8000);
}

// ── Outbound MCP access tokens (OE as an MCP server) ─────────────────────────
// The raw token exists only in this response — held here just long enough to
// render the one-time box; cleared next time the list re-renders without it.
let _mcpMintedToken = null;
let _mcpMintedName = null;

async function loadMcpTokens() {
  const body = $('mcpTokensBody');
  if (!body) return;
  try {
    const r = await fetch('/api/mcp/tokens').then(r => r.json());
    if (r.error) throw new Error(r.error);
    renderMcpTokens(r.tokens ?? []);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Failed to load access tokens: ${escHtml(e.message)}</div>`;
  }
}

function renderMcpTokens(tokens) {
  const body = $('mcpTokensBody');
  if (!body) return;
  const agentList = (typeof agents !== 'undefined' && Array.isArray(agents) ? agents : []).filter(a => a.id);
  const scopeLabel = { 'chat': 'chat', 'memory-read': 'memory read', 'memory-write': 'memory write' };
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString() : 'never';

  const mintedHtml = _mcpMintedToken ? `
    <div style="border:1px solid var(--accent);border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;margin-bottom:6px">Token "${escHtml(_mcpMintedName ?? '')}" created — copy it now, it won't be shown again</div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
        <code style="flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:11px;word-break:break-all">${escHtml(_mcpMintedToken)}</code>
        <button data-action="copyMcpMintedToken" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer;font-weight:600">Copy</button>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Claude Code:</div>
      <pre style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:10px;overflow-x:auto;margin:0 0 8px 0">claude mcp add --transport http openensemble ${escHtml(location.origin)}/mcp --header "Authorization: Bearer ${escHtml(_mcpMintedToken)}"</pre>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Claude Desktop / Cursor (mcpServers entry):</div>
      <pre style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:10px;overflow-x:auto;margin:0">${escHtml(JSON.stringify({ openensemble: { type: 'http', url: location.origin + '/mcp', headers: { Authorization: 'Bearer ' + _mcpMintedToken } } }, null, 2))}</pre>
    </div>` : '';

  const listHtml = tokens.length === 0
    ? `<div style="font-size:12px;color:var(--muted);padding:6px 0 10px">No access tokens yet.</div>`
    : `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">${tokens.map(t => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:600">${escHtml(t.name)} <span style="font-size:10px;color:var(--muted);font-family:'Fira Code',monospace">oemcp_${escHtml(t.id)}_…</span></div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">
              ${(t.scopes ?? []).map(s => `<span style="padding:1px 6px;background:var(--bg3);border-radius:4px;margin-right:4px">${escHtml(scopeLabel[s] ?? s)}</span>`).join('')}
              ${(t.scopes ?? []).includes('chat') ? `<span style="padding:1px 6px;background:var(--bg3);border-radius:4px;margin-right:4px">agent tools: read-only${t.toolAllowlist?.length ? ` + ${escHtml(t.toolAllowlist.join(', '))}` : ''}</span>` : ''}
              ${t.agentId ? `<span style="padding:1px 6px;background:var(--bg3);border-radius:4px;margin-right:4px">bound: ${escHtml(t.agentId)}</span>` : ''}
              created ${fmtDate(t.createdAt)} · last used ${fmtDate(t.lastUsedAt)}
            </div>
          </div>
          <button data-action="revokeMcpToken" data-args='${escHtml(JSON.stringify([t.id, t.name]))}' style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer">Revoke</button>
        </div>`).join('')}</div>`;

  const formHtml = `
    <details style="border:1px dashed var(--border);border-radius:8px;padding:10px">
      <summary style="cursor:pointer;font-size:12px;font-weight:600">+ Create an access token</summary>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <label style="font-size:11px;color:var(--muted)">Name (what will use it)</label>
        <input id="mcpTokenName" placeholder="laptop claude code" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">Scopes</label>
        <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" id="mcpTokenScopeChat" checked> Chat — ask your agents (first-party read-only tools by default)</label>
        <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" id="mcpTokenScopeMemRead" checked> Memory read — recall stored facts and past conversations</label>
        <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" id="mcpTokenScopeMemWrite"> Memory write — pin and forget facts</label>
        <label style="font-size:11px;color:var(--muted)">Additional agent tools (optional, exact names separated by commas)</label>
        <input id="mcpTokenToolAllowlist" placeholder="email_list, email_compose" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <div style="font-size:10px;color:var(--muted)">Only add tools this client genuinely needs. Explicit tools may change data or systems without an OE chat confirmation; high-impact tools such as <code>node_exec</code> remain blocked unless named here.</div>
        <label style="font-size:11px;color:var(--muted)">Limit to one agent (optional)</label>
        <select id="mcpTokenAgent" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;max-width:280px">
          <option value="">All my agents</option>
          ${agentList.map(a => `<option value="${escHtml(a.id)}">${escHtml(a.name ?? a.id)}</option>`).join('')}
        </select>
        <button data-action="createMcpToken" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600;align-self:flex-start">Create token</button>
        <div id="mcpTokenCreateStatus" style="font-size:11px;color:var(--muted);min-height:14px"></div>
      </div>
    </details>`;

  body.innerHTML = mintedHtml + listHtml + formHtml;
}

async function createMcpToken() {
  const status = $('mcpTokenCreateStatus');
  const scopes = [];
  if ($('mcpTokenScopeChat')?.checked) scopes.push('chat');
  if ($('mcpTokenScopeMemRead')?.checked) scopes.push('memory-read');
  if ($('mcpTokenScopeMemWrite')?.checked) scopes.push('memory-write');
  if (scopes.length === 0) { if (status) status.textContent = 'Pick at least one scope.'; return; }
  const payload = {
    name: $('mcpTokenName')?.value.trim(),
    scopes,
    agentId: $('mcpTokenAgent')?.value || null,
    toolAllowlist: [...new Set(String($('mcpTokenToolAllowlist')?.value || '')
      .split(/[\s,]+/).map(s => s.trim()).filter(Boolean))],
  };
  if (status) status.textContent = 'Creating…';
  try {
    const r = await fetch('/api/mcp/tokens', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    _mcpMintedToken = r.token;
    _mcpMintedName = r.record?.name ?? payload.name;
    await loadMcpTokens();
  } catch (e) {
    if (status) status.textContent = `Failed: ${e.message}`;
  }
}

function copyMcpMintedToken() {
  if (!_mcpMintedToken) return;
  navigator.clipboard?.writeText(_mcpMintedToken).catch(() => {});
}

async function revokeMcpToken(id, name) {
  if (!confirm(`Revoke access token "${name}"? Any client using it stops working immediately.`)) return;
  // Revoking invalidates the one-time mint box too if it's the same token.
  try {
    const r = await fetch(`/api/mcp/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    if (_mcpMintedToken?.startsWith(`oemcp_${id}_`)) { _mcpMintedToken = null; _mcpMintedName = null; }
    await loadMcpTokens();
  } catch (e) {
    alert(`Failed to revoke: ${e.message}`);
  }
}

async function openMcpEditDialog(serverId) {
  // Pull fresh server data to pre-fill the form. Secrets (env values,
  // header values) come back redacted from the API — don't pre-fill
  // those; the user can remove + re-add the server if they need to
  // rotate them. Editing covers the common cases: "I typo'd the URL"
  // or "let me change the args."
  let cur;
  try {
    const r = await fetch('/api/mcp/servers').then(r => r.json());
    cur = (r.servers ?? []).find(s => s.id === serverId);
    if (!cur) { alert(`Server "${serverId}" not found.`); return; }
  } catch (e) {
    alert(`Couldn't load server: ${e.message}`); return;
  }
  const existing = document.getElementById('mcpEditModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'mcpEditModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  const stdioVis = cur.transport === 'stdio' ? 'flex' : 'none';
  const httpVis  = cur.transport === 'http'  ? 'flex' : 'none';
  const oauthVis = (cur.transport === 'http' && cur.auth === 'oauth') ? 'flex' : 'none';
  const headersVis = (cur.transport === 'http' && cur.auth !== 'oauth') ? 'flex' : 'none';
  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:500px;width:100%;max-height:80vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0;font-size:14px">Edit "${escHtml(serverId)}"</h3>
        <button data-action="closeMcpEditModal" style="background:transparent;border:none;color:var(--muted);font-size:18px;cursor:pointer">×</button>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">Secrets (env vars, auth headers, OAuth tokens) keep their current values automatically — only the fields you fill in get updated. To rotate a secret, remove and re-add the server.</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <label style="font-size:11px;color:var(--muted)">Display name</label>
        <input id="mcpEditDisplayName" value="${escHtml(cur.displayName ?? '')}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">Transport</label>
        <select id="mcpEditTransport" data-change-action="onMcpEditTransportChange" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <option value="stdio" ${cur.transport === 'stdio' ? 'selected' : ''}>stdio (local subprocess)</option>
          <option value="http" ${cur.transport === 'http' ? 'selected' : ''}>http (remote server)</option>
        </select>
        <div id="mcpEditStdioFields" style="display:${stdioVis};flex-direction:column;gap:6px">
          <label style="font-size:11px;color:var(--muted)">Command</label>
          <input id="mcpEditCommand" value="${escHtml(cur.command ?? '')}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <label style="font-size:11px;color:var(--muted)">Args (one per line)</label>
          <textarea id="mcpEditArgs" rows="3" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;font-family:'Fira Code',monospace">${escHtml((cur.args ?? []).join('\n'))}</textarea>
        </div>
        <div id="mcpEditHttpFields" style="display:${cur.transport === 'http' ? 'flex' : 'none'};flex-direction:column;gap:6px">
          <label style="font-size:11px;color:var(--muted)">URL</label>
          <input id="mcpEditUrl" value="${escHtml(cur.url ?? '')}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <label style="font-size:11px;color:var(--muted)">Authentication</label>
          <select id="mcpEditAuth" data-change-action="onMcpEditAuthChange" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
            <option value="headers" ${cur.auth !== 'oauth' ? 'selected' : ''}>Static headers (PAT, API key)</option>
            <option value="oauth"   ${cur.auth === 'oauth' ? 'selected' : ''}>OAuth</option>
          </select>
          <div id="mcpEditOauthScopeWrap" style="display:${oauthVis};flex-direction:column;gap:6px">
            <label style="font-size:11px;color:var(--muted)">OAuth scope (optional)</label>
            <input id="mcpEditOauthScope" value="${escHtml(cur.oauthScope ?? '')}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          </div>
        </div>
        <button data-action="confirmMcpEdit" data-args='${escHtml(JSON.stringify([serverId]))}' style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600;margin-top:6px;align-self:flex-start">Save & reconnect</button>
        <div id="mcpEditStatus" style="font-size:11px;color:var(--muted);min-height:14px"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function closeMcpEditModal() { document.getElementById('mcpEditModal')?.remove(); }

function onMcpEditTransportChange() {
  const t = $('mcpEditTransport')?.value ?? 'stdio';
  const stdio = $('mcpEditStdioFields');
  const http  = $('mcpEditHttpFields');
  if (stdio) stdio.style.display = t === 'stdio' ? 'flex' : 'none';
  if (http)  http.style.display  = t === 'http'  ? 'flex' : 'none';
}

function onMcpEditAuthChange() {
  const a = $('mcpEditAuth')?.value ?? 'headers';
  const scopeWrap = $('mcpEditOauthScopeWrap');
  if (scopeWrap) scopeWrap.style.display = a === 'oauth' ? 'flex' : 'none';
}

async function confirmMcpEdit(serverId) {
  const transport = $('mcpEditTransport')?.value ?? 'stdio';
  const patch = {
    displayName: $('mcpEditDisplayName')?.value.trim() ?? '',
    transport,
  };
  if (transport === 'stdio') {
    patch.command = $('mcpEditCommand')?.value.trim() ?? '';
    patch.args = ($('mcpEditArgs')?.value ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  } else {
    patch.url = $('mcpEditUrl')?.value.trim() ?? '';
    const authMode = $('mcpEditAuth')?.value ?? 'headers';
    if (authMode === 'oauth') {
      patch.auth = 'oauth';
      const scope = $('mcpEditOauthScope')?.value.trim();
      if (scope) patch.oauthScope = scope;
    } else {
      patch.auth = undefined;
    }
  }
  const status = $('mcpEditStatus');
  if (status) status.textContent = 'Saving…';
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
    closeMcpEditModal();
    setTimeout(loadMcpServers, 400);
    setTimeout(loadMcpServers, 3000);
  } catch (e) {
    if (status) status.textContent = `Save failed: ${e.message}`;
  }
}

function flashMcpBanner(text, kind = 'ok', ttlMs = 4000) {
  const body = $('mcpServersBody'); if (!body) return;
  let banner = document.getElementById('mcpRefreshBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mcpRefreshBanner';
    banner.style.cssText = 'font-size:11px;margin-bottom:8px;padding:6px 10px;border-radius:6px;transition:opacity 0.3s';
    body.prepend(banner);
  }
  banner.style.color = kind === 'err' ? 'var(--red, #e05c5c)' : 'var(--accent)';
  banner.style.background = kind === 'err' ? 'rgba(224,92,92,0.08)' : 'rgba(137,180,250,0.08)';
  banner.style.opacity = '1';
  banner.textContent = text;
  clearTimeout(banner._fadeTimer);
  banner._fadeTimer = setTimeout(() => {
    banner.style.opacity = '0';
    setTimeout(() => { try { banner.remove(); } catch {} }, 300);
  }, ttlMs);
}

async function reconnectMcpServer(serverId) {
  flashMcpBanner(`Reconnecting "${serverId}"…`, 'ok', 60000);
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/reconnect`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      flashMcpBanner(`Reconnect failed: ${data.error ?? r.status}`, 'err');
      return;
    }
    flashMcpBanner(`✓ Reconnected "${serverId}"`, 'ok');
    loadMcpServers();
  } catch (e) {
    flashMcpBanner(`Reconnect failed: ${e.message}`, 'err');
  }
}

async function refreshMcpServers() {
  flashMcpBanner('Reconnecting all servers…', 'ok', 60000);
  try {
    const r = await fetch('/api/mcp/refresh', { method: 'POST' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data?.error ?? `HTTP ${r.status}`);
    }
    flashMcpBanner('✓ Reconnected all servers', 'ok');
    await loadMcpServers();
  } catch (e) {
    flashMcpBanner(`Refresh failed: ${e.message}`, 'err');
  }
}

async function unassignMcpServer(serverId, agentId) {
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/unassign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`Unassign failed: ${data.error ?? r.status}`);
      return;
    }
    loadMcpServers();
  } catch (e) {
    alert(`Unassign failed: ${e.message}`);
  }
}

// ── MCP catalog browser ───────────────────────────────────────────────────────
let _mcpCatalogCache = null;
async function openMcpCatalog() {
  if (!_mcpCatalogCache) {
    try {
      const r = await fetch('/api/mcp/catalog').then(r => r.json());
      _mcpCatalogCache = r.catalog ?? [];
    } catch (e) {
      alert(`Could not load catalog: ${e.message}`);
      return;
    }
  }
  // Render as a lightweight modal overlay anchored to the MCP panel.
  const existing = document.getElementById('mcpCatalogModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'mcpCatalogModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:680px;width:100%;max-height:80vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:14px">MCP server catalog</h3>
        <button data-action="closeMcpCatalog" style="background:transparent;border:none;color:var(--muted);font-size:18px;cursor:pointer">×</button>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:14px">Pick a template to pre-fill the Add form. You can edit anything before saving.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">
        ${_mcpCatalogCache.map(e => `
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px;cursor:pointer" data-action="pickMcpCatalogEntry" data-args='${escHtml(JSON.stringify([e.id]))}'>
            <div style="font-size:18px;margin-bottom:4px">${escHtml(e.icon ?? '🔌')}</div>
            <div style="font-size:13px;font-weight:600;margin-bottom:2px">${escHtml(e.displayName)}</div>
            <div style="font-size:11px;color:var(--muted);line-height:1.4">${escHtml(e.description)}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:6px">${escHtml(e.transport)} ${e.requiredEnv?.length ? ` · needs ${e.requiredEnv.length} secret(s)` : ''}</div>
          </div>
        `).join('')}
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function closeMcpCatalog() {
  document.getElementById('mcpCatalogModal')?.remove();
}

function pickMcpCatalogEntry(id) {
  const entry = (_mcpCatalogCache ?? []).find(e => e.id === id);
  if (!entry) return;
  closeMcpCatalog();
  // Open the manual-add details element if it's closed.
  const detailsBlocks = document.querySelectorAll('#mcpServersBody details');
  detailsBlocks.forEach(d => { d.open = true; });
  // Pre-fill the form fields.
  if ($('mcpAddId')) $('mcpAddId').value = entry.defaultServerId ?? entry.id;
  if ($('mcpAddTransport')) {
    $('mcpAddTransport').value = entry.transport;
    onMcpTransportChange();
  }
  if (entry.transport === 'stdio') {
    if ($('mcpAddCommand')) $('mcpAddCommand').value = entry.command ?? '';
    if ($('mcpAddArgs'))    $('mcpAddArgs').value    = (entry.args ?? []).join('\n');
    if ($('mcpAddEnv')) {
      const envLines = (entry.requiredEnv ?? []).map(e => `${e.key}=`).join('\n');
      $('mcpAddEnv').value = envLines;
    }
  } else if (entry.transport === 'http') {
    if ($('mcpAddUrl'))     $('mcpAddUrl').value     = entry.url ?? '';
    if ($('mcpAddHeaders')) {
      const hdrLines = (entry.requiredHeaders ?? []).map(h => `${h.key}: `).join('\n');
      $('mcpAddHeaders').value = hdrLines;
    }
  }
  // Status nudge so the user sees what to do next.
  const st = $('mcpAddStatus');
  if (st) {
    const needs = entry.requiredEnv?.length || entry.requiredHeaders?.length || 0;
    st.textContent = needs
      ? `Pre-filled. Fill in the ${needs} secret(s) above, then click Add.`
      : 'Pre-filled. Click Add to install.';
    st.style.color = 'var(--accent)';
  }
  // Scroll the form into view.
  $('mcpAddId')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('mcpAddId')?.focus();
}
