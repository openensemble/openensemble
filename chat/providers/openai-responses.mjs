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
import { OPENAI_OAUTH_BASE, readAnthropicSSE, stripThinking, stripReasoningPreamble, getStripThinkingTags, getCompatKey, OPENAI_COMPAT_PROVIDERS, capabilityNotice, modelCallTraceEvent } from './_shared.mjs';
import { LoopGuard, compressToolDefs } from '../compress.mjs';
import { summarizeToolResult, normalizeToolResult, drainToolWithEvents } from '../preview.mjs';
import { buildImageUserMessage } from './_shared.mjs';
import { applyRedactions } from '../../lib/credentials.mjs';
import { nativeWebSearch, supportsImageGeneration } from '../../lib/model-capabilities.mjs';
import { mapOpenAIResponsesReasoning, isReasoningUnsupportedError } from '../../lib/reasoning-effort.mjs';
import { getUserFilesDir } from '../../lib/paths.mjs';
import { getTurn, getTurnLabProviderRequestCap } from '../../lib/turn-trace-context.mjs';
import { getToolRouterContext } from '../../lib/tool-router-context.mjs';
import { getTurnContext } from '../../lib/turn-abort-context.mjs';
import {
  assertActiveLabVerifierLeaseToken,
  inspectLabVerifierLease,
} from '../../lib/lab-verifier-lease.mjs';

// Keep the lab-only request ceiling shared across provider-generator restarts
// and recovery calls. The trace cap is non-enumerated and cannot leak into
// durable trace output.
const labRequestsByTurn = new WeakMap();
const LAB_MAX_OBSERVED_OUTPUT_TOKENS_PER_RESPONSE = 4_096;
const LAB_DEFAULT_PROVIDER_REQUEST_CAP = 4;
const LAB_MAX_INTERNAL_PROVIDER_REQUEST_CAP = 6;

function currentLabProviderRequestCap() {
  const tracedCap = getTurnLabProviderRequestCap();
  if (tracedCap != null) return tracedCap;
  const routedCap = getToolRouterContext()?.labProviderRequestCap;
  return Number.isSafeInteger(routedCap)
    && routedCap >= 1
    && routedCap <= LAB_MAX_INTERNAL_PROVIDER_REQUEST_CAP
    ? routedCap
    : LAB_DEFAULT_PROVIDER_REQUEST_CAP;
}

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

/**
 * Replace OE's authorized generate_image function with the Codex-hosted tool.
 * The internal marker selects a backend; it is deliberately insufficient on
 * its own. The current turn must still hold generate_image, preserving account
 * allowedSkills, user tool plans, intent routing, and request_tools recovery.
 */
export function applyProviderHostedImageTool(agent, responsesTools, nativeImagesThisTurn, cap = 3) {
  const holdsAuthorizedCapability = agent?._providerHostedImageBackend === true
    && agent?.provider === 'openai-oauth'
    && supportsImageGeneration('openai-oauth', agent?.model)
    && agent?.tools?.some(tool => (tool?.function?.name ?? tool?.name) === 'generate_image');
  if (!holdsAuthorizedCapability) return responsesTools;

  const next = (responsesTools ?? []).filter(tool => !(
    tool?.type === 'function' && tool?.name === 'generate_image'
  ));
  // Once the per-turn paid-generation cap is reached, keep the unavailable
  // local fallback filtered too; advertising it would only produce a policy-
  // bypass attempt or a guaranteed backend error.
  if (nativeImagesThisTurn < cap) next.push({ type: 'image_generation' });
  return next;
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

const MAX_NATIVE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_NATIVE_IMAGE_BASE64_CHARS = Math.ceil(MAX_NATIVE_IMAGE_BYTES / 3) * 4 + 128;

function decodeNativeImageBase64(value) {
  let base64 = value;
  if (!base64 || typeof base64 !== 'string') return null;
  if (base64.includes(',')) base64 = base64.split(',').pop();
  if (!base64 || base64.length > MAX_NATIVE_IMAGE_BASE64_CHARS
      || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_NATIVE_IMAGE_BYTES) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { bytes, base64, mimeType: 'image/png', extension: 'png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    return { bytes, base64, mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { bytes, base64, mimeType: 'image/webp', extension: 'webp' };
  }
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { bytes, base64, mimeType: 'image/gif', extension: 'gif' };
  }
  return null;
}

