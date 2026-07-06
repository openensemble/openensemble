---
title: "Security: skill sandbox"
nav_order: 4
description: >-
  How OpenEnsemble isolates untrusted user-authored skills — a broker
  process, bubblewrap jails, and a real trust boundary around custom code.
---

# Custom-Skill Sandbox — What Was Built

Multi-tenant isolation for **custom (user-authored) skills**. OE is one Node process
serving all users off a shared filesystem; a custom skill's `execute.mjs` used to run
in-process with whatever `userId` it was handed, so a rogue/buggy skill could read another
user's tokens, the master key, or the OE config. This work puts a real trust boundary
around untrusted skill code without touching the fast path for trusted first-party skills.

Branch: `fix/delegation-tool-router-hardening`. Status: **8 of 9 custom skills run
sandboxed, live.** (`oe-update-checker` is deliberately in-process — see below.)

---

## Threat model & trust boundary

- **Trusted (in-process):** first-party skills shipped in `skills/` (audited, ~33 of them).
  `wrap.userId == null`.
- **Untrusted (sandboxed):** per-user skills under `users/<uid>/skills/`. Trust is decided
  by **origin, not name** — a custom skill named "email" is still jailed. Gating:
  `roles.shouldSandboxSkill(wrap)`.
- The hole was **direct `fs`** scoped only by the `userId` argument. The fix is an OS
  boundary (bubblewrap), not more careful scope-checking.

## Mechanism

Each sandboxed skill call runs its `execute.mjs` in a **bubblewrap (`bwrap`) subprocess**
that mounts only the owner's data. Everything the skill needs from the parent (secrets,
watchers, streaming, external binaries) is serviced over an **NDJSON-multiplexed RPC broker**
on stdin/stdout — chosen over fd-passing because it survives `bwrap` cleanly. The broker is
a strict **allowlist**: a jailed skill gets *less* than the in-process `ctx`, and the parent
forces `(userId, agentId, skillId)` on every brokered call so a child can't act as another.

**Isolation guarantees:**
- **Filesystem** — read/write only the owner's `documents/images/videos/audio/research`
  folders + the skill's own `state/` dir. `config.json`, `users/_system` (master key),
  other users' dirs, and OAuth/token files are not mounted → reads `ENOENT`.
- **Secrets** — `ctx.credentials` is a brokered, per-skill, master-key-encrypted store
  (`${skillId}__${id}`). The master key never enters the jail.
- **Network** — **default-deny**: the jail runs with `--unshare-net` (its own empty net
  namespace, no egress, no host loopback) unless the manifest opts in.
- **External binaries** — `ctx.ensureRuntime`/`runSandboxed` (yt-dlp etc.) are clamped: the
  binary must live under the skill's own `bin/`, writable dirs are clamped to the skill's
  folders, and it runs in a nested `bwrap` on top.

---

## What shipped (in order)

| Commit | Layer |
|---|---|
| `47d739b` | **Runner** — `lib/skill-subprocess.mjs` (parent) + `lib/skill-host.mjs` (in-jail harness). Fail-closed if no `bwrap`. |
| `c27880b` | **ctx IPC broker** — `lib/skill-ctx-broker.mjs`, the parent-side allowlist. |
| `28f02c8` | **Wire-in** — both dispatch seams (`executeRoleTool` + `executeToolStreaming`) branch on `shouldSandboxSkill`, flag-gated. |
| `a5e86f9` | **Blueprint** — sandbox authoring contract in `SKILL_BLUEPRINT.md`. |
| `76e7562` | **Watcher ctx surface** brokered (watch / proposeMonitor / unwatch / list). |
| `8f1ac5f` | **Watcher firing in the jail** — `runCustomWatcherSandboxed`; handler code runs jailed, `fire/notify/postStatus` keep full behaviour via `helper.*` RPCs. |
| `113be92` | **`ctx.credentials`** first-class secret store; migrated runpod + thunder off plaintext config files (**deleted the cleartext API keys**). |
| `019c8bf` | **Runtime broker** — `lib/skill-runtime-broker.mjs`, clamped ensureRuntime/runSandboxed. All 9 skills now sandbox-ready. |
| `0b7f81a` | **Per-skill gating** — `config.skillSandbox.skills` allowlist (per-skill trial) alongside `.enabled` (global). |
| `ae00faf` | **Network default-deny** — `lib/skill-net-policy.mjs`; jail gets `--unshare-net` unless `manifest.sandbox.network:true`; runtime broker clamps sub-binary egress to the skill's capability. |
| `5244a2b` | **System-watcher-kind guard** — a sandboxed skill can't register a watcher of a system kind (`exec`/`http_jsonpath`/`file_stat`/`task_proxy`/`event_subscription`) that would run in-process. |
| `ab86dfc` | **onFire neuter** — an untrusted skill's `agent`-delivery fire is downgraded to an owner notification (no agent turn, no confirmation-bypass); `email` fire forced to self (no exfil). |
| `8169ed9` | **Author-time consent** — `skill_create` ships skills sandboxed by default (`manifest.sandbox.isolate`), refuses network-using skills until `allow_network` is set, surfaces credential use; `skill_update_*` re-scan and can grant. |
| *(local)* | **Regression suite** — `tests/skill-sandbox-security.test.mjs` (7 tests). `tests/` is gitignored by convention (`9bdf205`), so it's local-only. |

