export const DESKTOP_RELEASES = 'https://github.com/openensemble/openensemble-desktop-client/releases';
const GITHUB_API = 'https://api.github.com/repos/openensemble/openensemble-desktop-client/releases/latest';
// Cached metadata from before the repository rename remains valid. Always
// offer the canonical URL, while accepting only these two known locations.
const LEGACY_RELEASES = 'https://github.com/openensemble/desktop/releases';

export function detectDesktopPlatform(nav = {}) {
  const ua = nav.userAgent || '';
  const platform = nav.userAgentData?.platform || nav.platform || '';
  if (/OpenEnsembleDesktop\//i.test(ua)) return 'desktop';
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod|CrOS/i.test(`${ua} ${platform}`) ||
      (/Mac/i.test(platform) && nav.maxTouchPoints > 1)) return 'unsupported';
  // Do not offer a Linux x64 binary to ARM/32-bit devices. Windows ARM users
  // can still choose the x64 installer explicitly if their OS supports it.
  if (/arm|aarch|i[3-6]86|Win32.*(?:x86|32.bit)/i.test(`${ua} ${platform}`) ||
      nav.architecture === 'arm' || nav.bitness === '32') return 'unsupported';
  if (/Windows|Win32|Win64/i.test(`${ua} ${platform}`)) return 'windows';
  if (/Linux|X11/i.test(`${ua} ${platform}`)) return 'linux';
  return 'unsupported';
}

export function parseDesktopRelease(release) {
  if (!release || release.draft !== false || release.prerelease !== false || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) return null;
  const version = release.tag_name.slice(1);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const base = `${DESKTOP_RELEASES}/download/${release.tag_name}/`;
  const legacyBase = `${LEGACY_RELEASES}/download/${release.tag_name}/`;
  function asset(name) {
    const found = assets.find(item => item?.name === name &&
      [base + name, legacyBase + name].includes(item.browser_download_url) &&
      Number.isSafeInteger(item.size) && item.size > 0);
    return found ? { url: base + name, size: found.size } : null;
  }
  const windows = asset(`OpenEnsemble-Setup-${version}-x64.exe`);
  const linux = asset(`OpenEnsemble-${version}-x86_64.AppImage`);
  // A partially uploaded release must never become a download recommendation.
  if (!windows || !linux || !asset('latest.yml') || !asset('latest-linux.yml') ||
      !asset(`OpenEnsemble-Setup-${version}-x64.exe.blockmap`)) return null;
  return { version, windows, linux, notes: `${DESKTOP_RELEASES}/tag/${release.tag_name}` };
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(text, href, className) {
  const node = element('a', text, className);
  node.href = href;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  node.referrerPolicy = 'no-referrer';
  return node;
}

export async function setupDesktopDownloads(root = document, nav = navigator, fetchImpl = fetch) {
  const cards = [...root.querySelectorAll('[data-desktop-downloads]')];
  if (!cards.length) return;
  let platform = detectDesktopPlatform(nav);
  if (platform === 'desktop') { for (const card of cards) card.hidden = true; return; }
  try {
    // Chromium can provide architecture when its reduced user agent cannot.
    if (nav.userAgentData?.getHighEntropyValues) {
      const details = await Promise.race([
        nav.userAgentData.getHighEntropyValues(['architecture', 'bitness']),
        new Promise(resolve => setTimeout(() => resolve({}), 500)),
      ]);
      platform = detectDesktopPlatform({ userAgent: nav.userAgent, platform: nav.platform,
        maxTouchPoints: nav.maxTouchPoints, userAgentData: nav.userAgentData, ...details });
    }
  } catch { /* The user agent remains a useful fallback if hints are denied. */ }
  // All cards on a page share one request. No account credentials leave OE.
  const endpoint = cards[0].dataset.releaseApi === 'github' ? GITHUB_API : '/api/desktop/releases';
  let release = null;
  let missing = false;
  try {
    const response = await fetchImpl(endpoint, { credentials: 'omit', signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json' } });
    missing = response.status === 404;
    if (response.ok) release = parseDesktopRelease(await response.json());
  } catch { /* Keep a working release-page link when offline or rate limited. */ }
  for (const card of cards) {
    const title = element('h3', 'OpenEnsemble Desktop Client');
    const description = element('p', 'Chat with OE and work with files on this computer. Connects to your existing OE server.');
    card.replaceChildren(title, description);
    if (!release) {
      card.append(element('p', missing ? 'Desktop downloads will appear here when the first release is published.' : 'Unable to load the latest downloads. Check the release page or try again.', 'desktop-download-note'));
      card.append(link('View desktop releases', DESKTOP_RELEASES, 'desktop-download-primary'));
      const retry = element('button', 'Try again', 'desktop-download-retry');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        retry.textContent = 'Checking…';
        await setupDesktopDownloads(root, nav, fetchImpl);
      });
      card.append(retry);
      continue;
    }
    if (platform === 'windows' || platform === 'linux') {
      const label = platform === 'windows' ? 'Windows' : 'Linux';
      card.append(link(`Download for ${label}`, release[platform].url, 'desktop-download-primary'));
      card.append(element('p', `${label} x64 · Version ${release.version}`, 'desktop-download-note'));
      card.append(element('p', platform === 'windows'
        ? 'Open the downloaded installer, then launch OpenEnsemble.'
        : 'Save the AppImage in your Applications folder. In its Properties, allow it to run as a program, then open it.', 'desktop-download-note'));
    } else {
      card.append(element('p', 'Choose a download for a Windows or Linux x64 computer. You can keep using OE in this browser.', 'desktop-download-note'));
    }
    const choices = element('div', '', 'desktop-download-choices');
    choices.append(link('Windows x64', release.windows.url), link('Linux x64 (AppImage)', release.linux.url), link('Release notes', release.notes));
    card.append(choices);
    card.append(element('p', 'Checks for updates on startup. You choose when to update and restart.', 'desktop-download-note'));
  }
}

if (typeof document !== 'undefined') setupDesktopDownloads();
