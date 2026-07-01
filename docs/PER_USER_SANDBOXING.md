# Per-User Sandboxing — Design Notes

Status: **design / not built.** This is the "v2 tenant boundary" idea, captured while the
per-*skill* sandbox work was landing. Read alongside the per-skill isolation that already
ships (`lib/skill-subprocess.mjs`, `lib/skill-ctx-broker.mjs`, `lib/skill-net-policy.mjs`,
`lib/skill-runtime-broker.mjs`, `roles.shouldSandboxSkill`).

## The question

Instead of sandboxing each untrusted *skill*, sandbox each *user* — run everything that
executes on behalf of user A inside a jail that only sees A's data, so reaching another
user's secrets or the OE core requires crossing a broker. Is that easier, and does it fix
the whole multi-tenant problem?

## Short answer

- **Not easier** than the (mostly-done) per-skill work — it's a bigger re-architecture,
  because OE is one Node process with a lot of shared in-memory state.
- **But stronger**, for one reason that per-skill can't match: it makes cross-tenant
  separation **kernel-enforced**, so it survives *our own bugs* — a mis-scoped `userId` in
  a route handler can't leak A's data to B if B literally isn't mounted in A's jail. (We've
  already shipped that class of bug: the `loadUsers` empty-cache lockout, the
  `chat-dispatch` `userId_` prefix.)
- The two are **complementary layers**, not either/or:
  - **Per-user** = the tenant wall (A can't reach B or the master key, even via a core bug).
  - **Per-skill** = untrusted-code containment *within* a tenant (a shady skill A installed
    from a marketplace can't read A's own tokens, puppet A's coordinator, or exfiltrate —
    see the network default-deny + `onFire` fixes).

## What per-user isolation fixes vs. doesn't

Inside user A's jail, A's custom skill still sees A's own data + A's secrets + the OE code
mounted in the jail. So:

| Threat | Per-user jail | Per-skill jail |
|---|---|---|
| A's skill reads **B's** tokens/data | ✅ blocked (B not mounted) | ✅ blocked (only A's own dirs mounted) |
| A's skill reads the **master key** | ✅ blocked (`_system` not mounted) | ✅ blocked (brokered creds) |
| **Core bug** serves A's data to B | ✅ blocked (kernel boundary) | ❌ not covered (skills aren't the leak) |
| A's *installed* skill exfiltrates **A's own** data | ❌ not covered (it's in A's jail) | ✅ blocked (network default-deny) |
| A's *installed* skill puppets A's coordinator | ❌ not covered | ✅ blocked (`onFire` downgrade) |

Takeaway: if the model is "each user only runs skills they wrote," per-user isolation is
close to the whole answer. If users can install shared/third-party skills, you want **both**.

## Sketch of an OE implementation

The plumbing already built for skills generalizes from "per skill" to "per user": the
NDJSON-over-stdio broker (`skill-ctx-broker`), the credentials broker, and the runtime
broker are exactly the shape a per-user boundary needs.

**Split into a trusted core + per-user jails:**

- **Per-user jail** (bwrap or a worker process; mounts only `users/<uid>/` + OE code
  read-only, **not** `users/_system` and **not** other users): the agent loop, tool
  dispatch, and skills run here.
- **Core / broker** (trusted, shared, holds the master key): provider egress, the WS hub,
  the scheduler + watcher supervisor, the model/voice-device servers, and every genuinely
  cross-user feature. Everything the jail needs from core is an RPC (same pattern as today's
  `helper.*` / `ctx.*` brokering).

**Decisions to make:**
- Which subsystems are core vs per-user. First cut above; the scheduler and voice hub are
  the debatable ones.
- Cross-user features. Delegation and shared-docs need explicit broker routes. Note MCP
  cross-user sharing was *built then removed* precisely because it broke isolation — it'd
  come back as a core-mediated route.
- **Footprint.** N warm Node workers is expensive; a bwrap-per-request model is cheaper but
  pays jail-setup latency per turn. Pooling / lazy spin-up per active user is the likely
  middle ground.
- Migration. Ship behind a flag, one subsystem at a time, reusing the broker layer — don't
  big-bang it.

## Recommendation

Keep the per-skill sandbox — it protects today and is the right containment layer for any
future installed/shared skills. Treat per-user isolation as a deliberate design pass to
adopt when onboarding users you don't fully trust, and sell it on "kernel-enforced
separation that survives our own scoping bugs," not on simplicity. It reuses, not replaces,
the broker machinery already in place.
