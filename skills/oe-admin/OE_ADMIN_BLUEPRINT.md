# OE Admin Blueprint

This guide teaches you (the LLM) how to safely modify the OpenEnsemble
installation through the oe-admin skill. Read this BEFORE calling any
mutation tool.

## What this skill does

OE Admin lets you change the OpenEnsemble installation itself:

- Add new LLM providers at runtime (no code change).
- Install OS-level integrations like Tailscale via JSON "recipes".
- Flip safe config flags (enabledProviders, feature toggles).
- Restart the server to apply changes.
- List and revert past changes if something breaks.

It does **not** let you:

- Run arbitrary shell commands. There is no `exec` tool.
- Overwrite OE's source tree (routes/, lib/, public/, chat/). These are
  on a deny list and write attempts throw.
- Touch the master encryption key (users/_system/.master-key) — losing it
  orphans every encrypted secret.
- Manage skills/agents/roles. That's what the skill-builder skill is for.

Every tool gates on `isPrivileged(userId)` — only owner/admin can call
them. Other users get a clear permission denied.

## Directory layout (write rules)

```
~/.openensemble/
├── config.json                       — WRITABLE via set_config_field (allowlist)
├── config/
│   ├── user-providers.json           — WRITABLE via add_provider only
│   ├── oe-admin-audit.jsonl          — append-only audit log
│   ├── oe-admin-snapshots/           — per-entry file snapshots
│   └── .pending-change.json          — single-slot in-flight marker
├── skills/oe-admin/integrations/     — WRITABLE via save_integration_recipe
├── users/<id>/credentials/           — WRITABLE via credential primitive
└── (everything else)                 — READ-ONLY for this skill
```

## The four mutation tools

### `add_provider({ name, baseUrl, keyField, displayName?, modelsEndpoint?, sampleModelId? })`

Adds a new OpenAI-compatible provider at runtime. Flow:

1. Validates `baseUrl` (rejects link-local, multicast, non-http(s)).
2. Issues a `credential_prompt` of kind `api_key`. User pastes key into
   the protected widget; the value never reaches you.
3. Persists the key (encrypted with the master key) in config.json under
   `keyField`.
4. Writes the overlay entry to config/user-providers.json.
5. Probes `<baseUrl>/<modelsEndpoint || /models>` with the key to verify.
6. Returns `{ ok, restartRequired: true, message }`.

**Research-driven flow** (when the user says "look up how to add X"):

- Use WebFetch / WebSearch to read X's API documentation.
- Identify base URL, auth header format (Bearer vs API-Key vs custom),
  models endpoint path, and a sample model id.
- Show the user a one-screen summary and ask for explicit approval
  ("Does this look right? I'll need the API key next.").
- Only then call `add_provider`.

### `install_integration({ recipeName })`

Loads `skills/oe-admin/integrations/<recipeName>.json` and executes its
steps in order. Recipe is validated again at load time (no shell
metacharacters in binary names, all credential references declared, all
configWrites paths on the allowlist).

If any step has `requiresRoot: true`, the server issues a single sudo
credential prompt at recipe start; the password is held in RAM for the
duration of the recipe and zeroed after. Output from each step is
surfaced as a tool_result. The credential value itself is in the global
redaction registry — even if a subprocess echoes it, the LLM never sees it.

If you need to author a new recipe, call `save_integration_recipe` first,
show the resulting JSON to the user, then call `install_integration`.

### `set_config_field({ path, value })`

Sets one config.json field by dotted path. Path allowlist:

- `enabledProviders.*` — toggle a provider on/off
- `integrations.*.*` — store integration-specific flags
- `featureFlags.*` — boolean feature gates
- `stripThinkingTags` — global flag
- `logs.*` — log levels
- `cortex.{embedProvider,reasonProvider,ollamaUrl,lmstudioUrl,ollamaLocalUrl}` — cortex routing
- `providerFailover.*` — failover policy

ANYTHING matching `*ApiKey` / `*Token` / `*Secret` / `*Password` /
`*ClientId` / `*Username` is denied — use `add_provider` for keys, or
ask the user how they'd like to add other credentials.

`owner`, `userIds`, `users` are also denied to prevent privilege escalation.

### `restart_server({ reason })`

Final step for any change that needs a restart. Flow:

1. Records a pending marker linking the most recent audit entry.
2. Issues a `credential_prompt` of kind `confirm` — user must type the
   literal phrase `RESTART`.
