# Tasks & scheduler

OpenEnsemble has a built-in scheduler that runs agent prompts on a schedule. Use it for daily briefings, recurring sweeps, or one-shot reminders — anything you'd otherwise have to remember to ask for.

## Two flavours

- **Recurring tasks** — fire on a cron-style schedule ("every weekday at 7am", "Sunday nights"). Best for routines: daily news briefing, weekly expense roll-up, nightly cleanup.
- **One-shot tasks** — fire once at a specific time. Useful for "remind me Friday to follow up", or for an agent to schedule a check-back on itself.

## Creating a task

Two ways:

**1. Just ask in chat.** "Every morning at 7, have the researcher brief me on AI news." OpenEnsemble has a built-in tiny LLM that parses scheduling intent — you don't need cron syntax. The agent will confirm, then create the task.

**2. Settings → Tasks.** Manual editor for the cron expression, the prompt, and the agent that runs it. Good for fine-tuning what the chat parser created.

You can see all your tasks in **Sidebar → Tasks**. The tasks badge counts upcoming runs.

## What runs

Each task is essentially: *"send this prompt to this agent on this schedule"*. The agent runs the prompt as if you'd typed it yourself, with all the same skills available. If the prompt asks for an email to be sent, it's sent. If it asks for a research doc, the doc is created and shows up in **Documents**.

## Watching for conditions (planned)

A condition-triggered task type is on the roadmap — *"tell me when SOL hits $100"*, *"ping me when this PR turns green"*. For now, you can fake it with a recurring task that polls.

## Editing & disabling

In the Tasks drawer, hover a task to edit, pause, or delete. Pausing keeps it but stops it firing.

## Where they live

- One-shot and recurring tasks: per-user state under `users/{userId}/`.
- The schedule loop runs in the same Node process as the server — restart the server and it picks them up again.

## Scheduler model

Schedule parsing is handled by a small bundled local model. It runs on CPU and doesn't call out to a cloud provider, so "every Monday at 9am" is interpreted privately and offline.

Two tiers ship out of the box:

- **fast** — `openensemble-plan-v5` (SmolLM2-135M, ~140 MB). Lower latency and RAM, slightly lower accuracy.
- **accurate** — `openensemble-plan-360m-v1` (SmolLM2-360M, ~370 MB). The default; better at edge-case phrasing.

**Owner/admin** can change which tier and which runtime hosts the model under **Settings → System → Scheduler Model**:

- **Built-in** (default) — runs the bundled GGUF in-process via `node-llama-cpp`. No setup.
- **Ollama** — pushes our model into your local Ollama and calls it from there. Faster on a GPU box.
- **LM Studio** — same idea, via LM Studio's local server.

The System tab itself is owner/admin only — regular users don't see it. If you're a regular user and the schedule parser is misbehaving, your owner is the one who'd switch it.

## Reminder delivery

Notifications from tasks go through whichever channels you've set up:

- **In-app** — chat bubble from the running agent (always on).
- **Telegram** — if you've connected a bot (see **Public access**).
- **Email** — if you've connected an outbound mailbox.

Configure default delivery in **Settings → System → Reminder Delivery**.