## Key files

- `lib/skill-subprocess.mjs` — parent runner; `runSandboxedJob` / `runCustomSkillSandboxed` / `customSkillBindings`.
- `lib/skill-host.mjs` — in-jail harness (job on stdin → result on stdout; `ctx`/`helpers` proxies).
- `lib/skill-ctx-broker.mjs` — the RPC allowlist (log, credentials, runtime, watch/proposeMonitor/unwatch).
- `lib/skill-net-policy.mjs` — `skillDeclaresNetwork` (default-deny resolver).
- `lib/skill-runtime-broker.mjs` — clamped external-binary runtime.
- `lib/credentials.mjs` — `buildSkillCredentials` (per-skill encrypted store).
- `scheduler/watchers.mjs` — `runCustomWatcherSandboxed`, `isSystemWatcherKind`, `executeOnFire` (onFire neuter), `handlerHelpers`.
- `roles.mjs` — `shouldSandboxSkill` / `isSandboxedSkill`; net resolution at the tool seam.
- `skills/skill-builder/execute.mjs` — `scanSkillCapabilities` + create/update consent flow.

## Escalation vectors closed

| Vector | Closed by |
|---|---|
| Read other users' data / master key | filesystem mounts (`47d739b`) + brokered creds (`113be92`) |
| Exfiltrate own-user data over the network | network default-deny (`ae00faf`) |
| Plant an `exec` watcher that runs in-process on de-sandbox | system-watcher-kind guard (`5244a2b`) |
| Puppet the coordinator via `onFire` agent prompt (no confirm) | onFire downgrade to notification (`ab86dfc`) |
| Email arbitrary recipients via `onFire` email | forced to self (`ab86dfc`) |
| Run arbitrary binaries / write arbitrary dirs via runtime | runtime broker clamps (`019c8bf`) |

## Tasks & polling — audited, covered

- **Tasks** (`background-tasks.mjs`) run as agent prompts via `streamChat`; their tool calls
  flow back through the jailed `executeToolStreaming` seam. No separate hole.
- **Polling = watchers**; ticks route to the jail by `skillId`. A sandboxed skill *can*
  create a watcher/poller (capped per-user), but only of its own kinds, jailed each tick,
  net-gated. It **cannot** create a `background-tasks` task — no `ctx` surface exists for it.

## Why `oe-update-checker` is excluded

It inspects the OE install itself (repo root, `.git`, to check for updates) — not mounted in
the jail, so sandboxing would break it. It's a user-authored **admin** skill → trusted,
in-process. Lesson: some custom skills are admin-class; the allowlist handles this, and a
future global-enable would need an opt-*out* list.

## Verification

- Real egress proof: `node` in the live jail sees the host interface and reaches the OE
  server with `net:true`; zero non-loopback interfaces and unreachable with `net:false`.
- Migrated skills read their config jailed; runpod round-trips its API key in-process and
  jailed; youtube-download downloaded 2160p/1080p videos through the jail (verified live).
- Regression suite: 7 tests green; full local suite 717 green.

## Open (Phase 5, defense-in-depth — not gaps)

- Per-skill CPU/time/memory caps (a skill can still spin or run long).
- Tool-gate the *trusted* `onFire` agent-summary turns (needs a `streamChat` allowedTools
  path — not currently plumbed).
- **Per-user isolation** — the stronger tenant boundary. See `PER_USER_SANDBOXING.md`.
