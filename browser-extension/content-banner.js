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
  // Lease state for THIS tab — 'active' keeps a persistent amber bar up so
  // the user always knows OE currently holds access here; 'suspended' (the
  // tab navigated away from the origin it was granted on) shows a grey
  // paused bar with a Resume button.
  let _leaseState = 'none'; // 'none' | 'active' | 'suspended'
  let _leaseExpiresAt = null;
  let _mode = 'activity'; // 'activity' | 'lease' — which button behavior is showing

  function ensureBanner() {
    // NB: the host is appended to documentElement, not body — checking
    // body.contains() here silently recreated (and stacked) the banner on
    // every call. Harmless when banners were transient; visible now that
    // the lease bar is persistent.
    if (_hostEl && document.documentElement.contains(_hostEl)) return _hostEl;
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
        .bar.lease { background: linear-gradient(90deg, #d97706, #f59e0b); }
        .bar.paused { background: linear-gradient(90deg, #475569, #64748b); }
        .label { flex: 1; min-width: 0; }
        .label code { background: rgba(255,255,255,0.18); padding: 1px 6px; border-radius: 4px; font-size: 11px; }
        .stop, .resume {
          background: rgba(255,255,255,0.18); color: #fff; border: none;
          padding: 4px 10px; border-radius: 4px; cursor: pointer; font: inherit; font-weight: 700;
          margin-left: 10px;
        }
        .stop:hover, .resume:hover { background: rgba(255,255,255,0.28); }
      </style>
      <div class="bar">
        <div class="label"></div>
        <button class="resume" type="button" style="display:none">Resume</button>
        <button class="stop" type="button">Disconnect</button>
      </div>
    `;
    _shadowRoot.querySelector('.stop').addEventListener('click', () => {
      if (_mode === 'lease') {
        // Revoking the lease is fail-safe, so the banner button may do it
        // directly; background broadcasts the state change back to us.
        try { chrome.runtime.sendMessage({ type: 'revoke_lease' }); } catch {}
        _leaseState = 'none';
        renderBase();
      } else {
        try { chrome.runtime.sendMessage({ type: 'disconnect' }); } catch {}
        hide();
      }
    });
    _shadowRoot.querySelector('.resume').addEventListener('click', () => {
      // Resume is the cheap re-consent after a cross-origin navigation
      // paused the lease. Success comes back via the oe_lease broadcast;
      // only refusals (sensitive page, no entry) need showing here.
      try {
        chrome.runtime.sendMessage({ type: 'resume_lease' }, (resp) => {
          if (chrome.runtime.lastError) return;
          if (resp && !resp.ok) {
            _shadowRoot.querySelector('.label').textContent = `⏸ ${resp.error || "couldn't resume"}`;
          }
        });
      } catch {}
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
      screenshot:    'taking a screenshot of',
      click_xy:      'clicking on',
      type:          'typing on',
      keypress:      'pressing a key on',
    };
    const txt = labelMap[action] || `running ${action} on`;
    _mode = 'activity';
    const bar = _shadowRoot.querySelector('.bar');
    bar.classList.remove('lease', 'paused');
    _shadowRoot.querySelector('.resume').style.display = 'none';
    _shadowRoot.querySelector('.label').textContent = `OpenEnsemble is ${txt} this page`;
    _shadowRoot.querySelector('.stop').textContent = 'Disconnect';
    _hostEl.style.display = 'block';
    clearTimeout(_hideTimer);
    // Fall back ~1.5s after the last activity — to hidden, or to the
    // persistent lease bar if this tab is leased. For long-running reads
    // background.js sends a follow-up event so this gets reset.
    _hideTimer = setTimeout(renderBase, 1500);
  }

  // The banner's resting state: a persistent amber bar while this tab is
  // under an active lease, a grey paused bar while the lease is suspended
  // (tab left its granted origin), nothing otherwise.
  function renderBase() {
    clearTimeout(_hideTimer);
    if (_leaseState === 'none') { hide(); return; }
    ensureBanner();
    _mode = 'lease';
    const bar = _shadowRoot.querySelector('.bar');
    const label = _shadowRoot.querySelector('.label');
    const resume = _shadowRoot.querySelector('.resume');
    bar.classList.toggle('lease', _leaseState === 'active');
    bar.classList.toggle('paused', _leaseState === 'suspended');
    if (_leaseState === 'suspended') {
      label.textContent = '⏸ OpenEnsemble access paused — this tab moved to a different site';
      resume.style.display = 'inline-block';
      _shadowRoot.querySelector('.stop').textContent = 'Revoke';
    } else {
      const until = _leaseExpiresAt
        ? new Date(_leaseExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : '';
      label.textContent = `🔓 OpenEnsemble has access to this tab${until ? ` until ${until}` : ''}`;
      resume.style.display = 'none';
      _shadowRoot.querySelector('.stop').textContent = 'Revoke access';
    }
    _hostEl.style.display = 'block';
  }

  function hide() {
    clearTimeout(_hideTimer);
    if (_hostEl) _hostEl.style.display = 'none';
  }

  // Capture-phase submit guard — defense in depth behind the broker's
  // refusal to click submit controls or fire requestSubmit. OE's injected
  // click/type/keypress helpers stamp window.__oeSyntheticActionTs in this
  // same isolated world; a submit event landing on a leased tab right
  // after an OE action gets blocked. User-initiated submits never carry
  // the stamp, so normal browsing is unaffected.
  document.addEventListener('submit', (e) => {
    // Guard while any lease entry exists for this tab (active OR
    // suspended) — a stale synthetic-action stamp should never ride
    // through a suspension.
    if (_leaseState === 'none') return;
    const ts = window.__oeSyntheticActionTs || 0;
    const confirmedTs = window.__oeConfirmedActionTs || 0;
    const explicitlyConfirmed = confirmedTs && confirmedTs === ts;
    if (ts && (Date.now() - ts) < 1500 && !explicitlyConfirmed) {
      e.preventDefault();
      e.stopImmediatePropagation();
      try { chrome.runtime.sendMessage({ type: 'oe_submit_blocked', url: location.href }); } catch {}
    }
  }, true);

  // Visual click indicator — a pulsing ring at the (x, y) coordinate
  // OE is about to click. Lets the user see exactly where Chey is
  // acting on the page rather than just reading her chat narration.
  function showClickRing(x, y) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `
      <style>
        @keyframes oeClickRing {
          0%   { transform: translate(-50%, -50%) scale(0.4); opacity: 0.9; }
          100% { transform: translate(-50%, -50%) scale(2.4); opacity: 0; }
        }
        .ring {
          position: fixed; left: ${x}px; top: ${y}px;
          width: 40px; height: 40px; border-radius: 50%;
          border: 3px solid #2563eb;
          background: rgba(37, 99, 235, 0.18);
          box-shadow: 0 0 12px rgba(37, 99, 235, 0.6);
          transform: translate(-50%, -50%);
          animation: oeClickRing 0.9s ease-out forwards;
        }
      </style>
      <div class="ring"></div>
    `;
    document.documentElement.appendChild(host);
    setTimeout(() => { try { host.remove(); } catch {} }, 1000);
  }

  // Element highlight — a brief outline on whatever OE is about to
  // interact with. Element resolved by document.elementFromPoint(x,y).
  function highlightAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el === document.body || el === document.documentElement) return;
    const prev = {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
      transition: el.style.transition,
    };
    el.style.transition = 'outline 0.2s ease-out';
    el.style.outline = '3px solid #2563eb';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      try {
        el.style.outline = prev.outline;
        el.style.outlineOffset = prev.outlineOffset;
        el.style.transition = prev.transition;
      } catch {}
    }, 700);
  }

  // Floating tooltip near the currently focused element showing what
  // text just got typed. Decays after a couple of seconds.
  function showTypeTooltip(text) {
    const focused = document.activeElement;
    if (!focused || focused === document.body) return;
    const rect = focused.getBoundingClientRect();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const sh = host.attachShadow({ mode: 'closed' });
    const safeText = String(text || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    sh.innerHTML = `
      <style>
        .tip {
          position: fixed;
          left: ${Math.round(rect.left)}px;
          top: ${Math.round(rect.bottom + 6)}px;
          background: #2563eb; color: #fff;
          padding: 4px 10px; border-radius: 4px;
          font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
          opacity: 0; animation: oeTipFade 1.8s ease-out forwards;
          max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        @keyframes oeTipFade {
          0%  { opacity: 0; transform: translateY(-4px); }
          15% { opacity: 1; transform: translateY(0); }
          80% { opacity: 1; }
          100% { opacity: 0; transform: translateY(-4px); }
        }
      </style>
      <div class="tip">⌨ ${safeText}</div>
    `;
    document.documentElement.appendChild(host);
    setTimeout(() => { try { host.remove(); } catch {} }, 1900);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'oe_activity_start') show(String(msg.action || ''));
    else if (msg.type === 'oe_activity_end') renderBase();
    else if (msg.type === 'oe_visual_click') {
      highlightAt(msg.x, msg.y);
      showClickRing(msg.x, msg.y);
    }
    else if (msg.type === 'oe_visual_type') showTypeTooltip(msg.text);
    else if (msg.type === 'oe_lease') {
      _leaseState = msg.state || 'none';
      _leaseExpiresAt = msg.expiresAt || null;
      renderBase();
    }
  });

  // On load, ask whether THIS tab is already leased — keeps the banner up
  // across same-origin navigations within a leased tab and after SW
  // respawn, and shows the paused bar after a cross-origin one.
  try {
    chrome.runtime.sendMessage({ type: 'get_lease_state' }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp?.state && resp.state !== 'none') {
        _leaseState = resp.state;
        _leaseExpiresAt = resp.expiresAt || null;
        renderBase();
      }
    });
  } catch {}
})();
