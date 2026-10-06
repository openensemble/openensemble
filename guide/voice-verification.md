# Wake verification configuration

This optional operator configuration connects an already-installed local wake
verifier to paired voice devices. Ordinary STT and first-chat setup do not
require it. Configure it only when that verifier service is available.

Wake verification is enabled with `verifyGateEnabled: true`.
`verifyGateUpstreamUrl` (or `OE_VERIFY_GATE_URL`) must be the numeric loopback
verifier endpoint, normally `http://127.0.0.1:5390/v1/verify`, and
`verifyGateClientSecret` (or `OE_VERIFY_GATE_SECRET`) must match the gate's
32+ character internal secret. The secret is encrypted at rest. Neither value
is sent to a voice device: `server_caps` advertises only the fixed
`/api/voice-gate/v1/verify` path.

Voice-device firmware resolves that path against its already-paired OE origin
and never accepts a free-form gate URL or sends its bearer to the loopback
service. Plain HTTP is allowed only when the paired origin is a numeric private
IPv4 address. OE independently requires the request's raw socket peer to be
private/loopback and rejects proxy/CDN forwarding headers, so this endpoint is
not supported through a tunnel, reverse proxy, or public/WAN address.

Private HTTP deliberately assumes a trusted or isolated LAN: the device bearer
and wake clip are not encrypted from another party capable of intercepting LAN
traffic. Use HTTPS instead where that assumption does not hold.

See [Voice devices](voice-devices.md) for pairing and calibration.
