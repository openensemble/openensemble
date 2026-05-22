/**
 * In-memory registry of voice-spoken proposals awaiting a yes/no response.
 *
 * Flow:
 *   1. Helen resolves an ambiguous phrase. The routine-proposer creates an
 *      alias_proposal AND calls notePendingVoiceProposal(deviceId, proposalId)
 *      AND sends a TTS sentence ("Want me to remember…?") + await_followup
 *      directly to the device.
 *   2. The device opens a listen window. User says "yes" or "no".
 *   3. chat-dispatch.mjs pre-pipeline calls peekPendingVoiceProposal(deviceId),
 *      detects yes/no in the transcript, then accepts / dismisses the
 *      proposal and clears the entry.
 *
 * TTL handles the case where the user says nothing — entry self-expires so
 * a later unrelated yes/no doesn't accidentally confirm a forgotten ask.
 */

const _queue = new Map();              // deviceId → { proposalId, expiresAt }
const TTL_MS = 30 * 1000;

export function notePendingVoiceProposal(deviceId, proposalId) {
  if (!deviceId || !proposalId) return;
  _queue.set(deviceId, { proposalId, expiresAt: Date.now() + TTL_MS });
}

export function peekPendingVoiceProposal(deviceId) {
  if (!deviceId) return null;
  const entry = _queue.get(deviceId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _queue.delete(deviceId); return null; }
  return entry;
}

export function clearPendingVoiceProposal(deviceId) {
  if (!deviceId) return;
  _queue.delete(deviceId);
}
