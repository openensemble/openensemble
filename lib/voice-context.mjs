// @ts-check
/**
 * AsyncLocalStorage that exposes the originating voice-device context
 * (source/deviceId) to deeply-nested skill executors without threading
 * it through every provider call site.
 *
 * Skills that produce verbose output can check getVoiceContext() / isVoiceSource()
 * and format compactly when source === 'voice-device' — the user only
 * hears the reply, so the LLM doesn't need 7 lines per email when 4 will do.
 *
 * Same pattern as tool-router-context.mjs: streamChat() in chat.mjs sets the
 * store via enterWith() so every downstream await/tool dispatch inherits it.
 */
import { AsyncLocalStorage } from 'async_hooks';

/** @type {AsyncLocalStorage<{source: string|null, deviceId: string|null}>} */
export const voiceContext = new AsyncLocalStorage();

export function getVoiceContext() {
  return voiceContext.getStore() ?? null;
}

export function isVoiceSource() {
  return voiceContext.getStore()?.source === 'voice-device';
}

/**
 * System-prompt addition for voice-device chats. Centralised so the
 * coordinator path (chat-dispatch.mjs) and the specialist-router path
 * (chat-dispatch/llm-loop.mjs) inject identical rules.
 *
 * Two concerns:
 *   1. Voice formatting — the user HEARS the reply; the LLM must not
 *      read IDs / emoji category headers / "→ summary:" prefixes that
 *      skill manifests (e.g. email) tell it to use on web.
 *   2. Follow-up listening — firmware opens a 5s listen window when the
 *      LAST sentence ends with "?", so the LLM must phrase clarifications
 *      that way instead of trailing imperatives ("say X", "let me know").
 *
 * Returns '' for non-voice sources so callers can unconditionally append.
 */
export function buildVoiceSystemAddition(source) {
  if (source !== 'voice-device') return '';
  return `

## Voice device — reply formatting (OVERRIDES earlier skill formatting rules)
This reply is coming out of a speaker. The user HEARS it via TTS; they don't see text. Skill manifests (email, calendar, tasks, etc.) tell you to include IDs, emoji category headers, and "→ summary" prefixes — those rules DO NOT APPLY here. Specifically:
- NEVER read message/email/event/task IDs aloud. They're for tool calls, not for the user.
- NEVER speak category headers like "Newsletters/Promos", "Needs Action", "FYI", "Receipts/Orders". Drop the emoji and the label.
- NEVER prefix summaries with "→" or "Summary:" or "Promo email:". Just say the thing.
- No markdown, no bullet lists, no bold. Plain spoken English.
- For a single email: "<sender> — <subject>." That's it. No extra summary unless the user asked "what's it about?".
- For multiple items: read them as a short spoken list, one short sentence each. Skip metadata the user didn't ask for.

## Voice device — follow-up listening
When you need ANY clarification, confirmation, or further info — ALWAYS phrase the LAST sentence as a direct question ending with "?". Don't trail off with imperative "say X" or "let me know" without a closing "?". The device uses the trailing "?" as the signal to keep listening; without it the user has to say the wake word again to respond.`;
}
