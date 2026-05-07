# Remote nodes

A **node** is a remote machine paired with this OpenEnsemble install. Once paired, your agents can run shell commands and transfer files on it — driving a homelab box, a Pi, a workshop rig, or any Linux/macOS machine reachable over the network.

> Throughout this app, **"node" always means a paired oe-node-agent machine**. It does not mean your laptop where the browser is open.

## Pairing a node

1. Open the **Nodes** drawer (sidebar server icon).
2. Click **+ Add Node**. The server generates a one-time pairing code (valid for ~10 minutes).
3. SSH into the machine you want to pair and run the install snippet shown — it downloads `oe-node-agent`, registers it as a service, and connects it to your install using the pairing code.
4. The new node appears in the drawer with its hostname, OS, and "online" status.

The pairing code dies when the server restarts, so finish step 3 in the same session you started step 2.

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

`node_read_file` is a separate, lower-privilege path from `node_exec`. Each node has a `readableFolders` list — an allowlist of absolute path prefixes the OE server will let agents read from. Configure it via your agent: *"set the readable folders on `homenode` to `/home/shawn/Documents` and `/home/shawn/Downloads`"* triggers the `node_set_readable_folders` tool. After that, *"summarise `/home/shawn/Documents/lease.pdf` from `homenode`"* just works.

How it's gated:

- Path must be inside one of the node's `readableFolders` prefixes — otherwise the request is rejected at the OE server before it ever reaches the agent on the node.
- `node_exec` does **not** respect this allowlist by design. Exec is a higher-privilege tool meant for system administration; it can read anything the agent on that node can read. The split lets you give an agent file-read access to a specific folder without giving it general shell access.
- The allowlist persists across reconnects (lives in `nodes.json`, not in the agent's local state) — re-pair a machine and your existing folder allowlist is preserved.

Use case: emailing yourself a doc that lives on a different machine. Pair the machine, allowlist the folder, then ask any agent: *"email me /home/shawn/Documents/foo.pdf from homenode."* The Read flow fetches the file under the allowlist, the email skill attaches it.

For a server install (OE running on a Pi or NAS away from your daily-driver machines), this is the only way agents can reach files on those machines. There's no shared filesystem assumption.

## Useful patterns

- **"Keep this server up to date"** — schedule a weekly task that runs `apt update && apt upgrade -y` on the node and reports any kernel reboots needed.
- **"Install X on my Pi"** — your coder/coordinator pushes a setup script and runs it.
- **"Tail the logs of foo on my server"** — exec `journalctl -fu foo` and stream the result back.
- **"Reboot the workshop machine"** — `sudo reboot` (you allowed this, right?).

## Going beyond exec — managing services on a node

`node_exec` is the right tool for one-off shell commands. For ongoing management of a *service* running on a node — Pi-hole, Home Assistant, nginx, MariaDB, etc. — use **service profiles**. They give you researched runbooks, automatic rollback, health monitoring, and incident tracking on top of the raw exec layer. See the **Service profiles** page.

## Security & trust

`oe-node-agent` opens a persistent connection from the *node* to the *server* — not the other way around. So your nodes can be on a NAT or a different LAN as long as they can reach the server.

Once paired, anything the server-side user can ask, the node will run. Pair only machines you trust the user with.

## Removing a node

Nodes drawer → hover the node → trash icon. The agent on the node is deactivated; if you want to fully uninstall, also `systemctl disable --now oe-node-agent` on the machine itself.
