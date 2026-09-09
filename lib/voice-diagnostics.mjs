// @ts-check
// Metadata-only projection: never return transcripts, reply text, or raw errors.
const DAY_MS = 24 * 60 * 60 * 1000;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const duration = value => number(value) !== null && value >= 0 ? Math.round(value) : null;
const difference = (end, start) => number(end) !== null && number(start) !== null ? duration(end - start) : null;

export function summarizeVoiceTurn(row) {
  const startedAt = number(row.startedAt) ?? (number(row.ts) !== null && duration(row.totalMs) !== null ? row.ts - row.totalMs : null);
  const captureMs = duration(row.sttCaptureMs);
  const levels = row.sttLevels;
  const outcome = row.noTerminalFromLlm === true ? 'handler_error' : row.outcome;
  return {
    id: typeof row.turnId === 'string' ? row.turnId.slice(0, 64) : null,
    startedAt,
    endedAt: number(row.ts),
    outcome: ['completed', 'suppressed', 'no_speech', 'stt_dropped', 'stt_failed', 'tts_failed', 'abandoned', 'evicted', 'aborted_disconnect', 'handler_error'].includes(outcome) ? outcome : 'unknown',
    failStage: ['wake', 'capture', 'transcribe', 'dispatch', 'tts'].includes(row.failStage) ? row.failStage : null,
    recognizedSpeech: number(row.transcriptChars) === null ? null : row.transcriptChars > 0,
    gaps: duration(row.sttGaps),
    levels: levels && typeof levels === 'object' ? {
      peakDbfs: number(levels.peakDbfs),
      rmsDbfs: number(levels.rmsDbfs),
      likelyClipped: levels.likelyClipped === true,
      silent: levels.peakSample === 0,
    } : null,
    timing: {
      captureMs,
      recognitionMs: duration(row.sttTranscribeMs),
      firstTextMs: difference(row.firstReplyTextAt, row.dispatchStartedAt),
      firstSynthesisMs: duration(row.ttsFirstSynthesisMs),
      firstAudioMs: startedAt !== null && captureMs !== null ? difference(row.ttsFirstAudioAt, startedAt + captureMs) : null,
      totalMs: duration(row.totalMs),
      deliveryMeasured: row.ttsDeliveryMeasured === true,
    },
  };
}

export function buildVoiceDiagnostics({ userId, device, online, health, turns = [], links = [], now = Date.now() }) {
  const cutoff = Math.max(now - DAY_MS, number(device.paired_at) ?? 0);
  const ownTurns = turns.filter(row => row && row.deviceId === device.id && row.authUserId === userId
    && (!row.effectiveUserId || row.effectiveUserId === userId)
    && number(row.ts) !== null && row.ts >= cutoff && row.ts <= now);
  const ownLinks = links.filter(row => row && row.deviceId === device.id && row.userId === userId
    && number(row.ts) !== null && row.ts >= cutoff && row.ts <= now);
  const lastHbAt = number(health?.lastHbAt);
  const heartbeatAgeMs = lastHbAt !== null ? duration(now - lastHbAt) : null;
  const fresh = online && heartbeatAgeMs !== null && heartbeatAgeMs <= 45_000;
  const capSps = duration(health?.capSps);
  const checks = [];
  checks.push({ name: 'Connection', status: online ? 'ok' : 'error', detail: online ? 'Connected to OE.' : 'Offline. Check device power and Wi-Fi.' });
  checks.push({ name: 'Microphone', status: device.mute_state ? 'warning' : !fresh || capSps === null ? 'unknown' : health?.micDead || capSps < 1000 ? 'error' : 'ok',
    detail: device.mute_state ? 'Muted. Unmute the device before speaking.'
      : !fresh ? 'No recent microphone telemetry. A connected socket alone does not confirm microphone health.'
      : capSps === null ? 'This device has not reported microphone capture data.'
      : health?.micDead || capSps < 1000 ? 'Microphone capture appears stalled. Restart the device and check its microphone connection.'
      : 'Microphone capture is running. Use the guided check to confirm speech reaches OE.' });
  const rssi = fresh ? number(health?.rssi) : null;
  checks.push({ name: 'Wi-Fi', status: rssi === null ? 'unknown' : rssi < -75 ? 'warning' : 'ok',
    detail: rssi === null ? 'No recent signal reading.' : `${rssi} dBm.${rssi < -75 ? ' Weak signal; move closer to the access point.' : ' Signal looks usable.'}` });
  if (health?.rebootStorm && fresh) checks.push({ name: 'Restarts', status: 'warning', detail: 'The device has restarted repeatedly. Check its power supply and cable.' });
  const recentTurns = ownTurns.sort((a, b) => b.ts - a.ts).slice(0, 10).map(summarizeVoiceTurn);
  return {
    serverNow: now,
    device: { id: device.id, name: device.name, online: !!online, muted: !!device.mute_state, firmware: device.fw_version || null },
    checks,
    heartbeatAgeMs,
    connection: {
      since: cutoff,
      connects: ownLinks.filter(row => row.event === 'connect').length,
      disconnects: ownLinks.filter(row => row.event === 'disconnect').length,
      unresponsive: ownLinks.filter(row => row.event === 'terminated_unresponsive').length,
      interruptedTurns: ownLinks.filter(row => row.event === 'disconnect' && row.hadActiveTurn).length,
      hasHistory: ownLinks.length > 0,
    },
    turns: recentTurns,
  };
}
