---
title: Single assistant and ensembles
nav_order: 3
description: >-
  Choose one primary assistant or a classic team of specialist agents without
  deleting agents, assignments, or conversation history.
---

# Single assistant and ensembles

OpenEnsemble supports two account-level agent setups:

- **Single assistant** — one persistent primary assistant handles every
  enabled skill. It can use private, task-scoped background workers for long
  or parallel work, but the primary remains the only conversational identity.
- **Agent ensemble** — separate persistent agents keep their assigned roles
  and a coordinator delegates work among them.

The choice is stored per account. It is never inferred from how many agents an
account has.

## Defaults and first setup

Existing accounts remain in ensemble mode when this feature is introduced.
New accounts start in single-assistant setup. Because a new account does not
have an assistant yet, its first successfully created assistant automatically
becomes both its primary assistant and its ensemble coordinator.

If that first-assistant transaction is interrupted, startup recovery safely
finishes it when exactly one owned assistant exists. A missing, malformed, or
stale policy fails back to ensemble behavior.

## Switching modes

Open **Settings → Agents → Agent setup**, choose a mode, and, for single mode,
choose the primary assistant. The change applies from the next message. Wait
for an active reply to finish or stop it before switching.

You can also ask your assistant directly, for example:

- “Switch me to single-assistant mode.”
- “Use Avery as my primary assistant.”
- “Switch me back to my agent ensemble.”

If several assistants could become primary, OpenEnsemble asks you to choose.
Children cannot change this setting themselves; their parent or an
administrator manages it from the Users settings.

## What switching preserves

Switching modes changes the live view of the account; it does not rewrite the
stored ensemble.

- Parked agents, their personas, role assignments, layouts, and histories are
  retained.
- Switching back to ensemble restores the same agents and assignments.
- Account-level facts and preferences available to the primary remain
  available.
- A parked agent's private episodic history stays dormant in single mode and
  returns with that agent in ensemble mode. It is not silently merged into the
  primary's history.
- Saved tasks that name a parked agent are preserved and shown as parked.

Deleting the active primary is a separate destructive action. OpenEnsemble
blocks deletion while work is active and returns the account to ensemble mode
if the primary is durably deleted.

## Background work

In single mode, the primary may start a background worker for a long or
parallel job. A worker:

- is private to the account that started it;
- receives the owner's permission-filtered persona, safety rules, enabled
  tools, skill rules, and relevant standing preferences;
- does not receive ordinary chat history, another agent's episodes, or the
  ability to create more workers;
- cannot write memories, standing rules, account or agent topology,
  integrations, schedules, watches, or other OpenEnsemble control-plane state;
- cannot bypass the account's normal tool authorization;
- reports through a primary-authored completion in the primary's chat.

If the primary model is temporarily unavailable after two authoring attempts,
OpenEnsemble posts a clearly labeled system notice with the preserved result.
It never presents deterministic fallback text as if the primary wrote it.

Use `check workers` or `stop worker` in chat to inspect or cancel active work.
Worker admission and terminal state are durable: browser retries coalesce to
the original logical job, and a restart recovers a completed notification
without rerunning the producer.

For a worker started inside a scheduled occurrence, OpenEnsemble keeps its
completion journal until the scheduler has durably finalized that occurrence.
If the server restarts in the narrow gap after the producer finishes, recovery
does not replay the producer or continuation because either could repeat an
external side effect. It preserves the result, records that occurrence as
failed, and leaves the schedule available for its normal next run.

## Release and rollback runbook

Single-assistant mode changes durable profile state, so treat code rollout,
account switching, and changing the new-account default as separate actions.

Before rollout:

1. Build and test one exact candidate hash outside the live source checkout.
2. Take and verify a complete data snapshot, including user profiles, agents,
   sessions, assignments, memories, tasks, credentials, and configuration.
3. Rehearse upgrade, single → ensemble → single round-trip, and snapshot
   restoration against an isolated copy of representative profile data.
4. Keep the previous known-good build and the pre-upgrade snapshot available.

For a canary, start with one adult account. Confirm the mode round-trip,
primary selection, browser refresh, voice and scheduled entry points, worker
completion, permissions, and the account's real integrations before expanding.
Do not use a child account as the first canary.

The fastest behavioral rollback is to switch the canary account to ensemble.
For a full rollback, restore the previous build and the matching pre-upgrade
data snapshot during an approved maintenance window. Do not restore only the
code after the new build has written profile state.

Monitor policy fallback warnings, unknown-agent errors, permission denials,
tool-recovery rate, worker completion and duplicate-effect signals, bound-MCP
refusals, token use, and p50/p95 latency throughout the canary.

The Run Inspector records the exact provider-native tool field prepared for
each logical model round. A cost result is promotable only when the inspector
marks both token totals and request/completion/usage cardinality complete.
OpenAI Responses currently supplies that exact cardinality. Other provider
adapters retain their schema evidence but do not yet qualify for an exact cost
pass; LM Studio can additionally report estimated token totals, which are
shown as estimates and never counted as exact evidence.
