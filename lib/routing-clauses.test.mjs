import { describe, expect, it } from 'vitest';

import {
  isStandaloneRoutingRequest,
  routingClauses,
  routingInstructionClauses,
} from './routing-clauses.mjs';

describe('routing clauses', () => {
  it('keeps a simple lookup and an ordinary noun conjunction standalone', () => {
    expect(routingClauses("What's the weather in Cape Coral?")).toHaveLength(1);
    expect(routingClauses('Show the current weather and forecast')).toHaveLength(1);
    expect(isStandaloneRoutingRequest('Show the current weather and forecast')).toBe(true);
  });

  it('separates explicit dependent workflow steps', () => {
    const prompt = 'Make me an image of a cute cat, then check the weather. Send me an email of the cat and the current weather.';
    expect(routingClauses(prompt)).toEqual([
      'Make me an image of a cute cat',
      'check the weather',
      'Send me an email of the cat and the current weather',
    ]);
    expect(isStandaloneRoutingRequest(prompt)).toBe(false);
    expect(isStandaloneRoutingRequest('Check the weather, then email it to me')).toBe(false);
    expect(isStandaloneRoutingRequest('Check the weather and email it to me')).toBe(false);
    expect(isStandaloneRoutingRequest('Check the weather\n\nEmail it to me')).toBe(false);
  });

  it('keeps later list actions but excludes ordinary payload prose', () => {
    expect(routingInstructionClauses('Make a cat image\n\nCheck the weather\n\nEmail it to me')).toEqual([
      'Make a cat image',
      'Check the weather',
      'Email it to me',
    ]);
    expect(routingInstructionClauses('Summarize this report:\n\nWeather trends rose all summer.\nHumidity was unusually high.')).toEqual([
      'Summarize this report:',
    ]);
    expect(routingInstructionClauses('Summarize this report:\n\nCheck the weather before leaving.\nSales increased afterward.')).toEqual([
      'Summarize this report:',
    ]);
    expect(routingInstructionClauses('Email this text:\n\nHow is the weather today? That was the survey question.')).toEqual([
      'Email this text:',
    ]);
    for (const prompt of [
      'Summarize this:\n\nCheck the weather before leaving.',
      'Summarize the report below:\n\nCheck the weather before leaving.',
      'Can you summarize this report:\n\nHow is the weather today?',
      'Could you please summarize this report:\n\nHow is the weather today?',
      'Email this to Dana:\n\nCheck the weather before leaving.',
      'Draft an email using this text:\n\nCheck the weather before leaving.',
      'Create a summary of the following report:\n\nCheck the weather before leaving.',
      'Summarize this report: Check the weather before leaving.',
    ]) {
      expect(routingInstructionClauses(prompt), prompt).toHaveLength(1);
      expect(routingInstructionClauses(prompt)[0], prompt).not.toMatch(/weather/i);
    }
    expect(routingInstructionClauses('Summarize the attached report\n\nCheck the weather\n\nEmail the summary to me')).toEqual([
      'Summarize the attached report',
      'Check the weather',
      'Email the summary to me',
    ]);
    expect(routingInstructionClauses('Do these tasks:\n\nMake a cat image\n\nCheck the weather\n\nEmail it to me')).toEqual([
      'Do these tasks:',
      'Make a cat image',
      'Check the weather',
      'Email it to me',
    ]);
    expect(routingInstructionClauses('Summarize this report for 3:00 PM, then check the weather, then email it')).toEqual([
      'Summarize this report for 3:00 PM',
      'check the weather',
      'email it',
    ]);
    expect(routingInstructionClauses('Review this page at https://example.com:8443, then check the weather')).toEqual([
      'Review this page at https://example.com:8443',
      'check the weather',
    ]);
    expect(routingInstructionClauses('Summarize this report: then check the weather')).toEqual([
      'Summarize this report:',
      'check the weather',
    ]);
  });
});
