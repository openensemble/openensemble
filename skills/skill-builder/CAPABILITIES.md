# Capabilities to offer the user during a skill draft

This file is consumed by skill-builder during a draft conversation. Each
capability has a TRIGGER (when to bring it up) and a USER PITCH (how to
phrase the offer to the user). The blueprint (`SKILL_BLUEPRINT.md`)
covers HOW to implement each one — don't duplicate that here.

**Discipline:** offer only the capabilities whose trigger actually matches
the user's ask. Don't carpet-bomb a draft with every option in the menu.
"Should I add image generation to your flight booker?" is the failure
mode — guard against it by reading triggers strictly.

---

## 1. Background watching (single source)

**Trigger:** user mentions "watch", "monitor", "check on", "alert me when",
"let me know if", "track", "follow", a price/release/upload/post they
care about.

**User pitch:** "I can check this in the background — every hour, or
every few minutes if it changes fast — and ping you when something
new shows up. Want me to set that up?"

**Decisions to surface:**
- Cadence preset (hourly/daily/weekly or "fast" = 5 min)
- Delivery mode: chat (agent summary), email, telegram, or quiet notify

**Skip when:** the skill is purely lookup-on-demand ("what's the price
right now") with no follow-up interest.

---

## 2. Multi-item collection (many similar things, one watcher)

**Trigger:** user uses a PLURAL noun for what they want to track —
"channels", "stores", "products", "feeds", "symbols", "addresses",
"accounts", "flights", "hotels", "subscriptions", "subreddits".

**User pitch:** "You'll have a single tracker that holds each
{noun-plural} as one item — different cadences per item, different
delivery per item if you want. You can add/remove items later just by
asking, no rebuild needed."

**Decisions to surface:**
- Default cadence for new items (will become each item's starting rate)
- Whether different items might want different delivery modes

**Skip when:** the user only ever talks about ONE thing of that kind.

---

## 3. User-named catalog (alias resolution)

**Trigger:** the skill needs an opaque id internally (channel_id, account
id, item id, store slug) AND the user is likely to refer to that thing
by a friendly name later ("the Asmongold channel", "my Tokyo flight",
"the Whole Foods one").

**User pitch:** "I'll remember the names you use for each one, so next
time you can just say 'the Asmongold channel' or 'my Tokyo flight' and
I'll know which one you mean — no need to repeat IDs or URLs."

**Decisions to surface:** none usually; this is a free win when the
trigger matches.

**Skip when:** the skill only takes plain strings the user types each
time (URLs, queries, free-form text).

---

## 4. Multi-source aggregation

**Trigger:** user mentions multiple competing sites/sources for the same
data — "Kayak and Google Flights", "Best Buy + Target + GameStop",
"Reddit + HackerNews", "Amazon + eBay".

**User pitch:** "I can pull from {site A} + {site B} + {site C} and merge
the results, so you don't have to check each one. Want me to start with
all of them, or pick the leanest one or two first?"

**Decisions to surface:**
- Which sources actually matter (don't assume "all")
- Whether to dedupe across sources (usually yes)
- Order of priority when results disagree

**Skip when:** there's a single canonical source (one official API, one
RSS feed).

---

## 5. External API + credentials

**Trigger:** the skill needs data or actions an unauthenticated public
page can't provide — booking a flight, sending an email, posting to a
social network, querying a paid market-data API.

**User pitch:** "This needs a {Provider} API key — I'll prompt you for
it when needed and store it encrypted. {Cost note: free signup / N
requests/day free / paid only}. Or I can fall back to {scraping public
results / a limited free tier / a different source} if you'd rather not
set up an account."

**Decisions to surface:**
- API vs scrape tradeoff (real data + signup vs limited + zero setup)
- Whether the user actually has an account / wants to create one

**Skip when:** everything the skill needs is publicly accessible.

---

## 6. Action vs read-only

**Trigger:** user describes something MUTATIVE ("book a flight", "send
an email", "post to Twitter", "place an order") rather than purely
informational.

**User pitch:** "This can take action for you — actually {booking /
sending / posting} — or stay read-only and just hand you a draft to
review. Read-only is safer; you flip 'send-without-confirm' style
behavior on per-skill once you trust it. Which feels right to start?"

**Decisions to surface:**
- Read-only draft vs direct action
- If direct, what confirmation gate (always confirm / confirm above
  $threshold / never confirm)

**Skip when:** the skill is purely informational.

---

## 7. Notification delivery (when watcher fires)

**Trigger:** ALWAYS bring this up when a watcher (#1 or #2) is part of
the draft — the user needs to choose how they hear about events.

**User pitch:** "When something fires, how do you want to hear about it?
- **Chat (default)** — the assigned agent summarizes and TTSs naturally.
- **Email** — sent from your primary connected account to your profile
  email.
- **Telegram** — pinged via your linked bot chat.
- **Notify** — quiet status bubble, no agent turn."

**Decisions to surface:**
- Default delivery
- Whether different items in a collection should be allowed to override
  (e.g. one important flight on email, the rest as chat)

---

## 8. Pref-aware filtering (cortex memory)

**Trigger:** user mentions a personal preference relevant to filtering
the data — "only deals on grocery items I actually buy", "skip beauty
products", "no spoilers", "Asian and Mediterranean cuisine only".

**User pitch:** "I can check your stored preferences before notifying
you, so you only hear about {matching items}. Anything that doesn't
match your preferences will be silently skipped, so the alerts stay
useful."

**Decisions to surface:**
- Whether to actually filter (some users want EVERYTHING regardless)
- What signal counts as preference (cortex search vs explicit list)

**Skip when:** there are no plausible "filter out" preferences for the
domain.

---

## 9. Drawer / sidebar UI

**Trigger:** user explicitly asks for a visual panel, a configuration
screen, or a place to see status at a glance.

**User pitch:** "I can add a small sidebar panel showing {what's in
flight, last fired, current settings} so you can see everything without
asking. Most skills don't need one — it's pure UX, no extra
functionality. Want one?"

**Skip when:** user didn't ask. The blueprint already says drawers are
optional and most skills should not include one.

---

## 10. Browser extension as the fetcher (no-API sites)

> ⛔ **NOT AVAILABLE YET — DO NOT RECOMMEND OR BUILD AGAINST THIS.** The OE
> Bridge browser extension is not shipped: it's gitignored, absent from fresh
> installs, and the `ctx.browser` / `helpers.browser` surface is incomplete
> (read-only primitives only; no scripting to click or control a page). Until
> it ships, do NOT pitch the extension to the user, do NOT offer it as a
> capability, and do NOT scaffold skills that depend on `ctx.browser`,
> `helpers.browser`, or `browser_list`. If a request would need it (scrape a
> no-API site, control a web app like YouTube Music, read the user's tabs),
> prefer a public API / RSS / JSON-LD source instead — and if there's no such
> source, tell the user that browser automation isn't available yet rather
> than building against the bridge. Everything below is retained for when it
> ships; ignore it for now.

**Trigger:** the user wants to monitor or read a site that has NO public
API, no RSS feed, no structured data export — AND/OR is known for
aggressive anti-bot (Best Buy, Target, Ticketmaster, Kayak, airline
sites). Common phrasing: "track Best Buy restocks", "watch this site
for changes", "scrape this URL", "monitor my school portal".

**User pitch:** "If you've installed the OE Bridge browser extension,
I can use YOUR browser as the fetcher instead of scraping from the
server — that means your real session, your real IP, your real cookies.
Sites that block server-side scrapers don't see this as a bot. Trade-
off: only works while your browser is open and the OE Bridge extension
is connected; if you close the browser, the watcher pauses until you
reopen it."

**Decisions to surface:**
- Has the user installed the OE Bridge extension? Check first via
  `browser_list`. If not, offer to talk them through install (see the
  README at `~/.openensemble/browser-extension/`).
- For a watcher: should the skill open a fresh tab each cycle, or
  reuse an existing tab the user is leaving open?
- What's the page selector / pattern that signals "new state"? (price
  text, stock badge, headline change, etc.)

**Skip when:** the site has a public API or RSS feed (cheaper, doesn't
depend on the user keeping a browser open). Order of preference per
the MONITORED-SOURCE PATTERN stays: RSS > public API > JSON-LD >
browser-extension scrape > full server-side scrape.

**Skill-side scaffolds** (Phase 1 — read-only):

A kickoff tool (called from a chat turn) uses `ctx.browser`:
```
// in execute.mjs tool handler
const tabs = (await ctx.browser.list())[0]?.tabs || [];
const targetTab = tabs.find(t => t.url.includes('bestbuy.com/site/x'));
const tabId = targetTab?.tabId ?? (await ctx.browser.openTab('https://www.bestbuy.com/...')).tabId;
await new Promise(r => setTimeout(r, 3000));
const page = await ctx.browser.readPage(tabId);
```

A watcher handler uses `helpers.browser` (same surface, bound to the
record's userId — `ctx` isn't available inside a handler tick):
```
async [KIND](state, helpers) {
  const tabs = (await helpers.browser.list())[0]?.tabs || [];
  const targetTab = tabs.find(t => t.url.includes(state.url));
  const tabId = targetTab?.tabId ?? (await helpers.browser.openTab(state.url)).tabId;
  await new Promise(r => setTimeout(r, 3000));
  const page = await helpers.browser.readPage(tabId);
  const inStock = /add to cart/i.test(page.text);
  if (inStock !== state.lastInStock) {
    await helpers.fire({ message: `Best Buy: ${inStock ? 'IN STOCK' : 'sold out'}` });
  }
  return { newState: { ...state, lastInStock: inStock } };
}
```

## 11. Scheduled action (cron-style)

**Trigger:** user mentions a TIME pattern rather than a condition —
"every morning at 7", "every Sunday", "the first of each month",
"weekdays at 9".

**User pitch:** "I can schedule this to run automatically — {time
phrasing}. The skill can also send results when it fires, or just keep
them for later when you ask."

**Decisions to surface:**
- Exact schedule (read it back to confirm time zone interpretation)
- What happens with the output (notification vs silent storage)

**Skip when:** the user is describing a CONDITION (price drop, new
upload) rather than a schedule — that's a watcher, not a cron.

---

## How to apply this menu

1. Listen to the full user ask. Don't propose anything yet.
2. Cross-reference against the triggers above. Note matches.
3. Surface 1-3 matched capabilities per turn, framed as concrete
   choices ("which feels right?"), never as feature checklists.
4. If user says yes, add to `draft.tools` / `draft.watcherKinds` /
   `draft.collection` / `draft.credentials` / etc. via
   `skill_draft_update`.
5. If user says no, mark the capability as REJECTED in the draft so
   you don't re-offer it on the next iteration.
6. When the draft has zero open questions AND every confirmed
   capability has the decisions filled in, ask "Want me to build it?"
7. Only `skill_draft_build` on explicit "build it" / "yes go" /
   "ship it" / equivalent.

When the user's ask is concrete enough that no decisions are needed
("add a tool to my YouTube skill that opens a URL in browser"), skip
the draft entirely and go straight to `skill_patch_code` /
`skill_create`. Draft is for shaped + ambiguous asks, not micro edits.

---

## N. Voice device output (`ctx.device.*`)

**Trigger:** user wants the skill to TALK through their voice device,
PLAY audio (music, podcasts, sound effects, alarms) on the device, or
NOTIFY them out loud when something happens — anything where the
device's speaker is the delivery surface, not the chat UI.

**User pitch:** "I can have this play / speak / notify through
your voice device — same one you talk to now. Want it speaking from
the device, popping up in chat, or both?"

**What ctx.device exposes (v1):**

- `ctx.device.id()` — the device the user is currently talking through,
  or `null` if this is a web/text chat. Use this as the default target
  when the user says "play music" without naming a room.
- `ctx.device.list()` — every registered device with id + name. Use
  when the user names a specific room ("play it in the kitchen").
- `ctx.device.playStream(deviceId, url, { loop })` — start an audio
  stream. `url` must be an http/https URL the server can fetch. The
  ambient pipeline transcodes it on the fly to MP3 CBR 160 kbps stereo
  at 48 kHz (the only format the firmware decodes), so the input
  can be any format ffmpeg can read (m4a, opus, mp3, ogg, etc.).
  `loop: true` restarts seamlessly at end-of-file.
- `ctx.device.stop(deviceId)` — stop any current stream.
- `ctx.device.speak(deviceId, text)` — TTS the text through the
  speaker. Interrupts any current playback (including ambient + the
  agent's reply if mid-conversation), so use sparingly.
- `ctx.device.notify(deviceId, text)` — v1 just calls speak. Future
  versions will add chime + criticality + quiet-hours awareness.

**REQUIRED — make the skill voice-triggerable (`voice_device` flag):**

Voice turns run a slim tool allowlist for latency, so a skill's tools
are STRIPPED on voice turns by default — the user speaks and nothing
happens. ANY skill the user will trigger by SPEAKING to a voice device
MUST set `"voice_device": true` at the manifest top level; that single
flag adds the skill's tools to the voice allowlist. This is independent
of audio output — a skill that controls YouTube Music in the browser, or
toggles a smart-home device, or just answers a question by voice needs
the flag just as much as one that streams audio via `ctx.device`. Leave
it off (default) only for skills the user will exclusively use in the
browser/chat UI.

**Protect terminal tools from remembered tool plans (`selected_plan_keep`):**

The server remembers per-task tool "recipes" and trims an agent's toolset
to the remembered list on matching turns. If your skill has a TERMINAL
tool — the save/send/deliver/finalize step without which its workflows
cannot complete (like `save_research` for research or `email_compose` for
email) — declare it at the manifest top level:

```json
"selected_plan_keep": ["myskill_save_result"]
```

Those tools then survive recipe trimming for any agent that holds the
skill. Declare ONLY genuinely terminal tools: every entry ships its
schema on every plan-constrained turn, so listing read/query tools here
wastes tokens and defeats the trimming.

**Audio-source guidance for the skill:**

When the user names an external music/podcast/audio service ("YouTube
Music", "Spotify", "my podcast feed", "this Bandcamp page"), pick the
backend at skill-build time based on what the user asked for. Use
whatever lib gets you to a streamable URL (search/discovery on the
service's side, URL resolution per song/episode). Don't ask the user
"which library should I use" — they already chose the service. Choose
a lib whose license fits + that doesn't require manual auth setup
unless the user mentions credentials. The OE side is identical
regardless of source: hand `ctx.device.playStream` an http(s) URL.

**For local audio files** (skill downloads/generates an MP3 first), the
file needs to be reachable as an http URL the OE server can fetch.
Today this means either hosting via `/api/files/...` (write into the
user's profile files dir via `getUserFilesDir(userId, 'audio')` and
expose) or — simplest for v1 — keep the file in a temp location and
serve it through a short-lived skill HTTP endpoint. The ambient-library
upload route already does the storage half; future work will expose a
"register temp audio" helper so skills don't have to roll their own.

**Decisions to surface:**

- "Which device should this come out of? The one you're talking through
  right now, or a specific room?"
- "Should it loop (background ambience) or play once (a song / message)?"
- "If you're already in the middle of another conversation, should this
  interrupt it or queue?" (v1 ALWAYS interrupts — note this honestly if
  it matters to the user)

**Skip when:** the skill's output is purely textual or visual (the
user reads a chat reply or sees an image). Don't shoehorn voice when
the user didn't ask for it.

---

## N. Per-skill runtime logging (`ctx.log.*`)

**Trigger:** EVERY skill you create. Default to `ctx.log.*` instead of
`console.log/warn/error`. Skills that don't use ctx.log can't be
debugged via `skill_read_logs` — entries vanish into OE's main app.log
mixed with everything else.

**What ctx.log exposes:**

```
ctx.log.info('fetched 3 songs', { query, ms });
ctx.log.warn('search returned empty', { query });
ctx.log.error('yt-dlp failed', { code, stderr });
```

Every entry is mirrored to:
- OE's app.log tagged `skill:<id>` (so cross-skill queries still see
  it)
- A per-skill JSONL at `users/<userId>/skills/<skillId>/runtime.log`
  that you can read back via `skill_read_logs`

**When to log:**
- Every external request (URL fetched, API called, command spawned) —
  log the action + key params, log the result (status, count, error)
- Every state transition (watcher fired, item added/removed, mode
  switched)
- Every decision branch where the next behavior depends on a value —
  log the value
- DON'T log token-by-token; log per-meaningful-step

**When users come back saying "skill X isn't working":**

1. Call `skill_read_logs({ skillId: 'X', tail: 100, level: 'error' })`
   first — actual error messages from the most-recent runs.
2. If there are recent errors, you know what to patch. Don't guess.
3. If there are NO error entries but the user reports a problem, fall
   back to `skill_read_logs` without the level filter (info+warn) to
   see what the skill saw on its last run, then ask the user one
   targeted question based on what's actually missing from the log.
4. If the per-skill log is empty entirely (skill was using
   `console.log`), patch the skill to use `ctx.log.*` BEFORE trying to
   diagnose — otherwise the next "it's broken" report will also have
   nothing to read.

**Skip when:** never. Always wire `ctx.log` from the first version of
the skill so the next time something breaks you have a trail.
