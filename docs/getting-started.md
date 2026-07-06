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
docker run -p 3737:3737 -v oe-data:/app/users openensemble
```

## First run

1. Open `http://<your-server-ip>:3737`.
2. Create the owner account, or restore an existing backup.
3. Connect one provider in **Settings → Providers**.
4. Create a coordinator or specialist agent and send a message.

Everything else — email, calendar, MCP servers, remote nodes, voice devices,
tunnels, and backups — can be added later.

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
