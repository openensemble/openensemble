/**
 * Ollama streaming (chat + tools).
 *
 * Tool loop is inline: the model can either return structured `tool_calls` or
 * emit Qwen-style `<|tool_call|>json{...}<|/tool_call|>` text blocks, both of
 * which are detected and looped back with results.
 *
 * If the model exits the loop without text output but called tools, we
 * synthesize a short "Done. (tool names)" message so the session ends cleanly.
 */

import { executeToolStreaming } from '../../roles.mjs';
import { getOllamaUrl, getOllamaKey, readNDJSON, stripThinking, stripReasoningPreamble, getStripThinkingTags } from './_shared.mjs';
import { LoopGuard, compressToolDefs, compressToolCalls, truncateToolResult, compressOllamaHistory } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';

export async function* streamOllama(agent, systemPrompt, working, signal, userId = 'default') {
  // Inject system as first message — more reliable than top-level system field.
  const ollamaMessages = [{ role: 'system', content: systemPrompt }, ...working];

  let assistantContent = '';
  let ollamaInputTokens = 0, ollamaOutputTokens = 0;
  let toolCallsMade = [];  // track all tool calls for fallback summary
  const guard = new LoopGuard(agent.maxToolLoops ?? 500);

  while (guard.tick()) {
    // Compress old tool-call/result pairs before sending to keep context small.
    compressOllamaHistory(ollamaMessages, agent.contextSize ?? 32768);

    const body = {
      model:    agent.model,
      messages: ollamaMessages,
      stream:   true,
      think:    agent.think ?? false,
      options:  { num_ctx: agent.contextSize ?? 32768, num_predict: agent.maxTokens ?? 8192 },
    };
    if (agent.tools.length) {
      body.tools = compressToolDefs(agent.tools);
      // Force tool use on the first call so models like GLM don't skip tools and answer from history.
      // Subsequent iterations (after a tool result) use 'auto' to allow a free-text final response.
      body.tool_choice = guard.count === 1 ? 'required' : 'auto';
    }

    // ── Ollama request diagnostics ─────────────────────────────────────────
    const bodyJson = JSON.stringify(body);
    const approxTokens = Math.round(bodyJson.length / 4);
    console.log(`[ollama] loop=${guard.count} agent=${agent.id} model=${agent.model} msgs=${ollamaMessages.length} tools=${agent.tools.length} body=${bodyJson.length}b (~${approxTokens} tokens)`);
    ollamaMessages.forEach((m, i) => {
      const tcInfo = m.tool_calls ? ` tool_calls=[${m.tool_calls.map(t => t.function?.name ?? '?').join(',')}]` : '';
      const contentLen = m.content?.length ?? 0;
      console.log(`[ollama]   [${i}] role=${m.role} content=${contentLen}c${tcInfo}`);
    });
    // ──────────────────────────────────────────────────────────────────────

    // Retry on transient cloud 500s (Ollama cloud backend occasionally fails)
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ollamaUrl = getOllamaUrl();
      const ollamaKey = getOllamaKey();
      const ollamaHeaders = { 'Content-Type': 'application/json' };
      if (ollamaKey) ollamaHeaders['Authorization'] = `Bearer ${ollamaKey}`;
      res = await fetch(ollamaUrl, {
        method:  'POST',
        headers: ollamaHeaders,
        signal,
        body:    bodyJson,
      });
      if (res.ok || (res.status !== 500 && res.status !== 503)) break;
      const errText = await res.text();
      console.warn(`[ollama] ${res.status} on attempt ${attempt}/3 — retrying in ${attempt}s. ref: ${errText}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
      else {
        console.error(`[ollama] ERROR ${res.status} agent=${agent.id} model=${agent.model} body=${bodyJson.length}b (~${approxTokens} tokens)`);
        console.error(`[ollama] ERROR response: ${errText}`);
        console.error(`[ollama] ERROR messages dump:`);
        ollamaMessages.forEach((m, i) => {
          const tc = m.tool_calls ? JSON.stringify(m.tool_calls).slice(0, 300) : '';
          console.error(`[ollama]   [${i}] ${m.role}: content=${m.content?.slice(0,200)} ${tc}`);
        });
        yield { type: 'error', message: `Ollama error ${res.status}: ${errText}` };
        return;
      }
    }

    if (!res.ok) {
      const err = await res.text();
      console.error(`[ollama] ERROR ${res.status} agent=${agent.id} model=${agent.model}`);
      yield { type: 'error', message: `Ollama error ${res.status}: ${err}` };
      return;
    }

    // Collect streamed chunks
    let content   = '';
    let toolCalls = null;
    let inThink   = false;
    let ollamaPerf = null;

    for await (const chunk of readNDJSON(res.body)) {
      if (chunk.error) {
        yield { type: 'error', message: chunk.error };
        return;
      }

      // Final done chunk carries generation stats
      if (chunk.done && chunk.eval_count) {
        ollamaOutputTokens += chunk.eval_count ?? 0;
        ollamaInputTokens += chunk.prompt_eval_count ?? 0;
        if (chunk.eval_duration) {
          const tps  = chunk.eval_count / (chunk.eval_duration / 1e9);
          const ttft = chunk.prompt_eval_duration ? Math.round(chunk.prompt_eval_duration / 1e6) : null;
          ollamaPerf = { tps: Math.round(tps * 10) / 10, ttft, tokens: chunk.eval_count };
        }
      }

      const msg = chunk.message ?? {};

      // Tool call response (not streamed token-by-token)
      if (msg.tool_calls?.length) {
        toolCalls = msg.tool_calls;
        break;
      }

      // Streaming text token
      if (msg.content) {
        content += msg.content;

        // Track <think> blocks per token (not accumulated content — multi-block safe).
        // Skip filtering when think is explicitly disabled or when globally turned off.
        if (agent.think !== false && getStripThinkingTags()) {
          if (!inThink && msg.content.includes('<think>')) {
            const before = msg.content.split('<think>')[0];
            if (before) yield { type: 'token', text: before };
            inThink = true;
          }
          if (inThink) {
            if (msg.content.includes('</think>')) {
              inThink = false;
              const after = msg.content.split('</think>').pop();
              if (after) yield { type: 'token', text: after };
            }
            continue;
          }
        }
        yield { type: 'token', text: msg.content };
      }
    }

    // ── Tool calls branch ──────────────────────────────────────────────────────
    if (toolCalls) {
      // Clear any reasoning preamble streamed before the tool call
      if (content.trim()) yield { type: 'replace', text: '' };
      // Add the assistant's tool-call message to working history.
      // Truncate large string arguments (e.g. file content in coder_write_file)
      // so accumulated tool-call history doesn't bloat the context.
      ollamaMessages.push({ role: 'assistant', content: '', tool_calls: compressToolCalls(toolCalls) });

      // Multiple tool calls in one assistant turn — run in parallel.
      // All tools run via executeToolStreaming (blocking per-tool, full
      // result returned). Promise.all gives us concurrency. For ask_agent,
      // the coordinator waits for specialist responses before synthesizing.
      // Events are buffered per-tool and replayed in order after all complete.
      if (toolCalls.length > 1) {
        const batchParsed = toolCalls.map(tc => {
          const name = tc.function?.name ?? tc.name;
          const args = tc.function?.arguments ?? tc.arguments ?? {};
          return { tc, name, args };
        });
        for (const { name, args } of batchParsed) {
          yield { type: 'tool_call', name, args };
          toolCallsMade.push(name);
        }
        const batchResults = await Promise.all(batchParsed.map(async ({ name, args }) => {
          const { text, _notify, events } = await drainToolWithEvents(name, args, userId, agent.id);
          return { name, result: text, _notify, events };
        }));
        for (const { name, result, _notify, events } of batchResults) {
          for (const ev of events) yield ev;
          yield { type: 'tool_result', name, text: result, preview: summarizeToolResult(name, result) };
          if (_notify) yield { type: '__notify', name, ..._notify };
          ollamaMessages.push({ role: 'tool', content: truncateToolResult(result), name });
        }
        { const sc = guard.check(batchResults.map(r => ({ name: r.name, args: JSON.stringify(batchParsed.find(p => p.name === r.name)?.args ?? {}) })), batchResults.map(r => r.result));
          if (sc.stalled) { console.warn(`[ollama] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
        continue;
      }

      for (const tc of toolCalls) {
        const name = tc.function?.name ?? tc.name ?? '?';
        toolCallsMade.push(name);
        const args = tc.function?.arguments ?? tc.arguments ?? {};

        yield { type: 'tool_call', name, args };

        let toolResult = '';
        for await (const chunk of executeToolStreaming(name, args, userId, agent.id)) {
          if (chunk.type === 'token')              toolResult += chunk.text;
          if (chunk.type === 'permission_request') yield chunk;
          if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args };
          if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) };
          if (chunk.type === 'result')             toolResult = chunk.text;
        }
        const { text: result, _notify } = normalizeToolResult(toolResult);
        yield { type: 'tool_result', name, text: result, preview: summarizeToolResult(name, result) };
        if (_notify) yield { type: '__notify', name, ..._notify };

        // Add tool result to working history — truncate large outputs so the model
        // isn't carrying full file contents forward (mirrors Claude Code behavior).
        ollamaMessages.push({ role: 'tool', content: truncateToolResult(result), name });
      }

      { const sc = guard.check(
          toolCalls.map(tc => ({ name: tc.function?.name ?? tc.name ?? '?', args: JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}) })),
          toolCalls.map(tc => { const m = ollamaMessages.findLast(m => m.role === 'tool' && m.name === (tc.function?.name ?? tc.name)); return m?.content ?? ''; })
        );
        if (sc.stalled) { console.warn(`[ollama] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }

      continue; // loop: send tool results back to the model
    }

    // ── Qwen inline tool calls (emitted as text instead of structured tool_calls) ─
    if (!toolCalls && content.includes('<|tool_call|>')) {
      const matches = [...content.matchAll(/<\|tool_call\|>json\s*(\{[\s\S]*?\})\s*<\|\/tool_call\|>/g)];
      const parsed = matches.map(m => {
        try {
          const obj = JSON.parse(m[1]);
          return { function: { name: obj.function || obj.name, arguments: obj.arguments ?? obj.parameters ?? {} } };
        } catch { return null; }
      }).filter(Boolean);
      if (parsed.length) {
        toolCalls = parsed;
        // Replace the streamed text with nothing — tool call output will follow
        yield { type: 'replace', text: '' };
        continue;
      }
    }

    // ── Text response complete ─────────────────────────────────────────────────
    assistantContent = (agent.think !== false && getStripThinkingTags())
      ? stripReasoningPreamble(stripThinking(content))
      : stripReasoningPreamble(content);
    if (assistantContent !== content) yield { type: 'replace', text: assistantContent };
    if (ollamaPerf) yield { type: 'perf', ...ollamaPerf };
    break;
  }

  if (!assistantContent) {
    if (toolCallsMade.length > 0) {
      // Model finished all tool work but hit the loop cap without sending a text reply.
      // Synthesize a minimal completion message so the session ends cleanly.
      const uniqueTools = [...new Set(toolCallsMade)];
      assistantContent = `Done. (${uniqueTools.join(', ')})`;
      yield { type: 'token', text: assistantContent };
    } else {
      yield { type: 'error', message: 'No response from model.' };
      return;
    }
  }

  yield { type: '__content', content: assistantContent };
  if (ollamaInputTokens || ollamaOutputTokens) {
    yield { type: '__usage', inputTokens: ollamaInputTokens, outputTokens: ollamaOutputTokens, provider: 'ollama', model: agent.model };
  }
}
