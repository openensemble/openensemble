---
title: Single-assistant rollout
parent: Development
nav_order: 3
permalink: /development/single-assistant-rollout/
---

# Single-assistant rollout

Operator guidance for developers deploying a new version of the account-mode feature.
User instructions are in [Single assistant and ensembles]({{ site.baseurl }}/guide/single-assistant/).

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
