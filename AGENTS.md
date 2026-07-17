# Repository Guidelines

## Project Structure & Module Organization

OpenEnsemble is a Node.js ES module application. `server.mjs` is the main entry point. Core chat orchestration lives in `chat.mjs`, with provider-specific streaming code under `chat/providers/`. Tool dispatch, roles, and skill loading are centered in `roles.mjs`, `skills/`, and `lib/`. HTTP routes live in `routes/`, browser assets in `public/`, user-facing documentation in `guide/`, and operational scripts in `scripts/`. Local runtime state such as `users/`, `logs/`, `models/`, vector databases, and `node_modules/` is intentionally ignored.

**Tests always live under `tests/` and stay gitignored.** Do not `git add -f` them, track them, or include them in commits/PRs. They are local development only and are not part of CI.

## Build, Test, and Development Commands

- `npm ci --ignore-scripts` installs dependencies without fetching bundled model artifacts.
- `npm start` runs `node server.mjs` locally.
- `npm run lint` runs `scripts/danger-zone-lint.mjs` to catch unsafe filesystem patterns.
- `npm run typecheck` runs `tsc -p tsconfig.json` for files opted into checking.
- `npm test` runs local Vitest tests if present. These tests are for local development and are not part of CI.

CI currently runs install, syntax checks for `.mjs` files, danger-zone lint, and typecheck.

## Restarting the running install

This machine runs OE as a **user systemd service**, not via ad-hoc `npm start`. Prefer that path when the user asks to restart after code changes (common and expected during development).

```bash
systemctl --user restart openensemble.service
systemctl --user status openensemble.service --no-pager
```

- Unit file: `~/.config/systemd/user/openensemble.service`
- Working directory: the OE install root (this repo)
- Entry: `node scripts/launch.mjs`
- Logs: `/tmp/openensemble.log` (also `journalctl --user -u openensemble.service`)
- UI alternative: **Settings → System → Restart Server** (same outcome; avoid mid-conversation when possible)

In-memory state (chat streams, pairing codes) does not survive a restart. Nodes and voice devices reconnect on their own.

## Coding Style & Naming Conventions

Use ES modules and keep filenames lowercase with hyphens where helpful, for example `tool-router.mjs`. Prefer small, focused modules under `lib/` and route-specific helpers under `routes/_helpers/`. Keep comments short and reserved for non-obvious behavior. Use two-space indentation in JavaScript and JSON, preserve existing style in touched files, and avoid broad refactors unless they are required for the change.

## Testing Guidelines

Vitest is the local test framework. Name tests `*.test.mjs` and place them only under `tests/`.

**Hard rule:** `tests/` is gitignored and must stay that way. Never `git add -f` a test file, never track tests in git, and never put tests outside `tests/` to “make them commit-able.” Run tests locally with `npm test` or `npx vitest run …`; they are not part of CI. Before submitting product code, run `npm run lint`, `npm run typecheck`, and targeted local tests when relevant.

## Commit & Pull Request Guidelines

Commit messages are short, imperative summaries, often scoped by feature area, for example `chat ui: readable tool pills` or `Suppress stale replies after background tools`. PRs should describe the user-visible change, list verification commands, call out service restarts if needed, and include screenshots for UI changes. Never commit secrets, runtime data, models, logs, user files, or local test artifacts (including anything under `tests/`).

## Security & Configuration Tips

Configuration and per-user state are local runtime data. Keep credentials in ignored config paths or encrypted stores. When adding file writes, scope them through existing path helpers and avoid touching system/user data outside the install root unless explicitly required.
