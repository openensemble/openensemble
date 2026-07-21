// OpenEnsemble Bridge — MV3 service worker.
// Connects to the user's OE server WS with a browser-bound signing key,
// then handles inbound commands via the browser's tabs + scripting APIs.
//
// Every server-initiated command passes through a default-deny capability
// broker (see ACTION_TIERS / authorize()). Without an active user-granted
// lease, the server can neither see nor touch tabs; leases are granted
// only from the extension's own UI, are scoped to specific tabs, expire,
// and are indicated by a persistent banner on every leased tab.
//
// Leases are also ORIGIN-BOUND: a grant covers the site the tab showed at
// Allow time. Cross-origin navigation suspends the grant until the user
// resumes it, and sensitive origins (login/banking/payments/etc.) fail
// closed everywhere. "Ask about this page" is a separate one-shot capture
// that mints no lease at all.

import { normalizeSuggestionMatchers, matchSuggestionForPage } from './suggestions.js';

const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
let _backoffIdx = 0;
let _ws = null;
let _shouldReconnect = true;
let _extId = null;
let _status = { connected: false, lastError: null, server: null, since: null };
let _connectionGeneration = 0;
const _pendingWsRequests = new Map();

const PENDING_CLIP_KEY = 'browserPendingClip';
const PENDING_CLIP_TTL_MS = 30 * 60 * 1000;
const FIELD_WATCH_PICKER_KEY = 'browserFieldWatchPickerGrant';
const FIELD_WATCH_SELECTION_KEY = 'browserFieldWatchPendingSelection';
const FIELD_WATCH_PICKER_TTL_MS = 5 * 60_000;
const FIELD_WATCH_POLL_INTERVAL_MS = 60_000;
const CONFIRMATION_TTL_MS = 60_000;
const EXTENSION_UI_DOCUMENTS = new Set(['popup.html', 'sidepanel.html']);
let _pendingConfirmation = null;
let _pendingConfirmationResolve = null;
let _fieldWatchPollInFlight = false;
let _lastFieldWatchPollAt = 0;
let _suggestionMatchers = [];
let _activeSuggestion = null;

// A Chrome side panel is extension UI, but Chrome may still attach its host
// tab to MessageSender.tab.  Therefore `sender.tab` cannot distinguish the
// side panel from a content script.  Authenticate the actual sender document
// instead and allow only our two user-facing extension pages.
function isExtensionUiSender(sender) {
  const runtimeId = String(chrome?.runtime?.id || '');
  if (!runtimeId || sender?.id !== runtimeId || typeof sender?.url !== 'string') return false;
  try {
    return [...EXTENSION_UI_DOCUMENTS].some(documentName => (
      sender.url === chrome.runtime.getURL(documentName)
    ));
  } catch {
    return false;
  }
}

async function getConfig() {
  const c = await chrome.storage.local.get(['serverUrl', 'name', 'browserCredential', 'pendingBrowserCredential']);
  const pending = c.pendingBrowserCredential?.credentialId && c.pendingBrowserCredential?.privateKeyJwk?.d
    ? c.pendingBrowserCredential : null;
  const current = c.browserCredential?.credentialId && c.browserCredential?.privateKeyJwk?.d
    ? c.browserCredential : null;
  const credential = pending || current;
  return {
    serverUrl: credential?.serverUrl || c.serverUrl || '',
    name:      credential?.browserName || c.name || 'OE Bridge',
    browserCredential: credential,
    pendingCredential: Boolean(pending),
  };
}

// One-way migration from pre-pairing builds. General OE session bearers are
// never valid browser credentials and must not remain in extension storage.
chrome.storage.local.remove('token').catch(() => {});

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

async function readPage(tabId, expectedUrl = null) {
  // Inject a function that returns reduced page contents: text, links, and
  // JSON-LD, never raw HTML. This shrinks the attack surface but does NOT
  // neutralize prompt injection; every returned field remains untrusted data.
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expectedUrl) => {
      if (expectedUrl && location.href !== expectedUrl) {
        return { __oeDenied: true, reason: 'page changed before the one authorized read could run' };
      }
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
    args: [expectedUrl],
  });
  if (!result) throw new Error('scripting returned nothing — tab may be a chrome:// page (not scriptable) or just closed');
  if (result.__oeDenied) throw new Error(result.reason || 'page changed before read');
  return result;
}

async function openTab(url) {
  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id, url: tab.url || url, title: tab.title || '', windowId: tab.windowId };
}

// Resolve a media target only from tabs already inside the active lease.
// The exact tab/document is chosen before confirmation and revalidated before
// execution, so approving "pause" cannot retarget an unrelated audible tab.
async function resolveLeasedMediaTarget(maybeTabId) {
  if (Number.isFinite(Number(maybeTabId))) return validateLiveLeaseTarget(Number(maybeTabId));
  const lease = await getLease();
  if (!lease) throw new Error(NO_LEASE_HINT);
  const candidates = [];
  for (const entry of lease.tabs.filter(row => !row.suspended)) {
    try {
      const target = await validateLiveLeaseTarget(entry.tabId);
      const tab = await chrome.tabs.get(entry.tabId);
      candidates.push({ target, tab });
    } catch { /* stale lease entry is not a candidate */ }
  }
  const picked = candidates.find(row => row.tab.audible)
    || candidates.find(row => /youtube\.com|music\.youtube\.com|open\.spotify\.com|soundcloud\.com|music\.apple\.com|bandcamp\.com/.test(row.tab.url || ''))
    || candidates.find(row => row.tab.active)
    || candidates[0];
  if (!picked) throw new Error('no leased tab is available for media control');
  return picked.target;
}

async function mediaControl(tabId, expectedUrl, action) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (action, expectedUrl) => {
      if (location.href !== expectedUrl) {
        return { __oeDenied: true, reason: 'media tab changed before the confirmed action could run' };
      }
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
    args: [action, expectedUrl],
  });
  if (result?.__oeDenied) throw new Error(result.reason || 'media target changed before execution');
  return result || { tabUrl: expectedUrl, method: 'unknown' };
}

// Resolve an effective tabId — explicit id if passed, otherwise the active
// tab of the current focused window. Used by the nav primitives so the LLM
// doesn't have to enumerate to get a "use the one in front" call.
async function resolveTabId(maybeTabId) {
  if (Number.isFinite(Number(maybeTabId))) return Number(maybeTabId);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) throw new Error('no active tab to act on');
  return active.id;
}

async function closeTab(tabId) {
  const id = await resolveTabId(tabId);
  const tab = await chrome.tabs.get(id).catch(() => null);
  await chrome.tabs.remove(id);
  return { tabId: id, url: tab?.url, title: tab?.title };
}

async function focusTab(tabId) {
  const id = await resolveTabId(tabId);
  const tab = await chrome.tabs.update(id, { active: true });
  if (tab?.windowId != null) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
  }
  return { tabId: id, url: tab?.url, title: tab?.title, windowId: tab?.windowId };
}

async function tabBack(tabId) {
  const id = await resolveTabId(tabId);
  await chrome.tabs.goBack(id);
  const tab = await chrome.tabs.get(id).catch(() => null);
  return { tabId: id, url: tab?.url };
}

async function tabForward(tabId) {
  const id = await resolveTabId(tabId);
  await chrome.tabs.goForward(id);
  const tab = await chrome.tabs.get(id).catch(() => null);
  return { tabId: id, url: tab?.url };
}

async function tabReload(tabId) {
  const id = await resolveTabId(tabId);
  await chrome.tabs.reload(id);
  const tab = await chrome.tabs.get(id).catch(() => null);
  return { tabId: id, url: tab?.url };
}

// Vision primitives — screenshot + xy click + type + keypress.
//
// browser_screenshot uses chrome.tabs.captureVisibleTab which captures the
// VISIBLE viewport (not the full scrollable page) of the focused tab in
// the focused window. We bring the target to the front first so the
// capture lands on the right tab.
async function screenshot(tabId, expectedUrl = null) {
  const id = Number(tabId);
  const tab = await chrome.tabs.get(id);
  if (expectedUrl && tab.url !== expectedUrl) throw new Error('page changed before screenshot');
  // Make sure the tab is the active one in its window — captureVisibleTab
  // only captures the focused tab. Don't focus the window itself, the
  // user doesn't need their desktop disturbed for an offscreen automation.
  if (!tab.active) await chrome.tabs.update(id, { active: true });
  const [captureTarget] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (captureTarget?.id !== id || (expectedUrl && captureTarget.url !== expectedUrl)) {
    throw new Error('target tab changed before screenshot');
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const [capturedTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (capturedTab?.id !== id || (expectedUrl && capturedTab.url !== expectedUrl)) {
    throw new Error('target tab changed while screenshot was captured');
  }
  // dataUrl is "data:image/png;base64,<b64>" — strip prefix.
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  // Get viewport dims via a quick scripting probe — captureVisibleTab
  // doesn't report them.
  const [{ result: dims } = {}] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (expectedUrl) => location.href === expectedUrl
      ? ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 })
      : ({ __oeDenied: true }),
    args: [expectedUrl || capturedTab.url],
  });
  if (dims?.__oeDenied) throw new Error('page changed while screenshot was captured');
  return {
    base64,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    devicePixelRatio: dims?.devicePixelRatio ?? 1,
    tabId: id,
    tabUrl: tab.url,
    tabTitle: tab.title,
  };
}

async function inspectClickTarget(tabId, x, y, expectedUrl = null) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click coordinates must be finite numbers');
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId) },
    func: (x, y, expectedUrl) => {
      if (expectedUrl && location.href !== expectedUrl) return { ok: false, reason: 'page changed before click inspection' };
      const raw = document.elementFromPoint(x, y);
      if (!raw) return { ok: false, reason: `no element at (${x}, ${y})` };
      const el = raw.closest?.('a,button,input,select,textarea,[role="button"],[role="link"]') || raw;
      const tag = el.tagName.toLowerCase();
      const type = String(el.type || el.getAttribute?.('type') || '').toLowerCase();
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      const label = String(el.innerText || el.value || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 120);
      const href = el.href && /^https?:/i.test(el.href) ? el.href.slice(0, 1000) : null;
      const isSubmit = Boolean(el.form && ((tag === 'button' && (type || 'submit') === 'submit')
        || (tag === 'input' && ['submit', 'image'].includes(type))));
      const highImpactText = /\b(?:buy|purchase|pay|place order|checkout|submit|send|publish|post|delete|remove|cancel (?:account|subscription)|download|install|sign out|log out|confirm|book|reserve)\b/i;
      const highImpactPath = /\/(?:checkout|payment|billing|delete|download|logout|signout)(?:[/?#]|$)/i;
      const sameOriginAnchor = tag === 'a' && href && new URL(href).origin === location.origin;
      const safeOrdinary = Boolean(sameOriginAnchor && !el.hasAttribute('download') && !highImpactText.test(label) && !highImpactPath.test(new URL(href).pathname));
      const descriptor = {
        tag, type, role, label, href,
        id: String(el.id || '').slice(0, 100),
        name: String(el.getAttribute?.('name') || '').slice(0, 100),
        isSubmit,
        inForm: Boolean(el.closest?.('form')),
        download: Boolean(el.hasAttribute?.('download')),
      };
      return {
        ok: true,
        descriptor,
        fingerprint: JSON.stringify(descriptor),
        requiresConfirmation: !safeOrdinary,
        summary: label ? `<${tag}> “${label}”` : `<${tag}> at (${Math.round(x)}, ${Math.round(y)})`,
      };
    },
    args: [x, y, expectedUrl],
  });
  if (!result?.ok) throw new Error(result?.reason || 'click inspection failed');
  return result;
}

// Execute exactly one activation after policy classification. If a user
// confirmed an ambiguous/high-impact target, the target fingerprint must be
// byte-identical immediately before execution so a page cannot swap the
// element under the confirmation dialog.
async function clickXY(tabId, x, y, expectedUrl = null, { confirmed = false, fingerprint = null } = {}) {
  const id = Number(tabId);
  // Visual indicator — pulsing ring + element outline so the user can
  // SEE where the click is landing. Fire BEFORE the actual click so the
  // visual is on-screen when the page reacts.
  try { await chrome.tabs.sendMessage(id, { type: 'oe_visual_click', x, y }); } catch {}
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (x, y, expectedUrl, confirmed, expectedFingerprint) => {
      if (expectedUrl && location.href !== expectedUrl) {
        return { ok: false, reason: 'page changed before click' };
      }
      const raw = document.elementFromPoint(x, y);
      if (!raw) return { ok: false, reason: `no element at (${x}, ${y})` };
      const el = raw.closest?.('a,button,input,select,textarea,[role="button"],[role="link"]') || raw;
      // Submit controls are always-confirm territory: refuse before any
      // event fires so a click can't be a disguised form submission.
      // (button.type defaults to "submit" inside a form.)
      const ctl = el.closest ? el.closest('button, input') : null;
      const isSubmitControl = !!(ctl && ctl.form &&
        ((ctl.tagName === 'BUTTON' && ctl.type === 'submit') ||
         (ctl.tagName === 'INPUT' && (ctl.type === 'submit' || ctl.type === 'image'))));
      if (isSubmitControl) {
        if (!confirmed) return { ok: false, reason: 'refused: that element submits a form and requires explicit user confirmation' };
      }
      const tag = el.tagName.toLowerCase();
      const type = String(el.type || el.getAttribute?.('type') || '').toLowerCase();
      const descriptor = {
        tag,
        type,
        role: String(el.getAttribute?.('role') || '').toLowerCase(),
        label: String(el.innerText || el.value || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        href: el.href && /^https?:/i.test(el.href) ? el.href.slice(0, 1000) : null,
        id: String(el.id || '').slice(0, 100),
        name: String(el.getAttribute?.('name') || '').slice(0, 100),
        isSubmit: isSubmitControl,
        inForm: Boolean(el.closest?.('form')),
        download: Boolean(el.hasAttribute?.('download')),
      };
      if (expectedFingerprint && JSON.stringify(descriptor) !== expectedFingerprint) {
        return { ok: false, reason: 'the click target changed after it was inspected; nothing was clicked' };
      }
      // Unconfirmed "safe link" actions navigate directly to the inspected
      // same-origin href. Calling page-controlled .click() would let an
      // ordinary-looking anchor run arbitrary application handlers instead.
      if (!confirmed && tag === 'a' && descriptor.href
          && new URL(descriptor.href).origin === location.origin && !descriptor.download) {
        location.assign(descriptor.href);
        return { ok: true, elementSummary: `<a> "${descriptor.label || descriptor.href}"` };
      }
      window.__oeSyntheticActionTs = Date.now();
      window.__oeConfirmedActionTs = confirmed ? window.__oeSyntheticActionTs : 0;
      const summarize = (e) => {
        const tag = e.tagName.toLowerCase();
        const text = (e.innerText || e.value || e.getAttribute('aria-label') || '').slice(0, 80).trim();
        const id = e.id ? `#${e.id}` : '';
        return `<${tag}${id}>${text ? ` "${text}"` : ''}`;
      };
      const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      // One activation only. HTMLElement.click() dispatches the click event
      // and performs the native default action; dispatchEvent('click') plus
      // .click() ran page handlers twice.
      try { if (typeof el.click === 'function') el.click(); }
      catch { el.dispatchEvent(new MouseEvent('click', opts)); }
      // If we clicked an input/textarea/contenteditable, leave it focused
      // so a follow-up browser_type lands there.
      try { if (el.focus) el.focus(); } catch {}
      return { ok: true, elementSummary: summarize(el) };
    },
    args: [x, y, expectedUrl, confirmed, fingerprint],
  });
  if (!result?.ok) throw new Error(result?.reason || 'click failed');
  return { x, y, elementSummary: result.elementSummary };
}

