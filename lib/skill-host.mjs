// @ts-check
/**
 * In-sandbox harness for custom (user-authored) skills. Runs as
 * `node lib/skill-host.mjs` INSIDE the bwrap jail built by skill-subprocess.mjs.
 *
 * stdio is an NDJSON-multiplexed channel (one JSON object per line) — robust
 * through bwrap with no fragile fd-passing:
 *   parent → child (stdin):  {t:'job', skillExecPath, toolName, args, userId, agentId}
 *                            {t:'rpc-result', id, ok, value|error}
 *   child → parent (stdout): {t:'rpc',   id, method, args}     ← a ctx call to broker
 *                            {t:'event', event}                ← a streamed yield
 *                            {t:'result', ok, result|error}    ← final, then exit
 *
 * ctx here is a thin PROXY: each capability turns into an `rpc` the parent
 * services (lib/skill-ctx-broker.mjs) with the enforced userId. The skill never
 * holds a live OE object. The sandbox already denies fs access to other users /
 * secrets; this denies privileged in-process capability the same way.
 */
import { pathToFileURL } from 'url';

// Keep stdout PURE for the protocol — a skill's stray console.log would corrupt
// the NDJSON stream. Route all console.* to stderr (diagnostics only).
const toErr = (...a) => process.stderr.write(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
const _con = /** @type {any} */ (console);
_con.log = toErr; _con.info = toErr; _con.warn = toErr; _con.error = toErr; _con.debug = toErr;

function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

// ── RPC plumbing (child side) ───────────────────────────────────────────────
let _rpcSeq = 0;
const _pendingRpc = new Map();
function rpc(method, args) {
  const id = `r${++_rpcSeq}`;
  return new Promise((resolve, reject) => {
    _pendingRpc.set(id, { resolve, reject });
    write({ t: 'rpc', id, method, args });
  });
}
function resolveRpc(id, ok, value, error) {
  const p = _pendingRpc.get(id);
  if (!p) return;
  _pendingRpc.delete(id);
  if (ok) p.resolve(value);
  else p.reject(new Error(error || 'ctx rpc failed'));
}

// ctx surface available to sandboxed skills — must mirror the broker allowlist.
function makeCtx(userId, agentId) {
  return {
    userId,
    agentId,
    toolError: (message) => ({ __toolError: true, message: String(message ?? '') }),
    log: {
      info:  (...a) => rpc('log', ['info', a.join(' ')]),
      warn:  (...a) => rpc('log', ['warn', a.join(' ')]),
      error: (...a) => rpc('log', ['error', a.join(' ')]),
    },
    credentials: {
      get:    (id) => rpc('credentials.get', [id]),
      set:    (id, value, meta) => rpc('credentials.set', [id, value, meta]),
      list:   () => rpc('credentials.list', []),
      delete: (id) => rpc('credentials.delete', [id]),
    },
  };
}

// ── job execution ────────────────────────────────────────────────────────────
let _ran = false;
async function runJob(job) {
  if (_ran) return; _ran = true;
  const { skillExecPath, toolName, args, userId, agentId } = job || {};
  if (!skillExecPath || !toolName) { write({ t: 'result', ok: false, error: 'job missing skillExecPath/toolName' }); process.exit(0); }

  let mod;
  try { mod = await import(pathToFileURL(skillExecPath).href); }
  catch (e) { write({ t: 'result', ok: false, error: `skill import failed: ${e?.message || e}` }); process.exit(0); }

  const fn = mod.default ?? mod.executeSkillTool ?? mod.execute;
  if (typeof fn !== 'function') { write({ t: 'result', ok: false, error: 'skill exports no executor function' }); process.exit(0); }

  const ctx = makeCtx(userId, agentId);
  try {
    const out = await fn(toolName, args, userId, agentId, ctx);
    if (out && typeof out === 'object' && typeof out[Symbol.asyncIterator] === 'function') {
      for await (const ev of out) write({ t: 'event', event: ev }); // forwarded live
      write({ t: 'result', ok: true, result: null });
    } else {
      write({ t: 'result', ok: true, result: out ?? null });
    }
  } catch (e) {
    write({ t: 'result', ok: false, error: e?.message || String(e) });
  }
  process.exit(0);
}

// ── stdin line reader: dispatch job + rpc-results ────────────────────────────
let _buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  _buf += chunk;
  let nl;
  while ((nl = _buf.indexOf('\n')) >= 0) {
    const line = _buf.slice(0, nl); _buf = _buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.t === 'job') runJob(msg);
    else if (msg.t === 'rpc-result') resolveRpc(msg.id, msg.ok, msg.value, msg.error);
  }
});
process.stdin.on('end', () => { if (!_ran) process.exit(0); });
