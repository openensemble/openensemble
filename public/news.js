// ── News ──────────────────────────────────────────────────────────────────────
let NEWS_TOPICS = [
  { label: 'Top',      q: 'top news today' },
  { label: 'Politics', q: 'politics news today' },
  { label: 'Tech',     q: 'technology news today' },
  { label: 'Crypto',   q: 'cryptocurrency bitcoin news today' },
  { label: 'Markets',  q: 'stock market finance news today' },
];
let newsTopic = 0;

function newsToolbar() {
  const btns = NEWS_TOPICS.map((t, i) =>
    `<button class="topic-btn${i===newsTopic?' active':''}" onclick="loadNews(${i})">${t.label}</button>`
  ).join('');
  return `<div class="drawer-toolbar"><div class="drawer-toolbar-topics">${btns}</div><button class="drawer-refresh" onclick="loadNews()">↻</button></div>`;
}

async function loadNews(topicIdx) {
  if (topicIdx !== undefined) {
    newsTopic = topicIdx;
    saveNewsTopicPref(topicIdx); // persist to user profile
  }
  const el = $('newsFeed');
  const { q } = NEWS_TOPICS[newsTopic];
  el.innerHTML = newsToolbar() + `<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">Loading…</div>`;
  try {
    const articles = await fetch(`/api/news?q=${encodeURIComponent(q)}&count=10`).then(r => r.json());
    if (articles.error) throw new Error(articles.error);
    if (!articles.length) { el.innerHTML = newsToolbar() + `<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">No results.</div>`; return; }

    const cards = articles.map(a => {
      const imgHtml = a.image
        ? `<img class="news-card-img" src="${escHtml(a.image)}" onerror="this.style.display='none'" loading="lazy" alt="">`
        : '';
      return `<a class="news-card" href="${escHtml(a.url)}" target="_blank" rel="noopener">
        ${imgHtml}
        <div class="news-card-body">
          <div class="news-card-meta">
            <span class="news-card-source">${escHtml(a.source)}</span>
            <span class="news-card-age">${escHtml(a.age)}</span>
          </div>
          <div class="news-card-title">${escHtml(a.title)}</div>
          ${a.description ? `<div class="news-card-desc">${escHtml(a.description)}</div>` : ''}
        </div>
      </a>`;
    }).join('');
    el.innerHTML = newsToolbar() + `<div class="drawer-cards">${cards}</div>`;
  } catch (err) {
    el.innerHTML = newsToolbar() + `<div style="color:var(--red);font-size:13px;padding:20px">Failed: ${escHtml(err.message)}</div>`;
  }
}

