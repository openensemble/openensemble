# Getting started

This walk-through assumes you've already run `./install.sh` and the server is up at `http://{ip}:3737`.

## 1. Create the owner account

The first time you visit the URL, OpenEnsemble shows a first-run screen. Pick a name, emoji, and password. That account becomes the **owner** — the only role that can manage providers, system settings, the Cloudflare tunnel, and the update channel.

Already have a backup from another install? Use **"Already have an OpenEnsemble backup?"** on the first-run screen to restore it instead of starting empty.

## 2. Connect an LLM provider

Open **Settings → Providers** (sidebar gear icon). Pick a provider you have credentials for — Anthropic, OpenAI, Grok, Gemini, OpenRouter, Groq, Together, DeepSeek, Mistral, Perplexity, Fireworks, Z.ai, Ollama, or LM Studio. Paste the API key, toggle **Enable**, save.

You don't need to pick "the right one" — agents can each use a different provider, and you can swap their model later from the agent panel. See **LLM providers** for guidance on what each one is good at.

If you don't have any cloud keys, the bundled local **Cortex** model handles light reasoning out of the box. You can also point at a local **Ollama** or **LM Studio** to run any open model.

## 3. Create your first agent

Open **Agents** (sidebar bot icon). Click **+ New Agent**. Give it:

- a name and emoji
- a role — pick "Coordinator" if you want a delegating front-door agent, or pick a specialist role like "Researcher" or "Coder"
- a model from the providers you enabled

Save. The agent appears in the list and is ready to chat.

## 4. Talk to it

Click the agent in the list, type into the input, hit enter. If you created a Coordinator, ask it broadly ("plan my day", "look up X and email me"); it will pull in other agents as needed. If you created a specialist, talk to it directly.

## 5. (Optional) Add more users

In **Settings → Users** you can add additional users on this install — each gets their own isolated agents, skills, sessions, chat history, uploads, and settings. The owner controls which providers and features each user can see.

## What to look at next

- **Skills** — what each agent can actually *do*
- **Tasks & scheduler** — recurring or one-shot agent jobs ("every morning at 7, brief me on the news")
- **Remote nodes** — pair a homelab box, Pi, or workshop rig and have agents drive it
- **Public access** — needed if you want OAuth logins (Gmail, MS, Google Calendar) or a Telegram bot to work
