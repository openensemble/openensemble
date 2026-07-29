# The Coordinator

The Coordinator is the agent at the front door. You talk to it, it figures out which specialist should answer, and either replies itself or hands the work off.

## What it actually does

When you message the Coordinator, it:

1. Reads your message.
2. Looks at the agents you have, their roles, and their descriptions.
3. Decides whether to answer directly or delegate.
4. If delegating, opens a fresh **ephemeral** session with the chosen specialist and asks them.
5. Collects the specialist's reply and integrates it into the response back to you.

You can have multiple delegations chained — *"Research the latest AI news and email it to me"* might delegate to the Researcher first, then to Email.

## Background worker teams

For a long, divisible outcome, the Coordinator can start one detached coordinator
worker and let it assign independent child workstreams. If you give an explicit
count — for example, *"use 6 agents to audit these sources"* — that count means
six child workers; the detached coordinator is additional. Without a count, the
coordinator chooses the smallest useful team, normally two to four children.

Requested team size and concurrency are separate. OpenEnsemble creates the full
team plan and reserves every lane's scope up front, then queues lanes that exceed
the shared concurrency limit. The task card shows requested, active, queued, and
completed workers. A user-specified team may contain up to 12 children by
default; owners can lower that ceiling with
`OPENENSEMBLE_MAX_WORKSTREAMS_PER_OUTCOME`. Requests above the configured
ceiling are reported explicitly rather than silently reduced.

## Direct chat vs. delegation

This is the most important Coordinator concept:

- **Direct chat** with a specialist (clicking them in the agent list) → **persistent session**. Memory accumulates.
- **Coordinator delegation** to a specialist (`ask_agent`) → **ephemeral session**. Every delegation is fresh, no carry-over.

So if you ask the Coordinator to "ask the researcher about X" twice, the researcher answers the second one with no memory of the first. To build context with a specialist, talk to them directly.

## Tuning the Coordinator's choices

The Coordinator picks specialists based on each agent's:
- **Role** (Coder vs. Researcher vs. Email)
- **Description** (your one-line "what is this agent for?")
- The user's message

If it's picking the wrong one, the cheapest fix is to write clearer agent descriptions. ("image and video generation specialist" is more useful than "creative agent".)

## When to talk to a specialist directly

- You're iterating on a long task and want continuity (debugging a coder agent's output, a long research thread).
- The Coordinator keeps misrouting.
- The specialist has its own UI or skill state you want to inspect.

## When to talk to the Coordinator

- Casual / mixed work where you don't know who should handle it.
- Multi-step asks that span specialists.
- Telegram and other inbound channels — they always go to the Coordinator first.

## No Coordinator?

You don't have to have one. If you only have specialists, just talk to them directly. A Coordinator just makes life easier when you have several specialists.
