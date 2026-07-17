import { describe, expect, it } from 'vitest';
import { learnToolPlanFromToolEvents, learnToolPlanFromTurn, matchToolPlan } from './tool-plan-memory.mjs';

const CAT_WORKFLOW = 'make me an image of a cute cat, then check the weather. send me an email of the cat and the current weather.';
let sequence = 0;
function userId(label) { return `tool_plan_${label}_${Date.now()}_${++sequence}`; }
function done(name, args = {}, text = `${name} completed`) {
  return { name, args, status: 'done', text };
}

describe('tool-plan success gates', () => {
  it('does not learn structurally failed or caught-failure tool events', () => {
    const failed = learnToolPlanFromTurn(userId('error_status'), {
      agentId: 'jarvis',
      phrase: 'Generate an image and email it to me',
      usedToolNames: ['generate_image', 'email_user'],
      toolEvents: [
        { name: 'generate_image', args: {}, status: 'error', text: 'Tool error: provider unavailable' },
        done('email_user', { attachment_doc_ids: [] }, 'Email sent. Message ID: test'),
      ],
    });
    expect(failed).toEqual({ ok: false, skipped: 'tool failure' });

    const caught = learnToolPlanFromToolEvents(userId('caught_error'), {
      agentId: 'jarvis',
      phrase: 'Attach the report and email it to me',
      toolEvents: [done('email_user', { attachment_doc_ids: ['documents:missing'] },
        'Could not attach the requested file. Refusing to send the email without the attachment.')],
      resultText: 'I could not deliver the attachment.',
    });
    expect(caught[0]?.learned).not.toBe(true);
    expect(caught[0]?.skipped).toBe('tool failure');
  });

  it('requires requested email and attachment delivery evidence', () => {
    expect(learnToolPlanFromTurn(userId('no_email'), {
      agentId: 'jarvis', phrase: CAT_WORKFLOW,
      usedToolNames: ['localweather_get_weather'],
      toolEvents: [done('localweather_get_weather')],
    })).toEqual({ ok: false, skipped: 'unmet email delivery' });

    expect(learnToolPlanFromTurn(userId('no_attachment'), {
      agentId: 'jarvis', phrase: CAT_WORKFLOW,
      usedToolNames: ['localweather_get_weather', 'email_user'],
      toolEvents: [done('localweather_get_weather'), done('email_user', { attachment_doc_ids: [] }, 'Email sent. Message ID: test')],
    })).toEqual({ ok: false, skipped: 'unmet artifact delivery' });
  });

  it('learns only after delivery confirms the requested attachment', () => {
    const uid = userId('attached');
    const result = learnToolPlanFromTurn(uid, {
      agentId: 'jarvis', phrase: CAT_WORKFLOW,
      usedToolNames: ['localweather_get_weather', 'email_user'],
      initiallyAvailableToolNames: ['localweather_get_weather', 'email_user'],
      fullToolNames: ['localweather_get_weather', 'email_user'],
      toolEvents: [
        done('localweather_get_weather'),
        done('email_user', { attachment_doc_ids: ['images:cute_cat.png'] },
          'Email sent with 1 attachment(s): cute_cat.png. Message ID: test-attached'),
      ],
    });
    expect(result.learned).toBe(true);
    expect(matchToolPlan(uid, { agentId: 'jarvis', phrase: CAT_WORKFLOW })?.selectedTools)
      .toEqual(['localweather_get_weather', 'email_user']);
  });
});
