# Tips & shortcuts

A grab-bag of small features that save time once you know they exist.

## Keyboard

| Shortcut | What it does |
|---|---|
| `Ctrl+K` | Search across all your conversations |
| `↑` / `↓` (in empty chat input) | Recall your last 10 messages to this agent — terminal-style |
| `Esc` | Closes the slash menu, search modal, and a few other context-specific overlays. To dismiss a drawer, click the ✕ or the dimmed area outside it. |
| `Enter` | Send |
| `Shift+Enter` | New line |

## Slash menu

Type `/` at the start of an empty chat input to bring up the slash menu. It shows agent-specific commands and quick actions. Available commands depend on the agent's role.

## Agent mentions

Type `@<agent-name> do this` at the start of a message to send that request to a specific agent. OE will switch to that agent's chat and route the message there.

## Attaching files

Three ways:

- Click the **paperclip** icon and pick a file.
- **Drag and drop** any file onto the OE window — a dashed overlay appears showing where it will land. Drop it and the file is attached to the current chat.
- **Paste** an image (or any file) from your clipboard while the chat input is focused — the screenshot/file becomes an attachment without needing to save it first.

PDFs, images, CSVs, and code files all work. The active agent will see the attachment on its next turn.

> The active agent's model has to be able to read whatever you attach. Drop an image onto an agent running a text-only model (LM Studio without a vision model, plain Ollama text models, etc.) and you'll get an error or the image will be silently ignored. Same for PDFs / CSVs on models that don't accept document input. If in doubt, send the attachment to an agent on a vision-capable provider (Anthropic, OpenAI, Gemini, Grok vision, etc.).

## Switching views

The view toggle near the top of the workspace flips between **Chat** (the default) and **Desktop** — a customizable widget grid where you can pin tasks, news, market data, and other panels.

## The agent pill

The pill at the top-left of the workspace shows the active agent's emoji and name. It's a passive indicator (not clickable) — to switch agents, use the Agents drawer. The small dot next to the name shows live status:

- **Green** — agent is online and ready.
- **Yellow (pulsing)** — agent is busy, currently generating.
- **Red** — agent is offline (its provider is unreachable, or its server hasn't responded).

## Layout toggle

The columns icon in the bottom-left toggles between drawer-overlay and side-by-side layouts. On wide screens, side-by-side keeps the agents list always visible.

## Stop generating

While an agent is streaming a reply, the **■** button in the input row stops it. This works for cross-agent delegations too — interrupting the Coordinator stops the active sub-agent.

## Clearing a session

The trash icon in the sidebar clears the *current* agent's session. The session-dot on it indicates whether the current chat has any state.

## Telegram while away

If you've set up a Telegram bot (see **Public access**), messaging it while away from your desk goes to your Coordinator. Replies come back over Telegram, and the same conversation is visible in the web UI when you next open it.

## Hidden gems

- **Code projects auto-zip** — every code project in the Docs drawer has a "Download as zip" button.
- **Re-run a task** — in the Tasks drawer, hover a recurring task and click "Run now" to fire it without waiting for its schedule.
- **Voice on the tutor** — Tutor messages can be read aloud if you've set up the TTS provider.
