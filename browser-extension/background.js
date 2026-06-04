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

// Media control — Tier 1.5 quick win. Prefer the standard Media Session
// action handlers (the proper browser API for "media keys"), fall back to
// site-specific selector clicks for popular sites that don't register
// Media Session actions correctly. Pick the tab with active media first;
// if none, fall back to the currently focused tab.
async function findMediaTab() {
  // Chrome marks tabs that have ever played audio as audible:true (or had
  // audio:true) — that's the best signal for "this tab is the music."
  const allTabs = await chrome.tabs.query({});
  const audible = allTabs.find(t => t.audible);
  if (audible) return audible;
  // Tabs that have been muted are sometimes still the music player —
  // include them as a fallback before resorting to the active tab.
  const known = allTabs.find(t => /youtube\.com|music\.youtube\.com|open\.spotify\.com|soundcloud\.com|music\.apple\.com|bandcamp\.com/.test(t.url || ''));
  if (known) return known;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active || null;
}

async function mediaControl(action) {
  const tab = await findMediaTab();
  if (!tab?.id) throw new Error('no tab found to control media on');
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (action) => {
      // 1. Standard path: navigator.mediaSession action handlers. Most
      //    modern sites register these so OS-level media keys work; we
      //    can invoke them programmatically too.
      //    Unfortunately the spec doesn't expose the registered handlers
      //    for direct invocation — but most sites also have keyboard
      //    bindings on the document, so dispatch the standard media key
      //    events first. Browsers will route to mediaSession.
      const fireMediaKey = (key) => {
        const ev = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, composed: true });
        document.dispatchEvent(ev);
      };
      const keyMap = { next: 'MediaTrackNext', previous: 'MediaTrackPrevious', playpause: 'MediaPlayPause' };
      fireMediaKey(keyMap[action]);
      // The keyboard event is unlikely to be honored on most sites because
      // synthesized events have isTrusted=false. Fall through to per-site
      // selector clicks for the popular cases.
      const host = location.hostname.replace(/^www\./, '');
      const click = (sel) => {
        const el = document.querySelector(sel);
        if (el) { el.click(); return true; }
        return false;
      };
      let matched = null;
      let method = 'keyboard';
      if (host === 'music.youtube.com') {
        matched = 'music.youtube.com';
        method = 'selector-click';
        if (action === 'next')      click('tp-yt-paper-icon-button.next-button') || click('.next-button');
        if (action === 'previous')  click('tp-yt-paper-icon-button.previous-button') || click('.previous-button');
        if (action === 'playpause') click('tp-yt-paper-icon-button#play-pause-button') || click('#play-pause-button');
      } else if (host === 'youtube.com') {
        matched = 'youtube.com';
        method = 'selector-click';
        if (action === 'next')      click('a.ytp-next-button') || click('.ytp-next-button');
        if (action === 'previous')  click('a.ytp-prev-button') || click('.ytp-prev-button');
        if (action === 'playpause') click('button.ytp-play-button');
      } else if (host === 'open.spotify.com') {
        matched = 'open.spotify.com';
        method = 'selector-click';
        if (action === 'next')      click('button[data-testid="control-button-skip-forward"]');
        if (action === 'previous')  click('button[data-testid="control-button-skip-back"]');
        if (action === 'playpause') click('button[data-testid="control-button-playpause"]');
      } else if (host === 'soundcloud.com') {
        matched = 'soundcloud.com';
        method = 'selector-click';
        if (action === 'next')      click('button.skipControl__next');
        if (action === 'previous')  click('button.skipControl__previous');
        if (action === 'playpause') click('button.playControl');
      } else if (host === 'music.apple.com') {
        matched = 'music.apple.com';
        method = 'selector-click';
        if (action === 'next')      click('button.web-chrome-playback-controls__next-button') || click('apple-music-playback-controls button[aria-label*="Next" i]');
        if (action === 'previous')  click('button.web-chrome-playback-controls__previous-button') || click('apple-music-playback-controls button[aria-label*="Previous" i]');
        if (action === 'playpause') click('button.web-chrome-playback-controls__playback-btn') || click('apple-music-playback-controls button[aria-label*="Play" i]');
      } else {
        // Unknown host — last-ditch: try the audio/video element on the
        // page directly. Pause/play work, next/previous don't (no
        // playlist semantics on a bare <video>).
        const media = document.querySelector('video, audio');
        if (media && action === 'playpause') {
          if (media.paused) media.play(); else media.pause();
          method = 'media-element';
        }
      }
      return { matchedHost: matched, method, tabUrl: location.href, tabTitle: document.title };
    },
    args: [action],
  });
  return result || { tabUrl: tab.url, method: 'unknown' };
}

