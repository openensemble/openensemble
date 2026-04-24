const $ = id => document.getElementById(id);
marked.setOptions({ breaks: true, gfm: true });

// ── Lucide icon helper ───────────────────────────────────────────────────────
function icon(name, size) {
  return lucide.icons[name]?.toSvg({ class: 'icon', width: size || 18, height: size || 18 }) || '';
}

// ── State ─────────────────────────────────────────────────────────────────────
let ws          = null;
let activeAgent = 'research';
let agents      = [];
let sessions    = {};
let streaming   = false;
let awaitingPermission = false;
let streamBuf   = '';
let streamEl    = null;
let toolPillsEl = null;

// Per-agent streaming state — tracks background agents that are still generating
// Key: agentId → { buf, toolNames, active }
const agentStreams = {};

// ── Layout preference ─────────────────────────────────────────────────────────
let layoutMode = localStorage.getItem('oe_layout') || 'A'; // 'A' or 'B'
applyLayout();

function applyLayout() {
  const bar = $('statusBar');
  if (layoutMode === 'B') {
    bar.classList.add('visible');
    $('layoutTooltip').textContent = 'Switch to Pure Workspace';
  } else {
    bar.classList.remove('visible');
    $('layoutTooltip').textContent = 'Switch to Hybrid Layout';
  }
}

function toggleLayout() {
  layoutMode = layoutMode === 'A' ? 'B' : 'A';
  localStorage.setItem('oe_layout', layoutMode);
  applyLayout();
  if (layoutMode === 'B') {
    updateStatusBar();
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStreaming(v) {
  streaming = v;
  $('btnSend').disabled = v;
  $('btnStop').classList.toggle('visible', v);
  setStatus(v ? 'busy' : 'online');
}
function setTyping(v) { $('typing').className = v ? 'typing visible' : 'typing'; if (v) scrollToBottom(); }
function setStatus(s) {
  const dots = [$('statusDot'), $('statusDotMobile')];
  const cls = 'status-dot' + (s === 'offline' ? ' offline' : s === 'busy' ? ' busy' : '');
  dots.forEach(d => { if (d) d.className = cls; });
}
function resizeTextarea() {
  const ta = $('input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 4000) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:8px;z-index:9999;font-size:14px;';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function showUndoToast(msg, duration = 5000, onUndo) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:8px;z-index:9999;font-size:14px;display:flex;align-items:center;gap:12px;';
  el.innerHTML = `<span>${escHtml(msg)}</span><button style="background:var(--accent);border:none;color:#fff;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;font-weight:600">Undo</button>`;
  el._cancelled = false;
  el.querySelector('button').onclick = () => { el.remove(); if (onUndo) onUndo(); };
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
  return el;
}

// ── Reminder banner ──────────────────────────────────────────────────────────
function showReminder(msg) {
  // Audio chime via Web Audio API
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523.25, 659.25].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.4);
    });
  } catch {}

  // Vibrate on mobile
  try { navigator.vibrate?.([200, 100, 200]); } catch {}

  // Browser notification (background tab)
  if (Notification.permission === 'granted') {
    new Notification('Reminder', { body: msg.label, icon: '/manifest.json' });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') new Notification('Reminder', { body: msg.label });
    });
  }

  // In-app banner
  const banner = document.createElement('div');
  banner.className = 'reminder-banner';
  banner.innerHTML = `
    <div class="reminder-content">
      <span class="reminder-icon">🔔</span>
      <div class="reminder-text">
        <div class="reminder-label">${escHtml(msg.label)}</div>
        <div class="reminder-time">Reminder · ${new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    </div>
    <button class="reminder-dismiss" onclick="this.parentElement.remove()">Dismiss</button>
  `;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('visible'));
}

// ── PIN modal ─────────────────────────────────────────────────────────────────
function showPinModal(title, onConfirm, onCancel) {
  const modal = $('pin-modal');
  $('pin-modal-title').textContent = title;
  $('pin-input').value = '';
  $('pin-error').textContent = '';
  modal.style.display = 'flex';

  const cleanup = () => { modal.style.display = 'none'; };

  const confirmHandler = async () => {
    const pin = $('pin-input').value;
    $('pin-error').textContent = '';
    try {
      await onConfirm(pin);
      cleanup();
    } catch (e) {
      $('pin-error').textContent = e.message || 'Invalid PIN';
    }
  };

  const cancelHandler = () => {
    cleanup();
    if (onCancel) onCancel();
  };

  $('pin-confirm').onclick = confirmHandler;
  $('pin-cancel').onclick = cancelHandler;
  $('pin-input').onkeydown = e => { if (e.key === 'Enter') confirmHandler(); };
  setTimeout(() => $('pin-input').focus(), 50);
}

