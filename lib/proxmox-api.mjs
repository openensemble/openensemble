/**
 * Minimal Proxmox VE REST API client — just the snapshot operations OE needs
 * for the host_snapshot rollback layer.
 *
 * Auth: API token. Tokens are scoped to specific privileges in PVE; the OE
 * token only needs VM.Snapshot + VM.Snapshot.Rollback on the target VMID.
 *
 * Token format on the wire: `PVEAPIToken=user@realm!tokenid=secret-uuid`
 * Callers should store this fully-formed string in token storage; this module
 * only does the auth-header substitution.
 *
 * Async ops: PVE returns a UPID (task id); the actual snapshot/rollback runs
 * on the host. This module polls task status by default so callers see a
 * synchronous result.
 */

const DEFAULT_TASK_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

function authHeader(opts) {
  // Caller stored 'PVEAPIToken=user@realm!id=uuid' or similar; pass through.
  // Allow callers to provide just the token body too.
  const tok = String(opts.api_token || '');
  if (tok.startsWith('PVEAPIToken=')) return tok;
  return `PVEAPIToken=${tok}`;
}

async function call(opts, p, init = {}) {
  if (!opts.api_url) throw new Error('proxmox: api_url required');
  if (!opts.api_token) throw new Error('proxmox: api_token required');
  const fetchFn = opts.fetchFn || globalThis.fetch;
  if (!fetchFn) throw new Error('proxmox: no fetch implementation available');

  const url = `${opts.api_url.replace(/\/+$/, '')}/api2/json${p}`;
  const headers = {
    Authorization: authHeader(opts),
    Accept: 'application/json',
    ...init.headers,
  };
  if (init.method && init.method !== 'GET' && !headers['Content-Type'] && init.body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const res = await fetchFn(url, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`proxmox ${init.method || 'GET'} ${p} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`proxmox ${p}: non-JSON response`); }
  return json.data;
}

function basePath(opts) {
  if (!opts.node)  throw new Error('proxmox: node required (e.g. "pve01")');
  if (!opts.vmid)  throw new Error('proxmox: vmid required');
  if (!opts.kind || !['lxc', 'qemu'].includes(opts.kind)) {
    throw new Error(`proxmox: kind must be "lxc" or "qemu", got "${opts.kind}"`);
  }
  return `/nodes/${opts.node}/${opts.kind}/${opts.vmid}`;
}

export async function waitForTask(opts, upid, timeoutMs = DEFAULT_TASK_TIMEOUT_MS) {
  if (!opts.node) throw new Error('proxmox: node required for task polling');
  const deadline = Date.now() + timeoutMs;
  // PVE task status path: /nodes/<node>/tasks/<upid>/status
  while (Date.now() < deadline) {
    const status = await call(opts, `/nodes/${opts.node}/tasks/${encodeURIComponent(upid)}/status`);
    if (status?.status === 'stopped') {
      if (status.exitstatus && status.exitstatus !== 'OK') {
        throw new Error(`proxmox task ${upid} failed: ${status.exitstatus}`);
      }
      return status;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`proxmox task ${upid} timed out after ${timeoutMs}ms`);
}

export async function createSnapshot(opts, snapname, description = '') {
  const body = new URLSearchParams({ snapname });
  if (description) body.set('description', description);
  // vmstate=1 (qemu only) snapshots RAM alongside disk so restore brings the
  // VM back to its exact in-flight state. LXC has no separate memory state
  // so the flag is meaningless there — silently ignored.
  if (opts.kind === 'qemu' && opts.vmstate) body.set('vmstate', '1');
  const upid = await call(opts, `${basePath(opts)}/snapshot`, {
    method: 'POST', body: body.toString(),
  });
  if (opts.waitForCompletion !== false) await waitForTask(opts, upid);
  return { snapname, upid };
}

export async function rollbackSnapshot(opts, snapname) {
  if (!snapname) throw new Error('proxmox: snapname required for rollback');
  const upid = await call(opts, `${basePath(opts)}/snapshot/${encodeURIComponent(snapname)}/rollback`, {
    method: 'POST',
  });
  if (opts.waitForCompletion !== false) await waitForTask(opts, upid);
  return { snapname, upid };
}

export async function deleteSnapshot(opts, snapname) {
  if (!snapname) throw new Error('proxmox: snapname required for delete');
  const upid = await call(opts, `${basePath(opts)}/snapshot/${encodeURIComponent(snapname)}`, {
    method: 'DELETE',
  });
  if (opts.waitForCompletion !== false) await waitForTask(opts, upid);
  return { snapname, upid };
}

export async function listSnapshots(opts) {
  const data = await call(opts, `${basePath(opts)}/snapshot`);
  return Array.isArray(data) ? data : [];
}
