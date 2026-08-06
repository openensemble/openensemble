// @ts-check
/**
 * lib/voice-policy.mjs
 *
 * Voice conversation policy (design: ~/oe-design-docs/voice-conversation-policy-design.md,
 * phases 1–3, server-only — resolved at review 2026-07-29):
 *
 *   Phase 1 — per-turn follow-up DISPOSITION. Windows are no longer three
 *     fixed constants; whatever handled the turn declares terminal / open /
 *     required and the window length follows from that. "Turn off the
 *     kitchen" stops opening a conversation window.
 *   Phase 2 — fleet self-audio. A per-owner registry of what every device is
 *     currently speaking, so device B's follow-up window is not armed while
 *     device A is talking, and a follow-up transcript that matches the
 *     fleet's own TTS text is discarded as self-audio.
 *   Phase 3 — continuation gate. Inside an `open` follow-up window an
 *     utterance must look like a continuation of the exchange. Ships in
 *     'log' mode (verdicts logged, nothing dropped) until telemetry proves
 *     the false-reject rate; flip to 'enforce' via config.
 *
 * Deliberately NOT here (deferred until telemetry forces them): arbitration,
 * bid windows, SNR/DoA scoring, stand_down, per-room tuning, speaker-ID.
 *
 * Config (config.json → voicePolicy, all optional):
 *   { "enabled": true, "continuationGate": "log" }   // "off" | "log" | "enforce"
 */

import { loadConfig } from '../routes/_helpers.mjs';

// Window lengths per disposition (§6 of the design doc). `terminal` is the
// chain tail: a short, high-bar window that only accepts another parsed
// device command ("turn off the kitchen… and the porch") — anything
// conversational in it is dropped silently by the dispatch gate.
export const DISPOSITION_WINDOW_MS = {
  terminal: 2000,
  open: 8000,
  required: 12000,
};

export function getVoicePolicyConfig() {
  let vp = null;
  try { vp = loadConfig()?.voicePolicy ?? null; } catch { /* defaults below */ }
  const gate = vp?.continuationGate;
  return {
    enabled: vp?.enabled !== false,
    continuationGate: gate === 'off' || gate === 'enforce' ? gate : 'log',
  };
}

export function isVoicePolicyEnabled() {
  return getVoicePolicyConfig().enabled;
}

/**
 * Follow-up capture signature by client type.
 *
 * ESP firmware marks a window fire with wake_avg_prob=255. Android TV has no
 * wake-score field and sends its re-listen result as a plain chat frame, so an
 * otherwise markerless TV frame is a follow-up candidate when the connection
 * layer also has a live, unconsumed server window.
 */
export function hasFollowupCaptureSignature({ wakeAvgProb = null, platform = null } = {}) {
  if (wakeAvgProb === 255) return true;
  return platform === 'android-tv' && wakeAvgProb == null;
}

// ── Phase 2: fleet self-audio registry ──────────────────────────────────────
// Keyed by the device-OWNER user id (the household fleet — every paired
// device authenticates as the owner), then by deviceId. Tracks whether each
// device is currently emitting TTS and a short rolling buffer of the text it
// spoke, so another device's capture can be recognized as our own audio.
const SPEECH_TEXT_TTL_MS = 20_000;   // how long spoken text stays matchable
const SPEECH_ACTIVE_TAIL_MS = 1500;  // "still emitting" grace after close
const SPEECH_SEGMENT_CAP = 40;       // per-device rolling segment cap
// `emitting` without fresh text for this long is treated as stale. The end
// mark can be missed on abrupt teardown paths (socket drop, legacy error
// terminals); without this bound one stuck device would suppress every other
// device's follow-up windows until its next completed reply.
const SPEECH_EMITTING_STALE_MS = 20_000;
const SPEECH_SEGMENT_COALESCE_MS = 2000;  // token deltas within this join one segment
const SPEECH_SEGMENT_MAX_CHARS = 600;

