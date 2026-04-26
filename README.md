# OpenEnsemble

Self-hosted, multi-user AI assistant platform. Run a team of specialist agents and choose which LLM providers they use.

OpenEnsemble is a single Node.js server that serves a web UI on port 3737. Sign in, pick an agent, and start a conversation — or let the coordinator agent dispatch your message to whichever specialist is the right fit (coder, email, research, calendar, expenses, image gen, etc.). Every user gets their own isolated workspace, agents, skills, and data.

<img width="939" height="463" alt="dashboard" src="https://github.com/user-attachments/assets/47256c92-2e5a-4bad-938c-0190919ae824" />
<img width="556" height="634" alt="agentlist" src="https://github.com/user-attachments/assets/1852cbe2-859b-4ebd-ba71-304e900e3884" />

## What it does

**Multi-agent chat.** A roster of specialist agents each tuned for a role. The Coordinator reads incoming messages and delegates to the right specialist, or you can talk to one directly.

**Bring your own LLMs.** Providers include Anthropic, OpenAI (API key or ChatGPT-login/OAuth), Grok, Gemini, DeepSeek, Mistral, Groq, Together, Perplexity, Fireworks, OpenRouter, Z.ai, Ollama, and LM Studio. Enable what you want; assign different models per agent. A built-in fallback provider kicks in if your primary is down.

**Skills.** Capabilities agents can use, each defined by a small manifest:

| Skill | What the agent can do |
|---|---|
| `coder` | Edit files and run shell commands inside a bubblewrap sandbox; manage multi-file projects |
| `coordinator` | Delegate incoming messages to specialist agents |
| `deep_research` | Multi-step web research saved as persistent research documents |
| `email` | Unified Gmail / Microsoft-Exchange / IMAP mailbox access |
| `expenses` | Parse receipts, invoices, bank statements; track spending across groups |
| `gcal` | View and manage Google Calendar events |
| `image_generator` | Text-to-image via Fireworks Flux |
| `nodes` | Run commands and transfer files to remote machines via the OE node agent |
| `role_tutor` | Adaptive tutor that tracks per-subject progress and mastery |
| `role_video_generator` | Text-to-video generation |
| `shared-docs` | Read uploaded documents, photos, and videos |
| `skill-builder` | Create and edit custom skills at runtime |
| `tasks` | Schedule recurring and one-time agent tasks |
| `web` | Brave Search and URL fetch |

Users can also install **plugins** (drop-in skills + UI drawers, e.g. `markets`, `news`, `tutor-today`) and extend with **user-scoped skills** kept in their own directory.

**Roles.** Swap the persona/prompt on any agent without rebuilding it — role instructions live on the role, not the agent, so the coordinator can reassign roles cleanly.

**Cortex — private reasoning & embeddings.** Bundled local models run in-process via `node-llama-cpp`: a reasoning model (`openensemble-reason-v1`, SmolLM2-based GGUF) and `nomic-embed-text-v1` embeddings. No external call required for retrieval, summarization, or classification.

**Desktop & documents drawer.** A unified view of everything the user has: uploaded docs, AI-generated images, AI-generated videos, research reports, files shared from other users, and code projects — each with its own tab. Code projects are downloadable as zip archives.

**Remote nodes.** Pair a machine with the server using a one-time code; the `oe-node-agent` then accepts exec and file-transfer commands scoped to that user. Useful for driving a homelab, a Raspberry Pi, or a workshop rig from the web UI.

**Expenses.** Groups, books, receipt parsing, and per-user / per-group activity.

**Background scheduler.** Cron-like recurring tasks. Custom built LLM to set and parse tasks. (e.g. a daily news briefing, a nightly uploads-folder cleanup) plus one-shot tasks an agent schedules for itself.

**Per-user everything.** Agents, custom skills, sessions, chat history, uploads, AI outputs, code projects, and settings are all stored under `users/{userId}/` — a fresh install with multiple accounts is fully isolated.

**Backup / restore.** Compressed `tar.gz` snapshots of the entire install; restore works from the first-run screen too, so a fresh box can pull in an existing user base in one step.

## Requirements

