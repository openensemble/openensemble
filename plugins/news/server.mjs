/**
 * News plugin — Brave News Search API
 * Handles GET /api/news
 */

export async function handleRequest(req, res, cfg) {
  if (!req.url.startsWith('/api/news') || req.method !== 'GET') return false;

  const key = process.env.BRAVE_API_KEY || cfg.braveApiKey;
  if (!key) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Brave API key not configured' }));
    return true;
  }

  const params = new URL(req.url, 'http://x').searchParams;
  const q      = params.get('q') || 'top news today';
  const count  = params.get('count') || 10;

  try {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(q)}&count=${count}&freshness=pd&spellcheck=false`,
      { headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) throw new Error(`Brave ${r.status}`);
    const data = await r.json();
    const articles = (data.results ?? [])
      .sort((a, b) => (b.page_age ? new Date(b.page_age) : 0) - (a.page_age ? new Date(a.page_age) : 0))
      .map(a => ({
        title:       a.title,
        url:         a.url,
        description: a.description ?? '',
        source:      a.meta_url?.hostname?.replace(/^www\./, '') ?? '',
        age:         a.age ?? '',
        image:       a.thumbnail?.src ?? null,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(articles));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
  return true;
}
