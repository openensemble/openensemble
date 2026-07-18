// Scroll / jump-to-latest pill — extracted from chat-render.js.
// Globals intentional.

// ── Scroll management ─────────────────────────────────────────────────────────
// Auto-scroll follows new content only while the user is at (or near) the
// bottom. Scrolling up pauses following and shows a "Jump to latest" pill;
// scrolling back down, clicking the pill, or sending a message resumes it.
// Without this, per-token scrollToBottom() yanks the viewport while reading
// scrollback — several times a second during streaming.
let _autoScroll = true;
let _jumpPillEl = null;
// Counts message-level bubbles inserted (via insertBefore) while scrolled up.
// Streaming tokens mutate an existing bubble's innerHTML rather than calling
// insertBefore again, so per-token updates never bump this — only genuinely
// new user/assistant/tool-report/etc. items do.
let _newMessageCount = 0;

function _isNearBottom() {
  const m = $('messages');
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}

function _updateJumpPill() {
  if (!_jumpPillEl) {
    _jumpPillEl = document.createElement('button');
    _jumpPillEl.type = 'button';
    // z-index must beat .workspace (a stacking context at 60, styles.css) or
    // the pill shows through the transparent chat background but hit-testing
    // sends every click to .messages — visible yet unclickable. Stay below
    // drawers (200) and modals (1100+).
    _jumpPillEl.style.cssText = 'position:fixed;transform:translateX(-50%);z-index:150;padding:6px 14px;font-size:12px;border-radius:16px;border:1px solid var(--border);background:var(--bg2);color:var(--fg);cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);display:none';
    _jumpPillEl.addEventListener('click', () => scrollToBottom(true));
    document.body.appendChild(_jumpPillEl);
  }
  if (_autoScroll) {
    // Reached bottom (scroll, pill click, or a forced scrollToBottom) —
    // clear the tally so the next time the pill appears it starts fresh.
    _newMessageCount = 0;
    _jumpPillEl.style.display = 'none';
    return;
  }
  _jumpPillEl.textContent = _newMessageCount > 0 ? `↓ ${_newMessageCount} new` : '↓ Jump to latest';
  const r = $('messages').getBoundingClientRect();
  _jumpPillEl.style.left = `${r.left + r.width / 2}px`;
  _jumpPillEl.style.bottom = `${Math.max(0, window.innerHeight - r.bottom) + 12}px`;
  _jumpPillEl.style.display = 'block';
}

(function _initScrollTracking() {
  const attach = () => {
    const m = $('messages');
    if (!m) return;
    m.addEventListener('scroll', () => {
      const nb = _isNearBottom();
      if (nb !== _autoScroll) { _autoScroll = nb; _updateJumpPill(); }
    }, { passive: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();

function scrollToBottom(force = false) {
  if (force && !_autoScroll) { _autoScroll = true; _updateJumpPill(); }
  if (!_autoScroll) return;
  const m = $('messages'); m.scrollTop = m.scrollHeight;
}
// escHtml defined below in Shared helpers section (with full quote escaping)
