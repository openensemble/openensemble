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
- **List** — list connected nodes, with hostname and OS.

Each node command is scoped to the user who paired it. A user can't reach into another user's nodes.

## Useful patterns

- **"Keep this server up to date"** — schedule a weekly task that runs `apt update && apt upgrade -y` on the node and reports any kernel reboots needed.
- **"Install X on my Pi"** — your coder/coordinator pushes a setup script and runs it.
- **"Tail the logs of foo on my server"** — exec `journalctl -fu foo` and stream the result back.
- **"Reboot the workshop machine"** — `sudo reboot` (you allowed this, right?).

## Security & trust

`oe-node-agent` opens a persistent connection from the *node* to the *server* — not the other way around. So your nodes can be on a NAT or a different LAN as long as they can reach the server.

Once paired, anything the server-side user can ask, the node will run. Pair only machines you trust the user with.

## Removing a node

Nodes drawer → hover the node → trash icon. The agent on the node is deactivated; if you want to fully uninstall, also `systemctl disable --now oe-node-agent` on the machine itself.
