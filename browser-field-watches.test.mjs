import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  acknowledgeBrowserFieldWatchEvent,
  applyBrowserFieldObservation,
  browserFieldCheckRequest,
  browserFieldWatchHandler,
  buildBrowserFieldWatchSpec,
  canonicalWatchUrl,
  checkServerBrowserFieldWatch,
  claimDueBrowserFieldChecks,
  createBrowserFieldWatch,
  extractStructuredField,
  getBrowserFieldWatch,
  listBrowserFieldWatches,
  normalizeBrowserFieldDetection,
  parseNumericValue,
  recordBrowserFieldObservation,
  recordBrowserFieldFailure,
  revokeBrowserFieldWatch,
} from './lib/browser-field-watches.mjs';
import { USERS_DIR } from './lib/paths.mjs';

const safe = async () => ({ ok: true });

async function priceSpec(overrides = {}) {
  return buildBrowserFieldWatchSpec({
    confirmed: true,
    url: 'https://shop.example.test/product/1#reviews',
    label: 'Mower price',
    field: { detector: 'structured', property: 'price' },
    parser: { type: 'price', currency: 'USD' },
    predicate: { type: 'changed' },
    cadenceSec: 21_600,
    ...overrides,
  }, { urlSafety: safe, now: 1_000 });
}

function serverDetection(spec, value, extra = {}) {
  return {
    value,
    pageUrl: spec.url,
    detector: 'structured',
    executor: 'server',
    locatorFingerprint: spec.field.fingerprint,
    confidence: 0.97,
    ...extra,
  };
}

describe('browser field WatchSpec', () => {
  it('canonicalizes an exact URL and refuses secret-bearing or unconfirmed specs', async () => {
    expect(canonicalWatchUrl('https://EXAMPLE.test:443/item?q=1#details'))
      .toBe('https://example.test/item?q=1');
    expect(() => canonicalWatchUrl('https://example.test/item?access_token=secret'))
      .toThrow(/secret-bearing query/i);
    await expect(buildBrowserFieldWatchSpec({
      url: 'https://shop.example.test/item',
      field: { detector: 'structured' },
    }, { urlSafety: safe })).rejects.toThrow(/explicit user confirmation/i);
    await expect(buildBrowserFieldWatchSpec({
      confirmed: true,
      url: 'https://shop.example.test/item',
      headers: { Cookie: 'secret' },
      field: { detector: 'structured' },
    }, { urlSafety: safe })).rejects.toThrow(/may not contain cookies/i);
    await expect(buildBrowserFieldWatchSpec({
      confirmed: true,
      url: 'https://shop.example.test/item',
      field: { detector: 'structured' },
    }, { urlSafety: async () => ({ ok: false, reason: 'private network' }) }))
      .rejects.toThrow(/private network/i);
    await expect(buildBrowserFieldWatchSpec({
      confirmed: true,
      url: 'https://shop.example.test/checkout',
      field: { detector: 'structured' },
    }, { urlSafety: safe })).rejects.toThrow(/standing field permissions/i);
  });

  it('normalizes numeric formats and all executor detections into one tiny record', async () => {
    expect(parseNumericValue('$1,299.95')).toBe(1299.95);
    expect(parseNumericValue('EUR 1.299,95')).toBe(1299.95);
    const spec = await priceSpec();
    const observation = normalizeBrowserFieldDetection(spec, serverDetection(spec, '$1,299.95'), { now: 2_000 });
    expect(observation).toMatchObject({
      value: 1299.95,
      currency: 'USD',
      confidence: 0.97,
      source: { executor: 'server', detector: 'structured' },
    });
    expect(observation).not.toHaveProperty('html');
  });

  it('requires exact live URL and locator proof from browser execution', async () => {
    const spec = await priceSpec({
      execution: { mode: 'browser', reason: 'JavaScript-rendered price', credentialId: 'oeb_browser_a' },
      field: { detector: 'dom', property: 'price', selector: '[data-price]' },
    });
    expect(() => normalizeBrowserFieldDetection(spec, { value: '$10' }))
      .toThrow(/live page URL/i);
    expect(() => normalizeBrowserFieldDetection(spec, {
      value: '$10', pageUrl: spec.url, locatorFingerprint: spec.field.fingerprint,
      detector: 'dom', executor: 'browser',
    })).not.toThrow();
    expect(() => normalizeBrowserFieldDetection(spec, {
      value: '$10', pageUrl: 'https://other.example.test/', locatorFingerprint: spec.field.fingerprint,
      detector: 'dom', executor: 'browser',
    })).toThrow(/outside the standing permission/i);
  });
});

