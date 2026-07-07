# Personalization

> **Note:** Reflection uses whatever model you've picked — it's making judgment calls about patterns in your activity, so it won't always get things right. That's exactly why every inferred fact starts out unconfirmed, and every offer waits for your say-so before anything actually happens.

OpenEnsemble can quietly learn from how you use it — the questions you ask, what's on your calendar, patterns in what the coordinator does for you — and turn that into small, useful nudges: a note in your morning briefing, a reminder before something you have coming up, a fact it noticed that you can confirm or throw away.

It's entirely ask-first. Learning happens passively in the background; anything it wants to *act* on shows up as a suggestion you accept or dismiss, never something that just happens.

Set it up in **Settings → Personalization** (on/off, which model reflects, run/reset controls). Review what it has actually learned in the **Learn** drawer, under **"What I've learned about you."**

## What it learns from

Every 6 hours, Personalization looks back over recent activity and looks for things worth surfacing: something you keep asking about, a fact worth remembering, an upcoming event worth preparing for. It draws on:

- **Tool activity** — what the coordinator did for you and what you asked for.
- **Calendar** — what's coming up in the next week.
- **Session summaries** — the gist of recent conversations.

You can also trigger this manually any time with the **Run now** button, instead of waiting for the next scheduled pass.

## What it stores (and what it doesn't)

Personalization keeps a short, one-line digest of things that happened — never the things themselves. A calendar sync isn't saved as the full event details — it comes down to something like "calendar event: flight next Tuesday." A question about the weather isn't saved as the full answer — just enough to know it happened.

For anything that touches content that isn't yours to begin with, or that could be sensitive — reading or searching an email, opening a file or document, browsing a web page, running a command — the digest goes further and doesn't keep even a short snippet. It records only that the action happened, whether it succeeded, and a rough size ("3 lines, 1.2k characters"), never the subject line, file text, page text, or command output itself.

- Every digest is capped at 400 characters and built deterministically — it truncates and counts, it isn't written by a model.
- Full email bodies, full calendar entries, full document contents, and command output are never stored here — only the fact that something happened, boiled down to a line (and for the content-touching actions above, not even a line of that — just the shape of it).
- Anything that looks like a password, API key, or token is stripped out before it's stored, even in the lighter-touch digests for everyday lookups.
- Digests age out automatically after 30 days.
- Everything is scoped to your own account — nothing here is shared between users.

## Choosing what does the learning

The model picker in **Settings → Personalization** has three kinds of choice, each with a privacy line so you know exactly what it means:

- **Off** — Stops reflection and any background lead re-checking — nothing gets sent to any model, local or cloud. It does *not* stop activity from being recorded; that's what the **Learn about me** switch above is for. Pick this if you want Personalization to keep its quiet digests without any model reflecting on them yet.
- **Same as coordinator** (the default) — whatever model your coordinator agent currently uses handles reflection too. If your coordinator runs on a local model, this does too; if it's a cloud model, the same posture carries over.
- **A specific provider** — pick any provider/model you've already configured under **Settings → Providers**, independent of your coordinator.
  - Local providers (a model running on your own network) are labeled **"stays on this machine."**
  - Cloud providers are labeled **"activity summaries — never raw content — sent to `<provider>`."**

If you pick a local provider and it happens to be unreachable when a scheduled run fires, that run is simply skipped — it never quietly falls back to a cloud provider on your behalf. A skipped run (and why) shows up on the last-run line, along with when it last ran, which model handled it, how many tokens it used, and what it produced.

## What I've learned about you

Every fact Personalization infers shows up in a ledger in the **Learn drawer** — plain one-line statements ("usually free Tuesday mornings," "prefers the earlier of two options") each tagged with how sure it is:

- **Inferred** — the model noticed a pattern and made a guess. You haven't said whether it's right.
- **Confirmed** — you told it "yes, that's accurate."

Each row also shows how many observations it's based on. From there:

- **Confirm** — mark it as accurate.
- **Forget** — forget that one fact, immediately.
- **Start fresh** (in **Settings → Personalization**) — clear every *inferred* fact in one go (this one asks you to confirm, since it's a bigger reset). Anything you've explicitly confirmed is left alone — starting fresh clears guesses, not things you've vouched for.

Nothing here is ever permanent. Even a confirmed fact is still one click from gone.

## Keeping an eye on things

Sometimes the honest answer to something you asked is "not yet" — is an item back in stock, has a price dropped, has something shipped. Instead of just giving up, the coordinator can open a **lead**: it tells you once that it'll check back ("I'll check again tomorrow and let you know"), then quietly re-checks on its own without you having to ask a second time.

- This is announce-first, not ask-first — you're told once, then it either reports back with an answer or the lead quietly expires.
- Leads only check a small, fixed number of times before giving up on their own — nothing runs forever in the background.
- **Settings → Personalization** lists everything currently being watched, with a **Dismiss** button if you'd rather it stopped checking.
- If something's found, you're notified right away — unless it's quiet hours or you're already at your daily notification limit, in which case it holds and folds quietly into your next briefing instead of interrupting you.

## Offers, and "always do this?"

When reflection spots something actionable — worth a reminder, worth preparing for — it doesn't just do it. It proposes it, the same way any other suggestion appears in chat: a card with **Accept** and **Dismiss**.

- **Accept** carries out the action right away (for example, setting a reminder).
- **Dismiss** declines it, this time only.

Accept the *same kind* of offer twice, and Personalization notices the pattern and asks a follow-up: **"Want me to always do this?"** Accepting that turns it into a standing rule — future offers of that kind execute immediately from then on, with a quick receipt instead of a card, until you say otherwise. Dismiss the same kind twice instead, and future offers of that kind are quietly suppressed — no more asking about it.

Two grounded examples of what this looks like day to day: a reminder to pack the night before a flight it noticed on your calendar, or a heads-up that groceries you buy regularly are on sale this week — both start as one-tap offers, and both can graduate to "just handle it" once you've said yes twice.

## Turning it off

The **Learn about me** toggle and the model picker's **Off** option stop different things:

- The toggle is the master switch — flip it off and new observations stop being recorded immediately, which in turn means reflection, lead re-checks, and offers have nothing to work from.
- Picking **Off** in the model picker stops reflection and lead re-checks specifically — but activity keeps being recorded as long as the toggle above is on. Use this if you want the quiet, deterministic digests to keep accumulating without any model (local or cloud) reflecting on them yet.

Turning either off doesn't erase what it's already learned. Anything already in the ledger stays until you delete it yourself or use **Start fresh** — these controls only affect whether it keeps learning, not what it remembers.
