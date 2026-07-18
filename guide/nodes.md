# Remote nodes

A **node** is a remote machine paired with this OpenEnsemble install. Once paired, your agents can run shell commands and transfer files on it — driving a homelab box, a Pi, a workshop rig, or any Linux/macOS machine reachable over the network.

> Throughout this app, **"node" always means a paired oe-node-agent machine**. It does not mean your laptop where the browser is open.

## Pairing a node

1. Open the **Nodes** drawer (sidebar server icon).
2. Click **Pair New Node**. The server generates a one-time pairing code (valid for ~10 minutes).
3. SSH into the machine you want to pair and run the install snippet shown — it downloads `oe-node-agent`, registers it as a service, and connects it to your install using the pairing code.
4. The new node appears in the drawer with its hostname, OS, and "online" status.

The pairing code dies when the server restarts, so finish step 3 in the same session you started step 2.

Pairing only connects the machine. It does not automatically turn every app on that machine into a managed service. After a node appears, click **Onboard** beside **Node checks** or **Managed services** on that node card to walk through Host health and service setup.

## Reading the node card

The top of each card describes the remote machine itself:

- **Connected / Recovered / Not Responding / Offline** - the oe-node-agent tunnel state.
- **Access level** - what administrative actions this node allows. **Full Access** can run privileged commands; a lock means access changes must be made from SSH on the node.
- **Agent version** - the installed oe-node-agent version. Use **Upgrade Agent** when OE shows it is outdated.
- **Quick actions** - Terminal, Status, Update, Restart, Shut Down, Install, Upgrade Agent, and Remove all act on the remote machine named in that card.

The lower part separates two different kinds of monitoring:

- **Node checks / Host health** is created automatically. It covers generic host health such as disk, load, memory, and the agent service.
- **Managed services** are service profiles that were researched and verified separately, such as Tailscale, Vaultwarden, Pi-hole, nginx, or Home Assistant.

Automation labels mean:

- **Draft** - monitoring and auto-fix are off.
- **Approved** - monitoring is on; verified low-risk fixes may auto-apply.
- **Auto-fix** - verified medium-risk fixes may auto-apply too. High-risk changes still require confirmation.

New nodes start Host health in **Draft**. Click **Onboard** beside **Node checks**, then approve Host health to run the built-in read-only diagnostics and start monitoring. After that passes, OE asks whether you want to go further and enable **Auto-fix** for verified medium-risk host fixes.

The same progression applies to services under **Managed services**:

1. Use **Onboard** beside **Managed services** to detect running services.
2. Ask the agent to create service profiles for the detected services. The agent researches each service, saves a Draft profile, verifies read-only operations, then shows it for review.
3. Click **Approve** on a Draft service profile after it looks right.
4. Enable **Auto-fix** from the onboarding flow only when you want verified medium-risk fixes for that service to run automatically.

## What agents can do with a node

Through the `nodes` skill:

- **Exec** — run a shell command, get stdout/stderr back.
- **Push tar** — upload a tarball from the install to the node and extract it.
- **Pull tar** — pull a directory off the node back to the install.
- **Read file** — read a file from a node, gated by a per-node allowlist (see below).
- **List** — list connected nodes, with hostname and OS.
- **Detect services** — `node_detect_services` runs a single probe (ports + binaries + paths + systemd units) and tells you what known services are running. Use before onboarding so the agent knows what to research.
- **Wire to a hypervisor** — `node_set_parent_host` connects a node to its Proxmox host, ZFS dataset, or Btrfs subvolume so high-risk operations get a whole-system snapshot before running. See the **Service profiles** page for the substrate matrix.

Each node command is scoped to the user who paired it. A user can't reach into another user's nodes.

## Reading files from a node

`node_read_file` is a separate, lower-privilege path from `node_exec`. Each node has a `readableFolders` list — an allowlist of absolute path prefixes the OE server will let agents read from. Configure it via your agent: *"set the readable folders on `homenode` to `/home/alex/Documents` and `/home/alex/Downloads`"* triggers the `node_set_readable_folders` tool. After that, *"summarise `/home/alex/Documents/lease.pdf` from `homenode`"* just works.

