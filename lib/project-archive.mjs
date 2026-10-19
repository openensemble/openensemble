import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ARCHIVE_SKIP = ['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next',
  'dist', 'build', '.cache', '.turbo', '.parcel-cache', '.pytest_cache', '.run'];
const SCRIPT = fileURLToPath(new URL('../scripts/project-archive.py', import.meta.url));

/** Pin the authorized directory; the worker never follows descendant links. */
export async function createProjectArchive(projectDir, { identity, signal, maxBytes = 500 * 1024 ** 2 } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oe-coder-download-'));
  const file = path.join(dir, 'project.zip');
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true });
  let fd;
  try {
    signal?.throwIfAborted();
    fd = fs.openSync(projectDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || identity && identity !== `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`) {
      throw new Error('Project changed. Refresh and try again.');
    }
    await new Promise((resolve, reject) => {
      const child = spawn('python3', [SCRIPT, file, String(maxBytes), JSON.stringify(ARCHIVE_SKIP)], {
        stdio: ['ignore', 'ignore', 'pipe', fd], signal,
      });
      let error, detail = '';
      child.stderr.on('data', chunk => { detail = (detail + chunk).slice(-2000); });
      child.once('error', value => { error = value; });
      const timeout = setTimeout(() => { error = new Error('Project download timed out. Choose a smaller project.'); child.kill('SIGKILL'); }, 300000);
      child.once('close', code => {
        clearTimeout(timeout);
        if (error) reject(error);
        else if (code) reject(new Error(detail.trim() || 'Could not prepare the project download.'));
        else resolve();
      });
    });
    return { file, cleanup };
  } catch (error) { await cleanup(); throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
