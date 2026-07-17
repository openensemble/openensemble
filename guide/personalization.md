# Personalization

> **Note:** Reflection uses whatever text-capable model you've picked — it's making judgment calls about patterns in your activity, so it won't always get things right. That's exactly why every inferred fact starts unconfirmed and consequential actions start ask-first. The only first-use exception is an optional Safe initiative contract for a server-reviewed private informational watcher with exact Stop/Undo; all other automation requires your separate “always do this” approval.

OpenEnsemble can quietly learn from how you use it — the questions you ask, what's on your calendar, patterns in what the coordinator does for you — and turn that into small, useful nudges: a note in your morning briefing, a reminder before something you have coming up, a fact it noticed that you can confirm or throw away.

Consequential actions start ask-first. Learning happens passively in the background; purchases, messages, calendar changes, destructive operations, external delivery, and anything without an exact undo path always appear as a suggestion first. If you enable **Safe initiative**, a reviewed skill may start a private informational watcher automatically—but only through a validated, exactly stoppable contract, with a durable receipt and **Undo / Stop updates** controls. Unreviewed or modified skill code falls back to a suggestion even when its manifest labels itself informational.

Set it up in **Settings → Personalization** (sources, privacy, model, engagement style, and reset controls). Review what it has actually learned in the **Learn** drawer, under **About you**.

## First-time setup

The first time you open Personalization, OpenEnsemble asks you to acknowledge what it stores and choose:

- which sources may contribute: tool activity, calendar patterns, and conversation summaries;
- which local or cloud model performs reflection; and
- engagement style: Quiet, Helpful, or Proactive.

Choose **Not now** to complete the acknowledgement with Personalization off. Nothing is locked in: every choice remains available in **Settings → Personalization**.

## What it learns from

Every 6 hours, Personalization looks back over recent activity and looks for things worth surfacing: something you keep asking about, a fact worth remembering, an upcoming event worth preparing for. It draws on:

- **Tool activity** — what the coordinator did for you and what you asked for.
- **Calendar** — what's coming up in the next week.
- **Session summaries** — the gist of recent conversations.

You can also trigger this manually any time with the **Run now** button, instead of waiting for the next scheduled pass.

Clear preference statements take a faster path: phrases such as “I love
Honeycrisp apples,” “my favorite apples are Cosmic Crisp,” or “remember that I
prefer Honeycrisp” become confirmed preferences immediately, without waiting
for reflection or depending on a model classifier. A one-off lookup such as
“are apples on sale?” still counts as weak evidence that you use that store
skill, but its query value is not silently promoted into “likes apples.”

## What it stores (and what it doesn't)

Personalization keeps bounded observations, never raw tool results. Ordinary tool activity is shape-only: the tool name, argument names/types, success or failure, and rough line/character counts. There is one declared exception: a skill may mark non-sensitive string search fields as weak interest evidence. For a successful call, up to three distinct matching terms (for example, “Honeycrisp apples”) are bounded, secret-redacted, and stored in the per-user encrypted observation log. They are still only weak evidence—not confirmed preferences or permission to act. Explicit preferences, corrections, choices, and outcomes may also be kept as short one-line signals because those are the high-value things the system needs to learn from.

For anything that touches content that isn't yours to begin with, or that could be sensitive — reading or searching an email, opening a file or document, browsing a web page, running a command — the digest goes further and doesn't keep even a short snippet. It records only that the action happened, whether it succeeded, and a rough size ("3 lines, 1.2k characters"), never the subject line, file text, page text, or command output itself.

- Every digest is capped at 400 characters and built deterministically — it truncates and counts, it isn't written by a model.
- Full email bodies, full calendar entries, full document contents, web content, and command output are never copied into the observation log. Calendar reflection reads the existing calendar mirror when that source is enabled; cloud reflection receives coarse event labels rather than private titles and locations.
- Anything that looks like a password, API key, or token is stripped out before it's stored, even in the lighter-touch digests for everyday lookups.
- Digests age out automatically. The default is 30 days; Settings offers 7 days, 30 days, 90 days, or one year.
- Everything is scoped to your own account — nothing here is shared between users.

## Choosing what does the learning

The model picker in **Settings → Personalization** has three kinds of choice, each with a privacy line so you know exactly what it means:

- **Off** — Stops reflection and any background lead re-checking — nothing gets sent to any model, local or cloud. It does *not* stop activity from being recorded; that's what the **Learn about me** switch above is for. Pick this if you want Personalization to keep its quiet digests without any model reflecting on them yet.
- **Same as coordinator** (the default) — whatever model your coordinator agent currently uses handles reflection too. If your coordinator runs on a local model, this does too; if it's a cloud model, the same posture carries over.
- **A specific provider** — pick any provider/model you've already configured under **Settings → Providers**, independent of your coordinator.
  - Loopback providers running on this machine are labeled **"stays on this machine."** A model endpoint on another host is treated as a network boundary, even if it uses a normally-local provider type.
  - Cloud/network reflection receives activity/conversation summaries, declared bounded lookup-interest terms, and coarse calendar labels—not stored raw tool output or private calendar bodies. If you explicitly ask for an automatic follow-up, a secret-redacted excerpt of that lead's later read-only result may also be sent to the chosen model so it can judge whether your question was finally satisfied.

