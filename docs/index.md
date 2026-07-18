---
title: Home
nav_order: 1
permalink: /
description: >-
  OpenEnsemble is a self-hosted, multi-user AI assistant platform: a team of
  specialist agents, your choice of LLM providers, and open-hardware ESP32
  voice satellites — all running on your own server.
---

# OpenEnsemble

**Self-hosted, multi-user AI assistant platform.** Run a team of specialist
agents, choose the LLM providers they use, and keep each user's data isolated
on your own server.

[Get started]({{ site.baseurl }}/getting-started){: .btn .btn-primary }
[View on GitHub](https://github.com/openensemble/openensemble){: .btn }

![OpenEnsemble demo]({{ site.baseurl }}/demo.gif)

## What it is

OpenEnsemble is a single Node.js server that serves a web UI on port 3737.
Create the owner account, connect at least one model provider, create an
agent, and start a conversation.

- **One assistant or an ensemble** — choose one primary assistant that handles
  every enabled skill, or use specialist agents for coding, email, research,
  calendar, expenses, image generation, and more. Switching is non-destructive.
- **Bring your own LLMs** — Anthropic, OpenAI (API key or ChatGPT
  login/OAuth), Grok, Gemini, DeepSeek, Mistral, Groq, Together, Perplexity,
  Fireworks, OpenRouter, Z.ai, Ollama, and LM Studio. Assign different models
  per agent.
- **Voice satellites** — open-hardware ESP32-S3 smart speakers with on-device
  wake words. A private, self-hosted alternative to Alexa or Google Home.
  See [Voice devices]({{ site.baseurl }}/voice-devices).
- **Skills** — email, calendar, web research, expenses, scheduled tasks,
  remote nodes, MCP servers, and a built-in skill builder that creates new
  capabilities at runtime.
- **Multi-user by design** — every user's agents, sessions, files, and
  settings live in their own isolated workspace. Owners and admins control
  which features and models each user can access.
- **Private local models** — bundled reasoning and embedding models run
  in-process, so retrieval, summarization, and classification can work
  without external API calls or a GPU.

## Quick install

```bash
git clone https://github.com/openensemble/openensemble.git
cd openensemble
./install.sh
```

Copy the one-time credential printed by the installer, then open
`https://<your-server-ip>:3739`, accept the self-signed certificate warning,
and use the credential for owner setup or initial restore. Run `oe bootstrap`
locally if you need to recover it before setup is complete.
Full steps in [Getting started]({{ site.baseurl }}/getting-started).

## License

[AGPL-3.0-or-later](https://github.com/openensemble/openensemble/blob/main/LICENSE).
Run it, modify it, redistribute it, host it — if you modify it and let others
use it (including over a network), offer them your changes under the same
license.

## Questions

Ask in [GitHub Discussions](https://github.com/openensemble/openensemble/discussions)
or open an [issue](https://github.com/openensemble/openensemble/issues).
