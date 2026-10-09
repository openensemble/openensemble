# LLM providers

Choose a chat provider for your assistant. The bundled Cortex models handle internal work and do not replace a chat model. Providers are configured in **Settings → Providers** (owner/admin only). All start disabled.

## How providers and agents fit together

- Enabling a provider just makes its models *available*.
- Each **agent** picks one model. You can mix providers across agents — the Coordinator on Anthropic, a coder on OpenAI, a researcher on Grok, a tutor on local Ollama.
- The owner can restrict which providers a given user is allowed to pick from.

## Cloud providers

| Provider | Good for | Notes |
|---|---|---|
| **Anthropic** (Claude) | Reasoning, tool use, coding | API key from console.anthropic.com |
| **OpenAI** | All-around, vision | API key, *or* sign in with your ChatGPT account (uses your Plus/Pro entitlements) |
| **xAI Grok** | Real-time web context, coding, X tools | API key from console.x.ai, *or* sign in with SuperGrok / X Premium+ (subscription entitlements, no console key) |
| **Gemini** (Google) | Long context, vision | API key from aistudio.google.com |
| **DeepSeek** | Cheap reasoning models | API key |
| **Mistral** | Open-weight family, EU host | API key |
| **Groq** | Very fast inference of open models | API key |
| **Together** | Hosted open-weight models | API key |
| **Perplexity** | Web-grounded chat | API key; live Agent API catalog, with existing Sonar agents kept on the Sonar endpoint |
| **Fireworks** | Legacy image assignments | Image generation is deprecated by Fireworks. OE lists only image models still returned by its API; choose another image provider if yours is unavailable. |
| **OpenRouter** | One key, many models | Single key; pick from hundreds of models |
| **Z.ai** | GLM family | API key |

## Provider compatibility and connection errors

Ollama Cloud checks a new key before saving it. A rejected key leaves the previous setting intact and displays the reason in **Settings → Providers → Ollama (cloud)**. Cloud model discovery requires successful authentication; Ollama's public model list alone does not mean a key works. Local Ollama keeps its own connection and credentials. Cloud tags retained by a local daemon are hidden when the model's metadata endpoint explicitly reports that it is missing or retired.

Provider model lists refresh from the provider, including Grok's separate image and video catalogs. Refreshing clears models that are no longer returned. The Image Generator supports an explicitly configured Grok Imagine Image 2.0 assignment; OE does not silently replace your selected model with a different paid model.

Model catalogs retain advertised input/output modalities, tools, features, limits, and explicit capability restrictions. Settings and chat share the same readers and account-scoped metadata. Claude's nested hosted-tool, thinking, effort, and context-management declarations are retained. OpenRouter's supported parameters and per-model reasoning options are retained, with hosting-endpoint details fetched when a model is used. Tool and reasoning requests require an OpenRouter endpoint that supports the requested parameters.

Gemini discovery uses Google's native Models API for generation methods, thinking support, and token limits. Missing Gemini and OpenAI capabilities are supplemented from the exact model's official documentation, cached for six hours. Features marked as available only in AI Studio are not advertised as Gemini API capabilities. Ollama's model-details endpoint supplies capabilities missing from its model list. LM Studio preserves native tool, vision, reasoning, and loaded-context information; a model's maximum context remains separate from its running configuration. Mistral and other compatible catalogs retain explicit capability flags and supported parameters when provided.

A missing field stays unknown; an explicit provider restriction takes precedence. Metadata keeps its source and fetch time, and failed refreshes preserve the last available metadata. Model support, access through your connection, and an implemented OE tool are separate requirements: discovering a capability does not enable a provider or skill, or add a new execution adapter. Providers that publish incomplete metadata may still need adapter support.

With **Image Generator** enabled, a supported ChatGPT-login model can generate and edit images through its hosted image tool when no separate usable image backend is assigned. Follow-up edits load the original saved image from the current conversation. Refresh the provider's model list after a model rollout to pick up new capability information.

