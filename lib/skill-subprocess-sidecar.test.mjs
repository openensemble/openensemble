import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachSandboxWireReader,
  createSandboxWireWriter,
} from './skill-sandbox-wire.mjs';
import {
  SKILL_SANDBOX_SOCKET_ENV,
  runSandboxedJob,
} from './skill-subprocess.mjs';

const cleanup = [];
const originalSocket = process.env[SKILL_SANDBOX_SOCKET_ENV];

async function fakeRunner(onRun) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-product-skill-runner-'));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 'runner.sock');
  const server = net.createServer(socket => {
    const writer = createSandboxWireWriter(socket, { onError: error => socket.destroy(error) });
    const detach = attachSandboxWireReader(socket, {
      onError: error => socket.destroy(error),
      onMessage: message => {
        if (message?.t !== 'run') { socket.destroy(); return; }
        onRun(message);
        writer.send({ t: 'result', ok: true, result: { mode: message.jobPayload.mode } });
        writer.end();
      },
    });
    socket.once('close', detach);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  cleanup.push(async () => {
    await new Promise(resolve => server.close(() => resolve(undefined)));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return socketPath;
}

afterEach(async () => {
  if (originalSocket == null) delete process.env[SKILL_SANDBOX_SOCKET_ENV];
  else process.env[SKILL_SANDBOX_SOCKET_ENV] = originalSocket;
  while (cleanup.length) await cleanup.pop()();
});

describe('product custom-skill sidecar client', () => {
  it('routes an exported-function job over the configured private socket', async () => {
    let observed;
    const socketPath = await fakeRunner(message => { observed = message; });
    process.env[SKILL_SANDBOX_SOCKET_ENV] = socketPath;
    const result = await runSandboxedJob({
      userId: 'user_sidecar_product',
      skillId: 'sidecar-product',
      jobPayload: {
        t: 'job', mode: 'exported_function',
        skillExecPath: '/runner/reconstructs/this',
        functionName: 'listAliasEntries',
      },
      handleRpc: async () => null,
      net: false,
      timeoutMs: 2_000,
    });

    expect(result).toEqual({ ok: true, result: { mode: 'exported_function' }, stderr: '' });
    expect(observed).toMatchObject({
      t: 'run', version: 1,
      userId: 'user_sidecar_product',
      skillId: 'sidecar-product',
      requestedNet: false,
      jobPayload: { mode: 'exported_function', functionName: 'listAliasEntries' },
    });
  });

  it('fails closed when a configured runner socket is absent', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-product-skill-runner-'));
    fs.chmodSync(directory, 0o700);
    cleanup.push(async () => fs.rmSync(directory, { recursive: true, force: true }));
    process.env[SKILL_SANDBOX_SOCKET_ENV] = path.join(directory, 'missing.sock');

    await expect(runSandboxedJob({
      userId: 'user_sidecar_missing',
      skillId: 'sidecar-missing',
      jobPayload: { t: 'job', mode: 'tool' },
      handleRpc: async () => null,
      timeoutMs: 500,
    })).rejects.toThrow(/runner socket is unavailable/);
  });
});
