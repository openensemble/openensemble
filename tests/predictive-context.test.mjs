/**
 * Tests for the predictive context injection layer (memory/predictive-context.mjs)
 * and its integration with buildAgentContext.
 *
 * Layer 1 coverage — shouldSkipRecall:
 *   - confirmations skip
 *   - slash commands skip
 *   - voice-control utterances skip
 *   - short reactions skip (length-bounded)
 *   - normal questions DO NOT skip
 *   - long messages DO NOT skip even when they start with a reaction word
 *   - empty/whitespace skips
 *
 * Layer 2 coverage — filterByConfidence:
 *   - drops snippets below default threshold
 *   - keeps snippets above default threshold
 *   - immortal rows always pass regardless of score
 *   - rows without a final_score pass (safety: never silently drop unknown shapes)
 *   - empty/non-array input returns []
 *   - custom threshold honored
 *
 * Layer 3 coverage — classifyRecallShape:
 *   - returns the conservative all-true shape for forward-compat
 *
 * Integration coverage — buildAgentContext early-return:
 *   - confirmation message returns the empty-shape with skipped reason
 *   - never embeds, never calls recall
 */

import { describe, it, expect, vi } from 'vitest';
import {
  shouldSkipRecall,
  filterByConfidence,
  classifyRecallShape,
  DEFAULT_INJECTION_THRESHOLD,
} from '../memory/predictive-context.mjs';

describe('shouldSkipRecall', () => {
  it.each([
    'yes', 'YES', 'Yes!', 'no', 'ok', 'okay', 'sure', 'confirm', 'cancel',
    'go', 'stop', 'done', 'trash', 'delete', 'send', 'proceed', 'continue',
    'skip', 'nope', 'yep', 'yup', 'aye', 'nah', 'please', 'thanks',
    'thank you', 'got it', 'sounds good', 'do it', 'go ahead', 'abort',
  ])('skips confirmation: "%s"', (msg) => {
    const r = shouldSkipRecall(msg);
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('confirmation');
  });

  it.each(['/trim', '/threshold 0.5', '/claim sydney', '   /release'])(
    'skips slash command: "%s"',
    (msg) => {
      const r = shouldSkipRecall(msg);
      expect(r.skip).toBe(true);
      expect(r.reason).toBe('slash_command');
    },
  );

  // "stop" and "skip" overlap with CONFIRMATION_RE; the skip behavior is the
  // same, just the reason label differs. Asserting the voice-only set keeps
  // the test about voice-specific routing rather than the labeling overlap.
  it.each([
    'volume up', 'Volume Up', 'volume down', 'volume max', 'volume to 50%',
    'mute', 'unmute', 'pause', 'resume', 'play', 'next', 'previous',
  ])('skips voice control: "%s"', (msg) => {
    const r = shouldSkipRecall(msg);
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('voice_control');
  });

  it.each(['stop', 'skip'])('still skips overlapping verb "%s" (as confirmation)', (msg) => {
    expect(shouldSkipRecall(msg).skip).toBe(true);
  });

  // "really?" deliberately falls through to recall — the trailing "?" lands
  // on QUESTION_HINT_RE, and false-positive recall on a 7-char turn is
  // cheaper than missing real one-word questions like "what?" / "when?".
  it.each(['huh', 'hmm', 'oh wait', 'oops', 'nvm', 'never mind'])(
    'skips short reaction: "%s"',
    (msg) => {
      const r = shouldSkipRecall(msg);
      expect(r.skip).toBe(true);
      expect(r.reason).toBe('short_reaction');
    },
  );

  it.each([
    'what fruit do I like?',
    'which lights are in the kitchen group?',
    'tell me about the project I mentioned yesterday',
    'how does my morning routine work',
    'show me my scheduled tasks',
  ])('does NOT skip a real question: "%s"', (msg) => {
    expect(shouldSkipRecall(msg).skip).toBe(false);
  });

  it('does NOT skip when a reaction word leads a long question', () => {
    // "wait" alone would skip; "wait, what did we say about X..." is a real
    // question with prior-context need.
    const msg = 'wait, what was that project we were discussing last week about cortex?';
    expect(shouldSkipRecall(msg).skip).toBe(false);
  });

  it.each(['', '   ', '\n\n'])('skips empty/whitespace: %j', (msg) => {
    expect(shouldSkipRecall(msg)).toEqual({ skip: true, reason: 'empty' });
  });

  it('handles null/undefined gracefully', () => {
    expect(shouldSkipRecall(null).skip).toBe(true);
    expect(shouldSkipRecall(undefined).skip).toBe(true);
  });
});

