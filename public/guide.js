// Guide pages and search use the same bundled Markdown as the public user guide.
let _guideIndex = null;
let _guideIndexRequest = null;
const _guidePageCache = new Map();
let _guideCurrent = null;
let _guidePageRequest = 0;
let _guidePendingTarget = null;
let _guideSearchTerm = '';
let _guideSearchMatches = new Set();
let _guideSearchStatus = 'idle';
let _guideSearchTimer = null;
let _guideSearchRequest = 0;
const _WHATS_NEW_SEEN_KEY = 'oe_whats_new_seen';

function _setWhatsNewAlert(show) {
  const dot = document.getElementById('sbtnGuideAlert');
  if (dot) dot.style.display = show ? '' : 'none';
}

async function _ensureGuideIndex() {
  if (_guideIndex) return _guideIndex;
  if (!_guideIndexRequest) {
    _guideIndexRequest = (async () => {
      const response = await fetch('/api/guide');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const index = await response.json();
      if (!Array.isArray(index?.sections)) throw new Error('No guide sections received');
      _guideIndex = index;
      return index;
    })().finally(() => { _guideIndexRequest = null; });
  }
  return _guideIndexRequest;
}

// Called after authentication. A guide link can also open in another tab.
async function checkWhatsNewBadge() {
  try {
    const index = await _ensureGuideIndex();
    const version = index.whatsNewVersion;
    if (version) {
      let seen;
      try { seen = localStorage.getItem(_WHATS_NEW_SEEN_KEY); } catch {}
      _setWhatsNewAlert(seen !== version);
    }
    const url = new URL(location.href);
    const slug = url.searchParams.get('guide');
    if (slug && _slugInIndex(slug)) openGuide(slug, url.hash.slice(1));
  } catch {}
}

