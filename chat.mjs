/**
 * Core chat loop for OpenEnsemble.
 *
 * This file is a public facade — provider streaming logic lives in chat/:
 *   chat/preview.mjs                — tool-result previews, drainToolResult
 *   chat/compress.mjs               — LoopGuard + context compression
 *   chat/providers/_shared.mjs      — URLs, API keys, SSE/NDJSON readers, strip helpers
 *   chat/providers/anthropic.mjs    — streamAnthropic (with prompt caching)
 *   chat/providers/lmstudio.mjs     — streamLMStudio + streamLMStudioCompat
 *   chat/providers/openrouter.mjs   — streamOpenRouter
 *   chat/providers/openai-compat.mjs    — streamOpenAICompat (OpenAI/DeepSeek/Groq/etc.)
 *   chat/providers/openai-responses.mjs — streamOpenAIResponses (ChatGPT OAuth)
 *   chat/providers/ollama.mjs       — streamOllama
 *
 * streamChat is the top-level dispatcher: it builds memory context, handles
 * Grok/Fireworks image/video branches, picks the right provider stream, and
 * persists the session + runs memory signals.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { buildAgentContext, formatContext, addToSessionBuffer, processSignals } from './memory.mjs';
import { loadSession, appendToSession, loadCrossAgentContext } from './sessions.mjs';
import { BASE_DIR } from './lib/paths.mjs';
import { log } from './logger.mjs';

import {
  OPENAI_COMPAT_PROVIDERS, FIREWORKS_BASE,
  getGrokKey, getFireworksKey,
} from './chat/providers/_shared.mjs';
import { streamAnthropic }        from './chat/providers/anthropic.mjs';
import { streamLMStudio }         from './chat/providers/lmstudio.mjs';
import { streamOpenRouter }       from './chat/providers/openrouter.mjs';
import { streamOpenAICompat }     from './chat/providers/openai-compat.mjs';
import { streamOpenAIResponses }  from './chat/providers/openai-responses.mjs';
import { streamOllama }           from './chat/providers/ollama.mjs';

// Re-export for external consumers (e.g. routes/agents.mjs)
export { OPENAI_COMPAT_PROVIDERS };

// ── Session persistence + memory signal dispatch ─────────────────────────────
// Shared across every provider branch. `withSignalWordsGate` matches the
// Anthropic-only gate that skips signal detection on orchestrator agents
// unless the message actually contains preference/correction wording.
const SIGNAL_WORDS_RE = /prefer|like|love|hate|want|don'?t like|remember|decided|will use|choose|chose|my name|i am|i'm|my \w+ is|call me|always|never|make sure|correction/i;

function persist(agent, sessionText, assistantContent, userId, emit, skipSignals, skipEpisodes, { withSignalWordsGate = false } = {}) {
  appendToSession(agent.id,
    { role: 'user', content: sessionText, ts: Date.now() },
    { role: 'assistant', content: assistantContent, ts: Date.now() });

  if (skipSignals) return;

  if (!skipEpisodes) {
    addToSessionBuffer(agent.id, 'user', sessionText, userId);
    addToSessionBuffer(agent.id, 'assistant', assistantContent, userId);
  }
  const runSignals = withSignalWordsGate
    ? (!skipEpisodes || SIGNAL_WORDS_RE.test(sessionText))
    : true;
  if (runSignals) {
    processSignals({ agentId: agent.id, userMessage: sessionText, agentLastResponse: assistantContent, userId })
      .then(r => {
        if (!emit) return;
        if (r.forgot) emit({ type: 'memory_forgotten' });
        else if (r.remembered) emit({ type: 'memory_stored', fact: r.factText });
        else if (r.correction || r.preference) emit({ type: 'memory_stored' });
      })
      .catch(e => console.warn('[cortex] Signal processing failed:', e.message));
  }
}

// Consume a provider stream: forward every event except __content (captured), and
// bail out on error. Returns the final assistantContent string (or '' on error/empty).
async function* consumeProvider(providerGen) {
  let assistantContent = '';
  let errored = false;
  for await (const event of providerGen) {
    if (event.type === '__content') { assistantContent = event.content; continue; }
    yield event;
    if (event.type === 'error') { errored = true; break; }
  }
  return errored ? { assistantContent: '', errored: true } : { assistantContent, errored: false };
}

// ── Main chat generator ───────────────────────────────────────────────────────
export async function* streamChat(agent, userText, signal, emit, userId = 'default', attachment = null, systemNote = null) {
  // Finance/email agents handle transactions and actions — skip memory signal processing.
  // Ephemeral agents (deep_research_parallel workers) are stateless one-shots — skip all memory ops.
  // Scheduler intercepts: when chat-dispatch.mjs's interceptScheduling fired and
  // produced a scheduler_result note, the user's turn was a scheduling request —
  // the scheduler DB owns that state, so don't duplicate it as a memory. Users
  // who want a behavior preference captured can state it in a separate turn.
  const schedulerFired = (systemNote ?? '').includes('<scheduler_result>');
  const skipSignals = schedulerFired || agent.ephemeral || agent.skillCategory === 'finance' || agent.skillCategory === 'expenses' || agent.skillCategory === 'email';
  // General/manager agents: skip episode storage (task requests aren't useful memories)
  // but still run processSignals to capture genuine preferences/corrections
  const skipEpisodes = schedulerFired || agent.ephemeral || agent.skillCategory === 'general';
  // 1. Build rich cortex context (relevant memories, preferences, past episodes)
  // Expand deictic/pronominal queries ("tell me more about that") with recent context
  const NEEDS_CONTEXT_RE = /\b(that|this|it|those|these|there|the same|more about|what we|what you|yesterday|earlier|last time|before|again|continue|go on)\b/i;
  let recallQuery = userText;
  if (userText.length < 50 || NEEDS_CONTEXT_RE.test(userText)) {
    const recentMsgs = loadSession(agent.id, 4);
    if (recentMsgs.length) {
      const lastUser = recentMsgs.filter(m => m.role === 'user').slice(-1)[0];
      const lastAsst = recentMsgs.filter(m => m.role === 'assistant').slice(-1)[0];
      const ctx_parts = [lastUser?.content?.slice(0, 150), lastAsst?.content?.slice(0, 150)].filter(Boolean);
      if (ctx_parts.length) recallQuery = `${userText} [context: ${ctx_parts.join(' ')}]`;
    }
  }
  // Ephemeral agents (deep_research_parallel workers, etc.) skip cortex loads
  // — they're pure stateless one-shots and shouldn't read the user's memory.
  const ctx = agent.ephemeral
    ? null
    : await buildAgentContext(agent.id, recallQuery, userId).catch(() => null);
  const memBlock = ctx ? formatContext(ctx) : '';

  // Inject current name so renaming takes effect in the LLM's self-awareness.
  // Anthropic models are trained to always identify as Claude — skip for them.
  const nameHeader = agent.provider !== 'anthropic'
    ? `Your name is ${agent.name}. You are ${agent.name}. Always refer to yourself as ${agent.name}, never by any other name.\n\n`
    : '';
  const basePrompt = `${nameHeader}${agent.systemPrompt}`;
  const userIdBlock = (agent.skillCategory === 'finance' || agent.skillCategory === 'expenses') && userId && userId !== 'default'
    ? `\n\nCurrent user ID: ${userId}` : '';
  let userEmailBlock = '';
  if (agent.skillCategory === 'email' && userId && userId !== 'default') {
    try {
      const userPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'users', userId, 'profile.json');
      if (existsSync(userPath)) {
        const user = JSON.parse(readFileSync(userPath, 'utf8'));
        if (user?.email) userEmailBlock = `\n\nUser's email address: ${user.email}`;
      }
    } catch { /* ignore */ }
  }
  // 1b. Cross-agent context — let this agent see recent messages from other agents.
  // Skip for ephemeral agents: "ephemeral" means a hermetic run with no carried-over
  // context, and crossAgentRead would silently leak another agent's history.
  let crossAgentBlock = '';
  if (!agent.ephemeral && agent.crossAgentRead?.length && userId && userId !== 'default') {
    const parts = [];
    for (const otherId of agent.crossAgentRead) {
      const recent = loadCrossAgentContext(userId, otherId, 3);
      // Filter to only user/assistant messages (skip notifications, system)
      const useful = recent.filter(m => m.role === 'user' || m.role === 'assistant');
      if (useful.length) {
        const lines = useful.map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n');
        parts.push(`### ${otherId}\n${lines}`);
      }
    }
    if (parts.length) crossAgentBlock = `\n\n## Recent activity from other agents\n${parts.join('\n\n')}`;
  }

  // systemNote: one-shot directive from the dispatcher (e.g. scheduler-intent
  // outcome). Goes into the system prompt — not userText — so the UI doesn't
  // render it and the session doesn't persist it into history.
  const noteBlock = systemNote ? `\n\n${systemNote}` : '';
  const systemPrompt = memBlock
    ? `${basePrompt}${userIdBlock}${userEmailBlock}\n\n${memBlock}${crossAgentBlock}${noteBlock}`
    : `${basePrompt}${userIdBlock}${userEmailBlock}${crossAgentBlock}${noteBlock}`;

  // 2. Build message history (strip ts field — Ollama doesn't want it)
  const history = loadSession(agent.id).map(({ role, content, name }) =>
    name ? { role, content, name } : { role, content }
  );

  // For session storage, store text only (no base64 — too large and not replayable)
  const sessionText = attachment ? `[Attached: ${attachment.name}]\n${userText}`.trim() : userText;

  // Working copy for the tool loop (no ts fields).
  // Trim history if it gets too long — rough token estimate: 1 token ≈ 4 chars.
  // Budget = 55% of the agent's context window minus tool schema overhead,
  // leaving the rest for system prompt, current turn, tools, and model response.
  const ctxWindow  = agent.contextSize ?? 32768;
  const toolTokens = Math.ceil((agent.tools?.length ?? 0) * 60); // ~60 tok/tool compressed
  const TOKEN_BUDGET = Math.max(1000, Math.floor(ctxWindow * 0.55) - toolTokens);
  let trimmed = [...history];
  let approxTokens = (systemPrompt.length + userText.length) / 4;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    approxTokens += (trimmed[i].content?.length ?? 0) / 4;
    if (approxTokens > TOKEN_BUDGET) { trimmed = trimmed.slice(i + 1); break; }
  }

  // Build the current user turn — include image data if attachment present
  let currentUserTurn;
  if (attachment?.base64) {
    if (agent.provider === 'anthropic') {
      currentUserTurn = { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: attachment.base64 } },
        { type: 'text', text: userText || 'What is in this image?' },
      ]};
    } else if (agent.provider === 'ollama') {
      currentUserTurn = { role: 'user', content: userText || 'What is in this image?', images: [attachment.base64] };
    } else if (OPENAI_COMPAT_PROVIDERS[agent.provider === 'grok' ? 'xai' : agent.provider] || agent.provider === 'openrouter' || agent.provider === 'openai-oauth') {
      // OpenAI vision schema: image_url with base64 data URL.
      // For openai-oauth (Responses API), toResponsesInput() translates this
      // shape into { type: 'input_image', image_url: '...' } parts.
      currentUserTurn = { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${attachment.base64}` } },
        { type: 'text', text: userText || 'What is in this image?' },
      ]};
    } else {
      // LM Studio / other: fall back to text description
      currentUserTurn = { role: 'user', content: userText };
    }
  } else {
    currentUserTurn = { role: 'user', content: userText };
  }

  const working = [...trimmed, currentUserTurn];

  // ── Grok video/image generation branch ──────────────────────────────────────
  // Only routes to the media endpoints if the model name indicates image/video
  // generation. Chat models (grok-4, grok-3, etc.) fall through to the generic
  // OpenAI-compat dispatcher under the 'xai' provider alias below.
  const grokModelLower = (agent.model ?? '').toLowerCase();
  const isGrokMedia = agent.provider === 'grok' && (grokModelLower.includes('image') || grokModelLower.includes('video') || grokModelLower.includes('imagine'));
  if (isGrokMedia) {
    const key = getGrokKey();
    if (!key) { yield { type: 'error', message: 'Grok API key not configured. Add it in Settings → Providers.' }; return; }

    // ── Video generation ───────────────────────────────────────────────────
    if (agent.model?.toLowerCase().includes('video')) {
      const model  = agent.model;
      const prompt = userText || 'A beautiful scene';

      yield { type: 'token', text: 'Generating video…' };

      const initRes = await fetch('https://api.x.ai/v1/videos/generations', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ model, prompt }),
      });
      if (!initRes.ok) { yield { type: 'error', message: `Grok error ${initRes.status}: ${await initRes.text()}` }; return; }
      const initData = await initRes.json();
      console.log('[grok-video] init response:', JSON.stringify(initData));
      const request_id = initData.id ?? initData.request_id;
      if (!request_id) { yield { type: 'error', message: `Grok returned no request ID. Response: ${JSON.stringify(initData)}` }; return; }

      // Poll until done (up to 10 minutes), reporting progress
      let videoUrl = null;
      let lastProgress = -1;
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 5000));
        const pollRes = await fetch(`https://api.x.ai/v1/videos/${request_id}`, {
          headers: { 'Authorization': `Bearer ${key}` },
          signal,
        });
        if (!pollRes.ok) {
          const errText = await pollRes.text();
          console.log('[grok-video] poll error:', pollRes.status, errText);
          yield { type: 'error', message: `Grok poll error ${pollRes.status}: ${errText}` }; return;
        }
        const pollData = await pollRes.json();
        if (pollData.error) { yield { type: 'error', message: `Video generation failed: ${pollData.error.message}` }; return; }
        if (pollData.progress != null && pollData.progress !== lastProgress) {
          yield { type: 'replace', text: `Generating video… ${pollData.progress}%` };
          lastProgress = pollData.progress;
        }
        if (pollData.status === 'done') {
          videoUrl = pollData.video?.url ?? null;
          if (!videoUrl) { yield { type: 'error', message: 'Video generation blocked by moderation.' }; return; }
          break;
        }
      }
      if (!videoUrl) { yield { type: 'error', message: 'Video generation timed out.' }; return; }

      const slug = prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');
      const filename = `${slug || 'video'}_${Date.now()}.mp4`;

      const videoSaveDir = agent.outputDir || path.join(BASE_DIR, 'users', userId, 'videos');
      let savedPath = null;
      try {
        mkdirSync(videoSaveDir, { recursive: true });
        const vidRes = await fetch(videoUrl, { signal });
        writeFileSync(path.join(videoSaveDir, filename), Buffer.from(await vidRes.arrayBuffer()));
        savedPath = path.join(videoSaveDir, filename);
      } catch (e) {
        console.warn('[grok-video] Failed to save video:', e.message);
      }

      appendToSession(agent.id,
        { role: 'user', content: userText, ts: Date.now() },
        { role: 'assistant', video: { url: videoUrl, filename }, content: `[Video: ${filename}]${savedPath ? `\nSaved to: ${savedPath}` : ''}`, ts: Date.now() }
      );
      yield { type: 'video', url: videoUrl, filename, savedPath, prompt };
      yield { type: 'done' };
      return;
    }

    // ── Image generation ───────────────────────────────────────────────────
    const model  = agent.model ?? 'grok-imagine-image';
    const prompt = userText || 'A beautiful image';

    const r = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model, prompt, n: 1, response_format: 'b64_json' }),
    });
    if (!r.ok) { yield { type: 'error', message: `Grok error ${r.status}: ${await r.text()}` }; return; }
    const data = await r.json();
    let base64 = data.data?.[0]?.b64_json;
    if (!base64) { yield { type: 'error', message: 'Grok returned no image data.' }; return; }
    if (base64.includes(',')) base64 = base64.split(',')[1];
    const mimeType = 'image/jpeg';

    const slug = prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');
    const filename = `${slug || 'image'}_${Date.now()}.jpg`;

    const grokImgDir = agent.outputDir || path.join(BASE_DIR, 'users', userId, 'images');
    let savedPath = null;
    try {
      mkdirSync(grokImgDir, { recursive: true });
      writeFileSync(path.join(grokImgDir, filename), Buffer.from(base64, 'base64'));
      savedPath = path.join(grokImgDir, filename);
    } catch (e) {
      console.warn('[grok] Failed to save image:', e.message);
    }

    appendToSession(agent.id,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', image: { base64, mimeType, filename }, content: `[Image: ${filename}]${savedPath ? `\nSaved to: ${savedPath}` : ''}`, ts: Date.now() }
    );
    yield { type: 'image', base64, mimeType, prompt, filename, savedPath };
    yield { type: 'done' };
    return;
  }

  // ── Fireworks image generation branch ───────────────────────────────────────
  if (agent.provider === 'fireworks') {
    const key = getFireworksKey();
    if (!key) { yield { type: 'error', message: 'Fireworks API key not configured. Add it in Settings → Providers.' }; return; }

    const model  = agent.model ?? 'flux-1-schnell-fp8';
    const prompt = userText || 'A beautiful image';
    const isFlux  = model.startsWith('flux');
    const isAsync = model.includes('kontext');
    let base64, mimeType = 'image/jpeg';

    if (!isFlux) {
      // SD/Playground/Segmind: /inference/v1/image_generation/... returns binary image directly
      const url = `https://api.fireworks.ai/inference/v1/image_generation/accounts/fireworks/models/${model}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'image/jpeg' },
        signal,
        body: JSON.stringify({ prompt, num_inference_steps: 30, guidance_scale: 7, width: 1024, height: 1024 }),
      });
      if (!r.ok) { yield { type: 'error', message: `Fireworks error ${r.status}: ${await r.text()}` }; return; }
      mimeType = r.headers.get('content-type') ?? 'image/jpeg';
      const buf = await r.arrayBuffer();
      base64 = Buffer.from(buf).toString('base64');
    } else if (!isAsync) {
      // Synchronous Flux: flux-1-schnell-fp8, flux-1-dev-fp8
      mimeType = 'image/png';
      const r = await fetch(`${FIREWORKS_BASE}/${model}/text_to_image`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        signal,
        body: JSON.stringify({ prompt, aspect_ratio: agent.aspectRatio ?? '1:1' }),
      });
      if (!r.ok) { yield { type: 'error', message: `Fireworks error ${r.status}: ${await r.text()}` }; return; }
      const data = await r.json();
      base64 = Array.isArray(data.base64) ? data.base64[0] : data.base64;
      if (!base64) { yield { type: 'error', message: 'Fireworks returned no image data.' }; return; }
    } else {
      // Async: flux-kontext-pro / flux-kontext-max
      const body = { prompt };
      if (attachment?.base64) body.input_image = `data:${attachment.mimeType};base64,${attachment.base64}`;
      const r = await fetch(`${FIREWORKS_BASE}/${model}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(body),
      });
      if (!r.ok) { yield { type: 'error', message: `Fireworks error ${r.status}: ${await r.text()}` }; return; }
      const { request_id } = await r.json();
      if (!request_id) { yield { type: 'error', message: 'Fireworks did not return a request ID.' }; return; }

      // Poll get_result until ready (max ~5 min, 3s interval)
      // "Task not found" is normal while the job queues — keep retrying for the full duration
      const pollUrl = `${FIREWORKS_BASE}/${model}/get_result`;
      let result = null;
      for (let i = 0; i < 100; i++) {
        await new Promise(res => setTimeout(res, 3000));
        if (signal?.aborted) return;
        const pr = await fetch(pollUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: request_id }),
        });
        const st = await pr.json();
        console.log(`[fireworks] poll ${i + 1}: status=${st.status ?? JSON.stringify(st).slice(0, 80)}`);
        if (st.status === 'Ready') { result = st.result; break; }
        if (st.status === 'Task not found') continue; // still queuing
        if (['Error', 'Request Moderated', 'Content Moderated'].includes(st.status)) {
          yield { type: 'error', message: `Fireworks: ${st.status}` }; return;
        }
      }
      if (!result) { yield { type: 'error', message: 'Fireworks image generation timed out after 5 minutes.' }; return; }

      // result may be a URL string, base64 string, { base64: [...] }, or Kontext-style { sample: url, ... }
      const sampleUrl = result?.sample ?? (typeof result === 'string' && result.startsWith('http') ? result : null);
      if (sampleUrl) {
        const imgRes = await fetch(sampleUrl);
        if (!imgRes.ok) { yield { type: 'error', message: `Fireworks: failed to fetch image (${imgRes.status})` }; return; }
        const buf = await imgRes.arrayBuffer();
        base64 = Buffer.from(buf).toString('base64');
        mimeType = imgRes.headers.get('content-type') ?? 'image/jpeg';
      } else if (typeof result === 'string') {
        base64 = result.includes(',') ? result.split(',')[1] : result;
      } else {
        base64 = Array.isArray(result?.base64) ? result.base64[0] : result?.base64;
        if (!base64) { yield { type: 'error', message: 'Fireworks: unexpected result format — no image URL or base64 found.' }; return; }
      }
    }

    // Strip any data-URL prefix that may have leaked through
    if (typeof base64 === 'string' && base64.includes(',')) base64 = base64.split(',')[1];

    const slug = prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');
    const filename = `${slug || 'image'}_${Date.now()}.png`;

    const fwImgDir = agent.outputDir || path.join(BASE_DIR, 'users', userId, 'images');
    let savedPath = null;
    try {
      mkdirSync(fwImgDir, { recursive: true });
      writeFileSync(path.join(fwImgDir, filename), Buffer.from(base64, 'base64'));
      savedPath = path.join(fwImgDir, filename);
    } catch (e) {
      console.warn('[fireworks] Failed to save image:', e.message);
    }

    appendToSession(agent.id,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', image: { base64, mimeType, filename }, content: `[Image: ${filename}]${savedPath ? `\nSaved to: ${savedPath}` : ''}`, ts: Date.now() }
    );
    yield { type: 'image', base64, mimeType, prompt, filename, savedPath };
    yield { type: 'done' };
    return;
  }

  // ── Chat-provider dispatch ──────────────────────────────────────────────────
  // Each branch forwards events via consumeProvider, captures __content, then
  // persists + runs memory signals through persist().
  const compatProviderKey = agent.provider === 'grok' ? 'xai' : agent.provider;

  let providerGen;
  let withSignalWordsGate = false;
  if (agent.provider === 'anthropic') {
    providerGen = streamAnthropic(agent, systemPrompt, working, signal, userId);
    withSignalWordsGate = true;
  } else if (agent.provider === 'openrouter') {
    providerGen = streamOpenRouter(agent, systemPrompt, working, signal, userId);
  } else if (agent.provider === 'openai-oauth') {
    providerGen = streamOpenAIResponses(agent, systemPrompt, working, signal, userId);
  } else if (OPENAI_COMPAT_PROVIDERS[compatProviderKey]) {
    providerGen = streamOpenAICompat(compatProviderKey, agent, systemPrompt, working, signal, userId);
  } else if (agent.provider === 'lmstudio') {
    // LM Studio's native path takes `userText` (string), not full message history
    providerGen = streamLMStudio(agent, systemPrompt, userText, agent.id, signal, userId);
  } else {
    // Default: Ollama
    providerGen = streamOllama(agent, systemPrompt, working, signal, userId);
  }

  const _llmStart = Date.now();
  const { assistantContent, errored } = yield* consumeProvider(providerGen);
  const _llmMeta = {
    userId,
    agentId: agent.id,
    provider: agent.provider,
    model: agent.model,
    durationMs: Date.now() - _llmStart,
    bytes: assistantContent ? (typeof assistantContent === 'string' ? assistantContent.length : JSON.stringify(assistantContent).length) : 0,
  };
  if (errored) {
    log.error('chat', 'llm turn errored', _llmMeta);
    return;
  }
  log.info('chat', 'llm turn complete', _llmMeta);
  if (assistantContent) {
    persist(agent, sessionText, assistantContent, userId, emit, skipSignals, skipEpisodes, { withSignalWordsGate });
  }
  yield { type: 'done' };
}
