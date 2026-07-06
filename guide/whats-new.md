# What's new

A running log of user-visible changes shipped to OpenEnsemble. Newest at the top.

If you auto-update (`oe update`), you'll get these as they land. If not, run `oe update` in your install directory to pull the latest.

---

## 2026-07-05

**Personalization you control**
OpenEnsemble can now learn quietly from your activity — the questions you ask, your calendar, patterns in what the coordinator does for you — and turn that into small, useful nudges in your daily briefing or a reminder before something you have coming up. It only ever suggests; nothing runs without your say-so, and accepting the same kind of suggestion twice in a row offers to make it automatic from then on.

**You pick what does the learning**
New Settings → Personalization panel: choose "Off," "Same as coordinator" (the default), or any other configured provider — local providers stay fully on this machine, cloud providers get one-line activity summaries, never raw email or calendar content. Every fact it's learned about you shows up in a ledger you can confirm, delete, or wipe clean with one "Start fresh" button.

**It follows up so you don't have to**
When the coordinator can't answer something right away — "is this back in stock," "did the price drop" — it can now say so once and check back on its own, announcing what it finds instead of making you ask again.

## 2026-07-04

**Send several files in one message**
Attachments now truly travel together: everything in the tray goes with the message you're typing (up to 6 per message), the assistant sees all of them at once, and they're remembered — reloading a chat shows every file that was attached to a message, not just the pictures from this tab session.

**Task drawer shows what happened and what's next**
Each scheduled task in the drawer now shows its next run time, a warning when it keeps failing, and a History view — every past run with whether it fired on time, fired late (and by how much), failed, or was skipped and why.

**Sessions list names your machines**
Node sessions now show the machine's actual hostname (like voice devices already did), so you can tell your machines apart at a glance.

**Destructive actions now show an approval card**
When the assistant stages something destructive (purging a sender's email, deleting transactions, promoting a service to trusted, cancelling another agent's watcher), a card now appears with Approve and Cancel buttons — no more typing "APPROVE PURGE" from memory, no more losing the staged action to a typo. Typing the phrase still works, and the card survives a page reload.

**Drafts follow their agent; attach multiple files**
A half-typed message now stays with the agent you typed it for — switch away and back, or reload, and it's still there. The attach button accepts multiple files with a tray showing each one (sent one per message for now).

**Scheduled tasks: see what happened and what's next**
Every task now records a run history — fired on time, fired late (and by how much), failed, or skipped and why — so "why didn't Tuesday's briefing arrive?" finally has an answer. Tasks also expose their next run time, and the desktop widget shows it along with a warning badge when a task keeps failing.

**Background work survives restarts**
Completed background delegations and workers are now remembered for 7 days — a server restart or a busy day no longer erases what finished and how. Workers spawned during a scheduled task are also now properly waited on, so a scheduled run can't report "done" while its worker is still going.

**Email auto-labeling you can trust**
Auto-label rules can now keep messages in your inbox (per-rule setting), the poller respects what you've taught the assistant about senders (a learned correction beats a rule; learned keep-inbox is honored), every action is recorded in an activity view, and "put the last batch back" undoes the most recent run.

**Self-healing is no longer silent**
When a provider rejects a capability (native web search, reasoning effort), a login token refreshes itself, or proposal suggestions pause because they weren't landing, you now get a one-line toast instead of silence.

**Skill authoring: undo button and test bench**
Skill code and manifest changes now keep the last 10 versions — `skill_rollback` lists and restores them. New `skill_try_tool` runs a single tool with real arguments through the production sandbox before you rely on it. And console output from skill runs is saved to the skill's log even when the run "succeeds," so successful-but-wrong is debuggable.

**"Why didn't my tool get called?"**
A new admin diagnostic walks all ~12 gates a tool must pass (manifest, bundling, allowlists, per-turn trimming, voice allowlist, intent routing…) and names the first one that dropped it — ask "why isn't my tool being called?" and the assistant can now actually tell you.