OE checks the public Models.dev and LiteLLM provider registries every six hours. These feeds propose compatible API addresses and parameter mappings; the provider's own catalog remains authoritative for available models. Feed entries do not change your chosen model, enable providers or skills, or grant new capabilities. Check **Settings → Providers → Provider updates** to see feed availability and the latest test results, or choose **Check update feeds** to refresh the sources.

When you use a compatible chat provider, OE tests a supported proposal with a small separate request before sending your work with that change. The test contains no conversation content or tools, checks the response format and completion, and may consume a small amount of your provider allowance. OE saves the change after the real request also returns a complete response. Failed or interrupted tests keep the previous settings and report the issue in chat and the provider update panel. Repeated failed proposals are held for six hours to avoid repeated test charges. Provider-reported changes are distinguished from possible changes found in a community feed; credential, billing and network failures are described separately.

Supported adjustments include `max_completion_tokens` replacing `max_tokens`, omitting unsupported streaming usage reports, and compatible endpoint paths on the existing provider host. Successful adjustments are remembered for that endpoint, model, and credential for seven days, including across restarts. The cache contains no keys or prompts. Changes to the provider host, authentication or unknown transformations need an adapter update; OE reports them instead of applying them automatically. SuperGrok tests its explicitly required client version before saving it or retrying your work. ChatGPT catalog versions are saved only after a valid model-list response.

These mechanisms update catalogs and known compatibility settings without an OE release. Coverage depends on what the feeds and provider responses expose; a feed cannot repair every provider API. Native protocols, incompatible request formats, and retired services may still require an adapter change. Invalid API keys, missing subscription access, and billing problems are reported for you to resolve.

## Local providers

| Provider | Where it runs | Notes |
|---|---|---|
| **Ollama (local)** | Your network | Point OE at `http://{ip-of-ollama-server}:11434` — use the IP of the box running Ollama, not literally `localhost` (unless OE happens to be on the same box). No key. Pull any model into Ollama; it shows up in OE. |
| **Ollama (cloud)** | Ollama Turbo | Same idea, with an API key, hosted by Ollama. |
| **LM Studio** | Your network | Point OE at `http://{ip-of-lmstudio-server}:1234`. Use the IP of the box running LM Studio. **Important:** enable JIT model loading in LM Studio, or only the currently-loaded model will work. |
| **Cortex** (built-in) | Your machine | Bundled local model used for memory/reasoning. Runs in-process inside OE itself — no network address, no setup. |

> If OE and Ollama/LM Studio are on the same machine, you *can* use `localhost`. But if Ollama is on your desktop and OE is in an LXC, a Pi, or a Docker container, `localhost` points OE at *itself* and the connection fails. Always use the actual LAN IP of the host running the model server. Make sure that host's firewall allows the port (11434 / 1234) and that Ollama/LM Studio is configured to listen on `0.0.0.0` rather than only `127.0.0.1`.

Ollama local and cloud have separate URLs, credentials, and model selections. Local model discovery uses the URL saved under **Settings → Providers → Ollama (local)**. In the supplied Docker Compose setup, `http://host.docker.internal:11434` reaches Ollama on the Docker host if Ollama is listening on an interface reachable by the container. Leave the local API key empty unless your own proxy requires one. An Ollama Cloud key is not needed for local inference.

If an older installation returns **401 Unauthorized** after selecting a local model, edit the affected agent, select the model again under **Ollama (local)**, and save. Older versions could save a local model as a cloud selection. Existing selections are not automatically moved between providers; reselecting after updating corrects the saved provider.

## Add another compatible provider

An owner/admin can ask an agent with the **OE Admin** role to register an
OpenAI-compatible provider. Supply its display name, API base URL, and a model
ID from that provider's documentation. Enter the API key in the credential
prompt, then review and approve the requested restart.

