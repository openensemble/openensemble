export const VOICE_GATE_PROXY_PATH = '/api/voice-gate/v1/verify';

/**
 * Gate enablement is an explicit policy bit. The private Python upstream URL
 * and its client secret never cross the device protocol boundary.
 */
export function voiceGateEnabled(config = {}) {
  return config.verifyGateEnabled === true;
}

export function buildVoiceDeviceServerCaps({ deviceId, config = {} }) {
  const gateEnabled = voiceGateEnabled(config);
  return {
    type: 'server_caps',
    turn_ids: true,
    tts_pause: true,
    // PAUSE/RESUME carry a per-provisional-wake hold_id. OE latches the
    // newest id on the device socket so a delayed resume cannot release a
    // later hold, including when a turnless announcement starts meanwhile.
    tts_hold_ids: true,
    // Streaming STT needs a working transcription backend server-side.
    stt_stream: config.sttMode === 'local' || !!(config.sttApiKey && config.sttApiUrl),
    // Pairing REST uses camelCase deviceId; server_caps follows the existing
    // snake_case wire convention used by turn_ids and stt_stream.
    device_id: typeof deviceId === 'string' ? deviceId : '',
    // Clear the retired direct-to-Python URL on older firmware. New firmware
    // accepts only the fixed relative OE proxy path below, resolves it against
    // its already-paired OE origin, and requires HTTPS before sending a bearer.
    verify_gate_url: '',
    verify_gate_path: gateEnabled ? VOICE_GATE_PROXY_PATH : '',
  };
}