- Linux (tested on Debian-family LXCs and VMs); macOS works for local dev
- Node.js ≥ 18 (the installer pulls one via `nvm` if missing)
- `build-essential`, `python3`, `zip`, `bubblewrap`, `git` (installer offers to install them — `git` is required for in-app auto-update; if you grabbed the source as a zip instead of cloning, install `git` and run `git clone` over the install dir or auto-update will be disabled)

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
5. Optionally registers a systemd user service so OE comes up at boot

Then open **http://{ip}:3737** and walk through first-run setup.

For a clean Docker deployment:

```bash
docker build -t openensemble .
docker run -p 3737:3737 -v oe-data:/app/users openensemble
```

## Configuring LLM providers

Providers start disabled. Enable them from the web UI under Settings → Providers, or by editing `config.json`:

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

Environment variables override config values: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIREWORKS_API_KEY`, `GROK_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY`, `OE_SESSION_EXPIRY`, `OE_VISION_PROVIDER`, `OE_VISION_MODEL`.

## Auto-update

Admin users see an "Update available" badge in the status bar and can apply updates from **Settings → System → Software Update** without dropping to a terminal. The server polls the configured git remote (default `origin`) every hour, fast-forwards the working tree on demand, runs `npm install` if `package.json` changed, then restarts itself using the same detached-respawn mechanism as the manual Restart button.

Tunable in `config.json`:

| Key | Default | Purpose |
|---|---|---|
| `updateCheckEnabled` | `true` | Master switch for periodic polling |
| `updateCheckIntervalMs` | `3600000` | Poll interval (ms) — minimum 60000 |
| `updateRemote` | `'origin'` | Git remote to follow |

The flow refuses to update when the working tree is dirty or has unpushed commits — it will never `git stash` or `git reset --hard`. Resolve those manually with `git status` first.

> **Trust note:** auto-update means anyone with push access to the configured `updateRemote` can ship code that runs on every install. If you don't fully trust the upstream, fork the repo and set `updateRemote` to your fork.

## Security model

- **Session tokens** live in the `Authorization: Bearer` header — never in URLs (URLs leak via Referer and access logs).
- **Media tokens** are short-lived (10 min) URL-embedded tokens minted on demand, so `<img>` / `<video>` / `<iframe>` elements can authenticate. Downloads that can't use fetch use these.
- **Coder shell sandbox** wraps every shell command with `bubblewrap`, giving the agent a read-only view of the system plus a writable bind-mount of just its own project directory. Network stays open (needed for npm / pip / git).
- **Role-based access**: `owner`, `admin`, `user` — plus per-user access schedules that can block logins outside chosen hours.
- **File-ownership enforcement**: every path going to shell / download / delete is `realpath`-checked against the caller's workspace before use, so symlinks can't escape.

## Directory layout

```
agents/                 default agent definitions
drawers/                built-in UI drawers (loaded alongside plugin drawers)
plugins/                bundled plugins (markets, news, tutor-today)
public/                 static front-end (HTML, CSS, JS)
routes/                 HTTP route modules
skills/                 built-in skills and SKILL_BLUEPRINT.md
users/                  per-user state (created on first run; ignored by git)
config.template.json    template copied to config.json on install
server.mjs              entry point
```

## Development

```bash
npm start                 # run the server (auto-rebuilds styles on boot)
npm test                  # vitest
npm run test:watch        # vitest --watch
```

Hot tips:

- The server restart wipes in-memory state: pairing codes, chat streams, pending node commands, and media tokens. Batch edits rather than restart-per-change when possible.
- Tests must import `BASE_DIR` from `lib/paths.mjs`; derive-your-own paths break isolation.
- User-scoped skills live in `users/{id}/skills/` in parallel with the global `skills/`. When wiring up a skill, check global, user-scope, and `plugins/`.

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). In plain English:

- **Allowed:** running OpenEnsemble yourself, modifying it, and sharing your modifications — for personal, hobby, research, educational, nonprofit, or government use.
- **Not allowed:** any commercial use. This explicitly includes selling the code, selling a modified version, offering it as a paid service, or bundling it into a paid product.
- **Required:** anyone you share the code (or a modification) with must also receive this license and the `Required Notice:` attribution line from the top of `LICENSE`. You can't strip the attribution and redistribute it as your own work.

See `LICENSE` for the full text. Commercial use requires a separate written license from the author.