If you pick a local provider and it happens to be unreachable when a scheduled run fires, that run is simply skipped — it never quietly falls back to a cloud provider on your behalf. Settings shows a privacy-safe reflection-health banner with the last attempted run and last successful run. It distinguishes a healthy run, an idle check with no new signal, a provider/model failure, and a currently unavailable model without displaying raw provider errors.

When provider-backed pattern discovery is paused but **Learn about me** and conversation learning remain enabled, explicit preferences you state still work. To use a different model as a fallback, choose it yourself in the existing **Reflection model** selector. OpenEnsemble never silently changes the selected model or provider; this preserves the privacy boundary you chose.

The picker only shows text-capable providers available to your account. Local/cloud labeling follows the endpoint the server will actually call, rather than a similarly named model in another catalog.

## About you

Every fact Personalization infers shows up in a ledger in the **Learn drawer** — plain one-line statements ("usually free Tuesday mornings," "prefers the earlier of two options") each tagged with how sure it is:

- **Inferred** — the model noticed a pattern and made a guess. You haven't said whether it's right.
- **Confirmed** — you told it "yes, that's accurate."

Inferred entries gradually lose confidence when they are not reinforced and
are removed once they become too stale. Confirmed entries keep their
confidence; a confirmed entry is removed only when you edit/delete it or when
an explicitly temporary preference reaches its stated expiry.

Each row also shows its category, when it was updated, a plain-language confidence level, and how many observations support it. Expand **Why does OpenEnsemble think this?** to see the short, redacted source summaries that were retained; older facts may only have an evidence count.

If later evidence conflicts with a fact, the row moves to the top and shows the competing statement explicitly as a model judgment. You decide whether to **Keep original**, **Use new suggestion**, edit it yourself, or remove it; the conflicting suggestion is not silently presented as truth. Other facts are ordered by most recently updated.

From there:

- **Confirm** — mark it as accurate.
- **Edit** — correct a close-but-not-quite fact. The corrected wording becomes confirmed and its memory embedding is updated.
- **Not true** — remove a false claim and keep a long-lived rejection marker so weak evidence does not immediately recreate it.
- **Outdated** — remove something that used to be true; fresh evidence may establish it again later.
- **Too personal** — remove it with a long-lived rejection marker. You can also turn off its contributing source in Settings.
- **Forget** — forget that one fact, immediately.
- **Start fresh** (in **Settings → Personalization**) — clear every *inferred* fact in one go (this one asks you to confirm, since it's a bigger reset). Anything you've explicitly confirmed is left alone — starting fresh clears guesses, not things you've vouched for.

Nothing here is ever permanent. Even a confirmed fact is still one click from gone.

## Keeping an eye on things

Sometimes the honest answer to something you asked is "not yet" — is an item back in stock, has a price dropped, has something shipped. Instead of just giving up, the coordinator can open a **lead**: it tells you once that it'll check back ("I'll check again tomorrow and let you know"), then quietly re-checks on its own without you having to ask a second time.

Lead judging uses the same model choice as reflection. A re-check result is capped, credential-redacted, and only comes from a tool explicitly approved as safe to invoke read-only; it is not added to the observation log.

- This is announce-first, not ask-first — you're told once, then it either reports back with an answer or the lead quietly expires.
- Leads only check a small, fixed number of times before giving up on their own — nothing runs forever in the background.
- **Settings → Personalization** lists everything currently being watched, with a **Dismiss** button if you'd rather it stopped checking.
- If something's found, you're notified right away when delivery is set to **Immediate** — unless it's quiet hours or you're already at your daily notification limit. With **Hold for briefing / activity**, or whenever an immediate ping is held back, the durable update waits for the briefing and remains visible in **Proactive activity**.

## Offers, and "always do this?"

When reflection spots something actionable — worth a reminder, worth preparing for — it doesn't just do it. It proposes it, the same way any other suggestion appears in chat: a card with **Accept** and **Dismiss**.

- **Accept** carries out the action right away (for example, setting a reminder).
- **Dismiss** declines it, this time only.

Accept the *same kind* of offer twice, and Personalization notices the pattern and asks a follow-up: **"Want me to always do this?"** Accepting that enables an automatic-behavior policy for that offer kind — future offers of that kind execute immediately from then on, with a durable receipt instead of a card, until you say otherwise. Dismiss the same kind twice instead, and future offers of that kind are quietly suppressed for 30 days; Settings shows when that automatic suppression expires.

The **Automatic and muted behaviors** list in Settings also shows behaviors you returned to **Ask first**. Choose **Ask first** to revoke an automatic behavior, **Mute** to stop that suggestion type indefinitely, or **Resume · ask first** to allow a stopped preference suggestion again without restoring automatic action. The accept/dismiss and usefulness history is kept when you change a policy, so the audit remains honest without immediately re-graduating the behavior.

Every reminder offer must cite current evidence that supports both the suggestion and its schedule; an ungrounded or guessed date is rejected before a card can be created. Two examples are a reminder to pack before a calendar-backed trip, or a reminder to follow up after a conversation-backed deadline. Both start as one-tap offers and can graduate to "just handle it" once you've said yes twice.

Safe initiative is deliberately separate from graduation. It does not make an
arbitrary tool automatic: only a server-reviewed, skill-declared informational
monitor with local delivery and an exact watcher identity qualifies. Before starting one,
OpenEnsemble reserves a receipt; afterward it verifies that exactly the
promised watcher exists. If verification fails, the watcher is removed and the
action does not report success.

Choose **Undo · ask next time** on the receipt to stop that watcher and return
the exact behavior to ask-first. Choose **Stop updates**, or reply “don’t do
that again,” to stop it and mute that exact behavior. The underlying preference
is kept—for example, stopping Publix alerts does not make OpenEnsemble forget
that you like Honeycrisp apples.

## Engagement, delivery, and quiet hours

Settings provides three **engagement** styles. This is a relationship posture, not only a volume knob:

- **Quiet** — learn for context only. No unsolicited preference-monitor discovery or soft-confirm cards; durable updates stay in **Proactive activity**, and lead results can wait for a briefing.
- **Helpful** — the default careful assistant: up to two offers per reflection and two unsolicited pings per day. One-off lookups stay weak interest; monitors still need a confirmed preference and an ask (or Safe initiative).
- **Proactive** — friend-like noticing: after repeated interactive interest on the same skill topic (for example two Publix chicken lookups), OE may soft-confirm “Remember that you like chicken?” and, once you accept, skill-scoped preferences can open standing watches even when the skill author never listed that exact subject keyword. Higher default offer/ping budget (four each).

Older installs that used volume-only **Balanced** / **Proactive** map to **Helpful** (the old higher volume is kept). A brief intermediate **Companion** value migrates to **Proactive**. The friendlier Proactive engagement mode is never applied automatically — choose it explicitly.

The independent **Safe initiative** control determines whether the system may
do a narrowly safe action or must suggest it first:

- **Suggest first** — every new behavior starts with a confirmation card.
- **Act when safe + show receipt** — reviewed informational, private, exactly
  reversible skill monitors may start automatically. Everything consequential remains
  ask-first.

In **Helpful** or **Proactive**, an installed skill may declare that it can use
a matching **confirmed** preference for an ongoing service (for example,
watching a store's deals for foods you like). Personalization can suggest
turning that service on, or—when both the user and skill opt into the restricted
Safe initiative contract—start it with a reversible receipt. The skill receives
only bounded positive confirmed preferences matching its own declaration;
contradicted and negative rows are excluded. **Proactive** can also soft-confirm
repeated interests and match skill-scoped confirmed subjects beyond static
keywords. **Quiet** suppresses both activation suggestions and safe automatic starts.

Choose whether unsolicited websocket updates arrive immediately or are held. Held lead results fold into the next scheduled briefing; automatic-action receipts remain visible in **Proactive activity** for review. If no briefing is scheduled, durable items do not disappear. Quiet hours and daily limits use the timezone captured during setup; lead results and automatic-action receipts wait rather than interrupting during that window. Every immediate receipt shares the same daily ping budget as lead updates. Upgraded installs and travelers can choose **Use this browser’s timezone** beside the quiet-hours controls at any time.

The **Proactive activity** list is durable: an update written while you're offline remains pending instead of disappearing. Delivered items can be marked read individually or all at once. Each item also includes a **Why this appeared** explanation and a mode label: **Safe initiative** when the restricted setting started a reviewed preference monitor, **You approved this** when you explicitly enabled that exact preference monitor, **Requested follow-up** for something you asked it to keep checking, or **Previously approved** for a behavior you separately graduated to automatic handling. Ask-first suggestions remain in chat and do nothing until you approve them.

## Decision history

The Settings timeline records privacy-bounded decisions such as facts created or corrected, reflection results, resets, and proactive policy changes. It stores short summaries and counts, not a second copy of raw observations. Clearing decision history does not delete facts, behaviors, or open leads.

## Turning it off

The **Learn about me** toggle and the model picker's **Off** option stop different things:

- The toggle is the master switch — flip it off and new observations, reflection, scheduled lead re-checks, and use of ledger-owned personalization facts stop. Existing data stays available for you to review or delete.
- Picking **Off** in the model picker stops reflection and lead re-checks specifically — but activity keeps being recorded as long as the toggle above is on. Use this if you want the quiet, deterministic digests to keep accumulating without any model (local or cloud) reflecting on them yet.

Turning either off doesn't immediately erase what it already learned. Confirmed entries stay until you delete them (or an explicitly temporary preference expires); inferred entries can still age out under the normal confidence-decay policy, or you can remove them with **Start fresh**. The master switch also stops those ledger-owned facts from being injected into agent context; choosing only the model's **Off** option leaves existing facts usable while pausing model-driven reflection and lead judging.
