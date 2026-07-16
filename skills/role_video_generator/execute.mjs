// @ts-check
/**
 * Provider-independent text-to-video generation.
 *
 * The foreground tool only registers durable work. The watcher owns provider
 * initiation, polling, bounded download, persistence, and chat delivery so a
 * long render survives a server restart and does not pin the primary model.
 */
import { constants as fsConstants, existsSync, lstatSync, readFileSync, rmSync } from 'fs';
import fsp from 'fs/promises';
import { createHash, randomBytes } from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { getUserFilesDir, readConfig, USERS_DIR } from '../../lib/paths.mjs';
import { isBlockedIP } from '../../lib/url-guard.mjs';
import { getGrokKey } from '../../chat/providers/_shared.mjs';

const SKILL_ID = 'role_video_generator';
const WATCHER_KIND = 'grok_video_generation';
const VIDEO_MODELS = new Set(['grok-imagine-video', 'grok-imagine-video-1.5']);
const PRODUCTION_VIDEO_BASE = 'https://api.x.ai/v1';
const LAB_VIDEO_BASE = 'http://127.0.0.1:9932/v1';
const LAB_VIDEO_ORIGIN = 'http://127.0.0.1:9932';
const LAB_DUMMY_KEY = 'lab-fake';
const POLL_CADENCE_SEC = 5;
const JOB_EXPIRY_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 4000;
const MAX_REQUEST_ID_CHARS = 256;
const MAX_PROVIDER_JSON_BYTES = 64 * 1024;
const MAX_PROVIDER_ERROR_BYTES = 4 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_REDIRECTS = 2;
// Provider POSTs have no documented idempotency key. Split submission across
// two durable watcher ticks and bind the persisted claim to this process. A
// restart at the POST boundary becomes an explicit ambiguous terminal state,
// never an automatic second paid request.
const VIDEO_BOOT_NONCE = randomBytes(16).toString('hex');
const submittedClaimsThisBoot = new Set();

function readJson(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }
  catch { return null; }
}

function selectConfiguredVideoModel(userId) {
  const cfg = readConfig();
  const profile = readJson(path.join(USERS_DIR, String(userId || ''), 'profile.json')) ?? {};
  const assignments = profile.role === 'owner'
    ? (cfg.skillAssignments ?? {})
    : profile.role === 'admin'
      ? { ...(cfg.skillAssignments ?? {}), ...(profile.skillAssignments ?? {}) }
      : (profile.skillAssignments ?? {});
  const assignedId = assignments[SKILL_ID];
  const agents = readJson(path.join(USERS_DIR, String(userId || ''), 'agents.json')) ?? [];
  const baseAgent = Array.isArray(agents) ? agents.find(agent => agent?.id === assignedId) : null;
  const preferred = baseAgent
    ? { ...baseAgent, ...(cfg.agentModels?.[assignedId] ?? {}), ...(profile.agentOverrides?.[assignedId] ?? {}) }
    : null;
  const provider = preferred?.provider === 'xai' ? 'grok' : preferred?.provider;
  if (provider !== 'grok' || !VIDEO_MODELS.has(preferred?.model)) {
    return { error: 'No explicitly configured, supported Grok video model is assigned to Video Generator.' };
  }
  if (profile.allowedModels != null) {
    if (!Array.isArray(profile.allowedModels) || !profile.allowedModels.includes(preferred.model)) {
      return { error: `The configured video model "${preferred.model}" is not approved for this account.` };
    }
  }
  return { model: preferred.model };
}

function providerConfig(userId) {
  const key = String(getGrokKey() ?? '');
  if (process.env.OPENENSEMBLE_LAB === '1') {
    if (key !== LAB_DUMMY_KEY) {
      return { error: 'The isolated video lab requires its exact dummy provider key.' };
    }
    const selected = selectConfiguredVideoModel(userId);
    if (selected.error) return selected;
    return { key, base: LAB_VIDEO_BASE, lab: true, model: selected.model };
  }
  if (readConfig().enabledProviders?.grok === false) {
    return { error: 'Grok is disabled in Settings → Providers.' };
  }
  if (!key) return { error: 'Grok API key not configured. Add it in Settings → Providers.' };
  const selected = selectConfiguredVideoModel(userId);
  if (selected.error) return selected;
  return { key, base: PRODUCTION_VIDEO_BASE, lab: false, model: selected.model };
}

export default function execute(name, args, userId, agentId, ctx) {
  if (name !== 'generate_video') return null;
  if (args?.__validate) return true;
  return queueVideo(args ?? {}, userId, ctx);
}