// Typing: send keydown/keypress/input/keyup for each character on the
// currently focused element. Falls back to setting .value if the element
// doesn't react to input events (some custom widgets).
async function typeText(tabId, text, expectedUrl = null) {
  const id = Number(tabId);
  // Visual tooltip — small floating "⌨ <text>" bubble next to the
  // currently focused element so the user can see what's being typed.
  try { await chrome.tabs.sendMessage(id, { type: 'oe_visual_type', text }); } catch {}
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (text, expectedUrl) => {
      if (expectedUrl && location.href !== expectedUrl) return { ok: false, reason: 'page changed before typing' };
      const el = document.activeElement;
      if (!el || el === document.body) return { ok: false, reason: 'no focused element to type into' };
      const tag = String(el.tagName || '').toLowerCase();
      const type = String(el.getAttribute?.('type') || 'text').toLowerCase();
      const autocomplete = String(el.getAttribute?.('autocomplete') || '').toLowerCase();
      const identity = `${el.id || ''} ${el.getAttribute?.('name') || ''} ${el.getAttribute?.('aria-label') || ''}`;
      const sensitive = type === 'password' ||
        /^(cc-|current-password|new-password|one-time-code)/i.test(autocomplete) ||
        /password|passcode|credit|card.?(number|cvv|cvc)|security.?code|one.?time.?code/i.test(identity);
      if (sensitive) return { ok: false, reason: 'refused: OE never types into password, payment, or one-time-code fields' };
      const textInputTypes = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week']);
      const editable = tag === 'textarea' || el.isContentEditable || (tag === 'input' && textInputTypes.has(type));
      if (!editable) return { ok: false, reason: 'focused element is not a non-sensitive editable text field' };
      const summarize = (e) => {
        const tag = e.tagName.toLowerCase();
        const placeholder = e.getAttribute?.('placeholder') || '';
        const aria = e.getAttribute?.('aria-label') || '';
        return `<${tag}${e.id ? '#'+e.id : ''}${placeholder ? ` placeholder="${placeholder.slice(0, 40)}"` : ''}${aria ? ` aria-label="${aria.slice(0, 40)}"` : ''}>`;
      };
      window.__oeSyntheticActionTs = Date.now();
      const sendChar = (char) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true }));
        if ('value' in el) {
          el.value = (el.value || '') + char;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: char, inputType: 'insertText' }));
        } else if (el.isContentEditable) {
          // contenteditable — use execCommand as a fallback
          try { document.execCommand('insertText', false, char); } catch {}
        }
        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true }));
      };
      for (const ch of text) sendChar(ch);
      return { ok: true, elementSummary: summarize(el) };
    },
    args: [text, expectedUrl],
  });
  if (!result?.ok) throw new Error(result?.reason || 'type failed');
  return { length: text.length, elementSummary: result.elementSummary };
}

async function keypress(tabId, key, expectedUrl = null) {
  const id = Number(tabId);
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (key, expectedUrl) => {
      if (expectedUrl && location.href !== expectedUrl) return { ok: false, reason: 'page changed before keypress' };
      const el = document.activeElement || document.body;
      const summarize = (e) => `<${(e.tagName || 'document').toLowerCase()}${e.id ? '#'+e.id : ''}>`;
      // Stamp the isolated world so the content script's capture-phase
      // submit guard can tell an OE-triggered submit from a user one.
      window.__oeSyntheticActionTs = Date.now();
      const opts = { key, code: key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      // Some sites listen for keypress (deprecated but real-world common).
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      // Deliberately NO requestSubmit()/submit() fallback on Enter:
      // submitting a form is an always-confirm action (submit_form), never
      // a side effect of a keypress. A synthetic Enter the page ignores
      // just gets ignored.
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      return { ok: true, elementSummary: summarize(el) };
    },
    args: [key, expectedUrl],
  });
  if (!result?.ok) throw new Error(result?.reason || 'keypress failed');
  return { key, elementSummary: result?.elementSummary };
}

// Browser routines replay accessibility-addressed semantic steps only. The
// server stores the routine, but the extension independently validates the
// wire object before it ever reaches page context. Selectors, coordinates,
// scripts, secrets, and cross-origin destinations have no representation.
function validateRoutineStep(step, grantedOrigin) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('routine step must be an object');
  const type = String(step.type || '');
  const allowedByType = {
    navigate: new Set(['type', 'origin', 'path']),
    click: new Set(['type', 'origin', 'target']),
    fill: new Set(['type', 'origin', 'target', 'value']),
    select: new Set(['type', 'origin', 'target', 'option']),
    toggle: new Set(['type', 'origin', 'target', 'checked']),
    wait_for: new Set(['type', 'origin', 'target', 'state', 'timeoutMs']),
  };
  const allowed = allowedByType[type];
  if (!allowed) throw new Error(`unsupported routine step type: ${type || '(missing)'}`);
  for (const key of Object.keys(step)) if (!allowed.has(key)) throw new Error(`unsupported routine step field: ${key}`);
  if (String(step.origin || '') !== grantedOrigin) throw new Error('routine step origin does not match the active lease');
  if (type === 'navigate') {
    if (typeof step.path !== 'string' || !step.path.startsWith('/') || step.path.startsWith('//') || step.path.length > 1500) {
      throw new Error('routine navigation must use a same-origin absolute path');
    }
    const destination = new URL(step.path, `${grantedOrigin}/`);
    if (destination.origin !== grantedOrigin || destination.username || destination.password) {
      throw new Error('routine navigation may not leave its granted origin');
    }
    if (/(?:password|passwd|passcode|otp|token|secret|api[_-]?key)=/i.test(`${destination.search}${destination.hash}`)) {
      throw new Error('routine navigation may not contain credentials or secrets');
    }
    return { type, origin: grantedOrigin, path: `${destination.pathname}${destination.search}${destination.hash}` };
  }
  const target = step.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('routine step requires a semantic target');
  const targetKeys = new Set(['role', 'name', 'label', 'ordinal', 'exact']);
  for (const key of Object.keys(target)) if (!targetKeys.has(key)) throw new Error(`unsupported routine target field: ${key}`);
  const roles = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'spinbutton']);
  const role = String(target.role || '').toLowerCase();
  if (!roles.has(role)) throw new Error('routine target has an unsupported semantic role');
  const clean = value => value == null ? null : String(value).replace(/\s+/g, ' ').trim();
  const name = clean(target.name);
  const label = clean(target.label);
  if ((!name && !label) || (name?.length || 0) > 160 || (label?.length || 0) > 160) {
    throw new Error('routine target requires a short accessible name or label');
  }
  const ordinal = target.ordinal == null ? 1 : Number(target.ordinal);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 20) throw new Error('routine target ordinal is invalid');
  if (target.exact != null && typeof target.exact !== 'boolean') throw new Error('routine target exact flag is invalid');
  const normalized = { role, name, label, ordinal, exact: target.exact !== false };
  const identity = `${name || ''} ${label || ''}`;
  if (/password|passcode|otp|one.?time|credit|card.?number|cvv|cvc|security.?code|routing.?number|bank.?account|\biban\b|\bswift\b|social.?security|\bssn\b|medical.?record|patient.?id|member.?id|api.?key|access.?token|secret/i.test(identity)) {
    throw new Error('routine targets a sensitive field');
  }
  if (type === 'fill') {
    if (!['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role) || typeof step.value !== 'string' || !step.value || step.value.length > 500) {
      throw new Error('routine fill step is invalid');
    }
    const compact = step.value.trim();
    const digits = compact.replace(/[\s-]/g, '');
    const luhn = /^\d{13,19}$/.test(digits) && (() => {
      let sum = 0;
      let double = false;
      for (let i = digits.length - 1; i >= 0; i -= 1) {
        let digit = Number(digits[i]);
        if (double) { digit *= 2; if (digit > 9) digit -= 9; }
        sum += digit;
        double = !double;
      }
      return sum % 10 === 0;
    })();
    if (/\{\{|\}\}|<%|%>|\$\{|javascript:|(?:password|passwd|passcode|otp|cvv|cvc|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret)\s*[:=]/i.test(compact) ||
        /^(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})$/.test(compact) ||
        /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(compact) ||
        /^[a-f0-9]{32,}$/i.test(compact) || /^\d{4,9}$/.test(compact) || luhn) {
      throw new Error('routine fill value may not contain templates, code, or secrets');
    }
    return { type, origin: grantedOrigin, target: normalized, value: step.value };
  }
  if (type === 'select') {
    if (!['combobox', 'listbox'].includes(role) || typeof step.option !== 'string' || !step.option || step.option.length > 160) {
      throw new Error('routine select step is invalid');
    }
    return { type, origin: grantedOrigin, target: normalized, option: step.option };
  }
  if (type === 'toggle') {
    if (!['checkbox', 'radio', 'switch'].includes(role) || typeof step.checked !== 'boolean') throw new Error('routine toggle step is invalid');
    return { type, origin: grantedOrigin, target: normalized, checked: step.checked };
  }
  if (type === 'wait_for') {
    const states = new Set(['visible', 'hidden', 'enabled', 'disabled']);
    const timeoutMs = Number(step.timeoutMs ?? 5000);
    if (!states.has(step.state) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) {
      throw new Error('routine wait step is invalid');
    }
    return { type, origin: grantedOrigin, target: normalized, state: step.state, timeoutMs };
  }
  if (type !== 'click' || !['button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'option'].includes(role)) {
    throw new Error('routine click step is invalid');
  }
  return { type, origin: grantedOrigin, target: normalized };
}

// Self-contained because Chrome serializes this function into an isolated
// page world. `phase=inspect` returns a fingerprint and risk decision;
// `phase=execute` re-resolves the target and requires the same fingerprint.
async function routinePageOperation(step, expectedUrl, phase, confirmed, expectedFingerprint) {
  if (expectedUrl && location.href !== expectedUrl) return { ok: false, reason: 'page changed before routine step' };
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
  const roleOf = el => {
    const explicit = norm(el.getAttribute?.('role')).toLowerCase();
    if (explicit) return explicit;
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.getAttribute?.('type') || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return '';
  };
  const labelOf = el => {
    const labelledBy = norm(el.getAttribute?.('aria-labelledby')).split(/\s+/).filter(Boolean)
      .map(id => norm(document.getElementById(id)?.innerText)).filter(Boolean).join(' ');
    const native = Array.from(el.labels || []).map(label => norm(label.innerText)).filter(Boolean).join(' ');
    return norm(labelledBy || native || el.closest?.('label')?.innerText);
  };
  const nameOf = el => norm(el.getAttribute?.('aria-label') || labelOf(el) || el.innerText || el.value || el.getAttribute?.('placeholder') || el.getAttribute?.('name'));
  const matches = (actual, wanted, exact) => {
    if (!wanted) return true;
    const a = norm(actual).toLocaleLowerCase();
    const w = norm(wanted).toLocaleLowerCase();
    return exact ? a === w : a.includes(w);
  };
  const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role]')).slice(0, 10_000)
    .filter(el => roleOf(el) === step.target.role)
    .filter(el => matches(nameOf(el), step.target.name, step.target.exact))
    .filter(el => matches(labelOf(el), step.target.label, step.target.exact));
  const el = candidates[step.target.ordinal - 1] || null;
  if (!el) {
    if (step.type === 'wait_for' && step.state === 'hidden') return { ok: true, state: 'hidden', absent: true };
    return { ok: false, reason: `could not find ${step.target.role} “${step.target.name || step.target.label}”` };
  }
  const tag = String(el.tagName || '').toLowerCase();
  const type = String(el.getAttribute?.('type') || '').toLowerCase();
  const autocomplete = String(el.getAttribute?.('autocomplete') || '').toLowerCase();
  const identity = `${el.id || ''} ${el.getAttribute?.('name') || ''} ${el.getAttribute?.('aria-label') || ''} ${labelOf(el)}`;
  const sensitive = type === 'password' || /^(?:cc-|current-password|new-password|one-time-code)/i.test(autocomplete) ||
    /password|passcode|credit|card.?(?:number|cvv|cvc)|security.?code|one.?time.?code|otp|routing.?number|bank.?account|\biban\b|\bswift\b|social.?security|\bssn\b|medical.?record|patient.?id|member.?id|api.?key|access.?token|secret/i.test(identity);
  if (sensitive) return { ok: false, reason: 'routine target became a sensitive field' };
  const href = el.href && /^https?:/i.test(el.href) ? el.href : null;
  if (href && new URL(href).origin !== location.origin) return { ok: false, reason: 'routine link would leave its granted origin' };
  if (el.hasAttribute?.('download')) return { ok: false, reason: 'routine downloads are not supported' };
  const isSubmit = Boolean(el.form && ((tag === 'button' && (type || 'submit') === 'submit') ||
    (tag === 'input' && ['submit', 'image'].includes(type))));
  const summaryText = norm(nameOf(el) || labelOf(el)).slice(0, 160);
  const highImpact = /\b(?:buy|purchase|pay|checkout|place (?:the )?order|order now|book|reserve|transfer|send money|bid|submit|send|post|publish|share|upload|delete|erase|remove|cancel|terminate|close (?:my |the )?account|sign[ -]?(?:in|out|up)|log[ -]?(?:in|out)|subscribe|unsubscribe|download|install|confirm|continue|finish|save|accept|agree|approve)\b/i
    .test(`${summaryText} ${step.option || ''}`);
  const requiresConfirmation = isSubmit || highImpact;
  const descriptor = {
    role: roleOf(el), name: nameOf(el).slice(0, 160), label: labelOf(el).slice(0, 160),
    tag, type, id: String(el.id || '').slice(0, 100), fieldName: String(el.getAttribute?.('name') || '').slice(0, 100),
    href: href?.slice(0, 1000) || null, isSubmit,
  };
  const fingerprint = JSON.stringify(descriptor);
  if (phase === 'inspect') return {
    ok: true, fingerprint, requiresConfirmation,
    summary: `${step.type} ${step.target.role} “${summaryText || step.target.name || step.target.label}”`,
  };
  if (expectedFingerprint && fingerprint !== expectedFingerprint) return { ok: false, reason: 'routine target changed after inspection' };
  if (requiresConfirmation && !confirmed) return { ok: false, reason: 'routine step requires explicit confirmation' };
  window.__oeSyntheticActionTs = Date.now();
  window.__oeConfirmedActionTs = confirmed ? window.__oeSyntheticActionTs : 0;

  if (step.type === 'click') {
    el.click();
    return { ok: true, summary: `clicked ${step.target.role} “${summaryText}”` };
  }
  if (step.type === 'fill') {
    const editable = tag === 'textarea' || el.isContentEditable || (tag === 'input' && !['hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'image'].includes(type));
    if (!editable) return { ok: false, reason: 'routine fill target is no longer editable' };
    el.focus?.();
    if ('value' in el) {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, step.value); else el.value = step.value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: step.value, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else {
      el.textContent = step.value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: step.value, inputType: 'insertText' }));
    }
    return { ok: true, summary: `filled ${step.target.role} “${summaryText}”` };
  }
  if (step.type === 'select') {
    if (tag !== 'select') return { ok: false, reason: 'routine select target is no longer a native select control' };
    const wanted = norm(step.option).toLocaleLowerCase();
    const option = Array.from(el.options || []).find(item => norm(item.textContent).toLocaleLowerCase() === wanted || norm(item.value).toLocaleLowerCase() === wanted);
    if (!option) return { ok: false, reason: `could not find taught option “${step.option}”` };
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true, summary: `selected “${norm(option.textContent)}”` };
  }
  if (step.type === 'toggle') {
    const checkedNow = () => Boolean(el.checked ?? el.getAttribute?.('aria-checked') === 'true');
    if (checkedNow() !== step.checked) el.click();
    if (checkedNow() !== step.checked) return { ok: false, reason: 'toggle did not reach the taught state' };
    return { ok: true, summary: `${step.checked ? 'enabled' : 'disabled'} ${step.target.role} “${summaryText}”` };
  }
  if (step.type === 'wait_for') {
    const deadline = Date.now() + step.timeoutMs;
    const stateNow = node => {
      const style = getComputedStyle(node);
      const visible = node.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
      const enabled = !node.disabled && node.getAttribute?.('aria-disabled') !== 'true';
      return { visible, enabled };
    };
    while (Date.now() <= deadline) {
      const state = stateNow(el);
      if ((step.state === 'visible' && state.visible) || (step.state === 'hidden' && !state.visible) ||
          (step.state === 'enabled' && state.enabled) || (step.state === 'disabled' && !state.enabled)) {
        return { ok: true, state: step.state };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { ok: false, reason: `timed out waiting for target to become ${step.state}` };
  }
  return { ok: false, reason: 'unsupported routine operation' };
}

async function inspectRoutineStep(tabId, step, expectedUrl) {
  if (step.type === 'navigate') return { ok: true, requiresConfirmation: false, fingerprint: null, summary: `navigate to ${step.path}` };
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId) },
    func: routinePageOperation,
    args: [step, expectedUrl, 'inspect', false, null],
  });
  if (!result?.ok) throw new Error(result?.reason || 'routine target inspection failed');
  return result;
}

