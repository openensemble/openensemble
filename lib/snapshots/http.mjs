/**
 * `http` mechanism — operations expressed as fetch calls.
 *
 * opSpec shape:
 *   {
 *     mechanism: 'http',
 *     parameters: { ... },                     // user-facing tool parameters
 *     write:       { method, url, headers?, body?, timeout_ms? },  // the actual operation
 *     pre_capture: { method, url, headers?, timeout_ms? },         // optional read endpoint that mirrors the write
 *     inverse:     { method, url, headers?, body?, timeout_ms? }   // optional inverse for rollback
 *   }
 *
 * On capture: GET pre_capture (if defined), save response as op_<id>.pre.json.
 *             Audit-only — rollback uses inverse_call, not the snapshot.
 * On execute: send write, return response.
 * On restore: send rollback.inverse_call from the record.
 *
 * If neither pre_capture nor inverse is defined, the dispatcher will mark
 * the op rollback.available=false / method=manual.
 */

import { writeSnapshotFile } from './util.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

async function doFetch(call, ctx) {
  const fetchFn = ctx.fetchFn || globalThis.fetch;
  if (!fetchFn) throw new Error('no fetch implementation available');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), call.timeout_ms || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(call.url, {
      method: call.method || 'GET',
      headers: call.headers || {},
      body: call.body ?? undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let headers = {};
    try { headers = Object.fromEntries(res.headers?.entries?.() ?? []); } catch {}
    return { status: res.status, ok: res.ok, headers, body: text };
  } finally {
    clearTimeout(timer);
  }
}

export const http = {
  name: 'http',

  // HTTP imposes no risk floor of its own — profile-declared risk wins.
  minimumRisk() { return 'low'; },

  async capture(opSpec, ctx) {
    if (!opSpec.pre_capture) return [];
    const res = await doFetch(opSpec.pre_capture, ctx);
    const payload = JSON.stringify({ pre_capture: opSpec.pre_capture, response: res });
    const file = writeSnapshotFile(ctx.userId, ctx.nodeId, ctx.opId, 'pre.json', payload);
    return [{
      type: 'http_response',
      stored_at: file,
      size_bytes: Buffer.byteLength(payload),
      metadata: { url: opSpec.pre_capture.url, status: res.status },
    }];
  },

  async execute(opSpec, ctx) {
    if (!opSpec.write) throw new Error('http.execute: opSpec.write missing');
    const res = await doFetch(opSpec.write, ctx);
    return {
      exit_code: res.ok ? 0 : 1,
      mechanism_response: { status: res.status, body_excerpt: res.body.slice(0, 500) },
    };
  },

  async restore(record, ctx) {
    const inv = record.rollback?.inverse_call;
    if (!inv) return { outcome: 'failure', message: 'no inverse_call recorded' };
    const res = await doFetch(inv, ctx);
    if (!res.ok) {
      return { outcome: 'failure', message: `inverse ${inv.method || 'GET'} ${inv.url} → ${res.status}: ${res.body.slice(0, 200)}` };
    }
    return { outcome: 'success', message: `inverse ${inv.method || 'GET'} ${inv.url} → ${res.status}` };
  },

  async validate(record) {
    if (!record.rollback?.inverse_call) {
      return { valid: false, reason: 'no inverse_call recorded' };
    }
    return { valid: true };
  },
};
