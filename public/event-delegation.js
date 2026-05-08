/**
 * Global event delegation harness.
 *
 * Lets us drop `unsafe-inline` from CSP `script-src` while keeping the
 * familiar "declare a handler in HTML" ergonomics. Instead of:
 *
 *   <button onclick="deleteThing('x')">…</button>
 *
 * we write:
 *
 *   <button data-action="deleteThing" data-args='["x"]'>…</button>
 *
 * and a single document-level listener routes the event to the named global
 * function. The function receives the parsed args, with `this` bound to the
 * element that carried the data-action attribute, and the original event as
 * the last argument (so handlers that need `event.stopPropagation()` etc.
 * can still reach it).
 *
 * Conventions:
 *   - data-action          → name of a global function (window[name])
 *   - data-args            → JSON array of positional args (optional; default [])
 *   - data-event           → which event triggers it (default: 'click')
 *
 * Multi-event elements declare more than one action via:
 *   data-action="onClick"     for click
 *   data-change-action="x"    for change
 *   data-input-action="x"     for input
 *   data-keydown-action="x"   for keydown
 *   data-submit-action="x"    for submit
 *   data-toggle-action="x"    for toggle (details/summary)
 *
 * Each event type has its own data-<event>-args sibling for that event's
 * arg list. Falls back to data-args if the event-specific one is absent.
 *
 * Special args:
 *   "$value"    → element.value          (input.value etc.)
 *   "$checked"  → element.checked        (checkbox)
 *   "$files"    → element.files          (file input)
 *   "$files0"   → element.files?.[0]
 *   "$key"      → event.key              (key events)
 *   "$target"   → event.target
 *   "$el"       → element with data-action
 *
 * For inline expressions that don't fit (multi-statement, ternaries), use
 * one of the bundled helpers exposed on window: `_actionPipeline` runs
 * a list of [fn, args] pairs in order; `_actionIf` runs fn if a key matches.
 */