async function executeRoutineStep(tabId, step, expectedUrl, { confirmed = false, fingerprint = null } = {}) {
  if (step.type === 'navigate') {
    const destination = new URL(step.path, `${step.origin}/`).href;
    const sensitive = await sensitiveMatch(destination);
    if (sensitive) throw new Error(`routine navigation refused because the destination is ${sensitive}`);
    const tab = await chrome.tabs.update(Number(tabId), { url: destination });
    return { ok: true, summary: `navigated to ${destination}`, url: tab?.url || destination };
  }
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId) },
    func: routinePageOperation,
    args: [step, expectedUrl, 'execute', confirmed, fingerprint],
  });
  if (!result?.ok) throw new Error(result?.reason || 'routine step failed');
  return result;
}

async function focusWindow() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.windowId != null) {
    try { await chrome.windows.update(active.windowId, { focused: true, drawAttention: true }); } catch {}
    return { windowId: active.windowId, focusedTab: active.id };
  }
  // Fallback: grab any window and focus it.
  const wins = await chrome.windows.getAll();
  const w = wins[0];
  if (w?.id != null) {
    try { await chrome.windows.update(w.id, { focused: true, drawAttention: true }); } catch {}
    return { windowId: w.id };
  }
  return { windowId: null };
}

// Chat persistence — popups and side panels are ephemeral; chrome
// can kill them between user interactions. Maintain the chat
// history + the currently-streaming response in chrome.storage.local
// so reopening either surface picks up exactly where we were. The
// SW keeps an in-memory mirror to avoid hitting storage on every
// token chunk.
let _chatCurrent = null; // { requestId, userText, assistantText, startedAt }
let _chatHistory = null; // [{ role:'user'|'assistant', text, ts }]
const CHAT_HISTORY_CAP = 80;

async function loadChatState() {
  try {
    const { chat_history, chat_current } = await chrome.storage.local.get(['chat_history', 'chat_current']);
    _chatHistory = Array.isArray(chat_history) ? chat_history : [];
    _chatCurrent = chat_current || null;
  } catch { _chatHistory = []; _chatCurrent = null; }
}
loadChatState();

let _chatPersistTimer = null;
function persistChatSoon() {
  // Coalesce: streaming tokens fire constantly; one write per ~250 ms
  // is plenty and survives popup/sidepanel close mid-response.
  if (_chatPersistTimer) return;
  _chatPersistTimer = setTimeout(() => {
    _chatPersistTimer = null;
    chrome.storage.local.set({ chat_current: _chatCurrent, chat_history: _chatHistory }).catch(() => {});
  }, 250);
}

function chatBegin(requestId, userText) {
  _chatCurrent = { requestId, userText, assistantText: '', startedAt: Date.now() };
  persistChatSoon();
}

function chatSetUserText(requestId, userText) {
  if (!_chatCurrent || _chatCurrent.requestId !== requestId) return;
  _chatCurrent.userText = String(userText || '').slice(0, 4_100);
  persistChatSoon();
}

function chatAppendToken(text) {
  if (!_chatCurrent || typeof text !== 'string') return;
  _chatCurrent.assistantText += text;
  persistChatSoon();
}

function chatFinish(error = null) {
  if (!_chatCurrent) return;
  _chatHistory ||= [];
  _chatHistory.push({ role: 'user', text: _chatCurrent.userText, ts: _chatCurrent.startedAt });
  _chatHistory.push({
    role: 'assistant',
    text: _chatCurrent.assistantText || (error ? `[error: ${error}]` : ''),
    ts: Date.now(),
  });
  while (_chatHistory.length > CHAT_HISTORY_CAP) _chatHistory.shift();
  _chatCurrent = null;
  // Final write skips the debounce so the storage is consistent before
  // any popup-open read.
  if (_chatPersistTimer) { clearTimeout(_chatPersistTimer); _chatPersistTimer = null; }
  chrome.storage.local.set({ chat_current: null, chat_history: _chatHistory }).catch(() => {});
}

function chatClear() {
  _chatCurrent = null;
  _chatHistory = [];
  chrome.storage.local.set({ chat_current: null, chat_history: [] }).catch(() => {});
}

// Observation buffer — events the user fired in their own tabs while
// watch mode was on. Per-tab, capped at 200 events / 5 minutes.
//
// Legacy global Watch Mode is gone. Teach Mode is a separate tab/origin-bound
// grant minted only by a direct click in extension UI. It expires, dies on a
// browser restart, and stops (rather than following) on navigation.
let _watchMode = false;
let _watchModeLoaded = false;
let _teachGrant = null; // {tabId, origin, grantedAt, expiresAt}
const _pendingObservations = []; // queue events that arrive during async load
const TEACH_DURATION_MS = 15 * 60_000;

async function _loadWatchMode() {
  try {
    const { teachGrant } = await _sessionStore().get(['teachGrant']);
    if (teachGrant?.tabId && teachGrant?.origin && Number(teachGrant.expiresAt) > Date.now()) {
      const tab = await chrome.tabs.get(Number(teachGrant.tabId)).catch(() => null);
      if (tab?.url && originOf(tab.url) === teachGrant.origin && !(await sensitiveMatch(tab.url))) {
        _teachGrant = teachGrant;
      }
    }
  } catch {}
  _watchMode = Boolean(_teachGrant);
  if (!_watchMode) {
    _teachGrant = null;
    try { await _sessionStore().remove(['teachGrant', 'watchMode']); } catch {}
  }
  try { await chrome.storage.local.remove(['watchMode']); } catch {}
  _watchModeLoaded = true;
  // Replay anything we buffered during the async load — if watch mode
  // ended up on, those events get buffered properly; if off, they're
  // dropped at pushObservation (which is what would have happened
  // anyway).
  console.log(`[OE-bg] watch mode loaded from storage: ${_watchMode}, replaying ${_pendingObservations.length} pending`);
  while (_pendingObservations.length) {
    const { tabId, event } = _pendingObservations.shift();
    pushObservation(tabId, event);
  }
  updateActionIndicator().catch(() => {});
}
function _saveWatchMode() {
  try {
    if (_teachGrant) _sessionStore().set({ teachGrant: _teachGrant }).catch(() => {});
    else _sessionStore().remove(['teachGrant', 'watchMode']).catch(() => {});
  } catch {}
}
_loadWatchMode();
let _observations = new Map(); // tabId -> Array<event>
const OBS_MAX_PER_TAB = 200;
const OBS_TTL_MS = 5 * 60_000;

// Persist observations to chrome.storage.session — same lifecycle as the
// browser session (clears on browser restart, not on SW eviction).
// Without this, the SW dies in idle, respawns when Chey queries, and
// the in-memory Map is empty even though events were captured. session
// storage is the right scope: events are inherently transient + we
// don't want them surviving a full browser restart for privacy.
let _observationsLoaded = false;
function _sessionStore() {
  // Security grants and observation buffers must die with the browser.
  // Falling back to storage.local can resurrect an expired/revoked grant
  // after restart, so unsupported browsers fail closed instead.
  if (!chrome?.storage?.session) throw new Error('session storage is unavailable');
  return chrome.storage.session;
}
async function _loadObservations() {
  try {
    const { observations } = await _sessionStore().get(['observations']);
    if (observations && typeof observations === 'object') {
      _observations = new Map(Object.entries(observations).map(([k, v]) => [Number(k), v || []]));
    }
  } catch { /* session storage unavailable — fresh start */ }
  _observationsLoaded = true;
  console.log(`[OE-bg] observations loaded from session storage: ${_observations.size} tab(s)`);
}
let _obsPersistTimer = null;
function _saveObservations() {
  // Debounce — clicks come in bursts; one storage write per ~300ms is
  // plenty to survive an SW eviction.
  if (_obsPersistTimer) return;
  _obsPersistTimer = setTimeout(() => {
    _obsPersistTimer = null;
    const obj = {};
    for (const [k, v] of _observations) obj[k] = v;
    _sessionStore().set({ observations: obj }).catch(() => {});
  }, 300);
}
_loadObservations();

function pushObservation(tabId, event) {
  if (!_watchMode || !_teachGrant || Number(tabId) !== Number(_teachGrant.tabId)) return;
  if (!tabId) return;
  const arr = _observations.get(tabId) || [];
  arr.push({ ...event, recvTs: Date.now() });
  // Drop old by count + time
  const cutoff = Date.now() - OBS_TTL_MS;
  while (arr.length > OBS_MAX_PER_TAB) arr.shift();
  while (arr.length && arr[0].recvTs < cutoff) arr.shift();
  _observations.set(tabId, arr);
  _saveObservations();
}

function clearObservations() {
  _observations.clear();
  _sessionStore().remove(['observations']).catch(() => {});
}

async function broadcastWatchMode(tabIds = []) {
  for (const tabId of [...new Set(tabIds.filter(Number.isFinite))]) {
    const on = Boolean(_watchMode && _teachGrant && Number(_teachGrant.tabId) === Number(tabId));
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'oe_watch_mode',
        on,
        expiresAt: on ? _teachGrant.expiresAt : null,
      });
    } catch { /* tab without content script */ }
  }
  await updateActionIndicator();
}

async function getTeachGrant() {
  if (!_watchModeLoaded) await _loadWatchMode();
  if (!_teachGrant) return null;
  if (Date.now() >= Number(_teachGrant.expiresAt)) {
    await stopTeachGrant('expired');
    return null;
  }
  const tab = await chrome.tabs.get(Number(_teachGrant.tabId)).catch(() => null);
  const sensitive = tab?.url ? await sensitiveMatch(tab.url) : 'a closed page';
  if (!tab?.url || originOf(tab.url) !== _teachGrant.origin || sensitive) {
    await stopTeachGrant(sensitive ? `navigation to ${sensitive}` : 'cross-origin navigation');
    return null;
  }
  return _teachGrant;
}

async function startTeachGrant(tabId, expectedUrl) {
  if (!_watchModeLoaded) await _loadWatchMode();
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab?.url || tab.url !== expectedUrl) throw new Error('the page changed before Teach Mode could start');
  const sensitive = await sensitiveMatch(tab.url);
  if (sensitive) throw new Error(`Teach Mode cannot run here — this is ${sensitive}`);
  const origin = originOf(tab.url);
  if (!origin) throw new Error('this page has no safe web origin');
  const previousTabId = _teachGrant?.tabId;
  const grantedAt = Date.now();
  _teachGrant = { tabId: tab.id, origin, grantedAt, expiresAt: grantedAt + TEACH_DURATION_MS };
  _watchMode = true;
  clearObservations();
  await _sessionStore().set({ teachGrant: _teachGrant });
  await broadcastWatchMode([previousTabId, tab.id].filter(Number.isFinite));
  return _teachGrant;
}

async function stopTeachGrant(reason = 'stopped') {
  if (!_watchModeLoaded) await _loadWatchMode();
  const tabId = _teachGrant?.tabId;
  _teachGrant = null;
  _watchMode = false;
  clearObservations();
  try { await _sessionStore().remove(['teachGrant', 'watchMode']); } catch {}
  if (tabId) console.log(`[OE Bridge] Teach Mode stopped on tab ${tabId} (${reason})`);
  await broadcastWatchMode(tabId ? [tabId] : []);
}

function _filterSince(arr, sinceMs, limit = 50) {
  const cap = Number.isInteger(Number(limit)) ? Math.min(OBS_MAX_PER_TAB, Math.max(1, Number(limit))) : 50;
  const selected = Number.isFinite(sinceMs) ? arr.filter(e => e.recvTs >= sinceMs) : arr;
  return selected.slice(-cap);
}

// Resolve which tab to return observations for. Honors explicit tabId
// (rejecting 0 since Chrome never assigns it), otherwise auto-picks the
// tab with the most recent activity in the buffer. Final fallback to
// the active tab — useful when no events have been captured yet so the
// caller at least gets a real tabId in the response.
async function resolveObservationTabId(maybeTabId) {
  const n = Number(maybeTabId);
  if (Number.isFinite(n) && n > 0) return n;
  let newestTabId = null;
  let newestTs = 0;
  for (const [tabId, arr] of _observations) {
    if (arr.length && arr[arr.length - 1].recvTs > newestTs) {
      newestTs = arr[arr.length - 1].recvTs;
      newestTabId = tabId;
    }
  }
  if (newestTabId) return newestTabId;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id) return active.id;
    // Side panel / extension-page context may give nothing back — try
    // last-focused window as a fallback before giving up.
    const win = await chrome.windows.getLastFocused({ populate: true });
    const winActive = win?.tabs?.find(t => t.active);
    if (winActive?.id) return winActive.id;
  } catch {}
  return null;
}

async function getObservations(maybeTabId, sinceMs, limit = 50) {
  const tabId = await resolveObservationTabId(maybeTabId);
  const arr = tabId != null ? (_observations.get(tabId) || []) : [];
  // Surface ALL tabs we have buffered events for so the LLM can spot a
  // misroute ("I'm watching tabs [123, 456], you asked about tab 0").
  const watchedTabs = [];
  for (const [t, evs] of _observations) {
    if (evs.length) watchedTabs.push({ tabId: t, eventCount: evs.length, lastTs: evs[evs.length - 1].recvTs });
  }
  return { tabId, events: _filterSince(arr, sinceMs, limit), watchedTabs };
}

// ── Sensitive-origin fail-closed list. ─────────────────────────────────
// Sensitive pages are always-confirm territory, and no per-use
// confirmation UI exists yet — so lease grants, lease resumes, one-shot
// page asks, and OE-opened tabs all refuse outright on them. Curated
// categories (auth, banking, payments, password managers, health) plus
// the browser's own surfaces, plus the user's "never read this domain"
// list in storage. Returned phrases are nouns so callers can compose
// "this page is <phrase>".
const SENSITIVE_HOSTS = [
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com',
  'chromewebstore.google.com',
  'paypal.com', 'venmo.com', 'cash.app', 'wise.com',
  'chase.com', 'wellsfargo.com', 'bankofamerica.com', 'capitalone.com',
  'citi.com', 'usbank.com', 'ally.com', 'schwab.com', 'fidelity.com', 'vanguard.com',
  '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com', 'keepersecurity.com',
  'healthcare.gov',
];
const SENSITIVE_HOST_PATTERNS = [
  /^mychart\./i,
  /^(login|signin|auth|sso|id|account|accounts)\./i,
  /^(pay|payments|checkout|banking|bank)\./i,
];
const SENSITIVE_PATH_PATTERNS = [
  /^\/(login|signin|sign-in|signup|sign-up|oauth|authorize|auth)([/?#]|$)/i,
  /^\/(checkout|payment|payments|billing)([/?#]|$)/i,
];

// Returns a short human phrase when the URL must fail closed, else null.
function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some(n => n < 0 || n > 255)) return true;
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }

  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^(fc|fd)/i.test(host) || /^fe[89ab]/i.test(host)) return true;
    const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped && isPrivateHostname(mapped[1])) return true;
  }
  return false;
}

function originOf(url) {
  try { return new URL(String(url || '')).origin; } catch { return null; }
}

async function sensitiveMatch(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return 'a browser-internal or local page';
  let parsed;
  try { parsed = new URL(u); } catch { return 'an unparseable URL'; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (isPrivateHostname(host)) return 'a private, local, or intranet page';
  if (SENSITIVE_HOSTS.some(h => host === h || host.endsWith('.' + h)) ||
      SENSITIVE_HOST_PATTERNS.some(p => p.test(host)) ||
      SENSITIVE_PATH_PATTERNS.some(p => p.test(parsed.pathname))) {
    return 'a sensitive page (login / banking / payments / health / password manager)';
  }
  try {
    const { neverReadDomains } = await chrome.storage.local.get(['neverReadDomains']);
    for (const d of Array.isArray(neverReadDomains) ? neverReadDomains : []) {
      const dom = String(d).toLowerCase().replace(/^www\./, '');
      if (dom && (host === dom || host.endsWith('.' + dom))) {
        return `a page on this household's never-read list (${dom})`;
      }
    }
  } catch {}
  return null;
}

// ── Exact-field standing permissions ───────────────────────────────────
// These are intentionally separate from the general tab lease. A watch may
// open only its already-approved exact URL and read only its already-approved
// unique selector. It cannot inventory tabs remotely, navigate elsewhere,
// click, type, submit, capture HTML, or take a screenshot.
function canonicalFieldWatchUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('field watch requires a safe HTTP(S) URL');
  }
  for (const key of url.searchParams.keys()) {
    if (/(?:^|[-_])(?:access[-_]?token|token|auth|authorization|credential|key|password|secret|session|signature|sig)(?:$|[-_])/i.test(key)) {
      throw new Error('field watch URLs may not contain secret-bearing query parameters');
    }
  }
  url.hash = '';
  if (url.href.length > 2_048) throw new Error('field watch URL is too long');
  return url.href;
}

