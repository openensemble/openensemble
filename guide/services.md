# Service profiles

A **service profile** lets OE manage a real service running on one of your nodes — Pi-hole, Home Assistant, nginx, MariaDB, Vaultwarden, anything with an API or config files. Once you've onboarded a service, your agents can:

- run operations against it (block a domain, restart a daemon, edit a vhost) with full audit and rollback
- monitor its health automatically and open an incident when something breaks
- gather diagnostics and propose (or auto-apply) fixes from a researched runbook

Profiles are the layer that turns "OE has shell access to my Pi-hole" into "OE knows what Pi-hole *is*, what it can do, what counts as healthy, and what to try when it isn't."

## The onboarding flow

Onboarding a service is a conversation with your agent, not a wizard. Walk through it once per service, per node:

1. **Detect what's running.** *"What services are on `pihole`?"* — your agent runs `node_detect_services` and reports back ("Detected: pihole. Listening on 53, 80, 443.").
2. **Research it.** *"Onboard the Pi-hole."* — the agent uses web search + `node_exec` (read-only) to look up the API, the config layout, the upgrade path, common failure modes, and cite its sources.
3. **Save the draft.** Agent calls `profile_save` with the constructed JSON. The schema validator rejects malformed profiles with a clear error so the agent can fix and resave.
4. **Verify.** *"Verify it works."* — `profile_verify_readonly` automatically runs every read-only operation in the profile against the live service and marks each one verified or failed. You see a summary like "4 of 5 read-only ops verified, 1 failed (auth required)."
5. **Review.** *"Show me the profile."* — agent calls `profile_load render:true` and surfaces the rendered Markdown. You see what actions were defined, what risk class each got, what health checks will run, what failure modes are catalogued, and where the LLM got the info.
6. **Approve.** *"Looks good, approve it."* — agent calls `profile_set_trust_state state:'reviewed'`. **This automatically starts monitoring** for the profile's defined checks; you don't have to wire monitoring separately.

The output gets saved as plain files under `users/<you>/nodes/<nodeId>/profiles/<service>.{json,md,research.md}` so you can read them in a text editor, git-track them, share them with someone else's OE install, etc.

## Automation Level

Every profile has an automation level. Internally the JSON field is called `trust_state`, but the UI uses these labels:

- **Draft** (`unverified`) — monitoring is off and fixes are only proposed. You can still ask the agent to run actions, but each write needs confirmation.
- **Approved** (`reviewed`) — monitoring is on. Low-risk fixes on tested actions can auto-apply when an incident matches a known failure mode. Medium and high-risk fixes still ask first.
- **Auto-fix** (`proven`) — monitoring is on, and medium-risk fixes such as service restarts, reloads, and reversible config changes can auto-apply on tested actions. High-risk fixes always require confirmation. Promoting to this level is staged: OE asks you to type `APPROVE PROVEN` in chat to confirm.

Going back to **Draft** tears down monitoring. The level always reflects what's actually happening.

### What's "low" vs "medium" vs "high" in practice?

| Risk | Examples | At Approved? | At Auto-fix? |
|---|---|---|---|
| **low** | `dns_block`, `disable_for_5min`, `reload_blocklists`, anything read-only | auto-applies on verified ops | auto-applies on verified ops |
| **medium** | `service_restart`, `reload_config`, `apply_vhost_change`, anything with a clean inverse | proposes | auto-applies on verified ops |
| **high** | `wipe_database`, `reset_to_defaults`, anything destructive or with no inverse | proposes | proposes |

A "tested action" means OE has actually run that action (or its read-only twin) successfully at least once and `op.verified === true` — auto-apply never fires on an action that has never been exercised.

## Operating a service

Once a profile is Approved, your agent calls actions through `dispatch_op`:

> *"Block ads on doubleclick.net"* → agent calls `dispatch_op opId='dns_block' parameters={domain:'doubleclick.net'}`.

The dispatcher: looks up the operation in the profile, substitutes parameters into the call template, takes a pre-state snapshot (saving exactly what the system looked like before the change), executes the operation, and writes an immutable record to the activity log. You see the outcome plus a rollback option.

> *"Undo that"* → agent calls `rollback_op op_id=...`. The dispatcher reads the record, runs the inverse, writes a NEW rollback record. Forward-only history; nothing edits past entries.

Both records show up in the per-node `ACTIVITY.md` document so you have a human-readable audit trail.

## Risk classes and rollback

Every operation in a profile is tagged with a risk class. See the table in **Trust state** above for what auto-applies at each tier. Summary:

- **low** — read-only or fully reversible writes (block a domain, list blocklists, query status).
- **medium** — restarts, reloads, config changes with a defined inverse.
- **high** — destructive or unrecoverable.

The runtime *automatically escalates* risk to `high` when no rollback path can be captured. The LLM can't lie about reversibility — declared `low` on an operation with no inverse becomes `high` at execution time.

For each op, two rollback layers can apply:

| Layer | What it captures | When |
|---|---|---|
| **Surgical** (default) | The exact state the operation was about to change (HTTP response, file bytes, etc.) | Every write op |
| **Host snapshot** (sledgehammer) | The whole guest — disk, processes, memory at quiesce | High-risk ops on snapshot-capable substrates |

Surgical is fast and narrow — it's what you use for "undo my last block-domain command." Host snapshot is heavier, but recovers from things the surgical layer didn't track (database mid-write, kernel panic, half-installed package). To use it: `rollback_op op_id=... host_level=true`.

## Host snapshots: which setups are covered?

Host snapshots require *something* underneath the OS that can take them. The `node_set_parent_host` tool wires a node to its substrate:

| Setup | `parent_host.type` | Auto-rollback? |
|---|---|---|
| Proxmox LXC | `proxmox` (kind: lxc) | ✅ Atomic |
| Proxmox VM | `proxmox` (kind: qemu) | ✅ Atomic. Optional `vmstate:true` snapshots RAM too — slower/larger but lossless restore. Worth it for Home Assistant, MQTT brokers, anything with mid-execution state in RAM. |
| TrueNAS / ZFS-on-Linux root | `zfs` | ✅ Atomic |
| Btrfs root (openSUSE/NixOS/Pop!_OS, some NAS firmware) | `btrfs` | ⚠️ Snapshot taken automatically; rollback returns the manual recovery command rather than auto-applying. (Btrfs subvolume swaps need unmount/reboot — not safe to do without a human.) |
| **Plain ext4** (Pi OS, default Raspberry Pi, most generic Linux installs) | **none — no host snapshot possible** | ❌ Surgical rollback only |

This is a filesystem-level limit, not an OE limit. A Raspberry Pi running Pi-hole on Pi OS works perfectly fine — surgical rollback handles every operation the dispatcher does (DNS blocks, config edits, service restarts). You just don't get the "go back in time on the whole machine" insurance for the rare case where something corrupts state in a way the surgical layer didn't capture.

Wiring a host:

> *"This Pi-hole runs in LXC 102 on my Proxmox host. The API token is stored in `proxmox_api_token`."*

Agent calls:
```
node_set_parent_host nodeId='pihole' parent_host={
  type: 'proxmox',
  api_url: 'https://pve01:8006',
  api_token: 'config_field:proxmox_api_token',
  node: 'pve01',
  vmid: 102,
  kind: 'lxc'
}
```

For Home Assistant in a VM, add `vmstate: true` so a rollback brings HA back exactly mid-execution.

## Checks + Incidents

When you mark a profile Approved, OE automatically registers a watcher for each check the profile declares. The watcher polls the check on its declared cadence and tracks state transitions.

When a check goes from healthy to unhealthy, OE opens an **incident**. The troubleshooting loop fires:

1. The matching `diagnostic_recipe` runs automatically — typically a few CLI/HTTP probes that gather context (`systemctl status`, `tail -n 100 /var/log/...`, API status check).
2. The output gets attached to the incident and matched against the profile's catalogued `failure_modes`.
3. If a known failure mode matches, the linked fix is either auto-applied (low-risk + reviewed profile + verified op) or proposed for your confirmation.
4. When the check returns to healthy, the incident closes automatically.

The incident record carries the full timeline: which check fired, what diagnostics were collected, which failure mode matched, what fix was attempted and how it went, when the check recovered. *"What happened with Pi-hole at 2am?"* — `incident_list` shows the answer.

## Health Checks — What They Are

A profile's `health_signals` array declares what "healthy" means for this service. The UI calls these **checks**. Each check is one cheap probe with an expected outcome. Examples from a typical profile:

```jsonc
{
  "kind": "service_up",                                    // free-form label; appears in incidents
  "description": "vaultwarden.service should be active.",
  "check": {
    "mechanism": "cli",                                    // cli or http (only those two)
    "command": "systemctl is-active vaultwarden.service"
  },
  "expect": { "contains": "active" },                      // body-string match
  "cadence_sec": 60,                                       // poll every minute
  "severity": "critical"                                   // critical | warn
},
{
  "kind": "api_ok",
  "check": {
    "mechanism": "http",
    "url": "${endpoint}/alive"                             // ${endpoint} comes from profile.endpoint
  },
  "expect": { "status": 200 },                             // HTTP status-code match
  "cadence_sec": 300,
  "severity": "critical"
},
{
  "kind": "port_listening",
  "check": {
    "mechanism": "cli",
    "command": "ss -ltn | grep -q ':8000 ' && echo listening"
  },
  "expect": { "contains": "listening" },
  "cadence_sec": 300,
  "severity": "warn"
}
```

### Mechanisms

- `cli` — runs the command on the node via the existing oe-node-agent connection. Stdout is matched against `expect`. Exit code != 0 marks the check unhealthy regardless of the body.
- `http` — fetches the URL from the OE server (not from the node!). For services not exposed externally, point the URL at the node's IP on your LAN: `http://192.0.2.10:8000/alive`.

