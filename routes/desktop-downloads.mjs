// Public release information only: no OE configuration, sessions or GitHub
// credentials. Coalesce requests and cache responses to stay within GitHub's
// unauthenticated API limit even on a busy OE server.
const RELEASE_API = 'https://api.github.com/repos/openensemble/desktop/releases/latest';

export function createDesktopDownloadsHandler({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached = null;
  let expires = 0;
  let pending = null;
  async function load() {
    if (cached && now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      let result;
      try {
        const response = await fetchImpl(RELEASE_API, { signal: AbortSignal.timeout(6_000),
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenEnsemble-Desktop-Downloads' } });
        if (response.status === 404) result = { status: 404, body: { error: 'No desktop release has been published yet.' } };
        else if (!response.ok) throw new Error('Release service unavailable');
        else {
          const release = await response.json();
          if (release.draft !== false || release.prerelease !== false || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error('Invalid stable release');
          result = { status: 200, body: { tag_name: release.tag_name, draft: false, prerelease: false,
            assets: release.assets.slice(0, 50).map(({ name, browser_download_url, size }) => ({ name, browser_download_url, size })) } };
        }
      } catch {
        result = { status: 503, body: { error: 'Desktop downloads are temporarily unavailable. Try the GitHub release page.' } };
      }
      cached = result;
      expires = now() + (result.status === 200 ? 10 * 60_000 : 60_000);
      return result;
    })().finally(() => { pending = null; });
    return pending;
  }
  return async function handle(req, res) {
    if (req.url.split('?', 1)[0] !== '/api/desktop/releases') return false;
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }
    const result = await load();
    res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60',
      ...(result.status === 503 ? { 'Retry-After': '60' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result.body));
    return true;
  };
}

export const handle = createDesktopDownloadsHandler();
