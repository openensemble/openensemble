/** Keep the CLI proxy's client-version handshake current without replaying accepted work. */
import fs from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { readBoundedJson } from './provider-update-feeds.mjs';
import { updateFailureReason, validateProbeStream } from './provider-update-gate.mjs';
import { providerUpdateId, recordProviderUpdate, getProviderUpdateResult, providerUpdateMessage } from './provider-update-status.mjs';

const DEFAULT_VERSION = '1.0.13';
const STATE_FILE = path.join(BASE_DIR, 'config', 'xai-client-compat.json');
const VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const UPGRADE_RE = /^Your Grok CLI version \((\d+\.\d+\.\d+)\) is outdated\. Please update to version (\d+\.\d+\.\d+) or later\b/;
const pendingPromotions = new WeakMap();

/** The adapter confirms its complete stream before this version becomes a default. */
export function confirmXaiCLIResponse(response, valid) {
  const finish = pendingPromotions.get(response);
  if (!finish) return;
  pendingPromotions.delete(response);
  finish(valid);
}

export const GROK_CLI_HEADERS = Object.freeze({
  'x-xai-token-auth': 'xai-grok-cli',
  'x-grok-client-identifier': 'grok-shell',
  'x-grok-client-version': process.env.OE_GROK_CLI_VERSION || DEFAULT_VERSION,
});

function isNewer(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function getGrokCliHeaders() {
  let version = DEFAULT_VERSION;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))?.version;
    if (typeof saved === 'string' && VERSION_RE.test(saved) && isNewer(saved, version)) version = saved;
  } catch { /* No learned requirement yet. */ }
  return { ...GROK_CLI_HEADERS, 'x-grok-client-version': process.env.OE_GROK_CLI_VERSION || version };
}

export async function fetchXaiCLI(url, init = {}, { onAttempt = null, userId = '' } = {}) {
  if (new URL(url).origin !== 'https://cli-chat-proxy.grok.com') {
    throw new Error('Grok client compatibility is only available for the xAI CLI proxy.');
  }
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(getGrokCliHeaders())) headers.set(name, value);
  onAttempt?.();
  const response = await fetch(url, { ...init, redirect: 'error', headers: new Headers(headers) });
  // HTTP 426 rejects the handshake before model execution. Never retry a
  // successful stream, a timeout, or any other status on this path.
  if (response.status !== 426 || process.env.OE_GROK_CLI_VERSION) return response;
  let message;
  try { message = (await response.clone().json())?.error; } catch { return response; }
  if (typeof message !== 'string' || message.length > 4096) return response;
  const match = message.match(UPGRADE_RE);
  const current = headers.get('x-grok-client-version');
  const required = match?.[2];
  if (!match || match[1] !== current || !VERSION_RE.test(required)
      || !isNewer(required, current)) return response;

  // A requirement is a proposal. Test it with a tiny request without user
  // content or tools before retrying any work or saving a new default.
  const learned = getGrokCliHeaders()['x-grok-client-version'];
  const version = isNewer(learned, required) ? learned : required;
  let model = '';
  try { model = JSON.parse(init.body)?.model || ''; } catch { /* Catalog request. */ }
  const context = { id: providerUpdateId(userId, headers.get('authorization'), url, model, version),
    userId, provider: 'xai-oauth', model, source: 'provider response' };
  const previous = getProviderUpdateResult(context.id);
  const reportFailure = reason => {
    const row = recordProviderUpdate({ ...context, status: 'rejected', reason });
    return Response.json({ error: providerUpdateMessage(row) }, { status: 426 });
  };
  if (['rejected', 'rolled_back'].includes(previous?.status) && Date.now() - previous.checkedAt < 6 * 60 * 60_000) {
    await response.body?.cancel();
    return Response.json({ error: providerUpdateMessage(previous) }, { status: 426 });
  }
  recordProviderUpdate({ ...context, status: 'testing' });
  headers.set('x-grok-client-version', version);
  await response.body?.cancel();
  try {
    const timeout = AbortSignal.timeout(20_000);
    const probeInit = { method: 'GET', redirect: 'error', headers: new Headers(headers),
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout };
    const isResponse = new URL(url).pathname === '/v1/responses';
    if (isResponse) {
      if (!model) return reportFailure('OE could not construct a model compatibility test.');
      probeInit.method = 'POST';
      probeInit.body = JSON.stringify({ model, instructions: 'Reply with OK.', store: false, stream: true,
        max_output_tokens: 512, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }] });
    } else if (new URL(url).pathname !== '/v1/models') {
      return reportFailure('This API endpoint needs an OE adapter update.');
    }
    onAttempt?.();
    const probe = await fetch(url, probeInit);
    if (!probe.ok) {
      await probe.body?.cancel();
      return reportFailure(updateFailureReason(probe.status));
    }
    if (isResponse) {
      if (!(await validateProbeStream(probe, 'responses')).ok) return reportFailure(updateFailureReason());
    } else {
      const data = await readBoundedJson(probe, 1024 * 1024);
      const rows = data.data ?? data.models ?? data;
      if (!Array.isArray(rows) || !rows.length || !rows.every(row => typeof (row.id ?? row.name ?? row.slug) === 'string')) {
        return reportFailure(updateFailureReason());
      }
      // GET /models was itself a successful read-only test; reuse its result.
      init = { ...init, _validatedCatalog: data };
    }
  } catch {
    return reportFailure(init.signal?.aborted ? 'The test was cancelled.' : 'The test timed out or could not reach the provider.');
  }
  const promote = () => {
    // Persist only a tested numeric version from the fixed provider endpoint.
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const latest = getGrokCliHeaders()['x-grok-client-version'];
      atomicWriteSync(STATE_FILE, JSON.stringify({ version: isNewer(latest, version) ? latest : version,
        learnedAt: Date.now(), source: 'xai-426-tested' }, null, 2), { mode: 0o600 });
      recordProviderUpdate({ ...context, status: 'applied' });
    } catch {
      recordProviderUpdate({ ...context, status: 'blocked', reason: 'The test passed but OE could not save the new client version.' });
    }
  };
  console.info(`[xai-oauth] Tested client compatibility ${current} -> ${version}; retrying rejected handshake once`);
  if (init._validatedCatalog) { promote(); return Response.json(init._validatedCatalog); }
  onAttempt?.();
  let result;
  try { result = await fetch(url, { ...init, redirect: 'error', headers }); }
  catch (error) {
    reportFailure('The request was interrupted after the compatibility test. Previous settings were retained.');
    // Acceptance is unknown. Do not let a caller replay potentially paid work.
    error.providerUpdateNoReplay = true;
    throw error;
  }
  if (!result.ok) reportFailure(updateFailureReason(result.status));
  else pendingPromotions.set(result, valid => {
    if (valid) promote();
    else reportFailure('The real response failed validation or was interrupted. Previous settings were retained.');
  });
  return result;
}
