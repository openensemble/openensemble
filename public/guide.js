// ── Guide drawer ──────────────────────────────────────────────────────────────
// Renders the bundled OpenEnsemble user guide from /api/guide.
// Pages are markdown stored under guide/{slug}.md on the server.

let _guideIndex      = null;            // { sections: [...] }
let _guidePageCache  = new Map();       // slug -> { title, body, html }
let _guideCurrent    = null;            // current slug
let _guideSearchTerm = '';

async function openGuideDrawer() {
  if (!_guideIndex || !Array.isArray(_guideIndex.sections) || !_guideIndex.sections.length) {
    const toc = document.getElementById('guideToc');
    if (toc) toc.innerHTML = `<div style="padding:14px;color:var(--muted);font-size:12px">Loading…</div>`;
    try {
      const r = await fetch('/api/guide');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data?.sections)) throw new Error('No sections in response');
      _guideIndex = data;
    } catch (e) {
      console.error('[guide] index load failed', e);
      if (toc) toc.innerHTML = `<div style="padding:14px;color:var(--muted);font-size:12px">Failed to load guide: ${escHtml(e.message ?? String(e))}</div>`;
      return;
    }
  }
  _renderGuideToc();
  // Default page: first slug, or restore last-viewed if cached.
  const firstSlug = _guideIndex.sections?.[0]?.pages?.[0]?.slug;
  const target = _guideCurrent && _slugInIndex(_guideCurrent) ? _guideCurrent : firstSlug;
  if (target) _loadGuidePage(target);

  const search = document.getElementById('guideSearch');
  if (search && !search._guideWired) {
    search._guideWired = true;
    search.addEventListener('input', e => {
      _guideSearchTerm = (e.target.value || '').trim().toLowerCase();
      _renderGuideToc();
    });
  }
}

function _slugInIndex(slug) {
  for (const s of _guideIndex?.sections ?? [])
    for (const p of s.pages ?? []) if (p.slug === slug) return true;
  return false;
}

function _renderGuideToc() {
  const toc = document.getElementById('guideToc');
  if (!toc || !_guideIndex) return;

  const term = _guideSearchTerm;
  const html = [];

  for (const section of _guideIndex.sections ?? []) {
    const matchedPages = (section.pages ?? []).filter(p => {
      if (!term) return true;
      // Match against title, slug, and the cached body if we have it.
      const cached = _guidePageCache.get(p.slug);
      const hay = [p.title, p.slug, cached?.body ?? ''].join(' ').toLowerCase();
      return hay.includes(term);
    });
    if (!matchedPages.length) continue;

    html.push(`<div style="padding:6px 14px 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">${escHtml(section.title)}</div>`);
    for (const p of matchedPages) {
      const active = p.slug === _guideCurrent;
      html.push(
        `<button class="guide-toc-item" data-slug="${escHtml(p.slug)}" style="display:block;width:100%;text-align:left;padding:6px 14px;background:${active ? 'var(--bg3)' : 'transparent'};border:none;color:${active ? 'var(--text)' : 'var(--muted)'};font-size:12.5px;cursor:pointer;border-left:2px solid ${active ? 'var(--accent)' : 'transparent'}">${escHtml(p.title)}</button>`
      );
    }
  }

  if (!html.length) {
    toc.innerHTML = `<div style="padding:14px;color:var(--muted);font-size:12px">No matches.</div>`;
  } else {
    toc.innerHTML = html.join('');
  }

  toc.querySelectorAll('.guide-toc-item').forEach(btn => {
    btn.addEventListener('click', () => _loadGuidePage(btn.dataset.slug));
  });
}

async function _loadGuidePage(slug) {
  _guideCurrent = slug;
  _renderGuideToc();
  const pane = document.getElementById('guideContent');
  if (!pane) return;

  let cached = _guidePageCache.get(slug);
  if (!cached) {
    pane.innerHTML = `<div style="color:var(--muted);font-size:12px">Loading…</div>`;
    try {
      const data = await fetch(`/api/guide/page/${encodeURIComponent(slug)}`).then(r => r.json());
      if (data.error) throw new Error(data.error);
      cached = { title: data.title, body: data.body, html: renderMarkdown(data.body) };
      _guidePageCache.set(slug, cached);
    } catch (e) {
      pane.innerHTML = `<div style="color:var(--muted);font-size:12px">Failed to load page: ${escHtml(e.message ?? String(e))}</div>`;
      return;
    }
  }

  pane.innerHTML = cached.html;
  pane.scrollTop = 0;
}

// Programmatic open — used by other code that wants to deep-link into the guide.
function openGuide(slug) {
  if (typeof toggleDrawer === 'function') toggleDrawer('drawerGuide', 'sbtnGuide');
  if (slug) {
    // openGuideDrawer is async; load directly after a tick so the drawer paints first.
    setTimeout(() => _loadGuidePage(slug), 0);
  }
}