function sanitizePickedField(raw, exactUrl, title = '') {
  const input = raw && typeof raw === 'object' ? raw : {};
  const selector = String(input.selector || '').trim().slice(0, 500);
  const value = String(input.value || '').replace(/\s+/g, ' ').trim().slice(0, 512);
  if (!selector || !value) throw new Error('the selected field did not have a reliable locator and value');
  const property = ['price', 'availability', 'value', 'text'].includes(input.property)
    ? input.property : 'text';
  const parserType = ['price', 'number', 'text', 'availability'].includes(input.parser?.type)
    ? input.parser.type : 'text';
  const anchors = Array.isArray(input.anchors) ? input.anchors.slice(0, 5).map(anchor => ({
    text: String(anchor?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    relation: ['before', 'after', 'parent', 'near'].includes(anchor?.relation) ? anchor.relation : 'near',
  })).filter(anchor => anchor.text) : [];
  return {
    exactUrl,
    title: String(title || exactUrl).replace(/\s+/g, ' ').trim().slice(0, 300),
    field: { detector: 'dom', selector, property, anchors },
    parser: {
      type: parserType,
      currency: input.parser?.currency ? String(input.parser.currency).toUpperCase().slice(0, 8) : null,
      unit: input.parser?.unit ? String(input.parser.unit).slice(0, 32) : null,
    },
    initialValue: value,
    pickedAt: Date.now(),
    pickedTabId: null,
  };
}

async function stopFieldWatchPicker(tabId = null) {
  const stored = await _sessionStore().get([FIELD_WATCH_PICKER_KEY]).catch(() => ({}));
  const grant = stored?.[FIELD_WATCH_PICKER_KEY];
  const targetId = Number(tabId ?? grant?.tabId);
  try { if (Number.isFinite(targetId) && targetId > 0) await chrome.tabs.sendMessage(targetId, { type: 'oe_field_watch_picker_stop' }); } catch {}
  try { await _sessionStore().remove(FIELD_WATCH_PICKER_KEY); } catch {}
}

async function startFieldWatchPicker(tab) {
  if (!tab?.id || !tab.url) throw new Error('open a normal web page before choosing a field');
  const sensitive = await sensitiveMatch(tab.url);
  if (sensitive) throw new Error(`Field watches cannot run here — this is ${sensitive}.`);
  const exactUrl = canonicalFieldWatchUrl(tab.url);
  const grant = { tabId: tab.id, exactUrl, expiresAt: Date.now() + FIELD_WATCH_PICKER_TTL_MS };
  await _sessionStore().remove(FIELD_WATCH_SELECTION_KEY).catch(() => {});
  await _sessionStore().set({ [FIELD_WATCH_PICKER_KEY]: grant });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'oe_field_watch_picker_start' });
  } catch (error) {
    await _sessionStore().remove(FIELD_WATCH_PICKER_KEY).catch(() => {});
    throw new Error(`The field picker could not start on this page. Reload the page and try again. (${error?.message || error})`);
  }
  return grant;
}

function fieldWatchFailure(code, message) {
  return { ok: false, failure: { code: String(code).slice(0, 80), message: String(message).replace(/\s+/g, ' ').trim().slice(0, 240) } };
}

async function waitForExactFieldWatchTab(tabId, exactUrl, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!tab?.url) throw Object.assign(new Error('the exact watch page did not open'), { code: 'page_unavailable' });
    if (canonicalFieldWatchUrl(tab.url) !== exactUrl) {
      throw Object.assign(new Error('the watched URL redirected outside its exact standing permission'), { code: 'redirect_out_of_scope' });
    }
    if (tab.status === 'complete' || (!tab.status && attempt >= 1)) return tab;
    attempt += 1;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Object.assign(new Error('the exact watch page did not finish loading'), { code: 'timeout' });
}

async function executeBrowserFieldCheck(request) {
  const permission = request?.permission;
  let exactUrl;
  try { exactUrl = canonicalFieldWatchUrl(request?.exactUrl); }
  catch (error) { return fieldWatchFailure('invalid_spec', error?.message || error); }
  const selector = String(request?.field?.selector || '').trim();
  const fingerprint = String(request?.field?.fingerprint || '');
  let permissionUrl = null;
  try { permissionUrl = canonicalFieldWatchUrl(permission?.exactUrl); } catch {}
  const ownCredentialId = (await getConfig()).browserCredential?.credentialId || null;
  if (permission?.scope !== 'exact_url_field_read'
      || permissionUrl !== exactUrl
      || permission?.fieldFingerprint !== fingerprint
      || !ownCredentialId || permission?.executorCredentialId !== ownCredentialId
      || !selector || selector.length > 500 || !fingerprint) {
    return fieldWatchFailure('invalid_spec', 'field watch standing permission did not match its exact URL and selector');
  }
  const sensitive = await sensitiveMatch(exactUrl);
  if (sensitive) return fieldWatchFailure('url_blocked', `field watch refused ${sensitive}`);

  let tab = null;
  let created = false;
  try {
    // This inventory is local-only. OE receives neither the list nor any tab
    // metadata; it receives only the selected field's bounded value.
    const localTabs = await chrome.tabs.query({});
    tab = localTabs.find(candidate => {
      try { return candidate?.url && canonicalFieldWatchUrl(candidate.url) === exactUrl; }
      catch { return false; }
    }) || null;
    if (!tab) {
      tab = await chrome.tabs.create({ url: exactUrl, active: false });
      created = true;
    }
    tab = await waitForExactFieldWatchTab(tab.id, exactUrl);
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (expectedUrl, approvedSelector, maxChars) => {
        let liveUrl;
        try {
          const parsed = new URL(location.href);
          parsed.hash = '';
          liveUrl = parsed.href;
        } catch {
          return { ok: false, code: 'url_changed', message: 'live page URL was not readable' };
        }
        if (liveUrl !== expectedUrl) return { ok: false, code: 'redirect_out_of_scope', message: 'page changed before the approved field read' };
        let matches;
        try { matches = document.querySelectorAll(approvedSelector); }
        catch { return { ok: false, code: 'invalid_spec', message: 'approved field selector is invalid' }; }
        if (matches.length !== 1) {
          return { ok: false, code: 'locator_not_found', message: matches.length ? 'approved selector became ambiguous' : 'approved selector was not found' };
        }
        const element = matches[0];
        if (element.matches('input,textarea,select,[contenteditable="true"]')) {
          return { ok: false, code: 'field_blocked', message: 'form fields cannot be read by a standing field watch' };
        }
        const value = String(element.innerText || element.textContent || element.getAttribute('content') || '')
          .replace(/\s+/g, ' ').trim().slice(0, maxChars);
        if (!value) return { ok: false, code: 'value_missing', message: 'approved field had no readable value' };
        return { ok: true, value, pageUrl: liveUrl };
      },
      args: [exactUrl, selector, Math.min(512, Math.max(1, Number(request?.maxValueChars) || 512))],
    });
    if (!result?.ok) return fieldWatchFailure(result?.code || 'check_failed', result?.message || 'approved field could not be read');
    const after = await chrome.tabs.get(tab.id).catch(() => null);
    if (!after?.url || canonicalFieldWatchUrl(after.url) !== exactUrl || result.pageUrl !== exactUrl) {
      return fieldWatchFailure('redirect_out_of_scope', 'page changed during the exact field read');
    }
    return {
      ok: true,
      detection: {
        value: String(result.value).slice(0, 512),
        pageUrl: exactUrl,
        detector: 'dom',
        executor: 'browser',
        locatorFingerprint: fingerprint,
        confidence: 0.9,
        observedAt: Date.now(),
      },
    };
  } catch (error) {
    return fieldWatchFailure(error?.code || 'browser_check_failed', error?.message || error);
  } finally {
    if (created && tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

async function pollBrowserFieldWatches({ force = false } = {}) {
  const now = Date.now();
  if (_fieldWatchPollInFlight || (!force && now - _lastFieldWatchPollAt < FIELD_WATCH_POLL_INTERVAL_MS)) return;
  if (!_ws || _ws.readyState !== 1) return;
  _fieldWatchPollInFlight = true;
  _lastFieldWatchPollAt = now;
  try {
    const response = await sendBrowserRpc('field_watch_due', {}, { timeoutMs: 15_000 });
    for (const request of Array.isArray(response?.checks) ? response.checks : []) {
      const outcome = await executeBrowserFieldCheck(request);
      await sendBrowserRpc('field_watch_observe', {
        watchId: String(request?.watchId || '').slice(0, 100),
        ...(outcome.ok ? { detection: outcome.detection } : { failure: outcome.failure }),
      }, { timeoutMs: 15_000 });
    }
  } catch (error) {
    console.warn('[OE Bridge] field-watch poll failed:', error?.message || error);
  } finally {
    _fieldWatchPollInFlight = false;
  }
}

// ── Capability lease — the broker's grant state. ───────────────────────
// Server commands fail closed unless the user has granted OE a scoped,
// expiring lease ("this tab, 15 minutes") from the extension's own UI.
// A lease is a user-channel artifact: nothing the server sends and nothing
// on a page can create one. Each per-tab entry is bound to the ORIGIN the
// tab showed at grant time; navigation off that origin suspends the entry
// (grant survives, capability doesn't) until the user explicitly resumes.
// Persisted to storage.session so it survives MV3 SW eviction but NOT a
// browser restart — same privacy scope as the observation buffer.
const LEASE_DURATION_MS = 15 * 60_000;
let _lease = null; // { tabs: [{ tabId, origin, suspended, reason? }], grantedAt, expiresAt } | null
let _leaseLoaded = false;

async function _loadLease() {
  if (_leaseLoaded) return;
  try {
    const [{ lease }, { leaseDenyBefore = 0 }] = await Promise.all([
      _sessionStore().get(['lease']),
      chrome.storage.local.get(['leaseDenyBefore']),
    ]);
    const deniedByTombstone = lease && Number(lease.grantedAt || 0) <= Number(leaseDenyBefore || 0);
    _lease = (!deniedByTombstone && lease && Array.isArray(lease.tabs) && lease.tabs.length) ? lease : null;
  } catch { _lease = null; }
  _leaseLoaded = true;
  updateActionIndicator().catch(() => {});
}
async function _saveLease() {
  const denyBefore = Date.now();
  try {
    if (_lease) await _sessionStore().set({ lease: _lease });
    else await _sessionStore().remove(['lease']);
  } catch (e) {
    // A grant that cannot be durably written must never remain active only
    // in memory; otherwise SW eviction can resurrect older state. A local
    // tombstone is safe to persist because it can only DENY old grants.
    try { await chrome.storage.local.set({ leaseDenyBefore: denyBefore }); } catch {}
    _lease = null;
    throw e;
  }
}

function _leaseEntry(tabId) {
  return _lease?.tabs.find(t => t.tabId === tabId) || null;
}
// The broker's question: may OE act on this tab right now?
function leaseCovers(tabId) {
  const e = _leaseEntry(tabId);
  return !!(e && !e.suspended);
}

// Returns the active lease or null, lazily expiring it. All broker checks
// go through here so an expired lease can never authorize anything.
async function getLease() {
  await _loadLease();
  if (_lease && Date.now() >= _lease.expiresAt) await revokeLease('expired');
  return _lease;
}

async function grantLease(tabId, expectedUrl) {
  await _loadLease();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || tab.url !== expectedUrl) throw new Error('the tab changed before access could be granted — press Allow again');
  const sensitive = await sensitiveMatch(tab.url);
  if (sensitive) throw new Error(`access cannot be granted because this is ${sensitive}`);
  const origin = originOf(tab.url);
  if (!origin) throw new Error('the tab has no safe web origin');
  const affected = _lease ? _lease.tabs.map(t => t.tabId) : [];
  let grantedAt = Date.now();
  try {
    const { leaseDenyBefore = 0 } = await chrome.storage.local.get(['leaseDenyBefore']);
    grantedAt = Math.max(grantedAt, Number(leaseDenyBefore || 0) + 1);
  } catch {}
  // "Allow this tab" is deliberately singular. A later multi-tab grant will
  // be a separate explicit scope, not an accidental extension of this lease.
  _lease = {
    tabs: [{ tabId, origin, suspended: false }],
    grantedAt,
    expiresAt: grantedAt + LEASE_DURATION_MS,
  };
  await _saveLease();
  await broadcastLeaseState([...new Set([...affected, tabId])]);
  return _lease;
}

async function includeConfirmedOpenedTab(tabId, expectedUrl) {
  const lease = await getLease();
  if (!lease) throw new Error('the original browser lease expired before the new tab opened');
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab?.url || (expectedUrl && tab.url !== expectedUrl)) throw new Error('the opened tab changed before access could be bound');
  const sensitive = await sensitiveMatch(tab.url);
  if (sensitive) throw new Error(`the opened tab cannot receive access because it is ${sensitive}`);
  const origin = originOf(tab.url);
  if (!origin) throw new Error('the opened tab has no safe origin');
  lease.tabs = lease.tabs.filter(entry => entry.tabId !== tab.id);
  lease.tabs.push({ tabId: tab.id, origin, suspended: false, confirmedOpen: true });
  // A single confirmation cannot fan out indefinitely.
  if (lease.tabs.length > 4) lease.tabs = lease.tabs.slice(-4);
  await _saveLease();
  await broadcastLeaseState(lease.tabs.map(entry => entry.tabId));
  return tab;
}

async function revokeLease(reason = 'revoked') {
  await _loadLease();
  const affected = _lease ? _lease.tabs.map(t => t.tabId) : [];
  _lease = null;
  await _saveLease();
  if (affected.length) console.log(`[OE Bridge] lease cleared (${reason})`);
  await broadcastLeaseState(affected);
}

// Un-pause a suspended entry, re-binding it to the tab's CURRENT origin —
// read from the tab itself, never from the message that asked. Sensitive
// destinations refuse.
async function resumeLease(tabId) {
  await _loadLease();
  const entry = _leaseEntry(tabId);
  if (!entry) return { ok: false, error: 'this tab has no lease to resume — grant one from the extension popup' };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return { ok: false, error: 'could not read the tab state' };
  const sensitive = await sensitiveMatch(tab.url);
  if (sensitive) return { ok: false, error: `can't resume here — this is ${sensitive}` };
  try { entry.origin = new URL(tab.url).origin; } catch { entry.origin = null; }
  entry.suspended = false;
  delete entry.reason;
  await _saveLease();
  await broadcastLeaseState([tabId]);
  return { ok: true, lease: _lease };
}

async function broadcastLeaseState(tabIds) {
  for (const t of tabIds || []) {
    const entry = _lease ? _lease.tabs.find(x => x.tabId === t) : null;
    const state = !entry ? 'none' : (entry.suspended ? 'suspended' : 'active');
    try {
      await chrome.tabs.sendMessage(t, { type: 'oe_lease', state, expiresAt: _lease?.expiresAt ?? null });
    } catch { /* tab without content script (chrome:// etc.) */ }
  }
  await updateActionIndicator();
}