describe('filterByConfidence', () => {
  it('drops snippets below the default threshold', () => {
    const memories = [
      { id: 'a', text: 'strong hit', final_score: 0.8 },
      { id: 'b', text: 'weak hit',   final_score: 0.2 },
      { id: 'c', text: 'mid hit',    final_score: DEFAULT_INJECTION_THRESHOLD },
      { id: 'd', text: 'borderline', final_score: DEFAULT_INJECTION_THRESHOLD - 0.001 },
    ];
    const kept = filterByConfidence(memories);
    expect(kept.map(m => m.id)).toEqual(['a', 'c']);
  });

  it('keeps immortal rows even when below threshold', () => {
    const memories = [
      { id: 'pinned', text: 'immortal pref', final_score: 0.1, immortal: true },
      { id: 'weak',   text: 'noise',         final_score: 0.1 },
    ];
    expect(filterByConfidence(memories).map(m => m.id)).toEqual(['pinned']);
  });

  it('passes through rows without a final_score (safety: never silently drop)', () => {
    // Immortal rows from recall.mjs's separate immortal path don't carry a
    // final_score. filterByConfidence must not strip them just because the
    // score is missing.
    const memories = [
      { id: 'no-score-immortal', text: 'pin', immortal: true },
      { id: 'no-score-regular',  text: 'unscored' },
      { id: 'scored-weak',       text: 'weak', final_score: 0.05 },
    ];
    const ids = filterByConfidence(memories).map(m => m.id);
    expect(ids).toContain('no-score-immortal');
    expect(ids).toContain('no-score-regular');
    expect(ids).not.toContain('scored-weak');
  });

  it('returns [] for empty / non-array input', () => {
    expect(filterByConfidence([])).toEqual([]);
    expect(filterByConfidence(null)).toEqual([]);
    expect(filterByConfidence(undefined)).toEqual([]);
  });

  it('honors a custom threshold', () => {
    const memories = [
      { id: 'a', text: 'a', final_score: 0.6 },
      { id: 'b', text: 'b', final_score: 0.4 },
    ];
    expect(filterByConfidence(memories, 0.5).map(m => m.id)).toEqual(['a']);
    expect(filterByConfidence(memories, 0.3).map(m => m.id)).toEqual(['a', 'b']);
  });
});

describe('classifyRecallShape', () => {
  it('returns conservative all-true shape (placeholder until cortex head ships)', () => {
    const shape = classifyRecallShape('any message');
    expect(shape).toEqual({ needsParams: true, needsEpisodes: true, needsFacts: true });
  });

  it('has a stable shape regardless of input — callers can depend on these keys', () => {
    for (const msg of ['', 'short', 'a very long meandering question about lots of things']) {
      const shape = classifyRecallShape(msg);
      expect(Object.keys(shape).sort()).toEqual(['needsEpisodes', 'needsFacts', 'needsParams']);
    }
  });
});

// ── Integration: buildAgentContext early-return ─────────────────────────────
//
// Mock the recall + embed surfaces so we can assert "not called" on the skip
// path. The mocks must be in place BEFORE buildAgentContext is imported
// because that module captures `recall` / `embed` at module-load time.

const embedSpy  = vi.fn(async () => new Array(768).fill(0));
const recallSpy = vi.fn(async () => []);

vi.mock('../memory/embedding.mjs', () => ({ embed: embedSpy }));
vi.mock('../memory/recall.mjs', async () => {
  const actual = await vi.importActual('../memory/recall.mjs');
  return { ...actual, recall: recallSpy };
});

describe('buildAgentContext — predictive skip integration', () => {
  it('confirmation message returns empty context without embedding or recalling', async () => {
    embedSpy.mockClear();
    recallSpy.mockClear();
    const { buildAgentContext } = await import('../memory/context.mjs');

    const ctx = await buildAgentContext('test_agent', 'yes', 'user_test');

    expect(ctx.systemInstructions).toBe('');
    expect(ctx.episodeHistory).toBe('');
    expect(ctx.userContext).toBe('');
    expect(ctx._meta.skipped).toBe('confirmation');
    expect(embedSpy).not.toHaveBeenCalled();
    expect(recallSpy).not.toHaveBeenCalled();
  });

  it('slash command does not trigger recall', async () => {
    embedSpy.mockClear();
    recallSpy.mockClear();
    const { buildAgentContext } = await import('../memory/context.mjs');

    const ctx = await buildAgentContext('test_agent', '/threshold 0.5', 'user_test');

    expect(ctx._meta.skipped).toBe('slash_command');
    expect(recallSpy).not.toHaveBeenCalled();
  });

  it('real question DOES trigger recall (no skip)', async () => {
    embedSpy.mockClear();
    recallSpy.mockClear();
    const { buildAgentContext } = await import('../memory/context.mjs');

    await buildAgentContext('test_agent', 'what fruit do I like?', 'user_test');

    expect(recallSpy).toHaveBeenCalled();
    expect(embedSpy).toHaveBeenCalled();
  });

  it('formatContext omits the cortex-memory block when buildAgentContext returns empty', async () => {
    const { buildAgentContext, formatContext } = await import('../memory/context.mjs');
    const ctx = await buildAgentContext('test_agent', 'ok', 'user_test');
    expect(formatContext(ctx)).toBe('');
  });
});
