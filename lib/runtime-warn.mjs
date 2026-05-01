/**
 * Loud-failure broadcast for cortex / scheduler external runtimes (Ollama, LM Studio).
 *
 * Background: when LM Studio's Just-In-Time model loading is off (the default),
 * a request for an unloaded model returns 404 — the cortex/plan call returns
 * null and the caller degrades silently. Users see "reason isn't running" with
 * no explanation. This module turns repeated failures into a visible toast.
 *
 * Threshold: 3 consecutive failures per (kind, provider). After that, we
 * broadcast a `cortex_warning` WS event to every connected client and rate-
 * limit further broadcasts for the same key to once per 5 minutes (so a hot
 * loop of cortex calls doesn't spam the UI).
 *
 * On the next successful call for the same key, the counter resets.
 */

const FAIL_THRESHOLD = 3;
const REBROADCAST_MS = 5 * 60_000;

// Map<key, { fails: number, lastBroadcastAt: number }>
const _state = new Map();

let _broadcast = () => {};
export function setRuntimeWarnBroadcast(fn) { _broadcast = fn; }

function _key(kind, provider) { return `${kind}:${provider}`; }

/**
 * Record a failure. `info` shapes the user-visible message.
 *  - kind:     'reason' | 'plan'
 *  - provider: 'lmstudio' | 'ollama' | other
 *  - status:   HTTP status code (or null for network error)
 *  - model:    requested model id
 *  - message:  raw error message (network errors)
 */
export function reportRuntimeFailure({ kind, provider, status = null, model = '', message = '' }) {
  const key = _key(kind, provider);
  const cur = _state.get(key) ?? { fails: 0, lastBroadcastAt: 0 };
  cur.fails += 1;
  _state.set(key, cur);

  if (cur.fails < FAIL_THRESHOLD) return;

  const now = Date.now();
  if (now - cur.lastBroadcastAt < REBROADCAST_MS) return;
  cur.lastBroadcastAt = now;

  _broadcast({
    type: 'cortex_warning',
    kind,
    provider,
    status,
    model,
    message: _formatMessage({ kind, provider, status, model, message }),
  });
}

/** Reset the counter for a (kind, provider) on first success. */
export function clearRuntimeFailure({ kind, provider }) {
  const key = _key(kind, provider);
  const cur = _state.get(key);
  if (cur && cur.fails > 0) cur.fails = 0;
}

function _formatMessage({ kind, provider, status, model, message }) {
  const name = kind === 'plan' ? 'Plan' : 'Reason';
  if (provider === 'lmstudio') {
    if (status === 404) {
      return `${name} model "${model}" isn't loaded in LM Studio. Enable Just-In-Time Model Loading in LM Studio's Developer settings, or load the model manually.`;
    }
    if (status != null) return `${name} via LM Studio failed (HTTP ${status}). Check that LM Studio is running and the model is loaded.`;
    return `Can't reach LM Studio for ${name.toLowerCase()} (${message || 'connection failed'}). Is the server running on the configured URL?`;
  }
  if (provider === 'ollama') {
    if (status === 404) return `${name} model "${model}" isn't pulled in Ollama. Run \`ollama pull ${model}\` or pick a different model.`;
    if (status != null) return `${name} via Ollama failed (HTTP ${status}).`;
    return `Can't reach Ollama for ${name.toLowerCase()} (${message || 'connection failed'}).`;
  }
  return `${name} provider ${provider} failed${status ? ` (HTTP ${status})` : ''}${message ? `: ${message}` : ''}.`;
}
