# Skills

A **skill** is a tool an agent can use during a chat. Skills are how agents *do* anything beyond talking — search the web, edit files, send email, run a command on a remote machine.

## How skills work

Each skill is a small folder with:
- a `manifest.json` — name, description, the tool calls it exposes, which roles it ships with by default
- an `execute.mjs` — the JS that runs when the agent calls one of the tools
- optional `rules.md` — extra system-prompt rules injected when the skill is enabled

OpenEnsemble ships with a curated set under `skills/`, and each user can have their own private skills under `users/{userId}/skills/`.

## Built-in skills

| Skill | What the agent can do |
|---|---|
| `coder` | Edit files and run shell commands inside a bubblewrap sandbox; manage multi-file projects |
| `coordinator` | Delegate incoming messages to specialist agents |
| `deep_research` | Multi-step web research saved as persistent research documents |
| `email` | Unified Gmail / Microsoft Exchange / IMAP mailbox access |
| `expenses` | Parse receipts, invoices, bank statements; track spending across groups |
| `gcal` | View and manage Google Calendar events |
| `image_generator` | Text-to-image generation |
| `nodes` | Run commands and transfer files to remote machines via the OE node agent |
| `role_tutor` | Adaptive tutor with per-subject mastery tracking |
| `role_video_generator` | Text-to-video generation |
| `shared-docs` | Read uploaded documents, photos, and videos |
| `skill-builder` | Create and edit custom skills at runtime |
| `tasks` | Schedule recurring and one-time agent tasks |
| `web` | Brave Search and URL fetch |
| `self-mgmt` | Edit the agent's own memory, name, and prompt |
| `delegate` | Hand work to other agents (used by the Coordinator) |
| `profile_files` | Read user-uploaded profile documents |
| `user-admin` | Manage users (owner/admin only) |
| `logs` | Read server logs (admin only) |
| `utility` | Time, calculator, small helpers |

## Enabling skills on an agent

Roles set sensible defaults — a Coder gets `coder`, `web`, `tasks`; a Researcher gets `deep_research`, `web`, `tasks`. To change which skills a single agent has, open its edit panel → **Tools**.

To change the *default* set for a role across all your agents using that role, edit the role under **Settings → Skills → Roles**.

## Per-skill setup

Some skills need additional configuration before they work:

- **email** — connect at least one mailbox in **Settings → Profile → Connected Accounts**.
- **gcal** — connect Google Calendar in the same place (uses Google OAuth).
- **web** — needs a Brave Search API key in **Settings → Profile → Brave Search API**.
- **image_generator** — needs at least one image-capable provider enabled in **Providers** (Fireworks Flux, xAI Grok image models, OpenAI's image models, etc.). Pick whichever you have a key for; the skill picks up any provider that exposes an image-generation model.
- **nodes** — needs at least one paired node (see **Remote nodes**).
- **shared-docs** — works automatically as soon as you upload anything.

## Custom skills

Anyone can write a skill. The `skill-builder` skill lets an agent author one for you — say "build me a skill that turns a postcode into the local weather forecast" and your coder/coordinator will scaffold it. See **Building custom skills**.
