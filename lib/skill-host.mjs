// @ts-check
/**
 * In-sandbox harness for custom (user-authored) skills. Runs as
 * `node lib/skill-host.mjs` INSIDE the bwrap jail built by skill-subprocess.mjs,
 * with only the owning user's data folders + the skill's own dir/state mounted —
 * no other users' data, no token files, no config.json, no master key.
 *
 * Protocol: a single job JSON arrives on stdin; a single result JSON leaves on
 * stdout. stderr is free-form (skill console output / diagnostics).
 *   in : { skillExecPath, toolName, args, userId, agentId }
 *   out: { ok:true, result } | { ok:true, stream:[events] } | { ok:false, error }
 *
 * The ctx here is a Phase-2 STUB. Phase 3 swaps it for an RPC bridge (over an
 * extra fd) so ctx.showImage / ctx.credentials / ctx.watch reach the parent,
 * which runs them with the enforced userId. Until then, ctx capability methods
 * are inert so a skill that only touches fs (the common case) runs unchanged.
 */
import { pathToFileURL } from 'url';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

function send(obj) {
  // One line, one result. Parent reads stdout to EOF then JSON.parse.
  process.stdout.write(JSON.stringify(obj));
}

/**
 * Phase-2 stub ctx. Real (Phase 3) ctx brokers these to the parent over IPC.
 * Methods are intentionally inert rather than throwing, so a skill that calls
 * e.g. ctx.log on a path we haven't wired yet doesn't crash mid-tool.
 */
function makeStubCtx(userId, agentId) {
  const notWired = (name) => async () => {
    process.stderr.write(`[skill-host] ctx.${name} is not yet brokered into the sandbox (Phase 3)\n`);
    return null;
  };
  return {
    userId,
    agentId,
    // toolError returns a recognizable marker the parent maps to a failed tool.
    toolError: (message) => ({ __toolError: true, message: String(message ?? '') }),
    log: {
      info: (...a) => process.stderr.write(`[skill] ${a.join(' ')}\n`),
      warn: (...a) => process.stderr.write(`[skill] ${a.join(' ')}\n`),
      error: (...a) => process.stderr.write(`[skill] ${a.join(' ')}\n`),
    },
    showImage: notWired('showImage'),
    showVideo: notWired('showVideo'),
    watch: notWired('watch'),
    unwatch: notWired('unwatch'),
    proposeMonitor: notWired('proposeMonitor'),
    credentials: { get: notWired('credentials.get'), request: notWired('credentials.request') },
  };
}

async function main() {
  let job;
  try {
    job = JSON.parse(await readStdin());
  } catch (e) {
    send({ ok: false, error: `bad job payload: ${e?.message || e}` });
    return;
  }
  const { skillExecPath, toolName, args, userId, agentId } = job || {};
  if (!skillExecPath || !toolName) { send({ ok: false, error: 'job missing skillExecPath/toolName' }); return; }

  let mod;
  try {
    mod = await import(pathToFileURL(skillExecPath).href);
  } catch (e) {
    send({ ok: false, error: `skill import failed: ${e?.message || e}` });
    return;
  }
  const fn = mod.default ?? mod.executeSkillTool ?? mod.execute;
  if (typeof fn !== 'function') { send({ ok: false, error: 'skill exports no executor function' }); return; }

  const ctx = makeStubCtx(userId, agentId);
  try {
    const out = await fn(toolName, args, userId, agentId, ctx);
    if (out && typeof out === 'object' && typeof out[Symbol.asyncIterator] === 'function') {
      // Streaming executor: drain to events. (Real-time forwarding = Phase 3.)
      const events = [];
      for await (const ev of out) events.push(ev);
      send({ ok: true, stream: events });
    } else {
      send({ ok: true, result: out ?? null });
    }
  } catch (e) {
    send({ ok: false, error: e?.message || String(e) });
  }
}

main().catch((e) => { try { send({ ok: false, error: `host crash: ${e?.message || e}` }); } catch {} });
