/**
 * LM Studio streaming — two paths:
 *   - streamLMStudio: native /api/v1/chat (stateful, no-tools only).
 *     Uses previous_response_id so LM Studio maintains context server-side.
 *   - streamLMStudioCompat: /v1/chat/completions (OpenAI-compat, used when
 *     the agent has tools since the native endpoint doesn't support them).
 */

import { executeToolStreaming } from '../../roles.mjs';
import { loadSession, getLmsResponseId, setLmsResponseId } from '../../sessions.mjs';
import {
  LMSTUDIO_NATIVE, LMSTUDIO_COMPAT, readAnthropicSSE,
  stripThinking, stripReasoningPreamble, getStripThinkingTags,
} from './_shared.mjs';
import { LoopGuard, compressToolDefs } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';

// ── LM Studio — native /api/v1/chat (stateful, no-tools path) ────────────────
// Uses previous_response_id so LM Studio maintains context server-side.
// NOTE: The native endpoint does NOT support tools/tool_choice — those calls
// fall through to streamLMStudioCompat which uses /v1/chat/completions (SSE).
export async function* streamLMStudio(agent, systemPrompt, userText, agentId, signal, userId = 'default') {
  if (agent.tools?.length) {
    yield* streamLMStudioCompat(agent, systemPrompt, userText, agentId, signal, userId);
    return;
  }

  const prevId = getLmsResponseId(agentId);

  const body = {
    model:         agent.model,
    input:         userText,
    system_prompt: systemPrompt,
    stream:        true,
    store:         true,
  };
  if (agent.think === false) body.reasoning = 'off';
  if (prevId) body.previous_response_id = prevId;

  const res = await fetch(LMSTUDIO_NATIVE, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    if (prevId && (res.status === 400 || res.status === 404)) {
      setLmsResponseId(agentId, '');
      yield* streamLMStudio(agent, systemPrompt, userText, agentId, signal, userId);
      return;
    }
    yield { type: 'error', message: `LM Studio error ${res.status}: ${err}` };
    return;
  }

  let textContent = '';
  let responseId  = null;
  let inThink     = false;
  let _lmsTokensPredicted = 0;
  // Read once at request start — config file mtime is already cached but we
  // still pay a stat() + map lookup per token without this hoist.
  const stripTags = getStripThinkingTags();

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]' || !raw) continue;
      let event;
      try { event = JSON.parse(raw); } catch { continue; }

      const evType = event.type ?? event.event;

      if (evType === 'message.delta') {
        const text = event.content ?? event.delta?.content ?? '';
        if (!text) continue;
        textContent += text;
        if (stripTags) {
          if (!inThink && text.includes('<think>')) {
            const before = text.split('<think>')[0];
            if (before) yield { type: 'token', text: before };
            inThink = true;
          }
          if (inThink) {
            if (text.includes('</think>')) {
              inThink = false;
              const after = text.split('</think>').pop();
              if (after) yield { type: 'token', text: after };
            }
            continue;
          }
        }
        yield { type: 'token', text };
      }

      if (evType === 'chat.end' || evType === 'message.end') {
        responseId = event.response_id ?? event.result?.response_id ?? null;
        const s = event.stats ?? event.result?.stats;
        if (s) {
          _lmsTokensPredicted = s.tokens_predicted ?? 0;
          yield { type: 'perf',
            tps:    s.tokens_predicted_per_second ?? null,
            ttft:   s.time_to_first_token_ms      ?? null,
            tokens: s.tokens_predicted             ?? null,
          };
        }
      }
    }
  }

  if (responseId) setLmsResponseId(agentId, responseId);
  const lmsContent = stripReasoningPreamble(stripTags ? stripThinking(textContent) : textContent);
  if (lmsContent !== textContent) yield { type: 'replace', text: lmsContent };
  yield { type: '__content', content: lmsContent };
  // Approximate token usage from stats (LM Studio native provides tokens_predicted)
  if (_lmsTokensPredicted) {
    // Input tokens not available in native mode; approximate from prompt length
    const approxInput = Math.ceil(userText.length / 4);
    yield { type: '__usage', inputTokens: approxInput, outputTokens: _lmsTokensPredicted, provider: 'lmstudio', model: agent.model };
  }
}

