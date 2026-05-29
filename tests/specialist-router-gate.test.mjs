// @ts-check
// Unit test for the compound-/delegation-detection gate in
// chat-dispatch/llm-loop.mjs. Background: a single-label intent classifier
// (regex or embedding) routes the whole user message to one specialist.
// On a multi-step request ("Compile briefing. Send via Telegram. Also
// delegate to email specialist") that's structurally wrong — the picked
// specialist can satisfy at most one step. The gate forces those messages
// down the coordinator's LLM path instead.
import { describe, it, expect } from 'vitest';
import { looksCompoundOrDelegation } from '../chat-dispatch/llm-loop.mjs';

describe('looksCompoundOrDelegation', () => {
  describe('returns true on', () => {
    it('explicit "delegate to" instruction', () => {
      expect(looksCompoundOrDelegation('delegate to the email specialist')).toBe(true);
    });
    it('"have <agent> email" delegation', () => {
      expect(looksCompoundOrDelegation('have Alex email it to me')).toBe(true);
    });
    it('"the email specialist" mention', () => {
      expect(looksCompoundOrDelegation('Also delegate to the email specialist to email the briefing')).toBe(true);
    });
    it('multi-step compound briefing request (the routing-bug case)', () => {
      const msg = "Compile a concise daily news briefing with current top headlines and any major weather/market/context items relevant to me. Send the full briefing to me via Telegram using send_telegram_message. Also delegate to the email specialist to email the same briefing to me at alex@example.com with subject 'Daily News Briefing'. Format the email as html making it look like a newspaper.";
      expect(looksCompoundOrDelegation(msg)).toBe(true);
    });
    it('"and also send" connective', () => {
      expect(looksCompoundOrDelegation('Tell me about quantum computing and also send a summary to my phone')).toBe(true);
    });
    it('3+ sentences with distinct imperatives', () => {
      expect(looksCompoundOrDelegation('Research the weather. Summarize the news. Save it.')).toBe(true);
    });
  });

  describe('returns false on', () => {
    it('simple single-intent question', () => {
      expect(looksCompoundOrDelegation('check my email')).toBe(false);
    });
    it('simple research request', () => {
      expect(looksCompoundOrDelegation('research the latest GPU benchmarks')).toBe(false);
    });
    it('home assistant control', () => {
      expect(looksCompoundOrDelegation('turn off the kitchen lights')).toBe(false);
    });
    it('empty/short text', () => {
      expect(looksCompoundOrDelegation('')).toBe(false);
      expect(looksCompoundOrDelegation('hi')).toBe(false);
    });
    it('two short sentences with same verb', () => {
      // Catches "what time is it. what day is it." — same verb, shouldn't be
      // considered compound enough to skip routing.
      expect(looksCompoundOrDelegation('what time is it. what day is it.')).toBe(false);
    });
  });
});