3. Spawns a detached re-exec and exits.
4. The next boot runs `runBootCheck()`:
   - If `/api/_alive` responds 200 within `commitDeadlineMs` (default
     60s), the change is auto-committed.
   - If the deadline expires, the change is auto-reverted (snapshots
     restored, inverse commands run) and the process exits non-zero so
     the supervisor respawns clean.

Single-slot rule: only one change can be awaiting restart-commit at a
time. If `hasPendingChange()` is true, every mutation tool refuses.
Either restart now or call `revert_audit_entry` to clear the marker.

## More wrapped surfaces

Beyond the four primary mutation tools, oe-admin exposes thin wrappers for
infrastructure your admin asks about most often:

### OE self-update

- `oe_update_check()` — read-only; returns whether `origin/HEAD` has commits
  beyond your current SHA.
- `oe_update_apply({ force?: false })` — pulls, runs `npm install` if
  package.json changed, and triggers `restartProcess()`. Refuses on a dirty
  tree unless `force: true`. Audit-logs the prior SHA so a broken update
  can be manually reverted with `git reset --hard <fromSha>` if needed.
  (The boot-check pipeline does NOT auto-revert OE updates — too invasive.
  Updates are commit-ish operations the admin must reason about.)

### Cloudflare tunnel

- `tunnel_status()` — current mode, state, hostname, publicUrl, hasToken,
  lastError.
- `tunnel_configure({ hostname, localPort? })` — collects the CF tunnel
  token via the protected widget, writes `tunnel.json` (chmod 600 +
  gitignored). Does NOT start.
- `tunnel_start()` — sets autoStart=true and brings the tunnel up.
- `tunnel_stop()` — stops the tunnel and clears autoStart.

The cloudflared binary is auto-downloaded by `lib/tunnel-binary.mjs` on
first start — no recipe install step needed. Token comes from the user's
Cloudflare Zero Trust dashboard → Networks → Tunnels → "Install and run a
connector".

### Systemd unit

Ship-ready recipe at `skills/oe-admin/integrations/systemd-unit.json`.
Installs OE as `openensemble.service` with `ExecStart=node bin/oe-supervise.mjs`
so the external supervisor (Layer 2 of the crash-safe rollback) is active
by default once systemd takes over.

```
install_integration({ recipeName: "systemd-unit" })
```

Sudo prompt fires once for the install. The recipe enables the unit but
does NOT start it (the running OE is already on port 3737 — admin reboots
or kills the running process to hand control to systemd). After systemd
takes over, `restart_server` automatically uses the systemd-friendly
SIGTERM-and-let-Restart-respawn path.

## Integration recipe schema

```json
{
  "name": "tailscale",
  "description": "Install Tailscale and authenticate with an auth key",
  "version": 1,
  "prerequisites": [
    { "kind": "binary_missing", "name": "tailscale", "note": "skip install if already present" }
  ],
  "credentials": [
    {
      "id": "tailscale_authkey",
      "label": "Tailscale auth key",
      "kind": "api_key",
      "description": "From https://login.tailscale.com/admin/settings/keys"
    }
  ],
  "steps": [
    {
      "id": "install",
      "requiresRoot": true,
      "cmd": ["bash", "-c", "curl -fsSL https://tailscale.com/install.sh | sh"],
      "timeoutMs": 120000
    },
    {
      "id": "up",
      "requiresRoot": true,
      "cmd": ["tailscale", "up", "--authkey={{credentials.tailscale_authkey}}"],
      "timeoutMs": 60000
    }
  ],
  "configWrites": [
    { "path": "integrations.tailscale.enabled", "value": true }
  ],
  "verify": {
    "cmd": ["tailscale", "status", "--json"],
    "expect": { "kind": "json_path_exists", "path": "Self.Online" }
  },
  "rollback": [
    { "id": "down", "requiresRoot": true, "cmd": ["tailscale", "down"] }
  ]
}
```

### Field rules

- `name` — lowercase letters/numbers/hyphens/underscores, must match the filename.
- `credentials[].id` — kebab/snake-case; referenced in commands as `{{credentials.<id>}}`.
- `credentials[].kind` — usually `api_key` (persisted, encrypted) or `confirm`.
- `steps[].cmd` — argv array. `cmd[0]` must be a plain binary name (no shell
  metacharacters in the binary slot). Use the `bash -c "…"` form only when
  shell expansion is genuinely needed.
- `steps[].requiresRoot` — when ANY step has this, a single sudo prompt
  fires at recipe start. Don't put the password in the command — the server
  spawns `sudo -S` and pipes the password to stdin.