async function queueVideo(args, userId, ctx) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Error: generate_video arguments must be an object.';
  }
  const unknown = Object.keys(args).find(key => key !== 'prompt');
  if (unknown) return `Error: generate_video does not accept the argument "${unknown}".`;
  if (typeof args.prompt !== 'string') return 'Error: generate_video prompt must be a string.';
  const prompt = args.prompt.trim();
  if (!prompt) return 'Error: generate_video requires a non-empty "prompt".';
  if (prompt.length > MAX_PROMPT_CHARS) {
    return `Error: generate_video prompt must be ${MAX_PROMPT_CHARS} characters or fewer.`;
  }
  const provider = providerConfig(userId);
  if (provider.error) return `Error: ${provider.error}`;
  if (!ctx?.watch) return 'Error: video generation requires the background-task service.';

  const watcherId = await ctx.watch({
    kind: WATCHER_KIND,
    label: `Generate video: ${prompt.slice(0, 80)}`,
    cadenceSec: POLL_CADENCE_SEC,
    expiresAt: Date.now() + JOB_EXPIRY_MS,
    requirePersist: true,
    state: {
      phase: 'queued',
      prompt,
      model: provider.model,
      requestId: null,
      progress: null,
      createdAt: Date.now(),
    },
  });
  if (!watcherId) return 'Error: video generation could not register its background job.';
  return `Video generation queued (task ${watcherId}). Progress will appear in the task drawer, and the finished video will be shown here automatically.`;
}

export const watcherHandlers = {
  async [WATCHER_KIND](state, helpers) {
    throwIfAborted(helpers?.signal);
    const provider = providerConfig(helpers?.userId);
    if (provider.error) return terminalError(provider.error);
    if (state?.model && state.model !== provider.model) {
      return terminalError('The configured/approved Grok video model changed while this task was running. The task was stopped before another provider call.');
    }
    if (!state?.requestId && state?.phase === 'queued') return claimProviderSubmission(state);
    if (!state?.requestId) return startProviderJob(state ?? {}, provider, helpers ?? {});
    return pollProviderJob(state, helpers ?? {}, provider);
  },
};

function claimProviderSubmission(state) {
  const prompt = String(state.prompt ?? '').trim();
  if (!prompt) return terminalError('Video task is missing its prompt.');
  if (prompt.length > MAX_PROMPT_CHARS) return terminalError('Video task prompt exceeds the allowed length.');
  return {
    newState: {
      ...state,
      phase: 'submission_claimed',
      model: state.model,
      submissionClaimId: randomBytes(16).toString('hex'),
      submissionBootNonce: VIDEO_BOOT_NONCE,
      submissionClaimedAt: Date.now(),
    },
    textUpdate: '🎬 Video request prepared for submission',
    nextCadenceSec: POLL_CADENCE_SEC,
    requirePersist: true,
  };
}

async function startProviderJob(state, provider, helpers) {
  const prompt = String(state.prompt ?? '').trim();
  if (!prompt) return terminalError('Video task is missing its prompt.');
  if (prompt.length > MAX_PROMPT_CHARS) return terminalError('Video task prompt exceeds the allowed length.');
  const claimId = normalizeSubmissionClaimId(state.submissionClaimId);
  if (state.phase !== 'submission_claimed' || !claimId || !state.submissionBootNonce) {
    return terminalError('Video task has no valid durable submission claim.');
  }
  if (state.submissionBootNonce !== VIDEO_BOOT_NONCE) {
    return terminalError('Video submission was interrupted at an ambiguous provider boundary and was not retried automatically. Start a new request only after checking provider billing/jobs.');
  }
  if (submittedClaimsThisBoot.has(claimId)) {
    return terminalError('Video submission outcome is ambiguous and was not retried automatically. Check provider billing/jobs before starting a new request.');
  }
  // Claim in memory BEFORE initiating I/O. If the request loses its response,
  // a later tick in this process refuses to POST again; after a restart the
  // boot-nonce check above refuses the persisted in-flight claim.
  submittedClaimsThisBoot.add(claimId);
  throwIfAborted(helpers.signal);

  let response;
  try {
    // xAI does not document an idempotency key for this endpoint. The durable
    // claim above provides at-most-once automatic submission, not exactly-once
    // completion: an interrupted boundary is surfaced for manual reconciliation.
    response = await fetch(`${provider.base}/videos/generations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
      signal: boundedSignal(helpers.signal),
      redirect: 'error',
      body: JSON.stringify({ model: provider.model, prompt }),
    });
  } catch (error) {
    if (helpers.signal?.aborted) throw abortError(helpers.signal.reason);
    return terminalError(`Grok video submission outcome is ambiguous and was not retried automatically: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    const detail = await safeText(response);
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return terminalError(`Grok video submission outcome is ambiguous and was not retried automatically (HTTP ${response.status}: ${detail}). Check provider billing/jobs before retrying.`);
    }
    return terminalError(`Grok error ${response.status}: ${detail}`);
  }
  let data;
  try { data = await readProviderJson(response); }
  catch (error) {
    return terminalError(`Grok accepted the video submission but returned an ambiguous response (${errorMessage(error)}). It was not retried; check provider billing/jobs.`);
  }
  const requestId = normalizeRequestId(data.id ?? data.request_id);
  if (!requestId) return terminalError('Grok accepted the video submission but returned no valid request ID. It was not retried; check provider billing/jobs.');

  return {
    newState: {
      ...state,
      phase: 'generating',
      model: provider.model,
      requestId,
      progress: 0,
      submittedAt: Date.now(),
    },
    textUpdate: '🎬 Video generation started — 0%',
    nextCadenceSec: POLL_CADENCE_SEC,
  };
}