> **Watch out:** tools like `nginx -t`, `apache2ctl configtest`, `pg_isready` write to *stderr*. Append `2>&1` to your CLI command so the matcher sees their output.

### Match shapes (`expect`)

The matcher recognises these keys:

| Key | What it does | Example |
|---|---|---|
| `contains` | substring match against output (CLI) or body (HTTP) | `{ "contains": "active" }` |
| `matches` | regex test against output/body | `{ "matches": "^v[0-9]+\\." }` |
| `eq` / `neq` | strict equality (string) | `{ "eq": "enabled" }` |
| `gt` / `gte` / `lt` / `lte` | numeric comparison | `{ "lt": 90 }` (e.g. disk-percent) |
| `status` | **HTTP only** — compares against the response status code | `{ "status": 200 }` |

If your HTTP check needs to assert against the body (not just the status), drop the `status` key and use `contains`/`matches`/`eq` against `parse_jsonpath` output.

### Cadence + severity guidance

- `service_up` / `process_up` → 60s, critical
- HTTP API health → 300s, critical (don't hammer with 60s polls)
- Disk free / memory / load → 60–300s, warn (transient spikes are normal)
- Config-validity (`nginx -t 2>&1`) → 300s, warn

`critical` checks open incidents and trigger the troubleshooting loop. `warn` checks just transition state and surface in the UI badge — no incident, no recipe.

## Debugging a Failing Check

If a profile shows "1 failing" in the nodes drawer, here's the workflow:

1. **Find which check it is.** Open the profile's row in the nodes drawer and click through, or ask your agent: *"What check is failing on `vaultwardenTrixie`'s vaultwarden profile?"* The watcher state surfaces `last_state: 'unhealthy'` for the affected check.

2. **Reproduce the check by hand.** Run the same command/URL the check is using:

   ```bash
   # CLI check — run on the node itself
   ssh node 'systemctl is-active vaultwarden.service'

   # HTTP check — run from the OE server (where the watcher lives)
   curl -i http://192.0.2.10:8000/alive
   ```

   If your manual probe disagrees with what the watcher says, the check config is wrong (bad URL, wrong unit name, missing `2>&1`, wrong `expect` shape). If they agree, the service is actually unhealthy — proceed to step 3.

3. **Check the open incident.** *"Show me the open incident for vaultwardenTrixie."* The incident record carries the diagnostic output the troubleshooter collected when the check first fired. Often that's enough to see the cause.

   ```bash
   # On the OE server, raw incident files:
   ls users/<you>/nodes/<nodeId>/incidents/
   cat users/<you>/nodes/<nodeId>/incidents/inc_<id>.json | jq .
   ```

4. **If you've fixed it manually, force a recheck.** The watcher will recover on its next tick (within `cadence_sec`). To force it sooner, toggle the automation level — *"set vaultwarden to Draft, then back to Approved"* — which tears down and re-registers the watchers in-process.

5. **If the check is misconfigured**, patch it instead of re-saving the whole profile:

   > *"Patch the api_ok check on vaultwarden — the expect should be `status: 200`, not `contains: 'OK'`."*

   Behind the scenes: `profile_patch` with `[{op:'set', path:'health_signals[1].expect', value:{status:200}}]`. Watchers auto-refresh when checks on an Approved or Auto-fix profile are patched, so the new check goes live immediately.

### Useful commands while troubleshooting

| What you want | Command |
|---|---|
| Is the service running? | `systemctl is-active <unit>` |
| What is it logging? | `journalctl -fu <unit> -n 100` |
| Is the port listening? | `ss -ltn \| grep ':<port> '` |
| Is the API responding? | `curl -i <url>` |
| Recent incidents on this node | `ls users/<you>/nodes/<nodeId>/incidents/` |
| Live watcher state | `cat users/<you>/watchers.json \| jq '.active[] \| select(.label \| contains("<service>"))'` |
| Last-known-good snapshot of an op | `ls users/<you>/nodes/<nodeId>/snapshots/<YYYY-MM-DD>/` |

> Don't edit `users/<you>/watchers.json` while the server is running — the supervisor's tick will overwrite your changes. Use `profile_patch` to mutate checks, or stop OE first.

## Sharing profiles

Because profiles are plain JSON + Markdown files, you can share them. Save a Pi-hole profile that works for you, hand the JSON to someone else, they paste it through `profile_save` and they're done — they still need to verify, review, and wire their own auth token, but they don't have to redo the research.

Future versions of OE will surface a community profile registry; for now, copy-paste is fine.

## Where things live on disk

```
users/<you>/nodes/<nodeId>/
  profiles/<service>.json        # the schema
  profiles/<service>.md          # human-readable rendering
  profiles/<service>.research.md # research transcript with sources
  activity.jsonl                 # append-only operation records
  ACTIVITY.md                    # rendered table view
  snapshots/<YYYY-MM-DD>/...     # pre-state captures (30-day retention by default)
  incidents/<incident_id>.json   # one file per incident
```

All plain text, all editable, all under your control. The whole thing survives a server restart.