// ── LM Studio — OpenAI-compat /v1/chat/completions (used when tools needed) ───
export async function* streamLMStudioCompat(agent, systemPrompt, userText, agentId, signal, userId = 'default') {
  // Need full history for tool-using requests since compat endpoint is stateless
  const history = loadSession(agentId).map(({ role, content }) => ({ role, content }));
  const working = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userText },
  ];
  const lmTools = compressToolDefs(agent.tools).map(t => ({ type: 'function', function: t.function }));

  let assistantContent = '';
  let totalCompatTokens = 0;
  const guard = new LoopGuard(agent.maxToolLoops ?? 500);

  while (guard.tick()) {
    // Force tool use on the first call so models like GLM don't skip tools and answer from history.
    // Subsequent iterations (after a tool result) use 'auto' to allow a free-text final response.
    const toolChoice = guard.count === 1 ? 'required' : 'auto';
    const body = { model: agent.model, messages: working, stream: true, tools: lmTools, tool_choice: toolChoice };
    if (agent.maxTokens) body.max_tokens = agent.maxTokens;
    if (agent.think === false) body.reasoning = 'off';

    const res = await fetch(LMSTUDIO_COMPAT, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      yield { type: 'error', message: `LM Studio error ${res.status}: ${await res.text()}` };
      return;
    }

    let textContent  = '';
    const toolCalls  = new Map(); // index -> { id, name, argsJson }
    let tokenCount   = 0;
    const startedAt  = Date.now();
    let firstTokenAt = null;

    for await (const event of readAnthropicSSE(res.body)) {
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
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') break;
    }

    if (toolCalls.size > 0) {
      // Clear any reasoning preamble streamed before the tool call
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
          const { text, _notify, events } = await drainToolWithEvents(block.name, toolArgs, userId, agentId);
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
          if (sc.stalled) { console.warn(`[lmstudio] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
        continue;
      }

      // Sequential execution for single or mixed tool calls
      const assistantToolCalls = blocks.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.argsJson } }));
      working.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
      const lmSeqResults = [];
      for (const block of blocks) {
        let args = {};
        try { args = JSON.parse(block.argsJson || '{}'); } catch (e) { console.warn('[chat] Failed to parse LM Studio tool args:', e.message); }
        yield { type: 'tool_call', name: block.name, args };
        let lmToolResult = '';
        for await (const chunk of executeToolStreaming(block.name, args, userId, agentId)) {
          if (chunk.type === 'token')              lmToolResult += chunk.text;
          if (chunk.type === 'permission_request') yield chunk;
          if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args };
          if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) };
          if (chunk.type === 'result')             lmToolResult = chunk.text;
        }
        const { text: result, _notify } = normalizeToolResult(lmToolResult);
        yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
        if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        working.push({ role: 'tool', tool_call_id: block.id, content: result });
        lmSeqResults.push({ name: block.name, args: block.argsJson, result });
      }
      { const sc = guard.check(lmSeqResults.map(r => ({ name: r.name, args: r.args })), lmSeqResults.map(r => r.result));
        if (sc.stalled) { console.warn(`[lmstudio] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
      continue;
    }

    assistantContent = stripReasoningPreamble(getStripThinkingTags() ? stripThinking(textContent) : textContent);
    if (assistantContent !== textContent) yield { type: 'replace', text: assistantContent };
    // Emit timing stats derived from wall clock
    totalCompatTokens += tokenCount;
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
  // LM Studio compat: approximate tokens from streamed token count
  if (totalCompatTokens > 0) {
    const approxInput = Math.ceil(userText.length / 4);
    yield { type: '__usage', inputTokens: approxInput, outputTokens: totalCompatTokens, provider: 'lmstudio', model: agent.model };
  }
}
