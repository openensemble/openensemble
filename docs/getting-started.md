---
title: Getting started
nav_order: 2
description: >-
  Install OpenEnsemble on your own server: one install script, a web UI on
  port 3737, and your first agent replying in minutes.
---

# Getting started

## Requirements

- Linux (tested on Debian-family LXCs and VMs); macOS works for local dev
- Node.js ≥ 18 (the installer pulls one via `nvm` if missing)
- `build-essential`, `python3`, `python3-full`, `zip`, `bubblewrap`, `git`,
  `ffmpeg`, `openssl` — the installer offers to install them

## Install

```bash
git clone https://github.com/openensemble/openensemble.git
cd openensemble
./install.sh
```

The installer:

1. Checks for build tools and offers to install them
2. Installs Node.js via `nvm` if needed
3. Runs `npm install`
4. Writes a default `config.json` (providers all disabled)
5. Optionally registers a systemd user service so OpenEnsemble comes up at boot

For a clean Docker deployment instead:

```bash
docker build -t openensemble .
docker run -d --name openensemble \
  -p 3737:3737 -p 3739:3739 \
  --add-host host.docker.internal:host-gateway \
  -v oe-data:/app/users -v oe-state:/app/docker-data \
  -v oe-plugins:/app/plugins -v oe-tls:/app/tls \
  openensemble
docker exec openensemble node scripts/first-run-bootstrap.mjs
```

The final command prints the one-time first-run credential. Open
`https://localhost:3739` (or substitute the Docker host's address), accept the
self-signed certificate warning, and enter the credential. The named volumes
persist profiles, plugins, runtime state/configuration, and the generated TLS
key.

The image supports the web application, remote model/STT/TTS providers, media
conversion, and manually addressed nodes and voice devices. The host-oriented
local Piper/Faster-Whisper installers use systemd user services and therefore
do not run inside this single container. Docker bridge networking also does not
forward OE's LAN discovery broadcasts; enter the container host's address on a
device, or use host networking on Linux after reviewing the exposed ports.
For Ollama running on the Docker host, set the Ollama URL in OpenEnsemble
Settings to `http://host.docker.internal:11434` (the example run command and
Compose file provide that hostname). Sandboxed coder shell commands and custom
skill subprocesses are unavailable under Docker's default security profile.
Nested sandboxing requires an operator-supplied security profile; do not use an
unrestricted privileged container as a shortcut.

## First run

1. Copy the one-time credential printed by `install.sh` (or by the Docker
   command above). On a host install, `oe bootstrap` recovers it locally before
   setup is complete.
2. Open `https://<your-server-ip>:3739` and accept the self-signed certificate
   warning. Plain HTTP setup is restricted to a browser running directly on
   the host at `http://localhost:3737`.
3. Create the owner account, or restore an existing backup, using the credential.
4. Connect one provider in **Settings → Providers**.
5. Create your first assistant and send a message. New accounts use one
   primary assistant by default; existing upgraded accounts keep their agent
   ensemble unless they choose to switch.

Everything else — email, calendar, MCP servers, remote nodes, voice devices,
tunnels, and backups — can be added later.

See [Single assistant and ensembles]({{ site.baseurl }}/single-agent-mode) for
mode switching, preserved agents and memory, and the rollout/rollback runbook.

## Configuring LLM providers

Providers start disabled. Enable them from the web UI under
**Settings → Providers**, or by editing `config.json`:

```jsonc
{
  "enabledProviders": { "anthropic": true, "openai": true, "ollama": true },
  "anthropicApiKey": "sk-ant-…",
  "openrouterApiKey": "sk-or-…",
  "cortex": {
    "reasonProvider": "auto",     // built-in, ollama, or lmstudio
    "lmstudioUrl": "http://127.0.0.1:1234"
  }
}
```

Environment variables override config values: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIREWORKS_API_KEY`, `GROK_API_KEY`,
`OPENROUTER_API_KEY`, `OLLAMA_API_KEY`.

## Staying up to date

Admin users see an "Update available" badge in the status bar and can apply
updates from **Settings → System → Software Update**. The server polls the
configured git remote hourly and fast-forwards on demand — it never
`git stash`es or `git reset --hard`s a dirty tree.