- `steps[].timeoutMs` — per-step timeout (default 60s).
- `steps[].stdin` — OPTIONAL string. Piped to the subprocess's stdin AFTER
  the sudo password (if any). Supports `{{credentials.<id>}}` and
  `{{env.<NAME>}}` templates. Use for `tee /etc/foo <<< content` patterns
  without spawning a shell.
- `configWrites` — each path runs through `assertConfigPathAllowed`.
- `verify` — `cmd` + `expect` (`json_path_exists` or `exit_zero`). Runs
  after all steps. Failure marks the recipe as failed (rollback runs).
- `rollback` — reverse-order steps run on step failure or on
  `revert_audit_entry`. Each can be `requiresRoot: true` too.

### Available env templates

Every recipe step (and its `stdin`) can reference these auto-detected values:

- `{{env.OE_BASE_DIR}}` — absolute install path
- `{{env.OE_NODE_BIN}}` — currently-running node executable
- `{{env.OE_USER}}` — process owner username
- `{{env.OE_PORT}}` — `3737`
- `{{env.OE_SUPERVISE}}` — absolute path to `bin/oe-supervise.mjs`

## Credential prompts

The chat-protocol primitive is shared with any tool that needs a secret.
You request one server-side via the credential primitive (which the
oe-admin tools do automatically). Kinds:

- `api_key` — persisted encrypted under `users/<userId>/credentials/`.
  Survives restart. Use for provider keys, integration auth tokens.
- `sudo` — held in RAM only for the duration of one operation. Never
  persisted. Use only for sudo passwords on requiresRoot steps. The
  primitive registers the password in the redaction set so any command
  output that echoes it gets scrubbed before the LLM sees it.
- `confirm` — like `api_key` but plain text input. Use for explicit
  user-typed confirmation phrases (e.g. "type RESTART to confirm").

The value never enters your message history. You only see the
credentialId — a stable handle that the tool uses internally to fetch
the plaintext.

## Audit log + revert

Every mutation writes a pending entry to `config/oe-admin-audit.jsonl`
with a snapshot of every file the change is about to touch. The entry
also records an `inverse` block describing the undo.

- `list_audit_log({ limit })` — show recent entries (id, op, timestamp,
  status). Status progression: `pending` → `committed` (after a clean
  restart) or `rolled_back` (after revert or commit-deadline failure).
- `revert_audit_entry({ id })` — restore the snapshots and run inverse
  commands. Recipe rollback steps that need root trigger a fresh sudo
  prompt. After revert, the entry is marked `rolled_back` and a NEW
  audit entry of op=`revert` is appended.

## Restart semantics

Most changes need a restart. After you make the change(s), tell the
admin to restart, then call `restart_server({ reason })`. The boot
watchdog will:

- Commit the change if the new process answers `/api/_alive` within the
  commit deadline (default 60s).
- Auto-revert and respawn if it doesn't.

This means: if you make a change that prevents OE from booting, the
NEXT boot reverts it automatically and comes up clean. The admin
sees a log line like `[oe-admin] auto-reverted entry <id>: prior boot
failed to commit within 60s`.

The supervisor at `bin/oe-supervise.mjs` (opt-in, runs OE as a child
process) handles the case where Node itself can't start (corrupt
node_modules, broken syntax). Not all installs run the supervisor; the
in-process boot-check is the always-on layer.

## Verification (always do this!)

Every recipe must include a `verify` block. For providers, the
post-add `/models` probe IS the verification. For free-form changes,
explain to the admin how to confirm the result ("run `tailscale status`
to check connectivity").

## Common pitfalls

- **Putting the credential value in a tool result string.** Don't.
  Reference it by id only, or use the global redaction registry for
  subprocess output.
- **Bypassing the credential prompt.** If a step needs a secret, ALWAYS
  go through the credential primitive — don't ask the user to type the
  secret as a chat message (it would land in the LLM message history).
- **Mutating multiple files in one tool call without snapshotting them.**
  The audit entry's `snapshotFiles` list must include every file the
  change touches, otherwise revert can't undo it.
- **Skipping `oe_admin_read_blueprint`.** You're reading this now. Good.
- **Forgetting `restart_server` after a config change.** Tell the admin
  to restart explicitly. Don't auto-restart unless they've said yes.
- **Two pending changes at once.** Refused by the single-slot marker.
  Commit (restart) or revert the first one before starting another.
