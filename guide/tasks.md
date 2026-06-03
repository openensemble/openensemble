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

Scheduled tasks always use the agent's **current** model — there's no model snapshot at schedule time. If you change your coordinator from gpt-5.5 to claude-sonnet-4.6 today, tomorrow's morning briefing fires on the new model. Same applies if you swap providers entirely.

If a scheduled run fails (transient network blip, provider 5xx, etc.), it retries 3 times with a 30-second gap before giving up. Final failures leave a visible **⚠️ Scheduled task failed** message in the agent's chat with the underlying error — no more silent orphan headers. The task stays scheduled and tries again at its next normal time.

## Silent runs

By default a scheduled fire writes three things to the agent's chat: a 📋 task header, the prompt itself as a user bubble, and the agent's reply. That's useful while you're tuning a new task. Once a task is running cleanly and delivers via side effects (Telegram, email, a doc that lands in **Documents**), the chat echo is just clutter.

Mark any agent task **silent** to suppress the entire run from chat — header, prompt, and reply all skipped. The task still fires, the agent still calls its tools, the email still gets sent. Confirmation comes from the tasks drawer instead: the row gets a 🔕 badge, an updated `last run` timestamp, and a one-line italic summary of what the agent reported (or the error if it failed).

Two ways to turn it on:

- **In chat** — drop an adverb into the request: *"silently send my news briefing at 10am"*, *"every morning at 7 quietly run my inbox sweep"*, *"at 5pm post the weekly metrics — don't show this in chat"*. The interceptor recognises *silently / quietly / in the background / without putting it in chat / don't show in chat* and creates the task with silent already on.
- **In the editor** — open Settings → Tasks (or the sidebar drawer), expand a task, and tick **Silent — run without showing in chat**. Same effect for tasks created loud that you've decided are noisy.

Silent failures don't escape into chat either — the **⚠️ Scheduled task failed** message is suppressed and the failure shows as a red line under the task row in the drawer. The task still retries on its next normal fire.

This is for **scheduled agent tasks** specifically. Reminder-type tasks (the chime + banner kind) ignore the flag — silencing a reminder just means turning it off. Watch tasks ignore it too.

## Watch tasks — fire on a condition, not a clock

Sometimes you don't want a clock — you want *"tell me when X happens."* Watches handle that. Ask in chat naturally: *"tell me when SOL hits $100"*, *"ping me when /tmp/build.log says BUILD OK"*, *"alert me if `df` shows the root volume above 90%."* Your agent picks the right shape and registers a watch.

Four sources cover most needs:

- **`http_jsonpath`** — fetch a URL, walk a JSON path, compare. *"alert me when this API returns `status: error`"*, *"watch the SOL price."*
- **`exec`** — run a shell command, parse stdout, compare. *"watch the disk fill"*, *"poll `gh pr view` until it merges."*
- **`file_stat`** — watch a file's existence, size, mtime, or content change. *"ping me when `/tmp/build-done` appears."*
- **`event_subscription`** — listen for an in-process event. Combine with `POST /api/watchers/event` to wire external webhooks (GitHub, CI, Telegram bot replies).

Each watch has a polling cadence (default 60 s) and an `on_fire` action: just notify (status bubble in chat) or run an agent (e.g., *"when the deploy log says READY, post a confirmation to Slack"*).

Active watches show in **Sidebar → Tasks** alongside scheduled tasks. Click any to expand history; cancel from the same row. Each watch is owned by the agent that created it; conversations preserve their bubbles across browser refresh.

## Friction proposals — the bubble that asks "make this recurring?"

If you ask for the same thing three times in a row in the same agent (the cortex same-instruction head decides what counts), a small bubble appears in chat: *"Make this a recurring task?"* with **Schedule daily** and **No, just this once** buttons. It's an offer, never an automatic action.

- **Accept** runs the agent in the background and sets up the right scheduled task or watch using sensible defaults (daily at the time you mentioned, or 09:00 if no time was specified). The bubble flips to *"Setting it up…"* immediately, then *"✓ Accepted"* when the agent finishes.
- **Dismiss** silences the same pattern for 24 hours so it doesn't immediately re-propose.
- **Destructive verbs** (delete, remove, wipe, format, drop, purge, rm, uninstall, reset, etc.) are filtered out — they never auto-propose, even when repeated. You can still set up a destructive recurring task explicitly via your agent; friction-as-proposer just won't escalate ad-hoc deletes into a daily one.

The bubble persists across reloads. Pending proposals can also be inspected via `/api/proposals` if you want to see what's outstanding.

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
