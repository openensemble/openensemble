---
title: "Design: per-user sandboxing"
nav_order: 5
description: >-
  Design document for OpenEnsemble's v2 tenant boundary — generalizing the
  shipped per-skill sandbox to full per-user isolation.
---

# Per-User Sandboxing — Plan

Status: **design / not built.** The "v2 tenant boundary." Companion to `SKILL_SANDBOX.md`
(the per-*skill* sandbox that shipped). Reuses that broker machinery — this is a
generalization from "per skill" to "per user," not a rewrite.

## The idea

Instead of only jailing untrusted *skills*, jail each *user*: run everything that executes
on behalf of user A inside a boundary that mounts only A's data. Reaching another user's
secrets or the OE core then requires crossing a broker. The payoff per-skill can't match:
cross-tenant separation becomes **kernel-enforced**, so it survives *our own scoping bugs*
(we've shipped that class: the `loadUsers` empty-cache lockout, the `chat-dispatch`
`userId_` prefix). Per-skill only contains skills; a bug in a route handler or the agent
loop can still cross tenants.

## What each boundary protects

| Threat | Per-user jail | Per-skill jail |
|---|---|---|
| Skill reads **another user's** data / master key | ✅ (B, `_system` not mounted) | ✅ (only owner's slice mounted) |
| **Core bug** (route/agent-loop) serves A's data to B | ✅ (kernel boundary) | ❌ (skills aren't the leak) |
| A's *installed/untrusted* skill reads **A's own** tokens / other skills | ❌ (all of A is in A's jail) | ✅ (only media + own `state/` mounted) |

Read that last row carefully — it's the crux of both your questions.

---

## Q: One wrapper per user, instead of a wrapper for the user AND one per skill?

**Short answer: yes for the tenant boundary, with a caveat for intra-user least-privilege.**

The two wrappers have **contradictory mount scopes**, so a single namespace can't literally
be both:
- the **per-user** jail must mount *all of A* (the agent loop legitimately needs A's data);
- the **per-skill** jail must mount *only skill X's slice* (media + its own `state/`).

You can't have one mount namespace that simultaneously "sees all of A" and "sees only X."
Different code needs different scopes, so if you want both you need two scopes — i.e.
**nesting** (a skill jail inside the user jail), not one wrapper.

**But** the per-user jail **subsumes the cross-tenant role** of the per-skill jail: once A is
jailed, a skill inside it can't reach user B or the master key *regardless* of whether it has
its own inner jail, because B and `_system` aren't in A's jail at all. So the per-skill
wrapper's *only remaining job* under per-user isolation is **intra-user least-privilege** —
stopping skill X from reading A's OAuth tokens or skill Y's data.

So the real choice is about that last table row, not about tenant safety:

- **Don't need intra-user least-privilege** (A only runs skills A wrote → A trusts them):
  **one wrapper per user is enough. Drop the per-skill jail.** A's skills run directly inside
  A's jail. Simplest, cheapest.
- **Do need it** (A installs third-party / marketplace skills that A shouldn't have to trust):
  **keep a nested inner per-skill jail** — but now it's purely least-privilege, and the tenant
  wall is the outer wrapper.

Middle option worth noting: you can push the per-user jail's mount scope *tighter* — exclude
A's high-value tokens from the jail and broker them too (the agent loop reaches Gmail via a
brokered token call, not a mounted file). That recovers much of the per-skill token
protection **without** a second jail. The trade is more brokering.

## Q: Keep per-skill sandboxing, or only per-user?

**Recommendation: per-user becomes the primary boundary; per-skill is kept but repositioned
as an *optional inner layer* for untrusted skills — not discarded.**

- User-authored skills → run in just the per-user jail (drop the inner jail: cheaper, one
  fewer `bwrap` per call).
- Installed / marketplace / shared skills → also get the inner per-skill jail (least
  privilege), toggled by the **`manifest.sandbox.isolate` flag we already built** — its
  meaning shifts from "sandbox this skill at all" to "give this skill the *tighter inner*
  jail on top of its user's jail."

Nothing built is wasted: the `ctx`/credentials/runtime/watcher brokers are exactly what the
per-user boundary needs, and the credential broker is required at **both** layers anyway (the
master key must never enter any jail).

---

## Mechanism

The realistic per-user boundary is a **`bwrap`-jailed worker subprocess per active user**,
lazily spun up, pooled, and reused across that user's turns — talking to a trusted **core**
over the same NDJSON broker. Rejected alternatives:
- **worker_threads / v8 isolates** — *not* a security boundary (shared process memory + fs).
- **`bwrap` per request** — fine for a single skill call, but the agent loop is long-lived and
  streams; a per-user *worker* fits it far better and amortizes jail setup.
- **container per user** (Docker/nspawn) — stronger, but orchestration + memory cost; a later
  option if `bwrap` isolation proves insufficient.

### Core (trusted, shared) vs per-user jail

- **Jail (mounts `users/<uid>/` only; **not** `users/_system`, **not** other users, OE code
  read-only):** the agent loop, tool dispatch, custom skills.
- **Core (holds the master key):** provider egress, the WS hub, the scheduler + watcher
  supervisor, the model/voice-device servers, and every genuinely cross-user feature.

Everything the jail needs from core is an RPC — the pattern the per-skill broker already
established. Note MCP cross-user sharing was *built then removed* precisely because it broke
isolation; under this model it returns as a core-mediated route.

## Phased plan

1. **Core/jail split, one subsystem.** Stand up a per-user worker that runs a *single*
   brokered capability (e.g. tool dispatch for one skill class) behind a flag, everything else
   still in-process. Proves the worker lifecycle + broker generalization.
2. **Move the agent loop into the jail.** The big lift — `streamChat` + tool dispatch run in
   the per-user worker; provider calls, WS emit, and session persistence become broker RPCs.
3. **Broker the shared services** the loop touches: master key / credentials (done), provider
   egress, WS hub, scheduler registration, session store.
4. **Decide token scope.** Either mount `users/<uid>/tokens` into the jail (simpler, trusts
   the user's own skills) or broker token access (tighter; recovers per-skill token
   protection without nesting).
5. **Reposition per-skill.** Keep the inner jail only for `sandbox.isolate` skills the user
   doesn't fully trust; user-authored skills run directly in the user jail.
6. **Pooling & lifecycle.** Lazy spin-up per active user, idle eviction, resource caps
   (also closes the open per-skill CPU/time-cap item).
7. **Cross-user features.** Re-add delegation / shared-docs / MCP as explicit core routes.

## Cost / footprint

- N warm Node workers is memory-heavy; lazy spin-up + idle eviction + pooling is the middle
  ground. A busy box with many concurrent users is where this bites — model it before
  committing.
- Latency: a per-user worker adds a hop but amortizes across a user's turns; jail *setup* is
  paid once per spin-up, not per call (unlike per-skill `bwrap`).

## Recommendation

Ship per-user isolation when you onboard users you don't fully trust, and sell it on
"kernel-enforced separation that survives our own scoping bugs," not on simplicity — it's a
bigger lift than the (done) per-skill work. Default to **one wrapper per user**; add the inner
per-skill jail **only** for untrusted/installed skills, via the `sandbox.isolate` flag already
in place. Build it as a deliberate core/jail split that reuses the broker layer, one subsystem
at a time behind a flag — never a big-bang.
