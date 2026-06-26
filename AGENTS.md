# Repository Guidelines

## Project Structure & Module Organization

OpenEnsemble is a Node.js ES module application. `server.mjs` is the main entry point. Core chat orchestration lives in `chat.mjs`, with provider-specific streaming code under `chat/providers/`. Tool dispatch, roles, and skill loading are centered in `roles.mjs`, `skills/`, and `lib/`. HTTP routes live in `routes/`, browser assets in `public/`, user-facing documentation in `guide/`, and operational scripts in `scripts/`. Local runtime state such as `users/`, `logs/`, `models/`, vector databases, and `node_modules/` is intentionally ignored. The `tests/` directory is gitignored too, so a newly created test file is not picked up by `git add` automatically; a curated subset of `*.test.mjs` files is force-added and tracked. Tracked tests run locally only — they are not part of CI.

## Build, Test, and Development Commands

- `npm ci --ignore-scripts` installs dependencies without fetching bundled model artifacts.
- `npm start` runs `node server.mjs` locally.
- `npm run lint` runs `scripts/danger-zone-lint.mjs` to catch unsafe filesystem patterns.
- `npm run typecheck` runs `tsc -p tsconfig.json` for files opted into checking.
- `npm test` runs local Vitest tests if present. These tests are for local development and are not part of CI.

CI currently runs install, syntax checks for `.mjs` files, danger-zone lint, and typecheck.

## Coding Style & Naming Conventions

Use ES modules and keep filenames lowercase with hyphens where helpful, for example `tool-router.mjs`. Prefer small, focused modules under `lib/` and route-specific helpers under `routes/_helpers/`. Keep comments short and reserved for non-obvious behavior. Use two-space indentation in JavaScript and JSON, preserve existing style in touched files, and avoid broad refactors unless they are required for the change.

## Testing Guidelines

Vitest is the local test framework. Name tests `*.test.mjs` and place local test files under `tests/`. Because `tests/` is gitignored, a new test file must be `git add -f`'d to be tracked and included in a PR — otherwise it stays local-only. Tests are not run in CI. Before submitting, run `npm run lint`, `npm run typecheck`, and targeted local tests when relevant.

## Commit & Pull Request Guidelines

Commit messages are short, imperative summaries, often scoped by feature area, for example `chat ui: readable tool pills` or `Suppress stale replies after background tools`. PRs should describe the user-visible change, list verification commands, call out service restarts if needed, and include screenshots for UI changes. Never commit secrets, runtime data, models, logs, user files, or local test artifacts.

## Security & Configuration Tips

Configuration and per-user state are local runtime data. Keep credentials in ignored config paths or encrypted stores. When adding file writes, scope them through existing path helpers and avoid touching system/user data outside the install root unless explicitly required.
