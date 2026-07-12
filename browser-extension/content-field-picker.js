// OE Bridge field picker. Dormant until extension UI explicitly starts it.
// It returns one selector and one bounded value; never page HTML or context.
(() => {
  if (globalThis.__oeFieldPickerInstalled) return;
  globalThis.__oeFieldPickerInstalled = true;

  let active = false;
  let hovered = null;
  let host = null;
  let pickerMessage = null;
  const liveMonitors = new Map();

  const cssString = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const compact = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

  function unique(selector) {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  }

  function selectorFor(element) {
    const tag = element.localName;
    if (element.id) {
      const selector = `#${CSS.escape(element.id)}`;
      if (unique(selector)) return selector;
    }
    for (const name of ['data-testid', 'data-test', 'data-price', 'itemprop', 'aria-label', 'name']) {
      const value = compact(element.getAttribute(name), 120);
      if (!value) continue;
      const selector = `${tag}[${name}="${cssString(value)}"]`;
      if (unique(selector)) return selector;
    }
    const stableClasses = [...element.classList]
      .filter(value => /^[A-Za-z_-][A-Za-z0-9_-]{0,48}$/.test(value) && !/\d{5,}/.test(value))
      .slice(0, 2);
    if (stableClasses.length) {
      const selector = `${tag}${stableClasses.map(value => `.${CSS.escape(value)}`).join('')}`;
      if (unique(selector)) return selector;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body && parts.length < 7) {
      const local = node.localName;
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(child => child.localName === local)
        : [];
      const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : '';
      parts.unshift(`${local}${suffix}`);
      const selector = parts.join(' > ');
      if (unique(selector)) return selector;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function anchorsFor(element, ownText) {
    const anchors = [];
    const add = (text, relation) => {
      const normalized = compact(text, 120);
      if (normalized && normalized !== ownText && !anchors.some(row => row.text === normalized)) {
        anchors.push({ text: normalized, relation });
      }
    };
    add(element.getAttribute('aria-label'), 'near');
    add(element.previousElementSibling?.textContent, 'before');
    add(element.nextElementSibling?.textContent, 'after');
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) add(document.getElementById(labelledBy)?.textContent, 'near');
    const parentText = compact(element.parentElement?.textContent, 120);
    if (parentText && parentText.length <= 120) add(parentText, 'parent');
    return anchors.slice(0, 5);
  }

  function inferField(element, value) {
    const itemprop = compact(element.getAttribute('itemprop'), 64).toLowerCase();
    const currency = /(?:\bUSD\b|\$)/i.test(value) ? 'USD'
      : /(?:\bEUR\b|€)/i.test(value) ? 'EUR'
        : /(?:\bGBP\b|£)/i.test(value) ? 'GBP'
          : /(?:\bJPY\b|¥)/i.test(value) ? 'JPY' : null;
    if (itemprop.includes('price') || currency) return { property: 'price', parser: { type: 'price', currency } };
    if (itemprop.includes('availability') || /\b(?:in stock|out of stock|sold out|available|unavailable|pre-?order)\b/i.test(value)) {
      return { property: 'availability', parser: { type: 'availability' } };
    }
    if (/[-+]?\d[\d.,'\s]*/.test(value)) return { property: 'value', parser: { type: 'number' } };
    return { property: 'text', parser: { type: 'text' } };
  }

  function setHover(element) {
    if (hovered === element) return;
    if (hovered) hovered.style.removeProperty('outline');
    hovered = element;
    if (hovered) hovered.style.setProperty('outline', '3px solid #f59e0b', 'important');
  }

  function cleanup(notify = false) {
    if (!active) return;
    active = false;
    setHover(null);
    host?.remove();
    host = null;
    pickerMessage = null;
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('keydown', onKey, true);
    if (notify) chrome.runtime.sendMessage({ type: 'field_watch_picker_cancelled' }).catch(() => {});
  }

  function onHover(event) {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element === host || host?.contains(element)) return;
    setHover(element);
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup(true);
  }

  function onPick(event) {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element === host || host?.contains(element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (element.matches('html, body, main, section, article, form, script, style, iframe, svg, canvas, input, textarea, select, [contenteditable="true"]')) {
      pickerMessage?.replaceChildren('That area is too broad or sensitive for a standing watch. Pick the displayed value itself.');
      return;
    }
    const value = compact(element.innerText || element.textContent || element.getAttribute('content'), 512);
    const selector = selectorFor(element);
    if (!value || value.length > 240 || element.children.length > 5 || !selector || !unique(selector)) {
      pickerMessage?.replaceChildren('That item cannot be pinned reliably. Try the visible value itself.');
      return;
    }
    const inferred = inferField(element, value);
    const selection = {
      selector,
      anchors: anchorsFor(element, value),
      value,
      property: inferred.property,
      parser: inferred.parser,
      tag: element.localName,
    };
    cleanup(false);
    chrome.runtime.sendMessage({ type: 'field_watch_picked', selection }).catch(() => {});
  }

  function start() {
    cleanup(false);
    active = true;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);';
    const root = host.attachShadow({ mode: 'closed' });
    const bar = document.createElement('div');
    bar.style.cssText = 'font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#3b2f08;background:#fffbeb;border:2px solid #f59e0b;border-radius:9px;padding:9px 12px;box-shadow:0 5px 22px rgba(0,0,0,.24);display:flex;gap:12px;align-items:center;max-width:680px;';
    const message = document.createElement('span');
    pickerMessage = message;
    message.dataset.message = 'true';
    message.textContent = 'Click the exact value OE should watch. Nothing else on the page will be saved.';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'font:600 12px inherit;border:1px solid #b45309;border-radius:5px;background:#fff;color:#92400e;padding:5px 8px;cursor:pointer;';
    cancel.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); cleanup(true); });
    bar.append(message, cancel);
    root.append(bar);
    document.documentElement.append(host);
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onPick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function canonicalUrl(value) {
    try {
      const url = new URL(String(value || ''));
      url.hash = '';
      return url.href;
    } catch { return null; }
  }

  function stopLiveMonitor(watchId) {
    const current = liveMonitors.get(String(watchId || ''));
    if (!current) return;
    clearTimeout(current.timer);
    current.observer.disconnect();
    liveMonitors.delete(String(watchId));
  }

  function startLiveMonitor(message) {
    const watchId = String(message.watchId || '').slice(0, 100);
    const selector = String(message.selector || '').slice(0, 500);
    const exactUrl = canonicalUrl(message.exactUrl);
    const locatorFingerprint = String(message.locatorFingerprint || '').slice(0, 160);
    if (!watchId || !selector || !exactUrl || exactUrl !== canonicalUrl(location.href) || !locatorFingerprint) return;
    let matches;
    try { matches = document.querySelectorAll(selector); } catch { return; }
    if (matches.length !== 1) return;
    const element = matches[0];
    if (element.matches('input,textarea,select,[contenteditable="true"]')) return;
    stopLiveMonitor(watchId);
    const state = { observer: null, timer: null, last: compact(element.innerText || element.textContent || element.getAttribute('content'), 512) };
    const emit = () => {
      state.timer = null;
      if (exactUrl !== canonicalUrl(location.href) || !element.isConnected) {
        stopLiveMonitor(watchId);
        return;
      }
      const value = compact(element.innerText || element.textContent || element.getAttribute('content'), 512);
      if (!value || value === state.last) return;
      state.last = value;
      chrome.runtime.sendMessage({
        type: 'field_watch_live_observation', watchId, pageUrl: exactUrl,
        value, locatorFingerprint,
      }).catch(() => {});
    };
    state.observer = new MutationObserver(() => {
      clearTimeout(state.timer);
      state.timer = setTimeout(emit, 500);
    });
    state.observer.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['content', 'aria-label'] });
    liveMonitors.set(watchId, state);
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'oe_field_watch_picker_start') start();
    if (message?.type === 'oe_field_watch_picker_stop') cleanup(false);
    if (message?.type === 'oe_field_watch_monitor_start') startLiveMonitor(message);
    if (message?.type === 'oe_field_watch_monitor_stop') stopLiveMonitor(message.watchId);
  });
})();
