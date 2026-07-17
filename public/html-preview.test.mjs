/**
 * Unit tests for HTML preview helpers extracted from public/tutor.js.
 * Uses a minimal DOM mock (no jsdom dependency).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tutorSrc = fs.readFileSync(path.join(__dirname, 'tutor.js'), 'utf8');

function makeDom() {
  const document = {
    _els: [],
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        className: '',
        hidden: false,
        dataset: {},
        style: {},
        childNodes: [],
        children: [],
        attributes: {},
        textContent: '',
        innerHTML: '',
        parentElement: null,
        srcdoc: '',
        src: '',
        setAttribute(k, v) { this.attributes[k] = v; if (k === 'srcdoc') this.srcdoc = v; },
        removeAttribute(k) { delete this.attributes[k]; if (k === 'srcdoc') this.srcdoc = ''; },
        getAttribute(k) { return this.attributes[k]; },
        appendChild(child) {
          child.parentElement = this;
          this.childNodes.push(child);
          this.children.push(child);
          return child;
        },
        replaceWith(next) {
          const parent = this.parentElement;
          if (!parent) return;
          const i = parent.childNodes.indexOf(this);
          if (i >= 0) parent.childNodes[i] = next;
          const j = parent.children.indexOf(this);
          if (j >= 0) parent.children[j] = next;
          next.parentElement = parent;
          this.parentElement = null;
        },
        querySelector(sel) {
          return find(this, sel, true);
        },
        querySelectorAll(sel) {
          return find(this, sel, false);
        },
        closest(sel) {
          let n = this;
          while (n) {
            if (matches(n, sel)) return n;
            n = n.parentElement;
          }
          return null;
        },
      };
      document._els.push(el);
      return el;
    },
    body: null,
    getElementById(id) {
      return document._els.find(e => e.id === id) || null;
    },
    querySelector(sel) {
      return find({ children: document._els.filter(e => !e.parentElement), childNodes: document._els.filter(e => !e.parentElement), querySelectorAll(s) { return find(this, s, false); } }, sel, true);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  document.body = document.createElement('body');

  function matches(el, sel) {
    if (!el || !sel) return false;
    if (sel.startsWith('.')) {
      const cls = sel.slice(1).split(/[\[\s]/)[0];
      return String(el.className || '').split(/\s+/).includes(cls);
    }
    if (sel.includes('[')) {
      // .html-preview-card[data-html-preview-id="x"]
      const m = sel.match(/^\.([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
      if (m) {
        const [, cls, attr, val] = m;
        if (!String(el.className || '').split(/\s+/).includes(cls)) return false;
        if (attr.startsWith('data-')) {
          const key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          return el.dataset?.[key] === val;
        }
        return el.attributes?.[attr] === val;
      }
    }
    if (sel.includes(' > ')) {
      // not used for matches on single el
      return false;
    }
    if (sel === 'pre' || sel === 'code' || sel === 'iframe' || sel === 'div') {
      return el.tagName === sel.toUpperCase();
    }
    if (sel.startsWith('pre') || sel.startsWith('code') || sel.startsWith('iframe')) {
      return el.tagName === sel.toUpperCase();
    }
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const inner = sel.slice(1, -1);
      if (inner.startsWith('data-')) {
        const key = inner.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return el.dataset?.[key] != null;
      }
    }
    return false;
  }

  function find(root, sel, firstOnly) {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      if (sel.includes(' > ')) {
        // handled specially below for pre > code
      } else if (matches(node, sel) && node !== root) {
        out.push(node);
        if (firstOnly) return true;
      }
      // special: pre > code
      if (sel === 'pre > code' && node.tagName === 'PRE') {
        for (const c of node.children || []) {
          if (c.tagName === 'CODE') {
            out.push(c);
            if (firstOnly) return true;
          }
        }
      }
      for (const c of node.children || []) {
        if (walk(c)) return true;
      }
      return false;
    };
    // For querySelectorAll('pre > code') on root
    if (sel === 'pre > code') {
      const walkPre = (node) => {
        if (node.tagName === 'PRE') {
          for (const c of node.children || []) {
            if (c.tagName === 'CODE') out.push(c);
          }
        }
        for (const c of node.children || []) walkPre(c);
      };
      walkPre(root);
      return firstOnly ? (out[0] || null) : out;
    }
    if (sel.startsWith('.html-preview-card[')) {
      const m = sel.match(/data-html-preview-id="([^"]*)"/);
      const want = m?.[1];
      for (const el of document._els) {
        if (String(el.className || '').includes('html-preview-card') && el.dataset?.htmlPreviewId === want) {
          out.push(el);
          if (firstOnly) break;
        }
      }
      return firstOnly ? (out[0] || null) : out;
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1).split(/[\[\s:]/)[0];
      for (const el of (root.children?.length ? null : document._els) || []) {
        // fallthrough
      }
      const walkCls = (node) => {
        if (node !== root && String(node.className || '').split(/\s+/).includes(cls)) {
          out.push(node);
          if (firstOnly) return true;
        }
        // also match compound selectors like .html-preview-frame
        for (const c of node.children || []) {
          if (walkCls(c)) return true;
        }
        return false;
      };
      walkCls(root);
      // Also search by class among descendants via recursive children
      if (!out.length) {
        for (const el of document._els) {
          if (String(el.className || '').split(/\s+/).includes(cls)) {
            // only if under root
            let p = el;
            let under = false;
            while (p) {
              if (p === root) { under = true; break; }
              p = p.parentElement;
            }
            if (under || root === document) out.push(el);
          }
        }
      }
      return firstOnly ? (out[0] || null) : out;
    }
    if (sel.startsWith('[')) {
      const walkAttr = (node) => {
        if (matches(node, sel) && node !== root) {
          out.push(node);
          if (firstOnly) return true;
        }
        for (const c of node.children || []) {
          if (walkAttr(c)) return true;
        }
        return false;
      };
      walkAttr(root);
      return firstOnly ? (out[0] || null) : out;
    }
    walk(root);
    return firstOnly ? (out[0] || null) : out;
  }

  // Attach find to elements via prototype-like method already set

  return {
    document,
    window: {
      document,
      CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    },
    // helper to build pre>code structure
    makeCodeBlock(className, text) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = className;
      code.textContent = text;
      pre.appendChild(code);
      return pre;
    },
  };
}

function loadHelpers(dom) {
  const start = tutorSrc.indexOf('function looksLikeHtmlDocument');
  const end = tutorSrc.indexOf('function wrapTables');
  if (start < 0 || end < 0) throw new Error('Could not locate HTML preview helpers in tutor.js');
  const slice = tutorSrc.slice(start, end);
  const factory = new Function('document', 'window', 'CSS', `${slice}
    return {
      looksLikeHtmlDocument,
      isHtmlLanguageClass,
      decorateHtmlPreviews,
      toggleHtmlPreview,
      setHtmlPreviewMode,
    };
  `);
  return factory(dom.document, dom.window, dom.window.CSS);
}

describe('HTML preview helpers', () => {
  let dom;
  let helpers;

  beforeEach(() => {
    dom = makeDom();
    helpers = loadHelpers(dom);
  });

  it('detects full HTML documents', () => {
    expect(helpers.looksLikeHtmlDocument('<!doctype html><html></html>')).toBe(true);
    expect(helpers.looksLikeHtmlDocument('<html lang="en"><body></body></html>')).toBe(true);
    expect(helpers.looksLikeHtmlDocument('<div>hi</div>')).toBe(false);
  });

  it('recognizes language-html class names', () => {
    expect(helpers.isHtmlLanguageClass('language-html')).toBe(true);
    expect(helpers.isHtmlLanguageClass('language-htm')).toBe(true);
    expect(helpers.isHtmlLanguageClass('language-html hljs')).toBe(true);
    expect(helpers.isHtmlLanguageClass('language-js')).toBe(false);
  });

  it('wraps language-html code fences with a preview card', () => {
    const root = dom.document.createElement('div');
    const pre = dom.makeCodeBlock('language-html', '<!doctype html>\n<html><body><h1>News</h1></body></html>\n');
    root.appendChild(pre);
    helpers.decorateHtmlPreviews(root);
    const card = root.querySelector('.html-preview-card');
    expect(card).toBeTruthy();
    expect(card.querySelector('.html-preview-frame')).toBeTruthy();
    expect(card.dataset.previewing).toBe('1');
    expect(card.querySelector('.html-preview-frame').srcdoc).toContain('<h1>News</h1>');
  });

  it('leaves non-html code blocks alone', () => {
    const root = dom.document.createElement('div');
    root.appendChild(dom.makeCodeBlock('language-js', 'console.log(1)'));
    helpers.decorateHtmlPreviews(root);
    expect(root.querySelector('.html-preview-card')).toBeNull();
  });

  it('toggles between preview and source', () => {
    const root = dom.document.createElement('div');
    root.appendChild(dom.makeCodeBlock('language-html', '<!doctype html><html><body>x</body></html>'));
    helpers.decorateHtmlPreviews(root);
    const card = root.querySelector('.html-preview-card');
    const id = card.dataset.htmlPreviewId;
    expect(card.dataset.previewing).toBe('1');
    helpers.toggleHtmlPreview(id);
    expect(card.dataset.previewing).toBe('0');
    expect(card.querySelector('.html-preview-frame').hidden).toBe(true);
    helpers.toggleHtmlPreview(id);
    expect(card.dataset.previewing).toBe('1');
  });
});
