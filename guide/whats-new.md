# What's new

A running log of user-visible changes shipped to OpenEnsemble. Newest at the top.

If you auto-update (`oe update`), you'll get these as they land. If not, run `oe update` in your install directory to pull the latest.

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
