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
5. **Review.** *"Show me the profile."* — agent calls `profile_load render:true` and surfaces the rendered Markdown. You see what operations were defined, what risk class each got, what health signals will be monitored, what failure modes are catalogued, and where the LLM got the info.
6. **Approve.** *"Looks good, approve it."* — agent calls `profile_set_trust_state state:'reviewed'`. **This automatically starts the health watchers** for the profile's defined signals; you don't have to wire monitoring separately.

The output gets saved as plain files under `users/<you>/nodes/<nodeId>/profiles/<service>.{json,md,research.md}` so you can read them in a text editor, git-track them, share them with someone else's OE install, etc.

## Trust state

Every profile has a trust state that gates what can auto-fire:

- **`unverified`** (default for newly-saved drafts) — every write operation requires your explicit confirmation per call. The agent can still run things, but you stay in the loop on each one.
- **`reviewed`** — you've eyeballed the profile and approved it. Low-risk + verified write operations can auto-fire. Health watchers run.
- **`proven`** — reserved for after a profile has accumulated successful operation history. Same auto-fire rules as reviewed; an extra signal of confidence.

Going *back* to `unverified` (e.g. "I want to make changes — disable monitoring temporarily") tears down the watchers. The state always reflects what's actually happening.

## Operating a service

Once a profile is reviewed, your agent calls operations through `dispatch_op`:

> *"Block ads on doubleclick.net"* → agent calls `dispatch_op opId='dns_block' parameters={domain:'doubleclick.net'}`.

The dispatcher: looks up the operation in the profile, substitutes parameters into the call template, takes a pre-state snapshot (saving exactly what the system looked like before the change), executes the operation, and writes an immutable record to the activity log. You see the outcome plus a rollback option.

> *"Undo that"* → agent calls `rollback_op op_id=...`. The dispatcher reads the record, runs the inverse, writes a NEW rollback record. Forward-only history; nothing edits past entries.

Both records show up in the per-node `ACTIVITY.md` document so you have a human-readable audit trail.

## Risk classes and rollback

Every operation in a profile is tagged with a risk class:

- **low** — read-only or fully reversible writes (block a domain, list blocklists, query status). Auto-fires from `reviewed` profiles.
- **medium** — restarts, reloads, config changes with a defined inverse. Always asks for confirmation.
- **high** — destructive or unrecoverable. Always asks; never auto-fires.

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

## Health monitoring + incidents

When you mark a profile `reviewed`, OE automatically registers a watcher for each `health_signals` entry the profile declares. The watcher polls the check on its declared cadence and tracks state transitions.

When a signal goes from healthy to unhealthy, OE opens an **incident**. The troubleshooting loop fires:

1. The matching `diagnostic_recipe` runs automatically — typically a few CLI/HTTP probes that gather context (`systemctl status`, `tail -n 100 /var/log/...`, API status check).
2. The output gets attached to the incident and matched against the profile's catalogued `failure_modes`.
3. If a known failure mode matches, the linked fix is either auto-applied (low-risk + reviewed profile + verified op) or proposed for your confirmation.
4. When the health signal returns to healthy, the incident closes automatically.

The incident record carries the full timeline: which signal fired, what diagnostics were collected, which failure mode matched, what fix was attempted and how it went, when the signal recovered. *"What happened with Pi-hole at 2am?"* — `incident_list` shows the answer.

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
