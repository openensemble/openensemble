# Voice devices

A voice device lets you speak to your assistant using a wake word. The supported
build is the Seeed reSpeaker XVF3800 with XIAO ESP32-S3. Each device is paired to
an OE account; wake-word slots can route to different household members.

## What you need

- A supported, flashed device on a network that can reach OE.
- A working chat assistant, [speech-to-text](stt.md), and [text-to-speech](tts.md).
- Chrome or Edge for the USB [flash wizard](voice-device-flashing.md).

Voice data goes through the providers you select. Local or cloud processing is
configured separately for STT, chat, and TTS; see [Which model does what](models-explained.md).

## Pairing a device

1. **Flash it** — follow [Flashing voice devices](voice-device-flashing.md). A new board needs the supported XVF audio firmware and ESP32 application firmware for OE voice operation.
2. **Power it on.** A freshly-flashed (or factory-reset) device boots into provisioning mode and broadcasts a Wi-Fi network named `oe-voice-XXXX`.
3. **Generate a pairing code.** Open **Voice devices** and click **+ Add device**. The code is good for ~10 minutes.
4. **Join the device's Wi-Fi** from your phone or laptop. The captive portal opens automatically; if not, browse to `http://192.168.4.1`.
5. **Fill in the form** — your home Wi-Fi SSID + password, the OE server URL (e.g. `http://192.168.4.20:3737`), the pairing code, and a friendly device name.
6. The device leaves AP mode, joins your Wi-Fi, redeems the pairing code, and shows up in **Voice devices** a few seconds later.

Pairing codes are held in memory and die when the OE server restarts. If you restart mid-pair, generate a new code.

## Wake words and slot routing

Each device has six **wake-word slots**. A slot is a `(wake word, voice, owner user)` triple:

- **Wake word** — what the user says to trigger the device (e.g. "hey ensemble", "computer"). Slots can use any model from your wake-word library — see the wake-word library in **Voice devices**. Each slot loads independently so a device can listen for multiple wake words simultaneously.
- **Voice** — the TTS voice the reply gets spoken in. See the **Text-to-speech** page.
- **Owner user** — which OE user account the chat runs as. In a single-user install this is always you. In a household, "hey ensemble" might route to your account while "hey roommate" routes to someone else's — same physical device, different per-user agents/memory/data.

Slot routing is configured per-OE-user, not per-device. Open **Voice devices → Voice config**. Whatever you set there applies to every voice device paired to your account. So if you have a kitchen device and a bedroom device, you configure slots once and both devices learn it.

Slot edits are saved first. Choose **Save & Push** after selecting the wake word, voice, and cutoffs to send them to your paired devices. Offline devices synchronize when they reconnect. **Avg cutoff** is a server-side average-score gate, separate from the firmware peak cutoff; use the calibration workflow below to evaluate room-specific values.

## Sharing slots with other users

A slot's *owner user* doesn't have to match the device's paired user. Set someone else's account as the owner and that wake word, on your device, will route to their account: their coordinator answers, using their memory, with their voice.

Useful for household setups — pair a device to the household admin's account, then set each family member's wake word to their own user account.

The non-admin user sees inbound routing in their own **Voice devices** under "Shared with you" and can opt out at any time (clears their `ownerUserId` from the slot).

## Conversation and playback controls

On the device card, enable **Conversation mode** to keep listening briefly
after a reply. Speak a follow-up without repeating the wake word; the session
ends after silence, a closing phrase such as “that's all,” or another user's
wake word. With compatible firmware, speaking during a reply can interrupt it.
Wake-word interruption also works when conversation mode is off.

Use “volume up,” “volume down,” “volume 50,” “mute,” “unmute,” “pause,” “resume,”
or “stop.” During a spoken reply, stop cancels the reply; when only music is
playing, it stops playback. Background work appears in the chat's Agents
activity view and supported device firmware indicates waiting work.

## AirPlay, ambient sound, and headphones

