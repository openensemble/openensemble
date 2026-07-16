import { describe, expect, it } from 'vitest';
import { isReasoningUnsupportedError } from './reasoning-effort.mjs';

describe('reasoning compatibility errors', () => {
  it('matches only errors that identify a reasoning control', () => {
    expect(isReasoningUnsupportedError(400, 'Unsupported parameter: reasoning')).toBe(true);
    expect(isReasoningUnsupportedError(422, 'Unknown field reasoning_effort')).toBe(true);
    expect(isReasoningUnsupportedError(400, 'output_config is not permitted')).toBe(true);
    expect(isReasoningUnsupportedError(400, 'thinking is unsupported')).toBe(true);
  });

  it('does not spend a reasoning retry on an unrelated rejected field', () => {
    expect(isReasoningUnsupportedError(400, 'Unsupported parameter: max_output_tokens')).toBe(false);
    expect(isReasoningUnsupportedError(400, 'Unknown parameter: metadata')).toBe(false);
    expect(isReasoningUnsupportedError(500, 'reasoning is unavailable')).toBe(false);
  });
});
