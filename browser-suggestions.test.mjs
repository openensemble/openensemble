import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './lib/paths.mjs';
import { saveUser } from './routes/_helpers.mjs';
import {
  recordBrowserClipForSuggestions, listBrowserSuggestionMatchers,
  resolveBrowserSuggestion, respondToBrowserSuggestion,
  _resetBrowserSuggestionsForTests,
} from './lib/browser-suggestions.mjs';

const ADULT = 'user_browser_suggest_adult';
const CHILD = 'user_browser_suggest_child';

beforeEach(() => {
  saveUser({ id: ADULT, name: 'Alex', role: 'owner' });
  saveUser({ id: CHILD, name: 'Sam', role: 'child' });
  _resetBrowserSuggestionsForTests(ADULT);
  _resetBrowserSuggestionsForTests(CHILD);
});

afterAll(() => {
  for (const id of [ADULT, CHILD]) {
    try { fs.rmSync(path.join(USERS_DIR, id), { recursive: true, force: true }); } catch {}
  }
});

async function teach(overrides = {}) {
  return recordBrowserClipForSuggestions(ADULT, {
    targetId: 'research:mowers',
    projectLabel: 'Mower research',
    capture: {
      url: 'https://example-store.test/tools/electric-mower',
      title: 'Kobalt electric mower with 80V battery',
    },
    ...overrides,
  });
}

describe('browser project suggestion matchers', () => {
  it('syncs coarse opaque matchers without project names or target ids', async () => {
    await teach();
    const matchers = listBrowserSuggestionMatchers(ADULT);
    expect(matchers).toHaveLength(1);
    expect(matchers[0].id).toMatch(/^bsm_/);
    expect(matchers[0].keywords).toEqual(expect.arrayContaining(['kobalt', 'electric', 'mower']));
    expect(matchers[0].domains).toEqual([]);
    expect(JSON.stringify(matchers[0])).not.toContain('Mower research');
    expect(JSON.stringify(matchers[0])).not.toContain('research:mowers');
  });

  it('reveals the project only after revalidating a clicked local match', async () => {
    const matcher = await teach();
    expect(resolveBrowserSuggestion(ADULT, {
      matcherId: matcher.id,
      url: 'https://another-shop.test/kobalt-tools',
      title: 'Kobalt 80V electric mower sale',
    })).toMatchObject({ projectLabel: 'Mower research', actions: ['remember', 'not_relevant', 'forget'] });
    expect(resolveBrowserSuggestion(ADULT, {
      matcherId: matcher.id,
      url: 'https://news.test/weather',
      title: 'Tomorrow morning forecast',
    })).toBeNull();
  });

  it('mutes one host on Not relevant and deletes the matcher on Forget', async () => {
    const matcher = await teach();
    const page = { matcherId: matcher.id, url: 'https://another-shop.test/kobalt', title: 'Kobalt electric mower' };
    expect(resolveBrowserSuggestion(ADULT, page)).not.toBeNull();
    await expect(respondToBrowserSuggestion(ADULT, { ...page, action: 'not_relevant' }))
      .resolves.toEqual({ ok: true, action: 'not_relevant' });
    expect(resolveBrowserSuggestion(ADULT, page)).toBeNull();
    await expect(respondToBrowserSuggestion(ADULT, { matcherId: matcher.id, action: 'forget' }))
      .resolves.toEqual({ ok: true, action: 'forget' });
    expect(listBrowserSuggestionMatchers(ADULT)).toEqual([]);
  });

  it('broadens to same-domain matching only after explicit Remember', async () => {
    const matcher = await teach();
    const unrelatedSameHost = {
      matcherId: matcher.id,
      url: 'https://example-store.test/garden-hose',
      title: 'Expandable garden hose',
    };
    expect(resolveBrowserSuggestion(ADULT, unrelatedSameHost)).toBeNull();
    await expect(respondToBrowserSuggestion(ADULT, { matcherId: matcher.id, action: 'remember' }))
      .resolves.toEqual({ ok: true, action: 'remember' });
    expect(listBrowserSuggestionMatchers(ADULT)[0].domains).toEqual(['example-store.test']);
    expect(resolveBrowserSuggestion(ADULT, unrelatedSameHost)).toMatchObject({
      projectLabel: 'Mower research', remembered: true,
    });
  });

  it('suppresses all matchers for children and shared profiles', async () => {
    expect(await recordBrowserClipForSuggestions(CHILD, {
      targetId: 'research:toys', projectLabel: 'Toy ideas',
      capture: { url: 'https://toys.test/blocks', title: 'Building blocks' },
    })).toBeNull();
    await teach();
    expect(listBrowserSuggestionMatchers(ADULT, { sharedProfile: true })).toEqual([]);
  });

  it('does not persist sensitive-topic matchers', async () => {
    expect(await teach({
      targetId: 'research:health', projectLabel: 'Cancer treatment research',
      capture: { url: 'https://hospital.test/', title: 'Medication options' },
    })).toBeNull();
    expect(listBrowserSuggestionMatchers(ADULT)).toEqual([]);
  });

  it('fails closed without overwriting a corrupt matcher store', async () => {
    const file = path.join(USERS_DIR, ADULT, 'browser-suggestions.json');
    fs.writeFileSync(file, '{"version":1,"projects":');
    expect(() => listBrowserSuggestionMatchers(ADULT)).toThrow(/malformed; refusing/i);
    await expect(teach()).rejects.toThrow(/malformed; refusing/i);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":1,"projects":');
  });
});