On the same local network, choose the voice device's name in your iPhone,
iPad, or Mac's AirPlay picker. Voice commands can pause, resume, skip, or go
back in the source's music session. Supported firmware lowers music under an
assistant reply, then restores it.

**Headphone / line-out mode** on the device card disables the internal speaker
amplifier and uses the 3.5 mm output. It is also available through “headphones
on” or “headphones off.” If a device seems silent, check this setting and volume.

In the **Ambient library**, the preview button toggles between play and stop.
Use a routine when you want a saved announcement and ambient sound sequence.

## Routines

Open **Routines** in the sidebar or mobile menu to create a sequence, choose
its target device, add waits, test it, or copy its webhook. See
[Routines and saved fast paths](routines.md) for the full workflow. HA actions
and waits can be tested without a voice device; audio needs an online target.

## Device maintenance

- **Rename:** edit the name at the top of its card and finish the edit. The
  device's AirPlay name updates too.
- **Change Wi-Fi:** on an online device, choose **Reset Wi-Fi**. It clears
  network/pairing settings, removes that registration from OE, and restarts
  into its setup network. Pair it again on the new network. Wake-word models
  on the device are retained.
- **Voice users:** removing a voice user releases that slot and removes its
  wake word from paired devices. Review household routing before doing so.
- **Firmware:** use the device's supported OTA update flow or the flash wizard.
  Use current firmware for conversation and diagnostic controls.

Device-side alarms can ring without Wi-Fi or OE once they are armed. Supported
firmware can retain up to eight armed alarms. After a device reboot, saved
deadlines still need clock synchronization before recovery.

## Voice diagnostics

Open **Voice devices → Voice diagnostics** to check a paired device or this browser's microphone.

- **Start device check:** choose a device, then say its wake word followed by *"What is two plus two?"* Use a wake word assigned to your profile. OE waits up to 60 seconds for the new turn and shows whether audio and recognized speech reached the server.
- **Connection:** see live connection status, microphone capture health, Wi-Fi strength, and disconnects over the past 24 hours. Old or missing telemetry is marked unknown.
- **Response timing:** expand a recent turn to compare recording/upload, speech recognition, time to the agent's first text, and first audio preparation. Detailed audio timings are available for new server-streamed voice turns. Older turns or other playback paths show **Not recorded** where a measurement is unavailable. Stages overlap, and speaker buffering is not included.
- **Check this microphone:** speak normally for six seconds while the input meter moves. This tests the microphone on your computer or phone, not the selected voice device. Audio is analyzed locally and is never uploaded by this check. Browser microphone access requires HTTPS or localhost.

Both guided checks can be canceled. Microphone access stops automatically after six seconds, when you close the drawer, or when the tab goes into the background.

Recent turn details show **What OE heard**, the selected agent, the average wake score and cutoff, and whether the wake was accepted or rejected. New transcripts are bounded to 2,000 characters and kept with OE's private voice-turn journal for up to 30 days; this panel shows recent turns from the past 24 hours. Older turns may have no transcript. A shared device's other users' conversations are excluded. The diagnostics API returns metadata by default; authenticated detail requests opt into transcript content.

### Room and wake-word calibration

With supported firmware connected and fresh wake telemetry available, choose **Calibrate slot** for one of your wake words. Leave normal room noise running while you stay quiet for 30 seconds. Then say your wake word and “What is two plus two?” three times from your usual speaking position, waiting for each reply.

OE compares quiet-room peak scores with the average scores of those wake attempts. When the samples are sufficiently separated, it suggests an average-score cutoff. **Apply** changes only that device's server-side average wake gate; **Restore slot defaults** removes the override. The setting is tied to the wake word and owner, so replacing either stops the old override from applying. Firmware peak thresholds and shared voice settings are unchanged.

When noise overlaps speech scores, OE recommends repositioning the device and repeating the check. Missing or stale telemetry produces no recommendation. The displayed microphone level is in device units, not calibrated decibels.
