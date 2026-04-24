/**
 * OpenRouter — OpenAI-compat SSE with tool calling.
 */

import { executeToolStreaming } from '../../roles.mjs';
import {
  OPENROUTER_URL, readAnthropicSSE, getOpenRouterKey,
  stripThinking, stripReasoningPreamble, getStripThinkingTags,
} from './_shared.mjs';
import { LoopGuard, compressToolDefs } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';

export async function* streamOpenRouter(agent, systemPrompt, messages, signal, userId = 'default') {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    yield { type: 'error', message: 'OpenRouter API key not set. Add it in Settings → Providers.' };
    return;
  }

  const working = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];
  const orTools = agent.tools?.length
    ? compressToolDefs(agent.tools).map(t => ({ type: 'function', function: t.function }))
    : undefined;

  let assistantContent = '';
  let totalInputTokens = 0, totalOutputTokens = 0;
  const guard = new LoopGuard(agent.maxToolLoops ?? 500);

  while (guard.tick()) {
    const body = {
      model:    agent.model,
      messages: working,
      stream:   true,
    };
    if (agent.maxTokens) body.max_tokens = agent.maxTokens;
    if (orTools) body.tools = orTools;

    const res = await fetch(OPENROUTER_URL, {
      method: 'POST', signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'https://openensemble.app',
        'X-Title':       'OpenEnsemble',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      yield { type: 'error', message: `OpenRouter error ${res.status}: ${await res.text()}` };
      return;
    }

    let textContent  = '';
    const toolCalls  = new Map(); // index -> { id, name, argsJson }
    let finishReason = null;
    let tokenCount   = 0;
    const startedAt  = Date.now();
    let firstTokenAt = null;

    for await (const event of readAnthropicSSE(res.body)) {
      // Token usage (OpenRouter sends this in the last chunk or as a separate event)
      if (event.usage) {
        totalInputTokens  += event.usage.prompt_tokens     ?? 0;
        totalOutputTokens += event.usage.completion_tokens ?? 0;
      }
      const choice = event.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (delta.content) {
        if (!firstTokenAt) firstTokenAt = Date.now();
        tokenCount++;
        textContent += delta.content;
        yield { type: 'token', text: delta.content };
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: tc.id ?? `tc${idx}`, name: '', argsJson: '' });
        const entry = toolCalls.get(idx);
        if (tc.function?.name)      entry.name     += tc.function.name;
        if (tc.function?.arguments) entry.argsJson += tc.function.arguments;
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (finishReason === 'tool_calls' || finishReason === 'stop') break;
    }

    if (toolCalls.size > 0) {
      if (textContent.trim()) yield { type: 'replace', text: '' };

      const blocks = [...toolCalls.values()];

      if (blocks.length > 1) {
        // Multiple tool calls in one assistant turn — run in parallel.
        // All tools run via executeToolStreaming (blocking per-tool, full
        // result returned). Promise.all gives us concurrency. For ask_agent,
        // the coordinator waits for specialist responses before synthesizing.
        // Events are buffered per-tool and replayed in order after all complete.
        const parsed = blocks.map(block => {
          let args = {};
          try { args = JSON.parse(block.argsJson || '{}'); } catch { /* ignore */ }
          return { block, toolArgs: args };
        });
        for (const { block, toolArgs } of parsed) {
          yield { type: 'tool_call', name: block.name, args: toolArgs };
        }
        const results = await Promise.all(parsed.map(async ({ block, toolArgs }) => {
          const { text, _notify, events } = await drainToolWithEvents(block.name, toolArgs, userId, agent.id);
          return { block, toolArgs, result: text, _notify, events };
        }));
        const assistantToolCalls = results.map(({ block }) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.argsJson } }));
        working.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
        for (const { block, result, _notify, events } of results) {
          for (const ev of events) yield ev;
          yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
          if (_notify) yield { type: '__notify', name: block.name, ..._notify };
          working.push({ role: 'tool', tool_call_id: block.id, content: result });
        }
        { const sc = guard.check(results.map(r => ({ name: r.block.name, args: r.block.argsJson })), results.map(r => r.result));
          if (sc.stalled) { console.warn(`[openrouter] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
        continue;
      }

      // Sequential execution for single or mixed tool calls
      const assistantToolCalls = blocks.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.argsJson } }));
      working.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
      const orSeqResults = [];
      for (const block of blocks) {
        let args = {};
        try { args = JSON.parse(block.argsJson || '{}'); } catch (e) { console.warn('[chat] Failed to parse OpenRouter tool args:', e.message); }
        yield { type: 'tool_call', name: block.name, args };
        let orToolResult = '';
        for await (const chunk of executeToolStreaming(block.name, args, userId, agent.id)) {
          if (chunk.type === 'token')              orToolResult += chunk.text;
          if (chunk.type === 'permission_request') yield chunk;
          if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args };
          if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) };
          if (chunk.type === 'result')             orToolResult = chunk.text;
        }
        const { text: result, _notify } = normalizeToolResult(orToolResult);
        yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
        if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        working.push({ role: 'tool', tool_call_id: block.id, content: result });
        orSeqResults.push({ name: block.name, args: block.argsJson, result });
      }
      { const sc = guard.check(orSeqResults.map(r => ({ name: r.name, args: r.args })), orSeqResults.map(r => r.result));
        if (sc.stalled) { console.warn(`[openrouter] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
      continue;
    }

    assistantContent = stripReasoningPreamble(getStripThinkingTags() ? stripThinking(textContent) : textContent);
    if (assistantContent !== textContent) yield { type: 'replace', text: assistantContent };
    if (firstTokenAt && tokenCount > 0) {
      const genSecs = (Date.now() - firstTokenAt) / 1000;
      yield { type: 'perf',
        tps:    Math.round((tokenCount / Math.max(genSecs, 0.001)) * 10) / 10,
        ttft:   firstTokenAt - startedAt,
        tokens: tokenCount,
      };
    }
    break;
  }

  yield { type: '__content', content: assistantContent };
  if (totalInputTokens || totalOutputTokens) {
    yield { type: '__usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, provider: 'openrouter', model: agent.model };
  }
}
