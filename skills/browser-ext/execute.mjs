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
