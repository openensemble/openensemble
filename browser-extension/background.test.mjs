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
  await local.remove(['browserCredential']);
});

function addTab(id, url, { active = false, windowId = 1 } = {}) {
  tabs.set(id, { id, url, title: `Tab ${id}`, active, windowId, status: 'complete' });
}

function fieldWatchRequest(overrides = {}) {
  const credentialId = overrides.credentialId || 'oeb_browser_a';
  const exactUrl = overrides.exactUrl || 'https://shop.example.com/product/1?color=green';
  const fingerprint = 'field_fingerprint_123';
  return {
    type: 'browser_field_check',
    watchId: 'watch_1',
    exactUrl,
    field: { detector: 'dom', property: 'price', selector: '#price', fingerprint },
    permission: {
      scope: 'exact_url_field_read', exactUrl, fieldFingerprint: fingerprint,
      executorCredentialId: credentialId,
      allow: ['read_selected_field'],
      deny: ['tab_inventory', 'surrounding_page', 'navigate', 'click', 'type', 'submit'],
    },
    maxValueChars: 512,
  };
}

async function answerPendingConfirmation(approved) {
  for (let i = 0; i < 20 && !session.data.pendingConfirmation; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const pending = session.data.pendingConfirmation;
  expect(pending?.id).toMatch(/^confirm_/);
  await new Promise(resolve => {
    runtimeMessages.listeners.at(-1)(
      { type: 'confirmation_respond', id: pending.id, approved },
      {},
      resolve,
    );
  });
}

describe('OE Bridge capability broker', () => {
  it('uses a staged replacement without exposing or falling back to a legacy token', async () => {
    local.data.token = 'must-never-be-used';
    local.data.browserCredential = {
      credentialId: 'oeb_current', serverUrl: 'https://oe.test', browserName: 'Current',
      privateKeyJwk: { d: 'current-private' },
    };
    local.data.pendingBrowserCredential = {
      credentialId: 'oeb_candidate', serverUrl: 'https://oe.test', browserName: 'Candidate',
      privateKeyJwk: { d: 'candidate-private' },
    };
    const config = await broker.getConfig();
    expect(config).toMatchObject({
      pendingCredential: true,
      browserCredential: { credentialId: 'oeb_candidate' },
      name: 'Candidate',
    });
    expect(config).not.toHaveProperty('token');
  });

  it('executes an exact-field standing grant without a general tab lease', async () => {
    await local.set({ browserCredential: {
      credentialId: 'oeb_browser_a', serverUrl: 'https://oe.example.com',
      privateKeyJwk: { d: 'private-test-key' },
    } });
    const request = fieldWatchRequest();
    addTab(7, request.exactUrl, { active: false });
    executeImpl = async options => {
      expect(options.target).toEqual({ tabId: 7 });
      expect(options.args.slice(0, 2)).toEqual([request.exactUrl, '#price']);
      return [{ result: { ok: true, value: '$399.00', pageUrl: request.exactUrl } }];
    };

    const result = await broker.executeBrowserFieldCheck(request);

    expect(await broker.getLease()).toBeNull();
    expect(result).toMatchObject({
      ok: true,
      detection: {
        value: '$399.00', pageUrl: request.exactUrl,
        locatorFingerprint: request.field.fingerprint,
      },
    });
    expect(result.detection).not.toHaveProperty('html');
    expect(result.detection).not.toHaveProperty('text');
  });

  it('rejects field checks owned by another browser credential before touching a tab', async () => {
    await local.set({ browserCredential: {
      credentialId: 'oeb_browser_a', serverUrl: 'https://oe.example.com',
      privateKeyJwk: { d: 'private-test-key' },
    } });
    const request = fieldWatchRequest({ credentialId: 'oeb_browser_b' });
    addTab(7, request.exactUrl);

    await expect(broker.executeBrowserFieldCheck(request)).resolves.toMatchObject({
      ok: false, failure: { code: 'invalid_spec' },
    });
    expect(executeCount).toBe(0);
  });

  it('discards an exact-field reading when the page changes during execution', async () => {
    await local.set({ browserCredential: {
      credentialId: 'oeb_browser_a', serverUrl: 'https://oe.example.com',
      privateKeyJwk: { d: 'private-test-key' },
    } });
    const request = fieldWatchRequest();
    addTab(7, request.exactUrl);
    executeImpl = async () => {
      tabs.get(7).url = 'https://other.example.com/';
      return [{ result: { ok: true, value: '$399.00', pageUrl: request.exactUrl } }];
    };

    await expect(broker.executeBrowserFieldCheck(request)).resolves.toMatchObject({
      ok: false, failure: { code: 'redirect_out_of_scope' },
    });
  });

  it('sanitizes picker output into one bounded exact-field selection', () => {
    const picked = broker.sanitizePickedField({
      selector: '#price', value: `  $399   ${'x'.repeat(600)}`,
      property: 'price', parser: { type: 'price', currency: 'usd' },
      anchors: [{ text: 'Current price', relation: 'before' }],
    }, 'https://shop.example.com/product/1?color=green', 'Mower');
    expect(picked).toMatchObject({
      exactUrl: 'https://shop.example.com/product/1?color=green',
      field: { selector: '#price', property: 'price' },
      parser: { type: 'price', currency: 'USD' },
    });
    expect(picked.initialValue.length).toBeLessThanOrEqual(512);
    expect(picked).not.toHaveProperty('html');
  });

  it('signs the exact browser-auth challenge with a raw P-256 signature', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const credentialId = 'oeb_test_browser';
    const challenge = {
      credentialId,
      challengeId: 'challenge_123',
      nonce: 'nonce_456',
      expiresAt: Date.now() + 30_000,
    };
    const encoded = await broker.signBrowserChallenge({ credentialId, privateKeyJwk }, challenge);
    const raw = Buffer.from(encoded, 'base64url');
    expect(raw).toHaveLength(64);
    await expect(crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      raw,
      new TextEncoder().encode(`oe-browser-v1\n${credentialId}\n${challenge.challengeId}\n${challenge.nonce}`),
    )).resolves.toBe(true);
  });

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

  it('keeps opening tabs fail-closed until extension UI approves once', async () => {
    addTab(1, 'https://example.com/', { active: true });
    await broker.grantLease(1, 'https://example.com/');

    const declined = broker.dispatch('open_tab', { url: 'https://example.org/' });
    const declinedCheck = expect(declined).rejects.toThrow(/declined|approve|confirmation/i);
    await answerPendingConfirmation(false);
    await declinedCheck;
    expect(createCount).toBe(0);

    const approved = broker.dispatch('open_tab', { url: 'https://example.org/' });
    await answerPendingConfirmation(true);
    await expect(approved).resolves.toMatchObject({ tabId: 2, url: 'https://example.org/' });
    expect(createCount).toBe(1);
    expect((await broker.getLease()).tabs.map(tab => tab.tabId)).toEqual([1, 2]);
  });

  it('binds media confirmation to one exact leased tab, never an unrelated audible tab', async () => {
    addTab(1, 'https://open.spotify.com/track/one', { active: true });
    addTab(2, 'https://music.youtube.com/watch?v=other');
    tabs.get(2).audible = true;
    await broker.grantLease(1, 'https://open.spotify.com/track/one');
    executeImpl = async options => {
      expect(options.target).toEqual({ tabId: 1 });
      expect(options.args).toEqual(['playpause', 'https://open.spotify.com/track/one']);
      return [{ result: { method: 'selector-click', tabUrl: 'https://open.spotify.com/track/one' } }];
    };

    const controlling = broker.dispatch('media_control', { action: 'playpause' });
    await answerPendingConfirmation(true);
    await expect(controlling).resolves.toMatchObject({ tabUrl: 'https://open.spotify.com/track/one' });
    expect(executeCount).toBe(1);
  });

  it('cancels confirmed media control if its exact leased document changes', async () => {
    addTab(1, 'https://open.spotify.com/track/one', { active: true });
    await broker.grantLease(1, 'https://open.spotify.com/track/one');
    let changed = false;
    onGet = async id => {
      if (id === 1 && !changed) {
        changed = true;
        tabs.get(1).url = 'https://other.example.com/';
      }
    };

    const controlling = broker.dispatch('media_control', { action: 'playpause' });
    await answerPendingConfirmation(true);
    await expect(controlling).rejects.toThrow(/paused|navigated|changed/i);
    expect(executeCount).toBe(0);
  });

  it('lets a classified same-origin link click proceed but confirms ambiguous controls', async () => {
    addTab(1, 'https://example.com/', { active: true });
    await broker.grantLease(1, 'https://example.com/');
    let phase = 'safe-inspect';
    executeImpl = async () => {
      if (phase === 'safe-inspect') {
        phase = 'safe-click';
        return [{ result: {
          ok: true, requiresConfirmation: false, summary: '<a> “Details”',
          fingerprint: 'safe-link', descriptor: { tag: 'a' },
        } }];
      }
      if (phase === 'safe-click') {
        phase = 'ambiguous-inspect';
        return [{ result: { ok: true, elementSummary: '<a> “Details”' } }];
      }
      if (phase === 'ambiguous-inspect') {
        phase = 'ambiguous-click';
        return [{ result: {
          ok: true, requiresConfirmation: true, summary: '<button> “Continue”',
          fingerprint: 'ambiguous-button', descriptor: { tag: 'button' },
        } }];
      }
      return [{ result: { ok: true, elementSummary: '<button> “Continue”' } }];
    };

    await expect(broker.dispatch('click_xy', { tabId: 1, x: 10, y: 10 }))
      .resolves.toMatchObject({ confirmed: false });
    expect(session.data.pendingConfirmation).toBeUndefined();

    const ambiguous = broker.dispatch('click_xy', { tabId: 1, x: 20, y: 20 });
    await answerPendingConfirmation(true);
    await expect(ambiguous).resolves.toMatchObject({ confirmed: true });
  });

  it('does not expose a generic form-submit command even after confirmation', async () => {
    addTab(1, 'https://example.com/form', { active: true });
    await broker.grantLease(1, 'https://example.com/form');
    const submitting = broker.dispatch('submit_form', { tabId: 1 });
    const check = expect(submitting).rejects.toThrow(/not exposed/i);
    await answerPendingConfirmation(true);
    await check;
    expect(executeCount).toBe(0);
  });

  it('denies Enter and Space at the command layer', async () => {
    addTab(1, 'https://example.com/', { active: true });
    await broker.grantLease(1, 'https://example.com/');

    await expect(broker.dispatch('keypress', { tabId: 1, key: 'Enter' })).rejects.toThrow(/submit|confirmation/i);
    await expect(broker.dispatch('keypress', { tabId: 1, key: 'Space' })).rejects.toThrow(/trigger|confirmation/i);
    expect(executeCount).toBe(0);
  });

  it('validates routine wire steps without selectors, coordinates, secrets, or cross-origin paths', () => {
    expect(broker.validateRoutineStep({
      type: 'click', origin: 'https://example.com',
      target: { role: 'button', name: 'Search', ordinal: 1, exact: true },
    }, 'https://example.com')).toMatchObject({ type: 'click', origin: 'https://example.com' });
    expect(() => broker.validateRoutineStep({
      type: 'click', origin: 'https://example.com', x: 10,
      target: { role: 'button', name: 'Search' },
    }, 'https://example.com')).toThrow(/unsupported.*field/i);
    expect(() => broker.validateRoutineStep({
      type: 'navigate', origin: 'https://example.com', path: '//evil.example/'
    }, 'https://example.com')).toThrow(/same-origin/i);
    expect(() => broker.validateRoutineStep({
      type: 'fill', origin: 'https://example.com', value: 'password=hunter2',
      target: { role: 'textbox', label: 'Notes' },
    }, 'https://example.com')).toThrow(/secrets/i);
  });

  it('replays an ordinary semantic routine step inside the exact leased origin', async () => {
    addTab(1, 'https://example.com/catalog', { active: true });
    await broker.grantLease(1, 'https://example.com/catalog');
    let phase = 'inspect';
    executeImpl = async () => {
      if (phase === 'inspect') {
        phase = 'execute';
        return [{ result: {
          ok: true, requiresConfirmation: false, fingerprint: 'semantic-target',
          summary: 'click button “Search”',
        } }];
      }
      return [{ result: { ok: true, summary: 'clicked button “Search”' } }];
    };
    await expect(broker.dispatch('run_routine_step', {
      tabId: 1,
      routineId: 'brt_search',
      origin: 'https://example.com',
      step: {
        type: 'click', origin: 'https://example.com',
        target: { role: 'button', name: 'Search', label: null, ordinal: 1, exact: true },
      },
    })).resolves.toMatchObject({ ok: true, confirmed: false });
    expect(executeCount).toBe(2);
    expect(session.data.pendingConfirmation).toBeUndefined();
  });

  it('confirms a consequential routine step and stops when the user declines', async () => {
    addTab(1, 'https://example.com/cart', { active: true });
    await broker.grantLease(1, 'https://example.com/cart');
    executeImpl = async () => [{ result: {
      ok: true, requiresConfirmation: true, fingerprint: 'checkout-target',
      summary: 'click button “Place order”',
    } }];
    const running = broker.dispatch('run_routine_step', {
      tabId: 1,
      routineId: 'brt_checkout',
      origin: 'https://example.com',
      step: {
        type: 'click', origin: 'https://example.com',
        target: { role: 'button', name: 'Place order', label: null, ordinal: 1, exact: true },
      },
    });
    const check = expect(running).rejects.toThrow(/declined|approve|confirmation/i);
    await answerPendingConfirmation(false);
    await check;
    expect(executeCount).toBe(1); // inspected, never activated
  });

  it('keeps routine navigation on the stored origin', async () => {
    addTab(1, 'https://example.com/start', { active: true });
    await broker.grantLease(1, 'https://example.com/start');
    await expect(broker.dispatch('run_routine_step', {
      tabId: 1,
      routineId: 'brt_nav',
      origin: 'https://example.com',
      step: { type: 'navigate', origin: 'https://example.com', path: '/catalog' },
    })).resolves.toMatchObject({ ok: true, confirmed: false });
    expect(tabs.get(1).url).toBe('https://example.com/catalog');
    expect(executeCount).toBe(0);

    await expect(broker.dispatch('run_routine_step', {
      tabId: 1,
      routineId: 'brt_nav',
      origin: 'https://other.example',
      step: { type: 'navigate', origin: 'https://other.example', path: '/escape' },
    })).rejects.toThrow(/origin/i);
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

  it('keeps Teach Mode bound to one explicit tab and origin', async () => {
    addTab(1, 'https://example.com/tutorial', { active: true });
    addTab(2, 'https://other.example/');
    const grant = await broker.startTeachGrant(1, 'https://example.com/tutorial');
    expect(grant).toMatchObject({ tabId: 1, origin: 'https://example.com' });

    broker.pushObservation(2, { kind: 'click', element: { tag: 'button' } });
    broker.pushObservation(1, { kind: 'click', element: { tag: 'button', ariaLabel: 'Search' } });
    const observations = await broker.dispatch('get_observations', { tabId: 1 });
    expect(observations.events).toHaveLength(1);
    expect(observations.events[0].element.ariaLabel).toBe('Search');
    expect(observations.teach).toMatchObject({
      tabId: 1,
      origin: 'https://example.com',
      url: 'https://example.com/tutorial',
    });
    await expect(broker.dispatch('get_observations', { tabId: 2 })).rejects.toThrow(/taught tab/i);
    await expect(broker.dispatch('set_watch_mode', { on: true })).rejects.toThrow(/extension UI/i);
  });

  it('stops and clears Teach Mode when the taught tab changes origin', async () => {
    addTab(1, 'https://example.com/tutorial', { active: true });
    await broker.startTeachGrant(1, 'https://example.com/tutorial');
    broker.pushObservation(1, { kind: 'click', element: { tag: 'button' } });
    tabs.get(1).url = 'https://example.org/elsewhere';

    await tabUpdated.listeners[0](1, { url: 'https://example.org/elsewhere' });

    expect(await broker.getTeachGrant()).toBeNull();
    expect((await broker.getObservations(1)).events).toEqual([]);
    await expect(broker.dispatch('get_observations', {})).rejects.toThrow(/not active/i);
  });

  it('refuses Teach Mode on sensitive pages', async () => {
    addTab(1, 'https://accounts.google.com/login', { active: true });
    await expect(broker.startTeachGrant(1, 'https://accounts.google.com/login')).rejects.toThrow(/sensitive/i);
    expect(await broker.getTeachGrant()).toBeNull();
  });
});
