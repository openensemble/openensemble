/**
 * OpenAI Codex (ChatGPT OAuth) via the Responses API.
 *
 * Uses a per-user OAuth token (see lib/openai-codex-auth.mjs) and hits the
 * ChatGPT backend's /responses endpoint, which is streaming-only and takes an
 * "input" array + "instructions" string rather than /chat/completions-style
 * messages. We translate our internal messages into that shape, relay tokens
 * from `response.output_text.delta`, and run the same tool loop as the
 * OpenAI-compat branch.
 */

import { executeToolStreaming } from '../../roles.mjs';
import { ensureFreshToken, forceRefreshToken } from '../../lib/openai-codex-auth.mjs';
import { OPENAI_OAUTH_BASE, readAnthropicSSE, stripThinking, stripReasoningPreamble, getStripThinkingTags } from './_shared.mjs';
import { LoopGuard, compressToolDefs } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';
import { applyRedactions } from '../../lib/credentials.mjs';

export function toResponsesInput(messages) {
  // Translate OpenAI-compat messages → Responses API input items.
  // Supported inbound shapes:
  //   { role: 'user'|'assistant'|'system', content: string }
  //   { role: 'assistant', content: null, tool_calls: [{ id, function: { name, arguments } }] }
  //   { role: 'tool', tool_call_id, content: string }
  const items = [];
  for (const m of messages) {
    if (m.role === 'system') {
      // Merged into top-level `instructions`; skip here.
      continue;
    }
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content ?? '') });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        items.push({
          type:      'function_call',
          call_id:   tc.id,
          name:      tc.function?.name ?? tc.name,
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        });
      }
      if (typeof m.content === 'string' && m.content.trim()) {
        items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      continue;
    }
    const partType = m.role === 'assistant' ? 'output_text' : 'input_text';
    // Handle multimodal array content (e.g. vision turns with image_url + text parts).
    // Responses API wants input_image parts with a flat image_url string.
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const p of m.content) {
        if (p?.type === 'image_url' && m.role === 'user') {
          const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
          if (url) parts.push({ type: 'input_image', image_url: url });
        } else if (p?.type === 'text' || typeof p?.text === 'string') {
          parts.push({ type: partType, text: p.text ?? '' });
        }
      }
      if (parts.length) { items.push({ type: 'message', role: m.role, content: parts }); continue; }
    }
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    items.push({ type: 'message', role: m.role, content: [{ type: partType, text }] });
  }
  return items;
}

export function toResponsesTools(tools) {
  // Responses API wants a flat { type:"function", name, description, parameters } shape,
  // not the /chat/completions nested { type:"function", function:{ ... } } shape.
  return compressToolDefs(tools).map(t => ({
    type:        'function',
    name:        t.function.name,
    description: t.function.description ?? '',
    parameters:  t.function.parameters ?? { type: 'object', properties: {} },
  }));
}

// Network-blip patterns we'll retry once before giving up. Anything else
// (4xx, 5xx, auth, malformed body) propagates immediately — we don't want
// to mask real provider errors as transient network issues.
const RETRIABLE_NETWORK_RE = /^fetch failed$|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i;
function isRetriableNetworkError(e) {
  if (!e) return false;
  if (RETRIABLE_NETWORK_RE.test(e.message || '')) return true;
  const causeMsg = e.cause?.message || '';
  const causeCode = e.cause?.code || '';
  return RETRIABLE_NETWORK_RE.test(causeMsg) || RETRIABLE_NETWORK_RE.test(causeCode);
}