describe('field change confirmation', () => {
  it('seeds silently, discards a transient, and emits only after two matching changes', async () => {
    let spec = await priceSpec();
    let result = applyBrowserFieldObservation(spec, serverDetection(spec, '$500'), { now: 2_000 });
    spec = result.spec;
    expect(result.status).toBe('baseline_seeded');

    result = applyBrowserFieldObservation(spec, serverDetection(spec, '$450'), { now: 3_000 });
    spec = result.spec;
    expect(result.status).toBe('change_pending_confirmation');
    expect(result.event).toBeNull();

    result = applyBrowserFieldObservation(spec, serverDetection(spec, '$500'), { now: 4_000 });
    spec = result.spec;
    expect(result.status).toBe('unchanged');
    expect(spec.candidate).toBeNull();

    result = applyBrowserFieldObservation(spec, serverDetection(spec, '$450'), { now: 5_000 });
    spec = result.spec;
    result = applyBrowserFieldObservation(spec, serverDetection(spec, '$450'), { now: 6_000 });
    expect(result.status).toBe('changed');
    expect(result.event).toMatchObject({
      type: 'browser_field_changed',
      previous: { value: 500 },
      current: { value: 450 },
    });
  });

  it('fires threshold predicates only when entering the matching range', async () => {
    let spec = await priceSpec({ predicate: { type: 'below', target: 400 } });
    spec = applyBrowserFieldObservation(spec, serverDetection(spec, '$450')).spec;
    spec = applyBrowserFieldObservation(spec, serverDetection(spec, '$390')).spec;
    const entered = applyBrowserFieldObservation(spec, serverDetection(spec, '$390'));
    expect(entered.event).not.toBeNull();
    const acknowledged = { ...entered.spec, pendingEvent: null };
    let lower = applyBrowserFieldObservation(acknowledged, serverDetection(spec, '$380')).spec;
    lower = applyBrowserFieldObservation(lower, serverDetection(spec, '$380')).spec;
    expect(lower.pendingEvent).toBeNull();
  });
});