export function saveImageGenerationResult(userId, item) {
  let base64 = item?.result ?? item?.image_base64 ?? item?.b64_json;
  const image = decodeNativeImageBase64(base64);
  if (!image) return null;
  base64 = image.base64;
  const idPart = String(item.id ?? item.call_id ?? 'openai_image')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const filename = `${idPart || 'openai_image'}_${Date.now()}.${image.extension}`;
  let savedPath = null;
  try {
    const dir = getUserFilesDir(userId, 'images');
    const diskPath = path.join(dir, filename);
    writeFileSync(diskPath, image.bytes, { mode: 0o600, flag: 'wx' });
    savedPath = `images:${filename}`;
  } catch (e) {
    console.warn('[openai-oauth] Failed to save generated image:', e.message);
  }
  return { base64, mimeType: image.mimeType, filename, savedPath };
}

async function postWithRetry(url, init, { attempts = 2, backoffMs = 1000, onAttempt = null } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      onAttempt?.();
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
  const labCodexRelay = isCodex
    && process.env.OPENENSEMBLE_LAB === '1'
    && process.env.OE_LAB_CODEX_RELAY === '1';
  const endpoint    = isCodex
    ? `${OPENAI_OAUTH_BASE}/responses`
    : `${OPENAI_COMPAT_PROVIDERS['xai'].baseUrl.replace(/\/$/, '')}/responses`;

  let assistantContent = '';
  let totalInputTokens = 0, totalOutputTokens = 0, totalCachedTokens = 0;
  // Track request/completion/usage cardinality separately from token totals.
  // Aggregate totals cannot prove that every logical provider round produced
  // exactly one terminal record and one usage object.
  let reqCount = 0, completionCount = 0, usageCount = 0;
  let usageCardinalityValid = true;
  const usageTelemetry = () => ({
    type: '__usage',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cachedTokens: totalCachedTokens,
    provider: tag,
    model: agent.model,
    reqCount,
    completionCount,
    usageCount,
    usageComplete: reqCount > 0
      && usageCardinalityValid
      && reqCount === completionCount
      && reqCount === usageCount,
  });
  const assertProviderLeaseBoundary = () => {
    // The required bit is itself part of the authenticated ambient context.
    // Check it even if lab mode were accidentally toggled off mid-run; an
    // environment change must not downgrade detached verifier work.
    const turnContext = getTurnContext();
    if (turnContext?.verifierLeaseRequired === true) {
      assertActiveLabVerifierLeaseToken(turnContext.verifierLeaseToken);
    } else if (process.env.OPENENSEMBLE_LAB === '1'
      && inspectLabVerifierLease(null) !== 'absent') {
      // Dispatcher exclusivity also covers direct/internal adapter callers.
      // An ordinary worker that predates lease acquisition must not slip an
      // unrelated request into the real-model evidence window.
      throw Object.assign(
        new Error('the isolated lab provider is exclusively leased by the verifier'),
        { code: 'LAB_VERIFIER_LEASE_EXCLUSIVE' },
      );
    }
  };
  // Refuse before token freshness can perform any auth-network activity. The
  // same assertion runs again at every fetch attempt below to bind each actual
  // provider request to the still-live lease.
  try {
    assertProviderLeaseBoundary();
  } catch (error) {
    yield usageTelemetry();
    yield { type: 'error', message: `${displayName}: ${error.message}` };
    return;
  }
  const noteProviderAttempt = () => {
    // Revalidate after all prompt construction and immediately before fetch.
    // This closes the worker-completion gap if the lease expired, was removed,
    // or changed after detached completion publication began.
    assertProviderLeaseBoundary();
    if (process.env.OPENENSEMBLE_LAB === '1') {
      const turn = getTurn();
      if (turn) {
        const cap = currentLabProviderRequestCap();
        const used = labRequestsByTurn.get(turn) || 0;
        if (used >= cap) throw new Error(`Lab provider request cap (${cap}) reached for this turn`);
        labRequestsByTurn.set(turn, used + 1);
      } else if (reqCount >= LAB_DEFAULT_PROVIDER_REQUEST_CAP) {
        // Direct adapter probes do not establish a turn trace. Keep the same
        // hard ceiling within that generator instead of silently disabling it.
        throw new Error('Lab provider request cap reached for this run');
      }
    }
    reqCount++;
  };

  let auth;
  if (isCodex) {
    try {
      auth = await ensureFreshToken(userId);
    } catch (e) {
      yield usageTelemetry();
      yield { type: 'error', message: `OpenAI Codex OAuth: ${e.message}` };
      return;
    }
  } else {
    const key = getCompatKey('xai');
    if (!key) {
      yield usageTelemetry();
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

  const configuredLoopCap = agent.maxToolLoops ?? 500;
  // The isolated real-provider verifier must have a hard spend/runaway bound
  // even if an agent config accidentally restores the production default.
  // Production semantics remain unchanged outside the lab.
  const loopCap = process.env.OPENENSEMBLE_LAB === '1'
    ? Math.min(configuredLoopCap, currentLabProviderRequestCap())
    : configuredLoopCap;
  const guard = new LoopGuard(loopCap);
  // A tool call is not a final assistant answer. Remember when the most recent
  // permitted provider round ended in tools so loop-budget exhaustion cannot
  // masquerade as a successful empty completion.
  let awaitingPostToolAnswer = false;
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

  try {
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
    const useNativeSearch = !labCodexRelay
      && !nativeSearchDisabled
      && nativeSearch?.kind === 'responses'
      && agent.tools?.some(t => (t.function?.name ?? t.name) === 'web_search');
    if (useNativeSearch) {
      responsesTools = (responsesTools || []).filter(t => t.name !== 'web_search' && t.name !== 'fetch_url');
      responsesTools.push(nativeSearch.tool);
    }
    if (isCodex && !labCodexRelay) {
      responsesTools = applyProviderHostedImageTool(
        agent, responsesTools, nativeImagesThisTurn, NATIVE_IMAGE_GEN_CAP,
      );
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
    if (process.env.OPENENSEMBLE_LAB === '1' && !labCodexRelay) {
      // Public Responses-compatible providers accept this request-side cap.
      // ChatGPT's internal Codex endpoint does not; the relay bounds transport
      // while terminal usage is checked below before text or tools are kept.
      body.max_output_tokens = LAB_MAX_OBSERVED_OUTPUT_TOKENS_PER_RESPONSE;
    }
    if (!reasoningDisabled) body.reasoning = mapOpenAIResponsesReasoning(agent);
    if (responsesTools?.length) { body.tools = responsesTools; body.parallel_tool_calls = true; }
    if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
    const paidHostedImageOffered = body.tools?.some(tool => tool?.type === 'image_generation') === true;

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
    yield modelCallTraceEvent({
      provider: tag, model: agent.model, tools: body.tools, round: guard.count,
    });
    // The Codex backend occasionally drops connections at handshake time
    // (manifests as Node fetch's TypeError "fetch failed"). One quick retry
    // with a small backoff resolves the vast majority of these without the
    // user noticing. Only retried BEFORE the SSE stream emits — once tokens
    // start flowing, replay would duplicate output.
    let res;
    try {
      res = await postWithRetry(endpoint, {
        method: 'POST', signal, headers, body: JSON.stringify(body),
      }, {
        // No verified idempotency primitive exists for the hosted paid image
        // tool. A handshake failure may follow provider acceptance, so never
        // automatically replay a request that offered image_generation.
        attempts: process.env.OPENENSEMBLE_LAB === '1' || paidHostedImageOffered ? 1 : 2,
        onAttempt: noteProviderAttempt,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const cause = e?.cause?.code || e?.cause?.message;
      const errTag = cause ? `${e.message} (${cause})` : e.message;
      console.error(`[${tag}] POST failed after retry: ${errTag}`);
      yield usageTelemetry();
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
      if (labCodexRelay && (res.status === 401 || res.status === 403)) {
        // The acceptance lab has an access-token snapshot only. Never invoke
        // either OAuth refresh path from this process; a rejected snapshot
        // must be deliberately reinjected from the host after review.
        usageCardinalityValid = false;
        yield usageTelemetry();
        yield { type: 'error', message: 'The lab provider access snapshot is unavailable or expired.' };
        return;
      } else if (isCodex && res.status === 401 && /token_invalidated/i.test(errText)) {
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
          yield usageTelemetry();
          yield { type: 'error', message: REAUTH_MSG };
          return;
        }
        // Refresh itself succeeded (the FAILED-refresh path above already
        // yields REAUTH_MSG, a user-visible error — leave that alone). This
        // silent-success path can legitimately fire often over a long-running
        // process (access tokens expire hourly), so it's keyed per-account
        // and fires once ever per process, not once per refresh.
        { const notice = capabilityNotice('openai-oauth', `token_refresh:${userId}`, 'Refreshed the provider login token automatically.');
          if (notice) yield notice; }
        headers.Authorization = `Bearer ${auth.access_token}`;
        if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;
        try {
          // This rejected request had no completion/usage record. Preserve
          // that gap even if the refreshed-token retry succeeds.
          usageCardinalityValid = false;
          res = await postWithRetry(`${OPENAI_OAUTH_BASE}/responses`, {
            method: 'POST', signal, headers, body: JSON.stringify(body),
          }, {
            attempts: process.env.OPENENSEMBLE_LAB === '1' || paidHostedImageOffered ? 1 : 2,
            onAttempt: noteProviderAttempt,
          });
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          yield usageTelemetry();
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
            yield usageTelemetry();
            yield { type: 'error', message: REAUTH_MSG };
          } else {
            yield usageTelemetry();
            yield { type: 'error', message: `OpenAI Codex error ${res.status} after token refresh: ${retryErr}` };
          }
          return;
        }
      } else if (!reasoningDisabled && isReasoningUnsupportedError(res.status, errText)) {
        usageCardinalityValid = false;
        console.warn(`[${tag}] reasoning effort rejected; retrying without reasoning field`);
        reasoningDisabled = true;
        { const notice = capabilityNotice(tag, 'reasoning_effort', 'Provider rejected the configured reasoning effort — continuing without it.');
          if (notice) yield notice; }
        continue;
      } else if ((res.status === 400 || res.status === 422) && useNativeSearch && /web[_ ]?search|unsupported tool|unknown variant/i.test(errText)) {
        // The hosted web_search tool was rejected (e.g. the experimental Codex
        // backend dropped support). Resend this same turn with the Brave
        // web_search function restored — search still works, just via our local
        // path. Bounded: nativeSearchDisabled stays set, so a second failure
        // falls through to the generic error below (no retry loop).
        usageCardinalityValid = false;
        console.warn(`[${tag}] hosted web_search rejected (${res.status}); falling back to Brave web_search`);
        nativeSearchDisabled = true;
        { const notice = capabilityNotice(tag, 'native_search', 'Provider rejected native web search — continuing with the standard search tool.');
          if (notice) yield notice; }
        continue;
      } else {
        console.error(`[${tag}] error ${res.status}: ${errText.slice(0, 500)}`);
        yield usageTelemetry();
        yield { type: 'error', message: `${displayName} error ${res.status}: ${errText}` };
        return;
      }
    }

    let textContent  = '';
    const generatedImages = [];
    const imageGenerationItemStatus = new Map();
    const recordGeneratedImage = (item, fallbackKey = 'unkeyed-image-generation') => {
      const key = String(item?.id ?? item?.call_id ?? fallbackKey).slice(0, 300);
      if (imageGenerationItemStatus.get(key) === 'valid') return null;
      const image = saveImageGenerationResult(userId, item);
      if (!image) {
        imageGenerationItemStatus.set(key, 'invalid');
        return null;
      }
      imageGenerationItemStatus.set(key, 'valid');
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
    // call_id → { id (same as call_id), name, argsJson, done }
    const toolCalls  = new Map();
    // output_index → call_id so *.delta events (keyed by output_index) route correctly
    const indexToCallId = new Map();
    let tokenCount   = 0;
    const startedAt  = Date.now();
    let firstTokenAt = null;
    let finalized    = false;
    let loopCompletionCount = 0;
    let loopUsageCount = 0;
    let loopUsageValuesValid = true;
    let loopOutputBudgetValid = true;
    // A completed response is authoritative only when it is the final parsed
    // provider event for this request. The direct ChatGPT Codex endpoint closes
    // cleanly after response.completed; other Responses providers must also
    // send the standard [DONE] sentinel.
    let loopTerminalWasLast = true;
    let loopSseDoneCount = 0;

    const seenEventTypes = new Set();
    for await (const ev of readAnthropicSSE(res.body, { strict: labCodexRelay })) {
      if (ev.__sseDone === true) {
        loopSseDoneCount++;
        continue;
      }
      const t = ev.type;
      if (finalized) loopTerminalWasLast = false;
      if (t && !seenEventTypes.has(t)) {
        seenEventTypes.add(t);
        if (!/^response\.(output_text\.(delta|done|annotation\.added)|output_item\.(added|done)|function_call_arguments\.(delta|done)|created|in_progress|completed|incomplete|failed|content_part\.(added|done)|web_search_call\.(in_progress|searching|completed)|image_generation_call\.(in_progress|generating|partial_image|completed)|reasoning_summary_part\.(added|done)|reasoning_summary_text\.(delta|done))$/.test(t)) {
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
          toolCalls.set(callId, {
            id: callId,
            name: item.name ?? '',
            argsJson: typeof item.arguments === 'string' ? item.arguments : '',
            done: false,
          });
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
            entry.done = true;
          } else {
            toolCalls.set(callId, {
              id: callId,
              name: item.name ?? '',
              argsJson: typeof item.arguments === 'string' ? item.arguments : '',
              done: true,
            });
          }
        }
        if (item.type === 'image_generation_call') {
          const image = recordGeneratedImage(item, `output-item:${ev.output_index ?? 'unknown'}`);
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
        completionCount++;
        loopCompletionCount++;
        for (const [outputIndex, item] of (ev.response?.output ?? []).entries()) {
          if (item?.type === 'image_generation_call') {
            const image = recordGeneratedImage(item, `response-output:${outputIndex}`);
            if (image) yield { type: 'image', ...image, prompt: '' };
          }
        }
        const usage = ev.response?.usage;
        if (usage && typeof usage === 'object') {
          usageCount++;
          loopUsageCount++;
          const validUsage = Number.isSafeInteger(usage.input_tokens) && usage.input_tokens > 0
            && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens > 0;
          if (validUsage) {
            if (process.env.OPENENSEMBLE_LAB === '1'
                && usage.output_tokens > LAB_MAX_OBSERVED_OUTPUT_TOKENS_PER_RESPONSE) {
              loopOutputBudgetValid = false;
            }
            const nextInputTokens = totalInputTokens + usage.input_tokens;
            const nextOutputTokens = totalOutputTokens + usage.output_tokens;
            if (Number.isSafeInteger(nextInputTokens) && Number.isSafeInteger(nextOutputTokens)) {
              totalInputTokens = nextInputTokens;
              totalOutputTokens = nextOutputTokens;
            } else {
              loopUsageValuesValid = false;
            }
          } else {
            loopUsageValuesValid = false;
          }
          // Responses API spells this `input_tokens_details.cached_tokens`
          // (vs Chat Completions' `prompt_tokens_details.cached_tokens`).
          const cached = usage.input_tokens_details?.cached_tokens;
          if (validUsage && cached != null) {
            if (Number.isSafeInteger(cached) && cached >= 0) {
              const nextCachedTokens = totalCachedTokens + cached;
              if (Number.isSafeInteger(nextCachedTokens)) totalCachedTokens = nextCachedTokens;
              else loopUsageValuesValid = false;
            } else {
              loopUsageValuesValid = false;
            }
          }
        }
        finalized = true;
        continue;
      }
      if (t === 'response.incomplete' || t === 'response.failed' || t === 'error') {
        const reason = ev.response?.incomplete_details?.reason;
        const msg = ev.response?.error?.message ?? ev.error?.message
          ?? (reason ? `response incomplete (${reason})` : 'response incomplete or failed');
        usageCardinalityValid = false;
        if (textContent.trim()) yield { type: 'replace', text: '' };
        yield usageTelemetry();
        yield { type: 'error', message: `${displayName}: ${msg}` };
        return;
      }
    }

    // Validate THIS request before executing tools or accepting final text.
    // Aggregate equality cannot prove per-request integrity: a duplicate in one
    // round and an omission in another could otherwise cancel out. ChatGPT's
    // direct Codex endpoint legitimately closes at clean EOF after its single
    // response.completed event; every other Responses provider must terminate
    // with exactly one [DONE] sentinel.
    const validStreamTerminator = loopSseDoneCount === 1
      || (isCodex && loopSseDoneCount === 0);
    const validTerminal = finalized
      && loopCompletionCount === 1
      && loopUsageCount === 1
      && loopUsageValuesValid
      && loopTerminalWasLast
      && validStreamTerminator;
    if (!validTerminal) {
      usageCardinalityValid = false;
      if (textContent.trim()) yield { type: 'replace', text: '' };
      yield usageTelemetry();
      yield { type: 'error', message: `${displayName}: incomplete or invalid response stream.` };
      return;
    }
    // The ChatGPT Codex subscription backend does not support a request-side
    // max_output_tokens field. Reject over-budget terminal usage before any
    // completed function call can be emitted or executed, and clear transient
    // text before it can become a retained final answer.
    if (!loopOutputBudgetValid) {
      if (textContent.trim()) yield { type: 'replace', text: '' };
      yield usageTelemetry();
      yield { type: 'error', message: `${displayName}: response exceeded the lab output-token acceptance cap.` };
      return;
    }
    if ([...imageGenerationItemStatus.values()].some(status => status === 'invalid')) {
      yield usageTelemetry();
      yield {
        type: 'error',
        message: `${displayName}: hosted image generation completed without a valid bounded image artifact.`,
      };
      return;
    }

    if (toolCalls.size > 0) {
      awaitingPostToolAnswer = true;
      if (textContent.trim()) yield { type: 'replace', text: '' };

      // Never turn truncated or malformed arguments into an empty object. A
      // completed stream is necessary but not sufficient: every call must
      // have a stable identity, name, and JSON-object body before any sibling
      // from the batch is emitted or executed.
      let blocks;
      try {
        blocks = [...toolCalls.values()].map(block => {
          if (block.done !== true
              || typeof block.id !== 'string' || !block.id.trim()
              || typeof block.name !== 'string' || !block.name.trim()
              || typeof block.argsJson !== 'string' || !block.argsJson.trim()) {
            throw new Error('tool call did not finish with a complete identity, name, and arguments');
          }
          const toolArgs = JSON.parse(block.argsJson);
          if (toolArgs === null || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
            throw new Error('tool arguments must be a JSON object');
          }
          return { block, toolArgs };
        });
      } catch (error) {
        usageCardinalityValid = false;
        console.warn(`[${tag}] Refusing malformed provider tool call: ${error.message}`);
        yield usageTelemetry();
        yield { type: 'error', message: `${displayName}: received an invalid tool call; no tools were executed.` };
        return;
      }

      if (blocks.length > 1) {
        // Multiple tool calls in one assistant turn — run in parallel.
        // All tools run via executeToolStreaming (blocking per-tool, full
        // result returned). Promise.all gives us concurrency. For ask_agent,
        // the coordinator waits for specialist responses before synthesizing.
        // Events are buffered per-tool and replayed in order after all complete.
        for (const { block, toolArgs } of blocks) {
          yield { type: 'tool_call', name: block.name, args: toolArgs, toolCallId: block.id };
        }
        const results = await Promise.all(blocks.map(async ({ block, toolArgs }) => {
          const { text, _notify, _images, events } = await drainToolWithEvents(block.name, toolArgs, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean));
          return { block, toolArgs, result: text, _notify, _images, events };
        }));
        const assistantToolCalls = results.map(({ block }) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.argsJson } }));
        working.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
        for (const { block, result, _notify, events } of results) {
          for (const ev of events) yield ev;
          yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result), toolCallId: block.id };
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
          if (sc.stalled) { console.warn(`[openai-oauth] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; awaitingPostToolAnswer = false; yield { type: 'token', text: assistantContent }; break; } }
        continue;
      }

      const assistantToolCalls = blocks.map(({ block }) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.argsJson } }));
      working.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
      const seqResults = [];
      const _imagesByBlockId = new Map();
      // Terminal handoff: a tool (ask_agent's forward pipeline) may signal that
      // its result IS the user-facing answer and the model should NOT run
      // another turn to relay it. We capture that reply, append the normal tool
      // result for transcript fidelity, then deliver it as assistantContent and
      // break the loop instead of re-inferring.
      let _terminalReply = null;
      for (const { block, toolArgs: args } of blocks) {
        yield { type: 'tool_call', name: block.name, args, toolCallId: block.id };
        let toolResultText = '';
        let _seqImages = null;
        for await (const chunk of executeToolStreaming(block.name, args, userId, agent.id, agent.tools?.map(t => t.function?.name).filter(Boolean))) {
          if (chunk.type === 'token')              toolResultText += chunk.text;
          if (chunk.type === 'permission_request') yield chunk;
          if (chunk.type === '__hide_turn')         yield { type: '__hide_turn', reason: chunk.reason, taskId: chunk.taskId };
          if (chunk.type === 'tool_call')          yield { type: 'tool_call', name: chunk.name, args: chunk.args, ...(chunk.toolCallId ? { toolCallId: chunk.toolCallId } : {}) };
          if (chunk.type === 'tool_progress')      yield { type: 'tool_progress', name: chunk.name, text: chunk.text };
          if (chunk.type === 'tool_result')        yield { type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text), ...(chunk.toolCallId ? { toolCallId: chunk.toolCallId } : {}) };
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
        yield { type: 'tool_result', name: block.name, text: result, preview: summarizeToolResult(block.name, result), toolCallId: block.id };
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
        if (sc.stalled) { console.warn(`[openai-oauth] stall: ${sc.reason}`); assistantContent = `Stopped: ${sc.reason}.`; awaitingPostToolAnswer = false; yield { type: 'token', text: assistantContent }; break; } }
      if (_terminalReply != null) {
        // The pipeline reported its own final answer — deliver it as this
        // turn's reply and end the loop without another model call.
        assistantContent = _terminalReply;
        awaitingPostToolAnswer = false;
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
    awaitingPostToolAnswer = false;
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
  } catch (e) {
    // Abort/read/tool exceptions are still observable usage outcomes. Emit
    // counters before preserving the original exception semantics.
    usageCardinalityValid = false;
    yield usageTelemetry();
    throw e;
  }

  if (awaitingPostToolAnswer) {
    yield usageTelemetry();
    yield {
      type: 'error',
      message: `${displayName}: tool-loop request budget ended before a final answer was produced.`,
    };
    return;
  }

  yield { type: '__content', content: assistantContent };
  // Always emit on normal exit, including explicit zero/incomplete evidence.
  yield usageTelemetry();
  if (totalInputTokens) {
    const hitRate = totalCachedTokens / totalInputTokens;
    const tierMode = agent._promptTiersAssembled ? 'tiered' : 'flat';
    console.log(`[${tag}] cache: mode=${tierMode} cached=${totalCachedTokens} input=${totalInputTokens} hit=${(hitRate*100).toFixed(0)}%`);
  }
}