// ── Password modal (for profile switching) ───────────────────────────────────
function showPasswordModal(title, onConfirm, onCancel) {
  // Reuse pin-modal structure but reconfigure for password entry
  const modal = $('pin-modal');
  $('pin-modal-title').textContent = title;
  const input = $('pin-input');
  input.value = '';
  input.removeAttribute('maxlength');
  input.placeholder = 'Password';
  input.style.fontSize = '14px';
  input.style.textAlign = 'left';
  $('pin-error').textContent = '';
  modal.style.display = 'flex';

  const cleanup = () => {
    modal.style.display = 'none';
    // Restore PIN input defaults
    input.setAttribute('maxlength', '6');
    input.placeholder = '••••';
    input.style.fontSize = '24px';
    input.style.textAlign = 'center';
  };

  const confirmHandler = () => {
    const pw = input.value;
    if (!pw) { $('pin-error').textContent = 'Password required'; return; }
    cleanup();
    onConfirm(pw);
  };

  const cancelHandler = () => { cleanup(); if (onCancel) onCancel(); };

  $('pin-confirm').onclick = confirmHandler;
  $('pin-cancel').onclick = cancelHandler;
  input.onkeydown = e => { if (e.key === 'Enter') confirmHandler(); };
  setTimeout(() => input.focus(), 50);
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

const AVATAR_COLORS = ['#e53935','#8e24aa','#1e88e5','#00897b','#f4511e','#6d4c41','#546e7a','#3949ab'];
function avatarColor(seed) {
  let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ── Conversation search ──────────────────────────────────────────────────────
let _searchDebounce = null;
function openSearch() {
  const modal = $('searchModal');
  modal.style.display = 'flex';
  const input = $('searchInput');
  input.value = '';
  $('searchResults').innerHTML = '<div style="text-align:center;opacity:.5;padding:24px">Type to search your conversations</div>';
  setTimeout(() => input.focus(), 50);
  input.oninput = () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => runSearch(input.value), 300);
  };
  input.onkeydown = e => { if (e.key === 'Escape') closeSearch(); };
}
function closeSearch() { $('searchModal').style.display = 'none'; }

async function runSearch(query) {
  if (query.trim().length < 2) {
    $('searchResults').innerHTML = '<div style="text-align:center;opacity:.5;padding:24px">Type at least 2 characters</div>';
    return;
  }
  $('searchResults').innerHTML = '<div style="text-align:center;opacity:.5;padding:24px">Searching...</div>';
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    const data = await r.json();
    if (!data.results?.length) {
      $('searchResults').innerHTML = '<div style="text-align:center;opacity:.5;padding:24px">No results found</div>';
      return;
    }
    const agentMap = {};
    agents.forEach(a => { const local = a.id.replace(/^user_[a-zA-Z0-9]+_/, ''); agentMap[local] = a; });
    $('searchResults').innerHTML = data.results.map(r => {
      const agent = agentMap[r.agent];
      const name = agent?.name ?? r.agent;
      const emoji = agent?.emoji ?? '🤖';
      const date = r.ts ? new Date(r.ts).toLocaleDateString() : '';
      const snippet = escHtml(r.content).replace(new RegExp(`(${escHtml(query)})`, 'gi'), '<mark>$1</mark>');
      return `<div class="search-result" onclick="closeSearch();switchAgent('${escHtml(r.agent)}')" style="padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:4px;border:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <span>${emoji}</span><strong style="font-size:13px">${escHtml(name)}</strong>
          <span style="margin-left:auto;font-size:11px;opacity:.5">${date}</span>
          <span style="font-size:11px;opacity:.4;text-transform:capitalize">${r.role}</span>
        </div>
        <div style="font-size:12px;opacity:.8;line-height:1.4;overflow:hidden;max-height:40px">${snippet}</div>
      </div>`;
    }).join('');
  } catch (e) {
    $('searchResults').innerHTML = `<div style="text-align:center;color:var(--error);padding:24px">${escHtml(e.message)}</div>`;
  }
}

// Ctrl+K keyboard shortcut for search
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    openSearch();
  }
});

