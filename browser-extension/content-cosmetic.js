// OE Bridge list-driven cosmetic filtering.
//
// Three jobs, all local to the page and none of them reporting anywhere:
//   1. Apply the per-site element-hiding rules compiled into filters/sites/*.js.
//      Those bucket files and this script are registered together and either
//      may run first, so they hand rules over through a queue.
//   2. Evaluate procedural filters (:has-text, :upward, ...) that plain CSS
//      cannot express.
//   3. Collapse the empty frames and broken images that network blocking leaves
//      behind, which is what makes a blocked ad read as "gone" rather than as a
//      hole in the page.
//
// Learned right-click rules live in content-adblock.js; this file never touches
// them.
(() => {
  if (globalThis.__oeCosmeticInstalled) return;
  globalThis.__oeCosmeticInstalled = true;

  const MAX_PROCEDURAL_NODES = 400;
  const PROCEDURAL_SETTLE_MS = 10_000;
  const HOST = location.hostname.toLowerCase();

  let hideStyle = null;
  let unhideStyle = null;
  const appliedHide = new Set();
  const appliedUnhide = new Set();
  const proceduralRules = [];
  let proceduralObserver = null;
  let proceduralTimer = null;
  let collapseEnabled = true;

  /** `a.b.example.com` -> itself, `b.example.com`, `example.com`. */
  function hostChain() {
    const parts = HOST.split('.');
    const chain = [];
    for (let i = 0; i < parts.length - 1; i++) chain.push(parts.slice(i).join('.'));
    return chain;
  }
  const CHAIN = hostChain();

  function ensureStyle(existing, id) {
    if (existing?.isConnected) return existing;
    const root = document.documentElement;
    if (!root) return null;
    const style = document.createElement('style');
    style.setAttribute('data-oe-filters', id);
    root.appendChild(style);
    return style;
  }

  function writeHideStyle() {
    if (!appliedHide.size) return;
    hideStyle = ensureStyle(hideStyle, 'hide');
    if (!hideStyle) return;
    hideStyle.textContent = `${[...appliedHide].join(',\n')}\n{display:none!important;}`;
  }

  function writeUnhideStyle() {
    if (!appliedUnhide.size) return;
    // Site exceptions have to beat the always-on generic stylesheet, so they are
    // appended after it and restore the element's own display value.
    unhideStyle = ensureStyle(unhideStyle, 'unhide');
    if (!unhideStyle) return;
    unhideStyle.textContent = `${[...appliedUnhide].join(',\n')}\n{display:revert!important;}`;
  }

  /** Collect the selectors a hostname map contributes to this page. */
  function collect(map, into) {
    if (!map || typeof map !== 'object') return false;
    let changed = false;
    for (const host of CHAIN) {
      const selectors = map[host];
      if (!Array.isArray(selectors)) continue;
      for (const selector of selectors) {
        if (typeof selector !== 'string' || !selector) continue;
        if (into.has(selector)) continue;
        into.add(selector);
        changed = true;
      }
    }
    return changed;
  }

  function applySiteRules(hideMap, unhideMap) {
    const hideChanged = collect(hideMap, appliedHide);
    const unhideChanged = collect(unhideMap, appliedUnhide);
    if (unhideChanged) {
      for (const selector of appliedUnhide) appliedHide.delete(selector);
    }
    if (hideChanged || unhideChanged) writeHideStyle();
    if (unhideChanged) writeUnhideStyle();
  }

  // --- procedural filters -----------------------------------------------------

  const PROCEDURAL_NAMES = [
    'has-text', 'upward', 'matches-css-before', 'matches-css-after', 'matches-css',
    'min-text-length', 'matches-attr', 'style', 'remove',
  ];

  /** Split `div.a:has-text(x):upward(2)` into a base selector plus operations. */
  function parseProcedural(selector) {
    const operations = [];
    let base = selector;
    let index = 0;
    let cut = selector.length;
    while (index < selector.length) {
      const colon = selector.indexOf(':', index);
      if (colon < 0) break;
      const name = PROCEDURAL_NAMES.find(candidate => selector.startsWith(candidate, colon + 1));
      if (!name || selector[colon + 1 + name.length] !== '(') { index = colon + 1; continue; }
      let depth = 0;
      let end = -1;
      for (let i = colon + 1 + name.length; i < selector.length; i++) {
        if (selector[i] === '(') depth++;
        else if (selector[i] === ')') { depth--; if (!depth) { end = i; break; } }
      }
      if (end < 0) return null;
      if (!operations.length) cut = colon;
      operations.push({ name, argument: selector.slice(colon + 2 + name.length, end) });
      index = end + 1;
    }
    if (!operations.length) return null;
    base = selector.slice(0, cut).trim() || '*';
    try { document.querySelector(base); } catch { return null; }
    return { base, operations };
  }

  function textMatcher(argument) {
    const match = /^\/(.+)\/([gimsuy]*)$/.exec(argument);
    if (match) {
      try {
        const regex = new RegExp(match[1], match[2].replace(/g/g, ''));
        return value => regex.test(value);
      } catch { return null; }
    }
    return value => value.includes(argument);
  }

  function applyOperation(nodes, { name, argument }) {
    switch (name) {
      case 'has-text': {
        const matches = textMatcher(argument);
        return matches ? nodes.filter(node => matches(node.textContent || '')) : [];
      }
      case 'min-text-length': {
        const min = Number(argument);
        return Number.isFinite(min) ? nodes.filter(node => (node.textContent || '').length >= min) : [];
      }
      case 'upward': {
        const steps = Number(argument);
        const out = [];
        for (const node of nodes) {
          let target = node;
          if (Number.isInteger(steps) && steps > 0) {
            for (let i = 0; i < steps && target; i++) target = target.parentElement;
          } else {
            try { target = node.closest(argument); } catch { target = null; }
          }
          if (target && target !== document.documentElement && target !== document.body) out.push(target);
        }
        return out;
      }
      case 'matches-css':
      case 'matches-css-before':
      case 'matches-css-after': {
        const pseudo = name === 'matches-css' ? null : name.slice('matches-css-'.length);
        const split = argument.indexOf(':');
        if (split < 0) return [];
        const property = argument.slice(0, split).trim();
        const matches = textMatcher(argument.slice(split + 1).trim());
        if (!matches) return [];
        return nodes.filter(node => {
          try {
            return matches(getComputedStyle(node, pseudo ? `::${pseudo}` : null).getPropertyValue(property).trim());
          } catch { return false; }
        });
      }
      case 'matches-attr': {
        const split = argument.indexOf('=');
        const attribute = (split < 0 ? argument : argument.slice(0, split)).trim();
        const matches = split < 0 ? () => true : textMatcher(argument.slice(split + 1).trim());
        if (!matches) return [];
        return nodes.filter(node => node.hasAttribute(attribute) && matches(node.getAttribute(attribute) || ''));
      }
      default:
        return nodes;
    }
  }

  function runProcedural() {
    proceduralTimer = null;
    for (const rule of proceduralRules) {
      let nodes;
      try { nodes = [...document.querySelectorAll(rule.base)]; } catch { continue; }
      if (!nodes.length || nodes.length > MAX_PROCEDURAL_NODES) continue;
      let terminal = null;
      for (const operation of rule.operations) {
        if (operation.name === 'style' || operation.name === 'remove') { terminal = operation; break; }
        nodes = applyOperation(nodes, operation);
        if (!nodes.length) break;
      }
      for (const node of nodes) {
        if (!(node instanceof Element) || node.matches('html,body')) continue;
        if (terminal?.name === 'remove') { try { node.remove(); } catch {} continue; }
        if (terminal?.name === 'style') { try { node.style.cssText += `;${terminal.argument}`; } catch {} continue; }
        try { node.style.setProperty('display', 'none', 'important'); } catch {}
      }
    }
  }

  function scheduleProcedural(delay = 60) {
    if (proceduralTimer || !proceduralRules.length) return;
    proceduralTimer = setTimeout(runProcedural, delay);
  }

  function applyProceduralRules(map) {
    if (!map || typeof map !== 'object') return;
    let added = false;
    for (const host of CHAIN) {
      const selectors = map[host];
      if (!Array.isArray(selectors)) continue;
      for (const selector of selectors) {
        const parsed = typeof selector === 'string' ? parseProcedural(selector) : null;
        if (!parsed) continue;
        proceduralRules.push(parsed);
        added = true;
      }
    }
    if (!added || proceduralObserver) { if (added) scheduleProcedural(0); return; }
    scheduleProcedural(0);
    try {
      proceduralObserver = new MutationObserver(() => scheduleProcedural(250));
      proceduralObserver.observe(document.documentElement || document, { childList: true, subtree: true });
      // Procedural rules are expensive; stop resurveying once the page settles.
      setTimeout(() => { proceduralObserver?.disconnect(); proceduralObserver = null; }, PROCEDURAL_SETTLE_MS);
    } catch {}
  }

  // --- element collapsing -----------------------------------------------------

  function isThirdParty(element) {
    const raw = element.getAttribute('src') || element.getAttribute('data') || '';
    if (!raw) return false;
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      const registrable = host => host.split('.').slice(-2).join('.');
      return registrable(url.hostname.toLowerCase()) !== registrable(HOST);
    } catch { return false; }
  }

  /**
   * A blocked subresource still leaves its element in the layout: an empty
   * iframe reserving 300x250, or a broken-image icon. Collapse those, but only
   * when the request was third-party, so a site's own failed image is left
   * alone for the page to handle.
   */
  function collapse(event) {
    if (!collapseEnabled) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    if (!element.matches('img,iframe,object,embed')) return;
    if (element.hasAttribute('data-oe-collapsed')) return;
    if (!isThirdParty(element)) return;
    try {
      const rect = element.getBoundingClientRect();
      if (rect.width * rect.height > 0.5 * innerWidth * innerHeight) return;
    } catch { return; }
    element.setAttribute('data-oe-collapsed', '');
    try { element.style.setProperty('display', 'none', 'important'); } catch {}
  }

  addEventListener('error', collapse, true);

  // --- queue handoff ----------------------------------------------------------

  function drain(queueName, handler) {
    const queue = globalThis[queueName];
    if (!Array.isArray(queue)) return;
    while (queue.length) {
      const item = queue.shift();
      try { handler(item); } catch {}
    }
  }

  function flush() {
    drain('__oeCosmeticQueue', ([hide, unhide]) => applySiteRules(hide, unhide));
    drain('__oeProceduralQueue', map => applyProceduralRules(map));
  }

  globalThis.__oeCosmeticFlush = flush;
  globalThis.__oeCosmeticDisable = () => {
    collapseEnabled = false;
    appliedHide.clear();
    appliedUnhide.clear();
    proceduralRules.length = 0;
    proceduralObserver?.disconnect();
    proceduralObserver = null;
    hideStyle?.remove();
    unhideStyle?.remove();
    hideStyle = null;
    unhideStyle = null;
    for (const element of document.querySelectorAll('[data-oe-collapsed]')) {
      element.removeAttribute('data-oe-collapsed');
      try { element.style.removeProperty('display'); } catch {}
    }
  };
  flush();
})();
