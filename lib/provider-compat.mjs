/** Learn only known wire-format adjustments after a successful retry. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BASE_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const STATE_FILE = path.join(BASE_DIR, 'config', 'provider-compat.json');
const TTL_MS = 7 * 24 * 60 * 60_000;
const LIMIT = 256;

function identity(endpoint, model, apiKey) {
  // Account-scoped without persisting credentials or prompts.
  return createHash('sha256').update(JSON.stringify([endpoint, model, apiKey])).digest('hex');
}

function readEntries() {
  try {
    if (fs.statSync(STATE_FILE).size > 128 * 1024) return {};
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data?.version !== 1 || !data.entries || Array.isArray(data.entries)) return {};
    return Object.fromEntries(Object.entries(data.entries)
      .filter(([key, value]) => /^[a-f0-9]{64}$/.test(key)
        && Number.isFinite(value?.expires) && value.expires > Date.now()
        && value.expires <= Date.now() + TTL_MS)
      .slice(-LIMIT));
  } catch { return {}; }
}

export function getProviderCompatibility(endpoint, model, apiKey) {
  const entry = readEntries()[identity(endpoint, model, apiKey)];
  let testedEndpoint;
  try {
    const target = new URL(entry?.endpoint);
    if (target.origin === new URL(endpoint).origin && target.protocol === 'https:'
      && !target.username && !target.password && !target.search && !target.hash) testedEndpoint = target.href;
  } catch { /* No tested endpoint override. */ }
  return {
    useMaxCompletionTokens: entry?.useMaxCompletionTokens === true,
    streamUsageDisabled: entry?.streamUsageDisabled === true,
    ...(testedEndpoint ? { endpoint: testedEndpoint } : {}),
  };
}

export function rememberProviderCompatibility(endpoint, model, apiKey, flags) {
  const entries = readEntries();
  const key = identity(endpoint, model, apiKey);
  delete entries[key];
  entries[key] = {
    useMaxCompletionTokens: flags.useMaxCompletionTokens === true,
    streamUsageDisabled: flags.streamUsageDisabled === true,
    ...(typeof flags.endpoint === 'string' ? { endpoint: flags.endpoint } : {}),
    expires: Date.now() + TTL_MS,
  };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    atomicWriteSync(STATE_FILE, JSON.stringify({
      version: 1, entries: Object.fromEntries(Object.entries(entries).slice(-LIMIT)),
    }), { mode: 0o600 });
  } catch {
    console.warn('[provider-compat] Could not save learned provider settings.');
  }
}
