// OE Bridge scriptlet runtime (MAIN world).
//
// Network and cosmetic rules cannot touch ads a page builds for itself: an
// anti-adblock wall reads a property, a video player splices pre-rolls into its
// own JSON, a paywall counts opens. Scriptlets patch those page-side APIs
// before the page's own scripts run.
//
// This file only ever executes rules that were compiled into
// filters/scriptlets/*.js at build time. It reads nothing from the page and
// sends nothing anywhere -- there is no messaging surface here at all, by
// design, because MAIN-world code shares the page's globals and a hostile page
// could otherwise drive it.
(() => {
  if (globalThis.__oeScriptletsInstalled) return;
  globalThis.__oeScriptletsInstalled = true;

  const noop = () => {};
  const toStringRaw = Function.prototype.toString;

  /**
   * Anti-adblock code routinely calls `String(window.setTimeout)` and bails when
   * it does not see `[native code]`. Patched functions are therefore recorded
   * here and `Function.prototype.toString` reports the original's source.
   */
  const NATIVE = new WeakMap();

  /** Make a patched function indistinguishable from the one it replaced. */
  function disguise(replacement, original) {
    try {
      Object.defineProperty(replacement, 'name', { value: original.name, configurable: true });
      Object.defineProperty(replacement, 'length', { value: original.length, configurable: true });
      NATIVE.set(replacement, original);
    } catch {}
    return replacement;
  }

  try {
    const patchedToString = function toString() {
      const original = NATIVE.get(this);
      return toStringRaw.call(original || this);
    };
    NATIVE.set(patchedToString, toStringRaw);
    Function.prototype.toString = patchedToString;
  } catch {}

  /**
   * uBO argument convention: `/re/flags` is a regex, a leading `!` negates, an
   * empty string matches everything.
   */
  function toMatcher(raw, { emptyMatchesAll = true } = {}) {
    const text = raw === undefined || raw === null ? '' : String(raw);
    if (!text) return emptyMatchesAll ? () => true : () => false;
    let negated = false;
    let body = text;
    if (body.startsWith('!')) { negated = true; body = body.slice(1); }
    let test;
    const match = /^\/(.+)\/([gimsuy]*)$/.exec(body);
    if (match) {
      let regex;
      try { regex = new RegExp(match[1], match[2].replace(/g/g, '')); } catch { return () => false; }
      test = value => regex.test(value);
    } else {
      test = value => String(value).includes(body);
    }
    return negated ? value => !test(value) : test;
  }

  function toNumberOrNull(raw) {
    if (raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /** Resolve a dotted property path, defining missing intermediate objects. */
  function definePath(root, chain, install) {
    const parts = String(chain).split('.');
    const last = parts.pop();
    if (!last) return;
    let owner = root;
    for (const part of parts) {
      const next = owner?.[part];
      if (next && (typeof next === 'object' || typeof next === 'function')) {
        owner = next;
        continue;
      }
      if (owner == null || typeof owner !== 'object') return;
      try {
        const created = {};
        Object.defineProperty(owner, part, { value: created, writable: true, configurable: true });
        owner = created;
      } catch { return; }
    }
    if (owner == null) return;
    install(owner, last);
  }

  function parseValue(raw) {
    switch (raw) {
      case 'true': return true;
      case 'false': return false;
      case 'null': return null;
      case 'undefined': return undefined;
      case 'noopFunc': return noop;
      case 'trueFunc': return () => true;
      case 'falseFunc': return () => false;
      case 'emptyArr': return [];
      case 'emptyObj': return {};
      case '': return '';
      default: break;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === "''" || raw === '""') return '';
    return raw;
  }

  /** Walk a `a.b.*.c` path inside a plain object, deleting matched leaves. */
  function pruneChain(target, parts, depth = 0) {
    if (target == null || typeof target !== 'object') return;
    const part = parts[depth];
    const isLast = depth === parts.length - 1;
    const keys = part === '*' || part === '[]' ? Object.keys(target) : [part];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(target, key)) continue;
      if (isLast) { try { delete target[key]; } catch {} continue; }
      pruneChain(target[key], parts, depth + 1);
    }
  }

  function hasChain(target, path) {
    if (!path) return true;
    const parts = path.split('.');
    let node = target;
    for (const part of parts) {
      if (node == null || typeof node !== 'object') return false;
      if (part === '*' || part === '[]') {
        return Object.values(node).some(value => hasChain(value, parts.slice(parts.indexOf(part) + 1).join('.')));
      }
      if (!Object.prototype.hasOwnProperty.call(node, part)) return false;
      node = node[part];
    }
    return true;
  }

  function stackMatches(matcher) {
    try { return matcher(new Error().stack || ''); } catch { return false; }
  }

  // ---------------------------------------------------------------------------
  // Scriptlet library. Names match uBlock Origin's so upstream rules compile
  // straight across; `ALIASES` maps the short forms used in the lists.
  // ---------------------------------------------------------------------------
  const LIBRARY = Object.create(null);

  LIBRARY['abort-on-property-read'] = (chain) => {
    if (!chain) return;
    const abort = () => { throw new ReferenceError(Math.random().toString(36).slice(2)); };
    definePath(globalThis, chain, (owner, key) => {
      try {
        Object.defineProperty(owner, key, { get: abort, set: noop, configurable: false });
      } catch {}
    });
  };

  LIBRARY['abort-on-property-write'] = (chain) => {
    if (!chain) return;
    definePath(globalThis, chain, (owner, key) => {
      let stored = owner[key];
      try {
        Object.defineProperty(owner, key, {
          get: () => stored,
          set() { throw new ReferenceError(Math.random().toString(36).slice(2)); },
          configurable: false,
        });
      } catch {}
    });
  };

  LIBRARY['abort-current-script'] = (chain, search, stackNeedle) => {
    if (!chain) return;
    const matchesText = toMatcher(search);
    const matchesStack = stackNeedle ? toMatcher(stackNeedle) : null;
    definePath(globalThis, chain, (owner, key) => {
      let stored = owner[key];
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor && !descriptor.configurable) return;
      const guard = () => {
        const script = document.currentScript;
        if (!script) return;
        const text = script.textContent || script.src || '';
        if (!matchesText(text)) return;
        if (matchesStack && !stackMatches(matchesStack)) return;
        throw new ReferenceError(Math.random().toString(36).slice(2));
      };
      try {
        Object.defineProperty(owner, key, {
          get() { guard(); return stored; },
          set(value) { guard(); stored = value; },
          configurable: false,
        });
      } catch {}
    });
  };

  LIBRARY['set-constant'] = (chain, rawValue) => {
    if (!chain) return;
    const value = parseValue(rawValue);
    definePath(globalThis, chain, (owner, key) => {
      try {
        Object.defineProperty(owner, key, {
          get: () => value,
          set: noop,
          configurable: false,
        });
      } catch {}
    });
  };

  LIBRARY['no-setTimeout-if'] = (needle, delay) => {
    const matches = toMatcher(needle);
    const wanted = toNumberOrNull(delay);
    const original = globalThis.setTimeout;
    globalThis.setTimeout = disguise(function (handler, timeout, ...rest) {
      const text = typeof handler === 'function' ? toStringRaw.call(handler) : String(handler);
      if (matches(text) && (wanted === null || wanted === Number(timeout))) {
        return original.call(this, noop, timeout);
      }
      return original.call(this, handler, timeout, ...rest);
    }, original);
  };

  LIBRARY['no-setInterval-if'] = (needle, delay) => {
    const matches = toMatcher(needle);
    const wanted = toNumberOrNull(delay);
    const original = globalThis.setInterval;
    globalThis.setInterval = disguise(function (handler, timeout, ...rest) {
      const text = typeof handler === 'function' ? toStringRaw.call(handler) : String(handler);
      if (matches(text) && (wanted === null || wanted === Number(timeout))) {
        return original.call(this, noop, timeout);
      }
      return original.call(this, handler, timeout, ...rest);
    }, original);
  };

  LIBRARY['addEventListener-defuser'] = (typeNeedle, handlerNeedle) => {
    const matchesType = toMatcher(typeNeedle);
    const matchesHandler = toMatcher(handlerNeedle);
    const original = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = disguise(function (type, listener, ...rest) {
      let text = '';
      try { text = typeof listener === 'function' ? toStringRaw.call(listener) : String(listener); } catch {}
      if (matchesType(String(type)) && matchesHandler(text)) return undefined;
      return original.call(this, type, listener, ...rest);
    }, original);
  };

  LIBRARY['no-window-open-if'] = (needle) => {
    const matches = toMatcher(needle);
    const original = globalThis.open;
    globalThis.open = disguise(function (url, ...rest) {
      if (matches(String(url ?? ''))) return null;
      return original.call(this, url, ...rest);
    }, original);
  };

  LIBRARY['noeval'] = () => {
    globalThis.eval = disguise(function () { return undefined; }, globalThis.eval);
  };

  LIBRARY['no-fetch-if'] = (needle) => {
    if (typeof globalThis.fetch !== 'function') return;
    const matches = toMatcher(needle, { emptyMatchesAll: true });
    const original = globalThis.fetch;
    globalThis.fetch = disguise(function (input, init, ...rest) {
      let url = '';
      try { url = typeof input === 'string' ? input : input?.url || ''; } catch {}
      if (matches(url)) return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
      return original.call(this, input, init, ...rest);
    }, original);
  };

  LIBRARY['no-xhr-if'] = (needle) => {
    const matches = toMatcher(needle);
    const openOriginal = XMLHttpRequest.prototype.open;
    const sendOriginal = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = disguise(function (method, url, ...rest) {
      this.__oeBlocked = matches(String(url ?? ''));
      return openOriginal.call(this, method, url, ...rest);
    }, openOriginal);
    XMLHttpRequest.prototype.send = disguise(function (...args) {
      if (!this.__oeBlocked) return sendOriginal.apply(this, args);
      Object.defineProperties(this, {
        readyState: { value: 4, configurable: true },
        status: { value: 200, configurable: true },
        responseText: { value: '', configurable: true },
        response: { value: '', configurable: true },
      });
      setTimeout(() => {
        try { this.dispatchEvent(new Event('readystatechange')); } catch {}
        try { this.dispatchEvent(new Event('load')); } catch {}
        try { this.dispatchEvent(new Event('loadend')); } catch {}
      }, 1);
      return undefined;
    }, sendOriginal);
  };

  LIBRARY['json-prune'] = (rawPaths, rawRequired) => {
    const paths = String(rawPaths || '').split(/\s+/).filter(Boolean).map(entry => entry.split('.'));
    if (!paths.length) return;
    const required = String(rawRequired || '').split(/\s+/).filter(Boolean);
    const prune = (value) => {
      if (!value || typeof value !== 'object') return value;
      if (required.length && !required.every(path => hasChain(value, path))) return value;
      for (const parts of paths) pruneChain(value, parts);
      return value;
    };
    const parseOriginal = JSON.parse;
    JSON.parse = disguise(function (...args) {
      return prune(parseOriginal.apply(this, args));
    }, parseOriginal);
    if (typeof Response === 'function' && Response.prototype.json) {
      const jsonOriginal = Response.prototype.json;
      Response.prototype.json = disguise(function (...args) {
        return jsonOriginal.apply(this, args).then(prune);
      }, jsonOriginal);
    }
  };

  LIBRARY['remove-attr'] = (rawAttrs, rawSelector, rawBehaviour) => {
    const attrs = String(rawAttrs || '').split(/\s*\|\s*/).filter(Boolean);
    if (!attrs.length) return;
    const selector = rawSelector || attrs.map(attr => `[${attr}]`).join(',');
    runRepeatedly(rawBehaviour, () => {
      for (const element of query(selector)) {
        for (const attr of attrs) { try { element.removeAttribute(attr); } catch {} }
      }
    });
  };

  LIBRARY['remove-class'] = (rawClasses, rawSelector, rawBehaviour) => {
    const classes = String(rawClasses || '').split(/\s*\|\s*/).filter(Boolean);
    if (!classes.length) return;
    const selector = rawSelector || classes.map(name => `.${CSS.escape(name)}`).join(',');
    runRepeatedly(rawBehaviour, () => {
      for (const element of query(selector)) {
        for (const name of classes) { try { element.classList.remove(name); } catch {} }
      }
    });
  };

  LIBRARY['remove-node-text'] = (tag, needle) => {
    const matchesText = toMatcher(needle);
    const scope = tagScope(tag);
    if (!scope) return;
    runRepeatedly('', () => {
      for (const element of query(scope)) {
        const text = element.textContent || '';
        if (!text || !matchesText(text)) continue;
        try { element.remove(); } catch {}
      }
    });
  };

  LIBRARY['replace-node-text'] = (tag, pattern, replacement) => {
    const scope = tagScope(tag);
    if (!scope) return;
    const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(String(pattern || ''));
    let regex = null;
    try { regex = regexMatch ? new RegExp(regexMatch[1], regexMatch[2]) : null; } catch {}
    if (!regex) return;
    runRepeatedly('', () => {
      for (const element of query(scope)) {
        const text = element.textContent;
        if (!text || !regex.test(text)) continue;
        try { element.textContent = text.replace(regex, String(replacement ?? '')); } catch {}
      }
    });
  };

  LIBRARY['set-local-storage-item'] = (key, rawValue) => storageSetter('localStorage', key, rawValue);
  LIBRARY['set-session-storage-item'] = (key, rawValue) => storageSetter('sessionStorage', key, rawValue);

  LIBRARY['set-cookie'] = (name, value, rawPath) => {
    if (!name) return;
    const path = rawPath || '/';
    const expires = new Date(Date.now() + 31_536_000_000).toUTCString();
    try {
      document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(String(value ?? ''))}; expires=${expires}; path=${path}`;
    } catch {}
  };

  LIBRARY['remove-cookie'] = (needle) => {
    const matches = toMatcher(needle, { emptyMatchesAll: false });
    const sweep = () => {
      let cookies = '';
      try { cookies = document.cookie; } catch { return; }
      for (const pair of cookies.split(';')) {
        const name = pair.split('=')[0]?.trim();
        if (!name || !matches(name)) continue;
        for (const domain of cookieDomains()) {
          try {
            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain ? `; domain=${domain}` : ''}`;
          } catch {}
        }
      }
    };
    sweep();
    addEventListener('load', sweep, { once: true });
  };

  LIBRARY['href-sanitizer'] = (rawSelector, rawSource) => {
    const selector = rawSelector || 'a[href]';
    const source = rawSource || '?';
    runRepeatedly('', () => {
      for (const anchor of query(selector)) {
        let href = '';
        try { href = anchor.getAttribute('href') || ''; } catch { continue; }
        if (!href) continue;
        let cleaned = null;
        try {
          const url = new URL(href, location.href);
          if (source.startsWith('?')) {
            const param = source.slice(1);
            const candidate = param ? url.searchParams.get(param) : null;
            if (candidate && /^https?:\/\//i.test(candidate)) cleaned = candidate;
          } else if (source === 'text') {
            const text = (anchor.textContent || '').trim();
            if (/^https?:\/\//i.test(text)) cleaned = text;
          }
        } catch {}
        if (cleaned && cleaned !== href) { try { anchor.setAttribute('href', cleaned); } catch {} }
      }
    });
  };

  LIBRARY['trusted-click-element'] = (selector, rawDelay) => {
    if (!selector) return;
    const delay = toNumberOrNull(rawDelay);
    const deadline = Date.now() + 10_000;
    const attempt = () => {
      if (Date.now() > deadline) return true;
      for (const part of String(selector).split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        let element = null;
        try { element = document.querySelector(trimmed); } catch { continue; }
        if (!element) continue;
        try { element.click(); } catch {}
        return true;
      }
      return false;
    };
    const start = () => {
      if (attempt()) return;
      const timer = setInterval(() => { if (attempt()) clearInterval(timer); }, 250);
      setTimeout(() => clearInterval(timer), 10_000);
    };
    if (delay) setTimeout(start, delay);
    else if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  };

  LIBRARY['nano-setTimeout-booster'] = (needle, rawDelay, rawBoost) => nanoBooster('setTimeout', needle, rawDelay, rawBoost);
  LIBRARY['nano-setInterval-booster'] = (needle, rawDelay, rawBoost) => nanoBooster('setInterval', needle, rawDelay, rawBoost);

  const ALIASES = {
    aopr: 'abort-on-property-read',
    aopw: 'abort-on-property-write',
    acs: 'abort-current-script',
    'abort-current-inline-script': 'abort-current-script',
    acis: 'abort-current-script',
    set: 'set-constant',
    nostif: 'no-setTimeout-if',
    'setTimeout-defuser': 'no-setTimeout-if',
    nosiif: 'no-setInterval-if',
    'setInterval-defuser': 'no-setInterval-if',
    aeld: 'addEventListener-defuser',
    ra: 'remove-attr',
    rc: 'remove-class',
    rmnt: 'remove-node-text',
    rpnt: 'replace-node-text',
    nowoif: 'no-window-open-if',
    'prevent-window-open': 'no-window-open-if',
    'window.open-defuser': 'no-window-open-if',
    'cookie-remover': 'remove-cookie',
    'trusted-set-cookie': 'set-cookie',
    'trusted-set-local-storage-item': 'set-local-storage-item',
    'nano-sib': 'nano-setInterval-booster',
    'nano-stb': 'nano-setTimeout-booster',
    'json-prune-fetch-response': 'json-prune',
  };

  // --- shared helpers used by several scriptlets ------------------------------

  function query(selector) {
    try { return [...document.querySelectorAll(selector)]; } catch { return []; }
  }

  /**
   * Text-rewriting scriptlets take a tag name. Anything that is not a literal
   * tag would force a walk of every element in the document on every mutation,
   * which costs more than the rule is worth, so those are declined.
   */
  function tagScope(tag) {
    const name = String(tag || '').trim().toLowerCase();
    return /^[a-z][a-z0-9-]*$/.test(name) ? name : null;
  }

  function cookieDomains() {
    const parts = location.hostname.split('.');
    const domains = [''];
    for (let i = parts.length - 2; i >= 0; i--) domains.push(`.${parts.slice(i).join('.')}`);
    return domains;
  }

  function storageSetter(store, key, rawValue) {
    if (!key) return;
    const value = parseValue(rawValue);
    try { globalThis[store]?.setItem(key, String(value)); } catch {}
  }

  function nanoBooster(kind, needle, rawDelay, rawBoost) {
    const matches = toMatcher(needle);
    const wanted = toNumberOrNull(rawDelay);
    const boost = Math.max(0.001, Math.min(50, Number(rawBoost) || 0.05));
    const original = globalThis[kind];
    globalThis[kind] = disguise(function (handler, timeout, ...rest) {
      const text = typeof handler === 'function' ? toStringRaw.call(handler) : String(handler);
      const next = matches(text) && (wanted === null || wanted === Number(timeout))
        ? Number(timeout) * boost
        : timeout;
      return original.call(this, handler, next, ...rest);
    }, original);
  }

  /**
   * Several scriptlets must keep working as a page rewrites itself. `behaviour`
   * follows uBO's convention: `stay` keeps observing, anything else runs until
   * the document settles.
   */
  function runRepeatedly(behaviour, action) {
    const persistent = String(behaviour || '').includes('stay');
    const run = () => { try { action(); } catch {} };
    run();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    }
    let observer = null;
    try {
      observer = new MutationObserver(() => run());
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch {}
    if (!persistent) {
      setTimeout(() => observer?.disconnect(), 10_000);
    }
  }

  // --- dispatch ---------------------------------------------------------------

  function runRule(rule) {
    if (!Array.isArray(rule) || !rule.length) return;
    const rawName = String(rule[0] || '');
    const name = ALIASES[rawName] || rawName;
    const implementation = LIBRARY[name];
    if (typeof implementation !== 'function') return;
    try { implementation(...rule.slice(1)); } catch {}
  }

  /**
   * Buckets and this library are registered together and either may run first,
   * so buckets push onto a queue and whichever side arrives second drains it.
   */
  function drain() {
    const queue = globalThis.__oeScriptletQueue;
    if (!Array.isArray(queue)) return;
    while (queue.length) {
      const rules = queue.shift();
      if (Array.isArray(rules)) for (const rule of rules) runRule(rule);
    }
  }

  globalThis.__oeScriptletRun = rules => {
    if (Array.isArray(rules)) for (const rule of rules) runRule(rule);
  };
  globalThis.__oeScriptletFlush = drain;
  drain();
})();