async function postWithRetry(url, init, { attempts = 2, backoffMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      lastErr = e;
      if (!isRetriableNetworkError(e) || i === attempts - 1) throw e;
      const causeTag = e.cause?.code || e.cause?.message || e.message;
      console.warn(`[openai-oauth] fetch attempt ${i + 1}/${attempts} failed (${causeTag}) — retrying in ${backoffMs}ms`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

export async function* streamOpenAIResponses(agent, systemPrompt, messages, signal, userId = 'default') {
  let auth;
  try {
    auth = await ensureFreshToken(userId);
  } catch (e) {
    yield { type: 'error', message: `OpenAI Codex OAuth: ${e.message}` };
    return;
  }

  const working = [...messages];

  let assistantContent = '';
  let totalInputTokens = 0, totalOutputTokens = 0;
  const guard = new LoopGuard(agent.maxToolLoops ?? 500);

  while (guard.tick()) {
    // Re-read tools per iteration so dynamic toolset mutations (e.g. the
    // request_tools meta-tool expanding the coordinator's surface mid-turn)
    // take effect on the very next provider call. Cost: one O(tools) map
    // per iteration — negligible vs the API roundtrip.
    const responsesTools = agent.tools?.length ? toResponsesTools(agent.tools) : undefined;
    const body = {
      model:        agent.model,
      instructions: systemPrompt,
      input:        toResponsesInput(working),
      // The ChatGPT Codex backend defaults reasoning.effort to "none", which
      // makes gpt-5.x models refuse to call custom function tools with
      // tool_choice:"auto". "high" is needed for reliable tool selection on
      // custom toolsets (coder_*, ask_agent, etc.) — "medium" is too weak.
      reasoning:    { effort: agent.reasoningEffort ?? 'high' },
      store:        false,
      stream:       true,
    };
    if (responsesTools) { body.tools = responsesTools; body.parallel_tool_calls = true; }

    const headers = {
      'Content-Type':  'application/json',
      'Accept':        'text/event-stream',
      'Authorization': `Bearer ${auth.access_token}`,
      'OpenAI-Beta':   'responses=experimental',
      'Originator':    'codex_cli_rs',
    };
    if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;

    console.log(`[openai-oauth] POST /responses model=${agent.model} tools=${responsesTools?.length ?? 0} input_items=${body.input.length}`);
    // The Codex backend occasionally drops connections at handshake time
    // (manifests as Node fetch's TypeError "fetch failed"). One quick retry
    // with a small backoff resolves the vast majority of these without the
    // user noticing. Only retried BEFORE the SSE stream emits — once tokens
    // start flowing, replay would duplicate output.
    let res;
    try {
      res = await postWithRetry(`${OPENAI_OAUTH_BASE}/responses`, {
        method: 'POST', signal, headers, body: JSON.stringify(body),
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const cause = e?.cause?.code || e?.cause?.message;
      const tag = cause ? `${e.message} (${cause})` : e.message;
      console.error(`[openai-oauth] POST failed after retry: ${tag}`);
      yield { type: 'error', message: `OpenAI Codex: ${tag}` };
      return;
    }
    if (!res.ok) {
      const errText = await res.text();
      // 401 token_invalidated: ChatGPT revoked our session server-side while
      // our local expires_at says the token is still valid. ensureFreshToken
      // skipped the refresh because of that, so the request used a dead token.
      // Force a refresh and retry once — refresh_token is usually still good
      // unless the user did a full logout, in which case we surface a clear
      // "please reconnect" instead of looping.
      if (res.status === 401 && /token_invalidated/i.test(errText)) {
        // Plain-English message for the user. Used in two spots below: when
        // refresh itself fails, and when the retry after a successful refresh
        // still returns 401. Both cases mean the session is unrecoverable
        // server-side and the user must reconnect their provider. Kept
        // provider-agnostic because this gets spoken on voice devices where
        // the user just needs to know what action to take, not the specifics.
        const REAUTH_MSG = "Your coordinator's provider needs to be reauthenticated. Please reconnect it in Settings.";
        console.warn(`[openai-oauth] 401 token_invalidated — forcing refresh and retrying once`);
        try {
          auth = await forceRefreshToken(userId);
        } catch (e) {
          console.warn(`[openai-oauth] refresh_token also invalid for user=${userId}: ${e.message}`);
          yield { type: 'error', message: REAUTH_MSG };
          return;
        }
        headers.Authorization = `Bearer ${auth.access_token}`;
        if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;
        try {
          res = await postWithRetry(`${OPENAI_OAUTH_BASE}/responses`, {
            method: 'POST', signal, headers, body: JSON.stringify(body),
          });
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          yield { type: 'error', message: `OpenAI Codex: ${e.message}` };
          return;
        }
        if (!res.ok) {
          const retryErr = await res.text();
          console.error(`[openai-oauth] 401 retry still failed ${res.status}: ${retryErr.slice(0, 500)}`);
          // If the upstream rejected the brand-new access token too, that's
          // the same "session truly revoked" signal — show the same reconnect
          // prompt rather than a raw error blob.
          if (res.status === 401) {
            yield { type: 'error', message: REAUTH_MSG };
          } else {
            yield { type: 'error', message: `OpenAI Codex error ${res.status} after token refresh: ${retryErr}` };
          }
          return;
        }
      } else {
        console.error(`[openai-oauth] error ${res.status}: ${errText.slice(0, 500)}`);
        yield { type: 'error', message: `OpenAI Codex error ${res.status}: ${errText}` };
        return;
      }
    }

    let textContent  = '';
    // call_id → { id (same as call_id), name, argsJson }
    const toolCalls  = new Map();
    // output_index → call_id so *.delta events (keyed by output_index) route correctly
    const indexToCallId = new Map();
    let tokenCount   = 0;
    const startedAt  = Date.now();
    let firstTokenAt = null;
    let finalized    = false;

    const seenEventTypes = new Set();
    for await (const ev of readAnthropicSSE(res.body)) {
      const t = ev.type;
      if (t && !seenEventTypes.has(t)) {
        seenEventTypes.add(t);
        if (!/^response\.(output_text\.delta|output_item\.(added|done)|function_call_arguments\.delta|created|in_progress|completed|content_part\.(added|done)|output_text\.done)$/.test(t)) {
          console.log(`[openai-oauth] unknown SSE event type: ${t}`, JSON.stringify(ev).slice(0, 300));
        }
      }
      if (t === 'response.output_text.delta' && typeof ev.delta === 'string') {
        if (!firstTokenAt) firstTokenAt = Date.now();
        tokenCount++;
        textContent += ev.delta;
        yield { type: 'token', text: ev.delta };
        continue;
      }
      if (t === 'response.output_item.added') {
        const item = ev.item ?? {};
        if (item.type === 'function_call') {
          const callId = item.call_id ?? item.id;
          toolCalls.set(callId, { id: callId, name: item.name ?? '', argsJson: typeof item.arguments === 'string' ? item.arguments : '' });
          if (typeof ev.output_index === 'number') indexToCallId.set(ev.output_index, callId);
        }
        continue;
      }
      if (t === 'response.function_call_arguments.delta') {
        const callId = ev.item_id ?? indexToCallId.get(ev.output_index);
        const entry = callId && toolCalls.get(callId);
        if (entry && typeof ev.delta === 'string') entry.argsJson += ev.delta;
        continue;
      }
      if (t === 'response.output_item.done') {
        const item = ev.item ?? {};
        if (item.type === 'function_call') {
          const callId = item.call_id ?? item.id;
          const entry = toolCalls.get(callId);
          if (entry) {
            if (item.name) entry.name = item.name;
            if (typeof item.arguments === 'string' && item.arguments.length >= entry.argsJson.length) {
              entry.argsJson = item.arguments;
            }
          } else {
            toolCalls.set(callId, { id: callId, name: item.name ?? '', argsJson: typeof item.arguments === 'string' ? item.arguments : '' });
          }
        }
        continue;
      }
      if (t === 'response.completed') {
        const usage = ev.response?.usage;
        if (usage) {
          totalInputTokens  += usage.input_tokens  ?? 0;
          totalOutputTokens += usage.output_tokens ?? 0;
        }
        finalized = true;
        continue;
      }
      if (t === 'response.failed' || t === 'error') {
        const msg = ev.response?.error?.message ?? ev.error?.message ?? 'unknown error';
        yield { type: 'error', message: `OpenAI Codex: ${msg}` };
        return;
      }
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
          const { text, _notify, events } = await drainToolWithEvents(block.name, toolArgs, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean));
          return { block, toolArgs, result: text, _notify, events };
        }));
        const assistantToolCalls = results.map(({ block }) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.argsJson } }));
        working.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
        for (const { block, result, _notify, events } of results) {
          for (const ev of events) yield ev;
          yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
          if (_notify) yield { type: '__notify', name: block.name, ..._notify };
          working.push({ role: 'tool', tool_call_id: block.id, content: applyRedactions(result) });
        }
        { const sc = guard.check(results.map(r => ({ name: r.block.name, args: r.block.argsJson })), results.map(r => r.result));
          if (sc.stalled) { console.warn(`[openai-oauth] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
        continue;
      }

      const assistantToolCalls = blocks.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.argsJson } }));
      working.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
      const seqResults = [];
      for (const block of blocks) {
        let args = {};
        try { args = JSON.parse(block.argsJson || '{}'); } catch (e) { console.warn('[openai-oauth] Failed to parse tool args:', e.message); }
        yield { type: 'tool_call', name: block.name, args };
        let toolResultText = '';
        for await (const chunk of executeToolStreaming(block.name, args, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean))) {
          if (chunk.type === 'token')              toolResultText += chunk.text;
          if (chunk.type === 'permission_request') yield chunk;
          if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args };
          if (chunk.type === 'tool_progress')      yield { type: 'tool_progress', name: chunk.name, text: chunk.text };
          if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) };
          if (chunk.type === 'result')             toolResultText = chunk.text;
        }
        const { text: result, _notify } = normalizeToolResult(toolResultText);
        yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
        if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        working.push({ role: 'tool', tool_call_id: block.id, content: applyRedactions(result) });
        seqResults.push({ name: block.name, args: block.argsJson, result });
      }
      { const sc = guard.check(seqResults.map(r => ({ name: r.name, args: r.args })), seqResults.map(r => r.result));
        if (sc.stalled) { console.warn(`[openai-oauth] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
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
    if (!finalized) {
      // Stream ended without response.completed — still emit what we have.
    }
    break;
  }

  yield { type: '__content', content: assistantContent };
  if (totalInputTokens || totalOutputTokens) {
    yield { type: '__usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, provider: 'openai-oauth', model: agent.model };
  }
}