(function () {
  function readArg(token, el, ev) {
    if (typeof token !== 'string' || token[0] !== '$') return token;
    switch (token) {
      case '$value':   return el.value;
      case '$checked': return el.checked;
      case '$files':   return el.files;
      case '$files0':  return el.files?.[0];
      case '$key':     return ev.key;
      case '$target':  return ev.target;
      case '$el':      return el;
      default:         return token;
    }
  }

  function dispatch(eventName, ev) {
    let el = ev.target;
    while (el && el !== document.body && el !== document) {
      const ds = el.dataset;
      if (ds) {
        // Pick the right attribute pair: data-<event>-action / data-<event>-args.
        // For click, data-action / data-args is the canonical short form.
        let actionAttr, argsAttr;
        if (eventName === 'click') {
          actionAttr = ds.action;
          argsAttr   = ds.args;
        } else {
          actionAttr = ds[`${eventName}Action`];
          argsAttr   = ds[`${eventName}Args`] ?? ds.args;
        }
        if (actionAttr) {
          const fn = window[actionAttr];
          if (typeof fn === 'function') {
            // Common companions: data-stop-propagation, data-prevent-default.
            // Either as bare attributes or "1"/"true" values; both stop the
            // event bubbling/default before the handler runs (matching the
            // old inline `event.stopPropagation();fn()` pattern).
            if (ds.stopPropagation != null && ds.stopPropagation !== 'false') ev.stopPropagation();
            if (ds.preventDefault != null && ds.preventDefault !== 'false') ev.preventDefault();
            let args = [];
            if (argsAttr) {
              try { args = JSON.parse(argsAttr); } catch { args = []; }
            }
            const resolved = args.map(t => readArg(t, el, ev));
            try {
              fn.apply(el, [...resolved, ev]);
            } catch (e) {
              console.error(`[event-delegation] ${eventName}-handler '${actionAttr}' threw:`, e);
            }
            return;
          }
        }
      }
      el = el.parentElement;
    }
  }

  // Compose helper for handlers that previously used "fn1();fn2()" style
  // multi-statement onclick bodies. Pass [["fn1",[args]], ["fn2",[args]]].
  window._actionPipeline = function (pipeline, ev) {
    if (!Array.isArray(pipeline)) return;
    for (const step of pipeline) {
      const [name, rawArgs = []] = step;
      const fn = window[name];
      if (typeof fn === 'function') {
        const args = rawArgs.map(t => readArg(t, this, ev));
        try { fn.apply(this, [...args, ev]); }
        catch (e) { console.error(`[event-delegation] pipeline step '${name}' threw:`, e); }
      }
    }
  };

  // Conditional helper for "if(event.key==='Enter')fn()" style handlers.
  // Pass {key:'Enter', action:'fn', args:[…]}.
  window._actionIf = function (cond, ev) {
    if (typeof cond !== 'object' || !cond) return;
    if (cond.key && ev.key !== cond.key) return;
    if (cond.code && ev.code !== cond.code) return;
    const fn = window[cond.action];
    if (typeof fn !== 'function') return;
    const args = (cond.args || []).map(t => readArg(t, this, ev));
    try { fn.apply(this, [...args, ev]); }
    catch (e) { console.error(`[event-delegation] _actionIf '${cond.action}' threw:`, e); }
  };

  // Bound dispatchers — module-scope so removeEventListener could match.
  const onClick   = (e) => dispatch('click',   e);
  const onChange  = (e) => dispatch('change',  e);
  const onInput   = (e) => dispatch('input',   e);
  const onKeydown = (e) => dispatch('keydown', e);
  const onKeyup   = (e) => dispatch('keyup',   e);
  const onSubmit  = (e) => dispatch('submit',  e);
  const onToggle  = (e) => dispatch('toggle',  e);
  const onFocus   = (e) => dispatch('focus',   e);
  const onBlur    = (e) => dispatch('blur',    e);
  const onError   = (e) => dispatch('error',   e);
  const onLoad    = (e) => dispatch('load',    e);
  const onMouseover = (e) => dispatch('mouseover', e);
  const onMouseout  = (e) => dispatch('mouseout',  e);
  const onPaste   = (e) => dispatch('paste',   e);
  const onDragover = (e) => dispatch('dragover', e);
  const onDragleave = (e) => dispatch('dragleave', e);
  const onDrop    = (e) => dispatch('drop',    e);

  document.addEventListener('click',     onClick);
  document.addEventListener('dragover',  onDragover);
  document.addEventListener('dragleave', onDragleave);
  document.addEventListener('drop',      onDrop);
  document.addEventListener('change',    onChange);
  document.addEventListener('input',     onInput);
  document.addEventListener('keydown',   onKeydown);
  document.addEventListener('keyup',     onKeyup);
  document.addEventListener('submit',    onSubmit);
  document.addEventListener('mouseover', onMouseover);
  document.addEventListener('mouseout',  onMouseout);
  document.addEventListener('paste',     onPaste, true);
  // These events don't bubble — capture phase catches them at document level.
  document.addEventListener('toggle',    onToggle, true);  // <details>
  document.addEventListener('focus',     onFocus,  true);
  document.addEventListener('blur',      onBlur,   true);
  document.addEventListener('error',     onError,  true);  // <img onerror>
  document.addEventListener('load',      onLoad,   true);  // <img onload>

  // Generic helper for the very common "onerror=this.style.display='none'"
  // pattern on broken images.
  window._hideElement = function () { this.style.display = 'none'; };
  // And the equally common "onmouseover=this.style.background='var(--bg3)'" /
  // "onmouseout=this.style.background=''" pair: pass a CSS color string in args.
  window._setBg = function (color) { this.style.background = color || ''; };
  // Replace a broken image with an emoji fallback inside its parent.
  window._imgFallbackEmoji = function () {
    if (this.parentElement) this.parentElement.innerHTML = '<span style="font-size:36px">🖼️</span>';
  };
  // Hide a broken image and show its next-sibling fallback container.
  window._imgShowFallbackSibling = function () {
    this.style.display = 'none';
    if (this.nextElementSibling) this.nextElementSibling.style.display = 'flex';
  };
  // Used by dragover handlers that previously inlined `event.preventDefault()`.
  window._preventDefault = function (event) { event?.preventDefault?.(); };
  // Backdrop dismiss: only run `fnName` when click landed on the backdrop
  // itself (not bubbling up from a child). Replaces the
  //   onclick="if(event.target===this)closeXxx()"
  // pattern used on every modal backdrop.
  window._backdropClick = function (fnName, event) {
    if (event.target !== this) return;
    const fn = window[fnName];
    if (typeof fn === 'function') fn.call(this, event);
  };
  // Toggle the open class on an element by id.
  window._toggleOpenById = function (id) { document.getElementById(id)?.classList.toggle('open'); };
  // Trigger a programmatic click on a sibling element (e.g. file picker).
  window._clickById = function (id) { document.getElementById(id)?.click(); };
  // Run a series of named functions in order; helper for the
  // "onclick='fn1();fn2()'" pattern that was very common.
  window._chain = function (...names) { for (const n of names) try { window[n]?.(); } catch (e) { console.error('[chain]', n, e); } };
  // Shortcut for closeDrawer + toggleDrawer(drawerId, btnId?) — first the
  // close, then re-open the named drawer. Supports the strip-button
  // navigation pattern.
  window._closeAndToggleDrawer = function (drawerId, btnId) {
    if (typeof closeDrawer === 'function') closeDrawer();
    if (typeof toggleDrawer === 'function') toggleDrawer(drawerId, btnId);
  };
  // Shortcut for closeDrawer + open<X> — the standalone callback that
  // closes drawers then runs a named global function.
  window._closeDrawerThen = function (fnName) {
    if (typeof closeDrawer === 'function') closeDrawer();
    const fn = window[fnName];
    if (typeof fn === 'function') fn();
  };
  // Wrappers for known multi-statement onclick bodies in index.html that
  // chain settings drawer + tab.
  window._closeDrawersOpenNewAgent = function () {
    if (typeof closeAllDrawers === 'function') closeAllDrawers();
    if (typeof openNewAgentModal === 'function') openNewAgentModal();
  };
  window._openSettingsTab = function (tab) {
    if (typeof openSettingsDrawer === 'function') openSettingsDrawer();
    if (typeof switchSettingsTab === 'function') switchSettingsTab(tab);
  };
  // toggle:if-open helper for <details> ontoggle handlers.
  window._ifOpenRefreshLogs = function () {
    if (this.open && typeof refreshLogs === 'function') refreshLogs();
  };
  // closeUserPicker(); logout()
  window._userPickerLogout = function () {
    if (typeof closeUserPicker === 'function') closeUserPicker();
    if (typeof logout === 'function') logout();
  };
  // closeDrawer(); switchView(name)
  window._closeDrawerThenSwitchView = function (view) {
    if (typeof closeDrawer === 'function') closeDrawer();
    if (typeof switchView === 'function') switchView(view);
  };
})();
