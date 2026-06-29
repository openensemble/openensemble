# Welcome to OpenEnsemble

OpenEnsemble is a self-hosted, multi-user AI assistant platform. You run a single Node.js server, connect the LLM providers you want, and create a roster of specialist agents that talk to each other to get work done.

The first-run path is deliberately short: create the owner account, connect one model provider, create an agent, and send a message. Optional integrations can be added later from Settings.

## The mental model

- **Agents** are the people on your team. Each one has a name, an emoji, a model, a role, and a set of skills. You can talk to any of them directly.
- **Roles** are the persona and workflow rules an agent follows (Coder, Researcher, Email, Coordinator, …). Roles are swappable — the same agent can change role without losing its history.
- **Skills** are the tools an agent can use. Web search, file editing in a sandbox, email, calendar, image generation, remote machine control, and so on. Each skill is a tiny manifest plus an `execute.mjs`.
- **The Coordinator** is the agent at the front door. When you message it, it figures out which specialist should answer and delegates to them.
- **Providers** are the LLM backends — Anthropic, OpenAI, Grok, Gemini, Ollama, LM Studio, OpenRouter, and others. You enable the ones you want; each agent picks one model.

## What it isn't

- It isn't a SaaS — you host it.
- It isn't tied to one model vendor — every provider is optional.
- It doesn't lock you in — your data is plain JSON and files under `users/{userId}/`.

## Feature maturity

- **Core:** agents, roles, skills, providers, documents, memory, tasks, and per-user workspaces.
- **Advanced:** remote nodes, service profiles, public access, backups, auto-update, MCP servers, and multi-user administration.
- **Beta / hardware:** voice devices, flashing, local speech-to-text, and local text-to-speech.

## Where to go next

- Brand new install? → **Getting started**
- Setting up which AIs OpenEnsemble can talk to? → **LLM providers**
- Want to know what each built-in skill does? → **Skills**
- Need to expose your install to the internet (Telegram, OAuth callbacks)? → **Public access**
