// @ts-check
/**
 * Browser-extension tools. Read-only Tier 0 (list, open_tab, read_page),
 * media keys + tab nav (Tier 1.5), and vision primitives (screenshot,
 * click_xy, type, keypress) that set up a screenshot → reason → act loop
 * for sites that don't make sense from HTML alone.
 *
 * The wire protocol + connection management lives in lib/browser-bus.mjs;
 * this file just adapts the bus surface to OE's tool-call shape.
 */

import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { listBrowsers, sendCommand } from '../../lib/browser-bus.mjs';
import { getUserFilesDir } from '../../lib/paths.mjs';

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

  // Vision primitives — screenshot + xy-click + type + keypress. Form the
  // basis of a "look at the page like a human" loop on arbitrary sites.
  if (name === 'browser_screenshot') {
    try {
      const data = await sendCommand(userId, 'screenshot', args?.tabId != null ? { tabId: Number(args.tabId) } : {}, { extId: args?.extId, timeoutMs: 8000 });
      const png = data?.base64;
      if (!png) return 'Screenshot returned no image data — the tab may be a chrome:// page (not capturable).';
      // Persist to user's images dir so the user can review it.
      const outDir = getUserFilesDir(userId, 'images');
      mkdirSync(outDir, { recursive: true });
      const fname = `browser-screenshot-${Date.now()}.png`;
      const fpath = path.join(outDir, fname);
      writeFileSync(fpath, Buffer.from(png, 'base64'));
      const sizeKb = Math.round(png.length * 0.75 / 1024);
      // Return an OBJECT with `text` (what the LLM reads) AND `_images`
      // (raw pixels the provider injects as a synthesised user message
      // before the next turn). The vision loop works because the model
      // sees both the description in the tool_result AND the actual
      // screenshot via the follow-up message.
      return {
        text: `Screenshot saved (${sizeKb} KB, ${data.width}×${data.height}) at:\n  ${fpath}\n\nTab: ${data.tabTitle || '(no title)'} — ${data.tabUrl || ''}\n\nThe viewport coordinate space is 0,0 (top-left) to ${data.width},${data.height} (bottom-right). Use browser_click_xy with coordinates in that space. The screenshot itself is attached as a follow-up image — look at it to decide which (x,y) to click next.`,
        _images: [{ mediaType: 'image/png', base64: png }],
      };
    } catch (e) {
      return `Failed to screenshot: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_click_xy') {
    const tabId = Number(args?.tabId);
    const x = Number(args?.x);
    const y = Number(args?.y);
    if (!Number.isFinite(tabId) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return 'tabId, x, y are all required and must be integers.';
    }
    try {
      const data = await sendCommand(userId, 'click_xy', { tabId, x, y }, { extId: args?.extId, timeoutMs: 5000 });
      const what = data?.elementSummary ? ` on ${data.elementSummary}` : '';
      return `Clicked at (${x}, ${y})${what}. Take another screenshot if you need to verify the result.`;
    } catch (e) {
      return `Failed to click at (${x}, ${y}): ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_type') {
    const tabId = Number(args?.tabId);
    const text = typeof args?.text === 'string' ? args.text : null;
    if (!Number.isFinite(tabId)) return 'tabId is required.';
    if (text == null) return 'text is required.';
    try {
      const data = await sendCommand(userId, 'type', { tabId, text }, { extId: args?.extId, timeoutMs: 8000 });
      const what = data?.elementSummary ? ` into ${data.elementSummary}` : '';
      return `Typed ${text.length} character(s)${what}. ${text.includes('\n') ? '' : 'If the form needs submitting, call browser_keypress with key="Enter".'}`;
    } catch (e) {
      return `Failed to type: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_keypress') {
    const tabId = Number(args?.tabId);
    const key = String(args?.key || '').trim();
    if (!Number.isFinite(tabId)) return 'tabId is required.';
    if (!key) return 'key is required.';
    try {
      const data = await sendCommand(userId, 'keypress', { tabId, key }, { extId: args?.extId, timeoutMs: 5000 });
      return `Sent ${key} keypress${data?.elementSummary ? ` to ${data.elementSummary}` : ''}.`;
    } catch (e) {
      return `Failed to send ${key}: ${e?.message || String(e)}`;
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