async function dispatch(action, args) {
  switch (action) {
    case 'list_tabs':     return await listTabsSnapshot();
    case 'open_tab':      return await openTab(String(args?.url || ''));
    case 'read_page':     return await readPage(Number(args?.tabId));
    case 'media_control': return await mediaControl(String(args?.action || ''));
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
      // Self-reload on source-version mismatch. The OE server hashes the
      // on-disk extension files (background.js, popup.*, manifest.json)
      // at startup and sends us the hash. If we've seen a DIFFERENT hash
      // before, the on-disk source has changed since our SW loaded — call
      // chrome.runtime.reload() to make Chrome re-read the files. Next
      // boot of the SW will see the new hash, store it, and continue
      // without reloading until source changes again.
      // First connect (no stored version): just record what the server
      // said and continue. Don't auto-reload on first boot.
      if (msg.sourceVersion) {
        try {
          const { lastSourceVersion } = await chrome.storage.local.get(['lastSourceVersion']);
          if (lastSourceVersion && lastSourceVersion !== msg.sourceVersion) {
            console.log(`[OE Bridge] source version changed (${lastSourceVersion} → ${msg.sourceVersion}), reloading extension`);
            await chrome.storage.local.set({ lastSourceVersion: msg.sourceVersion });
            // Give the status frame a moment to render in any open popup
            // before we yank the SW.
            setTimeout(() => chrome.runtime.reload(), 250);
            return;
          }
          if (!lastSourceVersion) {
            await chrome.storage.local.set({ lastSourceVersion: msg.sourceVersion });
          }
        } catch (e) {
          console.warn('[OE Bridge] source version compare failed:', e?.message || e);
        }
      }
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
    if (msg?.type === 'auto_pair') {
      // Try candidate OE URLs in order. Each fetch carries the user's
      // existing cookie for that origin (host_permissions: <all_urls>),
      // so we just need to find an origin where they're logged in and
      // it serves OE's setup-token endpoint.
      //
      // Order of preference:
      //   1. Caller-supplied URL (if popup passed one explicitly).
      //   2. Active tab's origin (covers "user is looking at OE in
      //      another tab right now" — handles LAN OE for free).
      //   3. Known previous serverUrl (if they've configured before).
      //   4. http://localhost:3737 (the same-machine default).
      const candidates = [];
      const pushUnique = (u) => {
        if (!u) return;
        const norm = String(u).trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(norm)) return;
        if (!candidates.includes(norm)) candidates.push(norm);
      };
      pushUnique(msg.serverUrl);
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.url) {
          const u = new URL(activeTab.url);
          if (u.protocol === 'http:' || u.protocol === 'https:') pushUnique(`${u.protocol}//${u.host}`);
        }
      } catch { /* no active tab access — skip */ }
      pushUnique((await getConfig()).serverUrl);
      pushUnique('http://localhost:3737');

      const tried = [];
      for (const url of candidates) {
        tried.push(url);
        try {
          const r = await fetch(url + '/api/browser/setup-token', {
            credentials: 'include',
            cache: 'no-store',
          });
          if (r.status === 401) continue;       // origin is OE but not logged in — try next
          if (!r.ok) continue;                   // not OE (or different error) — try next
          const j = await r.json().catch(() => null);
          if (!j?.token) continue;
          const config = { serverUrl: url, token: j.token, name: (await getConfig()).name || 'OE Bridge' };
          await chrome.storage.local.set(config);
          try { _ws?.close(); } catch {}
          _backoffIdx = 0;
          _shouldReconnect = true;
          setTimeout(connect, 100);
          sendResponse({ ok: true, config, userId: j.userId, source: url });
          return;
        } catch { /* fetch failed (connection refused, DNS, etc.) — try next */ }
      }
      sendResponse({
        ok: false,
        error: `Auto-detect couldn't find OE. Tried: ${tried.join(', ')}. If OE is on a different machine, open it in this browser first (so the extension can detect it from your active tab), or paste its URL + token manually below.`,
      });
      return;
    }
  })();
  return true; // async sendResponse
});

// Kick off on service worker startup. Chrome MV3 may park the worker; on
// wake, the onAlarm or onStartup hooks below will re-fire this.
chrome.runtime.onStartup.addListener(() => { _shouldReconnect = true; connect(); });
chrome.runtime.onInstalled.addListener(() => { _shouldReconnect = true; connect(); });

// Keepalive. Guarded against chrome.alarms being undefined — happens when
// the extension was first registered before the `alarms` permission was
// granted (manifest updates don't always re-flush permissions until a
// full remove + reinstall). The defensive branch falls back to setInterval
// so the SW at least loads + the popup can talk to it; alarms is the
// preferred path because it survives SW eviction.
if (typeof chrome?.alarms?.create === 'function') {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(() => {
    if (_ws && _ws.readyState === 1) send({ type: 'ping' });
    else if (_shouldReconnect && (!_ws || _ws.readyState >= 2)) connect();
  });
} else {
  console.warn('[OE Bridge] chrome.alarms unavailable — using setInterval fallback. Remove + reinstall the extension at chrome://extensions to pick up the alarms permission for the proper keepalive.');
  setInterval(() => {
    if (_ws && _ws.readyState === 1) send({ type: 'ping' });
    else if (_shouldReconnect && (!_ws || _ws.readyState >= 2)) connect();
  }, 30_000);
}

connect();
