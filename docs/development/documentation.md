---
title: Maintaining documentation
parent: Development
nav_order: 1
permalink: /development/documentation/
---

# Maintaining documentation

`guide/*.md` is the source for both the in-app Guide and the public user guide.
`guide/index.json` supplies page titles and navigation. Edit those sources,
then regenerate the checked-in website pages:

```bash
node scripts/sync-guide-docs.mjs
node scripts/sync-guide-docs.mjs --check
```

Do not hand-edit `docs/guide/`. The generator adds website metadata and converts
relative guide links to public page URLs. CI rejects generated pages that no
longer match their sources. Installation and feature landing pages live in
`docs/`; link them to the user guide for detailed usage instructions.

## Writing a feature page

Use this order where it applies: what it does, prerequisites, setup, a small
verification example, and common problems. Use the current visible labels,
state which account role can configure it, and distinguish the OE host from
the user's browser or a remote node. Keep optional developer details separate.

Link another guide with `[Title](page-slug.md)` and an optional `#section`.
Use ordinary Markdown headings. The in-app Guide handles page and heading
navigation; its search checks all indexed page contents.

When adding a feature, add its instructions to the relevant guide (or add a
page to the index) and link the release note to it. Bug fixes stay in
`whats-new.md` unless they also change instructions a user needs. The changelog
is historical; its old UI labels and limits are not the current reference.

## Checks

Run the synchronization check, `npm run lint`, and `npm run typecheck`.
Changes to Guide behavior also need local tests for full-text search,
authentication, internal links, section anchors, and rapid navigation.
Local tests remain under ignored `tests/`, following AGENTS.md.
