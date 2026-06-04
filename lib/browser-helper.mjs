// @ts-check
/**
 * ctx.browser — clean primitive surface for skills that want to use the
 * user's connected browser extension. Mirrors the shape of ctx.collection
 * and ctx.proposeMonitor: bound to a (userId, agentId) at ctx-construction
 * time, lazy-imports browser-bus so skills don't have to walk relative
 * paths up to lib/.
 *
 * Phase 1 surface (read-only Tier 0):
 *   ctx.browser.list()                    — connected extensions + tabs
 *   ctx.browser.openTab(url)              — open a URL, returns tabId
 *   ctx.browser.readPage(tabId)           — sanitized text/links/JSON-LD
 *   ctx.browser.mediaControl(action)      — Tier 1.5 media keys
 *                                            (next | previous | playpause)
 *
 * Phase 2 will add ctx.browser.click / fill / select once the per-site
 * permission model lands.
 */

export function buildBrowserHelpers({ userId, agentId }) {
  return {
    async list() {
      const { listBrowsers } = await import('./browser-bus.mjs');
      return listBrowsers(userId);
    },

    async openTab(url) {
      if (!url || !/^https?:\/\//i.test(url)) throw new Error('ctx.browser.openTab: url must start with http:// or https://');
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'open_tab', { url }, { timeoutMs: 8000 });
    },

    async readPage(tabId) {
      if (!Number.isFinite(Number(tabId))) throw new Error('ctx.browser.readPage: tabId required (integer)');
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'read_page', { tabId: Number(tabId) }, { timeoutMs: 12_000 });
    },

    async mediaControl(action) {
      const allowed = new Set(['next', 'previous', 'playpause']);
      if (!allowed.has(String(action))) throw new Error('ctx.browser.mediaControl: action must be next|previous|playpause');
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'media_control', { action }, { timeoutMs: 5000 });
    },

    // Tab-level navigation — bounded to "things a user could press with a
    // keyboard shortcut" (Ctrl+W, Ctrl+Tab, Alt+Left/Right, F5). No per-
    // site permission gate; never touches page content.
    async closeTab(tabId) {
      if (!Number.isFinite(Number(tabId))) throw new Error('ctx.browser.closeTab: tabId required');
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'close_tab', { tabId: Number(tabId) }, { timeoutMs: 5000 });
    },
    async focusTab(tabId) {
      if (!Number.isFinite(Number(tabId))) throw new Error('ctx.browser.focusTab: tabId required');
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'focus_tab', { tabId: Number(tabId) }, { timeoutMs: 5000 });
    },
    async back(tabId) {
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'back', Number.isFinite(Number(tabId)) ? { tabId: Number(tabId) } : {}, { timeoutMs: 5000 });
    },
    async forward(tabId) {
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'forward', Number.isFinite(Number(tabId)) ? { tabId: Number(tabId) } : {}, { timeoutMs: 5000 });
    },
    async reload(tabId) {
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'reload', Number.isFinite(Number(tabId)) ? { tabId: Number(tabId) } : {}, { timeoutMs: 5000 });
    },
    async focusWindow() {
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'focus_window', {}, { timeoutMs: 5000 });
    },

    // Vision primitives — screenshot returns { base64, width, height,
    // tabUrl, tabTitle }. The caller is responsible for persisting if
    // they want a saved copy. click_xy / type / keypress operate in the
    // viewport coordinate space of the most-recent screenshot.
    async screenshot(tabId) {
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'screenshot', Number.isFinite(Number(tabId)) ? { tabId: Number(tabId) } : {}, { timeoutMs: 8000 });
    },
    async clickXY(tabId, x, y) {
      if (!Number.isFinite(Number(tabId)) || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
        throw new Error('ctx.browser.clickXY: tabId, x, y required (integers)');
      }
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'click_xy', { tabId: Number(tabId), x: Number(x), y: Number(y) }, { timeoutMs: 5000 });
    },
    async type(tabId, text) {
      if (!Number.isFinite(Number(tabId))) throw new Error('ctx.browser.type: tabId required');
      if (typeof text !== 'string') throw new Error('ctx.browser.type: text required');
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'type', { tabId: Number(tabId), text }, { timeoutMs: 8000 });
    },
    async keypress(tabId, key) {
      if (!Number.isFinite(Number(tabId))) throw new Error('ctx.browser.keypress: tabId required');
      if (!key) throw new Error('ctx.browser.keypress: key required');
      const { sendCommand } = await import('./browser-bus.mjs');
      return sendCommand(userId, 'keypress', { tabId: Number(tabId), key: String(key) }, { timeoutMs: 5000 });
    },
  };
}
