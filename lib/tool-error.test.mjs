import { describe, expect, it } from 'vitest';

import { looksLikeToolError, looksLikeToolRefusal, normalizeToolResult } from './tool-error.mjs';

describe('tool error classification', () => {
  it('classifies dispatcher policy refusals separately from returned execution errors', () => {
    for (const text of [
      'Unknown tool: email_user',
      'Tool "email_user" is not permitted for this account.',
      'Tool "email_user" is from a disabled skill.',
      'Tool "email_user" is hidden by your settings.',
    ]) expect(looksLikeToolRefusal(text)).toBe(true);
    expect(looksLikeToolRefusal('The report discusses an unknown tool: archaeology.')).toBe(false);
  });

  it('classifies account-labelled wrapped errors', () => {
    const text = 'Error (Lab Mail): Command failed';
    expect(looksLikeToolError(text)).toBe(true);
    expect(normalizeToolResult(text)).toEqual({ isError: true, text });
  });

  it('keeps long untrusted content from becoming a tool failure', () => {
    const text = `Error (quoted email subject): ${'ordinary message body '.repeat(40)}`;
    expect(looksLikeToolError(text)).toBe(false);
  });
});
