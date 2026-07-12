import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

function eventHook() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

function storageArea(seed = {}) {
  const data = { ...seed };
  return {
    data,
    failRemove: false,
    async get(keys) {
      if (keys == null) return { ...data };
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter(k => k in data).map(k => [k, data[k]]));
    },
    async set(patch) { Object.assign(data, patch || {}); },
    async remove(keys) {
      if (this.failRemove) throw new Error('simulated remove failure');
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    async clear() { for (const key of Object.keys(data)) delete data[key]; },
  };
}

const tabs = new Map();
let onGet = null;
let executeImpl = null;
let captureTargetTabId = null;
let createCount = 0;
let executeCount = 0;

const local = storageArea();
const session = storageArea();
const runtimeMessages = eventHook();
const tabUpdated = eventHook();
const tabRemoved = eventHook();

globalThis.chrome = {
  storage: { local, session },
  runtime: {
    onMessage: runtimeMessages,
    onStartup: eventHook(),
    onInstalled: eventHook(),
    async sendMessage() {},
    getManifest: () => ({ version: 'test' }),
  },
  tabs: {
    onUpdated: tabUpdated,
    onRemoved: tabRemoved,
    async query(query = {}) {
      let out = [...tabs.values()];
      if (query.windowId != null) out = out.filter(t => t.windowId === query.windowId);
      if (query.active) out = out.filter(t => t.active);
      return out.map(t => ({ ...t }));
    },
    async get(id) {
      const tab = tabs.get(Number(id));
      if (!tab) throw new Error('No tab');
      const copy = { ...tab };
      if (onGet) await onGet(Number(id));
      return copy;
    },
    async update(id, patch) {
      const tab = tabs.get(Number(id));
      if (!tab) throw new Error('No tab');
      if (patch.active) {
        for (const row of tabs.values()) if (row.windowId === tab.windowId) row.active = false;
      }
      Object.assign(tab, patch);
      return { ...tab };
    },
    async create({ url }) {
      createCount++;
      const id = Math.max(0, ...tabs.keys()) + 1;
      const tab = { id, url, title: '', active: true, windowId: 1 };
      tabs.set(id, tab);
      return { ...tab };
    },
    async remove(id) { tabs.delete(Number(id)); },
    async reload() {},
    async goBack() {},
    async goForward() {},
    async sendMessage() {},
    async captureVisibleTab(windowId) {
      captureTargetTabId = [...tabs.values()].find(t => t.windowId === windowId && t.active)?.id ?? null;
      return 'data:image/png;base64,dGVzdA==';
    },
  },
  scripting: {
    async executeScript(opts) {
      executeCount++;
      if (executeImpl) return executeImpl(opts);
      return [{ result: { width: 800, height: 600, devicePixelRatio: 1 } }];
    },
  },
  windows: {
    async update() {},
    async getAll() { return [{ id: 1 }]; },
    async getLastFocused() { return { id: 1, tabs: [...tabs.values()].map(t => ({ ...t })) }; },
  },
  action: {
    async setBadgeBackgroundColor() {},
    async setBadgeText() {},
    async setTitle() {},
  },
  alarms: { create() {}, onAlarm: eventHook() },
  sidePanel: { async open() {} },
};

class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; }
  send() {}
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeWebSocket;

let broker;

beforeAll(async () => {
  ({ __test: broker } = await import('./background.js'));
  await new Promise(resolve => setTimeout(resolve, 0));
});

beforeEach(async () => {
  tabs.clear();
  onGet = null;
  executeImpl = null;
  captureTargetTabId = null;
  createCount = 0;
  executeCount = 0;
  session.failRemove = false;
  await broker.resetState();
});

function addTab(id, url, { active = false, windowId = 1 } = {}) {
  tabs.set(id, { id, url, title: `Tab ${id}`, active, windowId });
}

describe('OE Bridge capability broker', () => {
  it.each([
    'http://localhost:3737/',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.16.1.2/',
    `http://${[192, 168, 1, 20].join('.')}/`,
    'http://169.254.1.2/',
    'http://[::1]/',
    'http://printer.local/',
    'http://intranet/',
  ])('denies private or intranet URL %s', async url => {
    expect(await broker.sensitiveMatch(url)).toMatch(/private|local|intranet/);
  });

  it('binds an omitted-tab screenshot to the exact tab authorized before the active tab changes', async () => {
    addTab(1, 'https://example.com/product', { active: true });
    addTab(2, 'https://other.example/', { active: false });
    await broker.grantLease(1, 'https://example.com/product');
    let armed = true;
    onGet = async id => {
      if (!armed || id !== 1) return;
      armed = false;
      tabs.get(1).active = false;
      tabs.get(2).active = true;
    };

    const result = await broker.dispatch('screenshot', {});

    expect(result.tabId).toBe(1);
    expect(captureTargetTabId).toBe(1);
  });

  it('discards a read and suspends access when the page navigates during capture', async () => {
    addTab(1, 'https://example.com/product', { active: true });
    await broker.grantLease(1, 'https://example.com/product');
    executeImpl = async () => {
      tabs.get(1).url = 'https://chase.com/login';
      return [{ result: { url: 'https://example.com/product', title: 'Old', text: 'old page', links: [], jsonLd: [] } }];
    };

    await expect(broker.dispatch('read_page', { tabId: 1 })).rejects.toThrow(/paused|sensitive|changed/i);
    expect((await broker.getLease()).tabs[0].suspended).toBe(true);
  });

  it('keeps click, new-tab, media, and submit actions fail-closed without confirmation', async () => {
    addTab(1, 'https://example.com/', { active: true });
    await broker.grantLease(1, 'https://example.com/');

    await expect(broker.dispatch('click_xy', { tabId: 1, x: 10, y: 10 })).rejects.toThrow(/confirmation/i);
    await expect(broker.dispatch('open_tab', { url: 'https://example.org/' })).rejects.toThrow(/confirmation/i);
    await expect(broker.dispatch('media_control', { action: 'playpause' })).rejects.toThrow(/confirmation/i);
    await expect(broker.dispatch('submit_form', { tabId: 1 })).rejects.toThrow(/confirmation/i);
    expect(createCount).toBe(0);
    expect(executeCount).toBe(0);
  });

  it('denies Enter and Space at the command layer', async () => {
    addTab(1, 'https://example.com/', { active: true });
    await broker.grantLease(1, 'https://example.com/');

    await expect(broker.dispatch('keypress', { tabId: 1, key: 'Enter' })).rejects.toThrow(/submit|confirmation/i);
    await expect(broker.dispatch('keypress', { tabId: 1, key: 'Space' })).rejects.toThrow(/trigger|confirmation/i);
    expect(executeCount).toBe(0);
  });

  it('does not silently expand Allow-this-tab when another tab is granted', async () => {
    addTab(1, 'https://example.com/a', { active: true });
    addTab(2, 'https://example.org/b');
    await broker.grantLease(1, 'https://example.com/a');
    await broker.grantLease(2, 'https://example.org/b');

    expect((await broker.getLease()).tabs.map(t => t.tabId)).toEqual([2]);
  });

  it('uses a deny tombstone if revocation storage fails so stale grants do not resurrect', async () => {
    addTab(1, 'https://example.com/', { active: true });
    await broker.grantLease(1, 'https://example.com/');
    expect(session.data.lease).toBeTruthy();
    session.failRemove = true;

    await expect(broker.revokeLease('test')).rejects.toThrow(/simulated/);
    expect(local.data.leaseDenyBefore).toBeTypeOf('number');
    broker.dropMemoryState();
    expect(await broker.getLease()).toBeNull();
  });
});