/** @type {Map<string, Map<string, {emitting: boolean, lastStartAt: number, lastEndAt: number, lastTextAt: number, segments: Array<{text: string, ts: number}>}>>} */
const _fleetSpeech = new Map();

function fleetEntry(userId, deviceId) {
  if (!userId || !deviceId) return null;
  let byDevice = _fleetSpeech.get(userId);
  if (!byDevice) { byDevice = new Map(); _fleetSpeech.set(userId, byDevice); }
  let entry = byDevice.get(deviceId);
  if (!entry) {
    entry = { emitting: false, lastStartAt: 0, lastEndAt: 0, lastTextAt: 0, segments: [] };
    byDevice.set(deviceId, entry);
  }
  return entry;
}

function pruneSegments(entry, now) {
  while (entry.segments.length &&
         (now - entry.segments[0].ts > SPEECH_TEXT_TTL_MS ||
          entry.segments.length > SPEECH_SEGMENT_CAP)) {
    entry.segments.shift();
  }
}

/**
 * Record a chunk of text a device is speaking; marks the device emitting.
 * Chunks arrive as raw LLM token deltas (mid-word splits like "kit"+"chen"),
 * so consecutive chunks are CONCATENATED into one segment — joining them
 * with spaces would corrupt the spoken text and defeat the transcript match.
 */
export function noteFleetSpeech(userId, deviceId, text) {
  const entry = fleetEntry(userId, deviceId);
  if (!entry || typeof text !== 'string' || !text) return;
  const now = Date.now();
  if (!entry.emitting) { entry.emitting = true; entry.lastStartAt = now; }
  entry.lastTextAt = now;
  const last = entry.segments[entry.segments.length - 1];
  if (last && now - last.ts < SPEECH_SEGMENT_COALESCE_MS && last.text.length < SPEECH_SEGMENT_MAX_CHARS) {
    last.text += text;
    last.ts = now;
  } else {
    entry.segments.push({ text, ts: now });
  }
  pruneSegments(entry, now);
}

/** Mark a device's TTS emission finished (streamer closed / done sent). */
export function noteFleetSpeechEnd(userId, deviceId) {
  const entry = fleetEntry(userId, deviceId);
  if (!entry) return;
  entry.emitting = false;
  entry.lastEndAt = Date.now();
}

/**
 * True when any OTHER device in this owner's fleet is emitting TTS right now
 * (or closed within the short tail). Used to skip arming a follow-up window
 * that would just capture the other device's speech. `emitting` counts only
 * while text is fresh (see SPEECH_EMITTING_STALE_MS) so a missed end mark
 * cannot suppress the fleet forever.
 */
export function fleetSpeechActiveElsewhere(userId, deviceId) {
  const byDevice = _fleetSpeech.get(userId);
  if (!byDevice) return null;
  const now = Date.now();
  for (const [otherId, entry] of byDevice) {
    if (otherId === deviceId) continue;
    const emittingFresh = entry.emitting && now - entry.lastTextAt < SPEECH_EMITTING_STALE_MS;
    if (emittingFresh || now - entry.lastEndAt < SPEECH_ACTIVE_TAIL_MS) return otherId;
  }
  return null;
}

const normalizeSpeech = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9' ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Does this transcript match what ANOTHER device in the fleet was speaking in
 * the last ~20 s? Verbatim-substring only, on normalized text — STT of our
 * own TTS is near-verbatim, and anything looser (bag-of-words overlap) was
 * shown to eat genuine user commands whose vocabulary happened to appear in
 * a recent reply. The capturing device is EXCLUDED: its own just-spoken
 * reply is in the registry too, and a user legitimately echoing part of it
 * (answering "the 5 or the 10 minute one?" with "the 10 minute one") must
 * not be treated as self-audio — same-device TTS tails are already handled
 * by the firmware's pre-roll reset. Returns the matching deviceId or null.
 */