async function updateActionIndicator() {
  if (!chrome?.action?.setBadgeText) return;
  const awaitingConfirmation = Boolean(_pendingConfirmation && Date.now() < Number(_pendingConfirmation.expiresAt));
  const teaching = Boolean(_watchMode && _teachGrant && Date.now() < Number(_teachGrant.expiresAt));
  const active = _lease?.tabs?.some(t => !t.suspended);
  const paused = !active && _lease?.tabs?.length;
  const suggestion = Boolean(_activeSuggestion);
  const text = awaitingConfirmation ? '!' : (teaching ? 'T' : (active ? 'ON' : (paused ? 'Ⅱ' : (suggestion ? '1' : ''))));
  const color = awaitingConfirmation ? '#b91c1c' : (teaching ? '#b91c1c' : (active ? '#d97706' : (suggestion ? '#2563eb' : '#64748b')));
  const title = awaitingConfirmation
    ? 'OE Bridge — action waiting for your confirmation'
    : teaching
    ? 'OE Bridge — Teach Mode is observing one tab'
    : active
      ? 'OE Bridge — browser access active'
    : paused
      ? 'OE Bridge — browser access paused'
    : suggestion
      ? 'OE Bridge — something on this page may relate to one of your projects'
      : 'OE Bridge';
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    await chrome.action.setTitle({ title });
  } catch {}
}

function publicConfirmation(value) {
  if (!value) return null;
  return {
    id: value.id,
    action: value.action,
    summary: value.summary,
    pageTitle: value.pageTitle || null,
    origin: value.origin || null,
    expiresAt: value.expiresAt,
  };
}

async function clearPendingConfirmation(decision = false, reason = 'cleared') {
  const resolve = _pendingConfirmationResolve;
  _pendingConfirmation = null;
  _pendingConfirmationResolve = null;
  try { await _sessionStore().remove(['pendingConfirmation']); } catch {}
  await updateActionIndicator();
  if (resolve) resolve({ approved: decision === true, reason });
}

async function requestUserConfirmation({ action, summary, target = null }) {
  if (_pendingConfirmation) throw new Error('another browser action is already waiting for confirmation');
  const id = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
  _pendingConfirmation = {
    id,
    action: String(action || '').slice(0, 80),
    summary: String(summary || 'Allow this browser action?').replace(/[\r\n\0]+/g, ' ').slice(0, 300),
    pageTitle: String(target?.title || '').replace(/[\r\n\0]+/g, ' ').slice(0, 160),
    origin: target?.origin || null,
    expiresAt,
  };
  try { await _sessionStore().set({ pendingConfirmation: publicConfirmation(_pendingConfirmation) }); }
  catch {
    _pendingConfirmation = null;
    throw new Error('confirmation could not be stored safely');
  }
  await updateActionIndicator();
  try { await chrome.runtime.sendMessage({ type: 'action_confirmation', confirmation: publicConfirmation(_pendingConfirmation) }); } catch {}
  return new Promise(resolve => {
    _pendingConfirmationResolve = resolve;
    setTimeout(() => {
      if (_pendingConfirmation?.id === id) clearPendingConfirmation(false, 'confirmation timed out').catch(() => {});
    }, CONFIRMATION_TTL_MS);
  });
}

async function suspendLeaseEntry(entry, reason) {
  if (!entry || entry.suspended) return;
  entry.suspended = true;
  entry.reason = reason;
  await _saveLease();
  console.log(`[OE Bridge] lease suspended on tab ${entry.tabId} (${reason})`);
  await broadcastLeaseState([entry.tabId]);
}

// Resolve once and bind the whole command to this exact live tab/document.
// Helpers receive this target and never re-query "the active tab". Rechecks
// immediately before/after content reads prevent a navigation race from
// turning approval for page A into access to page B.
async function validateLiveLeaseTarget(tabId, expectedUrl = null) {
  const lease = await getLease();
  if (!lease) throw new Error(NO_LEASE_HINT);
  const entry = _leaseEntry(Number(tabId));
  if (!entry) throw new Error(`target tab is not covered by the active lease — ${NO_LEASE_HINT}`);
  if (entry.suspended) throw new Error('the lease on that tab is paused — press Resume or Allow again');

  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab?.url) throw new Error('target tab closed before the action could run');
  const sensitive = await sensitiveMatch(tab.url);
  const liveOrigin = originOf(tab.url);
  if (sensitive || !liveOrigin || liveOrigin !== entry.origin) {
    await suspendLeaseEntry(entry, sensitive ? `sensitive destination: ${sensitive}` : 'cross-origin navigation');
    throw new Error(sensitive
      ? `access paused because the tab is now ${sensitive}`
      : 'access paused because the tab navigated away from its granted site');
  }
  if (expectedUrl && tab.url !== expectedUrl) {
    throw new Error('page changed while the authorized action was starting; retry on the current page');
  }
  return { tabId: tab.id, url: tab.url, origin: liveOrigin, windowId: tab.windowId, title: tab.title || '' };
}

// A closed tab leaves the lease; an empty lease is revoked so stale grants
// can't dangle. (The ambient tabs_update telemetry that used to hang off
// these tab events is gone — the server only learns about tabs through
// leased list_tabs / read_page calls now.)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (_activeSuggestion?.tabId === tabId) {
    _activeSuggestion = null;
    await publishSuggestionState();
  }
  const teach = await getTeachGrant();
  if (teach?.tabId === tabId) await stopTeachGrant('taught tab closed');
  const lease = await getLease();
  if (!lease || !lease.tabs.some(t => t.tabId === tabId)) return;
  lease.tabs = lease.tabs.filter(t => t.tabId !== tabId);
  if (lease.tabs.length === 0) await revokeLease('all leased tabs closed');
  else await _saveLease();
});

// Origin-binding enforcement: any navigation that changes a leased tab's
// origin — or lands anywhere sensitive, even same-origin (/checkout,
// /login) — suspends that entry. Resuming is a fresh user click on the
// banner or a re-Allow from the popup. This deliberately catches OE's own
// back/forward navigations too: multi-site agent tasks are a future
// explicit lease scope, not a loophole.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title) {
    setTimeout(() => evaluateActiveSuggestion().catch(() => {}), 100);
  }
  if (!changeInfo.url) return;
  const teach = await getTeachGrant();
  if (teach?.tabId === tabId) {
    const sensitiveTeachUrl = await sensitiveMatch(changeInfo.url);
    if (originOf(changeInfo.url) !== teach.origin || sensitiveTeachUrl) {
      await stopTeachGrant(sensitiveTeachUrl ? 'taught tab entered a sensitive page' : 'taught tab changed origin');
    }
  }
  const lease = await getLease();
  const entry = lease ? lease.tabs.find(t => t.tabId === tabId) : null;
  if (!entry || entry.suspended) return;
  let newOrigin = null;
  try { newOrigin = new URL(changeInfo.url).origin; } catch {}
  const sensitive = await sensitiveMatch(changeInfo.url);
  if (newOrigin === entry.origin && !sensitive) return;
  await suspendLeaseEntry(entry, sensitive ? 'sensitive destination' : 'cross-origin navigation');
});

chrome.tabs.onActivated?.addListener(() => {
  setTimeout(() => evaluateActiveSuggestion().catch(() => {}), 50);
});

// ── Capability broker — default-deny gate in front of dispatch(). ──────
// Every server-initiated command is classified here; anything unlisted is
// denied. Tiers:
//   open    — allowed with no lease. Deliberate carve-outs only.
//   watch   — allowed only while watch/teach mode is on (its own
//             explicitly-entered state with a persistent banner).
//   lease   — requires an active lease covering the target tab.
//   confirm — requires per-use user confirmation. No confirmation UI
//             exists yet, so these always fail closed.
const ACTION_TIERS = {
  // These need a request-bound confirmation/scope UI. Until that exists they
  // fail closed; a generic tab lease is not permission to widen scope or
  // activate arbitrary page handlers.
  media_control: 'user_confirm', open_tab: 'user_confirm',
  submit_form: 'user_confirm',
  // Server may always turn Teach Mode OFF, but cannot turn it on or read a
  // different tab. Observation reads require the active UI-minted TeachGrant.
  set_watch_mode: 'watch_control',
  get_observations: 'teach',
  list_tabs: 'lease', read_page: 'lease',
  close_tab: 'lease', focus_tab: 'lease', back: 'lease',
  forward: 'lease', reload: 'lease', focus_window: 'lease',
  screenshot: 'lease', click_xy: 'lease', type: 'lease', keypress: 'lease',
  run_routine_step: 'lease',
};

const NO_LEASE_HINT =
  'no active access lease — OE cannot see or use the browser until the user grants access. ' +
  'Ask the user to click the OE Bridge icon in their browser toolbar and press ' +
  '"Allow OE to use this tab", then retry.';

async function authorize(action, args) {
  const tier = ACTION_TIERS[action];
  if (!tier) return { ok: false, reason: `action "${action}" is not permitted by the capability broker` };
  if (tier === 'disabled') {
    return { ok: false, reason: `"${action}" is disabled until its explicit, tab-scoped consent UI is available` };
  }
  if (tier === 'watch_control') {
    if (args?.on === false) return { ok: true };
    return { ok: false, reason: 'Teach Mode can only be started by the user from the extension UI' };
  }
  if (tier === 'teach') {
    const grant = await getTeachGrant();
    if (!grant) return { ok: false, reason: 'Teach Mode is not active — ask the user to start it from the OE side panel' };
    if (args?.tabId != null && Number(args.tabId) !== Number(grant.tabId)) {
      return { ok: false, reason: 'Teach Mode observations are available only for the explicitly taught tab' };
    }
    const tab = await chrome.tabs.get(Number(grant.tabId)).catch(() => null);
    if (!tab?.url || originOf(tab.url) !== grant.origin) {
      await stopTeachGrant('origin changed during observation read');
      return { ok: false, reason: 'Teach Mode stopped because the tab changed sites' };
    }
    return { ok: true, target: { tabId: tab.id, url: tab.url, origin: grant.origin, title: tab.title || '' } };
  }
  if (tier === 'user_confirm') {
    const lease = await getLease();
    if (!lease) return { ok: false, reason: NO_LEASE_HINT };
    if (action === 'open_tab') {
      const url = String(args?.url || '');
      const sensitive = await sensitiveMatch(url);
      if (sensitive) return { ok: false, reason: `OE cannot open that destination because it is ${sensitive}` };
      return { ok: true, requiresConfirmation: true };
    }
    if (action === 'media_control') {
      try {
        const target = await resolveLeasedMediaTarget(args?.tabId);
        return { ok: true, target, requiresConfirmation: true };
      } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
      }
    }
    const targetId = await resolveTabId(args?.tabId).catch(() => null);
    if (targetId == null) return { ok: false, reason: `no exact leased target tab — ${NO_LEASE_HINT}` };
    try {
      const target = await validateLiveLeaseTarget(targetId);
      return { ok: true, target, requiresConfirmation: true };
    } catch (e) {
      return { ok: false, reason: e?.message || String(e) };
    }
  }
  // tier === 'lease'
  const lease = await getLease();
  if (!lease) return { ok: false, reason: NO_LEASE_HINT };
  if (action === 'list_tabs') return { ok: true };
  if (action === 'keypress' && /^(enter|numpadenter| |space|spacebar)$/i.test(String(args?.key || ''))) {
    return { ok: false, reason: 'Enter/Space can submit forms or trigger application actions and requires per-use confirmation' };
  }
  if (action === 'keypress' && !/^(tab|escape|backspace|delete|arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown)$/i.test(String(args?.key || ''))) {
    return { ok: false, reason: 'that key is not on the lease-safe key allowlist' };
  }
  // Tab-targeted actions must land inside the lease. resolveTabId falls
  // back to the user's active tab, so a missing tabId on an unleased
  // active tab is a denial, not an implicit grant.
  let targetId = null;
  if (action === 'focus_window') {
    targetId = lease.tabs.find(t => !t.suspended)?.tabId ?? null;
  } else {
    targetId = await resolveTabId(args?.tabId).catch(() => null);
  }
  if (targetId == null) return { ok: false, reason: `no exact leased target tab — ${NO_LEASE_HINT}` };
  try {
    const target = await validateLiveLeaseTarget(targetId);
    return { ok: true, target };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

// Actions that touch a specific tab — send a banner-show event to that
// tab's content script so the user sees what's happening. list_tabs and
// focus_window are not user-facing per-tab work, so they skip the banner.
const TAB_TOUCHING_ACTIONS = new Set([
  'read_page', 'media_control', 'back', 'forward', 'reload', 'close_tab', 'focus_tab',
  'screenshot', 'click_xy', 'type', 'keypress', 'run_routine_step',
]);

async function fireActivityBanner(action, tabId) {
  if (!tabId || !TAB_TOUCHING_ACTIONS.has(action)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'oe_activity_start', action });
  } catch { /* tab might be a chrome:// page with no content script; ignore */ }
}

async function dispatch(action, args) {
  // Default-deny broker gate. Every server command must be explicitly
  // authorized before any tab resolution or banner side effects run.
  const auth = await authorize(action, args);
  if (!auth.ok) throw new Error(auth.reason);

  // Resolve effective tabId for actions that target one — we want to fire
  // the banner BEFORE the action lands, so the user sees the indicator
  // even if the action completes instantly (close_tab makes the tab go
  // away; the banner still flashes on its window or shows on the next
  // active tab).
  let target = auth.target || null;
  if (auth.requiresConfirmation) {
    const summary = action === 'open_tab'
      ? `Open ${String(args?.url || '').slice(0, 220)} and let OE use that new tab for the rest of this lease?`
      : action === 'media_control'
        ? `Let OE ${String(args?.action || '').replace('playpause', 'play or pause')} media once on ${target?.title || target?.origin || 'this leased tab'}?`
        : action === 'submit_form'
          ? `Submit the form on ${target?.title || target?.origin || 'this page'}? This may send data or complete an action.`
          : `Allow OE to run ${action}?`;
    const decision = await requestUserConfirmation({ action, summary, target });
    if (!decision.approved) throw new Error(decision.reason || 'the user did not approve that browser action');
    if (target) target = await validateLiveLeaseTarget(target.tabId, target.url);
    else if (!(await getLease())) throw new Error('the browser lease expired before the action was confirmed');
  }
  const effectiveTabId = target?.tabId ?? null;
  if (effectiveTabId) await fireActivityBanner(action, effectiveTabId);

  switch (action) {
    case 'list_tabs': {
      // Tab inventory only exists inside a lease, and only the tabs whose
      // grant is currently active (not suspended by navigation).
      await getLease();
      const out = [];
      for (const tab of await listTabsSnapshot()) {
        if (!leaseCovers(tab.tabId)) continue;
        try {
          const live = await validateLiveLeaseTarget(tab.tabId);
          out.push({ ...tab, url: live.url, title: live.title });
        } catch { /* validation suspended/removed it; omit */ }
      }
      return out;
    }
    case 'open_tab': {
      const opened = await openTab(String(args?.url || ''));
      await includeConfirmedOpenedTab(opened.tabId, opened.url);
      return opened;
    }
    case 'read_page': {
      const data = await readPage(target.tabId, target.url);
      await validateLiveLeaseTarget(target.tabId, target.url);
      return data;
    }
    case 'media_control': {
      const data = await mediaControl(target.tabId, target.url, String(args?.action || ''));
      await validateLiveLeaseTarget(target.tabId, target.url);
      return data;
    }
    case 'close_tab':     return await closeTab(target.tabId);
    case 'focus_tab':     return await focusTab(target.tabId);
    case 'back':          return await tabBack(target.tabId);
    case 'forward':       return await tabForward(target.tabId);
    case 'reload':        return await tabReload(target.tabId);
    case 'focus_window':  return await focusTab(target.tabId);
    case 'screenshot': {
      const data = await screenshot(target.tabId, target.url);
      await validateLiveLeaseTarget(target.tabId, target.url);
      return data;
    }
    case 'click_xy': {
      const x = Number(args?.x);
      const y = Number(args?.y);
      const inspected = await inspectClickTarget(target.tabId, x, y, target.url);
      let confirmed = false;
      if (inspected.requiresConfirmation) {
        const decision = await requestUserConfirmation({
          action: 'click_xy',
          summary: `Click ${inspected.summary} on ${target.title || target.origin}? Page controls can trigger actions, so this target needs approval.`,
          target,
        });
        if (!decision.approved) throw new Error(decision.reason || 'the user did not approve that click');
        target = await validateLiveLeaseTarget(target.tabId, target.url);
        confirmed = true;
      }
      const data = await clickXY(target.tabId, x, y, target.url, {
        confirmed,
        fingerprint: inspected.fingerprint,
      });
      await validateLiveLeaseTarget(target.tabId).catch(() => {});
      return { ...data, confirmed };
    }
    case 'type': {
      const data = await typeText(target.tabId, String(args?.text || ''), target.url);
      await validateLiveLeaseTarget(target.tabId, target.url);
      return data;
    }
    case 'keypress': {
      const data = await keypress(target.tabId, String(args?.key || ''), target.url);
      await validateLiveLeaseTarget(target.tabId, target.url);
      return data;
    }
    case 'run_routine_step': {
      const step = validateRoutineStep(args?.step, target.origin);
      if (String(args?.origin || '') !== target.origin) throw new Error('routine origin does not match the live leased page');
      const inspected = await inspectRoutineStep(target.tabId, step, target.url);
      let confirmed = false;
      if (inspected.requiresConfirmation) {
        const decision = await requestUserConfirmation({
          action: 'run_routine_step',
          summary: `Routine “${String(args?.routineName || args?.routineId || '').slice(0, 100)}” wants to ${inspected.summary}. Allow this step once?`,
          target,
        });
        if (!decision.approved) throw new Error(decision.reason || 'the user did not approve that routine step');
        target = await validateLiveLeaseTarget(target.tabId, target.url);
        confirmed = true;
      }
      const data = await executeRoutineStep(target.tabId, step, target.url, {
        confirmed,
        fingerprint: inspected.fingerprint,
      });
      // Same-origin navigation remains inside the grant; any unexpected
      // origin change suspends it before the next step can run.
      await validateLiveLeaseTarget(target.tabId).catch(error => {
        throw error;
      });
      return { ...data, confirmed };
    }
    case 'get_observations': {
      // Pass args.tabId RAW (don't pre-resolve via the generic
      // resolveTabId — that returns Chrome's active tab in the
      // SW context, which often isn't the tab where the user was
      // clicking). getObservations uses resolveObservationTabId
      // which smart-picks the tab with most recent buffered
      // activity, falling back through several heuristics.
      const data = await getObservations(target.tabId, args?.since_ms, args?.limit);
      const teachGrant = await getTeachGrant();
      return {
        ...data,
        watchMode: _watchMode,
        // Authenticated Chrome tab metadata, not page-supplied event data.
        // Server-side persistence (site notes / taught routines) can bind
        // writes to this exact active Teach scope.
        teach: teachGrant ? {
          tabId: target.tabId,
          origin: target.origin,
          url: target.url,
          expiresAt: teachGrant.expiresAt,
        } : null,
      };
    }
    case 'set_watch_mode': {
      if (args?.on) throw new Error('Teach Mode can only be started by the user from extension UI');
      await stopTeachGrant('server requested stop');
      return { on: false };
    }
    case 'submit_form': throw new Error('form submission is not exposed as a browser command yet');
    default: throw new Error(`unknown action "${action}"`);
  }
}

