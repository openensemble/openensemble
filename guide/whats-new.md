# What's new

A running log of user-visible changes shipped to OpenEnsemble. Newest at the top.

If you auto-update (`oe update`), you'll get these as they land. If not, run `oe update` in your install directory to pull the latest.

---

## 2026-05-27

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
