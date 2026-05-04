# Tasks & scheduler

> **Note:** the scheduler relies on a small bundled local model to parse intent — it isn't 100% accurate. Bare-time forms ("at 0230"), unusual phrasings, or compound requests can occasionally slip past it. When that happens, your agent's own model now has `set_reminder` and `schedule_task` tools as a fallback — so the larger model picks up where the local one missed. If a reminder still doesn't show up where you expected, check **Sidebar → Tasks**; if it isn't there, re-state it more explicitly ("remind me at 2:30 AM today to..."). Both paths get better as the cortex/plan models are retrained.

<br>

OpenEnsemble has a built-in scheduler that runs agent prompts on a schedule. Use it for daily briefings, recurring sweeps, or one-shot reminders — anything you'd otherwise have to remember to ask for.

## Two flavours

- **Recurring tasks** — fire on a cron-style schedule ("every weekday at 7am", "Sunday nights"). Best for routines: daily news briefing, weekly expense roll-up, nightly cleanup.
- **One-shot tasks** — fire once at a specific time. Useful for "remind me Friday to follow up", or for an agent to schedule a check-back on itself.

## Creating a task

Two ways:

**1. Just ask in chat.** "Every morning at 7, have the researcher brief me on AI news." OpenEnsemble has a built-in tiny LLM that parses scheduling intent — you don't need cron syntax. The agent will confirm, then create the task.

**2. Settings → Tasks.** Manual editor for the cron expression, the prompt, and the agent that runs it. Good for fine-tuning what the chat parser created.

You can see all your tasks in **Sidebar → Tasks**. The tasks badge counts upcoming runs.

### Two-stage parsing

There are two layers between you and a created task:

1. **Server interceptor** — runs *before* the LLM on every chat. The bundled local plan model parses the request and creates the task directly. Fast, free, private.
2. **Agent-tool fallback** — when the interceptor misses (regex doesn't recognize the phrasing, or the local model fails to parse), your agent's own model receives the raw message and can call `set_reminder` or `schedule_task` itself. Whatever model you've assigned to that agent (Claude, GPT-5.5, a local one) handles the parsing in this case.

The two paths produce slightly different titles right now — interceptor-created reminders use a terse label ("Drink water"), agent-tool-created ones get an LLM-polished title ("Drink Water Reminder"). Same firing behavior, different label producer. Cleanup of that inconsistency is on the roadmap.

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
- **accurate** — `openensemble-plan-360m-v2` (SmolLM2-360M, ~370 MB). The default; better at edge-case phrasing, with natural-language scheduling, reschedule/cancel coverage, and anchored-arithmetic ("30 min before my 11am meeting") all working.

**Owner/admin** can change which tier and which runtime hosts the model under **Settings → System → Scheduler Model**:

- **Built-in** (default) — runs the bundled GGUF in-process via `node-llama-cpp`. No setup.
- **Ollama** — pushes our model into your local Ollama and calls it from there. Faster on a GPU box.
- **LM Studio** — same idea, via LM Studio's local server.

### Disabling the plan model

Above the runtime picker is a toggle: **Use the built-in plan model**. Uncheck it to skip the bundled model entirely — every scheduling request then routes through your agent's own LLM (Claude, GPT-5.5, whatever you've assigned), which calls the `set_reminder` / `schedule_task` / `delete_task` tools.

When this might be the right choice:

- You're on a CPU-only machine and the bundled model's latency feels sluggish. The agent path adds ~2 seconds (its cloud round-trip), but you skip the local parse cost.
- Your phrasings consistently confuse the bundled parser ("friday, sat, and sunday at 12 I need to meditate") and you'd rather rely on the bigger model.
- You want a single model in charge of every chat decision, scheduling included.

Trade-offs to know about:

- **Cloud tokens** — every scheduling turn now pays for an agent LLM call.
- **Latency** — typical scheduling turn goes from ~400 ms (plan model + DB write) to ~2.5 s (agent round-trip + tool call + DB write). Still fast enough to feel snappy, but noticeable.
- **No offline path** — if the agent's provider is down, you can't schedule.
- The cancel/reschedule fast paths ("cancel that", "actually make it 3pm") also stop firing — the agent has to interpret those itself.

When the toggle is off, the runtime/tier rows below dim out (they have no effect). Re-enable any time without restarting the server.

The System tab itself is owner/admin only — regular users don't see it. If you're a regular user and the schedule parser is misbehaving, your owner is the one who'd switch it or flip the toggle.

## Reminder delivery

Reminders fire through the channel you pick under **Settings → System → Reminder Delivery**:

- **In-app** — banner + chime in the chat UI (default).
- **Telegram** — DM through the bot you've linked.
- **Email** — sent from one of your connected mailboxes (Gmail OAuth, Microsoft OAuth, or any IMAP account with SMTP). If you have multiple mailboxes, a second selector appears so you can pick which one sends. Defaults to the oldest connected account; falls back to the next sendable one if the chosen mailbox isn't usable when the reminder fires.
- **All channels** — fan out to every channel above that you've configured. Anything not configured is silently skipped (no error in chat).

Reminders fail open: if your preferred channel can't deliver (e.g. you picked Email but no mailbox is sendable), the system falls back to in-app so the reminder isn't silently lost. Check the server log for a `[reminder]` line if you expected delivery and didn't get it.

> Reminder delivery only applies to **reminder-type** tasks (the simple "remind me to X at Y" kind, fired by the built-in `fireReminder` handler). For agent-run scheduled tasks — like a daily news briefing — the agent itself decides what to do; if you want it pushed to Telegram or email, say so in the prompt ("…and email it to me", "…send via telegram") and the agent will use the matching tool.
