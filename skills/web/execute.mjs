import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function getBraveKey() {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
  const cfgPath = path.join(BASE_DIR, 'config.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (cfg.braveApiKey) return cfg.braveApiKey;
  }
  return null;
}

async function execWebSearch(query, count = 5) {
  const key = getBraveKey();
  if (!key) return 'Error: Brave API key not configured in config.json';
  const n = Math.min(count || 5, 10);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': key },
    });
    if (!res.ok) return `Brave Search error ${res.status}: ${await res.text()}`;
    const data = await res.json();
    const results = (data.web?.results ?? []).map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description ?? ''}`
    );
    return results.length ? results.join('\n\n') : 'No results found.';
  } catch (e) {
    return `Search error: ${e.message}`;
  }
}

async function execFetchUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return `Error: fetch_url requires a 'url' string argument. Received: ${JSON.stringify(url)}`;
  }
  if (!/^https?:\/\//i.test(url)) {
    return `Error: fetch_url requires an http:// or https:// URL. Received: ${url}`;
  }
  if (/news\.google\.com\/(articles|rss|stories)\//.test(url)) {
    return `Cannot fetch Google News article URLs directly — they require a browser session. Ask the user to open the link in their browser, or search Brave for the article title to find the original publisher URL.`;
  }
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (contentType.includes('application/json')) return text.slice(0, 8000);
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ').trim();
    return stripped.slice(0, 8000);
  } catch (e) {
    console.warn('[web] Fetch error for', url + ':', e.message);
    return `Fetch error: ${e.message}`;
  }
}

export default async function execute(name, args) {
  if (name === 'web_search') return execWebSearch(args.query, args.count);
  if (name === 'fetch_url')  return execFetchUrl(args.url);
  return `Unknown tool: ${name}`;
}
