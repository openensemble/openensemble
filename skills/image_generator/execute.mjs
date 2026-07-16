// @ts-check
/** Provider-independent, policy-scoped text-to-image generation. */

import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import { setTimeout as delay } from 'node:timers/promises';
import { getUserFilesDir, readConfig, USERS_DIR } from '../../lib/paths.mjs';
import { toolError } from '../../lib/tool-error.mjs';
import { getTurnSignal } from '../../lib/turn-abort-context.mjs';
import { fetchBrowserPublicResource } from '../../lib/browser-image.mjs';
import { FIREWORKS_BASE, getFireworksKey, getGrokKey } from '../../chat/providers/_shared.mjs';

const FIREWORKS_LEGACY_BASE = 'https://api.fireworks.ai/inference/v1/image_generation/accounts/fireworks/models';
const GROK_IMAGES_URL = 'https://api.x.ai/v1/images/generations';
const LAB_FLUX_BASE = 'http://127.0.0.1:9931/flux';
const LAB_LEGACY_BASE = 'http://127.0.0.1:9931/legacy';
const LAB_GROK_URL = 'http://127.0.0.1:9931/grok';

const FIREWORKS_MODELS = new Set([
  'flux-1-schnell-fp8',
  'flux-1-dev-fp8',
  'flux-kontext-pro',
  'flux-kontext-max',
  'stable-diffusion-xl-1024-v1-0',
  'playground-v2-1024px-aesthetic',
  'playground-v2-5-1024px-aesthetic',
  'SSD-1B',
  'japanese-stable-diffusion-xl',
]);
const GROK_MODELS = new Set(['grok-imagine-image', 'grok-imagine-image-quality']);
const ASPECT_RATIOS = new Set(['1:1', '21:9', '16:9', '3:2', '5:4', '4:5', '2:3', '9:16', '9:21', '4:3', '3:4']);
const MODEL_TIERS = new Map([
  ['flux-1-schnell-fp8', 'fast'],
  ['flux-1-dev-fp8', 'quality'],
  ['flux-kontext-pro', 'quality'],
  ['flux-kontext-max', 'quality'],
  ['stable-diffusion-xl-1024-v1-0', 'quality'],
  ['playground-v2-1024px-aesthetic', 'quality'],
  ['playground-v2-5-1024px-aesthetic', 'quality'],
  ['SSD-1B', 'quality'],
  ['japanese-stable-diffusion-xl', 'quality'],
  ['grok-imagine-image', 'fast'],
  ['grok-imagine-image-quality', 'quality'],
]);
const PUBLIC_ARGS = new Set(['prompt', 'quality', 'aspect_ratio', 'input_image_id']);

const REQUEST_TIMEOUT_MS = 120_000;
const KONTEXT_POLL_MS = process.env.NODE_ENV === 'test' ? 1 : 3_000;
const KONTEXT_DEADLINE_MS = process.env.NODE_ENV === 'test' ? 50 : 5 * 60_000;
const MAX_PROMPT_CHARS = 8_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 128;
const MAX_JSON_BYTES = MAX_BASE64_CHARS + 128 * 1024;
const MAX_ERROR_BYTES = 1_500;

export default function execute(toolName, args, userId, agentId, ctx) {
  if (toolName !== 'generate_image') return null;
  if (args?.__validate) return true;
  return generateImage(args ?? {}, userId, ctx);
}

