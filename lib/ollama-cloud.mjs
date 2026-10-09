import { createHash } from 'node:crypto';

const checks = new Map();
const TTL_MS = 60_000;

export function resolveOllamaKey(cfg, provider = 'ollama') {
  const candidates = provider === 'ollama-local'
    ? [cfg?.cortex?.ollamaLocalApiKey]
    : [cfg?.cortex?.ollamaApiKey, cfg?.ollamaApiKey];
  return candidates.find(key => typeof key === 'string' && key.trim())?.trim() || null;
}

export function isOfficialOllamaCloudBase(base) {
  try {
    const url = new URL(base);
    return url.protocol === 'https:' && url.hostname === 'ollama.com'
      && (!url.port || url.port === '443') && !url.username && !url.password;
  } catch { return false; }
}

/** /api/tags is public; only the account endpoint verifies a cloud key. */
export async function checkOllamaCloudKey(key, { refresh = false } = {}) {
  if (!key) return { ok: false, code: 'missing_key', message: 'Add an Ollama Cloud API key in Settings > Providers.' };
  const cacheKey = createHash('sha256').update(key).digest('hex');
  const cached = checks.get(cacheKey);
  if (!refresh && cached?.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    try {
      const response = await fetch('https://ollama.com/api/me', {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(4_000),
      });
      await response.body?.cancel();
      if (response.ok) return { ok: true, code: 'connected', message: 'Ollama Cloud key verified.' };
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false, code: 'authentication_failed', upstreamStatus: response.status,
          message: `Ollama Cloud rejected this key (HTTP ${response.status}). Replace it in Settings > Providers > Ollama Cloud. Create a key at ollama.com/settings/keys.`,
        };
      }
      return { ok: false, code: 'unavailable', upstreamStatus: response.status, message: `Ollama Cloud could not verify the key (HTTP ${response.status}). Try again shortly.` };
    } catch {
      return { ok: false, code: 'unavailable', message: 'Could not reach Ollama Cloud to verify the key. Try again shortly.' };
    }
  })();
  if (checks.size >= 50) checks.clear();
  checks.set(cacheKey, { expires: Date.now() + TTL_MS, promise });
  return promise;
}

export function clearOllamaCloudKeyCache() { checks.clear(); }
