// OpenEnsemble Bridge — MV3 service worker.
// Connects to the user's OE server WS, authenticates with a paste-in token,
// then handles inbound commands (open_tab, read_page, list_tabs) via the
// browser's tabs + scripting APIs.

const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
let _backoffIdx = 0;
let _ws = null;
let _shouldReconnect = true;
let _extId = null;
let _status = { connected: false, lastError: null, server: null, since: null };

const REQUIRED_FIELDS = ['serverUrl', 'token'];

async function getConfig() {
  const c = await chrome.storage.local.get(['serverUrl', 'token', 'name']);
  return {
    serverUrl: c.serverUrl || '',
    token:     c.token     || '',
    name:      c.name      || 'OE Bridge',
  };
}

async function setStatus(patch) {
  _status = { ..._status, ...patch };
  // Broadcast to any open popup. Errors are silent — popup may not be open.
  try { await chrome.runtime.sendMessage({ type: 'status', status: _status }); } catch {}
}

async function listTabsSnapshot() {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({
      tabId: t.id,
      url: t.url || '',
      title: t.title || '',
      active: !!t.active,
      windowId: t.windowId,
    }));
  } catch { return []; }
}

async function readPage(tabId) {
  // Inject a function that returns sanitized page contents. No raw HTML —
  // text only, plus a links list and any JSON-LD blocks. Defends against
  // prompt-injection from a hostile page by keeping HTML markup out of the
  // tool result that flows back to the LLM.
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const body = document.body ? document.body.innerText : '';
      const links = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        const text = (a.innerText || '').trim();
        if (href && text) links.push({ href, text });
        if (links.length >= 60) break;
      }
      const jsonLd = [];
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { jsonLd.push(JSON.parse(s.textContent || '{}')); } catch {}
        if (jsonLd.length >= 5) break;
      }
      return {
        url: location.href,
        title: document.title || '',
        text: body.slice(0, 50000), // hard cap; server will truncate further
        links,
        jsonLd,
      };
    },
  });
  if (!result) throw new Error('scripting returned nothing — tab may be a chrome:// page (not scriptable) or just closed');
  return result;
}

async function openTab(url) {
  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id };
}

async function dispatch(action, args) {
  switch (action) {
    case 'list_tabs': return await listTabsSnapshot();
    case 'open_tab':  return await openTab(String(args?.url || ''));
    case 'read_page': return await readPage(Number(args?.tabId));
    default: throw new Error(`unknown action "${action}"`);
  }
}

async function send(obj) {
  if (_ws && _ws.readyState === 1) {
    _ws.send(JSON.stringify(obj));
  }
}

async function pushTabsUpdate() {
  const tabs = await listTabsSnapshot();
  await send({ type: 'tabs_update', tabs });
}

function buildWsUrl(serverUrl) {
  let u = serverUrl.trim().replace(/\/+$/, '');
  // Accept http(s):// host[:port] or ws(s):// host[:port]; normalise to ws(s)://
  u = u.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  if (!/^wss?:\/\//.test(u)) u = 'ws://' + u;
  return u + '/ws/browser-ext';
}

async function connect() {
  if (!_shouldReconnect) return;
  const cfg = await getConfig();
  for (const f of REQUIRED_FIELDS) {
    if (!cfg[f]) { setStatus({ connected: false, lastError: `missing ${f}`, server: cfg.serverUrl, since: null }); return; }
  }
  const wsUrl = buildWsUrl(cfg.serverUrl);
  try {
    _ws = new WebSocket(wsUrl);
  } catch (e) {
    setStatus({ connected: false, lastError: String(e?.message || e), server: cfg.serverUrl });
    scheduleReconnect();
    return;
  }

  _ws.onopen = async () => {
    _backoffIdx = 0;
    // First-message auth. The server validates the token against
    // getSessionMeta and either ACKs or closes the socket.
    const tabs = await listTabsSnapshot();
    send({
      type: 'auth',
      token: cfg.token,
      name: cfg.name,
      version: chrome.runtime.getManifest().version,
      tabs,
    });
  };

  _ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'auth_ok') {
      _extId = msg.extId || null;
      setStatus({ connected: true, lastError: null, server: cfg.serverUrl, since: Date.now(), extId: _extId, userId: msg.userId });
      return;
    }
    if (msg.type === 'error') {
      setStatus({ connected: false, lastError: msg.message || 'server error', server: cfg.serverUrl });
      return;
    }
    if (msg.type === 'pong') return;

    if (msg.type === 'cmd' && msg.cmdId && msg.action) {
      try {
        const data = await dispatch(msg.action, msg.args || {});
        send({ type: 'result', cmdId: msg.cmdId, ok: true, data });
      } catch (e) {
        send({ type: 'result', cmdId: msg.cmdId, ok: false, error: e?.message || String(e) });
      }
      return;
    }
  };

  _ws.onclose = () => {
    setStatus({ connected: false, server: cfg.serverUrl });
    scheduleReconnect();
  };
  _ws.onerror = (e) => {
    setStatus({ connected: false, lastError: 'connection error', server: cfg.serverUrl });
    // onclose will follow and trigger the reconnect.
  };
}

function scheduleReconnect() {
  if (!_shouldReconnect) return;
  const delay = RECONNECT_BACKOFF_MS[Math.min(_backoffIdx, RECONNECT_BACKOFF_MS.length - 1)];
  _backoffIdx++;
  setTimeout(connect, delay);
}

// Push tabs updates when the user opens / closes / navigates a tab so the
// server snapshot stays fresh without round-trips. Debounced — a click can
// fire 3 events; collapse to one push within 250ms.
let _tabsPushTimer = null;
function debouncedPushTabs() {
  if (_tabsPushTimer) return;
  _tabsPushTimer = setTimeout(() => {
    _tabsPushTimer = null;
    pushTabsUpdate().catch(() => {});
  }, 250);
}
chrome.tabs.onCreated.addListener(debouncedPushTabs);
chrome.tabs.onRemoved.addListener(debouncedPushTabs);
chrome.tabs.onUpdated.addListener((_, info) => { if (info.url || info.title || info.status === 'complete') debouncedPushTabs(); });
chrome.tabs.onActivated.addListener(debouncedPushTabs);

// Popup ↔ background message bus. Popup asks for status / saves config /
// triggers reconnect.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'get_status') {
      sendResponse({ status: _status, config: await getConfig() });
      return;
    }
    if (msg?.type === 'save_config') {
      await chrome.storage.local.set(msg.config || {});
      // Drop existing WS so the new config takes effect immediately.
      try { _ws?.close(); } catch {}
      _backoffIdx = 0;
      _shouldReconnect = true;
      setTimeout(connect, 100);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'reconnect') {
      try { _ws?.close(); } catch {}
      _backoffIdx = 0;
      _shouldReconnect = true;
      setTimeout(connect, 100);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'disconnect') {
      _shouldReconnect = false;
      try { _ws?.close(); } catch {}
      sendResponse({ ok: true });
      return;
    }
  })();
  return true; // async sendResponse
});

// Kick off on service worker startup. Chrome MV3 may park the worker; on
// wake, the onAlarm or onStartup hooks below will re-fire this. We also
// keep an idle alarm so the worker doesn't fully evict.
chrome.runtime.onStartup.addListener(() => { _shouldReconnect = true; connect(); });
chrome.runtime.onInstalled.addListener(() => { _shouldReconnect = true; connect(); });
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  // No-op — the act of receiving an alarm event keeps the SW warm.
  if (_ws && _ws.readyState === 1) send({ type: 'ping' });
  else if (_shouldReconnect && (!_ws || _ws.readyState >= 2)) connect();
});

connect();
