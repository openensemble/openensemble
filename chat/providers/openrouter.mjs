/**
 * OpenRouter — OpenAI-compat SSE with tool calling.
 */

import { executeToolStreaming } from '../../roles.mjs';
import {
  OPENROUTER_URL, readAnthropicSSE, getOpenRouterKey, fetchWithRetry,
  stripThinking, stripReasoningPreamble, getStripThinkingTags, buildImageUserMessage,
} from './_shared.mjs';
import { LoopGuard, compressToolDefs } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';
import { applyRedactions } from '../../lib/credentials.mjs';
import { resolveNativeWebSearch } from '../../lib/model-capabilities.mjs';
import { applyOpenAICompatReasoning, isReasoningUnsupportedError } from '../../lib/reasoning-effort.mjs';

/**
 * Anthropic-model prompt caching via OpenRouter: OpenRouter forwards
 * `cache_control` markers inside message content parts straight to Anthropic.
 * Mark the system prompt (stable prefix) and the tail of the newest markable
 * message so turn N+1 reuses the turn-N prefix — the same 20–40% input-token
 * saving the direct Anthropic path already gets (see anthropic.mjs). Uses 2 of
 * Anthropic's 4 breakpoint slots. Non-Anthropic models never see this shape.
 */
export function withAnthropicCacheBreakpoints(messages) {
  if (!messages.length) return messages;
  const out = messages.map(m => ({ ...m }));
  if (out[0]?.role === 'system' && typeof out[0].content === 'string' && out[0].content) {
    out[0].content = [{ type: 'text', text: out[0].content, cache_control: { type: 'ephemeral' } }];
  }
  // Walk back to the newest user/assistant message whose content can carry a
  // marker (tool messages and content:null tool_call stubs are skipped — a
  // marker on an earlier message still caches everything before it).
  for (let i = out.length - 1; i > 0; i--) {
    const m = out[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content === 'string' && m.content) {
      out[i] = { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
      break;
    }
    if (Array.isArray(m.content) && m.content.length) {
      const blocks = m.content.map(b => ({ ...b }));
      for (let j = blocks.length - 1; j >= 0; j--) {
        if (blocks[j].type === 'text') { blocks[j] = { ...blocks[j], cache_control: { type: 'ephemeral' } }; break; }
      }
      out[i] = { ...m, content: blocks };
      break;
    }
  }
  return out;
}

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

  let assistantContent = '';
  let totalInputTokens = 0, totalOutputTokens = 0, cachedTokens = 0;
  const isAnthropicModel = /^anthropic\//i.test(String(agent.model || ''));
  const guard = new LoopGuard(agent.maxToolLoops ?? 500);
  // Set if OpenRouter rejects the native web_search server tool, so we resend
  // the same turn with the Brave function restored.
  let nativeSearchDisabled = false;
  let reasoningDisabled = false;

  while (guard.tick()) {
    // Re-read tools per iteration so dynamic toolset mutations
    // (request_tools meta-tool) take effect on the next provider call.
    // Native web search: when the agent already holds Brave web_search, drop it
    // and append OpenRouter's server tool so the search runs server-side in one
    // round-trip instead of search→result→synthesize.
    const { useNative, functionTools, nativeTool } =
      resolveNativeWebSearch('openrouter', agent.model, agent.tools || [], { disabled: nativeSearchDisabled });
    const orFnTools = functionTools?.length
      ? compressToolDefs(functionTools).map(t => ({ type: 'function', function: t.function }))
      : undefined;
    let orTools = orFnTools;
    if (useNative && nativeTool) {
      orTools = [...(orFnTools || []), nativeTool];
      console.log(`[openrouter] native web search: server tool injected (${nativeTool.type})`);
    }
    const body = {
      model:    agent.model,
      messages: isAnthropicModel ? withAnthropicCacheBreakpoints(working) : working,
      stream:   true,
      // Final SSE chunk then carries {prompt_tokens, completion_tokens,
      // prompt_tokens_details.cached_tokens} — without it OpenRouter sends no
      // usage at all and cost/cache metrics read 0.
      usage:    { include: true },
    };
    if (agent.maxTokens) body.max_tokens = agent.maxTokens;
    if (orTools) body.tools = orTools;
    if (!reasoningDisabled) applyOpenAICompatReasoning(body, 'openrouter', agent);

    const res = await fetchWithRetry(OPENROUTER_URL, {
      method: 'POST', signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'https://openensemble.app',
        'X-Title':       'OpenEnsemble',
      },
      body: JSON.stringify(body),
    }, { label: 'openrouter' });

    if (!res.ok) {
      const errText = await res.text();
      // Native web_search tool rejected → resend with Brave restored. Bounded:
      // the flag stays set, so a second failure hits the generic error below.
      if ((res.status === 400 || res.status === 422) && useNative && nativeTool && /web[_ ]?search|unsupported tool|tool type|unknown variant/i.test(errText)) {
        console.warn(`[openrouter] native web_search rejected (${res.status}); falling back to Brave web_search`);
        nativeSearchDisabled = true;
        continue;
      }
      if (!reasoningDisabled && isReasoningUnsupportedError(res.status, errText)) {
        console.warn('[openrouter] reasoning effort rejected; retrying without reasoning field');
        reasoningDisabled = true;
        continue;
      }
      yield { type: 'error', message: `OpenRouter error ${res.status}: ${errText}` };
      return;
    }

    let textContent  = '';
    const toolCalls  = new Map(); // index -> { id, name, argsJson }
    let finishReason = null;
    let tokenCount   = 0;
    const startedAt  = Date.now();
    let firstTokenAt = null;
    let iterUsage    = null;

    for await (const event of readAnthropicSSE(res.body)) {
      // Keep the LAST usage seen this completion; accumulated after the loop
      // (guards against providers that repeat cumulative usage per chunk).
      if (event.usage) iterUsage = event.usage;
      // Mid-stream error chunk (no `choices`) — surface it instead of silently
      // skipping via the `!choice` continue below, which would end the turn with
      // partial/empty text that reads as success downstream.
      if (event.error) {
        const em = event.error.message || event.error.type || 'stream error';
        yield { type: 'error', message: `OpenRouter error: ${em}` };
        return;
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
        // Key by index when present (spec), else by id — compat servers that
        // omit index on parallel calls used to collapse them all into idx 0.
        const idx = tc.index ?? tc.id ?? 0;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: tc.id ?? `tc${idx}`, name: '', argsJson: '' });
        const entry = toolCalls.get(idx);
        // ||= not +=: some servers resend the FULL name on every delta, which
        // += turned into "web_searchweb_search".
        if (tc.function?.name)      entry.name   ||= tc.function.name;
        if (tc.function?.arguments) entry.argsJson += tc.function.arguments;
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
      // No break on finish_reason: the usage chunk arrives AFTER the final
      // choice chunk — breaking here discarded it. The reader ends at [DONE].
    }
    if (iterUsage) {
      totalInputTokens  += iterUsage.prompt_tokens     ?? 0;
      totalOutputTokens += iterUsage.completion_tokens ?? 0;
      cachedTokens      += iterUsage.prompt_tokens_details?.cached_tokens ?? 0;
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
          const { text, _notify, _images, events } = await drainToolWithEvents(block.name, toolArgs, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean));
          return { block, toolArgs, result: text, _notify, _images, events };
        }));
        const assistantToolCalls = results.map(({ block }) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.argsJson } }));
        working.push({ role: 'assistant', content: textContent.trim() ? textContent : null, tool_calls: assistantToolCalls }); // keep the pre-tool preamble in history — dropping it left the model re-deriving its own reasoning next round
        for (const { block, result, _notify, events } of results) {
          for (const ev of events) yield ev;
          yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
          if (_notify) yield { type: '__notify', name: block.name, ..._notify };
          working.push({ role: 'tool', tool_call_id: block.id, content: applyRedactions(result) });
        }
        for (const { block, _images } of results) {
          if (_images?.length) {
            working.push(buildImageUserMessage('openrouter', _images, `[attached: image(s) returned by ${block.name}]`));
          }
        }
        { const sc = guard.check(results.map(r => ({ name: r.block.name, args: r.block.argsJson })), results.map(r => r.result));
          if (sc.stalled) { console.warn(`[openrouter] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
        continue;
      }

      // Sequential execution for single or mixed tool calls
      const assistantToolCalls = blocks.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.argsJson } }));
      working.push({ role: 'assistant', content: textContent.trim() ? textContent : null, tool_calls: assistantToolCalls }); // keep the pre-tool preamble in history — dropping it left the model re-deriving its own reasoning next round
      const orSeqResults = [];
      const _imagesByBlockId = new Map();
      for (const block of blocks) {
        let args = {};
        try { args = JSON.parse(block.argsJson || '{}'); } catch (e) { console.warn('[chat] Failed to parse OpenRouter tool args:', e.message); }
        yield { type: 'tool_call', name: block.name, args };
        let orToolResult = '';
        let _seqImages = null;
        for await (const chunk of executeToolStreaming(block.name, args, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean))) {
          if (chunk.type === 'token')              orToolResult += chunk.text;
          if (chunk.type === 'permission_request') yield chunk;
          if (chunk.type === '__hide_turn')         yield { type: '__hide_turn', reason: chunk.reason, taskId: chunk.taskId };
          if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args };
          if (chunk.type === 'tool_progress')      yield { type: 'tool_progress', name: chunk.name, text: chunk.text };
          if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) };
          if (chunk.type === 'image' || chunk.type === 'video' || chunk.type === 'audio') yield chunk;
          if (chunk.type === 'result') {
            orToolResult = chunk.text;
            if (Array.isArray(chunk._images)) _seqImages = chunk._images;
          }
        }
        const { text: result, _notify, _images } = normalizeToolResult(orToolResult);
        const effectiveImages = _seqImages ?? _images;
        if (effectiveImages?.length) _imagesByBlockId.set(block.id, { name: block.name, images: effectiveImages });
        yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
        if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        working.push({ role: 'tool', tool_call_id: block.id, content: applyRedactions(result) });
        orSeqResults.push({ name: block.name, args: block.argsJson, result });
      }
      for (const [, payload] of _imagesByBlockId) {
        working.push(buildImageUserMessage('openrouter', payload.images, `[attached: image(s) returned by ${payload.name}]`));
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
    yield { type: '__usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cachedTokens, provider: 'openrouter', model: agent.model };
  }
  if (totalInputTokens && isAnthropicModel) {
    const hitRate = totalInputTokens ? (cachedTokens / totalInputTokens) : 0;
    console.log(`[openrouter] cache: cached=${cachedTokens} input=${totalInputTokens} hit=${(hitRate*100).toFixed(0)}%`);
  }
}
