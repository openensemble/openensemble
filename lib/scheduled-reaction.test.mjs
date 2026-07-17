import { describe, expect, it, vi } from 'vitest';

import {
  buildScheduledReactionPrompt,
  createScheduledReactionTerminalCapture,
} from './scheduled-reaction.mjs';

describe('scheduled reaction contract', () => {
  it('separates new triggers from cumulative dependency context', () => {
    const prompt = buildScheduledReactionPrompt({
      task: { id: 'task_1', agent: 'jarvis', prompt: 'Research, chart, then email both.' },
      aggregate: 'chart saved as images:chart.png',
      cumulativeAggregate: 'research saved as research:doc_1\nchart saved as images:chart.png',
    });

    const newResults = prompt.match(/<new_results>\n([\s\S]*?)\n<\/new_results>/)?.[1];
    const allContext = prompt.match(/<all_results_context>\n([\s\S]*?)\n<\/all_results_context>/)?.[1];
    expect(newResults).toBe('chart saved as images:chart.png');
    expect(newResults).not.toContain('research:doc_1');
    expect(allContext).toContain('research:doc_1');
    expect(allContext).toContain('images:chart.png');
    expect(prompt).toContain('ALL_RESULTS_CONTEXT is read-only context');
    expect(prompt).toContain('do not repeat an action');
  });

  it('accepts exactly a successful done terminal and forwards events', () => {
    const forward = vi.fn();
    const capture = createScheduledReactionTerminalCapture(forward);
    capture.onEvent({ type: 'token', text: 'sent' });
    capture.onEvent({ type: 'done' });

    expect(capture.assertSucceeded()).toBe(true);
    expect(capture.snapshot()).toMatchObject({ terminal: 'done' });
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it.each([
    [[{ type: 'error', message: 'email failed' }, { type: 'done' }], 'email failed'],
    [[{ type: 'stopped', message: 'cancelled' }], 'cancelled'],
    [[{ type: 'token', text: 'partial only' }], 'without a successful terminal'],
  ])('rejects failed, stopped, or absent terminals', (events, expected) => {
    const capture = createScheduledReactionTerminalCapture();
    for (const event of events) capture.onEvent(event);
    expect(() => capture.assertSucceeded()).toThrow(expected);
  });
});

