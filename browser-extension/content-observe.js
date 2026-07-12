// OpenEnsemble Bridge — observation content script.
// DEBUG: this file logs to the PAGE console so we can see it via F12 on
// whatever page we're observing. Watch for "[OE-observe] loaded" — if you
// don't see that on the page, the content script isn't being injected.
//
// Listens for click / input / submit on the page and reports them to the
// background SW only while a scoped Teach session is active. When off,
// events are discarded in this content script and never cross the runtime
// message boundary.
//
// Sensitive fields (password, credit card autocomplete hints) NEVER
// have their value captured — only the FACT of typing into them.

(function () {
  console.log('[OE-observe] loaded on', location.href);
  const BANNER_HOST_ID = '__oe_bridge_watch_banner__';
  let _bannerEl = null;
  let _watchOn = false;

  function ensureWatchBanner(on) {
    _watchOn = !!on;
    if (!on) {
      if (_bannerEl && _bannerEl.parentNode) _bannerEl.parentNode.removeChild(_bannerEl);
      _bannerEl = null;
      return;
    }
    if (_bannerEl) return;
    _bannerEl = document.createElement('div');
    _bannerEl.id = BANNER_HOST_ID;
    _bannerEl.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0;
      z-index: 2147483646; pointer-events: none;
    `;
    const shadow = _bannerEl.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .bar {
          font: 600 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #d97706; color: #fff;
          padding: 4px 12px; text-align: center;
          box-shadow: 0 1px 4px rgba(0,0,0,0.15);
        }
      </style>
      <div class="bar">👁 OE Teach Mode is observing this page — stop it from OE Bridge at any time</div>
    `;
    document.documentElement.appendChild(_bannerEl);
  }

  function summariseElement(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute?.('type') || '';
    const autocomplete = el.getAttribute?.('autocomplete') || '';
    const sensitive =
      type === 'password' ||
      /^(cc-|credit|cvv|card)/i.test(autocomplete) ||
      /password|credit|card.?(number|cvv)/i.test(el.name || '') ||
      /password|credit|card.?(number|cvv)/i.test(el.id || '');
    const id = el.id || null;
    const cls = (typeof el.className === 'string' && el.className) ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : null;
    const text = (el.innerText || el.value || '').slice(0, 80).trim();
    const ariaLabel = el.getAttribute?.('aria-label') || null;
    const placeholder = el.getAttribute?.('placeholder') || null;
    const name = el.getAttribute?.('name') || null;
    // Best-effort path: ancestor chain with first id or first class on each level.
    const path = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && path.length < 6) {
      const segTag = cur.tagName.toLowerCase();
      const segId = cur.id ? `#${cur.id}` : '';
      const segCls = (typeof cur.className === 'string' && cur.className)
        ? '.' + cur.className.split(/\s+/).filter(Boolean).slice(0, 1).join('.')
        : '';
      path.unshift(segTag + segId + segCls);
      cur = cur.parentNode;
    }
    return {
      tag, id, class: cls, type, name, ariaLabel, placeholder,
      sensitive,
      text: sensitive ? null : text,
      selector: path.join(' > '),
    };
  }

  function send(event) {
    if (!_watchOn) return;
    console.log('[OE-observe] firing event', event.kind, event.element?.tag, 'tabUrl=' + event.tabUrl);
    try {
      chrome.runtime.sendMessage({ type: 'observation', event }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn('[OE-observe] sendMessage error:', chrome.runtime.lastError.message);
        }
      });
    } catch (e) { console.warn('[OE-observe] sendMessage threw', e); }
  }

  document.addEventListener('click', (e) => {
    const el = summariseElement(e.target);
    if (!el) return;
    send({
      kind: 'click',
      element: el,
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      tabUrl: location.href,
      ts: Date.now(),
    });
  }, true);

  // input fires once per user-visible character on text inputs and once
  // on selection change for selects. Captures the current value snapshot
  // (sensitive fields redacted).
  document.addEventListener('input', (e) => {
    const el = summariseElement(e.target);
    if (!el) return;
    const rawValue = (e.target?.value != null) ? String(e.target.value) : null;
    send({
      kind: 'input',
      element: el,
      value: el.sensitive ? null : (rawValue == null ? null : rawValue.slice(0, 200)),
      tabUrl: location.href,
      ts: Date.now(),
    });
  }, true);

  document.addEventListener('change', (e) => {
    const el = summariseElement(e.target);
    if (!el) return;
    if (el.tag === 'select' || el.type === 'checkbox' || el.type === 'radio' || el.type === 'date') {
      send({
        kind: 'change',
        element: el,
        value: el.sensitive ? null : ((e.target?.value != null) ? String(e.target.value).slice(0, 200) : null),
        checked: el.type === 'checkbox' || el.type === 'radio' ? !!e.target?.checked : undefined,
        tabUrl: location.href,
        ts: Date.now(),
      });
    }
  }, true);

  document.addEventListener('submit', (e) => {
    const el = summariseElement(e.target);
    if (!el) return;
    send({ kind: 'submit', element: el, tabUrl: location.href, ts: Date.now() });
  }, true);

  // SW broadcasts watch-mode state on toggle so the banner appears /
  // disappears on every open tab.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'oe_watch_mode') ensureWatchBanner(!!msg.on);
  });

  // On script load, ask the SW for the current state in case watch mode
  // is already on when this page finishes loading.
  try {
    chrome.runtime.sendMessage({ type: 'get_watch_mode' }, (resp) => {
      if (resp?.on) ensureWatchBanner(true);
    });
  } catch {}
})();
