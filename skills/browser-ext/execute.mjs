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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { listBrowsers, sendCommand } from '../../lib/browser-bus.mjs';
import { getUserFilesDir, userSiteNotesDir, userSiteNotesPath, userSharedSiteNotesPath } from '../../lib/paths.mjs';
import {
  deleteBrowserRoutine,
  listBrowserRoutines,
  replayBrowserRoutine,
  saveBrowserRoutineFromTeachEvents,
} from '../../lib/browser-routines.mjs';
import { atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';

const MAX_SITE_NOTE_WRITE = 8_000;
const MAX_SITE_NOTES_FILE = 64_000;

// Pull the registrable domain out of a URL — strips scheme, www., port,
// path. Used by browser_screenshot / browser_read_page to find site
// notes for the current page automatically.
function _domainOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

// Read the notes for a domain, returning the markdown body or null when
// no notes exist yet. Safe to call from auto-inject paths — never throws.
function _readNotes(userId, domain) {
  if (!domain) return null;
  try {
    const p = userSiteNotesPath(userId, domain);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

// Cross-cutting notes — patterns the user has shared across every site
// (general web-flow knowledge, user-wide preferences). Prepended to the
// per-domain notes so even unfamiliar domains arrive with priors.
function _readSharedNotes(userId) {
  try {
    const p = userSharedSiteNotesPath(userId);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

function _composeNotesBlock(userId, domain) {
  const shared = _readSharedNotes(userId);
  const perDomain = _readNotes(userId, domain);
  if (!shared && !perDomain && !domain) return '';
  const parts = [];
  if (shared) {
    parts.push(`## Your general patterns (apply to every site)`, shared.trim(), '');
  }
  if (perDomain) {
    parts.push(`## What you know about ${domain}`,
      'These are your own notes from prior explicit teaching sessions. Use them as priors, but trust the live page when reality differs. Updates require an active user-started Teach session on this exact origin.',
      '',
      perDomain.trim(),
      '');
  } else if (domain) {
    parts.push(`*No site notes yet for ${domain}. Notes can be created only while the user explicitly runs Teach Mode on this site.${shared ? ' Your confirmed general patterns above still apply.' : ''}*`, '');
  }
  parts.push('---', '');
  return parts.join('\n');
}

function _humanList(browsers) {
  if (!browsers.length) {
    return 'No browser extension connected. Install OE Bridge from `~/.openensemble/browser-extension/` (Load unpacked in the browser extensions page), open its popup, and use Pair this browser. Never ask the user to paste an auth token into chat.';
  }
  const lines = [`${browsers.length} connected extension(s):`];
  for (const b of browsers) {
    if (b.accessError) {
      lines.push(`- \`${b.extId}\` — ${b.name}${b.version ? ` (v${b.version})` : ''}, connected but tab access is unavailable: ${b.accessError}`);
      continue;
    }
    lines.push(`- \`${b.extId}\` — ${b.name}${b.version ? ` (v${b.version})` : ''}, ${b.tabs.length} explicitly shared tab(s)`);
    for (const t of b.tabs.slice(0, 15)) {
      const star = t.active ? '★' : ' ';
      lines.push(`    ${star} tabId=${t.tabId}  ${t.title || '(no title)'}\n      ${t.url}`);
    }
    if (b.tabs.length > 15) lines.push(`    … ${b.tabs.length - 15} more`);
  }
  return lines.join('\n');
}

async function _liveBrowsers(userId) {
  const connected = listBrowsers(userId);
  return Promise.all(connected.map(async browser => {
    try {
      const tabs = await sendCommand(userId, 'list_tabs', {}, { extId: browser.extId, timeoutMs: 5000 });
      return { ...browser, tabs: Array.isArray(tabs) ? tabs : [], tabCount: Array.isArray(tabs) ? tabs.length : 0 };
    } catch (e) {
      return { ...browser, tabs: [], tabCount: 0, accessError: e?.message || String(e) };
    }
  }));
}

async function _activeLeasedTab(userId, extId = null) {
  const browsers = await _liveBrowsers(userId);
  const browser = extId ? browsers.find(b => b.extId === extId) : browsers[0];
  return browser?.tabs?.find(t => t.active) || browser?.tabs?.[0] || null;
}

export default async function execute(name, args, userId, agentId) {
  if (name === 'browser_list') {
    return _humanList(await _liveBrowsers(userId));
  }

  if (name === 'browser_open_tab') {
    const url = String(args?.url || '').trim();
    if (!url) return 'url is required.';
    if (!/^https?:\/\//i.test(url)) return 'url must start with http:// or https://.';
    try {
      const data = await sendCommand(userId, 'open_tab', { url }, { extId: args?.extId, timeoutMs: 65_000 });
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
      // Auto-inject shared + per-domain notes. Shared notes always
      // prepend so even unfamiliar domains arrive with priors (general
      // web patterns, user-wide preferences). Per-domain comes next.
      const domain = _domainOf(data.tabUrl);
      const notesBlock = _composeNotesBlock(userId, domain);
      return {
        text: `${notesBlock}Screenshot saved (${sizeKb} KB, ${data.width}×${data.height}) at:\n  ${fpath}\n\nTab: ${data.tabTitle || '(no title)'} — ${data.tabUrl || ''}\n\nThe viewport coordinate space is 0,0 (top-left) to ${data.width},${data.height} (bottom-right). Use browser_click_xy with coordinates in that space. The screenshot itself is attached as a follow-up image — look at it to decide which (x,y) to click next.`,
        _images: [{ mediaType: 'image/png', base64: png }],
      };
    } catch (e) {
      return `Failed to screenshot: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_watch_mode') {
    const on = !!args?.on;
    if (on) {
      return 'Teach Mode must be started by the user: ask them to open the OE side panel on the page they want to teach and press “Teach this site.” The grant covers only that tab and origin for 15 minutes; do not claim it is active until browser_observe succeeds.';
    }
    try {
      await sendCommand(userId, 'set_watch_mode', { on: false }, { extId: args?.extId, timeoutMs: 5000 });
      return 'Teach Mode stopped. Its transient observation buffer was cleared.';
    } catch (e) {
      return `Failed to set watch mode: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_observe') {
    // Reject `tabId: 0` — Chrome never assigns it, so the LLM passing
    // it as a default leads to the buffer lookup missing the real tab
    // where the user actually clicked.
    const rawTabId = args?.tabId != null ? Number(args.tabId) : null;
    const tabId = (Number.isFinite(rawTabId) && rawTabId > 0) ? rawTabId : null;
    const since_ms = args?.since_ms != null ? Number(args.since_ms) : null;
    try {
      const data = await sendCommand(
        userId,
        'get_observations',
        { ...(tabId != null ? { tabId } : {}), ...(Number.isFinite(since_ms) ? { since_ms } : {}) },
        { extId: args?.extId, timeoutMs: 5000 },
      );
      const events = Array.isArray(data?.events) ? data.events : [];
      const watched = Array.isArray(data?.watchedTabs) ? data.watchedTabs : [];
      if (!data?.watchMode) {
        return 'Teach Mode is OFF — no observations are being captured. Ask the user to press “Teach this site” in the OE side panel on the exact tab they want to demonstrate.';
      }
      if (!events.length) {
        if (watched.length) {
          // We have events on OTHER tabs — Chey was looking at the wrong one.
          const summary = watched
            .map(w => `tab ${w.tabId} (${w.eventCount} event${w.eventCount === 1 ? '' : 's'})`)
            .join(', ');
          return `No events on tab ${data?.tabId ?? '?'} — the active Teach session is on: ${summary}. Read only that explicitly granted tab.`;
        }
        return `Watch mode is ON but no events captured yet — nobody has clicked / typed on any page since watch mode came on. Ask the user to demonstrate something and I'll see it. (Tab being polled: ${data?.tabId ?? 'no active tab found'}.) If you ARE seeing the orange banner on the right page, this means the page might be in an iframe or chrome:// or otherwise unscriptable.`;
      }
      const lines = [`${events.length} observation(s) on tab ${data.tabId} (most recent last):`, ''];
      for (const e of events) {
        const ago = Math.max(0, Math.round((Date.now() - e.recvTs) / 1000));
        const el = e.element || {};
        const elDesc = `<${el.tag || '?'}${el.id ? '#'+el.id : ''}${el.class ? '.'+el.class : ''}>${el.text ? ` "${el.text}"` : ''}${el.placeholder ? ` placeholder="${el.placeholder}"` : ''}${el.ariaLabel ? ` aria-label="${el.ariaLabel}"` : ''}`;
        if (e.kind === 'click') {
          lines.push(`- ${ago}s ago: **clicked** ${elDesc}`);
        } else if (e.kind === 'input') {
          lines.push(`- ${ago}s ago: **typed** into ${elDesc} → ${e.value == null ? '[sensitive — value redacted]' : `"${e.value}"`}`);
        } else if (e.kind === 'change') {
          lines.push(`- ${ago}s ago: **changed** ${elDesc} → ${e.checked != null ? `checked=${e.checked}` : `value="${e.value || ''}"`}`);
        } else if (e.kind === 'submit') {
          lines.push(`- ${ago}s ago: **submitted** ${elDesc}`);
        }
        if (el.selector) lines.push(`    selector: ${el.selector}`);
      }
      return lines.join('\n');
    } catch (e) {
      return `Failed to read observations: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_routine_create_from_teach') {
    const routineName = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!routineName) return 'name is required.';
    const rawTabId = args?.tabId != null ? Number(args.tabId) : null;
    const tabId = Number.isInteger(rawTabId) && rawTabId > 0 ? rawTabId : null;
    try {
      const data = await sendCommand(
        userId,
        'get_observations',
        { ...(tabId == null ? {} : { tabId }), limit: 200 },
        { extId: args?.extId, timeoutMs: 5000 },
      );
      if (!data?.watchMode) {
        return 'Teach Mode is not active. Ask the user to press “Teach this site,” demonstrate the routine, then ask to save it.';
      }
      if (!data?.teach?.origin || !data?.teach?.url || Number(data?.teach?.tabId) !== Number(data?.tabId)) {
        return 'Teach Mode did not return an exact active tab/origin scope, so nothing was saved. Reload the updated OE Bridge and try again.';
      }
      const saved = await saveBrowserRoutineFromTeachEvents(userId, {
        name: routineName,
        description: typeof args?.description === 'string' ? args.description : '',
        events: Array.isArray(data?.events) ? data.events : [],
        origin: data.teach.origin,
      });
      import('../../lib/browser-attention.mjs')
        .then(({ recordBrowserAttention }) => recordBrowserAttention(userId, {
          action: 'teach', domains: [saved.routine.origin], sharedProfile: false,
        }))
        .catch(() => {});
      let stopWarning = '';
      try {
        await sendCommand(userId, 'set_watch_mode', { on: false }, { extId: args?.extId, timeoutMs: 5000 });
      } catch (error) {
        stopWarning = ` Teach Mode could not be stopped automatically: ${error?.message || String(error)}`;
      }
      const warnings = saved.warnings.length ? ` Omitted/adjusted: ${saved.warnings.join(' ')}` : '';
      return `Saved browser routine “${saved.routine.name}” (${saved.routine.id}) with ${saved.routine.steps.length} semantic step(s), bound to ${saved.routine.origin}. Risk: ${saved.routine.risk.level}. Replay still requires a live lease; consequential steps ask for confirmation.${warnings}${stopWarning}`;
    } catch (error) {
      return `Failed to create browser routine: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_routine_list') {
    try {
      const routines = listBrowserRoutines(userId);
      if (!routines.length) return 'No taught browser routines yet.';
      return [
        `${routines.length} taught browser routine(s):`,
        ...routines.map(routine =>
          `- ${routine.name} — id=${routine.id}, origin=${routine.origin}, ${routine.steps.length} step(s), risk=${routine.risk.level}`),
      ].join('\n');
    } catch (error) {
      return `Failed to list browser routines: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_routine_delete') {
    const routineId = typeof args?.routineId === 'string' ? args.routineId.trim() : '';
    if (!routineId) return 'routineId is required.';
    try {
      return await deleteBrowserRoutine(userId, routineId)
        ? `Deleted browser routine ${routineId}.`
        : `No browser routine ${routineId} belongs to this user.`;
    } catch (error) {
      return `Failed to delete browser routine: ${error?.message || String(error)}`;
    }
  }

  if (name === 'browser_routine_run') {
    const routineId = typeof args?.routineId === 'string' ? args.routineId.trim() : '';
    const tabId = Number(args?.tabId);
    if (!routineId) return 'routineId is required.';
    if (!Number.isInteger(tabId) || tabId < 1) return 'tabId is required (integer from browser_list).';
    try {
      const result = await replayBrowserRoutine(userId, routineId, {
        tabId,
        command: (action, commandArgs, options = {}) => sendCommand(
          userId,
          action,
          commandArgs,
          { extId: args?.extId, timeoutMs: options.timeoutMs },
        ),
      });
      return `Completed browser routine “${result.name}” on tab ${result.tabId}: ${result.completedSteps} step(s). Consequential steps, if any, were confirmed individually by the user.`;
    } catch (error) {
      return `Browser routine did not complete: ${error?.message || String(error)}`;
    }
  }

  // Site-notes tools — Sydney's institutional memory of how each
  // website works. Markdown free-form, NOT step-by-step recipes.
  if (name === 'browser_site_notes_read') {
    let domain = args?.domain ? String(args.domain).trim() : null;
    if (domain === '_shared' || domain === '*') {
      const shared = _readSharedNotes(userId);
      return shared
        ? `# Your general / cross-site patterns\n\n${shared}`
        : 'No shared notes yet. Cross-site preferences must be stated and confirmed in normal OE chat; browser agents cannot write them.';
    }
    if (!domain) {
      const activeTab = await _activeLeasedTab(userId, args?.extId);
      domain = _domainOf(activeTab?.url);
    }
    if (!domain) return 'No domain specified, and no active tab to infer from. Pass `domain: "<example.com>"` (or `"_shared"` for the cross-cutting file).';
    const notes = _readNotes(userId, domain);
    if (!notes) return `No site notes for ${domain} yet. The user can start Teach Mode on that exact site before notes are written.`;
    return `# Site notes for ${domain}\n\n${notes}`;
  }

  if (name === 'browser_site_notes_write') {
    let domain = args?.domain ? String(args.domain).trim() : null;
    const content = typeof args?.content === 'string' ? args.content : '';
    const mode = args?.mode === 'append' ? 'append' : 'replace';
    if (!content.trim()) return 'content is required (free-form markdown).';
    if (content.length > MAX_SITE_NOTE_WRITE) return `Site-note updates are limited to ${MAX_SITE_NOTE_WRITE} characters.`;
    if (domain === '_shared' || domain === '*') {
      return 'Cross-site notes require a separate explicit confirmation and cannot be written from a browser agent turn. Ask the user to state the preference in normal OE chat instead.';
    }
    try {
      // Persistence is allowed only while the extension proves a live,
      // UI-minted, exact-origin Teach grant. The domain comes from Chrome's
      // authenticated tab metadata—not page text or an LLM-supplied URL.
      const observed = await sendCommand(userId, 'get_observations', {}, {
        extId: args?.extId, timeoutMs: 5_000,
      });
      if (!observed?.watchMode || !observed?.teach?.origin || !observed?.teach?.url) {
        return 'Site notes can be saved only during an active “Teach this site” session.';
      }
      const taughtDomain = _domainOf(observed.teach.url);
      if (!taughtDomain || new URL(observed.teach.url).origin !== observed.teach.origin) {
        return 'Teach Mode did not provide a valid exact-origin scope; no notes were saved.';
      }
      if (domain) {
        const requested = _domainOf(domain.includes('://') ? domain : `https://${domain}`);
        if (!requested || requested !== taughtDomain) {
          return `Teach Mode is scoped to ${taughtDomain}; it cannot write notes for another site.`;
        }
      }
      domain = taughtDomain;
      const p = userSiteNotesPath(userId, domain);
      mkdirSync(userSiteNotesDir(userId), { recursive: true });
      let next;
      if (mode === 'append' && existsSync(p)) {
        const existing = readFileSync(p, 'utf8').replace(/\n+$/, '');
        const sep = existing ? '\n\n' : '';
        next = `${existing}${sep}${content.trim()}\n`;
      } else {
        next = content.trim() + '\n';
      }
      if (Buffer.byteLength(next) > MAX_SITE_NOTES_FILE) {
        return `Site notes for ${domain} are at the ${MAX_SITE_NOTES_FILE}-byte limit; shorten or replace them before adding more.`;
      }
      atomicWriteSync(p, next, { mode: 0o600 });
      const size = statSync(p).size;
      return `${mode === 'append' ? 'Appended to' : 'Wrote'} site notes for ${domain} (${size} bytes total) from the active Teach session.`;
    } catch (e) {
      return `Failed to write notes: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_site_notes_list') {
    const dir = userSiteNotesDir(userId);
    if (!existsSync(dir)) return 'No site notes yet.';
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    if (!files.length) return 'No site notes yet.';
    const lines = [];
    // Shared notes first if present, with a special label.
    const sharedFile = files.find(f => f === '_shared.md');
    const perDomainFiles = files.filter(f => f !== '_shared.md');
    if (sharedFile) {
      const full = path.join(dir, sharedFile);
      try {
        const stat = statSync(full);
        const txt = readFileSync(full, 'utf8').slice(0, 200).replace(/\s+/g, ' ').trim();
        lines.push(`**Shared / cross-site** — ${stat.size} bytes, updated ${new Date(stat.mtimeMs).toLocaleDateString()}: "${txt.slice(0, 120)}${txt.length > 120 ? '…' : ''}"`);
        lines.push('');
      } catch { /* unreadable — skip */ }
    }
    if (perDomainFiles.length) {
      lines.push('Sites you have notes for:');
      for (const f of perDomainFiles) {
        const domain = f.replace(/\.md$/, '');
        const full = path.join(dir, f);
        try {
          const stat = statSync(full);
          const txt = readFileSync(full, 'utf8').slice(0, 200).replace(/\s+/g, ' ').trim();
          lines.push(`- **${domain}** — ${stat.size} bytes, updated ${new Date(stat.mtimeMs).toLocaleDateString()}: "${txt.slice(0, 120)}${txt.length > 120 ? '…' : ''}"`);
        } catch { /* unreadable — skip */ }
      }
    } else if (!sharedFile) {
      lines.push('No site notes yet.');
    }
    return lines.join('\n');
  }

  if (name === 'browser_click_xy') {
    const tabId = Number(args?.tabId);
    const x = Number(args?.x);
    const y = Number(args?.y);
    if (!Number.isFinite(tabId) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return 'tabId, x, y are all required and must be integers.';
    }
    try {
      const data = await sendCommand(userId, 'click_xy', { tabId, x, y }, { extId: args?.extId, timeoutMs: 65_000 });
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
      return `Typed ${text.length} character(s)${what}. This did not submit the form; submission requires a separate explicit confirmation.`;
    } catch (e) {
      return `Failed to type: ${e?.message || String(e)}`;
    }
  }

  if (name === 'browser_keypress') {
    const tabId = Number(args?.tabId);
    const key = String(args?.key || '').trim();
    if (!Number.isFinite(tabId)) return 'tabId is required.';
    if (!key) return 'key is required.';
    if (/^(enter|numpadenter|space|spacebar)$/i.test(key)) {
      return `${key} can submit a form or trigger an application action, so OE will not send it without per-use confirmation. Ask the user to press it themselves.`;
    }
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
      const data = await sendCommand(userId, 'media_control', { action }, { extId: args?.extId, timeoutMs: 65_000 });
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
      const domain = _domainOf(data?.url);
      const notesBlock = _composeNotesBlock(userId, domain);
      const out = [];
      if (notesBlock) out.push(notesBlock);
      out.push(
        `**${data?.title || '(no title)'}**`,
        `URL: ${data?.url}`,
        '',
        '## Text',
        text + trunc,
      );
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
