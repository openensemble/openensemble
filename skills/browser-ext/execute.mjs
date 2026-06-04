// @ts-check
/**
 * Browser-extension Tier-0 tools. Read-only — list, open_tab, read_page.
 * The wire protocol + connection management lives in lib/browser-bus.mjs;
 * this file just adapts the bus surface to OE's tool-call shape.
 */

import { listBrowsers, sendCommand } from '../../lib/browser-bus.mjs';

function _humanList(browsers) {
  if (!browsers.length) {
    return 'No browser extension connected. Install the OE browser extension from `~/.openensemble/browser-extension/` (Load unpacked in chrome://extensions), paste your OE auth token in the extension popup, and reconnect.';
  }
  const lines = [`${browsers.length} connected extension(s):`];
  for (const b of browsers) {
    lines.push(`- \`${b.extId}\` — ${b.name}${b.version ? ` (v${b.version})` : ''}, ${b.tabCount} tab(s)`);
    for (const t of b.tabs.slice(0, 15)) {
      const star = t.active ? '★' : ' ';
      lines.push(`    ${star} tabId=${t.tabId}  ${t.title || '(no title)'}\n      ${t.url}`);
    }
    if (b.tabs.length > 15) lines.push(`    … ${b.tabs.length - 15} more`);
  }
  return lines.join('\n');
}

export default async function execute(name, args, userId, agentId) {
  if (name === 'browser_list') {
    return _humanList(listBrowsers(userId));
  }

  if (name === 'browser_open_tab') {
    const url = String(args?.url || '').trim();
    if (!url) return 'url is required.';
    if (!/^https?:\/\//i.test(url)) return 'url must start with http:// or https://.';
    try {
      const data = await sendCommand(userId, 'open_tab', { url }, { extId: args?.extId, timeoutMs: 8000 });
      return `Opened ${url} in browser. tabId=${data?.tabId ?? '?'}`;
    } catch (e) {
      return `Failed to open tab: ${e?.message || String(e)}`;
    }
  }

  // Tab-level operations — all bounded to "things the user could press
  // with a keyboard shortcut" (Ctrl+W, Ctrl+Tab, Alt+Left, F5, etc.).
  // No per-site permission gate because they don't touch page content.
  if (name === 'browser_close_tab' || name === 'browser_focus_tab' ||
      name === 'browser_back' || name === 'browser_forward' ||
      name === 'browser_reload') {
    const tabId = args?.tabId != null ? Number(args.tabId) : null;
    if ((name === 'browser_close_tab' || name === 'browser_focus_tab') && !Number.isFinite(tabId)) {
      return 'tabId is required.';
    }
    const action = name.replace(/^browser_/, '');
    try {
      const data = await sendCommand(userId, action, tabId != null ? { tabId } : {}, { extId: args?.extId, timeoutMs: 5000 });
      const verbs = {
        close_tab: 'Closed tab',
        focus_tab: 'Brought tab to the front',
        back: 'Went back',
        forward: 'Went forward',
        reload: 'Reloaded the page',
      };
      const url = data?.url ? ` — ${data.url}` : '';
      return `${verbs[action] || action}${url}.`;
    } catch (e) {
      return `Failed (${action}): ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_focus_window') {
    try {
      const data = await sendCommand(userId, 'focus_window', {}, { extId: args?.extId, timeoutMs: 5000 });
      return `Brought the browser window to the front.${data?.windowId ? ` (windowId=${data.windowId})` : ''}`;
    } catch (e) {
      return `Failed to focus browser window: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_media_control') {
    const action = String(args?.action || '').trim().toLowerCase();
    if (!['next', 'previous', 'playpause'].includes(action)) {
      return 'action must be one of: next, previous, playpause.';
    }
    try {
      const data = await sendCommand(userId, 'media_control', { action }, { extId: args?.extId, timeoutMs: 5000 });
      const where = data?.matchedHost ? `on ${data.matchedHost}` : (data?.tabUrl ? `on ${new URL(data.tabUrl).host}` : 'in the active tab');
      const verb = action === 'next' ? 'Skipped' : action === 'previous' ? 'Back' : 'Toggled play/pause';
      return `${verb} ${where}.${data?.method ? ` (via ${data.method})` : ''}`;
    } catch (e) {
      return `Failed to control media: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_read_page') {
    const tabId = Number(args?.tabId);
    if (!Number.isFinite(tabId)) return 'tabId is required (integer from browser_list).';
    try {
      const data = await sendCommand(userId, 'read_page', { tabId }, { extId: args?.extId, timeoutMs: 12_000 });
      const text = String(data?.text || '').slice(0, 8000);
      const trunc = (data?.text || '').length > text.length ? `\n…[truncated, ${(data?.text || '').length - text.length} more chars]` : '';
      const links = Array.isArray(data?.links) ? data.links.slice(0, 30) : [];
      const jsonLd = Array.isArray(data?.jsonLd) ? data.jsonLd.slice(0, 5) : [];
      const out = [
        `**${data?.title || '(no title)'}**`,
        `URL: ${data?.url}`,
        '',
        '## Text',
        text + trunc,
      ];
      if (links.length) {
        out.push('', '## Links');
        for (const l of links) out.push(`- [${(l.text || '').slice(0, 80)}](${l.href})`);
      }
      if (jsonLd.length) {
        out.push('', '## Structured data (JSON-LD)');
        for (const d of jsonLd) out.push('```json\n' + JSON.stringify(d, null, 2).slice(0, 2000) + '\n```');
      }
      return out.join('\n');
    } catch (e) {
      return `Failed to read page: ${e?.message || String(e)}`;
    }
  }

  return `Unknown tool: ${name}`;
}

export const executeSkillTool = execute;
