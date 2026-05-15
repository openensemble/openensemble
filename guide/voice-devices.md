# Voice devices

A **voice device** is a small physical box you talk to — wake word, mic capture, on-device speech replies. The reference build is a Seeed reSpeaker XVF3800 paired with a Seeed XIAO ESP32-S3, but the protocol is open so other hardware can join the same way.

Once paired, the device acts like any other OE client: it logs into a user account, sends transcribed utterances as chat messages to that user's coordinator (or any agent), and plays the reply back through its speaker or 3.5 mm jack.

## Pairing a device

1. **Flash it** — see the **Voice device flashing** page. New devices need both the XVF audio chip and the ESP32 application firmware before they'll boot.
2. **Power it on.** A freshly-flashed (or factory-reset) device boots into provisioning mode and broadcasts a Wi-Fi network named `oe-voice-XXXX`.
3. **Generate a pairing code.** Open *Settings → Voice devices* and click **+ Add device**. The code is good for ~10 minutes.
4. **Join the device's Wi-Fi** from your phone or laptop. The captive portal opens automatically; if not, browse to `http://192.168.4.1`.
5. **Fill in the form** — your home Wi-Fi SSID + password, the OE server URL (e.g. `http://192.168.1.81:3737`), the pairing code, and a friendly device name.
6. The device leaves AP mode, joins your Wi-Fi, redeems the pairing code, and shows up in *Settings → Voice devices* a few seconds later.

Pairing codes are held in memory and die when the OE server restarts. If you restart mid-pair, generate a new code.

## Wake words and slot routing

Each device has six **wake-word slots**. A slot is a `(wake word, voice, owner user)` triple:

- **Wake word** — what the user says to trigger the device (e.g. "sydney", "hey ensemble"). Slots can use any model from your wake-word library — see *Settings → Wake words*. Each slot loads independently so a device can listen for multiple wake words simultaneously.
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

- **Voice memo** — Pair a device next to your desk, route slot 0 to your coordinator: *"sydney, remind me to call the dentist tomorrow at 10 a.m."* — Cortex creates the task and sets a reminder.
- **Hands-free notes** — *"sydney, save: the dehumidifier filter is the AC4150 model"* drops into your skills's memory pipeline; later searchable from any chat.
- **Read-aloud requests** — *"sydney, what's on my calendar today?"* speaks the answer instead of you reading it.