async function* generateImage(args, userId, ctx) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    yield failure(ctx, 'generate_image arguments must be an object.');
    return;
  }
  const unknown = Object.keys(args).find(key => !PUBLIC_ARGS.has(key));
  if (unknown) {
    yield failure(ctx, `generate_image does not accept the argument "${unknown}".`);
    return;
  }
  if (typeof args.prompt !== 'string') {
    yield failure(ctx, 'generate_image prompt must be a string.');
    return;
  }
  const prompt = args.prompt.trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    yield failure(ctx, `generate_image requires a prompt between 1 and ${MAX_PROMPT_CHARS} characters.`);
    return;
  }
  if (args.quality != null && typeof args.quality !== 'string') {
    yield failure(ctx, 'generate_image quality must be either fast or quality.');
    return;
  }
  const requestedQuality = args.quality == null ? null : args.quality.trim().toLowerCase();
  if (requestedQuality != null && !['fast', 'quality'].includes(requestedQuality)) {
    yield failure(ctx, 'generate_image quality must be either fast or quality.');
    return;
  }
  if (args.aspect_ratio != null && typeof args.aspect_ratio !== 'string') {
    yield failure(ctx, 'generate_image aspect_ratio must be a supported ratio.');
    return;
  }
  const requestedAspectRatio = args.aspect_ratio == null ? null : args.aspect_ratio.trim();
  if (requestedAspectRatio != null && !ASPECT_RATIOS.has(requestedAspectRatio)) {
    yield failure(ctx, `generate_image aspect_ratio must be one of: ${[...ASPECT_RATIOS].join(', ')}.`);
    return;
  }
  if (args.input_image_id != null && typeof args.input_image_id !== 'string') {
    yield failure(ctx, 'generate_image input_image_id must be an images: attachment ID.');
    return;
  }

  let plan;
  try {
    plan = selectBackend(userId, requestedQuality);
  } catch (error) {
    yield failure(ctx, boundedMessage(error));
    return;
  }

  const aspectRatio = requestedAspectRatio ?? plan.aspectRatio;
  let inputImage = null;
  if (args.input_image_id != null) {
    if (!plan.model.includes('kontext')) {
      yield failure(ctx, 'The configured image model does not support image editing. Assign an approved Flux Kontext model first.');
      return;
    }
    try {
      inputImage = loadOwnedInputImage(userId, args.input_image_id);
    } catch (error) {
      yield failure(ctx, boundedMessage(error));
      return;
    }
  }

  yield { type: 'tool_progress', name: 'generate_image', text: inputImage ? 'Editing image…' : 'Generating image…' };
  let image;
  try {
    image = await (plan.provider === 'grok'
      ? grokGenerate(plan.model, prompt, aspectRatio)
      : fireworksGenerate(plan.model, prompt, aspectRatio, inputImage));
  } catch (error) {
    yield failure(ctx, boundedMessage(error));
    return;
  }

  const filename = `${slug(prompt)}_${Date.now()}.${image.extension}`;
  let savedPath = null;
  try {
    const diskPath = path.join(getUserFilesDir(userId, 'images'), filename);
    writeFileSync(diskPath, image.bytes, { mode: 0o600, flag: 'wx' });
    savedPath = `images:${filename}`;
  } catch (error) {
    console.warn('[image_generator] failed to save image:', error?.message);
    savedPath = null;
  }

  const base64 = image.bytes.toString('base64');
  const selectedQuality = MODEL_TIERS.get(plan.model) ?? 'configured';
  yield { type: 'image', base64, mimeType: image.mimeType, prompt, filename, savedPath };
  yield {
    type: 'result',
    text: `Image generated with the configured ${plan.provider} ${selectedQuality} tier and shown to the user.${savedPath
      ? ` Attachment ID: images:${filename}. Use this exact ID for attachment_doc_ids; do not search for the file.`
      : ' It could not be saved locally, so the inline copy was retained.'}`,
    // The generic slow-tool drain reads artifacts from the terminal result so
    // a background transition still persists and broadcasts this exact image.
    _images: [{ base64, mediaType: image.mimeType, mimeType: image.mimeType, filename, savedPath }],
  };
}

function failure(ctx, message) {
  const clean = String(message || 'Image generation failed.').slice(0, 1_200);
  return { type: 'result', text: ctx?.toolError ? ctx.toolError(clean) : toolError(clean) };
}

function boundedMessage(error) {
  const raw = String(error?.message || error || 'Image generation failed.');
  if (error?.name === 'AbortError' || /aborted|aborterror/i.test(raw)) return 'Image generation was cancelled or timed out.';
  return raw.slice(0, 1_200);
}

function slug(prompt) {
  return prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '') || 'image';
}

