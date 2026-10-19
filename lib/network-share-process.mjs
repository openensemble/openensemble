import { spawn } from 'node:child_process';

// Never include argv, environment, or stdin in errors: these processes can
// carry credentials. Callers translate stderr into a bounded public error.
export function runShareCommand(command, args, { env, input, timeout = 15000, maxBytes = 1024 * 1024, killGroup = false } = {}) {
  return new Promise((resolve, reject) => {
    const detached = killGroup && process.platform !== 'win32';
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached });
    let stdout = '', stderr = '', size = 0, failure;
    const stop = () => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* Already exited. */ }
      }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      failure = Object.assign(new Error('Share operation timed out.'), { code: 'TIMEOUT' });
      stop();
    }, timeout);
    const collect = (key, chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        failure = Object.assign(new Error('Share response is too large. Open a smaller folder.'), { code: 'LIMIT' });
        stop();
        return;
      }
      if (key === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error('Share command failed.'), { code: 'COMMAND', stderr }));
      else resolve(stdout);
    });
    child.stdin.end(input ?? '');
  });
}
