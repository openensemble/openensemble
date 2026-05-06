# LLM providers

OpenEnsemble doesn't ship with a default model — you bring your own. Providers are configured in **Settings → Providers** (owner/admin only). All start disabled.

## How providers and agents fit together

- Enabling a provider just makes its models *available*.
- Each **agent** picks one model. You can mix providers across agents — the Coordinator on Anthropic, a coder on OpenAI, a researcher on Grok, a tutor on local Ollama.
- The owner can restrict which providers a given user is allowed to pick from.

## Cloud providers

| Provider | Good for | Notes |
|---|---|---|
| **Anthropic** (Claude) | Reasoning, tool use, coding | API key from console.anthropic.com |
| **OpenAI** | All-around, vision | API key, *or* sign in with your ChatGPT account (uses your Plus/Pro entitlements) |
| **xAI Grok** | Real-time web context, X integrations | API key from x.ai |
| **Gemini** (Google) | Long context, vision | API key from aistudio.google.com |
| **DeepSeek** | Cheap reasoning models | API key |
| **Mistral** | Open-weight family, EU host | API key |
| **Groq** | Very fast inference of open models | API key |
| **Together** | Hosted open-weight models | API key |
| **Perplexity** | Web-grounded chat | API key |
| **Fireworks** | Image generation (Flux), open models | API key — one of several providers that can power `image_generator` |
| **OpenRouter** | One key, many models | Single key; pick from hundreds of models |
| **Z.ai** | GLM family | API key |

## Local providers

| Provider | Where it runs | Notes |
|---|---|---|
| **Ollama (local)** | Your network | Point OE at `http://{ip-of-ollama-server}:11434` — use the IP of the box running Ollama, not literally `localhost` (unless OE happens to be on the same box). No key. Pull any model into Ollama; it shows up in OE. |
| **Ollama (cloud)** | Ollama Turbo | Same idea, with an API key, hosted by Ollama. |
| **LM Studio** | Your network | Point OE at `http://{ip-of-lmstudio-server}:1234`. Use the IP of the box running LM Studio. **Important:** enable JIT model loading in LM Studio, or only the currently-loaded model will work. |
| **Cortex** (built-in) | Your machine | Bundled local model used for memory/reasoning. Runs in-process inside OE itself — no network address, no setup. |

> If OE and Ollama/LM Studio are on the same machine, you *can* use `localhost`. But if Ollama is on your desktop and OE is in an LXC, a Pi, or a Docker container, `localhost` points OE at *itself* and the connection fails. Always use the actual LAN IP of the host running the model server. Make sure that host's firewall allows the port (11434 / 1234) and that Ollama/LM Studio is configured to listen on `0.0.0.0` rather than only `127.0.0.1`.

## Environment-variable overrides

Instead of pasting API keys into `config.json` (where they sit as plain text on disk), you can set them as shell environment variables before starting OE. The server reads from the environment first; values found there **override** anything in `config.json`.

Why you might want this:

- **No secrets in the file.** If you back up the install dir or commit it to git, `config.json` won't contain real keys.
- **Per-environment keys.** Dev vs. prod can use different keys without anyone editing the same file.
- **Override without editing.** Set the env var and OE uses it, regardless of what's saved in Settings.

Set them in your shell (or `~/.bashrc`, or your systemd unit) before launching OE:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
./start.sh
```

You can leave the corresponding fields in **Settings → Providers** blank — OE picks them up from the environment automatically.

The variables OE recognises:

| Variable | What it sets |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GROK_API_KEY` | xAI Grok API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OLLAMA_API_KEY` | Ollama Cloud (Turbo) API key |
| `FIREWORKS_API_KEY` | Fireworks API key (one option for `image_generator`) |
| `BRAVE_API_KEY` | Brave Search API key (used by the `web` skill) |
| `OE_VISION_PROVIDER` | Provider used for image analysis, e.g. `openai`, `anthropic` |
| `OE_VISION_MODEL` | Specific vision model, e.g. `gpt-4o`, `claude-3-5-sonnet` |
| `OE_SESSION_EXPIRY` | Session token lifetime, in seconds |

## Special-purpose providers

- **Brave Search** — needed by the `web` skill. API key from brave.com/search/api.
- **Vision** — set `OE_VISION_PROVIDER` and `OE_VISION_MODEL` if you want a specific model used for image analysis (`OE_VISION_PROVIDER=openai`, `OE_VISION_MODEL=gpt-4o`, etc.). Easier path: pick from the dropdown under **Settings → Profile → Vision model**, which filters every enabled provider's catalog down to models that actually accept image input. The same `supportsVision` annotation flows through every model-list endpoint, so future agent-side vision pickers reuse it.
- **Text-to-Speech** — toggleable in **Settings → Providers**, used by the Tutor and read-aloud features.

## Choosing what to enable first

If you only want to enable one thing: **Anthropic** or **OpenAI** covers most use cases. Add **Fireworks** if you want image generation, **Brave** if you want web search, and **Ollama**/**LM Studio** if you want offline fallback.
