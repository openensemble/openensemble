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
import { writeFileSync } from 'fs';
import path from 'path';
import { ensureFreshToken, forceRefreshToken } from '../../lib/openai-codex-auth.mjs';
import { OPENAI_OAUTH_BASE, readAnthropicSSE, stripThinking, stripReasoningPreamble, getStripThinkingTags, getCompatKey, OPENAI_COMPAT_PROVIDERS } from './_shared.mjs';
import { LoopGuard, compressToolDefs } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';
import { buildImageUserMessage } from './_shared.mjs';
import { applyRedactions } from '../../lib/credentials.mjs';
import { nativeWebSearch, supportsImageGeneration } from '../../lib/model-capabilities.mjs';
import { mapOpenAIResponsesReasoning, isReasoningUnsupportedError } from '../../lib/reasoning-effort.mjs';
import { getUserFilesDir } from '../../lib/paths.mjs';

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

function saveImageGenerationResult(userId, item) {
  let base64 = item?.result ?? item?.image_base64 ?? item?.b64_json;
  if (!base64 || typeof base64 !== 'string') return null;
  if (base64.includes(',')) base64 = base64.split(',').pop();
  const idPart = String(item.id ?? item.call_id ?? 'openai_image')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const filename = `${idPart || 'openai_image'}_${Date.now()}.png`;
  let savedPath = null;
  try {
    const dir = getUserFilesDir(userId, 'images');
    savedPath = path.join(dir, filename);
    writeFileSync(savedPath, Buffer.from(base64, 'base64'));
  } catch (e) {
    console.warn('[openai-oauth] Failed to save generated image:', e.message);
  }
  return { base64, mimeType: 'image/png', filename, savedPath };
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
  // This adapter serves BOTH Responses-API providers: ChatGPT Codex
  // (openai-oauth, per-user OAuth token) and xAI grok (api.x.ai/v1/responses,
  // bearer API key). They share the Responses wire shape — identical SSE events,
  // tool/function-call format, and `instructions`/`input` request shape (all
  // live-verified for grok) — so the entire tool loop below is shared; only
  // auth, endpoint, headers, and the native-search provider slug differ.
  const isCodex     = agent.provider !== 'grok' && agent.provider !== 'xai';
  const wsProvider  = isCodex ? 'openai-oauth' : 'xai';
  const tag         = isCodex ? 'openai-oauth' : 'grok';
  const displayName = isCodex ? 'OpenAI Codex' : 'xAI Grok';
  const endpoint    = isCodex
    ? `${OPENAI_OAUTH_BASE}/responses`
    : `${OPENAI_COMPAT_PROVIDERS['xai'].baseUrl.replace(/\/$/, '')}/responses`;

  let auth;
  if (isCodex) {
    try {
      auth = await ensureFreshToken(userId);
    } catch (e) {
      yield { type: 'error', message: `OpenAI Codex OAuth: ${e.message}` };
      return;
    }
  } else {
    const key = getCompatKey('xai');
    if (!key) {
      yield { type: 'error', message: 'xAI Grok API key not set. Add it in Settings → Providers.' };
      return;
    }
    auth = { access_token: key, account_id: null };
  }

  const working = [...messages];

  // Stable per-(user, agent) prompt-cache routing hint. Our `instructions`
  // prefix is long and mostly stable across an agent's turns; this key tells the
  // Codex/OpenAI Responses backend to land those requests on the same cache
  // shard, which is what actually lifts CROSS-turn cache hits (without it, only
  // the intra-turn tool-loop iterations reliably hit). It's a routing hint only
  // — OpenAI still validates the real prefix, so a stale/colliding key can never
  // serve the wrong prefix. Codex-only: xAI's /responses may 400 on unknown body
  // fields, and 100% of our Codex traffic flows through here anyway.
  const promptCacheKey = isCodex ? `oe:${userId}:${agent.id ?? agent.name ?? 'agent'}` : null;

  let assistantContent = '';
  let totalInputTokens = 0, totalOutputTokens = 0, totalCachedTokens = 0;
  const guard = new LoopGuard(agent.maxToolLoops ?? 500);
  // Set if the Codex backend rejects the hosted web_search tool, so we resend
  // with the Brave function tool restored. Guards against the experimental
  // backend dropping hosted-tool support (the way it rejects web_search_preview
  // today) — without it, every web-search turn would die instead of degrading.
  let nativeSearchDisabled = false;
  let reasoningDisabled = false;
  // Native image generation costs real money per call and a confused agent
  // can loop it (a delegated "generate then attach" turn produced 8 Grand
  // Canyon images hunting for a file handle). Hard cap per turn; once hit,
  // later iterations simply don't offer the tool.
  const NATIVE_IMAGE_GEN_CAP = 3;
  let nativeImagesThisTurn = 0;

  while (guard.tick()) {
    // Re-read tools per iteration so dynamic toolset mutations (e.g. the
    // request_tools meta-tool expanding the coordinator's surface mid-turn)
    // take effect on the very next provider call. Cost: one O(tools) map
    // per iteration — negligible vs the API roundtrip.
    let responsesTools = agent.tools?.length ? toResponsesTools(agent.tools) : undefined;
    // Native web search: if the model can search+synthesize in one call AND the
    // agent already holds our Brave `web_search` tool, drop the Brave function
    // and inject the provider's hosted tool instead — one round-trip instead of
    // search → result → synthesize. wsProvider selects Codex vs grok.
    //
    // We ALSO drop `fetch_url` here: gpt's native tool searches AND reads pages
    // server-side, so on a native-search model ALL web access should go through
    // gpt. OE's `fetch_url` is a plain HTTP GET (12s timeout, no JS rendering)
    // that breaks the streamed answer with a tool round and times out on slow or
    // dynamic pages — exactly the failure we kept hitting. Routing everything
    // through the native tool keeps the answer streaming and avoids the OE fetch.
    const nativeSearch = nativeWebSearch(wsProvider, agent.model);
    const useNativeSearch = !nativeSearchDisabled
      && nativeSearch?.kind === 'responses'
      && agent.tools?.some(t => (t.function?.name ?? t.name) === 'web_search');
    if (useNativeSearch) {
      responsesTools = (responsesTools || []).filter(t => t.name !== 'web_search' && t.name !== 'fetch_url');
      responsesTools.push(nativeSearch.tool);
    }
    if (isCodex && supportsImageGeneration('openai-oauth', agent.model)
        && nativeImagesThisTurn < NATIVE_IMAGE_GEN_CAP) {
      responsesTools = responsesTools || [];
      if (!responsesTools.some(t => t.type === 'image_generation')) {
        responsesTools.push({ type: 'image_generation' });
      }
    }
    const body = {
      model:        agent.model,
      instructions: systemPrompt,
      input:        toResponsesInput(working),
      // The ChatGPT Codex backend defaults reasoning.effort to "none", which
      // makes gpt-5.x models refuse to call custom function tools with
      // tool_choice:"auto". "high" is needed for reliable tool selection on
      // custom toolsets (coder_*, ask_agent, etc.) — "medium" is too weak.
      store:        false,
      stream:       true,
    };
    if (!reasoningDisabled) body.reasoning = mapOpenAIResponsesReasoning(agent);
    if (responsesTools?.length) { body.tools = responsesTools; body.parallel_tool_calls = true; }
    if (promptCacheKey) body.prompt_cache_key = promptCacheKey;

    const headers = {
      'Content-Type':  'application/json',
      'Accept':        'text/event-stream',
      'Authorization': `Bearer ${auth.access_token}`,
    };
    // Codex backend needs these to accept the experimental Responses endpoint;
    // xAI's /v1/responses is a standard bearer-auth endpoint and rejects unknown
    // headers on some paths, so only send them for Codex.
    if (isCodex) {
      headers['OpenAI-Beta'] = 'responses=experimental';
      headers['Originator']  = 'codex_cli_rs';
      if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;
    }

    console.log(`[${tag}] POST /responses model=${agent.model} tools=${responsesTools?.length ?? 0} input_items=${body.input.length}${body.prompt_cache_key ? ` cache_key=${body.prompt_cache_key}` : ''}`);
    // The Codex backend occasionally drops connections at handshake time
    // (manifests as Node fetch's TypeError "fetch failed"). One quick retry
    // with a small backoff resolves the vast majority of these without the
    // user noticing. Only retried BEFORE the SSE stream emits — once tokens
    // start flowing, replay would duplicate output.
    let res;
    try {
      res = await postWithRetry(endpoint, {
        method: 'POST', signal, headers, body: JSON.stringify(body),
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const cause = e?.cause?.code || e?.cause?.message;
      const errTag = cause ? `${e.message} (${cause})` : e.message;
      console.error(`[${tag}] POST failed after retry: ${errTag}`);
      yield { type: 'error', message: `${displayName}: ${errTag}` };
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
      if (isCodex && res.status === 401 && /token_invalidated/i.test(errText)) {
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
      } else if (!reasoningDisabled && isReasoningUnsupportedError(res.status, errText)) {
        console.warn(`[${tag}] reasoning effort rejected; retrying without reasoning field`);
        reasoningDisabled = true;
        continue;
      } else if ((res.status === 400 || res.status === 422) && useNativeSearch && /web[_ ]?search|unsupported tool|unknown variant/i.test(errText)) {
        // The hosted web_search tool was rejected (e.g. the experimental Codex
        // backend dropped support). Resend this same turn with the Brave
        // web_search function restored — search still works, just via our local
        // path. Bounded: nativeSearchDisabled stays set, so a second failure
        // falls through to the generic error below (no retry loop).
        console.warn(`[${tag}] hosted web_search rejected (${res.status}); falling back to Brave web_search`);
        nativeSearchDisabled = true;
        continue;
      } else {
        console.error(`[${tag}] error ${res.status}: ${errText.slice(0, 500)}`);
        yield { type: 'error', message: `${displayName} error ${res.status}: ${errText}` };
        return;
      }
    }

    let textContent  = '';
    const generatedImages = [];
    const seenImageGenerationItems = new Set();
    const recordGeneratedImage = (item) => {
      const key = item?.id ?? item?.call_id ?? item?.result?.slice?.(0, 32);
      if (key && seenImageGenerationItems.has(key)) return null;
      const image = saveImageGenerationResult(userId, item);
      if (!image) return null;
      if (key) seenImageGenerationItems.add(key);
      generatedImages.push(image);
      nativeImagesThisTurn++;
      // Hand the MODEL the artifact id immediately. The human-facing
      // "Saved to:" note lands only at end-of-turn, so mid-turn the model
      // otherwise has no handle to the file it just produced — a delegated
      // "generate then attach" task then hunts the filesystem and
      // regenerates. This note rides the continuation input of any further
      // rounds in this turn; if the turn ends here it's harmlessly unused.
      working.push({
        role: 'user',
        content: `[server note] Image generated and saved — attachment id: images:${image.filename}. Use exactly this id wherever a file or attachment reference is needed; do not search for the file.`
          + (nativeImagesThisTurn >= NATIVE_IMAGE_GEN_CAP ? ' Image-generation limit for this turn reached — do not generate more images.' : ''),
      });
      return image;
    };
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
        if (!/^response\.(output_text\.(delta|done|annotation\.added)|output_item\.(added|done)|function_call_arguments\.(delta|done)|created|in_progress|completed|content_part\.(added|done)|web_search_call\.(in_progress|searching|completed)|image_generation_call\.(in_progress|generating|partial_image|completed)|reasoning_summary_part\.(added|done)|reasoning_summary_text\.(delta|done))$/.test(t)) {
          console.log(`[${tag}] unknown SSE event type: ${t}`, JSON.stringify(ev).slice(0, 300));
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
          // Argument deltas reference the fc_… ITEM id, not the call_… id the
          // map is keyed by — without this alias every delta missed and only
          // the final done re-delivery saved the args (a stream ending without
          // done yielded {}). Keys are disjoint (numbers vs fc_ strings).
          if (item.id && item.id !== callId) indexToCallId.set(item.id, callId);
        }
        if (item.type === 'image_generation_call') {
          yield { type: 'tool_progress', name: 'image_generation', text: 'Generating image...' };
        }
        continue;
      }
      if (t === 'response.function_call_arguments.delta') {
        const callId = indexToCallId.get(ev.item_id) ?? ev.item_id ?? indexToCallId.get(ev.output_index);
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
        if (item.type === 'image_generation_call') {
          const image = recordGeneratedImage(item);
          if (image) yield { type: 'image', ...image, prompt: '' };
        }
        continue;
      }
      if (t === 'response.image_generation_call.in_progress' || t === 'response.image_generation_call.generating') {
        yield { type: 'tool_progress', name: 'image_generation', text: 'Generating image...' };
        continue;
      }
      if (t === 'response.web_search_call.in_progress') {
        // Provider-hosted web search runs server-side (no local execution) and
        // folds its results straight into the output_text deltas. Surface a
        // transient progress indicator so chat shows activity; fires once per
        // search. Not a token, so voice devices won't speak it.
        yield { type: 'tool_progress', name: 'web_search', text: 'Searching the web…' };
        continue;
      }
      if (t === 'response.completed') {
        for (const item of ev.response?.output ?? []) {
          if (item?.type === 'image_generation_call') {
            const image = recordGeneratedImage(item);
            if (image) yield { type: 'image', ...image, prompt: '' };
          }
        }
        const usage = ev.response?.usage;
        if (usage) {
          totalInputTokens   += usage.input_tokens  ?? 0;
          totalOutputTokens  += usage.output_tokens ?? 0;
          // Responses API spells this `input_tokens_details.cached_tokens`
          // (vs Chat Completions' `prompt_tokens_details.cached_tokens`).
          totalCachedTokens  += usage.input_tokens_details?.cached_tokens ?? 0;
        }
        finalized = true;
        continue;
      }
      if (t === 'response.failed' || t === 'error') {
        const msg = ev.response?.error?.message ?? ev.error?.message ?? 'unknown error';
        yield { type: 'error', message: `${displayName}: ${msg}` };
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
          const { text, _notify, _images, events } = await drainToolWithEvents(block.name, toolArgs, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean));
          return { block, toolArgs, result: text, _notify, _images, events };
        }));
        const assistantToolCalls = results.map(({ block }) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.argsJson } }));
        working.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
        for (const { block, result, _notify, events } of results) {
          for (const ev of events) yield ev;
          yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
          if (_notify) yield { type: '__notify', name: block.name, ..._notify };
          working.push({ role: 'tool', tool_call_id: block.id, content: applyRedactions(result) });
        }
        // Vision attachments: append a synthesized user message carrying
        // any image data tools returned, so the model can SEE the pixels
        // on its next turn. The Responses-API input builder converts
        // image_url → input_image transparently.
        for (const { block, _images } of results) {
          if (_images?.length) {
            working.push(buildImageUserMessage('openai-oauth', _images, `[attached: image(s) returned by ${block.name}]`));
          }
        }
        { const sc = guard.check(results.map(r => ({ name: r.block.name, args: r.block.argsJson })), results.map(r => r.result));
          if (sc.stalled) { console.warn(`[openai-oauth] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
        continue;
      }

      const assistantToolCalls = blocks.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.argsJson } }));
      working.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
      const seqResults = [];
      const _imagesByBlockId = new Map();
      // Terminal handoff: a tool (ask_agent's forward pipeline) may signal that
      // its result IS the user-facing answer and the model should NOT run
      // another turn to relay it. We capture that reply, append the normal tool
      // result for transcript fidelity, then deliver it as assistantContent and
      // break the loop instead of re-inferring.
      let _terminalReply = null;
      for (const block of blocks) {
        let args = {};
        try { args = JSON.parse(block.argsJson || '{}'); } catch (e) { console.warn('[openai-oauth] Failed to parse tool args:', e.message); }
        yield { type: 'tool_call', name: block.name, args };
        let toolResultText = '';
        let _seqImages = null;
        for await (const chunk of executeToolStreaming(block.name, args, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean))) {
          if (chunk.type === 'token')              toolResultText += chunk.text;
          if (chunk.type === 'permission_request') yield chunk;
          if (chunk.type === '__hide_turn')         yield { type: '__hide_turn', reason: chunk.reason, taskId: chunk.taskId };
          if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args };
          if (chunk.type === 'tool_progress')      yield { type: 'tool_progress', name: chunk.name, text: chunk.text };
          if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) };
          if (chunk.type === 'image' || chunk.type === 'video' || chunk.type === 'audio') yield chunk;
          if (chunk.type === 'result') {
            toolResultText = chunk.text;
            if (Array.isArray(chunk._images)) _seqImages = chunk._images;
            if (chunk._terminal && typeof chunk.text === 'string') _terminalReply = chunk.text;
          }
        }
        const { text: result, _notify, _images } = normalizeToolResult(toolResultText);
        const effectiveImages = _seqImages ?? _images;
        if (effectiveImages?.length) _imagesByBlockId.set(block.id, { name: block.name, images: effectiveImages });
        yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result) };
        if (_notify) yield { type: '__notify', name: block.name, ..._notify };
        working.push({ role: 'tool', tool_call_id: block.id, content: applyRedactions(result) });
        seqResults.push({ name: block.name, args: block.argsJson, result });
      }
      // Vision attachments: append a synthesized user message per tool
      // call that returned image data. Inserted after all tool results
      // for this iteration so the LLM's next turn sees them as input.
      for (const [, payload] of _imagesByBlockId) {
        working.push(buildImageUserMessage('openai-oauth', payload.images, `[attached: image(s) returned by ${payload.name}]`));
      }
      { const sc = guard.check(seqResults.map(r => ({ name: r.name, args: r.args })), seqResults.map(r => r.result));
        if (sc.stalled) { console.warn(`[openai-oauth] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; yield { type: 'token', text: assistantContent }; break; } }
      if (_terminalReply != null) {
        // The pipeline reported its own final answer — deliver it as this
        // turn's reply and end the loop without another model call.
        assistantContent = _terminalReply;
        yield { type: 'replace', text: assistantContent };
        break;
      }
      continue;
    }

    if (generatedImages.length) {
      const imageText = generatedImages
        .map(img => `[Image: ${img.filename}]${img.savedPath ? `\nSaved to: ${img.savedPath}` : ''}`)
        .join('\n\n');
      textContent = [textContent.trim(), imageText].filter(Boolean).join('\n\n');
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
    yield { type: '__usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cachedTokens: totalCachedTokens, provider: tag, model: agent.model };
  }
  if (totalInputTokens) {
    const hitRate = totalCachedTokens / totalInputTokens;
    const tierMode = agent._promptTiersAssembled ? 'tiered' : 'flat';
    console.log(`[${tag}] cache: mode=${tierMode} cached=${totalCachedTokens} input=${totalInputTokens} hit=${(hitRate*100).toFixed(0)}%`);
  }
}