export function matchesFleetSpeech(userId, transcript, { excludeDeviceId = null } = {}) {
  const byDevice = _fleetSpeech.get(userId);
  if (!byDevice) return null;
  const norm = normalizeSpeech(transcript);
  const words = norm ? norm.split(' ') : [];
  // One- or two-word captures ("okay", "thank you") are too generic to
  // attribute to our own audio; the continuation gate judges those instead.
  if (words.length < 3) return null;
  const now = Date.now();
  for (const [deviceId, entry] of byDevice) {
    if (excludeDeviceId && deviceId === excludeDeviceId) continue;
    pruneSegments(entry, now);
    if (!entry.segments.length) continue;
    // Segments are already coalesced token runs — join with '' so a segment
    // boundary can't inject a phantom space mid-word.
    const spoken = normalizeSpeech(entry.segments.map(s => s.text).join(''));
    if (!spoken) continue;
    if (spoken.includes(norm)) return deviceId;
  }
  return null;
}

// Words that must ALWAYS be able to interrupt a reply, even when they also
// appear in the text the device is speaking. A reply that happens to contain
// "stop" would otherwise make the user's real "stop" unstoppable — and a
// missed stop costs the user their turn, while a false stop only truncates a
// reply. Same asymmetry the short-barge firmware path was built around.
const BARGE_IMPERATIVE_RE =
  /^(?:stop|wait|hold on|hang on|quiet|be quiet|shut up|shush|enough|that's enough|cancel|never ?mind|nevermind|pause|abort)$/;

/**
 * Does this transcript match what THIS device is speaking right now?
 *
 * Companion to matchesFleetSpeech, for the opposite case. That function
 * deliberately EXCLUDES the capturing device, because a user echoing part of
 * a finished reply is answering it, not bleeding into it. During a barge
 * verify the device is mid-sentence, so its own audio is precisely the
 * suspect — a candidate that transcribes to words it is currently saying is
 * its own voice coming back through the mic.
 *
 * Deliberately has no 3-word floor. matchesFleetSpeech needs one because it
 * scans every other device's speech over 20 s, where a short generic phrase
 * collides easily. Here the comparison is against ONE device's in-flight
 * reply while it is paused mid-utterance, so a single word ("Sure.") is
 * already strong evidence — and that one-word case is the whole failure this
 * exists to catch. Verbatim-substring on normalized text, matching the
 * near-verbatim way STT renders our own TTS.
 *
 * Returns true when the capture should be treated as self-audio.
 */
export function matchesOwnSpeech(userId, deviceId, transcript) {
  if (!userId || !deviceId) return false;
  const norm = normalizeSpeech(transcript);
  if (!norm) return false;
  // An explicit interrupt always wins, however well it matches.
  if (BARGE_IMPERATIVE_RE.test(norm)) return false;
  const entry = _fleetSpeech.get(userId)?.get(deviceId);
  if (!entry) return false;
  const now = Date.now();
  pruneSegments(entry, now);
  if (!entry.segments.length) return false;
  const spoken = normalizeSpeech(entry.segments.map(s => s.text).join(''));
  if (!spoken) return false;
  return spoken.includes(norm);
}

// ── Chain-tail command expansion ───────────────────────────────────────────
// People chain elliptically: "turn off the kitchen … and the porch." The
// anchored intent classifiers can't parse "and the porch" on its own, so the
// chain tail offers the parsers up to three candidate readings of a capture:
// the raw text, the text with chaining connectives stripped ("and the porch"
// → "the porch" / "and turn off the porch" → "turn off the porch"), and the
// stripped text with the PREVIOUS command's verb phrase carried over
// ("turn off" + "the porch" → "turn off the porch").

const CHAIN_LEAD_RE = /^(?:and|also|then|plus|now)[,\s]+/i;
const CHAIN_TRAIL_RE = /[,\s]+(?:too|as well|also|please)[.!?\s]*$/i;
const DEVICE_VERB_RE = /^(?:turn\s+(?:on|off)|switch\s+(?:on|off)|lock|unlock|open|close|dim|brighten|set|start|stop|pause|resume|mute|unmute|play)\b/i;

export function chainCommandCandidates(text, prevUserText = null) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const candidates = [raw];
  let stripped = raw.replace(CHAIN_LEAD_RE, '').replace(CHAIN_TRAIL_RE, '').trim();
  if (stripped && stripped !== raw) candidates.push(stripped);
  // Verb carry-over: only when the fragment itself has no device verb and the
  // previous utterance led with one ("turn off the kitchen" → "turn off").
  if (stripped && !DEVICE_VERB_RE.test(stripped) && prevUserText) {
    const prevVerb = String(prevUserText).trim().match(DEVICE_VERB_RE)?.[0];
    if (prevVerb) candidates.push(`${prevVerb} ${stripped}`);
  }
  return candidates;
}