How it's gated:

- Path must be inside one of the node's `readableFolders` prefixes — otherwise the request is rejected at the OE server before it ever reaches the agent on the node.
- `node_exec` does **not** respect this allowlist by design. Exec is a higher-privilege tool meant for system administration; it can read anything the agent on that node can read. The split lets you give an agent file-read access to a specific folder without giving it general shell access.
- The allowlist persists across reconnects (lives in `nodes.json`, not in the agent's local state) — re-pair a machine and your existing folder allowlist is preserved.

Use case: emailing yourself a doc that lives on a different machine. Pair the machine, allowlist the folder, then ask any agent: *"email me /home/alex/Documents/foo.pdf from homenode."* The Read flow fetches the file under the allowlist, the email skill attaches it.

For a server install (OE running on a Pi or NAS away from your daily-driver machines), this is the only way agents can reach files on those machines. There's no shared filesystem assumption.

## Useful patterns

- **"Keep this server up to date"** — schedule a weekly task that runs `apt update && apt upgrade -y` on the node and reports any kernel reboots needed.
- **"Install X on my Pi"** — your coder/coordinator pushes a setup script and runs it.
- **"Tail the logs of foo on my server"** — exec `journalctl -fu foo` and stream the result back.
- **"Reboot the workshop machine"** — `sudo reboot` (you allowed this, right?).

## Going beyond exec — managing services on a node

`node_exec` is the right tool for one-off shell commands. For ongoing management of a *service* running on a node — Pi-hole, Home Assistant, nginx, MariaDB, etc. — use **service profiles**. They give you researched runbooks, automatic rollback, health monitoring, and incident tracking on top of the raw exec layer. See the **Service profiles** page.

## Checking node + service health

Each row in the Nodes drawer shows two things:

- **The node itself** — green/red dot for the WS connection (the oe-node-agent → server tunnel).
- **Checks and managed services** — baseline node checks are grouped separately from service profiles.

A profile row like:

> `vaultwarden v1.35.6 — Approved — 3 checks · 2 ok · 1 failing · 6/6 actions tested`

means: monitoring is on for that service, 3 checks define what healthy means, 2 are passing right now, 1 is failing, and OE has successfully tested all 6 actions at least once.

The **Node checks** row is auto-created on every node and tracks generic host health: disk free, load, memory, and the oe-node-agent itself. It starts as Draft on new nodes. Use **Onboard** beside the Node checks header to verify the built-in diagnostics and approve monitoring.

To investigate a "1 failing" badge, see the **Debugging a failing check** section in the **Service profiles** page.

### Quick health commands

| What you want | Command |
|---|---|
| List paired nodes + connection state | Ask your agent: *"list nodes"* (`node_list`) |
| Force a status refresh on one node | Status icon in the drawer, or *"check status of `<node>`"* |
| See system stats from a node | *"what's the disk and memory on `<node>`?"* — runs `df -h` + `free -h` via `node_exec` |
| Check a specific service is up | *"is vaultwarden running on `<node>`?"* — runs `systemctl is-active …` |
| Tail a service's log | *"tail nginx logs on `<node>`"* — `journalctl -fu nginx -n 100` |

## Security & trust

`oe-node-agent` opens a persistent connection from the *node* to the *server* — not the other way around. So your nodes can be on a NAT or a different LAN as long as they can reach the server.

Once paired, anything the server-side user can ask, the node will run. Pair only machines you trust the user with.

## Removing a node

Nodes drawer → hover the node → trash icon (confirm). That:

- tells a connected agent to uninstall itself (best-effort if offline);
- revokes the registration so it cannot reconnect on its own;
- cancels that node's service health watches; and
- deletes local profile data under `users/<you>/nodes/<nodeId>/` (profiles, incidents, activity, snapshots).

If you want to fully wipe the agent package on the machine as well, also run `systemctl disable --now oe-node-agent` there when it is still reachable.
