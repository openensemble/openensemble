/** Whole-token wake matching, shared by OE's built-in verification path. */
const HEY_TOKENS = new Set(['hey', 'hay', 'hej', 'heya', 'ey', 'hi']);
const MIN_SIMILARITY = 0.8;

// Keep the stock verifier's accepted spellings. Fuzzy matching is limited to
// these proper names; dictionary words and custom phrases stay literal.
const STOCK_WORDS = {
  hey_jarvis: ['jarvis', ['jarvis', 'jervis', 'jarves', 'jarvus', 'hey jarvis', 'hey jervis', 'hey jarves', 'hey jarvus'], true],
  carina_bare: ['karina', ['karina', 'carina', 'corina', 'kareena', 'karena', 'korina'], true],
  hey_computer: ['computer', ['computer', 'hey computer'], false],
  hey_korra: ['korra', ['cora', 'korra', 'corra', 'kora', 'hey cora', 'hey korra', 'hey corra', 'hey kora'], true],
  hey_taylor: ['taylor', ['taylor', 'tailor', 'hey taylor', 'hey tailor'], false],
  hey_athena: ['athena', ['athena', 'athina', 'hey athena', 'hey athina'], true],
  hey_gina: ['gina', ['gina', 'geena', 'gena', 'jina', 'hey gina', 'hey geena', 'hey gena', 'hey jina'], true],
  hey_assistant: ['assistant', ['assistant', 'hey assistant'], false],
  hey_ensemble: ['ensemble', ['ensemble', 'hey ensemble'], false],
  hey_sydney: ['sydney', ['sydney', 'sidney', 'sydnee', 'hey sydney', 'hey sidney', 'hey sydnee', 'hey cindy', 'hey cindi'], true],
  hey_carina: ['karina', ['karina', 'corina', 'carina', 'kareena', 'karena', 'korina', 'hey karina', 'hey corina', 'hey carina', 'hey kareena', 'hey karena', 'hey korina'], true],
};
const BARE_ALIASES = {
  assistant: 'hey_assistant', athena: 'hey_athena', ensemble: 'hey_ensemble',
  jarvis: 'hey_jarvis', karina: 'carina_bare', korra: 'hey_korra', sydney: 'hey_sydney',
};

export function normalizeWakeText(text) {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .split(/\s+/u).map(token => token
      .replace(/[^0-9a-z'’]+$/u, '')
      .replace(/['’]s$/u, '')
      .replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function buildSpec(slug, canonical, spellings, phonetic = false) {
  const variants = [];
  const seen = new Set();
  const literalOnly = new Set();
  const add = tokens => {
    const key = tokens.join(' ');
    if (tokens.length && !seen.has(key)) {
      seen.add(key);
      variants.push(tokens);
    }
  };
  for (const spelling of spellings) add(normalizeWakeText(spelling));
  const name = normalizeWakeText(canonical);
  if (slug.startsWith('hey_')) {
    const explicit = new Set(seen);
    for (const variant of [...variants]) {
      if (variant.length < 2 || !HEY_TOKENS.has(variant[0])) continue;
      const bare = variant.slice(1);
      if (explicit.has(bare.join(' ')) || (bare.length === name.length
          && bare.every((token, i) => similarity(token, name[i]) >= MIN_SIMILARITY))) {
        add(bare);
      } else {
        // "hey cindy" can verify Sydney, but neither bare "cindy" nor a
        // fuzzy neighbour such as "hey candy" may inherit that exception.
        literalOnly.add(variant.join(' '));
      }
    }
    add(['hey', ...name]);
  }
  add(name);
  return { slug, name, variants, phonetic, literalOnly };
}

const STOCK_SPECS = new Map(Object.entries(STOCK_WORDS)
  .map(([slug, [canonical, variants, phonetic]]) =>
    [slug, buildSpec(slug, canonical, variants, phonetic)]));

/** Custom manifest slugs get exact matching without a separate word registry. */
export function resolveWakeWordSpecs(wakeWords) {
  if (!Array.isArray(wakeWords) || !wakeWords.length || wakeWords.length > 8
      || wakeWords.some(word => typeof word !== 'string' || word.length > 39
        || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(word))) return null;
  return wakeWords.map(slug => {
    const known = STOCK_SPECS.get(slug)
      || (Object.hasOwn(BARE_ALIASES, slug) && STOCK_SPECS.get(BARE_ALIASES[slug]));
    if (known) return { ...known, slug };
    const canonical = (slug.startsWith('hey_') ? slug.slice(4) : slug).replaceAll('_', ' ');
    return buildSpec(slug, canonical, [canonical]);
  });
}

function literalToken(a, b) {
  return a === b || (b === 'hey' && HEY_TOKENS.has(a));
}

function phoneticToken(a, b) {
  if (literalToken(a, b)) return true;
  const initial = token => token[0] === 'c' ? 'k' : token[0];
  return initial(a) === initial(b) && similarity(a, b) >= MIN_SIMILARITY;
}

function subsequence(tokens, variant, equals) {
  for (let i = 0; i <= tokens.length - variant.length; i += 1) {
    if (variant.every((token, j) => equals(tokens[i + j], token))) return true;
  }
  return false;
}

/** Literal matches take precedence over all phonetic matches. */
export function matchWakeWords(transcript, specs, { requireHey = false } = {}) {
  const tokens = normalizeWakeText(transcript);
  const allowed = (spec, variant) => !requireHey || !spec.slug.startsWith('hey_')
    || HEY_TOKENS.has(variant[0]);
  const hit = (spec, variant, method) => ({
    slug: spec.slug, matched_variant: variant.join(' '), match_method: method,
  });
  for (const spec of specs) {
    for (const variant of spec.variants) {
      if (!allowed(spec, variant)) continue;
      if (subsequence(tokens, variant, literalToken)
          || (variant.length > 1 && tokens.includes(variant.join('')))) {
        return hit(spec, variant, variant.join(' ') === spec.name.join(' ') ? 'exact' : 'variant');
      }
    }
  }
  for (const spec of specs) {
    if (!spec.phonetic) continue;
    for (const variant of spec.variants) {
      if (spec.literalOnly.has(variant.join(' ')) || !allowed(spec, variant)) continue;
      if (subsequence(tokens, variant, phoneticToken)) return hit(spec, variant, 'phonetic');
    }
  }
  return null;
}
