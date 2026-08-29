// @ts-check
/**
 * Server-mediated refresh of the OE Bridge filter lists.
 *
 * OE Bridge ships a converted snapshot of the upstream lists, so ad blocking
 * works offline and the browser never contacts a filter-list host. Lists do go
 * stale, though, so this module lets the OE server do the fetching on the
 * household's behalf: OE pulls the upstream text, reruns the converter, and
 * writes the regenerated artifacts into the bundled extension. The browser's
 * only network peer is still OE itself.
 *
 * Refreshing rewrites files inside the extension. Chrome will not pick up new
 * static rulesets until the extension is reloaded, so the caller is told to do
 * that; `getExtensionSourceVersion()` in browser-bus.mjs already reports the
 * change once the server restarts.
 */

import fs from 'fs';
import path from 'path';
import log from '../logger.mjs';
import { BASE_DIR } from '../routes/_helpers/paths.mjs';

const EXT_DIR = path.join(BASE_DIR, 'browser-extension');
const CACHE_DIR = path.join(EXT_DIR, '.filter-cache');
const BUILD_INFO = path.join(EXT_DIR, 'filters', 'build-info.json');
const REFRESH_TIMEOUT_MS = 180_000;

let _refreshInFlight = null;

export function readFilterBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(BUILD_INFO, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Fetch the upstream lists and regenerate the bundled artifacts.
 *
 * Concurrent callers share one run: the converter rewrites a whole directory
 * tree, and two overlapping rebuilds would race on the same files.
 *
 * @returns {Promise<{ok: true, summary: any, buildInfo: any}>}
 */
export function refreshBrowserFilters() {
  if (_refreshInFlight) return _refreshInFlight;

  const run = (async () => {
    const builder = path.join(EXT_DIR, 'tools', 'build-filters.mjs');
    if (!fs.existsSync(builder)) throw new Error('the bundled filter builder is missing');

    const started = Date.now();
    const { main } = await import(`file://${builder}`);
    const timeout = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('filter refresh timed out')), REFRESH_TIMEOUT_MS).unref?.();
    });
    const summary = await Promise.race([
      main({ sourceDir: CACHE_DIR, outDir: EXT_DIR, fetch: true, quiet: true }),
      timeout,
    ]);

    // The raw lists are only a build input; keeping them would bloat both the
    // repo and the extension download.
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });

    const buildInfo = readFilterBuildInfo();
    log.info('browser-ext', 'filter lists refreshed', {
      ms: Date.now() - started,
      rules: buildInfo?.counts?.tiers,
      siteHosts: buildInfo?.counts?.siteHosts,
    });
    return { ok: /** @type {const} */ (true), summary, buildInfo };
  })();

  _refreshInFlight = run.finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}
