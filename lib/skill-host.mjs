// @ts-check
/**
 * Direct in-jail harness for copied first-party custom skills.
 *
 * `node lib/skill-host.mjs` runs inside the Bubblewrap jail assembled by
 * skill-subprocess.mjs. The skill is trusted first-party code, while Bubblewrap
 * and the dedicated sidecar keep its filesystem/environment/network view
 * separate from stock OE and other users. ctx/helper capabilities remain
 * brokered over one bounded NDJSON channel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBinaryInsideSkillJail } from './skill-jail-runtime.mjs';
import {
  SKILL_SANDBOX_MAX_FRAME_BYTES,
  attachSandboxWireReader,
} from './skill-sandbox-wire.mjs';

// An explicit fd stream works even on runtimes that classify inherited stdin
// as UNKNOWN, and the shared reader preserves UTF-8 split across pipe chunks.
const input = fs.createReadStream(null, { fd: 0, autoClose: false });
const output = fs.createWriteStream(null, { fd: 1, autoClose: false });
const diagnostics = fs.createWriteStream(null, { fd: 2, autoClose: false });

const toErr = (...args) => {
  try {
    diagnostics.write(args.map(value => (
      typeof value === 'string' ? value : JSON.stringify(value)
    )).join(' ') + '\n');
  } catch {
    try { diagnostics.write('[skill diagnostic was not serializable]\n'); } catch {}
  }
};
const hostConsole = /** @type {any} */ (console);
hostConsole.log = toErr;
hostConsole.info = toErr;
hostConsole.warn = toErr;
hostConsole.error = toErr;
hostConsole.debug = toErr;

// Serialize writes and wait for the stream callback. This honors ordinary
// pipe backpressure without adding a second protocol/security layer.
let outputTail = Promise.resolve();
function write(message) {
  let frame;
  try { frame = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'); }
  catch { return Promise.reject(new Error('skill sandbox protocol payload is not serializable')); }
  if (frame.length > SKILL_SANDBOX_MAX_FRAME_BYTES) {
    return Promise.reject(new Error(
      `skill sandbox protocol frame exceeds ${SKILL_SANDBOX_MAX_FRAME_BYTES} bytes`,
    ));
  }
  const operation = outputTail.then(() => new Promise((resolve, reject) => {
    try {
      output.write(frame, error => error ? reject(error) : resolve(undefined));
    } catch (error) { reject(error); }
  }));
  outputTail = operation.catch(() => {});
  return operation;
}

let terminalSent = false;
function terminateHost() {
  if (process.platform !== 'win32') {
    try { process.kill(process.pid, 'SIGKILL'); return; } catch {}
  }
  process.exit(0);
}
async function finish(message) {
  if (terminalSent) return;
  terminalSent = true;
  try { await write(message); }
  catch (error) {
    try { diagnostics.write(`skill protocol write failed: ${error?.message || error}\n`); } catch {}
  }
  output.end(terminateHost);
}

let rpcSequence = 0;
const pendingRpc = new Map();
function rpc(method, args) {
  const id = `r${++rpcSequence}`;
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    write({ t: 'rpc', id, method, args }).catch(error => {
      pendingRpc.delete(id);
      reject(error);
    });
  });
}

function resolveRpc(message) {
  const pending = pendingRpc.get(message?.id);
  if (!pending) return;
  pendingRpc.delete(message.id);
  if (message.ok) pending.resolve(message.value);
  else pending.reject(new Error(message.error || 'ctx rpc failed'));
}

function makeCtx(userId, agentId, skillDir, runnerOwnsSandbox) {
  return {
    userId,
    agentId,
    toolError: (message) => ({ __toolError: true, message: String(message ?? '') }),
    log: {
      info: (...args) => rpc('log', ['info', args.join(' ')]),
      warn: (...args) => rpc('log', ['warn', args.join(' ')]),
      error: (...args) => rpc('log', ['error', args.join(' ')]),
    },
    credentials: {
      get: (id) => rpc('credentials.get', [id]),
      set: (id, value, meta) => rpc('credentials.set', [id, value, meta]),
      list: () => rpc('credentials.list', []),
      delete: (id) => rpc('credentials.delete', [id]),
    },
    personalization: {
      confirmedPreferences: () => rpc('personalization.confirmedPreferences', []),
      confirmedPreferenceDetails: () => rpc('personalization.confirmedPreferenceDetails', []),
    },
    watch: (opts) => rpc('watch', [opts]),
    unwatch: (id) => rpc('unwatch', [id]),
    proposeMonitor: (opts) => rpc('proposeMonitor', [opts]),
    unwatchMatching: async (predicate) => {
      const list = await rpc('watchers.list', []);
      const watchers = Array.isArray(list) ? list : [];
      let removed = 0;
      for (const watcher of watchers) {
        let match = false;
        try { match = !!predicate(watcher); } catch {}
        if (match) {
          await rpc('unwatch', [watcher.id]);
          removed++;
        }
      }
      return removed;
    },
    ensureRuntime: (spec) => rpc('runtime.ensureRuntime', [spec]),
    runSandboxed: runnerOwnsSandbox
      ? (bin, binArgs, opts) => runBinaryInsideSkillJail(skillDir, bin, binArgs, opts)
      : (bin, binArgs, opts) => rpc('runtime.runSandboxed', [bin, binArgs, opts]),
  };
}

