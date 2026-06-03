# What's new

A running log of user-visible changes shipped to OpenEnsemble. Newest at the top.

If you auto-update (`oe update`), you'll get these as they land. If not, run `oe update` in your install directory to pull the latest.

---

## 2026-06-03

**Aliases — say "the kitchen lights" once, OE remembers it**
OpenEnsemble now learns the names you use for things. Reference a skill, agent, node, email account, project, or watched YouTube channel by friendly name ("ask Ada", "the pihole server", "my Renovo email", "the snake game project", "any new videos from twice") and the coordinator skips the usual list-then-filter dance — it goes straight to the right tool with the right id. Aliases auto-save the first time they're resolved (so the second mention is instant) and cascade-delete when the underlying thing is removed. If the LLM asks "did you mean X?" and you reply "yes", that learns the alias too. Custom skills with their own catalogs can opt in via a small `alias_catalog` block in their manifest — Skill Builder knows the pattern.

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
- `@ada` (or any agent name) routes the message to that agent and auto-switches your active chat tab to theirs. Works from any agent's chat panel — useful for quickly delegating without opening a different drawer first.
- `@audio/foo.wav`, `@video/clip.mp4`, `@image/sunset.png` references a file already in your profile folders. Tab-completes to the exact filename and the server resolves it to an absolute path so transcribe (or any path-aware tool) can act on it. Typing `@a` shows both Ada-the-agent and `audio/` as completion options.

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
When you (or an OE Admin–assigned agent like Sydney) add a new OpenAI-compatible provider via the OE Admin tools, it now renders as its own provider card under Settings → Providers and appears as a labelled group in every agent's model dropdown — alongside the built-in providers. Previously the provider worked in chat dispatch but was invisible to the UI, so users couldn't actually select its models for their agents.

**Voice routines now have webhook triggers**
Every routine gets its own webhook URL. Open Settings → Voice devices → Routines, edit a routine, and copy the **Webhook URL** at the bottom. POST to that URL from anywhere — including an iPhone NFC tag via Shortcuts ("When NFC tag is scanned" → "Get contents of URL") — and the routine fires. Anyone with the URL can trigger it, so don't share it widely; the "Regen" button revokes the old URL if you need to rotate.

**Target device picker for routines**
Each routine now has a **Target device** dropdown in the editor. When set, the routine's `play ambient` and `tts say` actions run on that device regardless of which voice device heard the trigger — so "goodnight" said in the kitchen can play sounds in the bedroom. Required for webhook fires too, since they have no originating device.

**Webhook + Test work with idle devices**
Reminders, the Test button, and webhook fires now push spoken replies via the same one-shot MP3 path as scheduled reminders, so a target device doesn't need an active chat session to speak.

**Sydney can install Tailscale on the OE host**
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