async function pollProviderJob(state, helpers, provider) {
  const requestId = normalizeRequestId(state.requestId);
  if (!requestId) return terminalError('Video task has an invalid request ID.');
  let response;
  try {
    response = await fetch(`${provider.base}/videos/${encodeURIComponent(requestId)}`, {
      headers: { 'Authorization': `Bearer ${provider.key}` },
      signal: boundedSignal(helpers.signal),
      redirect: 'error',
    });
  } catch (error) {
    if (helpers.signal?.aborted) throw abortError(helpers.signal.reason);
    throw new Error(`Grok video poll failed: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    const detail = await safeText(response);
    // The watcher supervisor retries thrown transient failures. Permanent 4xx
    // responses terminate the job so they do not burn requests indefinitely.
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new Error(`Grok poll error ${response.status}: ${detail}`);
    }
    return terminalError(`Grok poll error ${response.status}: ${detail}`);
  }

  let data;
  try { data = await readProviderJson(response); }
  catch (error) { return terminalError(`Grok returned an invalid poll response: ${errorMessage(error)}`); }
  if (data.error) return terminalError(`Video generation failed: ${boundedDetail(data.error?.message ?? data.error)}`);

  const status = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
  if (status === 'failed') {
    return terminalError(`Video generation failed: ${boundedDetail(data.message ?? data.video?.message ?? 'provider reported failed')}`);
  }
  if (status === 'expired') return terminalError('Video generation expired before completion.');
  if (status !== 'pending' && status !== 'done') {
    return terminalError(`Grok returned an invalid video status${status ? ` "${boundedDetail(status)}"` : ''}.`);
  }

  if (status === 'pending') {
    const progress = normalizeProgress(data.progress, state.progress);
    return {
      newState: { ...state, phase: 'generating', progress },
      textUpdate: progress == null ? '🎬 Generating video…' : `🎬 Generating video… ${progress}%`,
      nextCadenceSec: POLL_CADENCE_SEC,
    };
  }

  if (data.video?.respect_moderation !== true) {
    return terminalError('Video generation was blocked or not explicitly cleared by moderation.');
  }

  const videoUrl = normalizeVideoUrl(data.video?.url);
  if (!videoUrl) return terminalError('Video generation was blocked by moderation.');

  const filename = makeFilename(state.prompt, requestId);
  const diskPath = path.join(getUserFilesDir(helpers.userId, 'videos'), filename);
  try {
    throwIfAborted(helpers.signal);
    if (!(await validExistingVideo(diskPath))) {
      const video = await downloadProviderVideo(videoUrl, provider.lab, helpers.signal);
      throwIfAborted(helpers.signal);
      await saveVideoAtomic(diskPath, video.bytes, helpers.signal);
    }
    throwIfAborted(helpers.signal);
  } catch (error) {
    if (helpers.signal?.aborted) throw abortError(helpers.signal.reason);
    return terminalError(`Video download/save failed: ${errorMessage(error)}`);
  }

  const playbackUrl = `/api/desktop/videos/${encodeURIComponent(filename)}`;
  const attachmentId = `videos:${filename}`;
  if (typeof helpers.showVideo !== 'function') throw new Error('durable video delivery is unavailable');
  throwIfAborted(helpers.signal);
  await helpers.showVideo({
    url: playbackUrl,
    filename,
    savedPath: attachmentId,
    deliveryId: requestId,
  });
  throwIfAborted(helpers.signal);

  return {
    done: true,
    newState: { ...state, phase: 'done', model: provider.model, progress: 100, filename, attachmentId, playbackUrl },
    textUpdate: `✓ Video generated with ${provider.model}. Attachment ID: ${attachmentId}.`,
  };
}

async function downloadProviderVideo(videoUrl, lab, signal) {
  return lab ? fetchExactLabVideo(videoUrl, signal) : fetchPublicVideo(videoUrl, signal);
}

// Cookie-free, DNS-pinned download with a literal-IP check on every redirect.
// Node bypasses a custom lookup callback for literal IPs, so both checks are
// necessary to keep provider-controlled result URLs away from private hosts.
function validatePublicVideoUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('provider returned an invalid video URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('provider video URL is not allowed');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) && isUnsafeVideoAddress(hostname)) {
    throw new Error('provider video URL points to a private or unsafe address');
  }
  return url;
}

function isUnsafeVideoAddress(address) {
  if (isBlockedIP(address)) return true;
  if (!net.isIPv6(address)) return false;
  const value = address.toLowerCase();
  // Cover compressed IPv4-mapped literals and the full fe80::/10 range.
  if (value.startsWith('::')) return true;
  const firstHextet = Number.parseInt(value.split(':', 1)[0] || '0', 16);
  return Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80;
}

function pinnedPublicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) { callback(error); return; }
    if (!addresses?.length || addresses.some(row => isUnsafeVideoAddress(row.address))) {
      callback(new Error('provider video host resolves to a private or unsafe address'));
      return;
    }
    const chosen = addresses[0];
    if (options?.all) callback(null, [chosen]);
    else callback(null, chosen.address, chosen.family);
  });
}

function requestPublicVideoOnce(url, signal) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https.request : http.request)({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { Accept: 'video/mp4', 'User-Agent': 'OpenEnsemble-Video/1.0' },
      lookup: pinnedPublicLookup,
      timeout: REQUEST_TIMEOUT_MS,
      signal: boundedSignal(signal),
    }, response => resolve(response));
    request.on('timeout', () => request.destroy(new Error('generated video request timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function fetchPublicVideo(rawUrl, signal) {
  let url = validatePublicVideoUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_VIDEO_REDIRECTS; redirect++) {
    throwIfAborted(signal);
    const response = await requestPublicVideoOnce(url, signal);
    const status = Number(response.statusCode || 0);
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (redirect === MAX_VIDEO_REDIRECTS) throw new Error('generated video redirected too many times');
      url = validatePublicVideoUrl(new URL(response.headers.location, url).href);
      continue;
    }
    if (status !== 200) {
      response.resume();
      throw new Error(`generated video fetch failed (${status || 'unknown status'})`);
    }
    const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (mime !== 'video/mp4') {
      response.resume();
      throw new Error('download did not return video/mp4');
    }
    const declared = Number(response.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
      response.resume();
      throw new Error(`generated video exceeds the ${MAX_VIDEO_BYTES}-byte limit`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_VIDEO_BYTES) {
        response.destroy();
        throw new Error(`generated video exceeds the ${MAX_VIDEO_BYTES}-byte limit`);
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    if (!bytes.length) throw new Error('generated video was empty');
    if (!isMp4(bytes)) throw new Error('generated video was not a valid MP4 container');
    return { bytes };
  }
  throw new Error('generated video fetch failed');
}

async function fetchExactLabVideo(rawUrl, signal) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error('lab provider returned an invalid video URL'); }
  if (url.origin !== LAB_VIDEO_ORIGIN || url.username || url.password || !url.pathname.startsWith('/output/')) {
    throw new Error('lab provider video URL is outside the exact loopback test origin');
  }
  const response = await fetch(url.href, {
    signal: boundedSignal(signal),
    redirect: 'error',
    headers: { Accept: 'video/mp4' },
  });
  if (!response.ok) throw new Error(`download returned ${response.status}`);
  const mime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  if (mime !== 'video/mp4') throw new Error('download did not return video/mp4');
  const { bytes } = await readBodyLimited(response, MAX_VIDEO_BYTES, { label: 'generated video' });
  if (!bytes.length) throw new Error('generated video was empty');
  if (!isMp4(bytes)) throw new Error('generated video was not a valid MP4 container');
  return { bytes };
}

function terminalError(message) {
  return { done: true, failed: true, textUpdate: `❌ ${message}` };
}

function normalizeProgress(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
  const old = Number(fallback);
  return Number.isFinite(old) ? old : null;
}

function normalizeRequestId(value) {
  const requestId = typeof value === 'string' ? value.trim() : '';
  if (!requestId || requestId.length > MAX_REQUEST_ID_CHARS || !/^[a-z0-9._:-]+$/i.test(requestId)) return null;
  return requestId;
}

function normalizeSubmissionClaimId(value) {
  const claimId = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{32}$/.test(claimId) ? claimId : null;
}

function normalizeVideoUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return url && url.length <= 4096 ? url : null;
}

function makeFilename(prompt, requestId) {
  const slug = String(prompt ?? '').slice(0, 40)
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
  const requestHash = createHash('sha256').update(String(requestId || '')).digest('hex').slice(0, 16);
  return `${slug || 'video'}_${requestHash}.mp4`;
}

function isMp4(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
}

async function validExistingVideo(file) {
  let fh = null;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return false;
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_VIDEO_BYTES) return false;
    fh = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const openedStat = await fh.stat();
      if (!openedStat.isFile() || openedStat.size < 12 || openedStat.size > MAX_VIDEO_BYTES) return false;
      const header = Buffer.alloc(12);
      const { bytesRead } = await fh.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || !isMp4(header)) return false;
      await fh.chmod(0o600);
    } finally {
      await fh.close();
      fh = null;
    }
    return true;
  } catch {
    try { await fh?.close(); } catch { /* best effort */ }
    return false;
  }
}

async function saveVideoAtomic(file, bytes, signal) {
  if (!isMp4(bytes)) throw new Error('generated video was not a valid MP4 container');
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fh = null;
  try {
    throwIfAborted(signal);
    fh = await fsp.open(tmp, 'wx', 0o600);
    await fh.writeFile(bytes);
    throwIfAborted(signal);
    await fh.sync();
    await fh.chmod(0o600);
    await fh.close();
    fh = null;
    throwIfAborted(signal);
    await fsp.rename(tmp, file);
  } catch (error) {
    try { await fh?.close(); } catch { /* best effort */ }
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function abortError(reason) {
  const error = new Error(String(reason?.message || reason || 'watcher cancelled'));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

function boundedSignal(signal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readProviderJson(response) {
  const { bytes } = await readBodyLimited(response, MAX_PROVIDER_JSON_BYTES, { label: 'provider response' });
  if (!bytes.length) throw new Error('empty response');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('malformed JSON'); }
}

async function readBodyLimited(response, maxBytes, { label = 'response', truncate = false } = {}) {
  const declaredRaw = String(response.headers?.get?.('content-length') ?? '');
  const declared = /^\d+$/.test(declaredRaw) ? Number(declaredRaw) : null;
  if (!truncate && Number.isSafeInteger(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* best effort */ }
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error(`${label} had no readable body`);
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value ?? []);
      const remaining = maxBytes - size;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        size = maxBytes;
        truncated = true;
        await reader.cancel();
        if (!truncate) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    try { reader.releaseLock?.(); } catch { /* best effort */ }
  }
  return { bytes: Buffer.concat(chunks, size), truncated };
}

async function safeText(response) {
  try {
    const { bytes, truncated } = await readBodyLimited(response, MAX_PROVIDER_ERROR_BYTES, {
      label: 'provider error',
      truncate: true,
    });
    const detail = bytes.toString('utf8').trim();
    return detail ? `${detail}${truncated ? '…' : ''}` : 'unknown provider error';
  } catch {
    return 'unknown provider error';
  }
}

function boundedDetail(value) {
  let detail;
  try { detail = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { detail = String(value); }
  return String(detail ?? 'unknown provider error').slice(0, MAX_PROVIDER_ERROR_BYTES);
}

function errorMessage(error) {
  return String(error?.message || error || 'unknown error').slice(0, 500);
}

export const __test = Object.freeze({
  providerConfig,
  selectConfiguredVideoModel,
  normalizeRequestId,
  normalizeSubmissionClaimId,
  normalizeProgress,
  validatePublicVideoUrl,
  readBodyLimited,
  isMp4,
  validExistingVideo,
  makeFilename,
  videoBootNonce: VIDEO_BOOT_NONCE,
  limits: { maxPromptChars: MAX_PROMPT_CHARS, maxVideoBytes: MAX_VIDEO_BYTES },
});
