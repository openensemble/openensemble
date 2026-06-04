// OpenEnsemble Bridge — activity banner content script.
// Renders a small colored bar at the top of the page whenever a server-
// initiated read or media action targets THIS tab. Lets the user always
// see when their browser is being touched + click STOP to disconnect the
// extension immediately. Receives start/end events from background.js
// via chrome.runtime.sendMessage.

(function () {
  const HOST_ID = '__oe_bridge_banner_host__';
  let _hostEl = null;
  let _shadowRoot = null;
  let _hideTimer = null;

  function ensureBanner() {
    if (_hostEl && document.body.contains(_hostEl)) return _hostEl;
    _hostEl = document.createElement('div');
    _hostEl.id = HOST_ID;
    _hostEl.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      pointer-events: none; display: none;
    `;
    _shadowRoot = _hostEl.attachShadow({ mode: 'closed' });
    _shadowRoot.innerHTML = `
      <style>
        .bar {
          font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: linear-gradient(90deg, #2563eb, #6366f1);
          color: #fff; padding: 7px 14px;
          display: flex; align-items: center; justify-content: space-between;
          box-shadow: 0 2px 8px rgba(0,0,0,0.18);
          pointer-events: auto;
        }
        .label { flex: 1; min-width: 0; }
        .label code { background: rgba(255,255,255,0.18); padding: 1px 6px; border-radius: 4px; font-size: 11px; }
        .stop {
          background: rgba(255,255,255,0.18); color: #fff; border: none;
          padding: 4px 10px; border-radius: 4px; cursor: pointer; font: inherit; font-weight: 700;
          margin-left: 10px;
        }
        .stop:hover { background: rgba(255,255,255,0.28); }
      </style>
      <div class="bar">
        <div class="label">OpenEnsemble is <span class="action">reading</span> this page</div>
        <button class="stop" type="button">Disconnect</button>
      </div>
    `;
    _shadowRoot.querySelector('.stop').addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'disconnect' }); } catch {}
      hide();
    });
    document.documentElement.appendChild(_hostEl);
    return _hostEl;
  }

  function show(action) {
    ensureBanner();
    const labelMap = {
      read_page:     'reading',
      open_tab:      'opening',
      media_control: 'controlling media on',
      back:          'navigating back on',
      forward:       'navigating forward on',
      reload:        'reloading',
      close_tab:     'closing',
      focus_tab:     'focusing',
    };
    const txt = labelMap[action] || `running ${action} on`;
    _shadowRoot.querySelector('.action').textContent = txt;
    _hostEl.style.display = 'block';
    clearTimeout(_hideTimer);
    // Auto-hide ~1.5s after the last activity. For long-running reads
    // background.js sends a follow-up event so this gets reset.
    _hideTimer = setTimeout(hide, 1500);
  }

  function hide() {
    clearTimeout(_hideTimer);
    if (_hostEl) _hostEl.style.display = 'none';
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'oe_activity_start') show(String(msg.action || ''));
    else if (msg.type === 'oe_activity_end') hide();
  });
})();
