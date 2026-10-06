---
title: Getting started
nav_order: 2
description: >-
  Install OpenEnsemble on your own server: one install script, a web UI on
  HTTPS setup, and a first assistant reply.
---

# Getting started

## Requirements

- Linux (tested on Debian-family LXCs and VMs); macOS works for local dev
- Node.js ≥ 22.12 (the installer pulls one via `nvm` if missing)
- `build-essential`, Python ≥ 3.7 (`python3` and `python3-full`), `zip`, `bubblewrap`, `git`,
  `ffmpeg`, `openssl` — the installer offers to install them

## Install

```bash
git clone --depth 1 https://github.com/openensemble/openensemble.git
cd openensemble
./install.sh
```

A shallow clone downloads the current revision and supports in-app updates.
Omit `--depth 1` if you need the full development history.

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

Copy the first-run credential printed by the installer, then follow
[Getting started]({{ site.baseurl }}/guide/getting-started/). That walkthrough
covers owner creation, connecting a chat provider, creating your single
assistant, and testing its first reply. Run `oe bootstrap` on a host install
if you lose the credential before setup is complete.

Use HTTPS on port **3739** from another computer. Plain HTTP first-run setup
is restricted to a browser on the OE host at `http://localhost:3737`.

## After your first reply

- [Choose providers]({{ site.baseurl }}/guide/providers/) and
  [understand the model choices]({{ site.baseurl }}/guide/models-explained/).
- [Add an agent ensemble]({{ site.baseurl }}/guide/single-assistant/) when you need specialists.
- [Back up and update]({{ site.baseurl }}/guide/backup-update/) before relying on the installation.
- [Troubleshoot setup]({{ site.baseurl }}/guide/troubleshooting/) if a step fails.

[Browse the complete user guide]({{ site.baseurl }}/guide/).