**Sessions you can recognize — and revoke everywhere**
The session list now shows what each session is (browser, node, voice device — with names). One "Log out everywhere" button revokes all other browser sessions, and optionally unpairs voice devices and nodes too (they can't sneak back in — re-pairing is required).

**Conversations no longer end early on routed answers**
In conversation mode, replies that were routed to a specialist behind the scenes (calendar, email, weather, and friends) now keep the listen window open just like direct answers — previously any routed reply silently ended the conversation. Timer disambiguation ("the 5 or 10 minute one?") also now holds the mic open for the full 30 seconds it will accept your pick, even with conversation mode off — no wake word needed to answer.

**"What's the weather tomorrow" actually answers for tomorrow**
Asking about tomorrow now leads with tomorrow's forecast instead of re-reading today's. Weather replies are also cleaner spoken aloud — no more ZIP code or "Source:" footer read to the room.

**Instant phrases can't hijack built-in requests**
A custom skill's instant phrases can no longer claim requests that belong to a built-in — "set a reminder for tomorrow morning" goes to reminders, never to a weather skill that happens to know the word "tomorrow." When a request sits too close to a built-in domain (reminders, calendar, email, timers, home control, messaging, media), the fast-path steps aside and the normal assistant handles it. Skill authors get warned at build time when their phrasings sit too close to a built-in domain.

**Background work announces when it's actually done**
When delegated work spawns further sub-tasks, the device used to say "done" and stop its waiting ring while the sub-tasks were still running — then stay silent when everything truly finished. The announcement and the ring now track the whole job.

**Chat & device polish**
Opening a chat lands you at the latest messages (no more mid-history jumps), the "jump to latest" pill counts how many new messages arrived while you were scrolled up, and sending while disconnected now tells you instead of silently dropping. Voice device cards show Wi-Fi signal strength (flagged when weak) and audio drop counts, so "why does it sound choppy" is answerable at a glance. Provider failover now also catches "overloaded" errors, not just timeouts and 5xx.

**Teach your own instant phrases**
Tell your assistant "when I say *check the deals*, run my Publix skill" and it's learned on the spot — the phrase now triggers that skill's tool instantly on-device, with no cloud round-trip, in chat or by voice. "Forget that phrase" undoes it. Skills you build also get smarter about this on their own: when a custom skill keeps handling the same kind of simple request the slow way, OpenEnsemble notices and offers to make it instant — one tap to accept. And skill authors get guardrails: the skill-builder now auto-merges redundant fast-path intents and warns when two intents' phrasings overlap enough to shadow each other.

**Voice replies speak places and weather naturally**
"Springfield, IL: 76°F, wind 3 mph" is now spoken as "Springfield, Illinois: 76 degrees, wind 3 miles per hour" — state abbreviations, degree symbols, speeds, and slashed number pairs are naturalized before synthesis, for every skill and every agent.

**Calendar follow-ups without repeating yourself**
After a calendar answer, a bare follow-up like "what about Wednesday?" or "and next week?" is answered instantly from the same local mirror — no need to say "what's on my calendar" again. Strictly guarded: the follow-up must name a day or range and must come immediately after a calendar answer, so unrelated follow-ups ("what's in my email?") route normally.

**Background work you can see and hear sooner**
When the assistant hands work to another agent ("I've asked the researcher — I'll tell you when it's back"), the voice device's LED ring now keeps a rotating rainbow going until the result arrives (firmware 0.2.73), so a quiet device no longer looks like something failed. Results are also spoken sooner: completed background work now speaks as soon as the device is quiet — including while it's sitting in a listen window waiting for you — instead of holding for several extra seconds, and the follow-up window re-opens afterwards so you can react.

**Calendar answers in about a second**
"What's on my calendar today", "do I have anything Friday", "what's my next meeting" — these are now answered instantly from a local mirror of your Google Calendar instead of a slow round-trip through the model (voice turns that used to take a minute or more now speak in a second or two). The mirror covers every calendar you have visible in Google, refreshes itself every few minutes, and double-checks with Google right before answering, so an event you just added or cancelled is always reflected — a stale answer is never spoken. Harder questions ("when am I free for two hours next week?") still go to the assistant, which now reads your whole schedule in a single **calendar_snapshot** call instead of listing each calendar one by one. Requires Google Calendar to be connected; everything falls back to the old path if the mirror is unavailable.

**Voice devices: real back-and-forth conversations**
New per-device **Conversation mode** (Settings → Voice devices, or PATCH `conversation_mode`): say the wake word once, and after every reply the device keeps listening for about 8 seconds so you can just keep talking — no wake word between turns. The conversation ends when you go quiet, say something like "stop", "that's all", or "goodbye", or someone else's wake word takes over. Requires voice-device firmware 0.2.65.

**Interrupt a reply just by speaking**
In conversation mode, start talking while the assistant is mid-reply and it pauses to listen. If you were actually saying something, the reply is cancelled and your interjection becomes the next turn; if it was a cough, the TV, or an "um", the reply picks back up right where it paused. Wake-word interruptions still work everywhere, as before.

**Voice replies are harder to break**
A deep reliability pass on the whole voice turn path. Every message between the device and server now carries a turn ID, so leftovers from a cancelled reply can't confuse the next one (this fixes music resuming over you mid-command after a barge-in). The device now recovers within seconds — instead of up to 90, or sometimes never — when the server drops mid-reply, a reply never starts, or an error ends a turn. Follow-up listening windows ("Which one did you mean?") now open when the device *finishes speaking* the question instead of expiring while it's still talking, and soft-spoken answers no longer lose their first syllable.

**Faster voice turns**
With firmware 0.2.65 the device streams your words to the server *while you're speaking* instead of uploading the whole recording afterwards, so transcription starts the moment you stop. The server also stops re-reading device config files on every single turn.

**Music ducks under the assistant's voice instead of stopping**
The device firmware (0.2.68+) gained a real audio mixer: when the assistant speaks over ambient sound or AirPlay, the music now dips smoothly to about 10% volume, the voice speaks on top, and the music swells back — no more abrupt pause and restart. Saying "stop" or "that's enough" during a reply now stops *the reply* and leaves your rain sounds or music playing; a bare "stop" with only music playing still stops the music.

**Background work announces itself when it's done**
If you ask for something slow — an image, a delegated task — the assistant says "On it, give me a moment," the LED ring switches to a rotating rainbow so you can see work is happening, and the microphone comes back to you during the wait. When the work finishes, the result is spoken as a one-line announcement the next time the device is quiet (ducking over any music), even if you've asked other questions in between. Saying "stop" mid-task now cancels the whole chain, including the specialist doing the work.

**Voice replies sound like a person, not a screen reader**
Spoken replies no longer read out URLs, calendar event IDs, or emoji — those are stripped before synthesis (the full text stays in your chat). Dates and times are spoken naturally: "Saturday, July 4th, 2026, 5 AM to 8 AM" instead of "Sat, Jul 4 · 5:00 AM–8:00 AM". List-style content gets natural pauses between items instead of running together. Voice turns can also read your calendar directly now, and always know today's actual date.

---

## 2026-07-03

**Replies start faster, and voice replies stop pausing mid-thought**
A round of performance work across the whole turn path. The fixed setup cost before every reply (memory recall, tool selection, context building — previously run one after another) now runs in parallel, cutting it to roughly a third. On voice devices, the next sentence of a reply is now synthesized *while* the current one is still playing, so longer answers no longer have awkward silent gaps between sentences. Long conversations also stop re-sending every old tool result with every message, which keeps more of your actual conversation in the model's context and makes long sessions cheaper.

**The app stays responsive while background work streams**
While a delegated/background task was streaming progress, the browser fired a task-list refresh (two requests plus a full drawer re-render) for every progress update, and the server rewrote the whole watcher file for each one — with enough updates this made everything feel sticky. Progress updates now batch (the drawer refreshes at most every couple of seconds, immediately when something finishes), the tool-activity panel only re-renders when it's actually open, and the tool-suggestion bar under the composer no longer re-scans on every keystroke. Server-side, scheduled-task bookkeeping now touches only the affected user's file instead of rewriting every user's tasks on each fire.

**Email sorting and large code projects: less waiting**
Sorting a big inbox re-read the learned label store once per email (200 emails = 200 reads of the same file) — it's now read once per change. For IMAP accounts, message previews fetch only the first 2 KB instead of entire message bodies, and operations reuse one connection instead of a fresh login per action. The Code Projects pane also stops freezing the server while it sizes up large projects.
The 🌐 Everyone button on document sharing looked like it worked, but other users could never see or open the document — the share was recorded on the file yet never entered the discovery list, so it silently behaved like "share with nobody". Everyone-shares now show up (and open) for every user, existing everyone-shared documents are repaired automatically, and un-sharing removes both visibility and access as expected.

**Cloud replies retry through brief provider hiccups; token/cost metrics stop reading zero**
A momentary provider overload (the classic Anthropic 529, a 429 rate-limit, or a dropped connection) used to fail the whole turn immediately. All cloud providers now retry the request a couple of times with short waits (respecting the provider's requested back-off) before giving up — nothing double-executes, since only the initial request is retried. Separately, token usage for OpenAI-compatible providers and OpenRouter was always recorded as 0 (the usage report was never requested, and when present it arrived after the point the stream stopped reading); real input/output/cached-token counts now land in your usage metrics. Claude models routed through OpenRouter also get prompt caching now (20–40% cheaper long conversations, same as the direct Anthropic path), local models via Ollama no longer lose the second tool call when the model fires two at once, and screenshots/generated images now reach LM Studio vision models instead of a "can't see images" note.

**Chat stays where you're reading while a reply streams**
Scrolling up to re-read something while the assistant was still typing used to be impossible — every token yanked the view back to the bottom, several times a second. Now the chat only follows the stream while you're already at the bottom: scroll up and it stays put, with a **↓ Jump to latest** pill you can tap to catch back up. Sending a message or switching agents still lands you at the latest message. Streaming is also much smoother in long replies (the whole message no longer re-renders on every token), and you can select text mid-stream without losing the selection. *(If you updated earlier today: the pill initially showed but ignored clicks — it was rendering underneath the chat layer. Fixed; hard-refresh the tab after updating.)*

**Long chats load faster and stop bloating the tab**
Very long sessions used to render every message on every update, which made switching to a busy agent slow and let long-lived tabs eat memory. The chat now renders the most recent 150 messages with a **Load earlier messages** button at the top — click it to page further back without losing your place. Generated-image memory is also reclaimed when bubbles re-render, so image-heavy chats no longer grow the tab's footprint over time.

**Stop and errors no longer tangle the next reply**
After pressing **Stop** (or after a turn failed), the next reply could get glued onto the aborted bubble. Both now finalize cleanly: what streamed before the Stop stays as its own message, and the next reply starts fresh. A connection blip mid-reply also no longer leaves the text painting into a bubble that's no longer on screen.

**Voice-device dropdowns save on every input method**
In Settings → Devices, picking a voice, wake word, or user with the keyboard (or on many phone pickers) silently didn't save — only mouse clicks did. All the slot dropdowns now save on the actual change, whatever input method you use.

**Tutor quizzes: switching agents mid-answer no longer eats the reply**
Answering a tutor widget (quiz, flashcard…) and switching agent tabs before the response finished used to swallow the reply — and could swallow the *next* reply too. The response now survives the switch and shows as a normal message when you come back.

---

## 2026-06-08

**Removing a voice user now frees its slot and wipes the wake word off your devices**
Voice devices give each user in your Global Voice Configuration a wake-word "slot," numbered by the order they're listed. Removing someone used to leave a hole: the people below them kept their original slot numbers, and the removed user's wake word stayed loaded in the device's memory — so it could still fire until you happened to reassign that slot. Now removing a user **packs everyone up a slot** (so a list of Alex, Test, Jordan with Test removed becomes Alex = slot 0, Jordan = slot 1) and **clears the freed slot off every paired device**, deleting its wake word from the device's storage so it stops responding immediately (online devices right away; offline ones the next time they connect). The push happens automatically when you remove a user — no separate Push click. (Requires firmware ≥ 0.2.48; older devices keep the previous behavior until they update.)

---

## 2026-06-07

**Reset a voice device's Wi-Fi from the app**
Moving a voice device to a different Wi-Fi network used to mean re-flashing it over USB (the saved Wi-Fi lives in NVS, which re-flashing preserves). Now there's a **⟳ Reset Wi-Fi** button on each online device in Settings → Devices: it tells the device to wipe its Wi-Fi/pairing and reboot into its setup AP (`oe-voice-XXXX`), so you can join that and enter the new network — no computer, no button-fishing. Because the device comes back as a fresh pairing, OpenEnsemble also **removes it from your device list** when you do this (it reappears once you re-pair it on the new network). Wake-word models on the device are kept. (Requires the device to be online to receive the command, and firmware ≥ 0.2.44.)

**Routines: announcement finishes before ambient sound starts**
In a routine that both says something and plays an ambient sound, the sound used to start while (or before) the spoken announcement played, talking over it. Now the routine speaks its reply first and only starts the ambient sound **after the announcement has finished**, so you actually hear it. Applies to voice-triggered routines, the Test button, and webhook/NFC fires.

---

## 2026-06-06

**Pick which GPU runs local Speech-to-Text**
On a machine with more than one NVIDIA GPU, the local Faster-Whisper STT service used to always grab the default GPU (device 0) — a problem if you wanted that card free for something else, like training a model. Settings → Providers → STT now shows a **STT GPU** picker (when you're on the GPU profile and have 2+ GPUs): choose which card Faster-Whisper runs on, and OpenEnsemble re-pins the service and restarts it (~15 s). The choice survives reboots and reinstalls. Single-GPU and CPU setups don't see the picker — nothing changes for them.

**Voice device settings: edit freely, push when ready**
In Settings → Devices, changing a voice device's wake word, voice, cutoff, or avg cutoff used to update your device over-the-air on *every* change. Now those edits just **save** — your device only receives them when you click the new **Push** button (now next to the **Avg cutoff** field). If you were used to changes taking effect on the device automatically, this is the difference: tweak everything you want, then Push once. It also stops the device's wake word from reloading on every keystroke, which could leave it on a stale model until a restart.

**ElevenLabs speech-pace slider**
ElevenLabs' fast default cadence — especially the low-latency Turbo model — could make spoken replies sound rushed or sped-up. There's now a **Speech pace** slider under Settings → Providers → TTS that appears when ElevenLabs is selected: slide it down (toward 0.7) to slow speech to a natural pace, or up toward 1.2 to speed it up. It defaults to 0.85, which fixes the rushed delivery out of the box. (Piper already had its own pace control; now both providers do.)

---

## 2026-06-03

**Skill proposer stops false-firing on shared utility tools**
The auto-skill proposer used to skip any candidate that shared even one tool name with an existing custom skill — so a five-tool workflow that happened to use `web_search` would never get proposed if you also had a tiny `web_search`-using skill installed. Now it computes per-skill Jaccard overlap and only treats ≥50% shared tools as a duplicate. When real overlap is detected, it also checks usage telemetry: actively-used skills (3+ invocations) block proposals as before, but dormant skills (zero invocations, >7 days old) and fresh skills (recent, untried) are tracked with distinct reason codes so future "want to revive your unused skill X?" prompts have a hook.

**Skill-builder catches type errors, manifest/code drift, AND runtime crashes before code lands**
When the coder creates / updates / patches a custom skill, the new code goes through three pre-write gates: a TypeScript type-check (wrong import depths, forgotten `ctx` parameter, missing `await` on async helpers, CommonJS leftovers); a manifest/code consistency validator that catches the silent failure where manifest.json declares tool `weather_lookup` but execute.mjs handles `get_weather`; and a per-tool smoke runner that actually invokes every tool the manifest declares with generated args, catching handler crashes, wrong-typed returns (object instead of string), hangs (3s timeout per tool), and silent arg-name mismatches. Tools that legitimately can't be smoke-tested (sends email, deletes things, smart-home actions) get a `destructive: true` annotation in the manifest and are skipped with a warning instead of being invoked. All three gates run together so one fix-and-retry handles every bug class. Strict default: any error blocks the write; warnings surface in the success message. Separate `skip_lsp` / `skip_validator` / `skip_smoke` flags let the coder bypass one gate precisely when another is the legit catch. Infrastructure failures (TS missing, smoke timeout on a tool's own internal sleep) never block.

**MCP (Model Context Protocol) — local, remote, and OAuth**
You can now plug any Model Context Protocol server into OpenEnsemble — local subprocesses (stdio), remote HTTP servers, and OAuth-protected remote servers. New **Settings → MCP** tab with a Browse catalog button (10 popular servers pre-filled with their package name + required secrets), live status badges, and conversational management through your coordinator (`mcp_list_servers`, `mcp_add_server`, etc.).

Each user manages their own MCP servers — no cross-user sharing. If two users in a household want the same integration (Calendar, GitHub, etc.), each adds it with their own credentials. This keeps the user-isolation boundary clean; one user's token never powers another user's agent call.

For remote servers that require OAuth (Cloudflare and others): pick `http` transport + `OAuth` authentication when adding, click **Authorize** on the server card, complete the consent screen in the popup that opens. Tokens are stored encrypted under your account and refreshed automatically. Headers-based auth (Personal Access Tokens etc.) remains for everything else.

**Cheaper, faster turns via prompt-cache tiering**
The system prompt your agents send to the model is now split into three layers — a stable persona+tooling layer, a per-turn skill SPA layer, and a volatile layer with the date and one-shot notes. On Anthropic models, each layer gets its own cache marker so the bulk of the prompt is reused turn-to-turn instead of being re-sent. On OpenAI models, the same reorder lets OpenAI's automatic prefix cache hit on more of the prompt. Verified: a follow-up turn on Sydney hit 36% prompt-cache the first time the tier path activated. The tool-router also now puts always-on tools at fixed leading positions in the tools list and appends per-turn-matched tools at the end, so the cache hits the tools block too. New `[provider] cache: mode=tiered hit=N%` log lines surface the hit rate.

**Quieter `node_exec` results for the LLM**
When an agent runs `apt`, `pip`, `docker pull`, or similar on a remote node, the live stream you see in chat is unchanged — but the version of the output the LLM reads at the end is now noise-stripped (download progress, per-package "Setting up …", layer-pull chatter, progress bars). Typical apt install drops from ~5KB to ~500 bytes of tool result. If the cleaned output is still over the cap, head + tail are kept (instead of head-only) since the meaningful "did it succeed?" line usually lives at the end.

**Save or discard chat attachments after the reply**
Before today, every file you dropped or pasted into chat — images, PDFs, audio, video — silently persisted to your profile files forever, even if you only meant to ask one question about it. The ✕ on the preview pill only cleared client state; the file stayed on disk. Now after each turn that had an attachment, a small "Keep `foo.png` in your files?" bar appears with **Keep** and **Discard** buttons. Keep is a no-op (the file is already saved). Discard deletes it from your profile-files folder, and for documents it also prunes the entry from your docs index so it stops showing up in `list_profile_files`. The prompt fires for everything uploaded via drag-drop, paste, OR the attachment button, but not for voice-device turns (no screen) or routine follow-ups (the original turn already prompted). If you ignore it, the file stays — no expiration sweep.

**Specialists can now escalate to the coordinator**
Until today, only the coordinator could call `ask_agent`. If you asked a specialist for something just outside its domain — "send me an email of the latest videos from my channels" to your YouTube agent, for instance — it would respond with "I can't email" and stop. Now every specialist has `ask_agent` restricted to one target: `coordinator`. The specialist does its part of the work, then escalates with a task description that includes what it gathered, and the coordinator routes the remainder to whoever can finish (the email agent, the coder, etc.). Two safeguards prevent chains from spiraling: max delegation depth is 2 hops, and specialists can only escalate up (never to another specialist directly). The coordinator's full delegate roster is unchanged.

**Background-task replies stay around after a reload**
When an agent delegated work to a specialist in the background, the specialist's final reply used to render as a tagged bubble for the rest of the session — but on a browser refresh it would either disappear or render as a flat assistant message with a `[<name> finished in background]` prefix and no sender styling. Now the persisted entry carries enough metadata that the same tagged bubble renders on reload, with the agent name in the header and the body cleaned up. The bubble also has a height cap with internal scrolling, so a long reply (e.g. "top 3 videos from each of N channels") no longer pushes the rest of the conversation off-screen. Older entries from before this fix get the same treatment retroactively via prefix detection.

**Settings → Skills now separates Roles, Custom Skills, and Tools**
Three independent sections instead of one mixed list. Custom skills (the ones you or your coder built) live in their own section with an agent-picker dropdown per skill, so you can see at a glance who owns what and reassign in one click. Built-in tools (Web Search, Task Scheduler, Profile Files, etc.) are listed below, with a clear "available to any agent" label. A handful of internal capabilities — Active Agents, Skill Builder — are now bundled with the coordinator and coder roles respectively and no longer appear in the Tools list (they were never user-assignable in any meaningful way, and listing them confused things).

**New-agent and `/claim` pickers now show custom skills**
When you create a new agent, the Role dropdown groups choices under "Roles" and "Custom skills" — picking a custom skill assigns it to the new agent immediately, transferring ownership from whoever held it before. Same fix applies to the `/claim` / `/release` slash-command picker in chat: typing `/claim ` now shows both roles and custom skills, each tagged with their kind and current owner. Typing `/claim` with no argument lists everything that's assignable so you can browse.

**Coordinator always sees a full roster of your agents**
"Who are my agents?" used to miss any agent you created after your coordinator was first set up — because the coordinator's stored system prompt was written before the dynamic-roster feature shipped. Now the roster is auto-appended on every turn for any agent whose primary role is `coordinator`, regardless of what the stored prompt says. Includes unassigned agents too (a newly-created "Test" agent shows up immediately, even without any skills).

**Agent description edits no longer revert**
Editing an agent's description and saving used to look successful but the value would re-render to the old text on the next load — the PATCH route's allowlist silently dropped the `description` and `systemPrompt` fields. Fixed; both fields now persist, and changing the description also rebuilds the agent's stored system prompt so the new wording reflects in the agent's behavior on its next turn.

**HA "turn on X" no longer matches entities named "<X> None"**
A handful of HA integrations create entities whose `friendly_name` ends in the literal word `None` (a misconfigured subentity label that the integration stringifies as Python's `None`). When you said "turn on window ac", the fast-path could match `Window AC None` instead of your real window AC entity, fire `turn_on` on the wrong device, and report success even though nothing happened. These entities are now filtered out of the fast-path index at load time, so the resolver picks a properly-named sibling (or misses and falls back to the LLM, which lists devices and asks you to confirm).

**Skill Builder now keeps the manifest in sync with the code**
A new `skill_update_tool_def` tool lets the skill author update one tool's `description` or `parameters` in an existing skill's manifest without rewriting the whole file. Crucially, the skill-builder system prompt now requires this call any time a code patch changes what a tool returns or what arguments it accepts — without it, the calling agent reads the stale description, doesn't trust the new behavior, and either reproduces the work with generic fallback tools (`fetch_url`, `web_search`) or skips the change entirely. End-result: when you ask the coder to update one of your custom skills, the next time the owning agent calls one of its tools, it actually uses the new behavior instead of working around it.

**Voice-device firmware 0.2.36: quieter serial log (developer)**
The wake-word `audio_lvl=…` periodic stats line moved from INFO to DEBUG. Same data still streams server-side via the wake_avg_prob telemetry channel; the local print was clutter at the default log level. No user-visible behavior change — only relevant if you've been watching serial output.

**Voice-device firmware 0.2.35: bigger task stacks + per-task stack diagnostics**
Voice devices were occasionally panicking after long uptimes with a FreeRTOS `vApplicationStackOverflowHook` trap — typically when several heavy audio paths (TTS playback, ambient streaming, wake interruption) chained in quick succession. The mp3 decoder + audio resampler combined can carry ~5-6 KB of stack frames, and a few tasks were sized at 4 KB or 8 KB — close enough to the limit that an unlucky deep call would tip over. Bumped five tasks (`tts_worker`, `drive`, `ambient_w` to 12 KB; `audio_play`, `audio_cap` to 6 KB; `hb` to 4 KB) and added per-task stack-high-water-mark logging to the heartbeat task (`[hb] stack hwm ...`) every minute so future overflows can be pinned to a specific task name. (0.2.34 shipped the diagnostic but blew the heartbeat task's own stack — 0.2.35 fixes that.) Update via the Devices drawer when a paired device shows 0.2.35 available.

**Custom skills now belong to one agent — pick which one in Settings**
Specialists used to silently inherit every custom skill you'd ever built — so an email specialist might end up with 70 tools in its context even though only 13 were email-related. That bloated every turn and made the LLM more likely to grab a wrong tool. Now each custom skill is assigned to exactly one agent, and only that agent sees its tools. Settings → Skills has a new "Custom skills" section with a dropdown per skill — pick the agent that should own it (defaults to your coordinator). You can also chat with an agent and say `/claim <skill-id>` to move a skill to it, or `/release <skill-id>` to clear the assignment.

If you're updating from a previous version, all of your existing custom skills get auto-assigned to your coordinator on first boot — nothing disappears, but if you had a custom skill that you specifically wanted on a specialist, move it via the new Settings UI or `/claim` it from a chat with that agent.

**Aliases — say "the kitchen lights" once, OE remembers it**
OpenEnsemble now learns the names you use for things. Reference a skill, agent, node, email account, project, or watched YouTube channel by a friendly name — e.g. "ask the researcher", "the pihole server", "my work email", "the side project repo", "any new videos from that channel I added last week" — and the coordinator skips the usual list-then-filter dance and goes straight to the right tool with the right id. Aliases auto-save the first time they're resolved (so the second mention is instant) and cascade-delete when the underlying thing is removed. If the LLM asks "did you mean X?" and you reply "yes", that learns the alias too. Custom skills with their own catalogs can opt in via a small `alias_catalog` block in their manifest — Skill Builder knows the pattern.

**Routine HA actions no longer hang on slow Home Assistant**
Routines that touch Home Assistant (like the `goodnight` routine doing `light.turn_off entity_id=light.all`) used to block up to 15 seconds per action when HA was slow to acknowledge — typical when one call expands to many bulbs. Now those calls are fire-and-forget: OE waits 1.5 s for transport-level errors (HA actually down) then moves on, treating slow responses as "queued, will finish async." Same change applies to the HA fast-path ("turn off the kitchen lights") so you get an immediate spoken confirmation instead of a 15-second silence followed by a confused LLM paraphrase.

**Ambient sound resumes on its own after a wake interruption**
If you say a wake word while ambient audio is playing (rain, white noise, sleep sounds from the goodnight routine), the firmware interrupts playback so it can listen. Previously the ambient stayed off after the wake handler completed — even if no new ambient was started by the resulting turn. Now the server snapshots the device's ambient state at the start of a voice turn, and if nothing this turn started or explicitly stopped ambient, the same stream resumes ~3 seconds later (long enough for any TTS reply to finish first).

**Voice-device firmware 0.2.33: end mp3 decoder pitch glitches**
Two related fixes for the brief audio glitches some users heard on long ambient playback:
- libhelix occasionally mis-parses an mp3 frame header during network jitter and reports a phantom sample rate (22050 or 32000 on a 44100 file — caused by a flipped MPEG-version bit). The firmware now locks the stream rate on the first valid frame and ignores subsequent rate reports, so a brief misparse no longer plays the recovery buffer at the wrong pitch.
- The same lock pattern applies to TTS playback — covers different providers cleanly (Piper 22050, OpenAI 24000, ElevenLabs 44100), resets between sentences so a provider switch picks up the new rate.

Update via the Devices drawer when a paired device shows 0.2.33 available.

**Routine editor: long ambient filenames no longer overflow the panel**
The play_ambient action's filename dropdown stretched its grid column to fit the longest option, pushing the whole routine editor off-screen for files with long names. Constrained to its container width with a hover-tooltip showing the full filename.

**install.sh: ffmpeg now detected on existing-tool systems**
A fresh install on a system that already had build-essential, python3, etc. would skip the ffmpeg install entirely (the detection loop didn't check for it), then Voice Devices would later complain `ffmpeg is not installed`. ffmpeg + openssl now in the detection list alongside the other tools.

---

## 2026-06-02

**Voice devices: spoken time/date, false-fire gating, and clearer auth errors**
A handful of voice-device polish items shipped together:
- "What time is it?" / "What day is it?" now answers in natural spoken form on voice devices ("two fifteen P.M.", "Tuesday, June second") instead of digits-and-colons. Browser and Telegram chats keep the existing compact format. Also fixes a regression where Faster-Whisper's trailing period was breaking the trivia fast-path — any phrasing that worked before still works, plus the punctuated variants STT produces.
- New **Avg cutoff** field on each wake-word slot in Settings → Voice devices. It's a server-side gate on the firmware's rolling-window average probability — useful for filtering brief cross-fires (e.g. a different slot's wake firing on a TV or on your own TTS playback). Leave blank to disable, or set 0.85–0.95 to drop marginal fires while keeping confident ones. Set independently from the existing peak cutoff.
- If your coordinator's LLM provider rejects its credentials mid-turn (session revoked elsewhere, refresh token expired, etc.), the device now speaks "Your coordinator's provider needs to be reauthenticated. Please reconnect it in Settings." instead of going silent. OpenAI/ChatGPT OAuth specifically tries one auto-refresh first — if upstream truly revoked the session, you get the spoken reconnect prompt rather than a hung chat.

**Local Faster-Whisper STT — keep transcription private and offline**
Speech-to-text now has a local option alongside the existing remote-API one. Settings → Providers → Speech-to-Text has a top-level **Provider** dropdown: pick **Remote API** for OpenAI/Groq/etc. or **Local — Faster-Whisper large-v3-turbo** to run on this server. Local mode offers two profiles you choose at install:
- **CPU profile** — large-v3-turbo int8, ~810 MB on disk, ~2 GB RAM at runtime. Works on any system without a GPU. Speed varies by CPU: modern desktops run ~2-3× real-time; older laptops/SBCs land near real-time.
- **GPU profile** — large-v3-turbo float16, ~810 MB model + ~2 GB NVIDIA CUDA libs (auto-installed via pip into a dedicated venv), ~2.5 GB VRAM. Requires an NVIDIA GPU + driver (installer fails fast with a clear error if `nvidia-smi` isn't present). 14-40× real-time. Not supported: AMD/Intel GPUs and macOS — use CPU profile there.

Switching between CPU and GPU re-runs the installer (1-2 min); switching between Remote and Local preserves your API credentials for next time so you can flip back without re-entering them.

**Transcribe audio and video in chat**
Drop an audio or video file into the chat and say "transcribe this" — the transcript comes back without an LLM round-trip (the fast-path runs your configured STT directly). Supports common audio formats (wav, mp3, flac, ogg, m4a, aac, opus) and video formats (mp4, mov, mkv, webm, avi — audio is extracted via ffmpeg first). 500 MB upload cap; the previous 10 MB cap that blocked large videos has been lifted. If your STT isn't configured, the request falls through to the coordinator instead of erroring silently.

**Audio is now its own profile folder**
Chat-uploaded audio used to land in your Documents folder mixed with PDFs and CSVs. Now it goes to a dedicated **Audio** folder (alongside Images and Videos), with its own tab in the Docs drawer and an inline player so you can preview clips without opening a viewer. Existing files in Documents stay where they are.

**`@-mentions` in chat: agents and files**
Two new chat-input behaviors. Type `@` and an autocomplete menu drops in:
- `@<agent-name>` routes the message to that agent and auto-switches your active chat tab to theirs. Works from any agent's chat panel — useful for quickly delegating without opening a different drawer first.
- `@audio/foo.wav`, `@video/clip.mp4`, `@image/sunset.png` references a file already in your profile folders. Tab-completes to the exact filename and the server resolves it to an absolute path so transcribe (or any path-aware tool) can act on it. Typing `@a` shows both any agent whose name starts with `a` and the `audio/` folder as completion options.

`@audio/<file> transcribe this` fires the transcribe fast-path on your saved files the same way attaching a fresh file does.

**Wake-word false-positive recovery**
When a voice device fires a wake word on noise (TV, a cough, a sentence ending in the wake word) and the STT comes back empty or near-empty, the device used to sit in THINKING forever waiting for a reply that never arrived. Now a server-side fast-path catches these and replies *"I'm sorry, I didn't catch that"* so the device immediately returns to listening. Doesn't pollute your chat history — false-positive wakes don't appear as turns.

**Speech pace slider for Piper voices**
Settings → Providers → Text-to-Speech → Piper has a new **Speech pace** slider when Piper is installed. Range 0.80×-1.50× (Piper's default is 1.00×; OE ships at 1.10× because the VITS voices read a little fast for most listeners). Saves on release so the next TTS call uses the new pace immediately.

**Piper TTS goes multi-voice with a downloadable voice catalog**
Piper now runs as a multi-voice service instead of being locked to a single model at install time. Settings → Providers → Text-to-Speech → Piper shows a catalog of voices you can download independently — including a custom OpenEnsemble Australian female voice (`en_AU-OE_custom-medium`) hosted on our HuggingFace repo, plus seven popular voices from the public Piper catalog (Amy, Lessac, Ryan, LibriTTS-R, Alba, Jenny, and Cori-high). You pick which voice to install when you first set up Piper; additional voices download independently from the same catalog. The service hot-picks new voices up without a restart. In Voice Devices, each slot now has a dropdown of installed Piper voices instead of a numeric speaker ID, so different users / different wake-word slots can talk in different voices simultaneously. Multi-speaker voices like LibriTTS-R get an extra speaker-id field after voice selection. Existing numeric voice values keep working — they're auto-mapped to LibriTTS-R behind the scenes.

**KittenTTS — a tiny local TTS option for machines without a GPU**
A new text-to-speech provider lands alongside OpenAI, ElevenLabs, and Piper. KittenTTS is a 25 M-parameter ONNX model that runs on CPU — no GPU, no API key, ~50 MB total install. It ships 8 preset voices (`expr-voice-2-f` through `expr-voice-5-m`); voice cloning is *not* supported, which is the trade-off for being so small. Quality is functional, not class-leading — the right pick when the alternatives are "pay for a remote API" or "buy a GPU". Three ways to install: tick the prompt during a fresh `install.sh`, click "Install KittenTTS" in Settings → Providers → Text-to-Speech, or ask the coordinator ("install kittentts on this server").

---

## 2026-05-31

**Voice-friendly email output**
When you ask a voice device about your latest email or have one read aloud, the reply no longer recites IDs, dates, thread IDs, or "→ summary" prefixes that the email formatting rules tell the model to include on web. The response just states the sender, subject, and a short summary, with long bodies trimmed so the device summarizes instead of reading the whole message verbatim. Message IDs are still in the tool result for follow-ups ("trash it", "reply to that") — they're just no longer spoken.

**Skills can now poll automatically and notify by voice, email, or Telegram**
A new monitoring primitive lets any skill — including ones the skill builder writes for you on demand — set up a recurring check on an external source (a feed, a page, a price, a queue, an inbox) and notify you when it changes. The skill picks a cadence preset (`minutely` / `5-min` / `hourly` / `daily` / `weekly`) and a delivery mode. The default runs a coordinator turn so it can speak the news on a voice device. Email delivery sends from your connected Gmail / Outlook / IMAP account directly to your inbox — zero AI tokens spent composing it. Telegram delivery messages you via your linked bot chat — also zero tokens. Switching delivery on an existing watcher works the same way: ask again with the new preference and the old registration is replaced so you don't end up with duplicates.

**Skill builder learned the monitored-source pattern**
When you ask for a recurring watcher ("make a tracker for [thing]", "ping me when [source] changes", "watch [feed] for new posts"), the skill builder now scaffolds a four-piece proactive skill in one shot: a fetcher for the source, an appropriate cadence (weekly for store ads, hourly for channels, fast for prices), a filter that reads your stored preferences from memory so you only hear about items you care about, and a notification path of your choice. No more manually wiring up polling, filter logic, and delivery each time you describe a watcher.

**Auto-offer monitoring on the kinds of questions you ask repeatedly**
When you ask the coordinator something time-varying ("any new uploads from [channel]?", "what's on sale at [store]?", "is [thing] back in stock?", "did [person] post yet?"), the coordinator now recognizes the shape of the question and offers — after answering — to set up automatic monitoring. Decline once and the offer goes away for that turn; the next topical question will offer again. Recognized via a small embedding classifier, no extra AI round-trip.

**See what other agents are doing**
Asking the coordinator "is [agent] still working?" or "what's [agent] doing?" now returns concrete detail: which background dispatches are in flight, the task they were given, which tool they're currently running, and how many tools they've used. The activity panel in the corner of the chat also shows live "running [tool name]" updates as background agents work, replacing the static spinner that was there before.

**AirPlay pause / resume reliability + iPhone UI sync (firmware 0.2.28 – 0.2.29)**
Voice-pausing AirPlay music now both updates the iPhone Music app to show "Paused" AND locally mutes the speaker as a safety net. The hybrid means voice-resume works reliably even after long pauses (the local-mute side stays good even if iOS would otherwise tear down the stream), and tapping pause in the iPhone Music app silences the speaker within ~10 ms instead of waiting for the local audio buffer to drain. Devices on 0.2.27 or older will auto-OTA to 0.2.29 on their next chat round-trip; USB flash also works.

---

## 2026-05-28

**Voice control of AirPlay sessions (firmware 0.2.24 – 0.2.27)**
While AirPlaying music to a voice device, you can now say "hey [coordinator] skip" / "next song" to advance, "back" / "previous" to go back a track, "pause" / "play" / "resume" to pause and resume, and "stop" to end the session. The device sends control commands back to the iPhone / iPad / Mac that's streaming, so the music app reflects the new state (paused, advanced track, etc.) within a fraction of a second. Resume sends both `playresume` and `play` so it works regardless of iOS version. Voice control works in headphone mode too — the wake word fires during music playback, the LED responds immediately, and audio resumes cleanly on play.

**Headphone mode for voice devices (firmware 0.2.21-headphone)**
A new per-device "headphone mode" setting that, when on, keeps the speaker amplifier disabled and routes audio out through the 3.5 mm jack only. This lets the wake word stay sensitive while music plays — the device's normal wake-during-music suppression is a side effect of the amplifier being on, so muting the internal speaker preserves wake-word detection on headphone listening. Toggle by saying "headphones on" / "headphones off" to a voice device, or via PATCH `/api/devices/<id>` with `{"headphone_mode": true|false}`. Persisted across reboot. Internal-speaker case is unchanged.

**Wake word fires faster during music playback (firmware 0.2.22-cutoff)**
When the device is actively playing audio (TTS, AirPlay, ambient), per-frame wake probability builds slower because the I²S audio bus is busy. The device now temporarily lowers the wake-word probability cutoff while playback is active and snaps it back the moment playback ends — restoring first-try wake during music without affecting idle-room sensitivity or false-positive characteristics.

**LED responds the instant the wake word fires (firmware 0.2.23-led-first)**
Before, the LED ring switched to LISTENING only after the device finished its barge-in cleanup (pausing AirPlay, flushing audio buffers, sending the WebSocket stop signal). That cleanup includes a network write that can stall 50–500 ms depending on connection state, so the LED visibly lagged the wake. The visual ack now fires first; cleanup happens after, off-screen.

---

## 2026-05-27

**AirPlay no longer goes silent after a wake-word conversation (firmware 0.2.20-airplay)**
If you used the wake word + had a conversation with a voice device, then tried to AirPlay to it, the device would often play nothing — the speaker stayed muted and the device looked asleep. Root cause: the speaker amplifier is enabled only around text-to-speech replies and then disabled when TTS finishes (to keep wake-word detection sensitive). AirPlay was never asking for it back, so the first AirPlay session after any conversation played into a muted speaker. The AirPlay receiver now turns the amp on as soon as audio frames start arriving and releases it on session end, so AirPlay-after-conversation just works.

**AirPlay volume slider now controls the voice device (firmware 0.2.16-airplay)**
Adjusting the volume from iOS Control Center / lock screen / Apple Music while AirPlaying to a voice device now changes the device's actual playback volume in real time. Previously the slider moved on screen but the device kept playing at its own volume. The new value applies for the rest of the AirPlay session only — when iOS disconnects, the device returns to whatever volume it was at before (or whatever you last set via voice command), so leaving an AirPlay session at very low volume won't leave the device effectively muted next time.

**Voice device network responsiveness hardening (firmware 0.2.17 – 0.2.19-airplay)**
Defensive Wi-Fi changes shipped alongside the AirPlay work above: the radio is now pinned to always-on after every reconnect (not just at boot), the IDF default that drops the radio into low-power mode on disconnect is turned off, the DTIM listen interval is set to its minimum, and NTP polls every 30 s to keep the AP-side forwarding table warm. None of these were the actual "AirPlay silent" cause — that was the amplifier above — but they reduce the odds of intermittent OE WebSocket / mDNS hiccups under flaky Wi-Fi. Devices on 0.2.15-airplay or newer auto-OTA to 0.2.20 on their next chat round-trip.

**Active monitors: node health collapsed into one row**
If you have several nodes paired, each one was registering its own row in Active monitors and burying the rest of your watchers. They now collapse under a single "🖥️ Node health · N nodes" row at the top of the section. Click it to expand and see / cancel / extend individual nodes; all the per-node controls still work exactly as before, just behind one click instead of crowding the list.

**AirPlay pause/resume reliability (firmware 0.2.15-airplay)**
Pausing an AirPlay stream from iOS — Control Center, lock screen, or just stopping inside Apple Music — and then hitting play used to produce a few seconds of robotic / clipped audio before things stabilized, especially after pauses longer than half a minute. Renaming a voice device during playback could also drop the stream and bring it back glitchy. Both are fixed: the receiver now re-handshakes timing with iOS on every pause and the audio resampler resets its phase state at the right moment, so resume sounds clean from the first sample. A rename mid-stream no longer races two decoders against each other. Devices on 0.2.13-airplay will auto-OTA to 0.2.15-airplay on their next chat round-trip (or reboot to force the pull).

**Tailscale integration in Settings**
Settings → System → **Private Mesh (Tailscale)** is a new panel right beneath Public Access (Cloudflare Tunnel). Shows whether Tailscale is installed and running on this host, the assigned tailnet IP (with copy button), and your MagicDNS name. Two ways to set it up: paste a reusable auth key + sudo password directly in the panel for a one-click install, or click "Ask the coordinator instead" to drop into chat with the install request prefilled — same recipe runs either way, with the same audit log + one-click revert. Owner/admin only.

**Rename voice devices live**
Edit a device's name in Settings → Voice devices (click the name at the top of any device card) and press Enter — the new name is saved, pushed to the device, and the AirPlay picker label on iOS updates within ~5 seconds. No reboot needed, and an active music stream isn't interrupted by the rename.

**Voice devices are now AirPlay receivers**
Paired voice devices (XVF3800 + ESP32-S3 with firmware 0.2.13-airplay or later) show up in your iOS Control Center → AirPlay picker as the device name you set in Settings → Voice devices. Cast Apple Music, Spotify, YouTube Music, or any iOS system audio to one and it plays through the speaker — at full 44.1 kHz CD quality via Apple's ALAC codec. Saying your wake word during music pauses playback for the conversation and resumes after the reply. Music keeps playing through brief network blips because the device buffers ~9 seconds of audio in PSRAM. Devices need to be on the same Wi-Fi network as the iOS device. After updating, reboot the voice device so the new firmware loads — paired devices will auto-OTA on their next chat round-trip.

**Inbox drawer: back button now returns to the email list**
After opening an email in the Inbox drawer, clicking the **←** back button would show "Failed: internal error" instead of returning to the message list — clicking the account tab refreshed it. Affected all providers (Gmail, Microsoft, IMAP) though Microsoft and IMAP users hit it most. The refresh **↻** button in the same toolbar had the same defect. Both now work as expected.

---

## 2026-05-26

**CRITICAL fix: bulk user-save no longer wipes the master-key file**
A pre-existing bug in the bulk-user-save helper would `rm -rf` any subdirectory of `users/` that wasn't a current user — including the system-only `users/_system/` directory that holds the master key used to encrypt your API keys in `config.json`. Triggers included `/claim` in chat, setting a news preference via chat ("only show me science news"), renaming an agent via chat ("call yourself Iris"), and any admin user-management action. If you've ever lost API keys after typing one of those, this was why. After updating, those actions are safe. If your `config.json` already has encrypted blobs that won't decrypt, you'll need to re-enter the affected keys in Settings → Providers; there's no way to recover them without a backup of the original `users/_system/.master-key` file.

**Providers added by OE Admin show up in Settings + the model picker**
When you (or any OE Admin–assigned agent) add a new OpenAI-compatible provider via the OE Admin tools, it now renders as its own provider card under Settings → Providers and appears as a labelled group in every agent's model dropdown — alongside the built-in providers. Previously the provider worked in chat dispatch but was invisible to the UI, so users couldn't actually select its models for their agents.

**Voice routines now have webhook triggers**
Every routine gets its own webhook URL. Open Settings → Voice devices → Routines, edit a routine, and copy the **Webhook URL** at the bottom. POST to that URL from anywhere — including an iPhone NFC tag via Shortcuts ("When NFC tag is scanned" → "Get contents of URL") — and the routine fires. Anyone with the URL can trigger it, so don't share it widely; the "Regen" button revokes the old URL if you need to rotate.

**Target device picker for routines**
Each routine now has a **Target device** dropdown in the editor. When set, the routine's `play ambient` and `tts say` actions run on that device regardless of which voice device heard the trigger — so "goodnight" said in the kitchen can play sounds in the bedroom. Required for webhook fires too, since they have no originating device.

**Webhook + Test work with idle devices**
Reminders, the Test button, and webhook fires now push spoken replies via the same one-shot MP3 path as scheduled reminders, so a target device doesn't need an active chat session to speak.

**Your OE Admin agent can install Tailscale on the OE host**
If you have the **OE Admin** role assigned to an agent (Settings → Agents → edit → Role: OE Admin), ask it to "install Tailscale on this server" and it walks the install: prompts for your auth key via the secure widget, runs the installer with sudo, enables `tailscaled`, and brings up the node. Same path works for Cloudflared. The system restarts when needed, with auto-revert if the server fails to come back.

**Ambient preview is now a play/stop toggle**
Settings → Voice devices → Ambient library: the **▶** button changes to **■** while a clip is playing. Click again to stop instead of waiting for the file to finish.

**Routine editor: spacebar in ID field**
The ID field (e.g. `goodnight`) is a slug, not a phrase — spaces are now blocked from being typed, and any other invalid characters are auto-converted to underscores on save with a notification telling you what the slug became.

**Routine editor: adding actions no longer collapses the row**
Adding a new action (e.g. HA scene) before any others existed in a new routine used to collapse the editor. Fixed.

**Routine drops are now visible**
If a routine fails server-side validation on save (e.g. an `ha_scene` action without a scene picked, or a `play_ambient` pointing at a deleted file), the UI now shows a specific error explaining which field tripped it instead of pretending the save succeeded.

**Health-check ticks are quieter on your nodes**
Background service-health monitoring no longer spawns a separate bash process per signal — every node's due signals run as one composite shell invocation per cycle (~4× fewer processes on a node like shareserver). Profile ticks across multiple nodes are also dispersed across the cadence window so they don't all spike at the same instant.