async function openGuideDrawer() {
  const toc = document.getElementById('guideToc');
  try {
    if (!_guideIndex && toc) toc.textContent = 'Loading guide…';
    await _ensureGuideIndex();
  } catch (error) {
    if (toc) toc.textContent = 'Failed to load guide: ' + error.message;
    return;
  }
  const search = document.getElementById('guideSearch');
  if (search && !search._guideWired) {
    search._guideWired = true;
    search.addEventListener('input', () => _searchGuide(search.value));
  }
  const contents = document.getElementById('guideContentsToggle');
  if (contents && !contents._guideWired) {
    contents._guideWired = true;
    contents.addEventListener('click', () => _showGuideContents(contents.getAttribute('aria-expanded') !== 'true'));
  }
  const pane = document.getElementById('guideContent');
  if (pane && !pane._guideWired) {
    pane._guideWired = true;
    pane.addEventListener('click', event => {
      const link = event.target.closest('a[data-guide-slug]');
      if (!link || !pane.contains(link) || event.button !== 0
          || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      _loadGuidePage(link.dataset.guideSlug, link.dataset.guideAnchor);
    });
  }
  const pending = _guidePendingTarget;
  _guidePendingTarget = null;
  // Opening the Guide starts with release notes; explicit page links retain
  // their destination, including links from chat and other guide pages.
  const slug = pending?.slug || (_slugInIndex('whats-new') ? 'whats-new' : _guideIndex.sections[0]?.pages[0]?.slug);
  if (!pending) {
    if (search) search.value = '';
    _searchGuide('');
  }
  _renderGuideToc();
  if (slug) await _loadGuidePage(slug, pending?.anchor);
}

function _slugInIndex(slug) {
  return _guideIndex?.sections.some(section => section.pages?.some(page => page.slug === slug)) ?? false;
}

function _showGuideContents(show) {
  document.getElementById('drawerGuide')?.classList.toggle('guide-show-toc', show);
  document.getElementById('guideContentsToggle')?.setAttribute('aria-expanded', String(show));
}

function _searchGuide(value) {
  _guideSearchTerm = value.trim();
  if (_guideSearchTerm) _showGuideContents(true);
  clearTimeout(_guideSearchTimer);
  const request = ++_guideSearchRequest;
  _guideSearchMatches = new Set();
  _guideSearchStatus = _guideSearchTerm ? 'loading' : 'idle';
  _renderGuideToc();
  if (!_guideSearchTerm) return;
  const term = _guideSearchTerm;
  _guideSearchTimer = setTimeout(async () => {
    try {
      const response = await fetch('/api/guide/search?q=' + encodeURIComponent(term));
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (!Array.isArray(data.matches)) throw new Error('Invalid search response');
      if (request !== _guideSearchRequest) return;
      _guideSearchMatches = new Set(data.matches);
      _guideSearchStatus = 'ready';
    } catch {
      if (request !== _guideSearchRequest) return;
      _guideSearchStatus = 'error';
    }
    _renderGuideToc();
  }, 150);
}

function _renderGuideToc() {
  const toc = document.getElementById('guideToc');
  if (!toc || !_guideIndex) return;
  let message = '';
  if (_guideSearchStatus === 'loading') message = 'Searching all guide pages…';
  if (_guideSearchStatus === 'error') message = 'Search unavailable. Clear the search to browse, or type again to retry.';
  if (message) {
    toc.innerHTML = '<div role="status" style="padding:14px;color:var(--muted);font-size:12px">' + message + '</div>';
    return;
  }
  const html = [];
  for (const section of _guideIndex.sections) {
    const pages = (section.pages ?? []).filter(page => !_guideSearchTerm || _guideSearchMatches.has(page.slug));
    if (!pages.length) continue;
    html.push('<div style="padding:6px 14px 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">' + escHtml(section.title) + '</div>');
    for (const page of pages) {
      const active = page.slug === _guideCurrent;
      html.push('<button class="guide-toc-item" data-slug="' + escHtml(page.slug) + '"'
        + (active ? ' aria-current="page"' : '')
        + ' style="display:block;width:100%;text-align:left;padding:6px 14px;background:' + (active ? 'var(--bg3)' : 'transparent')
        + ';border:none;color:' + (active ? 'var(--text)' : 'var(--muted)')
        + ';font-size:12.5px;cursor:pointer;border-left:2px solid ' + (active ? 'var(--accent)' : 'transparent') + '">'
        + escHtml(page.title) + '</button>');
    }
  }
  toc.innerHTML = html.join('') || '<div role="status" style="padding:14px;color:var(--muted);font-size:12px">No matches.</div>';
  toc.querySelectorAll('.guide-toc-item').forEach(button => {
    button.addEventListener('click', () => _loadGuidePage(button.dataset.slug));
  });
}

function _prepareGuideLinks(pane, slug) {
  const used = new Set();
  pane.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(heading => {
    const base = heading.textContent.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-') || 'section';
    let anchor = base;
    for (let suffix = 1; used.has(anchor); suffix++) anchor = base + '-' + suffix;
    used.add(anchor);
    heading.dataset.guideAnchor = anchor;
    heading.id = 'guide-' + slug + '-' + anchor;
  });
  pane.querySelectorAll('a[href]').forEach(link => {
    const href = link.getAttribute('href');
    const match = href.match(/^(?:\.\/)?([a-z0-9-]+)\.md(?:#(.*))?$/);
    const target = match ? match[1] : href.startsWith('#') ? slug : null;
    if (!target || !_slugInIndex(target)) return;
    const anchor = match ? (match[2] || '') : href.slice(1);
    link.dataset.guideSlug = target;
    link.dataset.guideAnchor = anchor;
    link.href = '/?guide=' + encodeURIComponent(target) + (anchor ? '#' + anchor : '');
  });
}

async function _loadGuidePage(slug, anchor = '') {
  if (!_slugInIndex(slug)) return;
  _showGuideContents(false);
  _guideCurrent = slug;
  const request = ++_guidePageRequest;
  _renderGuideToc();
  const pane = document.getElementById('guideContent');
  if (!pane) return;
  let cached = _guidePageCache.get(slug);
  if (!cached) {
    pane.textContent = 'Loading…';
    try {
      const response = await fetch('/api/guide/page/' + encodeURIComponent(slug));
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (typeof data.body !== 'string') throw new Error('No guide text received');
      cached = { html: wrapTables(DOMPurify.sanitize(marked.parse(data.body, { breaks: false }))) };
      _guidePageCache.set(slug, cached);
    } catch (error) {
      if (request === _guidePageRequest) pane.textContent = 'Failed to load page: ' + error.message;
      return;
    }
  }
  if (request !== _guidePageRequest) return;
  pane.innerHTML = cached.html;
  _prepareGuideLinks(pane, slug);
  pane.scrollTop = 0;
  let decoded = anchor;
  try { decoded = decodeURIComponent(anchor); } catch {}
  const heading = Array.from(pane.querySelectorAll('[data-guide-anchor]'))
    .find(element => /^H[1-6]$/.test(element.tagName) && element.dataset.guideAnchor === decoded);
  if (heading) pane.scrollTop = heading.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  if (slug === 'whats-new' && _guideIndex.whatsNewVersion) {
    try { localStorage.setItem(_WHATS_NEW_SEEN_KEY, _guideIndex.whatsNewVersion); } catch {}
    _setWhatsNewAlert(false);
  }
}

function openGuide(slug, anchor = '') {
  _guidePendingTarget = slug ? { slug, anchor } : null;
  const drawer = document.getElementById('drawerGuide');
  if (drawer && !drawer.classList.contains('open') && typeof toggleDrawer === 'function') {
    toggleDrawer('drawerGuide', 'sbtnGuide');
  } else {
    return openGuideDrawer();
  }
}