/** Resolve provider/model from server-owned configuration, never model input. */
function selectBackend(userId, requestedQuality = null) {
  const lab = process.env.OPENENSEMBLE_LAB === '1';
  const cfg = readConfig();
  const profile = readJson(path.join(USERS_DIR, String(userId || ''), 'profile.json')) ?? {};
  const assignments = profile.role === 'owner'
    ? (cfg.skillAssignments ?? {})
    : profile.role === 'admin'
      ? { ...(cfg.skillAssignments ?? {}), ...(profile.skillAssignments ?? {}) }
      : (profile.skillAssignments ?? cfg.skillAssignments ?? {});
  const assignedId = assignments.image_generator;
  const agents = readJson(path.join(USERS_DIR, String(userId || ''), 'agents.json')) ?? [];
  const baseAgent = Array.isArray(agents) ? agents.find(agent => agent?.id === assignedId) : null;
  const mergedPreferred = baseAgent
    ? { ...baseAgent, ...(cfg.agentModels?.[assignedId] ?? {}), ...(profile.agentOverrides?.[assignedId] ?? {}) }
    : null;
  const preferred = mergedPreferred
    ? { ...mergedPreferred, model: normalizeImageModel(mergedPreferred.model) }
    : null;
  const allowedModels = Array.isArray(profile.allowedModels)
    ? new Set(profile.allowedModels.filter(model => typeof model === 'string').map(normalizeImageModel))
    : null;
  const keys = { fireworks: getFireworksKey(), grok: getGrokKey() };
  if (lab && Object.values(keys).some(key => key && key !== 'lab-fake')) {
    throw new Error('The isolated lab refuses non-dummy image credentials.');
  }

  const configuredProvider = normalizeProvider(preferred?.provider);
  const configuredModelProvider = providerForModel(preferred?.model);
  // The primary's text provider is not automatically its image provider. A
  // valid raw image-skill assignment remains authoritative while specialists
  // are parked by single mode.
  const primaryProvider = configuredProvider && configuredProvider === configuredModelProvider
    ? configuredProvider
    : null;
  const configuredTier = MODEL_TIERS.get(preferred?.model) ?? null;
  const quality = requestedQuality ?? configuredTier ?? 'fast';
  const fallbackProvider = normalizeProvider(cfg.providerFailover?.fallbackProvider);
  const fallbackModel = normalizeImageModel(cfg.providerFailover?.fallbackModel);
  const providerOrder = [];
  const addProvider = provider => {
    if (provider && !providerOrder.includes(provider)) providerOrder.push(provider);
  };
  addProvider(primaryProvider);
  if (cfg.providerFailover?.enabled && providerForModel(fallbackModel) === fallbackProvider) {
    addProvider(fallbackProvider);
  }
  for (const model of allowedModels ?? []) addProvider(providerForModel(model));

  for (const provider of providerOrder) {
    if (!lab && cfg.enabledProviders?.[provider] === false) continue;
    if (!keys[provider]) continue;
    const models = [];
    const add = model => {
      if (providerForModel(model) === provider && MODEL_TIERS.get(model) === quality && !models.includes(model)) {
        models.push(model);
      }
    };
    if (provider === primaryProvider) add(preferred?.model);
    if (provider === fallbackProvider && cfg.providerFailover?.enabled) add(fallbackModel);
    // A public quality argument may select only the exact parked assignment,
    // an explicit server failover, or an administrator-approved allowedModels
    // entry. It never silently escalates to an unconfigured default model.
    for (const model of allowedModels ?? []) add(model);
    const selected = models.find(model => !allowedModels || allowedModels.has(model));
    if (selected) {
      const aspectRatio = ASPECT_RATIOS.has(preferred?.aspectRatio) ? preferred.aspectRatio : '1:1';
      return { provider, model: selected, aspectRatio };
    }
  }
  if (allowedModels) throw new Error(`No administrator-approved ${quality}-tier image model is available for this account.`);
  if (primaryProvider && requestedQuality && configuredTier !== requestedQuality) {
    throw new Error(`The configured image assignment is ${configuredTier}-tier; ${requestedQuality}-tier generation is not approved.`);
  }
  throw new Error('No enabled, explicitly configured image provider/model is available. Configure the Image Generator assignment in Settings.');
}

/**
 * Whether the server-owned image tool can satisfy at least one public tier.
 * The router uses this to avoid advertising a guaranteed-to-fail local
 * function when the active text model has a working hosted image tool.
 */
export function hasUsableConfiguredImageBackend(userId) {
  for (const quality of ['fast', 'quality']) {
    try {
      selectBackend(userId, quality);
      return true;
    } catch { /* try the other public tier */ }
  }
  return false;
}

function normalizeProvider(provider) {
  if (provider === 'xai') return 'grok';
  return provider === 'fireworks' || provider === 'grok' ? provider : null;
}

function providerForModel(model) {
  if (FIREWORKS_MODELS.has(model)) return 'fireworks';
  if (GROK_MODELS.has(model)) return 'grok';
  return null;
}

function normalizeImageModel(model) {
  return model === 'grok-imagine-image-pro' ? 'grok-imagine-image-quality' : model;
}

function readJson(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }
  catch { return null; }
}

