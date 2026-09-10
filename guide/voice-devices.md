# Voice devices

A **voice device** is a small physical box you talk to — wake word, mic capture, on-device speech replies. The reference build is a Seeed reSpeaker XVF3800 paired with a Seeed XIAO ESP32-S3, but the protocol is open so other hardware can join the same way.

Once paired, the device acts like any other OE client: it logs into a user account, sends transcribed utterances as chat messages to that user's coordinator (or any agent), and plays the reply back through its speaker or 3.5 mm jack.

## Routines

Choose **Routines** next to **Tasks** in the sidebar, or **Menu → Routines** on mobile, to jump straight to your saved action sequences. You can also choose **Open routines** in Tasks or **Manage routines** in Learn.

Use **+ New routine** to save a trigger phrase and its actions, or ask in chat: *"When I say goodnight, turn off the lights."* Existing routines have **Test**, **Edit**, and **Delete** controls. You can create and edit routines before pairing a device; the **Test** button currently needs an online paired device. Webhook URLs are available inside each saved routine's editor for triggers from other apps.

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

## Pairing a device

1. **Flash it** — see the **Voice device flashing** page. New devices need both the XVF audio chip and the ESP32 application firmware before they'll boot.
2. **Power it on.** A freshly-flashed (or factory-reset) device boots into provisioning mode and broadcasts a Wi-Fi network named `oe-voice-XXXX`.
3. **Generate a pairing code.** Open *Settings → Voice devices* and click **+ Add device**. The code is good for ~10 minutes.
4. **Join the device's Wi-Fi** from your phone or laptop. The captive portal opens automatically; if not, browse to `http://192.168.4.1`.
5. **Fill in the form** — your home Wi-Fi SSID + password, the OE server URL (e.g. `http://192.168.4.20:3737`), the pairing code, and a friendly device name.
6. The device leaves AP mode, joins your Wi-Fi, redeems the pairing code, and shows up in *Settings → Voice devices* a few seconds later.

Pairing codes are held in memory and die when the OE server restarts. If you restart mid-pair, generate a new code.

## Wake words and slot routing

Each device has six **wake-word slots**. A slot is a `(wake word, voice, owner user)` triple:

- **Wake word** — what the user says to trigger the device (e.g. "hey ensemble", "computer"). Slots can use any model from your wake-word library — see *Settings → Wake words*. Each slot loads independently so a device can listen for multiple wake words simultaneously.
- **Voice** — the TTS voice the reply gets spoken in. See the **Text-to-speech** page.
- **Owner user** — which OE user account the chat runs as. In a single-user install this is always you. In a household, "hey ensemble" might route to your account while "hey roommate" routes to someone else's — same physical device, different per-user agents/memory/data.

Slot routing is configured per-OE-user, not per-device. Open *Settings → Voice devices → Voice config*. Whatever you set there applies to every voice device paired to your account. So if you have a kitchen device and a bedroom device, you configure slots once and both devices learn it.

When you change a slot's wake word, the new `.tflite` is pushed over WebSocket to every online device and hot-loaded into SPIFFS without a reboot. The push is acked by the device so the server knows it landed.

## Sharing slots with other users

A slot's *owner user* doesn't have to match the device's paired user. Set someone else's account as the owner and that wake word, on your device, will route to their account: their coordinator answers, using their memory, with their voice.

Useful for household setups — pair a device to the household admin's account, then set each family member's wake word to their own user account.

The non-admin user sees inbound routing in their own *Settings → Voice devices* under "Shared with you" and can opt out at any time (clears their `ownerUserId` from the slot).

## What gets sent to the server

When a wake word fires, the device:

1. Captures the utterance until the VAD detects ~500 ms of silence (or hits a 15 s ceiling).
2. POSTs the raw 16 kHz mono PCM to `/api/stt` and gets a transcript back.
3. Sends `{type:'chat', text:<transcript>, wake_slot:<N>, source:'voice-device'}` over the WebSocket the device opened at boot.
4. Receives streamed reply tokens, which it accumulates into sentences and runs through `/api/tts` to play.

The `source: 'voice-device'` tag is what triggers two server-side optimizations: a slim tool subset (no email/expenses/etc. — see the **Skills** page) and the **voice intent router** (volume, pause, stop are handled inline without calling the LLM at all).

## Interrupting and controlling playback

Say the wake word while the device is speaking and the reply gets cut off and the device starts capturing your next utterance ("barge-in"). What you say next is interpreted normally — say a new question, or use one of the built-in control verbs:

- "volume up" / "volume down" / "volume 50" / "louder" / "quieter"
- "mute" / "unmute"
- "pause" / "resume"
- "stop" / "cancel" / "never mind"

Control verbs are matched by a fast server-side regex *before* the LLM dispatch, so they take effect almost instantly (no token cost, no agent round-trip). You'll get a short "okay" back on most of them.

## Useful patterns

- **Voice memo** — Pair a device next to your desk, route slot 0 to your coordinator: *"\<wake-word\>, remind me to call the dentist tomorrow at 10 a.m."* — Cortex creates the task and sets a reminder.
- **Hands-free notes** — *"\<wake-word\>, save: the dehumidifier filter is the AC4150 model"* drops into your skills's memory pipeline; later searchable from any chat.
- **Read-aloud requests** — *"\<wake-word\>, what's on my calendar today?"* speaks the answer instead of you reading it.
