import { normalizeSegmentText } from './voice-tts-stream.mjs';

// Reuse the speaker pipeline's cleanup; never edit the displayed chat reply.
export function mobileSpeechText(text) {
  if (typeof text !== 'string' || text.length > 32000) {
    throw new Error('Voice reply must be text no longer than 32000 characters');
  }
  return normalizeSegmentText(text);
}

// A phone has no wake-word slot. Use the first configured voice for the signed-in
// account, in slot order, then an explicitly shared household assignment, then
// the server default. The reference stays owned by the configuration's owner,
// just as it does on hardware. Chat always remains in the signed-in account.
export function accountSpeechVoice(userId, assignments, fallback, incoming = []) {
  const slots = Object.entries(assignments || {}).sort(([a], [b]) => Number(a) - Number(b));
  const match = slots.find(([, slot]) => slot?.ownerUserId === userId
    && typeof slot.ttsVoice === 'string' && slot.ttsVoice.trim());
  if (match) return { voice: match[1].ttsVoice, ownerUserId: userId };
  const shared = incoming.filter(entry => entry.assignment?.ownerUserId === userId
    && /^[A-Za-z0-9_-]{1,128}$/.test(entry.ownerUserId || '')
    && typeof entry.assignment.ttsVoice === 'string' && entry.assignment.ttsVoice.trim())
    .sort((a, b) => a.ownerUserId.localeCompare(b.ownerUserId) || a.slot - b.slot)[0];
  return shared ? { voice: shared.assignment.ttsVoice, ownerUserId: shared.ownerUserId }
    : { voice: fallback, ownerUserId: userId };
}
