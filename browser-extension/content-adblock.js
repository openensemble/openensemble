// OE Bridge local ad blocker.
//
// Network filtering is handled by the packaged MV3 ruleset. This isolated
// content script owns only user-taught cosmetic rules: right-click an element,
// choose "Block this ad with OE", and the background worker stores a bounded
// selector for this top-level site and frame host. No page text or browsing
// data leaves the browser.
(() => {
  if (globalThis.__oeAdBlockInstalled) return;
  globalThis.__oeAdBlockInstalled = true;

  const DOCUMENT_TOKEN = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
    || Math.random().toString(36).slice(2, 14);
  const HIDDEN_ATTRIBUTE = `data-oe-adblock-hidden-${DOCUMENT_TOKEN}`;
  const TARGET_TTL_MS = 30_000;
  const MAX_SELECTOR_LENGTH = 420;
  const MAX_SELECTOR_MATCHES = 100;
  const MAX_FRAME_RULES = 50;
  const AD_HINT = /(?:^|[-_\s])(ad|ads|advert|advertisement|advertising|sponsor|sponsored|promoted|commercial)(?:$|[-_\s])/i;
  const GENERIC_AD_LABEL = /^(?:ad|advertisement|advertising|sponsored|promoted)(?:\s+(?:content|link|post|result|video))?$/i;
  const SENSITIVE_SELECTOR = 'input,textarea,select,option,[contenteditable="true"],[contenteditable=""]';
  const MEDIA_SELECTOR = 'img,picture,video,object,embed,iframe';

  let enabled = false;
  let learnedRules = [];
  let currentSiteHost = '';
  let currentFrameHost = '';
  let lastContextTarget = null;
  let lastContextAt = 0;
  let observer = null;
  let applyTimer = null;
  let lastMatchedCount = 0;
  let styleElement = null;
  let toastHost = null;
  let toastShadow = null;
  let toastTimer = null;

  function compact(value, max = 160) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function cssString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function stableToken(value) {
    const token = String(value || '');
    if (!/^[A-Za-z_-][A-Za-z0-9_-]{1,63}$/.test(token)) return false;
    if (/\d{5,}/.test(token) || /(?:^|[-_])[a-f0-9]{10,}(?:$|[-_])/i.test(token)) return false;
    return true;
  }

  function isOwnedUi(element) {
    return Boolean(toastHost && (
      element === toastHost
      || toastHost.contains(element)
      || element?.getRootNode?.() === toastShadow
    ));
  }

  function documentReachableTarget(element) {
    let target = element;
    while (target instanceof Element) {
      const root = target.getRootNode?.();
      if (!root?.host || !(root.host instanceof Element)) return target;
      target = root.host;
    }
    return null;
  }

  function isSafeTarget(element) {
    if (!(element instanceof Element) || !element.isConnected || isOwnedUi(element)) return false;
    if (element.matches('html,body,head,main,script,style,link,meta,title')) return false;
    if (element.matches(SENSITIVE_SELECTOR)) return false;
    return true;
  }

  function selectorSyntaxSafe(selector) {
    if (typeof selector !== 'string' || !selector || selector.length > MAX_SELECTOR_LENGTH) return null;
    if (/[{},\r\n@]/.test(selector) || selector.includes(',')) return null;
    try { document.querySelectorAll(selector); } catch { return false; }
    return true;
  }

  function selectorMatches(selector, target = null) {
    if (!selectorSyntaxSafe(selector)) return null;
    let nodes;
    try { nodes = document.querySelectorAll(selector); } catch { return null; }
    if (!nodes.length || nodes.length > MAX_SELECTOR_MATCHES) return null;
    const matches = [...nodes];
    if (matches.some(element => element.matches('html,body,head,main'))) return null;
    if (target && !matches.includes(target)) return null;
    return matches;
  }

  function adSignalScore(element) {
    let score = 0;
    if (element.hasAttribute('data-ad') || element.hasAttribute('data-ad-slot') || element.hasAttribute('data-ad-unit')) score += 12;
    if (element.hasAttribute('data-google-query-id')) score += 10;
    if (AD_HINT.test(compact(element.getAttribute('aria-label'), 120))) score += 9;
    if (AD_HINT.test(compact(element.id, 120))) score += 8;
    if (AD_HINT.test(compact(typeof element.className === 'string' ? element.className : '', 240))) score += 7;
    if (AD_HINT.test(compact(element.getAttribute('data-testid'), 120))) score += 7;
    if (element.matches('iframe,object,embed')) score += 3;
    return score;
  }

  function reasonableBounds(element, explicit = false) {
    let rect;
    try { rect = element.getBoundingClientRect(); } catch { return false; }
    if (rect.width < 2 || rect.height < 2) return false;
    if (explicit || element.matches(MEDIA_SELECTOR)) return true;
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    return (rect.width * rect.height) / viewportArea <= 0.72;
  }

  function chooseCandidate(target) {
    if (!isSafeTarget(target)) return null;
    const chain = [];
    let node = target;
    while (node && node instanceof Element && chain.length < 8 && !node.matches('html,body,main')) {
      if (isSafeTarget(node)) chain.push(node);
      node = node.parentElement;
    }

    let best = null;
    let bestScore = 0;
    for (let index = 0; index < chain.length; index++) {
      const element = chain[index];
      const score = adSignalScore(element) - (index * 0.05);
      if (score > bestScore && reasonableBounds(element, score >= 7)) {
        best = element;
        bestScore = score;
      }
    }
    if (best) return best;

    const media = chain.find(element => element.matches(MEDIA_SELECTOR));
    if (media && reasonableBounds(media)) {
      let candidate = media;
      const mediaRect = media.getBoundingClientRect();
      for (let index = chain.indexOf(media) + 1; index < Math.min(chain.length, chain.indexOf(media) + 4); index++) {
        const parent = chain[index];
        const rect = parent.getBoundingClientRect();
        const areaRatio = (rect.width * rect.height) / Math.max(1, mediaRect.width * mediaRect.height);
        if (areaRatio <= 2.5 && parent.children.length <= 12 && reasonableBounds(parent)) candidate = parent;
      }
      return candidate;
    }

    return reasonableBounds(target) ? target : null;
  }

  function highSignalSelector(element) {
    const tag = element.localName;
    for (const name of ['data-ad', 'data-ad-slot', 'data-ad-unit', 'data-google-query-id']) {
      if (!element.hasAttribute(name)) continue;
      const broad = `${tag}[${name}]`;
      if (selectorMatches(broad, element)) return broad;
    }

    for (const name of ['aria-label', 'data-testid', 'data-test']) {
      const value = compact(element.getAttribute(name), 120);
      if (!value || (name === 'aria-label'
        ? !GENERIC_AD_LABEL.test(value)
        : (!AD_HINT.test(value) || !stableToken(value)))) continue;
      const selector = `${tag}[${name}="${cssString(value)}"]`;
      if (selectorMatches(selector, element)) return selector;
    }

    const signalClasses = [...element.classList].filter(token => stableToken(token) && AD_HINT.test(token));
    for (const token of signalClasses) {
      const selector = `${tag}.${CSS.escape(token)}`;
      if (selectorMatches(selector, element)) return selector;
    }
    return null;
  }

  function segmentFor(element, includePosition = false) {
    const tag = element.localName;
    const id = compact(element.id, 96);
    if (id && stableToken(id)) return `#${CSS.escape(id)}`;

    for (const name of ['data-testid', 'data-test', 'role']) {
      const value = compact(element.getAttribute(name), 120);
      if (value && value.length >= 2 && stableToken(value)) {
        return `${tag}[${name}="${cssString(value)}"]`;
      }
    }

    const classes = [...element.classList].filter(stableToken).slice(0, 2);
    let segment = `${tag}${classes.map(token => `.${CSS.escape(token)}`).join('')}`;
    if (includePosition && element.parentElement) {
      const siblings = [...element.parentElement.children].filter(child => child.localName === tag);
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(element) + 1})`;
    }
    return segment;
  }

  function selectorFor(element) {
    const highSignal = highSignalSelector(element);
    if (highSignal) return highSignal;

    const id = compact(element.id, 96);
    if (id && stableToken(id)) {
      const selector = `#${CSS.escape(id)}`;
      if (selectorMatches(selector, element)) return selector;
    }

    const classSelector = segmentFor(element, false);
    const classMatches = selectorMatches(classSelector, element);
    if (classMatches?.length === 1) return classSelector;

    const parts = [];
    let node = element;
    while (node && node instanceof Element && !node.matches('html,body,main') && parts.length < 7) {
      parts.unshift(segmentFor(node, true));
      const selector = parts.join(' > ');
      const matches = selectorMatches(selector, element);
      if (matches?.length === 1) return selector;
      node = node.parentElement;
    }
    return null;
  }

  function ensureStyle() {
    if (!document.documentElement) return;
    const expected = `[${HIDDEN_ATTRIBUTE}][${HIDDEN_ATTRIBUTE}][${HIDDEN_ATTRIBUTE}]{display:none !important;visibility:hidden !important;}`;
    if (styleElement?.isConnected && styleElement.textContent === expected) return;
    styleElement?.remove();
    styleElement = document.createElement('style');
    styleElement.textContent = expected;
    document.documentElement.appendChild(styleElement);
  }

  function clearHidden() {
    try {
      for (const element of document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)) {
        element.removeAttribute(HIDDEN_ATTRIBUTE);
      }
    } catch {}
    lastMatchedCount = 0;
  }

  function applyRules() {
    applyTimer = null;
    if (!document.documentElement) return;
    if (!enabled || !learnedRules.length) {
      stopObserver();
      clearHidden();
      return;
    }
    ensureObserver();
    ensureStyle();
    const matched = new Set();
    for (const rule of learnedRules) {
      const matches = selectorMatches(rule.selector);
      if (!matches) continue;
      for (const element of matches) {
        if (!isSafeTarget(element)) continue;
        matched.add(element);
        if (!element.hasAttribute(HIDDEN_ATTRIBUTE)) element.setAttribute(HIDDEN_ATTRIBUTE, 'true');
      }
    }
    for (const element of document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)) {
      if (!matched.has(element)) element.removeAttribute(HIDDEN_ATTRIBUTE);
    }
    lastMatchedCount = matched.size;
  }

  function scheduleApply(delay = 50) {
    if (applyTimer) return;
    applyTimer = setTimeout(applyRules, delay);
  }

  function ensureObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(() => scheduleApply(250));
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        HIDDEN_ATTRIBUTE, 'id', 'class', 'aria-label', 'role', 'data-testid', 'data-test',
        'data-ad', 'data-ad-slot', 'data-ad-unit', 'data-google-query-id',
      ],
    });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
  }

  function normalizeRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules
      .filter(rule => rule && typeof rule.id === 'string' && selectorSyntaxSafe(rule.selector))
      .slice(0, MAX_FRAME_RULES)
      .map(rule => ({ id: rule.id, selector: rule.selector }));
  }

  function setState(state) {
    if (!state?.ok) return;
    enabled = state.enabled === true;
    if (typeof state.siteHost === 'string' && state.siteHost) currentSiteHost = state.siteHost.toLowerCase();
    if (typeof state.frameHost === 'string' && state.frameHost) currentFrameHost = state.frameHost.toLowerCase();
    learnedRules = normalizeRules(state.rules);
    scheduleApply(0);
  }

  function requestState() {
    try {
      chrome.runtime.sendMessage({ type: 'adblock_content_ready' }, response => {
        if (chrome.runtime.lastError) return;
        setState(response);
      });
    } catch {}
  }

  function refreshState(message) {
    const frameHost = currentFrameHost || (() => {
      const values = [location.href, globalThis.origin, location.origin];
      try { values.push(document.location.ancestorOrigins?.[0]); } catch {}
      for (const value of values) {
        try {
          const url = new URL(value);
          if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname.toLowerCase();
          if (url.protocol === 'blob:') {
            const owner = new URL(url.pathname);
            if (owner.protocol === 'http:' || owner.protocol === 'https:') return owner.hostname.toLowerCase();
          }
        } catch {}
      }
      return String(message?.siteHost || '').toLowerCase();
    })();
    setState({
      ok: true,
      enabled: message?.enabled === true,
      siteHost: message?.siteHost || currentSiteHost,
      frameHost,
      rules: Array.isArray(message?.rules)
        ? message.rules.filter(rule => rule?.frameHost === frameHost)
        : [],
    });
  }

  function showToast(message, { ruleId = null, isError = false } = {}) {
    clearTimeout(toastTimer);
    toastHost?.remove();
    toastHost = document.createElement('div');
    toastHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:14px;right:14px;max-width:360px;';
    toastShadow = toastHost.attachShadow({ mode: 'closed' });
    const card = document.createElement('div');
    card.setAttribute('role', isError ? 'alert' : 'status');
    card.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    card.style.cssText = `font:600 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:${isError ? '#7f1d1d' : '#14532d'};background:${isError ? '#fef2f2' : '#f0fdf4'};border:1px solid ${isError ? '#fca5a5' : '#86efac'};border-radius:8px;padding:9px 11px;box-shadow:0 6px 24px rgba(0,0,0,.22);display:flex;align-items:center;gap:9px;`;
    const label = document.createElement('span');
    label.textContent = message;
    card.append(label);
    if (ruleId) {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.textContent = 'Undo';
      undo.style.cssText = 'font:700 11px inherit;border:1px solid #4ade80;border-radius:5px;background:#fff;color:#166534;padding:4px 7px;cursor:pointer;';
      undo.addEventListener('click', () => {
        undo.disabled = true;
        chrome.runtime.sendMessage({ type: 'adblock_remove_learned_rule', ruleId }, response => {
          if (chrome.runtime.lastError || !response?.ok) {
            showToast(response?.error || 'Could not undo that rule.', { isError: true });
            return;
          }
          requestState();
          showToast('That learned ad rule was removed.');
        });
      });
      card.append(undo);
    }
    toastShadow.append(card);
    document.documentElement?.appendChild(toastHost);
    toastTimer = setTimeout(() => {
      toastHost?.remove();
      toastHost = null;
      toastShadow = null;
    }, ruleId ? 9_000 : 6_000);
  }

  function blockContextTarget() {
    if (!enabled) return { ok: false, error: 'Ad blocking is turned off in the OE Bridge popup.' };
    if (!lastContextTarget || Date.now() - lastContextAt > TARGET_TTL_MS || !lastContextTarget.isConnected) {
      return { ok: false, error: 'The clicked item expired. Right-click the ad again.' };
    }
    const candidate = chooseCandidate(lastContextTarget);
    if (!candidate) return { ok: false, error: 'That area is too broad or sensitive to learn safely.' };
    const selector = selectorFor(candidate);
    const matches = selector && selectorMatches(selector, candidate);
    if (!selector || !matches) return { ok: false, error: 'OE could not make a stable rule for that item.' };
    return {
      ok: true,
      selector,
      matchCount: matches.length,
      frameUrl: location.href,
      frameOrigin: globalThis.origin,
      frameHost: currentFrameHost,
      tag: candidate.localName,
      signalled: adSignalScore(candidate) > 0,
    };
  }

  document.addEventListener('contextmenu', event => {
    if (!event.isTrusted) return;
    const rawTarget = event.composedPath?.().find(node => node instanceof Element)
      || (event.target instanceof Element ? event.target : null);
    const target = documentReachableTarget(rawTarget);
    if (!target || isOwnedUi(target)) return;
    lastContextTarget = target;
    lastContextAt = Date.now();
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'oe_adblock_block_context_target') {
      sendResponse(blockContextTarget());
      return;
    }
    if (message?.type === 'oe_adblock_refresh') {
      refreshState(message);
      return;
    }
    if (message?.type === 'oe_adblock_rule_saved') {
      showToast(`Blocked this ad and learned it for ${message.siteHost || 'this site'}.`, { ruleId: message.ruleId || null });
      return;
    }
    if (message?.type === 'oe_adblock_notice') {
      showToast(message.message || 'OE could not block that item.', { isError: message.isError !== false });
      return;
    }
    if (message?.type === 'oe_adblock_get_status') {
      sendResponse({ ok: true, enabled, matchedCount: lastMatchedCount });
    }
  });

  if (!document.documentElement) {
    document.addEventListener('readystatechange', () => scheduleApply(0), { once: true });
  }
  addEventListener('pageshow', event => {
    if (event.persisted) requestState();
  });
  requestState();
})();
