# Wake verification configuration

Wake verification runs inside OpenEnsemble. Enable it with
`verifyGateEnabled: true` and configure speech-to-text in OE's settings.
Verification uses the currently selected local or remote STT provider on every
new wake. Switching STT therefore also switches wake verification automatically.
There is no separate verifier service, model selection, URL, or shared secret
to configure. Legacy `verifyGateUpstreamUrl`, `verifyGateClientSecret`,
`OE_VERIFY_GATE_URL`, and `OE_VERIFY_GATE_SECRET` settings are no longer used.

The voice device detects a possible wake locally and sends the short audio clip
to OE at `/api/voice-gate/v1/verify`. OE transcribes the clip without prompting
STT with the expected word, then checks for the wake phrase or an accepted stock
spelling. Custom phrases use whole-word matching without fuzzy matching.
Silence, unrelated speech, low confidence, errors, and timeouts reject the wake.
OE keeps clips and transcripts in memory only; they are not saved by the
verifier. A remote STT selection sends the clip to that configured provider,
just as regular transcription does.

Voice-device firmware resolves that path against its already-paired OE origin
and never accepts a free-form gate URL. Plain HTTP is allowed only when the
paired origin is a numeric private IPv4 address. OE independently requires the
request's raw socket peer to be
private/loopback and rejects proxy/CDN forwarding headers, so this endpoint is
not supported through a tunnel, reverse proxy, or public/WAN address.

Private HTTP deliberately assumes a trusted or isolated LAN: the device bearer
and wake clip are not encrypted from another party capable of intercepting LAN
traffic. Use HTTPS instead where that assumption does not hold.

See [Voice devices](voice-devices.md) for pairing and calibration.