/** Test hook — wipe registry state between cases. */
export function _resetFleetSpeechForTest() {
  _fleetSpeech.clear();
}

// ── Phase 3: continuation gate ──────────────────────────────────────────────
// Judges whether an in-window utterance reads as a continuation of the
// exchange rather than room conversation that happened to trip the trigger.
// Default is reject (§3.2/§6): a rejected utterance produces NOTHING — no
// chime, no "sorry, I didn't catch that". Deterministic on purpose: zero
// added latency, and every verdict is logged so 'log' mode can measure the
// false-reject rate before 'enforce' is allowed to drop anything.

const CONTINUATION_OPENERS = /^(and|also|what about|how about|but|or|then|no(?:,\s*|\s+)|yes(?:,\s*|\s+)|yeah|yep|okay|ok|actually|wait|now|instead|again|plus|oh|so|make (it|that|them)|the other|that one|this one|those|them|it|that|he|she|they|there|same)\b/;
const CONTINUATION_CLOSERS = /\b(too|as well|instead|please|also)[.!?]*$/;

const contentWords = (s) => new Set(
  normalizeSpeech(s).split(' ').filter(w => w.length > 3)
);

/**
 * @param {{ text: string, prevReplyText?: string|null, prevUserText?: string|null }} args
 * @returns {{ verdict: 'accept'|'reject', reason: string, words: number }}
 */
export function evaluateContinuation({ text, prevReplyText = null, prevUserText = null }) {
  const norm = normalizeSpeech(text);
  const words = norm ? norm.split(' ').length : 0;
  if (!words) return { verdict: 'reject', reason: 'empty', words };
  const t = String(text ?? '').trim().toLowerCase();
  if (CONTINUATION_OPENERS.test(t)) return { verdict: 'accept', reason: 'opener', words };
  if (CONTINUATION_CLOSERS.test(t)) return { verdict: 'accept', reason: 'closer', words };
  const prev = contentWords(`${prevReplyText ?? ''} ${prevUserText ?? ''}`);
  const overlap = [...contentWords(text)].filter(w => prev.has(w)).length;
  const isQuestion = /[?？]["'”’)\]]*$/.test(String(text ?? '').trim());
  // Short speech is common TV/room bleed too, so length alone is not proof
  // of continuation. Keep the useful fragments via opener/closer above,
  // explicit questions, or a concrete lexical tie to the prior turn.
  if (words <= 4) {
    if (isQuestion) return { verdict: 'accept', reason: 'short-question', words };
    if (overlap >= 1) return { verdict: 'accept', reason: 'short-overlap', words };
    return { verdict: 'reject', reason: 'short-unrelated', words };
  }
  // A question that shares vocabulary with the previous turn is a follow-up
  // ("how cold does it get there tonight" after a weather answer).
  if (isQuestion && overlap >= 1) {
    return { verdict: 'accept', reason: 'question-overlap', words };
  }
  if (overlap >= 2) return { verdict: 'accept', reason: 'topic-overlap', words };
  // Long, self-contained, no tie to the exchange → room conversation.
  return { verdict: 'reject', reason: 'unrelated', words };
}
