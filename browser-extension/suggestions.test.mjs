import { describe, expect, it } from 'vitest';
import { normalizeSuggestionMatchers, matchSuggestionForPage } from './suggestions.js';

const MATCHER = {
  id: 'bsm_abcdefghijklmnopqrstuv',
  domains: ['example-store.test'],
  keywords: ['kobalt', 'electric', 'mower', 'battery'],
  minKeywordMatches: 2,
  excludedDomains: [],
};

describe('extension-local project matching', () => {
  it('returns only an opaque id for domain or keyword matches', () => {
    expect(matchSuggestionForPage([MATCHER], {
      url: 'https://example-store.test/unrelated', title: 'Weekly sale',
    })).toEqual({ matcherId: MATCHER.id, score: 10 });
    expect(matchSuggestionForPage([MATCHER], {
      url: 'https://another-shop.test/tools', title: 'Kobalt electric tools',
    })).toEqual({ matcherId: MATCHER.id, score: 2 });
  });

  it('does not match one weak keyword or non-web pages', () => {
    expect(matchSuggestionForPage([MATCHER], {
      url: 'https://news.test/', title: 'Electric utility report',
    })).toBeNull();
    expect(matchSuggestionForPage([MATCHER], { url: 'chrome://settings', title: 'Kobalt mower' })).toBeNull();
  });

  it('drops malformed bundles and bounds every field', () => {
    expect(normalizeSuggestionMatchers([
      { id: 'project-name-leak', domains: ['ok.test'], keywords: ['valid'] },
      { ...MATCHER, domains: ['BAD VALUE'], keywords: ['ok', 'mower', 'MOWER', '<script>'] },
    ])).toEqual([{ ...MATCHER, domains: [], keywords: ['mower'], updatedAt: null }]);
  });

  it('honors server-synced Not relevant host exclusions locally', () => {
    expect(matchSuggestionForPage([{ ...MATCHER, excludedDomains: ['another-shop.test'] }], {
      url: 'https://another-shop.test/tools', title: 'Kobalt electric mower',
    })).toBeNull();
  });
});
