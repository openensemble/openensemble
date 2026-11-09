/** OE owns the verification decision and uses its current shared STT provider. */
import { transcribeAudio } from './stt.mjs';
import { matchWakeWords, resolveWakeWordSpecs } from './wakeword-matcher.mjs';

const STT_TIMEOUT_MS = 900;

export async function verifyWakeAudio({ file, wakeWords, deviceId, sessionId }) {
  const started = performance.now();
  const result = (reason, match = null) => {
    const verdict = match ? 'accept' : 'reject';
    return {
      device_id: deviceId,
      session_id: sessionId,
      verdict,
      effective: verdict,
      matched_variant: match?.matched_variant ?? null,
      match_method: match?.match_method ?? null,
      mode: 'enforce',
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
      reasons: [reason],
    };
  };
  const specs = resolveWakeWordSpecs(wakeWords);
  if (!specs) return result('unknown_wake_word');

  let transcript, raw;
  try {
    // No expected word or prompt is sent to STT: that could bias it into
    // hallucinating the wake phrase from silence or unrelated speech.
    ({ transcript, raw } = await transcribeAudio(file, {
      name: 'wake.wav', lang: 'en', timeoutMs: STT_TIMEOUT_MS,
      temperature: 0, responseFormat: 'json', redirect: 'error',
      maxResponseBytes: 64 * 1024,
    }));
    if (typeof transcript !== 'string' || transcript.length > 4096) {
      return result('invalid_transcription');
    }
  } catch (error) {
    return result(error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'stt_timeout' : 'stt_error');
  }
  if (!transcript.trim()) return result('empty_transcript');

  // Providers without confidence fields still need a positive word match.
  // If confidence is supplied, low-confidence text must never open a wake.
  const segments = raw?.segments;
  if (segments != null) {
    if (!Array.isArray(segments) || segments.length > 64) return result('invalid_transcription');
    let logprobSum = 0, logprobCount = 0;
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') return result('invalid_transcription');
      const nsp = segment.no_speech_prob, lp = segment.avg_logprob;
      if ((nsp != null && (!Number.isFinite(nsp) || nsp < 0 || nsp > 1))
          || (lp != null && !Number.isFinite(lp))) return result('invalid_transcription');
      if (nsp != null && nsp > 0.5) return result('high_no_speech_prob');
      if (lp != null) { logprobSum += lp; logprobCount += 1; }
    }
    if (logprobCount && logprobSum / logprobCount < -1.2) return result('low_avg_logprob');
  }
  const match = matchWakeWords(transcript, specs);
  return match ? result(`match:${match.match_method}`, match) : result('no_match');
}