After restart, open **Settings → Providers**, enable its card, and check its
model list. Select one of those models for an agent and send a short test
message. Registration records an audit entry; ask OE Admin to list recent
changes or revert that entry if the configuration is wrong.

## Environment-variable overrides

OE encrypts registered provider keys when saving configuration. Environment
variables are another way to supply credentials and override saved values.
Environment-only credentials are not included in OE backups; configure them
again on a replacement host.

For a manual foreground start from the OE installation directory:

```bash
export ANTHROPIC_API_KEY="your-api-key"
npm start
```

For a systemd user service, set variables in that service's environment or an
`EnvironmentFile`, then reload/restart the service. Editing `~/.bashrc` alone
does not update a running systemd service. For Docker, supply variables to the
container. Provider enablement and the agent's model selection still apply.
See [Security model](security.md#encryption-and-backups).

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
| `OE_SESSION_EXPIRY` | Optional browser-session idle timeout, in hours (`0` disables the idle timeout; the fixed seven-day browser maximum still applies) |

## Special-purpose providers

- **Brave Search** — needed by the `web` skill. API key from brave.com/search/api.
- **Vision** — set `OE_VISION_PROVIDER` and `OE_VISION_MODEL` if you want a specific model used for image analysis (`OE_VISION_PROVIDER=openai`, `OE_VISION_MODEL=gpt-4o`, etc.). Easier path: pick from the dropdown under **Settings → Profile → Vision model**, which filters every enabled provider's catalog down to models that actually accept image input. Choose an available vision model before testing a receipt or image.
- **Text-to-Speech** — toggleable in **Settings → Providers**, used by the Tutor and read-aloud features.

## Subscription logins (ChatGPT / SuperGrok)

Some providers let you **sign in with a consumer subscription** instead of (or in addition to) a console API key:

| Login | Where | Uses |
|---|---|---|
| **OpenAI (ChatGPT login)** | Settings → Providers | Your ChatGPT Plus/Pro entitlements via Codex OAuth |
| **xAI Grok (SuperGrok login)** | Settings → Providers | SuperGrok or X Premium+ via device-code OAuth |

How SuperGrok login works:

1. Click **Connect SuperGrok account**.
2. OE shows a short code and opens (or links to) the xAI verification page.
3. Sign in with the account that has SuperGrok or X Premium+, approve access.
4. OE stores a per-user refreshable token and lists Grok models under **xAI Grok (SuperGrok)**.

Notes:

- SuperGrok OAuth and the console **API key** are separate paths. Keep the API-key card for pay-as-you-go; use SuperGrok login to spend subscription quota.
- xAI decides which subscription tiers can use the OAuth API surface. If login succeeds but chat returns 403/402, fall back to a console API key or check your plan at [x.ai/grok](https://x.ai/grok).
- Non-admin users need an admin to grant **OAuth logins** for their account (same grant list as ChatGPT login).

If xAI rejects a request because OE's Grok client version is outdated, OE saves
the minimum version reported by xAI and retries the rejected request once.
Later requests, including model discovery, use that version. This updates the
connection handshake; it does not install software, change your selected model,
or replay a request that already started. An administrator's explicit
`OE_GROK_CLI_VERSION` setting takes precedence. Other API changes still require
an OE update.

Grok 4.7 can use hosted image generation when **Image Generator** is enabled
for your account and no separate image backend is configured. A request such
as "Have Grok create a cat sitting in a tree" or "Use Grok to generate an image" starts one
temporary worker using an available Grok connection. It does not need a new
saved agent or a change to your primary assistant's provider.
Direct requests to other named providers or models use the same routing. The
worker stays on the requested provider or model; unavailable targets report an
error instead of switching providers.

## Choosing what to enable first

Start with one chat provider you can access, then select a model for your assistant. Add an image-capable provider for image generation, Brave for Brave-backed search, or a local chat server for local inference. See [Getting started](getting-started.md) and [Which model does what](models-explained.md).
