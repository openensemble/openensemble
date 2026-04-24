/**
 * Anthropic Messages API streaming with tool calling + prompt caching.
 *
 * Caches the system prompt, the last tool block, and the tail of the last
 * message on every request. Turn N+1 then reuses most of the turn-N prefix
 * within the 5-min TTL, cutting input tokens 20–40% on multi-turn chats.
 */

import { executeToolStreaming } from '../../roles.mjs';
import { ANTHROPIC_URL, readAnthropicSSE, getAnthropicKey } from './_shared.mjs';
import { LoopGuard, compressToolDefs } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';

// Convert Ollama/OpenAI tool format → Anthropic format (with description compression)
export function toAnthropicTools(tools) {
  const compressed = compressToolDefs(tools);
  return compressed.map((t, i) => ({
    name:         t.function.name,
    description:  t.function.description,
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    // Mark the last tool so Anthropic caches the full tool block
    ...(i === compressed.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
}

/**
 * Add a cache breakpoint to the last content block of the last message.
 * Anthropic caches the prefix up to each cache_control marker. Marking the
 * tail of the most recent message on every request means turn N+1 can reuse
 * the whole turn-N prefix (within the 5-min TTL) and only pays for the new
 * tokens. Expect 20-40% input-token savings on multi-turn conversations.
 *
 * Uses 1 of Anthropic's 4 cache-control slots. Tools + system already use 2.
 */
export function markTailCacheBreakpoint(messages) {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  const blocks = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]
    : last.content.map(b => ({ ...b }));
  if (!blocks.length) return messages;
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

export async function* streamAnthropic(agent, systemPrompt, messages, signal, userId = 'default') {
  const apiKey = getAnthropicKey();
  if (!apiKey) {
    yield { type: 'error', message: 'Anthropic API key not set. Add it to ~/.openensemble/config.json' };
    return;
  }

  // Anthropic wants system as top-level field, messages must be user/assistant only
  const working = messages.filter(m => m.role !== 'system');
  const anthropicTools = agent.tools?.length ? toAnthropicTools(agent.tools) : undefined;

  let assistantContent = '';
  let totalInputTokens = 0, totalOutputTokens = 0;
  const guard = new LoopGuard(agent.maxToolLoops ?? 500);

  while (guard.tick()) {
    const body = {
      model:      agent.model,
      max_tokens: agent.maxTokens ?? 8192,
      system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages:   markTailCacheBreakpoint(working),
      stream:     true,
    };
    if (anthropicTools) body.tools = anthropicTools;

    const res = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      signal,
      headers: {
        'x-api-key':              apiKey,
        'anthropic-version':      '2023-06-01',
        'anthropic-beta':         'prompt-caching-2024-07-31',
        'content-type':           'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      yield { type: 'error', message: `Anthropic error ${res.status}: ${err}` };
      return;
    }

    // Collect streaming events
    let textContent  = '';
    const toolUseBlocks = new Map(); // index -> { id, name, inputJson }
    let stopReason   = null;

    let cacheCreated = 0, cacheRead = 0;
    for await (const event of readAnthropicSSE(res.body)) {
      if (event.type === 'message_start' && event.message?.usage) {
        const u = event.message.usage;
        totalInputTokens += u.input_tokens ?? 0;
        cacheCreated += u.cache_creation_input_tokens ?? 0;
        cacheRead    += u.cache_read_input_tokens     ?? 0;
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        toolUseBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, inputJson: '' });
      }
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') {
          const text = event.delta.text;
          textContent += text;
          yield { type: 'token', text };
        }
        if (event.delta?.type === 'input_json_delta') {
          const block = toolUseBlocks.get(event.index);
          if (block) block.inputJson += event.delta.partial_json;
        }
      }
      if (event.type === 'message_delta') {
        stopReason = event.delta?.stop_reason;
        if (event.usage) totalOutputTokens += event.usage.output_tokens ?? 0;
      }
      if (event.type === 'message_stop') break;
    }

    if (cacheCreated || cacheRead) {
      console.log(`[anthropic] cache: created=${cacheCreated} read=${cacheRead} input=${totalInputTokens}`);
    }

    // ── Tool use ──────────────────────────────────────────────────────────────
    if (stopReason === 'tool_use' && toolUseBlocks.size > 0) {
      const blocks = [...toolUseBlocks.values()];

      if (blocks.length > 1) {
        // Multiple tool calls in one assistant turn — run in parallel.
        // The LLM emitted them together, which signals they're independent.
        // All tools run via executeToolStreaming (blocking per-tool, full
        // result returned). Promise.all gives us concurrency across tools.
        // For ask_agent this means the coordinator waits for specialist responses
        // before synthesizing — no background dispatch.
        // Intermediate events (permission_request, nested tool_call/result)
        // are buffered per-tool and replayed in tool order after all complete.
        const parsed = blocks.map(block => {
          let toolArgs = {};
          try { toolArgs = JSON.parse(block.inputJson || '{}'); } catch (e) { console.warn('[chat] Failed to parse tool args:', e.message); }
          return { block, toolArgs };
        });
        for (const { block, toolArgs } of parsed) {
          yield { type: 'tool_call', name: block.name, args: toolArgs };
        }
        const results = await Promise.all(parsed.map(async ({ block, toolArgs }) => {
          const { text, _notify, events } = await drainToolWithEvents(block.name, toolArgs, userId, agent.id);
          return { block, toolArgs, result: text, _notify, events };
        }));
        for (const { block, result, _notify, events } of results) {
          for (const ev of events) yield ev;
          yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
          if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        }
        working.push({ role: 'assistant', content: results.map(r => ({ type: 'tool_use', id: r.block.id, name: r.block.name, input: r.toolArgs })) });
        working.push({ role: 'user',      content: results.map(r => ({ type: 'tool_result', tool_use_id: r.block.id, content: r.result })) });
        const sc1 = guard.check(results.map(r => ({ name: r.block.name, args: r.block.inputJson })), results.map(r => r.result));
        if (sc1.stalled) { console.warn(`[anthropic] stall: ${sc1.reason}`); assistantContent = `Stopped: ${sc1.reason}.`; yield { type: 'token', text: assistantContent }; break; }
        continue;
      }

      // Sequential execution — single block or mixed tool types
      const seqResults = [];
      for (const block of blocks) {
        let toolArgs = {};
        try { toolArgs = JSON.parse(block.inputJson || '{}'); } catch (e) { console.warn('[chat] Failed to parse Anthropic tool args:', e.message); }

        yield { type: 'tool_call', name: block.name, args: toolArgs };
        let toolResult = '';
        try {
          for await (const chunk of executeToolStreaming(block.name, toolArgs, userId, agent.id)) {
            if (chunk.type === 'token')              toolResult += chunk.text;
            if (chunk.type === 'permission_request') yield chunk;
            if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args };
            if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) };
            if (chunk.type === 'result')             toolResult = chunk.text;
          }
        } catch (e) {
          console.error('[tool error]', block.name, e.stack || e.message);
          toolResult = `Tool error: ${e.message}`;
        }
        const { text: result, _notify } = normalizeToolResult(toolResult);
        yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
        if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        seqResults.push({ block, toolArgs, result });
      }
      // Anthropic requires all tool_use blocks in one assistant message
      // and all tool_result blocks in one user message
      working.push({ role: 'assistant', content: seqResults.map(r => ({ type: 'tool_use', id: r.block.id, name: r.block.name, input: r.toolArgs })) });
      working.push({ role: 'user',      content: seqResults.map(r => ({ type: 'tool_result', tool_use_id: r.block.id, content: r.result })) });
      const sc2 = guard.check(seqResults.map(r => ({ name: r.block.name, args: r.block.inputJson })), seqResults.map(r => r.result));
      if (sc2.stalled) { console.warn(`[anthropic] stall: ${sc2.reason}`); assistantContent = `Stopped: ${sc2.reason}.`; yield { type: 'token', text: assistantContent }; break; }
      continue;
    }

    assistantContent = textContent;
    break;
  }

  yield { type: '__content', content: assistantContent };
  if (totalInputTokens || totalOutputTokens) {
    yield { type: '__usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, provider: 'anthropic', model: agent.model };
  }
}
