# Agents

An agent is one configurable participant in your ensemble. They're cheap to make and you'll usually have several — the Coordinator out front and specialists behind.

## What an agent has

- **Name and emoji** — how you identify them in the sidebar and in cross-agent delegations.
- **Role** — the persona and workflow rules they follow (see **Roles**). Determines which built-in skills they're allowed to use.
- **Model** — one model from one enabled provider. Can be changed any time.
- **Description** — a short hint of what this agent is for; the Coordinator uses it when deciding who to delegate to.
- **System prompt** — extra instructions on top of the role's prompt. Use this for personal preferences ("always answer in metric", "I'm a senior Go engineer").
- **Tools** — the specific skill tools this agent has unlocked. Roles set sensible defaults; you can adjust per-agent.

## Creating an agent

Two ways:

- **Sidebar → Agents → + New Agent**.
- Or type **`/new-agent`** in the chat input — same modal, faster if you're already typing.

Pick a role first — that pre-fills the tools and system prompt. Save. The agent appears in the list immediately.

## Talking directly vs. through the Coordinator

- Click an agent in the sidebar list to open a **direct** chat. This conversation has a persistent session — it remembers context across messages.
- Talk to the **Coordinator** instead and it will *delegate* — each delegation creates an **ephemeral** session for the chosen specialist, just for that task. The Coordinator collects the result and replies to you.

That distinction matters: when you ask the Coordinator to "have the researcher look up X", the researcher gets a clean fresh context every time. To accumulate state with a specialist, talk to it directly.

## Editing an agent later

In the agent list, hover the agent and click the edit icon (or right-click → Edit). You can change name, emoji, model, system prompt, role, and tool selection without losing chat history. Switching role swaps the persona without rebuilding the agent.

Expand the **Advanced** dropdown in the edit panel for the less-touched knobs:

- **Context window** — how many prior tokens of conversation to include each turn. Lower it if responses are slow or you're getting close to the model's limit; raise it if the agent forgets things mid-task.
- **Max output tokens** — caps the length of any single response. Useful if an agent rambles or to keep cost predictable on long-output models.

These are per-agent, so you can give a researcher generous limits and a quick-reply assistant tighter ones.

## Deleting an agent

Edit panel → Delete. Sessions, history, and any per-agent state under `users/{userId}/agents/{agentId}/` are removed.

## Multiple agents on the same model

Totally fine, and common. Two coders on the same OpenAI model with different system prompts (one front-end, one infra) is a perfectly good setup.