async function send(obj) {
  if (_ws && _ws.readyState === 1) {
    _ws.send(JSON.stringify(obj));
  }
}

function sendBrowserRpc(type, payload = {}, { timeoutMs = 15_000 } = {}) {
  if (!_ws || _ws.readyState !== 1) return Promise.reject(new Error('not connected to OE — check the extension status'));
  const requestId = `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pendingWsRequests.delete(requestId);
      reject(new Error('OE did not respond in time'));
    }, timeoutMs);
    _pendingWsRequests.set(requestId, { resolve, reject, timer });
    try {
      _ws.send(JSON.stringify({ type, requestId, ...payload }));
    } catch (error) {
      clearTimeout(timer);
      _pendingWsRequests.delete(requestId);
      reject(error);
    }
  });
}

function buildWsUrl(serverUrl) {
  let u = serverUrl.trim().replace(/\/+$/, '');
  // Accept http(s):// host[:port] or ws(s):// host[:port]; normalise to ws(s)://
  u = u.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  if (!/^wss?:\/\//.test(u)) u = 'ws://' + u;
  return u + '/ws/browser-ext';
}

async function publishSuggestionState() {
  const available = Boolean(_activeSuggestion);
  try {
    await chrome.runtime.sendMessage({ type: 'suggestion_available', available });
  } catch {}
  await updateActionIndicator();
}

async function evaluateActiveSuggestion() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab?.id || !tab.url || await sensitiveMatch(tab.url)) {
    _activeSuggestion = null;
    await publishSuggestionState();
    return null;
  }
  const match = matchSuggestionForPage(_suggestionMatchers, { url: tab.url, title: tab.title || '' });
  _activeSuggestion = match ? {
    matcherId: match.matcherId,
    tabId: tab.id,
    url: tab.url,
    title: String(tab.title || '').slice(0, 500),
  } : null;
  await publishSuggestionState();
  return _activeSuggestion;
}

async function syncSuggestionMatchers() {
  if (!_ws || _ws.readyState !== 1 || !_status.connected) return;
  const data = await sendBrowserRpc('suggestion_matchers', {}, { timeoutMs: 10_000 });
  _suggestionMatchers = normalizeSuggestionMatchers(data.matchers);
  await chrome.storage.local.set({ browserSuggestionMatchers: _suggestionMatchers });
  await evaluateActiveSuggestion();
}

async function loadSuggestionMatchers() {
  const stored = await chrome.storage.local.get('browserSuggestionMatchers').catch(() => ({}));
  _suggestionMatchers = normalizeSuggestionMatchers(stored?.browserSuggestionMatchers);
  await evaluateActiveSuggestion();
}

function bytesToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signBrowserChallenge(credential, challenge) {
  if (!credential?.privateKeyJwk?.d || challenge?.credentialId !== credential.credentialId) {
    throw new Error('browser challenge did not match this browser identity');
  }
  const expiresAt = Number(challenge.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('browser challenge expired');
  const key = await crypto.subtle.importKey(
    'jwk',
    credential.privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const payload = `oe-browser-v1\n${credential.credentialId}\n${challenge.challengeId}\n${challenge.nonce}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(payload),
  );
  if (signature.byteLength !== 64) throw new Error('browser generated an unsupported signature format');
  return bytesToBase64Url(signature);
}

