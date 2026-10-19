import { spawn } from 'node:child_process';

// Never include argv, environment, or stdin in errors: these processes can
// carry credentials. Callers translate stderr into a bounded public error.
export function runShareCommand(command, args, { env, input, timeout = 15000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure;
    const timer = setTimeout(() => {
      failure = Object.assign(new Error('Share operation timed out.'), { code: 'TIMEOUT' });
      child.kill('SIGKILL');
    }, timeout);
    const collect = (key, chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        failure = Object.assign(new Error('Share response is too large. Open a smaller folder.'), { code: 'LIMIT' });
        child.kill('SIGKILL');
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