describe('server structured-data executor', () => {
  it('extracts JSON-LD without page screenshots or an LLM', async () => {
    const spec = await priceSpec();
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'Mower',
      offers: { '@type': 'Offer', price: '399.99', priceCurrency: 'USD' },
    })}</script>`;
    expect(extractStructuredField(html, spec)).toMatchObject({
      value: '399.99', currency: 'USD', detector: 'structured', executor: 'server',
    });
  });

  it('uses a fixed no-cookie fetch and refuses redirects outside the exact grant', async () => {
    const spec = await priceSpec();
    let options;
    const html = '<meta property="product:price:amount" content="399.99"><meta property="product:price:currency" content="USD">';
    const result = await checkServerBrowserFieldWatch(spec, {
      urlSafety: safe,
      fetchImpl: async (_url, opts) => {
        options = opts;
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      },
      now: 7_000,
    });
    expect(result.ok).toBe(true);
    expect(options.credentials).toBe('omit');
    expect(Object.keys(options.headers).map(k => k.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(options.headers).map(k => k.toLowerCase())).not.toContain('authorization');

    const redirected = await checkServerBrowserFieldWatch(spec, {
      urlSafety: safe,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://other.example.test/' } }),
    });
    expect(redirected).toMatchObject({ ok: false, failure: { code: 'redirect_out_of_scope' } });
  });

  it('notifies deterministically only after the second matching changed reading', async () => {
    const spec = await priceSpec({ cadenceSec: 300 });
    let state = { schema: 1, items: [spec] };
    let price = '500';
    const notify = vi.fn();
    const fetchImpl = async () => new Response(
      `<meta property="product:price:amount" content="${price}">`
      + '<meta property="product:price:currency" content="USD">',
      { status: 200 },
    );
    const helpers = { notify };
    let result = await browserFieldWatchHandler(state, helpers, { fetchImpl, urlSafety: safe, now: 1_000 });
    state = result.newState;
    expect(notify).not.toHaveBeenCalled();

    price = '450';
    result = await browserFieldWatchHandler(state, helpers, { fetchImpl, urlSafety: safe, now: 302_000 });
    state = result.newState;
    expect(notify).not.toHaveBeenCalled();

    result = await browserFieldWatchHandler(state, helpers, { fetchImpl, urlSafety: safe, now: 603_000 });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toMatch(/Mower price: USD 500.*USD 450/);
    expect(result.newState.items[0].pendingEvent).toBeNull();
  });
});

describe('owned field-watch store and browser contract', () => {
  it('keeps ownership scoped, returns a narrow request, persists observations, and revokes', async () => {
    const owner = `watch-owner-${Date.now()}`;
    const stranger = `watch-stranger-${Date.now()}`;
    const created = await createBrowserFieldWatch(owner, 'agent-test', {
      confirmed: true,
      url: 'https://shop.example.test/member-price',
      // The standing DOM grant belongs to exactly this paired browser.
      execution: { mode: 'browser', reason: 'member-only price', credentialId: 'oeb_browser_a' },
      field: { detector: 'dom', property: 'price', selector: '#member-price' },
      parser: { type: 'price', currency: 'USD' },
      predicate: { type: 'below', target: 300 },
      cadenceSec: 600,
    }, { urlSafety: safe, now: 10_000 });

    expect(getBrowserFieldWatch(stranger, created.id)).toBeNull();
    expect(listBrowserFieldWatches(owner)).toHaveLength(1);
    expect(browserFieldCheckRequest(created)).toMatchObject({
      watchId: created.id,
      exactUrl: created.url,
      permission: {
        scope: 'exact_url_field_read',
        executorCredentialId: 'oeb_browser_a',
        allow: ['read_selected_field'],
        deny: expect.arrayContaining(['surrounding_page', 'navigate', 'click', 'submit']),
      },
    });

    expect(claimDueBrowserFieldChecks(owner, { now: 20_000, executorCredentialId: 'oeb_browser_b' })).toEqual([]);
    const requests = claimDueBrowserFieldChecks(owner, { now: 20_000, executorCredentialId: 'oeb_browser_a' });
    expect(requests).toHaveLength(1);
    const detection = {
      value: '$350', pageUrl: created.url, detector: 'dom', executor: 'browser',
      locatorFingerprint: created.field.fingerprint,
    };
    const stored = recordBrowserFieldObservation(owner, created.id, detection, { now: 21_000 });
    expect(stored.status).toBe('baseline_seeded');
    expect(getBrowserFieldWatch(owner, created.id).nextDueAt).toBe(621_000);

    expect(acknowledgeBrowserFieldWatchEvent(owner, created.id, 'not-real')).toBeNull();
    const revoked = revokeBrowserFieldWatch(owner, created.id, { now: 30_000 });
    expect(revoked).toMatchObject({ status: 'revoked', permission: { revokedAt: new Date(30_000).toISOString() } });
    expect(listBrowserFieldWatches(owner)).toEqual([]);
    expect(listBrowserFieldWatches(owner, { includeRevoked: true })).toHaveLength(1);
    expect(claimDueBrowserFieldChecks(owner, { now: 999_999 })).toEqual([]);
  });

  it('creates the initial reading atomically and leaves no orphan on invalid input', async () => {
    const owner = `watch-atomic-${Date.now()}`;
    const base = {
      confirmed: true,
      url: 'https://shop.example.test/member-price',
      execution: { mode: 'browser', credentialId: 'oeb_browser_atomic' },
      field: { detector: 'dom', property: 'price', selector: '#member-price' },
      parser: { type: 'price', currency: 'USD' },
      predicate: { type: 'changed' },
      cadenceSec: 600,
    };
    await expect(createBrowserFieldWatch(owner, 'agent-test', {
      ...base,
      initialObservation: { value: 'not a price' },
    }, { urlSafety: safe, now: 40_000 })).rejects.toThrow(/valid price/i);
    expect(listBrowserFieldWatches(owner, { includeRevoked: true })).toEqual([]);

    const created = await createBrowserFieldWatch(owner, 'agent-test', {
      ...base,
      initialObservation: { value: '$349.00' },
    }, { urlSafety: safe, now: 50_000 });
    expect(created.baseline).toMatchObject({ value: 349, currency: 'USD' });
    // Collection items deliberately get one immediate first tick; the
    // already-committed baseline keeps that tick silent when unchanged.
    expect(created.nextDueAt).toBe(0);
  });

  it('persists bounded browser failures and marks a twice-missing locator for repair', async () => {
    const owner = `watch-failure-${Date.now()}`;
    const created = await createBrowserFieldWatch(owner, 'agent-test', {
      confirmed: true,
      url: 'https://shop.example.test/member-price',
      execution: { mode: 'browser', credentialId: 'oeb_browser_failure' },
      field: { detector: 'dom', property: 'price', selector: '#member-price' },
      parser: { type: 'price', currency: 'USD' },
      predicate: { type: 'changed' },
      cadenceSec: 600,
    }, { urlSafety: safe, now: 60_000 });
    const once = recordBrowserFieldFailure(owner, created.id, {
      code: 'locator_not_found', message: `missing ${'x'.repeat(500)}`,
    }, { now: 61_000 });
    expect(once).toMatchObject({ status: 'active', consecutiveFailures: 1 });
    expect(once.lastError.message.length).toBeLessThanOrEqual(240);
    const twice = recordBrowserFieldFailure(owner, created.id, {
      code: 'locator_not_found', message: 'still missing',
    }, { now: 62_000 });
    expect(twice).toMatchObject({ status: 'needs_repair', consecutiveFailures: 2 });
  });

  it('fails closed instead of overwriting a malformed watcher store', async () => {
    const owner = `watch-corrupt-${Date.now()}`;
    const userDir = path.join(USERS_DIR, owner);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'watchers.json'), '{not valid json', { mode: 0o600 });
    await expect(createBrowserFieldWatch(owner, 'agent-test', {
      confirmed: true,
      url: 'https://shop.example.test/item',
      field: { detector: 'structured', property: 'price' },
      parser: { type: 'price' },
      predicate: { type: 'changed' },
    }, { urlSafety: safe })).rejects.toThrow(/watcher store is unreadable/i);
    expect(fs.readFileSync(path.join(userDir, 'watchers.json'), 'utf8')).toBe('{not valid json');
  });
});