async function connect() {
  if (!_shouldReconnect) return;
  const connectionGeneration = ++_connectionGeneration;
  const cfg = await getConfig();
  if (!cfg.serverUrl) { setStatus({ connected: false, lastError: 'browser is not paired with an OE server', server: null, since: null }); return; }
  if (!cfg.browserCredential) {
    setStatus({ connected: false, lastError: 'secure browser pairing is required', server: cfg.serverUrl, since: null });
    return;
  }
  const attemptedPendingCredential = cfg.pendingCredential === true;
  const wsUrl = buildWsUrl(cfg.serverUrl);
  let authenticated = false;
  let credentialRejected = false;
  try {
    _ws = new WebSocket(wsUrl);
  } catch (e) {
    setStatus({ connected: false, lastError: String(e?.message || e), server: cfg.serverUrl });
    scheduleReconnect();
    return;
  }

  _ws.onopen = async () => {
    _backoffIdx = 0;
    // Paired browsers always prove possession of their private P-256 key.
    send({
      type: 'browser_auth',
      credentialId: cfg.browserCredential.credentialId,
      name: cfg.name,
      version: chrome.runtime.getManifest().version,
    });
  };

  _ws.onmessage = async (ev) => {
    if (connectionGeneration !== _connectionGeneration) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'browser_auth_challenge') {
      try {
        const signature = await signBrowserChallenge(cfg.browserCredential, msg);
        send({
          type: 'browser_auth_response',
          credentialId: cfg.browserCredential.credentialId,
          challengeId: msg.challengeId,
          signature,
        });
      } catch (error) {
        credentialRejected = true;
        setStatus({ connected: false, lastError: error?.message || String(error), server: cfg.serverUrl });
        try { _ws?.close(); } catch {}
      }
      return;
    }

    if (msg.type === 'auth_ok') {
      authenticated = true;
      _extId = msg.extId || null;
      setStatus({
        connected: true,
        lastError: null,
        server: cfg.serverUrl,
        since: Date.now(),
        extId: _extId,
        userId: msg.userId,
        userName: typeof msg.userName === 'string' ? msg.userName.trim().slice(0, 64) : null,
        authMethod: 'browser-key',
        sharedProfile: msg.sharedProfile === true,
      });
      if (msg.authMethod === 'browser-key' && cfg.browserCredential?.credentialId === msg.credentialId) {
        // Promote a replacement only after it proves itself end to end. The
        // previous working credential remains untouched until this point.
        await chrome.storage.local.set({
          browserCredential: { ...cfg.browserCredential, verifiedAt: Date.now() },
          serverUrl: cfg.browserCredential.serverUrl,
          name: cfg.browserCredential.browserName || cfg.name,
        });
        await chrome.storage.local.remove(['pendingBrowserCredential', 'token']);
      }
      // Track the server's hash of the on-disk extension source for
      // diagnostics, but never reload the extension from inside its MV3
      // service worker. In Vivaldi, chrome.runtime.reload() unregisters the
      // worker without reliably starting a replacement: the popup remains
      // visible, but Save / Reconnect then fail because no message receiver
      // exists. Source updates are activated with the browser's explicit
      // Reload button on the extensions page instead.
      if (msg.sourceVersion) {
        try {
          const { lastSourceVersion } = await chrome.storage.local.get(['lastSourceVersion']);
          if (lastSourceVersion && lastSourceVersion !== msg.sourceVersion) {
            console.log(`[OE Bridge] source version changed (${lastSourceVersion} → ${msg.sourceVersion}); use the browser's Extensions > Reload control to activate new source`);
          }
          await chrome.storage.local.set({ lastSourceVersion: msg.sourceVersion });
        } catch (e) {
          console.warn('[OE Bridge] source version compare failed:', e?.message || e);
        }
      }
      setTimeout(() => pollBrowserFieldWatches({ force: true }), 500);
      setTimeout(() => syncSuggestionMatchers().catch(error => {
        console.warn('[OE Bridge] suggestion matcher sync failed:', error?.message || error);
      }), 700);
      return;
    }
    if (msg.type === 'error') {
      if (attemptedPendingCredential) credentialRejected = true;
      setStatus({ connected: false, lastError: msg.message || 'server error', server: cfg.serverUrl });
      return;
    }
    if (msg.type === 'pong') return;

    if (msg.type === 'voice_transcript' && msg.requestId && typeof msg.transcript === 'string') {
      chatSetUserText(String(msg.requestId), `🎙️ ${msg.transcript}`);
      try { chrome.runtime.sendMessage(msg); } catch {}
      return;
    }

    if (msg.requestId && (
      msg.type === 'clip_targets_result' || msg.type === 'clip_save_result' ||
      msg.type === 'handoff_targets_result' || msg.type === 'handoff_send_result' ||
      msg.type === 'field_watch_list_result' || msg.type === 'field_watch_create_result' ||
      msg.type === 'field_watch_revoke_result' || msg.type === 'field_watch_due_result' ||
      msg.type === 'field_watch_observe_result' ||
      msg.type === 'suggestion_matchers_result' || msg.type === 'suggestion_resolve_result' ||
      msg.type === 'suggestion_respond_result'
    )) {
      const pending = _pendingWsRequests.get(String(msg.requestId));
      if (!pending) return;
      clearTimeout(pending.timer);
      _pendingWsRequests.delete(String(msg.requestId));
      if (msg.ok === false) pending.reject(new Error(msg.error || 'OE rejected the browser request'));
      else pending.resolve(msg.data || {});
      return;
    }

    // Chat-from-popup wire frames. Relay verbatim to any open popup or
    // side panel; the receiving surface's handlers filter by requestId
    // so frames for a stale request are ignored cleanly. Also pump the
    // event into the chat-history persistence layer so the conversation
    // survives popup close + reopen.
    if (msg.type === 'chat_event' || msg.type === 'chat_done' || msg.type === 'chat_error') {
      if (msg.type === 'chat_event' && msg.event?.type === 'token' && typeof msg.event.text === 'string') {
        chatAppendToken(msg.event.text);
      }
      if (msg.type === 'chat_done')  chatFinish(null);
      if (msg.type === 'chat_error') chatFinish(msg.message || 'unknown error');
      try { chrome.runtime.sendMessage(msg); } catch {}
      return;
    }

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
    if (connectionGeneration !== _connectionGeneration) return;
    for (const [requestId, pending] of _pendingWsRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('connection to OE closed'));
      _pendingWsRequests.delete(requestId);
    }
    if (attemptedPendingCredential && credentialRejected && !authenticated) {
      // Rejected replacement: discard only the candidate, then reconnect with
      // the previous proven browser identity.
      chrome.storage.local.remove('pendingBrowserCredential').finally(() => {
        _backoffIdx = 0;
        setTimeout(connect, 100);
      });
      setStatus({ connected: false, lastError: 'replacement pairing failed; restoring the previous browser connection', server: cfg.serverUrl });
      return;
    }
    setStatus({ connected: false, server: cfg.serverUrl });
    scheduleReconnect();
  };
  _ws.onerror = (e) => {
    if (connectionGeneration !== _connectionGeneration) return;
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

// (Ambient tabs_update telemetry removed — the server no longer receives
// tab open/close/navigate events. Tab state is only visible via leased
// list_tabs / read_page commands.)

async function captureOneShotViewport(tab) {
  const before = await chrome.tabs.get(tab.id).catch(() => null);
  if (!before?.url || before.url !== tab.url || !before.active) throw new Error('the page changed before screenshot capture');
  const dataUrl = await chrome.tabs.captureVisibleTab(before.windowId, { format: 'jpeg', quality: 70 });
  const after = await chrome.tabs.get(tab.id).catch(() => null);
  if (!after?.url || after.url !== before.url || !after.active) throw new Error('the page changed during screenshot capture');
  const base64 = String(dataUrl || '').replace(/^data:image\/jpeg;base64,/, '');
  if (!base64 || base64.length > 1_600_000) throw new Error('the screenshot is too large to send safely');
  return { mimeType: 'image/jpeg', base64, name: 'browser-viewport.jpg' };
}

function minimizedContextUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only web URLs can be shared');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function sendOneShotContext({ tab, question, requestId, selectionText = null, imageUrl = null, screenshot = false, announce = true }) {
  if (!_ws || _ws.readyState !== 1) throw new Error('not connected to OE — check the extension status');
  if (!tab?.id || !tab.url) throw new Error('no active web page to share');
  const sensitive = await sensitiveMatch(tab.url);
  if (sensitive) throw new Error(`OE won't read this page — it's ${sensitive}`);

  const live = await chrome.tabs.get(tab.id).catch(() => null);
  if (!live?.url || live.url !== tab.url) throw new Error('the page changed before it could be shared — try again');
  const safeQuestion = String(question || '').trim().slice(0, 4_000) || 'What is this page? Summarize what matters on it.';
  const id = String(requestId || `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  let title = live.title || live.url;
  let text = '';
  let kind = 'page';
  let image = null;
  let selectedImageUrl = null;
  let documentUrl = null;

  if (screenshot) {
    kind = 'screenshot';
    image = await captureOneShotViewport(live);
    text = 'The user explicitly shared a one-time screenshot of the visible browser viewport.';
  } else if (imageUrl) {
    kind = 'image';
    // OE fetches this cookie-free with DNS pinning; the extension never turns
    // a rebinding hostname into a LAN-reading oracle.
    selectedImageUrl = String(imageUrl);
    text = 'The user explicitly shared this selected page image for a one-time question.';
  } else if (typeof selectionText === 'string' && selectionText.trim()) {
    kind = 'selection';
    text = selectionText.trim().slice(0, 16_000);
  } else if (/\.pdf(?:$|[?#])/i.test(live.url)) {
    kind = 'pdf';
    documentUrl = live.url;
    text = 'The user explicitly shared this public PDF for a one-time question.';
  } else {
    await fireActivityBanner('read_page', live.id);
    const page = await readPage(live.id, live.url);
    const after = await chrome.tabs.get(live.id).catch(() => null);
    const afterSensitive = await sensitiveMatch(after?.url || '');
    if (!after?.url || after.url !== live.url || page.url !== live.url || afterSensitive) {
      throw new Error('the page changed during capture, so nothing was sent — try again on the current page');
    }
    title = page.title || page.url;
    text = page.text.slice(0, 16_000) + (page.text.length > 16_000 ? '\n[…truncated]' : '');
  }

  const marker = kind === 'selection' ? '✂️' : (kind === 'page' || kind === 'pdf' ? '📄' : '🖼️');
  const userText = `${marker} [${title}] ${safeQuestion}`;
  chatBegin(id, userText);
  if (announce) {
    try { await chrome.runtime.sendMessage({ type: 'context_started', requestId: id, userText }); } catch {}
  }
  _ws.send(JSON.stringify({
    type: 'page_ask',
    requestId: id,
    question: safeQuestion,
    snapshot: { kind, url: minimizedContextUrl(live.url), title, text },
    attention: { action: 'ask', domains: [new URL(live.url).hostname] },
    ...(image ? { image } : {}),
    ...(selectedImageUrl ? { imageUrl: selectedImageUrl } : {}),
    ...(documentUrl ? { documentUrl } : {}),
  }));
  return { ok: true, requestId: id, title, question: safeQuestion, kind };
}

async function sendSelectedTabsComparison({ tabIds, question, requestId, announce = false }) {
  if (!_ws || _ws.readyState !== 1) throw new Error('not connected to OE — check the extension status');
  const ids = [...new Set((Array.isArray(tabIds) ? tabIds : []).map(Number).filter(Number.isFinite))].slice(0, 8);
  if (ids.length < 2) throw new Error('select at least two tabs to compare');
  const safeQuestion = String(question || '').trim().slice(0, 4_000) || 'Compare these pages. Summarize the important differences, tradeoffs, and any contradictions.';

  const captures = await Promise.all(ids.map(async tabId => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) throw new Error(`selected tab ${tabId} is no longer open`);
    const sensitive = await sensitiveMatch(tab.url);
    if (sensitive) throw new Error(`can't compare “${tab.title || tab.url}” because it is ${sensitive}`);
    const page = await readPage(tab.id, tab.url);
    const after = await chrome.tabs.get(tab.id).catch(() => null);
    if (!after?.url || after.url !== tab.url || page.url !== tab.url || await sensitiveMatch(after.url)) {
      throw new Error(`“${tab.title || tab.url}” changed during capture; select the tabs and try again`);
    }
    return {
      url: minimizedContextUrl(page.url),
      title: page.title || tab.title || page.url,
      text: page.text.slice(0, 5_000) + (page.text.length > 5_000 ? '\n[…truncated]' : ''),
    };
  }));

  const id = String(requestId || `tabs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const userText = `🗂️ Compare ${captures.length} selected tabs: ${safeQuestion}`;
  chatBegin(id, userText);
  if (announce) {
    try { await chrome.runtime.sendMessage({ type: 'context_started', requestId: id, userText }); } catch {}
  }
  const text = captures.map((page, i) => [
    `--- SELECTED TAB ${i + 1} ---`,
    `URL: ${page.url}`,
    `Title: ${page.title}`,
    page.text,
  ].join('\n')).join('\n\n');
  _ws.send(JSON.stringify({
    type: 'page_ask',
    requestId: id,
    question: safeQuestion,
    snapshot: {
      kind: 'tabs',
      url: captures[0].url,
      title: `${captures.length} explicitly selected tabs`,
      text,
    },
    attention: {
      action: 'compare',
      domains: captures.map(page => new URL(page.url).hostname),
      count: captures.length,
    },
  }));
  return { ok: true, requestId: id, count: captures.length, question: safeQuestion };
}

async function captureClip({ tab, selectionText = null }) {
  if (!tab?.id || !tab.url) throw new Error('no active web page to clip');
  const sensitive = await sensitiveMatch(tab.url);
  if (sensitive) throw new Error(`OE won't clip this page — it's ${sensitive}`);
  const live = await chrome.tabs.get(tab.id).catch(() => null);
  if (!live?.url || live.url !== tab.url) throw new Error('the page changed before it could be clipped — try again');

  let title = live.title || live.url;
  let text;
  let kind;
  if (typeof selectionText === 'string' && selectionText.trim()) {
    kind = 'selection';
    text = selectionText.trim().slice(0, 20_000);
  } else {
    kind = 'page';
    await fireActivityBanner('read_page', live.id);
    const page = await readPage(live.id, live.url);
    const after = await chrome.tabs.get(live.id).catch(() => null);
    if (!after?.url || after.url !== live.url || page.url !== live.url || await sensitiveMatch(after.url)) {
      throw new Error('the page changed during capture, so nothing was saved — try again');
    }
    title = page.title || title;
    text = page.text.trim().slice(0, 20_000);
  }
  if (!text) throw new Error('there was no readable text to clip');
  const capture = { kind, url: live.url, title, text, capturedAt: Date.now() };
  await chrome.storage.session.set({ [PENDING_CLIP_KEY]: capture });
  return capture;
}

async function captureHandoffPage(tab) {
  if (!tab?.id || !tab.url) throw new Error('no active web page to send');
  const sensitive = await sensitiveMatch(tab.url);
  if (sensitive) throw new Error(`OE won't send this page — it's ${sensitive}`);
  const live = await chrome.tabs.get(tab.id).catch(() => null);
  if (!live?.url || live.url !== tab.url) throw new Error('the page changed before it could be sent');
  await fireActivityBanner('read_page', live.id);
  const page = await readPage(live.id, live.url);
  const after = await chrome.tabs.get(live.id).catch(() => null);
  if (!after?.url || after.url !== live.url || page.url !== live.url || await sensitiveMatch(after.url)) {
    throw new Error('the page changed during capture, so nothing was sent');
  }
  return {
    kind: 'page',
    url: page.url,
    title: page.title || live.title || page.url,
    text: page.text.trim().slice(0, 4_000),
    capturedAt: Date.now(),
  };
}

async function getPendingClip() {
  const stored = await chrome.storage.session.get(PENDING_CLIP_KEY);
  const capture = stored?.[PENDING_CLIP_KEY];
  if (!capture || !Number.isFinite(Number(capture.capturedAt)) || Date.now() - Number(capture.capturedAt) > PENDING_CLIP_TTL_MS) {
    await chrome.storage.session.remove(PENDING_CLIP_KEY);
    return null;
  }
  if (await sensitiveMatch(capture.url || '')) {
    await chrome.storage.session.remove(PENDING_CLIP_KEY);
    return null;
  }
  return capture;
}

async function announceClipReady(capture) {
  try {
    await chrome.runtime.sendMessage({
      type: 'clip_ready',
      capture: { kind: capture.kind, title: capture.title, url: capture.url },
    });
  } catch {}
}

async function openPanelForTab(tab) {
  if (tab?.windowId == null || !chrome?.sidePanel?.open) return;
  try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch {}
}

async function setupContextMenus() {
  if (!chrome?.contextMenus?.create) return;
  try { await chrome.contextMenus.removeAll(); } catch {}
  try {
    chrome.contextMenus.create({ id: 'oe-ask-selection', title: 'Ask OE about this selection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'oe-ask-page', title: 'Summarize this page with OE', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'oe-ask-image', title: 'Ask OE about this image', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'oe-clip-selection', title: 'Clip selection to OE…', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'oe-clip-page', title: 'Clip page to OE…', contexts: ['page'] });
  } catch {}
}

if (chrome?.contextMenus?.onClicked?.addListener) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    try {
      await openPanelForTab(tab);
      if (info.menuItemId === 'oe-ask-selection') {
        await sendOneShotContext({
          tab,
          selectionText: String(info.selectionText || ''),
          question: 'Explain this selection and why it matters in the context of the page.',
        });
      } else if (info.menuItemId === 'oe-ask-page') {
        await sendOneShotContext({ tab, question: 'Summarize this page and highlight what matters most.' });
      } else if (info.menuItemId === 'oe-ask-image') {
        await sendOneShotContext({ tab, imageUrl: info.srcUrl, question: 'Describe this image and explain what matters about it in the page context.' });
      } else if (info.menuItemId === 'oe-clip-selection' || info.menuItemId === 'oe-clip-page') {
        const capture = await captureClip({
          tab,
          selectionText: info.menuItemId === 'oe-clip-selection' ? String(info.selectionText || '') : null,
        });
        await announceClipReady(capture);
      }
    } catch (e) {
      console.warn('[OE Bridge] context-menu Ask failed:', e?.message || e);
    }
  });
}

if (chrome?.omnibox?.onInputEntered?.addListener) {
  try { chrome.omnibox.setDefaultSuggestion({ description: 'Ask OE about the current page: %s' }); } catch {}
  chrome.omnibox.onInputEntered.addListener(async text => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await openPanelForTab(tab);
      await sendOneShotContext({ tab, question: String(text || '').trim() || 'Summarize this page.' });
    } catch (e) {
      console.warn('[OE Bridge] omnibox Ask failed:', e?.message || e);
    }
  });
}

// Popup ↔ background message bus. Popup asks for status / saves config /
// triggers reconnect.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'get_status') {
      const cfg = await getConfig();
      sendResponse({
        status: _status,
        config: { serverUrl: cfg.serverUrl, name: cfg.name, paired: Boolean(cfg.browserCredential) },
        lease: await getLease(),
      });
      return;
    }
    if (msg?.type === 'get_pending_confirmation') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'confirmations are available only in extension UI' }); return; }
      if (_pendingConfirmation && Date.now() >= Number(_pendingConfirmation.expiresAt)) {
        await clearPendingConfirmation(false, 'confirmation timed out');
      }
      sendResponse({ ok: true, confirmation: publicConfirmation(_pendingConfirmation) });
      return;
    }
    if (msg?.type === 'confirmation_respond') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'browser actions can be confirmed only in extension UI' }); return; }
      if (!_pendingConfirmation || msg.id !== _pendingConfirmation.id) {
        sendResponse({ ok: false, error: 'that confirmation is no longer pending' });
        return;
      }
      const approved = msg.approved === true && Date.now() < Number(_pendingConfirmation.expiresAt);
      await clearPendingConfirmation(approved, approved ? 'approved by user' : 'declined by user');
      sendResponse({ ok: true, approved });
      return;
    }
    if (msg?.type === 'browser_pairing_complete') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'pairing completion must come from extension UI' }); return; }
      const credential = msg.credential;
      if (!credential?.credentialId || !credential?.privateKeyJwk?.d || !credential?.serverUrl) {
        sendResponse({ ok: false, error: 'pairing credential was incomplete' });
        return;
      }
      // Stage, do not promote. connect() uses the candidate once and promotes
      // it only after auth_ok proves its private key to the intended server.
      await chrome.storage.local.set({ pendingBrowserCredential: credential });
      _connectionGeneration++;
      try { _ws?.close(); } catch {}
      _backoffIdx = 0;
      _shouldReconnect = true;
      setTimeout(connect, 100);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'suggestion_get') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'suggestions are available only in extension UI' }); return; }
      sendResponse({ ok: true, available: Boolean(_activeSuggestion) });
      return;
    }
    if (msg?.type === 'suggestion_open') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'suggestions are available only in extension UI' }); return; }
      try {
        const active = await evaluateActiveSuggestion();
        if (!active) throw new Error('There is no relevant project suggestion on this page now.');
        const data = await sendBrowserRpc('suggestion_resolve', {
          matcherId: active.matcherId,
          url: minimizedContextUrl(active.url),
          title: active.title,
        }, { timeoutMs: 10_000 });
        sendResponse({ ok: true, suggestion: data.suggestion });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'suggestion_respond') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'suggestions can be changed only in extension UI' }); return; }
      try {
        const active = await evaluateActiveSuggestion();
        if (!active || String(msg.matcherId || '') !== active.matcherId) {
          throw new Error('That suggestion is no longer active on this page.');
        }
        const action = String(msg.action || '');
        if (!['remember', 'not_relevant', 'forget'].includes(action)) throw new Error('invalid suggestion response');
        await sendBrowserRpc('suggestion_respond', {
          matcherId: active.matcherId,
          action,
          url: minimizedContextUrl(active.url),
        }, { timeoutMs: 10_000 });
        await syncSuggestionMatchers();
        sendResponse({ ok: true, action });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'field_watch_picker_start') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'field selection must start from extension UI' }); return; }
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        const grant = await startFieldWatchPicker(active);
        sendResponse({ ok: true, exactUrl: grant.exactUrl, expiresAt: grant.expiresAt });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'field_watch_picker_cancel') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'field picker cancellation must come from extension UI' }); return; }
      await stopFieldWatchPicker();
      await _sessionStore().remove(FIELD_WATCH_SELECTION_KEY).catch(() => {});
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'field_watch_picker_cancelled') {
      const stored = await _sessionStore().get([FIELD_WATCH_PICKER_KEY]).catch(() => ({}));
      const grant = stored?.[FIELD_WATCH_PICKER_KEY];
      if (grant && Number(grant.tabId) === Number(_sender?.tab?.id)) {
        await _sessionStore().remove([FIELD_WATCH_PICKER_KEY, FIELD_WATCH_SELECTION_KEY]).catch(() => {});
        try { await chrome.runtime.sendMessage({ type: 'field_watch_picker_cancelled' }); } catch {}
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'field_watch_picked') {
      const stored = await _sessionStore().get([FIELD_WATCH_PICKER_KEY]).catch(() => ({}));
      const grant = stored?.[FIELD_WATCH_PICKER_KEY];
      const senderTab = _sender?.tab;
      try {
        if (!grant || Date.now() >= Number(grant.expiresAt)
            || Number(grant.tabId) !== Number(senderTab?.id)
            || canonicalFieldWatchUrl(senderTab?.url) !== grant.exactUrl) {
          throw new Error('field picker grant expired or the page changed');
        }
        const sensitive = await sensitiveMatch(senderTab.url);
        if (sensitive) throw new Error(`field watches cannot run here — this is ${sensitive}`);
        const selection = sanitizePickedField(msg.selection, grant.exactUrl, senderTab.title);
        selection.pickedTabId = senderTab.id;
        await _sessionStore().set({ [FIELD_WATCH_SELECTION_KEY]: selection });
        await _sessionStore().remove(FIELD_WATCH_PICKER_KEY);
        try { await chrome.runtime.sendMessage({ type: 'field_watch_selection', selection }); } catch {}
        sendResponse({ ok: true });
      } catch (e) {
        await _sessionStore().remove(FIELD_WATCH_PICKER_KEY).catch(() => {});
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'field_watch_pending_get') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'field watch state is available only in extension UI' }); return; }
      const stored = await _sessionStore().get([FIELD_WATCH_SELECTION_KEY]).catch(() => ({}));
      sendResponse({ ok: true, selection: stored?.[FIELD_WATCH_SELECTION_KEY] || null });
      return;
    }
    if (msg?.type === 'field_watch_list') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'field watches are available only in extension UI' }); return; }
      try {
        const data = await sendBrowserRpc('field_watch_list');
        sendResponse({ ok: true, watches: Array.isArray(data.watches) ? data.watches : [] });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'field_watch_create') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'field watches can be created only in extension UI' }); return; }
      try {
        const stored = await _sessionStore().get([FIELD_WATCH_SELECTION_KEY]);
        const selection = stored?.[FIELD_WATCH_SELECTION_KEY];
        if (!selection) throw new Error('pick a page field before creating the watch');
        if (msg.confirmed !== true) throw new Error('confirm the exact URL and field standing permission first');
        const predicateType = String(msg.predicate?.type || 'changed');
        const predicate = { type: predicateType };
        if (!['changed'].includes(predicateType)) predicate.target = msg.predicate?.target;
        const data = await sendBrowserRpc('field_watch_create', {
          spec: {
            confirmed: true,
            label: String(msg.label || `Watch ${selection.field.property}`).replace(/\s+/g, ' ').trim().slice(0, 160),
            url: selection.exactUrl,
            field: selection.field,
            parser: selection.parser,
            predicate,
            cadenceSec: Number(msg.cadenceSec),
          },
          initialDetection: {
            value: selection.initialValue,
            currency: selection.parser?.currency,
            unit: selection.parser?.unit,
            confidence: 0.9,
          },
        }, { timeoutMs: 35_000 });
        await _sessionStore().remove(FIELD_WATCH_SELECTION_KEY);
        if (data.watch?.execution?.mode === 'browser' && selection.pickedTabId) {
          try {
            await chrome.tabs.sendMessage(selection.pickedTabId, {
              type: 'oe_field_watch_monitor_start',
              watchId: data.watch.id,
              exactUrl: selection.exactUrl,
              selector: selection.field.selector,
              locatorFingerprint: data.watch.field?.fingerprint,
            });
          } catch { /* immediate observation is optional; polling remains authoritative */ }
        }
        sendResponse({ ok: true, watch: data.watch });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'field_watch_revoke') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'field watches can be revoked only in extension UI' }); return; }
      try {
        const data = await sendBrowserRpc('field_watch_revoke', { watchId: String(msg.watchId || '').slice(0, 100) });
        for (const tab of await chrome.tabs.query({}).catch(() => [])) {
          try { await chrome.tabs.sendMessage(tab.id, { type: 'oe_field_watch_monitor_stop', watchId: String(msg.watchId || '') }); } catch {}
        }
        sendResponse({ ok: true, ...data });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'field_watch_live_observation') {
      const senderTab = _sender?.tab;
      try {
        if (!senderTab?.id || !senderTab.url) throw new Error('live field observation had no browser tab');
        const pageUrl = canonicalFieldWatchUrl(msg.pageUrl);
        if (canonicalFieldWatchUrl(senderTab.url) !== pageUrl || await sensitiveMatch(pageUrl)) {
          throw new Error('live field observation fell outside its exact URL permission');
        }
        const value = String(msg.value || '').replace(/\s+/g, ' ').trim().slice(0, 512);
        const fingerprint = String(msg.locatorFingerprint || '').slice(0, 160);
        if (!value || !fingerprint) throw new Error('live field observation was incomplete');
        await sendBrowserRpc('field_watch_observe', {
          watchId: String(msg.watchId || '').slice(0, 100),
          detection: {
            value,
            pageUrl,
            detector: 'dom',
            executor: 'browser',
            locatorFingerprint: fingerprint,
            confidence: 0.9,
            observedAt: Date.now(),
          },
        }, { timeoutMs: 15_000 });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'grant_lease') {
      // Leases are user-channel artifacts: only the extension's own UI
      // (the authenticated popup / side-panel document) may create one. A
      // content script relaying page-forged messages could never mint a
      // grant this way.
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'lease grants must come from the extension UI' }); return; }
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!active?.id) { sendResponse({ ok: false, error: 'no active tab to grant access to' }); return; }
        const sensitive = await sensitiveMatch(active.url || '');
        if (sensitive) { sendResponse({ ok: false, error: `This is ${sensitive} — OE access can't be granted here.` }); return; }
        const lease = await grantLease(active.id, active.url || '');
        sendResponse({ ok: true, lease });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'revoke_lease') {
      // Revocation is fail-safe, so any surface may trigger it —
      // including the banner button on a leased page.
      if (_pendingConfirmation) await clearPendingConfirmation(false, 'browser access was revoked');
      await revokeLease('user revoked');
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'resume_lease') {
      // Resume is a fresh user click — from the paused banner on the tab
      // itself (content-script sender) or from the popup (active tab). The
      // tab's current URL is read from the tab, never trusted from the
      // message; resumeLease refuses sensitive destinations.
      let tabId = _sender?.tab?.id ?? null;
      if (tabId == null) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id ?? null;
      }
      if (tabId == null) { sendResponse({ ok: false, error: 'no tab to resume on' }); return; }
      sendResponse(await resumeLease(tabId));
      return;
    }
    if (msg?.type === 'get_lease_state') {
      // Content script asks on page load whether ITS tab is leased, so
      // the persistent banner survives navigation within a leased tab.
      const tabId = _sender?.tab?.id;
      const lease = await getLease();
      const entry = (lease && tabId != null) ? lease.tabs.find(t => t.tabId === tabId) : null;
      sendResponse({
        state: !entry ? 'none' : (entry.suspended ? 'suspended' : 'active'),
        expiresAt: lease?.expiresAt ?? null,
      });
      return;
    }
    if (msg?.type === 'ask_page_oneshot') {
      // "Ask about this page" is one-shot consent: capture a snapshot of
      // the page the user is looking at RIGHT NOW, attach it to their
      // question, done. No lease is minted — explicitly asking is consent
      // to read this page once, not to let OE act on the tab.
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'one-shot page asks must come from the extension UI' }); return; }
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        sendResponse(await sendOneShotContext({ tab: active, question: msg.question, requestId: msg.requestId, announce: false }));
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'ask_screenshot_oneshot') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'one-shot screenshots must come from the extension UI' }); return; }
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        sendResponse(await sendOneShotContext({
          tab: active,
          question: msg.question || 'Explain what is visible in this screenshot and what matters most.',
          requestId: msg.requestId,
          screenshot: true,
          announce: false,
        }));
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'compare_tabs_oneshot') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'tab comparison must come from the extension UI' }); return; }
      try {
        sendResponse(await sendSelectedTabsComparison({
          tabIds: msg.tabIds,
          question: msg.question,
          requestId: msg.requestId,
          announce: false,
        }));
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'clip_prepare') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'clips must be prepared from the extension UI' }); return; }
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        const capture = await captureClip({ tab: active });
        sendResponse({ ok: true, capture: { kind: capture.kind, title: capture.title, url: capture.url } });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'clip_pending_get') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'clip state is available only to extension UI' }); return; }
      const capture = await getPendingClip();
      sendResponse({ ok: true, capture: capture ? { kind: capture.kind, title: capture.title, url: capture.url } : null });
      return;
    }
    if (msg?.type === 'clip_pending_cancel') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'clip cancellation is available only in extension UI' }); return; }
      await chrome.storage.session.remove(PENDING_CLIP_KEY);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'clip_targets') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'clip targets are available only to extension UI' }); return; }
      try {
        const data = await sendBrowserRpc('clip_targets');
        sendResponse({ ok: true, targets: Array.isArray(data.targets) ? data.targets : [] });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'clip_save') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'clips can be saved only from extension UI' }); return; }
      try {
        const capture = await getPendingClip();
        if (!capture) throw new Error('the pending clip expired — capture the page again');
        const data = await sendBrowserRpc('clip_save', {
          targetId: String(msg.targetId || '').slice(0, 200),
          newDocumentName: String(msg.newDocumentName || '').trim().slice(0, 160),
          capture,
        });
        await chrome.storage.session.remove(PENDING_CLIP_KEY);
        await syncSuggestionMatchers().catch(() => {});
        sendResponse({ ok: true, result: data });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'voice_send') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'voice messages must come from extension UI' }); return; }
      if (!_ws || _ws.readyState !== 1) { sendResponse({ ok: false, error: 'not connected to OE' }); return; }
      const mimeType = String(msg.mimeType || '').toLowerCase().slice(0, 100);
      const base64 = String(msg.base64 || '');
      if (!/^audio\/(?:webm|ogg|mp4|wav)(?:;\s*codecs=[a-z0-9._-]+)?$/i.test(mimeType)
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
          || base64.length > 1_250_000) {
        sendResponse({ ok: false, error: 'voice recording was invalid or too large' });
        return;
      }
      const requestId = String(msg.requestId || `voice_${Date.now()}`).slice(0, 100);
      chatBegin(requestId, '🎙️ Voice message');
      _ws.send(JSON.stringify({
        type: 'voice_utterance',
        requestId,
        mimeType,
        base64,
        lang: String(msg.lang || '').slice(0, 20),
      }));
      sendResponse({ ok: true, requestId });
      return;
    }
    if (msg?.type === 'handoff_targets') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'device targets are available only to extension UI' }); return; }
      try {
        const data = await sendBrowserRpc('handoff_targets');
        sendResponse({ ok: true, targets: Array.isArray(data.targets) ? data.targets : [] });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'handoff_send') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'page handoff must come from extension UI' }); return; }
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        const capture = await captureHandoffPage(active);
        const data = await sendBrowserRpc('handoff_send', {
          targetId: String(msg.targetId || '').slice(0, 160),
          mode: String(msg.mode || '').slice(0, 40),
          capture,
        }, { timeoutMs: 20_000 });
        sendResponse({ ok: true, result: data });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'oe_submit_blocked') {
      console.warn(`[OE Bridge] capture-phase guard blocked a form submit on ${_sender?.tab?.url || 'unknown tab'}`);
      return;
    }
    if (msg?.type === 'reconnect') {
      _connectionGeneration++;
      try { _ws?.close(); } catch {}
      _backoffIdx = 0;
      _shouldReconnect = true;
      setTimeout(connect, 100);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'disconnect') {
      _shouldReconnect = false;
      _connectionGeneration++;
      if (_pendingConfirmation) await clearPendingConfirmation(false, 'extension disconnected');
      try { _ws?.close(); } catch {}
      sendResponse({ ok: true });
      return;
    }
    // Observation events from the content-observe.js script. We always
    // accept the frame; pushObservation checks _watchMode and drops
    // when off, so the listener doesn't have to gate per-event.
    if (msg?.type === 'observation') {
      const tabId = _sender?.tab?.id;
      // If the storage-backed watch_mode hasn't loaded yet (SW just
      // respawned), queue the event so we can replay it once load
      // completes. Without this, the first events after an SW
      // resurrection get dropped.
      if (!_watchModeLoaded) {
        _pendingObservations.push({ tabId, event: msg.event });
        console.log(`[OE-bg] observation queued (watchMode loading) tabId=${tabId} kind=${msg.event?.kind} tag=${msg.event?.element?.tag}`);
        return;
      }
      const grant = await getTeachGrant();
      const senderUrl = String(_sender?.tab?.url || '');
      const exactGrant = grant && Number(grant.tabId) === Number(tabId) && originOf(senderUrl) === grant.origin;
      console.log(`[OE-bg] observation received tabId=${tabId} teachGrant=${Boolean(exactGrant)} kind=${msg.event?.kind} tag=${msg.event?.element?.tag}${exactGrant ? '' : ' [DROPPED — outside TeachGrant]'}`);
      if (exactGrant && msg.event && typeof msg.event === 'object') {
        // tabUrl comes from Chrome's sender metadata, never from page data.
        pushObservation(tabId, { ...msg.event, tabUrl: senderUrl });
      }
      return;
    }
    if (msg?.type === 'get_watch_mode') {
      const grant = await getTeachGrant();
      sendResponse({
        on: Boolean(grant && Number(grant.tabId) === Number(_sender?.tab?.id)),
        expiresAt: grant?.expiresAt || null,
      });
      return;
    }
    if (msg?.type === 'get_teach_state') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'Teach state is available only to extension UI' }); return; }
      const grant = await getTeachGrant();
      sendResponse({ ok: true, active: Boolean(grant), grant });
      return;
    }
    if (msg?.type === 'teach_start') {
      if (!isExtensionUiSender(_sender)) { sendResponse({ ok: false, error: 'Teach Mode must be started from extension UI' }); return; }
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!active?.id || !active.url) throw new Error('no active web page to teach');
        const grant = await startTeachGrant(active.id, active.url);
        sendResponse({ ok: true, grant, title: active.title || active.url });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'teach_stop') {
      // Fail-safe stop may come from the extension UI or the content banner.
      await stopTeachGrant('user stopped');
      sendResponse({ ok: true, active: false });
      return;
    }
    if (msg?.type === 'set_watch_mode') {
      if (msg.on) {
        sendResponse({ ok: false, on: false, error: 'Teach Mode requires the new tab-scoped consent control' });
        return;
      }
      await stopTeachGrant('user stopped');
      sendResponse({ ok: true, on: false });
      return;
    }
    if (msg?.type === 'chat_send') {
      // Popup wants to ask Sydney something. Forward over the same WS
      // we use for command results. Server replies stream back as
      // chat_event/chat_done frames keyed by requestId, which the WS
      // message handler below relays to the popup via runtime.sendMessage.
      if (!_ws || _ws.readyState !== 1) {
        sendResponse({ ok: false, error: 'not connected to OE — open the extension popup and check the status pill.' });
        return;
      }
      try {
        chatBegin(msg.requestId, msg.text);
        _ws.send(JSON.stringify({ type: 'chat', requestId: msg.requestId, text: msg.text }));
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
    if (msg?.type === 'chat_history_get') {
      sendResponse({ history: _chatHistory || [], current: _chatCurrent || null });
      return;
    }
    if (msg?.type === 'chat_history_clear') {
      // Wipe BOTH the local SW-held history AND the server-side session
      // for whichever agent the extension chat targets (Browser Tutor or
      // coordinator). Without the server-side wipe the LLM keeps
      // pattern-matching off its earlier "no events captured" replies
      // and never re-queries browser_observe even when fresh events
      // are buffered.
      chatClear();
      if (_ws && _ws.readyState === 1) {
        try { _ws.send(JSON.stringify({ type: 'chat_clear_session' })); } catch {}
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'open_sidepanel') {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.windowId != null) await chrome.sidePanel.open({ windowId: activeTab.windowId });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return;
    }
  })();
  return true; // async sendResponse
});