function loadOwnedInputImage(userId, rawId) {
  const id = String(rawId || '').trim();
  if (!id.startsWith('images:') || id.length > 300) {
    throw new Error('Image edits require an owner-scoped attachment ID in the form images:filename.');
  }
  const filename = id.slice('images:'.length);
  if (!filename || filename.length > 255 || filename === '.' || filename === '..'
      || filename.includes('/') || filename.includes('\\') || filename.includes('\0')
      || path.basename(filename) !== filename) {
    throw new Error('The image attachment ID is invalid. Use an exact images: ID from this profile.');
  }
  const root = realpathSync(getUserFilesDir(userId, 'images'));
  const file = path.join(root, filename);
  let fd;
  try {
    const resolved = realpathSync(file);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error('The requested image attachment is outside this profile.');
    }
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`The input image must be a regular file no larger than ${MAX_IMAGE_BYTES} bytes.`);
    }
    const image = inspectImage(readFileSync(fd));
    return `data:${image.mimeType};base64,${image.bytes.toString('base64')}`;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
      throw new Error('The requested image attachment does not exist in this profile.');
    }
    throw error;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function requestSignal(timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const turn = getTurnSignal();
  return turn ? AbortSignal.any([turn, timeout]) : timeout;
}

function deadlineSignal(deadline) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error('Fireworks image generation timed out after 5 minutes.');
  return requestSignal(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining)));
}

async function waitForKontextPoll(deadline) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error('Fireworks image generation timed out after 5 minutes.');
  const turnSignal = getTurnSignal();
  await delay(
    Math.min(KONTEXT_POLL_MS, remaining),
    undefined,
    turnSignal ? { signal: turnSignal } : undefined,
  );
}

function fluxBase() {
  return process.env.OPENENSEMBLE_LAB === '1' ? LAB_FLUX_BASE : FIREWORKS_BASE;
}
function legacyBase() {
  return process.env.OPENENSEMBLE_LAB === '1' ? LAB_LEGACY_BASE : FIREWORKS_LEGACY_BASE;
}
function grokUrl() {
  return process.env.OPENENSEMBLE_LAB === '1' ? LAB_GROK_URL : GROK_IMAGES_URL;
}

