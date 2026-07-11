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
    personalization: {
      confirmedPreferences: () => rpc('personalization.confirmedPreferences', []),
      confirmedPreferenceDetails: () => rpc('personalization.confirmedPreferenceDetails', []),
    },
    // Watchers/monitors. Registration crosses to the broker; unwatchMatching's
    // predicate is a function that can't be serialized, so we run it HERE over
    // the skill's own watcher list (fetched via rpc) and unwatch the matches.
    watch:          (opts) => rpc('watch', [opts]),
    unwatch:        (id) => rpc('unwatch', [id]),
    proposeMonitor: (opts) => rpc('proposeMonitor', [opts]),
    unwatchMatching: async (predicate) => {
      const list = await rpc('watchers.list', []);
      const arr = Array.isArray(list) ? list : [];
      let n = 0;
      for (const w of arr) {
        let match = false;
        try { match = !!predicate(w); } catch { match = false; }
        if (match) { await rpc('unwatch', [w.id]); n++; }
      }
      return n;
    },
    // External binary runtime (provision + run yt-dlp etc.) — brokered + clamped.
    ensureRuntime: (spec) => rpc('runtime.ensureRuntime', [spec]),
    runSandboxed:  (bin, binArgs, opts) => rpc('runtime.runSandboxed', [bin, binArgs, opts]),
  };
}

// Watcher-handler helpers surface — mirrors scheduler/watchers.mjs handlerHelpers,
// but each method RPCs to the parent (which runs the REAL helper bound to the
// watcher record). userId/agentId/watcherId are plain props supplied in the job.
function makeHelpers(userId, agentId, watcherId) {
  return {
    userId, agentId, watcherId,
    fire:       (arg) => rpc('helper.fire', [arg]),
    fireAgent:  (arg) => rpc('helper.fireAgent', [arg]),
    showVideo:  (vid) => rpc('helper.showVideo', [vid]),
    showImage:  (img) => rpc('helper.showImage', [img]),
    postStatus: (text) => rpc('helper.postStatus', [text]),
    notify:     (content, opts) => rpc('helper.notify', [content, opts]),
    credentials: {
      get:    (id) => rpc('helper.credentials.get', [id]),
      set:    (id, value, meta) => rpc('helper.credentials.set', [id, value, meta]),
      list:   () => rpc('helper.credentials.list', []),
      delete: (id) => rpc('helper.credentials.delete', [id]),
    },
    personalization: {
      confirmedPreferences: () => rpc('helper.personalization.confirmedPreferences', []),
      confirmedPreferenceDetails: () => rpc('helper.personalization.confirmedPreferenceDetails', []),
    },
    ensureRuntime: (spec) => rpc('helper.ensureRuntime', [spec]),
    runSandboxed:  (bin, binArgs, opts) => rpc('helper.runSandboxed', [bin, binArgs, opts]),
  };
}

// ── job execution ────────────────────────────────────────────────────────────
let _ran = false;
function hardenImmutableSnapshotRuntime() {
  const denied = () => { throw new Error('runtime code loading is disabled for approved skill snapshots'); };
  // Static imports are allowlisted before the snapshot is materialized. Remove
  // process-level escape hatches that could recover module/vm/subprocess loaders
  // without an import edge, and prevent mutable state from supplying executable
  // WebAssembly after approval.
  for (const name of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen']) {
    try {
      Object.defineProperty(process, name, {
        value: denied, writable: false, configurable: false, enumerable: false,
      });
    } catch {}
  }
  try {
    Object.defineProperty(globalThis, 'WebAssembly', {
      value: undefined, writable: false, configurable: false,
    });
  } catch {}
}

async function runJob(job) {
  if (_ran) return; _ran = true;
  const { mode = 'tool', skillExecPath, userId, agentId } = job || {};
  if (!skillExecPath) { write({ t: 'result', ok: false, error: 'job missing skillExecPath' }); process.exit(0); }
  if (job?.immutableSnapshot === true) hardenImmutableSnapshotRuntime();

  let mod;
  try { mod = await import(pathToFileURL(skillExecPath).href); }
  catch (e) { write({ t: 'result', ok: false, error: `skill import failed: ${e?.message || e}` }); process.exit(0); }

  // Authoring smoke: run the whole per-tool smoke IN the jail. The smoke's
  // stub ctx is self-contained (no parent RPCs), so freshly-written code
  // never executes in the OE process and never sees real credentials/env.
  // lib/ is bound read-only in the jail, so the shared logic imports fine.
  if (mode === 'smoke') {
    try {
      const { smokeModule } = await import(new URL('./skill-smoke.mjs', import.meta.url).href);
      const report = await smokeModule(mod, job.manifest);
      write({ t: 'result', ok: true, result: report });
    } catch (e) {
      write({ t: 'result', ok: false, error: e?.message || String(e) });
    }
    process.exit(0);
  }

  // Watcher firing: run the named watcherHandlers[kind] in the jail.
  if (mode === 'watcher') {
    const { kind, state, watcherId } = job;
    const h = (mod.watcherHandlers || {})[kind];
    if (typeof h !== 'function') { write({ t: 'result', ok: false, error: `skill has no watcherHandler for kind "${kind}"` }); process.exit(0); }
    try {
      const result = await h(state, makeHelpers(userId, agentId, watcherId));
      write({ t: 'result', ok: true, result: result ?? null }); // {newState,textUpdate,done,…}
    } catch (e) {
      write({ t: 'result', ok: false, error: e?.message || String(e) });
    }
    process.exit(0);
  }

  // Tool call (default).
  const { toolName, args } = job;
  if (!toolName) { write({ t: 'result', ok: false, error: 'job missing toolName' }); process.exit(0); }
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
