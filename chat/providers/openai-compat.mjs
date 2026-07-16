/**
 * Generic OpenAI-compat streaming.
 *
 * Used by: OpenAI, DeepSeek, Mistral, Groq, Together, Perplexity,
 * Gemini-compat, xAI Grok (chat models). Each is dispatched by providerKey
 * into OPENAI_COMPAT_PROVIDERS to resolve baseUrl + key.
 */

import { executeToolStreaming } from '../../roles.mjs';
import {
  OPENAI_COMPAT_PROVIDERS, readAnthropicSSE, getCompatKey, fetchWithRetry,
  stripThinking, stripReasoningPreamble, getStripThinkingTags, buildImageUserMessage,
  modelCallTraceEvent,
} from './_shared.mjs';
import { LoopGuard, compressToolDefs } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';
import { applyRedactions } from '../../lib/credentials.mjs';
import { resolveNativeWebSearch } from '../../lib/model-capabilities.mjs';
import { applyOpenAICompatReasoning, isReasoningUnsupportedError } from '../../lib/reasoning-effort.mjs';
import { capabilityNotice } from './_shared.mjs';

export async function* streamOpenAICompat(providerKey, agent, systemPrompt, messages, signal, userId = 'default') {
  const cfg = OPENAI_COMPAT_PROVIDERS[providerKey];
  if (!cfg) { yield { type: 'error', message: `Unknown provider: ${providerKey}` }; return; }
  const apiKey = getCompatKey(providerKey);
  if (!apiKey) {
    yield { type: 'error', message: `${cfg.displayName} API key not set. Add it in Settings → Providers.` };
    return;
  }
  const endpoint = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const working = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  let assistantContent = '';
  // cachedTokens must live at function scope like the other totals — the final
  // __usage yield below the loop reads it (declared inside the loop it was a
  // latent ReferenceError, masked while usage always read 0).
  let totalInputTokens = 0, totalOutputTokens = 0, cachedTokens = 0;
  const guard = new LoopGuard(agent.maxToolLoops ?? 500);
  // Set if the provider rejects an injected native web_search tool, so we resend
  // the same turn with the Brave function restored. (Only the grok/xai path
  // injects a tool; the perplexity model-implicit path has nothing to fall back
  // from, so this stays false there.)
  let nativeSearchDisabled = false;
  let reasoningDisabled = false;
  // o-series / gpt-5 on /chat/completions reject max_tokens with "use
  // max_completion_tokens" — latch and resend with the renamed field.
  let useMaxCompletionTokens = false;
  // Strict-validation providers (e.g. Mistral) may reject stream_options —
  // latch and resend without it (usage then reads 0 for that provider only).
  let streamUsageDisabled = false;

  while (guard.tick()) {
    // Re-read tools per iteration so dynamic toolset mutations (request_tools
    // meta-tool expanding the coordinator's surface mid-turn) take effect on
    // the next provider call.
    // Native web search: grok/xai injects a server `web_search` tool; perplexity
    // Sonar searches by construction so we just drop our Brave web_search (the
    // model does it implicitly). Either way: one round-trip, not search→synth.
    // Gated to agents that already hold Brave web_search — never a new grant.
    const { useNative, functionTools, nativeTool } =
      resolveNativeWebSearch(providerKey, agent.model, agent.tools || [], { disabled: nativeSearchDisabled });
    const compatFnTools = functionTools?.length
      ? compressToolDefs(functionTools).map(t => ({ type: 'function', function: t.function }))
      : undefined;
    let compatTools = compatFnTools;
    if (useNative && nativeTool) compatTools = [...(compatFnTools || []), nativeTool];
    if (useNative) {
      console.log(`[${providerKey}] native web search: ${nativeTool ? `server tool injected (${nativeTool.type})` : 'model-implicit (web_search dropped)'}`);
    }
    const body = {
      model:    agent.model,
      messages: working,
      stream:   true,
    };
    if (agent.maxTokens) {
      if (useMaxCompletionTokens) body.max_completion_tokens = agent.maxTokens;
      else                        body.max_tokens            = agent.maxTokens;
    }
    // Without this OpenAI(-compat) sends no usage chunk at all and every
    // cost/cache metric reads 0.
    if (!streamUsageDisabled) body.stream_options = { include_usage: true };
    if (compatTools)     body.tools      = compatTools;
    if (!reasoningDisabled) applyOpenAICompatReasoning(body, providerKey, agent);

    yield modelCallTraceEvent({
      provider: providerKey, model: agent.model, tools: body.tools, round: guard.count,
    });

    const res = await fetchWithRetry(endpoint, {
      method: 'POST', signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }, { label: providerKey });

    if (!res.ok) {
      const errText = await res.text();
      // Injected native web_search tool rejected → resend with Brave restored.
      // Bounded: the flag stays set, so a second failure hits the generic error.
      if ((res.status === 400 || res.status === 422) && useNative && nativeTool && /web[_ ]?search|unsupported tool|tool type|unknown variant/i.test(errText)) {
        console.warn(`[${providerKey}] native web_search rejected (${res.status}); falling back to Brave web_search`);
        nativeSearchDisabled = true;
        const notice = capabilityNotice(providerKey, 'native_search', 'Provider rejected native web search — continuing with the standard search tool.');
        if (notice) yield notice;
        continue;
      }
      // These two must run BEFORE the reasoning check: their rejection text
      // ("Unsupported parameter: …") also matches isReasoningUnsupportedError,
      // which would burn the reasoning retry on the wrong field and then fail.
      if (!useMaxCompletionTokens && body.max_tokens !== undefined && res.status === 400 && /max_completion_tokens/i.test(errText)) {
        console.warn(`[${providerKey}] max_tokens rejected for ${agent.model}; retrying with max_completion_tokens`);
        useMaxCompletionTokens = true;
        const notice = capabilityNotice(providerKey, 'max_completion_tokens', 'Provider rejected the max_tokens parameter — retrying with its expected name.');
        if (notice) yield notice;
        continue;
      }
      if (!streamUsageDisabled && (res.status === 400 || res.status === 422) && /stream_options/i.test(errText)) {
        console.warn(`[${providerKey}] stream_options rejected; retrying without usage reporting`);
        streamUsageDisabled = true;
        const notice = capabilityNotice(providerKey, 'stream_options', 'Provider rejected usage reporting — continuing without token-usage stats for this provider.');
        if (notice) yield notice;
        continue;
      }
      if (!reasoningDisabled && isReasoningUnsupportedError(res.status, errText)) {
        console.warn(`[${providerKey}] reasoning effort rejected; retrying without reasoning field`);
        reasoningDisabled = true;
        const notice = capabilityNotice(providerKey, 'reasoning_effort', 'Provider rejected the configured reasoning effort — continuing without it.');
        if (notice) yield notice;
        continue;
      }
      yield { type: 'error', message: `${cfg.displayName} error ${res.status}: ${errText}` };
      return;
    }

    let textContent  = '';
    const toolCalls  = new Map();
    let finishReason = null;
    let sawDone = false; // saw the [DONE] terminator → stream ended cleanly even without a finish_reason
    let tokenCount   = 0;
    const startedAt  = Date.now();
    let firstTokenAt = null;
    let iterUsage    = null;

    for await (const event of readAnthropicSSE(res.body)) {
      if (event.__sseDone) { sawDone = true; continue; }
      // Keep the LAST usage seen this completion, accumulate after the loop.
      // Most providers send usage once on the final chunk; Perplexity sends a
      // CUMULATIVE usage on every chunk, so `+=` per event would overcount.
      if (event.usage) iterUsage = event.usage;
      // Mid-stream error chunk (no `choices`) — surface it instead of silently
      // skipping via the `!choice` continue below, which would end the turn with
      // partial/empty text that reads as success downstream.
      if (event.error) {
        const em = event.error.message || event.error.type || 'stream error';
        yield { type: 'error', message: `${providerKey} error: ${em}` };
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
      // No break on finish_reason: with stream_options.include_usage the usage
      // chunk arrives AFTER the final choice chunk — breaking here discarded it
      // (usage always read 0). The reader ends at [DONE]/EOF.
    }
    if (iterUsage) {
      totalInputTokens  += iterUsage.prompt_tokens     ?? 0;
      totalOutputTokens += iterUsage.completion_tokens ?? 0;
      // OpenAI-shape providers expose prefix-cache hits via the optional
      // `prompt_tokens_details.cached_tokens` field on the usage chunk.
      // Capture so we can log a hit rate parallel to Anthropic's explicit
      // cache_control telemetry. Not all providers populate this; missing = 0.
      cachedTokens += iterUsage.prompt_tokens_details?.cached_tokens ?? 0;
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
            working.push(buildImageUserMessage(providerKey, _images, `[attached: image(s) returned by ${block.name}]`));
          }
        }
        { const sc = guard.check(results.map(r => ({ name: r.block.name, args: r.block.argsJson })), results.map(r => r.result));
          if (sc.stalled) { console.warn(`[${providerKey}] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
        continue;
      }

      const assistantToolCalls = blocks.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.argsJson } }));
      working.push({ role: 'assistant', content: textContent.trim() ? textContent : null, tool_calls: assistantToolCalls }); // keep the pre-tool preamble in history — dropping it left the model re-deriving its own reasoning next round
      const compatSeqResults = [];
      const _imagesByBlockId = new Map();
      for (const block of blocks) {
        let args = {};
        try { args = JSON.parse(block.argsJson || '{}'); } catch (e) { console.warn(`[${providerKey}] Failed to parse tool args:`, e.message); }
        yield { type: 'tool_call', name: block.name, args };
        let compatToolResult = '';
        let _seqImages = null;
        for await (const chunk of executeToolStreaming(block.name, args, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean))) {
          if (chunk.type === 'token')              compatToolResult += chunk.text;
          if (chunk.type === 'permission_request') yield chunk;
          if (chunk.type === '__hide_turn')         yield { type: '__hide_turn', reason: chunk.reason, taskId: chunk.taskId };
          if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args };
          if (chunk.type === 'tool_progress')      yield { type: 'tool_progress', name: chunk.name, text: chunk.text };
          if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) };
          if (chunk.type === 'image' || chunk.type === 'video' || chunk.type === 'audio') yield chunk;
          if (chunk.type === 'result') {
            compatToolResult = chunk.text;
            if (Array.isArray(chunk._images)) _seqImages = chunk._images;
          }
        }
        const { text: result, _notify, _images } = normalizeToolResult(compatToolResult);
        const effectiveImages = _seqImages ?? _images;
        if (effectiveImages?.length) _imagesByBlockId.set(block.id, { name: block.name, images: effectiveImages });
        yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
        if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        working.push({ role: 'tool', tool_call_id: block.id, content: applyRedactions(result) });
        compatSeqResults.push({ name: block.name, args: block.argsJson, result });
      }
      for (const [, payload] of _imagesByBlockId) {
        working.push(buildImageUserMessage(providerKey, payload.images, `[attached: image(s) returned by ${payload.name}]`));
      }
      { const sc = guard.check(compatSeqResults.map(r => ({ name: r.name, args: r.args })), compatSeqResults.map(r => r.result));
        if (sc.stalled) { console.warn(`[${providerKey}] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
      continue;
    }

    // No tool calls, no finish_reason, AND no [DONE]: the SSE stream ended
    // before any terminal marker, so the text is likely truncated. Warn. A
    // provider that ends cleanly via [DONE] without per-chunk finish_reason
    // (some custom compat endpoints) sets sawDone and is NOT flagged.
    if (!finishReason && !sawDone) {
      yield { type: 'cortex_warning', message: 'The response may be incomplete — the model stream ended before its completion marker.' };
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
    yield { type: '__usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cachedTokens, provider: providerKey, model: agent.model };
  }
  if (totalInputTokens) {
    const hitRate = totalInputTokens ? (cachedTokens / totalInputTokens) : 0;
    const tierMode = agent._promptTiersAssembled ? 'tiered' : 'flat';
    console.log(`[${providerKey}] cache: mode=${tierMode} cached=${cachedTokens} input=${totalInputTokens} hit=${(hitRate*100).toFixed(0)}%`);
  }
}