// When the extension loads (install OR reload), Chrome only auto-injects
// content scripts into pages that load AFTER the registration. Existing
// tabs that predate the reload are missing the listeners — that's why
// watch mode "works" but captures nothing on a Booking tab the user
// had open before the latest extension reload. Walk every open tab and
// inject the content scripts programmatically so they work immediately
// without needing the user to refresh.
async function injectContentScriptsIntoAllTabs() {
  const scripts = ['content-banner.js', 'content-observe.js', 'content-field-picker.js'];
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  for (const t of tabs) {
    if (!t.id || !t.url) continue;
    // Skip non-injectable origins.
    if (/^(chrome|edge|brave|about|chrome-extension|moz-extension):/i.test(t.url)) continue;
    for (const f of scripts) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id, allFrames: false },
          files: [f],
        });
      } catch { /* tab refused (private file://, restricted page) — skip silently */ }
    }
  }
}

// Kick off on service worker startup. Chrome MV3 may park the worker; on
// wake, the onAlarm or onStartup hooks below will re-fire this.
chrome.runtime.onStartup.addListener(() => { _shouldReconnect = true; connect(); injectContentScriptsIntoAllTabs(); });
chrome.runtime.onInstalled.addListener(() => { _shouldReconnect = true; connect(); injectContentScriptsIntoAllTabs(); setupContextMenus(); });
loadSuggestionMatchers().catch(() => {});
// Also fire on every SW boot (not just onInstalled/onStartup, which
// don't fire on a normal cold start of a docked extension).
injectContentScriptsIntoAllTabs();
setupContextMenus();

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
    // Lazily expire the lease so the banner drops promptly, not just on
    // the next denied command.
    getLease().catch(() => {});
    pollBrowserFieldWatches().catch(() => {});
  });
} else {
  console.warn('[OE Bridge] chrome.alarms unavailable — using setInterval fallback. Remove + reinstall the extension at chrome://extensions to pick up the alarms permission for the proper keepalive.');
  setInterval(() => {
    if (_ws && _ws.readyState === 1) send({ type: 'ping' });
    else if (_shouldReconnect && (!_ws || _ws.readyState >= 2)) connect();
    getLease().catch(() => {});
    pollBrowserFieldWatches().catch(() => {});
  }, 30_000);
}

// Small white-box surface for the versioned broker regression suite. These
// are module exports only; extension pages and websites cannot call them.
export const __test = Object.freeze({
  getConfig,
  isExtensionUiSender,
  authorize,
  dispatch,
  grantLease,
  revokeLease,
  getLease,
  sensitiveMatch,
  isPrivateHostname,
  validateLiveLeaseTarget,
  signBrowserChallenge,
  startTeachGrant,
  getTeachGrant,
  stopTeachGrant,
  pushObservation,
  getObservations,
  validateRoutineStep,
  canonicalFieldWatchUrl,
  sanitizePickedField,
  executeBrowserFieldCheck,
  pollBrowserFieldWatches,
  dropMemoryState() {
    _lease = null;
    _leaseLoaded = false;
  },
  async resetState() {
    if (_pendingConfirmation) await clearPendingConfirmation(false, 'test reset');
    _lease = null;
    _leaseLoaded = false;
    _watchMode = false;
    _watchModeLoaded = true;
    _teachGrant = null;
    _observations = new Map();
    _fieldWatchPollInFlight = false;
    _lastFieldWatchPollAt = 0;
    try { await chrome.storage.session.clear(); } catch {}
    try {
      await chrome.storage.local.remove([
        'leaseDenyBefore', 'watchMode', 'neverReadDomains', 'token',
        'browserCredential', 'pendingBrowserCredential', 'browserSuggestionMatchers',
      ]);
    } catch {}
  },
});

// A confirmation Promise cannot survive MV3 worker eviction. Never restore a
// stale approval card without the exact suspended command behind it.
try { _sessionStore().remove(['pendingConfirmation']).catch(() => {}); } catch {}
connect();