function makeHelpers(userId, agentId, watcherId, skillDir, runnerOwnsSandbox) {
  return {
    userId,
    agentId,
    watcherId,
    fire: (arg) => rpc('helper.fire', [arg]),
    fireAgent: (arg) => rpc('helper.fireAgent', [arg]),
    showVideo: (video) => rpc('helper.showVideo', [video]),
    showImage: (image) => rpc('helper.showImage', [image]),
    postStatus: (text) => rpc('helper.postStatus', [text]),
    notify: (content, opts) => rpc('helper.notify', [content, opts]),
    credentials: {
      get: (id) => rpc('helper.credentials.get', [id]),
      set: (id, value, meta) => rpc('helper.credentials.set', [id, value, meta]),
      list: () => rpc('helper.credentials.list', []),
      delete: (id) => rpc('helper.credentials.delete', [id]),
    },
    personalization: {
      confirmedPreferences: () => rpc('helper.personalization.confirmedPreferences', []),
      confirmedPreferenceDetails: () => rpc('helper.personalization.confirmedPreferenceDetails', []),
    },
    ensureRuntime: (spec) => rpc('helper.ensureRuntime', [spec]),
    runSandboxed: runnerOwnsSandbox
      ? (bin, binArgs, opts) => runBinaryInsideSkillJail(skillDir, bin, binArgs, opts)
      : (bin, binArgs, opts) => rpc('helper.runSandboxed', [bin, binArgs, opts]),
  };
}

function hardenImmutableSnapshotRuntime() {
  const denied = () => { throw new Error('runtime code loading is disabled for approved skill snapshots'); };
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

let ran = false;
async function runJob(job) {
  if (ran) return;
  ran = true;
  const { mode = 'tool', skillExecPath, userId, agentId } = job || {};
  if (!skillExecPath) {
    await finish({ t: 'result', ok: false, error: 'job missing skillExecPath' });
    return;
  }
  if (job?.immutableSnapshot === true) hardenImmutableSnapshotRuntime();
  const skillDir = path.dirname(skillExecPath);
  const runnerOwnsSandbox = job?.runnerOwnsSandbox === true && job?.immutableSnapshot !== true;

  let mod;
  try { mod = await import(pathToFileURL(skillExecPath).href); }
  catch (error) {
    await finish({ t: 'result', ok: false, error: `skill import failed: ${error?.message || error}` });
    return;
  }

  if (mode === 'smoke') {
    try {
      const { smokeModule } = await import(new URL('./skill-smoke.mjs', import.meta.url).href);
      await finish({ t: 'result', ok: true, result: await smokeModule(mod, job.manifest) });
    } catch (error) {
      await finish({ t: 'result', ok: false, error: error?.message || String(error) });
    }
    return;
  }

  if (mode === 'watcher') {
    const { kind, state, watcherId } = job;
    const handler = (mod.watcherHandlers || {})[kind];
    if (typeof handler !== 'function') {
      await finish({
        t: 'result', ok: false, error: `skill has no watcherHandler for kind "${kind}"`,
      });
      return;
    }
    try {
      const result = await handler(
        state, makeHelpers(userId, agentId, watcherId, skillDir, runnerOwnsSandbox),
      );
      await finish({ t: 'result', ok: true, result: result ?? null });
    } catch (error) {
      await finish({ t: 'result', ok: false, error: error?.message || String(error) });
    }
    return;
  }

  // Read-only named export used by the alias-catalog framework. Custom skill
  // modules still load only inside the same bwrap boundary as their tools and
  // watchers; the parent process receives just the JSON-serializable result.
  if (mode === 'exported_function') {
    const functionName = String(job.functionName || '');
    if (!/^[A-Za-z_$][\w$]*$/.test(functionName)) {
      await finish({ t: 'result', ok: false, error: 'invalid exported function name' });
      return;
    }
    const fn = mod[functionName];
    if (typeof fn !== 'function') {
      await finish({
        t: 'result', ok: false,
        error: `skill has no exported function "${functionName}"`,
      });
      return;
    }
    try {
      const result = await fn(userId);
      await finish({ t: 'result', ok: true, result: result ?? null });
    } catch (error) {
      await finish({ t: 'result', ok: false, error: error?.message || String(error) });
    }
    return;
  }

  const { toolName, args } = job;
  if (!toolName) {
    await finish({ t: 'result', ok: false, error: 'job missing toolName' });
    return;
  }
  const execute = mod.default ?? mod.executeSkillTool ?? mod.execute;
  if (typeof execute !== 'function') {
    await finish({ t: 'result', ok: false, error: 'skill exports no executor function' });
    return;
  }

  try {
    const output = await execute(
      toolName, args, userId, agentId,
      makeCtx(userId, agentId, skillDir, runnerOwnsSandbox),
    );
    if (output && typeof output === 'object'
      && typeof output[Symbol.asyncIterator] === 'function') {
      for await (const event of output) await write({ t: 'event', event });
      await finish({ t: 'result', ok: true, result: null });
    } else {
      await finish({ t: 'result', ok: true, result: output ?? null });
    }
  } catch (error) {
    await finish({ t: 'result', ok: false, error: error?.message || String(error) });
  }
}

const detachInput = attachSandboxWireReader(input, {
  onMessage: message => {
    if (message?.t === 'job') {
      runJob(message).catch(error => finish({
        t: 'result', ok: false, error: error?.message || String(error),
      }));
    } else if (message?.t === 'rpc-result') {
      resolveRpc(message);
    }
  },
  onError: error => finish({ t: 'result', ok: false, error: error.message }),
});

input.once('end', () => {
  detachInput();
  if (!ran) terminateHost();
});
