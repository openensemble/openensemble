/**
 * Anthropic Messages API streaming with tool calling + prompt caching.
 *
 * Caches the system prompt, the last tool block, and the tail of the last
 * message on every request. Turn N+1 then reuses most of the turn-N prefix
 * within the 5-min TTL, cutting input tokens 20–40% on multi-turn chats.
 */

import { executeToolStreaming } from '../../roles.mjs';
import { ANTHROPIC_URL, readAnthropicSSE, getAnthropicKey, fetchWithRetry } from './_shared.mjs';
import { LoopGuard, compressToolDefs } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';
import { buildImageUserMessage } from './_shared.mjs';
import { applyRedactions } from '../../lib/credentials.mjs';
import { resolveNativeWebSearch } from '../../lib/model-capabilities.mjs';
import { applyAnthropicReasoning, isReasoningUnsupportedError } from '../../lib/reasoning-effort.mjs';

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

  let assistantContent = '';
  let totalInputTokens = 0, totalOutputTokens = 0;
  // Turn-wide cache accumulators (the per-iteration cacheCreated/cacheRead below
  // reset each tool round-trip; these survive the loop so __usage reports the
  // whole turn's cache behavior, mirroring totalInput/OutputTokens).
  let totalCacheRead = 0, totalCacheCreated = 0;
  const guard = new LoopGuard(agent.maxToolLoops ?? 500);
  // Set if Anthropic rejects the hosted web_search server tool, so we resend the
  // same turn with the Brave function restored (search still works, via Brave).
  let nativeSearchDisabled = false;
  let reasoningDisabled = false;

  while (guard.tick()) {
    // Re-read tools per iteration so dynamic toolset mutations (request_tools
    // meta-tool expanding the coordinator's surface mid-turn) take effect on
    // the next provider call. The system message keeps its ephemeral
    // cache_control breakpoint, so the bulk of the input still cache-hits;
    // only the tools portion takes a partial miss when expanded.
    // Native web search: when the model can search+synthesize server-side AND
    // the agent already holds our Brave web_search, drop the Brave function and
    // append Anthropic's hosted server tool (one round-trip instead of
    // search→result→synthesize). toAnthropicTools runs on the filtered list so
    // its cache_control marker lands on the last *function* tool; the server
    // tool is appended after (a few uncached tokens, negligible).
    const { useNative, functionTools, nativeTool } =
      resolveNativeWebSearch('anthropic', agent.model, agent.tools || [], { disabled: nativeSearchDisabled });
    let anthropicTools = functionTools?.length ? toAnthropicTools(functionTools) : undefined;
    if (useNative && nativeTool) {
      anthropicTools = [...(anthropicTools || []), nativeTool];
      console.log(`[anthropic] native web search: server tool injected (${nativeTool.type})`);
    }
    // Three-tier system message for cache locality. When chat.mjs has built
    // the tier breakdown (stable / context / volatile), emit them as separate
    // blocks with cache_control markers on stable + context. The cache hit
    // on the stable tier survives even when the tool-router recomposes the
    // context tier or per-turn additions land in volatile. Falls back to a
    // single-block marker when the agent record predates the tier split.
    //
    // Uses up to 4 Anthropic cache slots: tools (1) + system stable (1) +
    // system context (1) + message tail (1) — exactly at the limit. If a
    // future change needs another slot, drop the context marker first
    // (volatile changes per turn anyway, so caching stable alone retains
    // most of the win).
    const tiers = agent._promptTiersAssembled;
    const systemBlocks = tiers
      ? [
          { type: 'text', text: tiers.stable, cache_control: { type: 'ephemeral' } },
          tiers.context ? { type: 'text', text: tiers.context, cache_control: { type: 'ephemeral' } } : null,
          tiers.volatile ? { type: 'text', text: tiers.volatile } : null,
        ].filter(Boolean)
      : [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
    const body = {
      model:      agent.model,
      max_tokens: agent.maxTokens ?? 8192,
      system:     systemBlocks,
      messages:   markTailCacheBreakpoint(working),
      stream:     true,
    };
    if (anthropicTools) body.tools = anthropicTools;
    if (!reasoningDisabled) applyAnthropicReasoning(body, agent);

    // Retried on 429/529/5xx + network failures (honoring Retry-After) — a
    // single overloaded_error used to throw straight out of the generator
    // while every other provider path had some retry story.
    const res = await fetchWithRetry(ANTHROPIC_URL, {
      method:  'POST',
      signal,
      headers: {
        'x-api-key':              apiKey,
        'anthropic-version':      '2023-06-01',
        'anthropic-beta':         'prompt-caching-2024-07-31',
        'content-type':           'application/json',
      },
      body: JSON.stringify(body),
    }, { label: 'anthropic' });

    if (!res.ok) {
      const err = await res.text();
      // Hosted web_search server tool rejected → resend this turn with the Brave
      // function restored. Bounded: nativeSearchDisabled stays set, so a second
      // failure falls through to the generic error below (no retry loop).
      if ((res.status === 400 || res.status === 422) && useNative && nativeTool && /web[_ ]?search|unsupported tool|tool type|unknown variant/i.test(err)) {
        console.warn(`[anthropic] hosted web_search rejected (${res.status}); falling back to Brave web_search`);
        nativeSearchDisabled = true;
        continue;
      }
      if (!reasoningDisabled && isReasoningUnsupportedError(res.status, err)) {
        console.warn('[anthropic] reasoning effort rejected; retrying without effort field');
        reasoningDisabled = true;
        continue;
      }
      yield { type: 'error', message: `Anthropic error ${res.status}: ${err}` };
      return;
    }

    // Collect streaming events
    let textContent  = '';
    const toolUseBlocks = new Map(); // index -> { id, name, inputJson }
    let stopReason   = null;

    let cacheCreated = 0, cacheRead = 0;
    for await (const event of readAnthropicSSE(res.body)) {
      // Mid-stream error (e.g. overloaded_error) arrives as its own SSE event
      // with no message_stop. Surface it — otherwise the loop just ends and the
      // turn completes with partial/empty text that reads as success downstream.
      if (event.type === 'error') {
        const em = event.error?.message || event.error?.type || 'stream error';
        yield { type: 'error', message: `Anthropic error: ${em}` };
        return;
      }
      if (event.type === 'message_start' && event.message?.usage) {
        const u = event.message.usage;
        totalInputTokens += u.input_tokens ?? 0;
        cacheCreated += u.cache_creation_input_tokens ?? 0;
        cacheRead    += u.cache_read_input_tokens     ?? 0;
        totalCacheCreated += u.cache_creation_input_tokens ?? 0;
        totalCacheRead    += u.cache_read_input_tokens     ?? 0;
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        toolUseBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, inputJson: '' });
      }
      // Hosted server tools (web_search) execute server-side and fold their
      // results into the text deltas — never registered as a client tool_use, so
      // the loop below won't try to run them. Surface a transient indicator for
      // parity with the Codex path; not a token, so voice devices won't speak it.
      if (event.type === 'content_block_start' && event.content_block?.type === 'server_tool_use'
          && event.content_block?.name === 'web_search') {
        yield { type: 'tool_progress', name: 'web_search', text: 'Searching the web…' };
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

    {
      // Always log so we can spot misses too (created>0+read=0 = first turn or
      // cache TTL expired). hitRate is over cached tokens only (created+read);
      // raw input_tokens is the uncached portion (volatile tier + new
      // messages). tierMode tags whether the agent supplied the 3-block split.
      const totalCacheable = cacheCreated + cacheRead;
      const hitRate = totalCacheable ? (cacheRead / totalCacheable) : 0;
      const tierMode = agent._promptTiersAssembled ? 'tiered' : 'flat';
      console.log(`[anthropic] cache: mode=${tierMode} created=${cacheCreated} read=${cacheRead} uncached=${totalInputTokens} hit=${(hitRate*100).toFixed(0)}%`);
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
          const { text, _notify, _images, events } = await drainToolWithEvents(block.name, toolArgs, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean));
          return { block, toolArgs, result: text, _notify, _images, events };
        }));
        for (const { block, result, _notify, events } of results) {
          for (const ev of events) yield ev;
          yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
          if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        }
        working.push({ role: 'assistant', content: results.map(r => ({ type: 'tool_use', id: r.block.id, name: r.block.name, input: r.toolArgs })) });
        working.push({ role: 'user',      content: results.map(r => ({ type: 'tool_result', tool_use_id: r.block.id, content: applyRedactions(r.result) })) });
        // After the tool_result message, append any vision attachments
        // (browser_screenshot etc.) as a synthesized user message so the
        // model sees the pixels on its next turn. Each call's images
        // bundle into one message with the tool name as caption so the
        // model can correlate.
        for (const { block, _images } of results) {
          if (_images?.length) {
            working.push(buildImageUserMessage('anthropic', _images, `[attached: image(s) returned by ${block.name}]`));
          }
        }
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
          let _seqImages = null;
          for await (const chunk of executeToolStreaming(block.name, toolArgs, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean))) {
            if (chunk.type === 'token')              toolResult += chunk.text;
            if (chunk.type === 'permission_request') yield chunk;
            if (chunk.type === '__hide_turn')         yield { type: '__hide_turn', reason: chunk.reason, taskId: chunk.taskId };
            if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args };
            if (chunk.type === 'tool_progress')      yield { type: 'tool_progress', name: chunk.name, text: chunk.text };
            if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) };
            if (chunk.type === 'image' || chunk.type === 'video' || chunk.type === 'audio') yield chunk;
            if (chunk.type === 'result') {
              toolResult = chunk.text;
              if (Array.isArray(chunk._images)) _seqImages = chunk._images;
            }
          }
          // Carry images out to the post-tool message-pump below.
          block._images = _seqImages;
        } catch (e) {
          console.error('[tool error]', block.name, e.stack || e.message);
          toolResult = `Tool error: ${e.message}`;
        }
        const { text: result, _notify, _images } = normalizeToolResult(toolResult);
        yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
        if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        seqResults.push({ block, toolArgs, result, _images: block._images ?? _images });
      }
      // Anthropic requires all tool_use blocks in one assistant message
      // and all tool_result blocks in one user message
      working.push({ role: 'assistant', content: seqResults.map(r => ({ type: 'tool_use', id: r.block.id, name: r.block.name, input: r.toolArgs })) });
      working.push({ role: 'user',      content: seqResults.map(r => ({ type: 'tool_result', tool_use_id: r.block.id, content: applyRedactions(r.result) })) });
      // Vision attachments — same pattern as the parallel path above.
      for (const { block, _images } of seqResults) {
        if (_images?.length) {
          working.push(buildImageUserMessage('anthropic', _images, `[attached: image(s) returned by ${block.name}]`));
        }
      }
      const sc2 = guard.check(seqResults.map(r => ({ name: r.block.name, args: r.block.inputJson })), seqResults.map(r => r.result));
      if (sc2.stalled) { console.warn(`[anthropic] stall: ${sc2.reason}`); assistantContent = `Stopped: ${sc2.reason}.`; yield { type: 'token', text: assistantContent }; break; }
      continue;
    }

    assistantContent = textContent;
    break;
  }

  yield { type: '__content', content: assistantContent };
  if (totalInputTokens || totalOutputTokens) {
    yield { type: '__usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cachedTokens: totalCacheRead, cacheCreatedTokens: totalCacheCreated, provider: 'anthropic', model: agent.model };
  }
}
