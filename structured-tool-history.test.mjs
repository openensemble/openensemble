import { describe, expect, it } from 'vitest';

import { adaptLlmHistoryForProvider, buildLlmHistory } from './chat.mjs';
import { toResponsesInput } from './chat/providers/openai-responses.mjs';
import { normalizeStructuredToolHistoryGuidance } from './lib/skill-prompt-composer.mjs';

function modernToolTurn(overrides = {}) {
  return {
    role: 'assistant',
    content: 'The newest message says hello.',
    toolsUsed: ['email_read({"account":"Lab Mail","messageId":"3"})'],
    toolResults: [{ name: 'email_read', text: 'message id: 3\nbody: hello' }],
    toolEvents: [{
      name: 'email_read',
      args: { account: 'Lab Mail', messageId: '3' },
      status: 'done',
      resultIndex: 0,
    }],
    ...overrides,
  };
}

describe('structured persisted tool history', () => {
  it('reconstructs an actual call/result boundary without provenance prose', () => {
    const history = buildLlmHistory([
      { role: 'user', content: 'Read the newest message.' },
      modernToolTurn(),
    ]);

    expect(history).toEqual([
      { role: 'user', content: 'Read the newest message.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_hist_1_0',
          type: 'function',
          function: {
            name: 'email_read',
            arguments: '{"account":"Lab Mail","messageId":"3"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_hist_1_0',
        name: 'email_read',
        content: 'message id: 3\nbody: hello',
      },
      { role: 'assistant', content: 'The newest message says hello.' },
    ]);
    expect(JSON.stringify(history)).not.toContain('[tools used this turn:');
    expect(JSON.stringify(history)).not.toContain('[prior-turn tool results]');

    // The Responses adapter must receive genuine protocol items, not text that
    // merely looks like a tool transcript.
    expect(toResponsesInput(history)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_hist_1_0',
        name: 'email_read',
        arguments: '{"account":"Lab Mail","messageId":"3"}',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_hist_1_0',
        output: 'message id: 3\nbody: hello',
      }),
    ]));
  });

  it('keeps full outputs for only the two newest tool turns', () => {
    const history = buildLlmHistory([
      { role: 'user', content: 'first' },
      modernToolTurn({ content: 'first done', toolResults: [{ name: 'email_read', text: 'old-secret-handle' }] }),
      { role: 'user', content: 'second' },
      modernToolTurn({ content: 'second done', toolResults: [{ name: 'email_read', text: 'middle-handle' }] }),
      { role: 'user', content: 'third' },
      modernToolTurn({ content: 'third done', toolResults: [{ name: 'email_read', text: 'new-handle' }] }),
    ]);
    const outputs = history.filter(row => row.role === 'tool').map(row => row.content);
    expect(outputs).toEqual([
      '[Tool result omitted from older conversation context.]',
      'middle-handle',
      'new-handle',
    ]);
    expect(JSON.stringify(history)).not.toContain('old-secret-handle');
  });

  it('falls back to legacy call summaries and degrades truncated args to an empty object', () => {
    const history = buildLlmHistory([
      {
        role: 'assistant',
        content: 'Done.',
        toolsUsed: [
          'email_send({"to":"capture@example.test"})',
          'email_read({"account":"a very long truncated preview',
        ],
        toolResults: [
          { name: 'email_send', text: 'accepted' },
          { name: 'email_read', text: 'body' },
        ],
      },
    ]);
    const calls = history[0].tool_calls;
    expect(calls[0].function).toEqual({
      name: 'email_send',
      arguments: '{"to":"capture@example.test"}',
    });
    expect(calls[1].function).toEqual({ name: 'email_read', arguments: '{}' });
    expect(history.filter(row => row.role === 'tool').map(row => row.content)).toEqual(['accepted', 'body']);
  });

  it('does not fabricate a local function call for provider-hosted search', () => {
    const history = buildLlmHistory([
      modernToolTurn({
        content: 'Here is what I found.',
        toolsUsed: ['web_search'],
        toolResults: [{ name: 'web_search', text: 'provider-hosted web search' }],
        toolEvents: [{ name: 'web_search', args: null, status: 'done', native: true }],
      }),
    ]);
    expect(history).toEqual([{ role: 'assistant', content: 'Here is what I found.' }]);
  });

  it('keeps the coordinator ask_agent boundary but omits delegated specialist calls', () => {
    const history = buildLlmHistory([modernToolTurn({
      content: 'The specialist completed the email check.',
      toolsUsed: ['ask_agent', 'email_read'],
      toolResults: [
        { name: 'ask_agent', text: 'Specialist report' },
        { name: 'email_read', text: 'Nested email body' },
      ],
      toolEvents: [
        { name: 'ask_agent', args: { role: 'email' }, status: 'done', resultIndex: 0 },
        { name: 'email_read', args: { messageId: '3' }, status: 'done', resultIndex: 1, delegated: true },
      ],
    })]);

    expect(history.filter(row => row.role === 'tool')).toEqual([{
      role: 'tool',
      tool_call_id: 'call_hist_0_0',
      name: 'ask_agent',
      content: 'Specialist report',
    }]);
    expect(JSON.stringify(history)).not.toContain('Nested email body');
  });

  it('uses modern result indexes instead of guessing across repeated tool names', () => {
    const history = buildLlmHistory([modernToolTurn({
      toolsUsed: ['email_read({"messageId":"1"})', 'email_read({"messageId":"2"})'],
      toolResults: [{ name: 'email_read', text: 'second result only' }],
      toolEvents: [
        { name: 'email_read', args: { messageId: '1' }, status: 'done' },
        { name: 'email_read', args: { messageId: '2' }, status: 'done', resultIndex: 0 },
      ],
    })]);

    expect(history.filter(row => row.role === 'tool').map(row => row.content)).toEqual([
      '[Tool completed, but no textual result was retained.]',
      'second result only',
    ]);
  });

  it('uses call-local legacy toolEvent text when result indexes predate the row', () => {
    const history = buildLlmHistory([modernToolTurn({
      toolsUsed: ['email_read({"messageId":"legacy"})'],
      toolResults: [{ name: 'email_read', text: 'unrelated retained result' }],
      toolEvents: [{
        name: 'email_read',
        args: { messageId: 'legacy' },
        status: 'done',
        text: 'legacy body with message id 17',
      }],
    })]);

    expect(history.find(row => row.role === 'tool')?.content)
      .toBe('legacy body with message id 17');
  });

  it('does not feed legacy or model-imitated provenance appendices back as assistant prose', () => {
    const history = buildLlmHistory([{
      role: 'assistant',
      content: 'The body is hello.\n[tools used this turn: email_read({"messageId":"3"})]\n\n[prior-turn tool results]\nemail_read →\nbody: hello',
    }]);

    expect(history).toEqual([{ role: 'assistant', content: 'The body is hello.' }]);
    expect(JSON.stringify(history)).not.toContain('email_read →');
  });

  it('drops a marker-only assistant row after reserved provenance is stripped', () => {
    const history = buildLlmHistory([{
      role: 'assistant',
      content: '[tools used this turn: email_read]\n[prior-turn tool results]\nemail_read →\nbody: invented',
    }]);
    expect(history).toEqual([]);
  });

  it('renders Anthropic-native tool_use/tool_result blocks', () => {
    const canonical = buildLlmHistory([
      { role: 'user', content: 'Read it.' },
      modernToolTurn(),
    ]);
    const history = adaptLlmHistoryForProvider(canonical, 'anthropic');

    expect(history).toEqual([
      { role: 'user', content: 'Read it.' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_hist_1_0',
          name: 'email_read',
          input: { account: 'Lab Mail', messageId: '3' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_hist_1_0',
          content: 'message id: 3\nbody: hello',
        }],
      },
      { role: 'assistant', content: 'The newest message says hello.' },
    ]);
    expect(history.some(row => row.role === 'tool' || row.tool_calls)).toBe(false);
  });

  it('renders Ollama object arguments and name-paired tool results', () => {
    const canonical = buildLlmHistory([modernToolTurn()]);
    const history = adaptLlmHistoryForProvider(canonical, 'ollama');

    expect(history[0].tool_calls[0].function.arguments).toEqual({
      account: 'Lab Mail',
      messageId: '3',
    });
    expect(history[1]).toEqual({
      role: 'tool',
      name: 'email_read',
      content: 'message id: 3\nbody: hello',
    });
  });

  it('removes stale prose-marker directions from the composed email guidance', () => {
    const old = 'Message IDs come back in the tool result, and that tool result is appended to your prior assistant entry under a `[prior-turn tool results]` block on every subsequent turn. When asked to open it, look at the most recent `[prior-turn tool results]` block in your context.';
    const guidance = normalizeStructuredToolHistoryGuidance(old);

    expect(guidance).toContain('preserved in conversation context as a structured tool result');
    expect(guidance).toContain('most recent structured email tool result');
    expect(guidance).not.toContain('[prior-turn tool results]');
  });
});
