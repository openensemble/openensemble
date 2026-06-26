import { describe, expect, it } from 'vitest';
import { classifyAutomationText, canRunScheduledTaskSilently } from '../lib/autonomy-policy.mjs';

describe('autonomy policy', () => {
  it('classifies destructive and side-effect automation text', () => {
    expect(classifyAutomationText('delete old files')).toBe('destructive');
    expect(classifyAutomationText('send an email summary')).toBe('side_effect');
    expect(classifyAutomationText('summarize the latest RSS posts')).toBe('low');
  });

  it('allows only low-risk silent scheduled tasks', () => {
    expect(canRunScheduledTaskSilently({ prompt: 'summarize the news', silent: true }))
      .toMatchObject({ ok: true, risk: 'low' });
    expect(canRunScheduledTaskSilently({ prompt: 'post the report to Slack', silent: true }))
      .toMatchObject({ ok: false, risk: 'side_effect' });
    expect(canRunScheduledTaskSilently({ prompt: 'delete old backups', silent: true }))
      .toMatchObject({ ok: false, risk: 'destructive' });
    expect(canRunScheduledTaskSilently({ prompt: 'delete old backups', silent: false }))
      .toMatchObject({ ok: true, risk: 'destructive' });
  });
});