async function fireworksGenerate(model, prompt, aspectRatio, inputImage = null) {
  if (!FIREWORKS_MODELS.has(model)) throw new Error('Configured Fireworks image model is not allowed.');
  const key = getFireworksKey();
  if (!key) throw new Error('Fireworks API key not configured. Add it in Settings → Providers.');

  const isFlux = model.startsWith('flux');
  const isAsync = model.includes('kontext');
  if (!isFlux) {
    const response = await fetch(`${legacyBase()}/${model}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'image/jpeg' },
      signal: requestSignal(),
      body: JSON.stringify({ prompt, num_inference_steps: 30, guidance_scale: 7, width: 1024, height: 1024 }),
    });
    if (!response.ok) throw new Error(`Fireworks error ${response.status}: ${await safeErrorText(response)}`);
    return inspectImage(await readResponseBytes(response, MAX_IMAGE_BYTES, 'Fireworks image'));
  }

  if (!isAsync) {
    const response = await fetch(`${fluxBase()}/${model}/text_to_image`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      signal: requestSignal(),
      body: JSON.stringify({ prompt, aspect_ratio: aspectRatio }),
    });
    if (!response.ok) throw new Error(`Fireworks error ${response.status}: ${await safeErrorText(response)}`);
    const data = await readResponseJson(response, MAX_JSON_BYTES, 'Fireworks response');
    const base64 = Array.isArray(data.base64) ? data.base64[0] : data.base64;
    if (!base64) throw new Error('Fireworks returned no image data.');
    return inspectBase64(base64);
  }

  const deadline = Date.now() + KONTEXT_DEADLINE_MS;
  const response = await fetch(`${fluxBase()}/${model}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: deadlineSignal(deadline),
    body: JSON.stringify({
      prompt,
      output_format: 'png',
      aspect_ratio: aspectRatio,
      ...(inputImage ? { input_image: inputImage } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Fireworks error ${response.status}: ${await safeErrorText(response)}`);
  const { request_id: requestId } = await readResponseJson(response, 256 * 1024, 'Fireworks submit response');
  if (!requestId) throw new Error('Fireworks did not return a request ID.');

  const pollUrl = `${fluxBase()}/${model}/get_result`;
  let result = null;
  while (Date.now() < deadline) {
    await waitForKontextPoll(deadline);
    const poll = await fetch(pollUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: deadlineSignal(deadline),
      body: JSON.stringify({ id: requestId }),
    });
    if (!poll.ok) throw new Error(`Fireworks poll error ${poll.status}: ${await safeErrorText(poll)}`);
    const state = await readResponseJson(poll, MAX_JSON_BYTES, 'Fireworks poll response');
    if (state.status === 'Ready') { result = state.result; break; }
    if (state.status === 'Task not found' || state.status === 'Pending') continue;
    if (['Error', 'Request Moderated', 'Content Moderated'].includes(state.status)) {
      throw new Error(`Fireworks: ${state.status}`);
    }
  }
  if (!result) throw new Error('Fireworks image generation timed out after 5 minutes.');

  const sampleUrl = result?.sample ?? (typeof result === 'string' && /^https?:\/\//i.test(result) ? result : null);
  if (sampleUrl) return fetchSafeGeneratedImage(sampleUrl, getTurnSignal());
  if (typeof result === 'string') return inspectBase64(result);
  const base64 = Array.isArray(result?.base64) ? result.base64[0] : result?.base64;
  if (!base64) throw new Error('Fireworks returned an unsupported result format.');
  return inspectBase64(base64);
}

async function grokGenerate(model, prompt, aspectRatio) {
  if (!GROK_MODELS.has(model)) throw new Error('Configured Grok image model is not allowed.');
  const key = getGrokKey();
  if (!key) throw new Error('Grok API key not configured. Add it in Settings → Providers.');
  const response = await fetch(grokUrl(), {
    method: 'POST',
    redirect: 'error',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: requestSignal(),
    body: JSON.stringify({ model, prompt, n: 1, response_format: 'b64_json', aspect_ratio: aspectRatio }),
  });
  if (!response.ok) throw new Error(`Grok error ${response.status}: ${await safeErrorText(response)}`);
  const data = await readResponseJson(response, MAX_JSON_BYTES, 'Grok response');
  const base64 = data.data?.[0]?.b64_json;
  if (!base64) throw new Error('Grok returned no image data.');
  return inspectBase64(base64);
}

async function fetchSafeGeneratedImage(rawUrl, signal = null) {
  let parsed;
  try { parsed = new URL(String(rawUrl)); }
  catch { throw new Error('Fireworks returned an invalid image URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Fireworks returned an unsafe image URL.');
  }
  const resource = await fetchBrowserPublicResource(parsed.href, {
    maxBytes: MAX_IMAGE_BYTES,
    mimePattern: /^image\/(?:png|jpe?g|webp|gif)$/,
    label: 'generated image',
    accept: 'image/png,image/jpeg,image/webp,image/gif',
    requireHttps: true,
    signal,
  });
  return inspectImage(resource.bytes);
}

async function readResponseJson(response, maxBytes, label) {
  const bytes = await readResponseBytes(response, maxBytes, label);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${label} was not valid JSON.`); }
}

async function safeErrorText(response) {
  try { return (await readResponseBytes(response, MAX_ERROR_BYTES, 'provider error')).toString('utf8').slice(0, 1_000); }
  catch { return 'unreadable provider error'; }
}

async function readResponseBytes(response, maxBytes, label) {
  const declared = Number(response.headers?.get?.('content-length') ?? response.headers?.['content-length'] ?? 0);
  if (declared > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes.`);
  const chunks = [];
  let size = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error(`${label} exceeded ${maxBytes} bytes.`); }
      chunks.push(Buffer.from(value));
    }
  } else if (response.arrayBuffer) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes.`);
    chunks.push(bytes);
    size = bytes.length;
  } else if (response.text) {
    const bytes = Buffer.from(await response.text());
    if (bytes.length > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes.`);
    chunks.push(bytes);
    size = bytes.length;
  } else {
    throw new Error(`${label} had no readable body.`);
  }
  if (!size) throw new Error(`${label} was empty.`);
  return Buffer.concat(chunks, size);
}

function inspectBase64(raw) {
  if (typeof raw !== 'string') throw new Error('Provider returned invalid base64 image data.');
  let value = raw.trim();
  const comma = value.indexOf(',');
  if (value.startsWith('data:') && comma >= 0) value = value.slice(comma + 1);
  value = value.replace(/\s+/g, '');
  if (!value || value.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('Provider returned invalid or oversized base64 image data.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Provider returned an empty or oversized image.');
  return inspectImage(bytes);
}

function inspectImage(bytes) {
  const format = detectImageFormat(bytes);
  if (!format) throw new Error('Provider response was not a supported PNG, JPEG, WebP, or GIF image.');
  return { bytes, ...format };
}

function detectImageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  return null;
}

export const __test = Object.freeze({
  detectImageFormat,
  inspectBase64,
  loadOwnedInputImage,
  selectBackend,
  readResponseBytes,
  limits: {
    maxImageBytes: MAX_IMAGE_BYTES,
    maxBase64Chars: MAX_BASE64_CHARS,
    maxPromptChars: MAX_PROMPT_CHARS,
    kontextDeadlineMs: KONTEXT_DEADLINE_MS,
  },
});
