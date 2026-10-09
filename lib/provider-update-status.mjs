/** Durable, credential-free results of provider compatibility checks. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BASE_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const FILE = path.join(BASE_DIR, 'config', 'provider-update-results.json');
const LIMIT = 128;
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240);
export const providerUpdateId = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function read() {
  try {
    if (fs.statSync(FILE).size > 256 * 1024) return [];
    const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(rows) ? rows.filter(r => /^[a-f0-9]{64}$/.test(r?.id)).slice(-LIMIT) : [];
  } catch { return []; }
}

export function recordProviderUpdate({ id, userId = '', provider, model = '', source, status, reason = '' }) {
  const row = { id, userId: clean(userId), provider: clean(provider), model: clean(model),
    source: clean(source), status, reason: clean(reason), checkedAt: Date.now() };
  if (!/^[a-f0-9]{64}$/.test(id) || !['testing', 'applied', 'rejected', 'blocked', 'rolled_back'].includes(status)) return null;
  try {
    const rows = read().filter(r => r.id !== id);
    rows.push(row);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    atomicWriteSync(FILE, JSON.stringify(rows.slice(-LIMIT)), { mode: 0o600 });
  } catch { console.warn('[provider-updates] Could not save compatibility check result.'); }
  return row;
}

export function getProviderUpdateResult(id) { return read().find(r => r.id === id) ?? null; }
export function listProviderUpdateResults(userId) {
  return read().filter(r => !r.userId || r.userId === userId).reverse().map(({ userId: _userId, ...row }) => row);
}

export function providerUpdateMessage(row) {
  const name = row.provider === 'xai-oauth' ? 'SuperGrok' : row.provider;
  if (row.status === 'applied') return `${name}: OE tested and applied a provider compatibility update.`;
  if (row.status === 'testing') return `${name}: OE is testing a provider compatibility update.`;
  if (row.status === 'rolled_back') return `${name}: the provider update failed during use. OE restored the previous settings. ${row.reason}`.trim();
  const evidence = row.source === 'provider response' ? 'The provider reported an API compatibility change.' : 'An update feed reports a possible provider API change.';
  return `${name}: ${evidence} OE could not validate the update and kept the previous settings. ${row.reason}`.trim();
}

/** Do not label credentials, quota errors or ordinary outages as API changes. */
export function isProviderCompatibilityError(status, text) {
  if (![400, 404, 410, 422, 426].includes(status)) return false;
  return status === 426 || status === 410
    || /(?:client|api|protocol).{0,40}(?:outdated|unsupported|deprecated|retired)|(?:outdated|unsupported|deprecated|retired).{0,40}(?:client|api|protocol)|(?:unknown|unrecognized|unsupported|removed|deprecated) (?:parameter|field|endpoint)|(?:endpoint|model).{0,50}(?:retired|deprecated|no longer (?:available|supported))/i.test(String(text).slice(0, 8192));
}

/** Shared feedback for native adapters whose protocol changes need code. */
export async function* withProviderUpdateFeedback(generator, { userId, provider, model }) {
  for await (const event of generator) {
    if (event.type === 'error' && !/OE (?:could not validate|restored|tested)/.test(event.message || '')) {
      const status = Number(String(event.message || '').match(/\b(400|401|402|403|404|410|422|426|429|5\d\d)\b/)?.[1]);
      if (isProviderCompatibilityError(status, event.message)) {
        const row = recordProviderUpdate({ id: providerUpdateId(userId, provider, model, 'unhandled protocol'),
          userId, provider, model, source: 'provider response', status: 'rejected',
          reason: 'This change needs an OE adapter update. Check Settings → Providers for the update result.' });
        yield { ...event, message: `${providerUpdateMessage(row)}\n${event.message}`, retryable: false };
        continue;
      }
    }
    yield event;
  }
}
