// @ts-check
/**
 * Privacy boundary for durable learning from OE Bridge.
 *
 * Raw pages, screenshots, selections, search queries, and full URLs never
 * cross this module. It accepts only an intentional action plus coarse
 * domains/project labels and writes through the existing Personalization
 * consent + audit pipeline. Child accounts and shared browser profiles are
 * suppressed entirely.
 */

import { getUserRole } from '../routes/_helpers.mjs';
import { getConfig } from './personalization/config.mjs';
import { appendObservation } from './personalization/observations.mjs';
import { recordStructuredSignal } from './personalization/recorder.mjs';

const ACTIONS = new Set(['ask', 'compare', 'clip', 'handoff', 'watch', 'teach']);

function cleanDomain(value) {
  const raw = String(value || '').trim().toLowerCase();
  let hostname = raw;
  try { hostname = new URL(raw).hostname.toLowerCase(); } catch {}
  hostname = hostname.replace(/^www\./, '').replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname) || !hostname.includes('.')) return null;
  return hostname;
}

function cleanLabel(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 100) : null;
}

function uniqueDomains(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanDomain).filter(Boolean))].slice(0, 8);
}

/**
 * @param {string} userId
 * @param {{action:string,domains?:string[],projectLabel?:string|null,targetKind?:string|null,count?:number|null,sharedProfile?:boolean}} event
 */
export async function recordBrowserAttention(userId, event = /** @type {any} */ ({})) {
  if (!userId || event.sharedProfile === true || getUserRole(userId) === 'child') return null;
  const action = String(event.action || '');
  if (!ACTIONS.has(action)) return null;
  const domains = uniqueDomains(event.domains);
  if (!domains.length) return null;

  // Asking is weak, repeated evidence—not a durable preference. Use the same
  // low-confidence interest path reflection already gates on repetition.
  if (action === 'ask') {
    try {
      const config = await getConfig(userId);
      if (!config?.enabled || config?.setupComplete === false || config?.sources?.sessions === false) return null;
      return await appendObservation(userId, {
        source: 'browser_attention',
        kind: 'interest',
        digest: `Asked OE about a page on ${domains[0]}`,
        entities: domains,
        metadata: {
          capturePolicy: 'browser_attention_v1',
          action,
          confidence: 0.15,
        },
        origin: 'interactive',
      });
    } catch (error) {
      console.warn('[browser-attention] weak interest capture failed:', error?.message || error);
      return null;
    }
  }

  const projectLabel = cleanLabel(event.projectLabel);
  const count = Math.max(1, Math.min(8, Number(event.count) || domains.length));
  const targetKind = ['tv', 'speaker'].includes(String(event.targetKind || '')) ? String(event.targetKind) : null;
  const statement = {
    compare: `Compared ${count} explicitly selected browser pages`,
    clip: `Saved browser research from ${domains[0]}${projectLabel ? ` to ${projectLabel}` : ''}`,
    handoff: `Sent browser context from ${domains[0]} to ${targetKind || 'a household device'}`,
    watch: `Created a field watch for ${domains[0]}`,
    teach: `Taught OE how to use ${domains[0]}`,
  }[action];
  return recordStructuredSignal({
    userId,
    type: action === 'handoff' ? 'outcome' : 'choice',
    statement,
    entities: [...domains, ...(projectLabel ? [projectLabel] : [])],
    metadata: {
      capturePolicy: 'browser_attention_v1',
      action,
      domainCount: domains.length,
      ...(targetKind ? { targetKind } : {}),
    },
    source: 'browser_attention',
    origin: 'interactive',
  });
}

export const __test = Object.freeze({ cleanDomain, uniqueDomains });
