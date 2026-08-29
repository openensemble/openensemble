# OE network rules

These are generated Manifest V3 `declarativeNetRequest` rulesets. Do not edit
them by hand — they are rebuilt by `../tools/build-filters.mjs`.

| File | Tier | Default | Contents |
| --- | --- | --- | --- |
| `ads.json` | ads | on | Advertising platforms, exchanges, and ad-serving paths |
| `trackers.json` | trackers | on | Analytics, profiling, and cross-site measurement |
| `annoyances.json` | annoyances | off | Cookie notices, newsletter nags, and overlays |
| `surrogates.json` | always on | on | Redirects to the neutered stubs in `../surrogates/` |

Two properties hold across every generated rule, and both are enforced by
`../tools/validate-rules.mjs`:

- **No rule blocks a top-level navigation.** `main_frame` never appears in a
  block rule's `resourceTypes`, so a filter can cost you an ad but never a page.
- **All tiers enabled together stay inside Chrome's guaranteed budget** of
  30,000 enabled static rules, with headroom for `surrogates.json`.

`surrogates.json` deliberately outranks the block rules. Blocking Google
Analytics or the Google Publisher Tag outright breaks pages that call their
APIs, so those requests are redirected to stubs that satisfy the call sites and
send nothing anywhere.

## Rebuilding

```sh
node tools/build-filters.mjs --fetch     # download upstream lists, then convert
node tools/validate-rules.mjs            # schema, budget, and safety checks
```

An OE admin can do the same thing through the server with
`POST /api/browser/filters/refresh`, which fetches and reconverts host-side so
the browser still never contacts a filter-list host. Reload OE Bridge on the
browser's extensions page afterwards; Chrome reads static rulesets at load time.

## Upstream sources and licensing

The generated rules are derived from the lists recorded in
`../filters/build-info.json`:

| List | License |
| --- | --- |
| [EasyList](https://easylist.to/) | GPLv3 / CC BY-SA 3.0 |
| [EasyPrivacy](https://easylist.to/) | GPLv3 / CC BY-SA 3.0 |
| [EasyList Cookie List](https://secure.fanboy.co.nz/) | GPLv3 / CC BY-SA 3.0 |
| [uBlock Origin filter lists](https://github.com/uBlockOrigin/uAssets) | GPLv3 |

OpenEnsemble is AGPL-3.0-or-later, which is compatible with the GPLv3 terms
these lists are offered under. The conversion tooling in `../tools/` is part of
OpenEnsemble and carries the repository license.

The curated advertising domains OE blocked before it carried upstream lists are
kept as a floor in `CORE_AD_DOMAINS` (see `../tools/build-filters.mjs`). Upstream
expresses several of them only through narrower path rules, so without that floor
the size budget could trim a blanket block on a major exchange.
