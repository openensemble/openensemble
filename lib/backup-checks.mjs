import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveWriteTargetSync } from './write-target.mjs';
import { BACKUP_MAX_BYTES, BACKUP_VERIFIER_VERSION } from './backup-policy.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/backup-check.mjs', import.meta.url));
const active = new Map();
const metadataRoot = base => resolveWriteTargetSync(path.join(base, '.backup-meta'));
const statusPath = base => path.join(metadataRoot(base), 'verification-status.json');
function checkError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function publicError(error) {
  if (String(error?.code || '').startsWith('BACKUP_')) return error;
  const text = String(error?.message || error);
  if (/Password is required/.test(text)) return checkError('BACKUP_PASSWORD_REQUIRED', 'Enter the archive password and try again.');
  if (/password|Encrypted backup|encrypt/i.test(text)) return checkError('BACKUP_PASSWORD', 'The password is incorrect or the encrypted archive is damaged.');
  if (/changed during|Data changed/.test(text)) return checkError('BACKUP_CHANGED', 'Saved data changed during the check. Pause active work and retry.');
  if (/exceeds|too large|too many|too deep|restore limit|ENAMETOOLONG/.test(text)) return checkError('BACKUP_LIMIT', 'The backup exceeds a size, entry or nesting limit. Use an offline backup for larger installations.', 413);
  if (/symbolic link|special file|Archive links|Unsafe archive|Duplicate or oversized/.test(text)) return checkError('BACKUP_UNSAFE', 'The backup contains an unsafe path, unsupported link or special file. Export a fresh backup after reviewing saved files.');
  if (/inventory mismatch|changed during verification/.test(text)) return checkError('BACKUP_MISMATCH', 'The restored files did not match the archive. No verification was recorded.');
  if (/no user profiles|no owner|missing config|profile identity|encryption key/.test(text)) return checkError('BACKUP_STATE', 'The backup is missing valid account, configuration or encryption-key data. Export a fresh backup from a working installation.');
  return checkError('BACKUP_INVALID', 'The backup could not be verified. Check that it is a complete OpenEnsemble archive and retry.');
}

export async function getBackupStatus(base, sha256 = null) {
  let state = {};
  try {
    const stat = await fs.promises.stat(statusPath(base));
    if (stat.size > 65536) throw new Error('Oversized status');
    state = JSON.parse(await fs.promises.readFile(statusPath(base), 'utf8'));
    if (!state || Array.isArray(state) || typeof state !== 'object') throw new Error('Invalid status');
    if (state.lastSuccess && (typeof state.lastSuccess.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(state.lastSuccess.sha256)
      || state.lastSuccess.scope !== 'disposable-restore' || !Number.isInteger(state.lastSuccess.verifierVersion)
      || !Number.isFinite(Date.parse(state.lastSuccess.verifiedAt)) || !Number.isInteger(state.lastSuccess.archiveBytes)
      || state.lastSuccess.archiveBytes < 10 || state.lastSuccess.archiveBytes > BACKUP_MAX_BYTES)) throw new Error('Invalid receipt');
    if (state.latest && (!['preflight', 'verify', 'export'].includes(state.latest.kind)
      || !['running', 'blocked', 'succeeded', 'failed', 'cancelled'].includes(state.latest.state))) throw new Error('Invalid operation status');
  } catch (error) {
    if (error.code !== 'ENOENT') throw checkError('BACKUP_STATUS', 'Saved backup-check status could not be read. Run a new check to replace it.', 503);
  }
  const lastSuccess = state.lastSuccess?.verifierVersion === BACKUP_VERIFIER_VERSION ? state.lastSuccess : null;
  const latest = state.latest?.state === 'running' && !active.has(path.resolve(base))
    ? { ...state.latest, state: 'interrupted', message: 'The previous check was interrupted. Run it again.' } : state.latest || null;
  return { verifierVersion: BACKUP_VERIFIER_VERSION, lastSuccess, latest,
    matches: !!(sha256 && /^[a-f0-9]{64}$/.test(sha256) && lastSuccess?.sha256 === sha256) };
}

async function saveStatus(base, value) {
  const root = metadataRoot(base);
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const file = statusPath(base), temporary = file + '.tmp';
  await fs.promises.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.promises.rename(temporary, file);
}

export async function getBackupAttention(base) {
  const { latest } = await getBackupStatus(base);
  if (!latest || !['failed', 'blocked', 'cancelled', 'interrupted'].includes(latest.state)) return [];
  return [{ id: 'backup-check', severity: latest.state === 'failed' || latest.state === 'blocked' ? 'warning' : 'info',
    title: latest.kind === 'preflight' ? 'Backup needs review' : 'Backup verification did not complete',
    message: latest.message, updatedAt: latest.finishedAt || latest.startedAt, action: 'backup' }];
}

function runCheck(input, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const grouped = process.platform !== 'win32';
    const child = spawn(process.execPath, ['--max-old-space-size=512', SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: grouped,
    });
    let output = '', failure;
    const stop = error => {
      failure ||= error;
      // Only signal the new process group created for this exact child.
      try { if (grouped && child.pid > 1) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    };
    const abort = () => stop(checkError('BACKUP_CANCELLED', 'Backup check cancelled.', 499));
    const timer = setTimeout(() => stop(checkError('BACKUP_TIMEOUT', 'The backup check timed out. Use an offline backup for larger installations.', 408)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 65536) stop(checkError('BACKUP_OUTPUT', 'The backup check returned an invalid result.', 500));
    });
    child.stderr.resume(); // Never expose filenames, contents or passwords in diagnostics.
    child.stdin.on('error', () => {});
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      try {
        const message = JSON.parse(output);
        if (code || message.error) reject(new Error(message.error || 'Backup check failed.'));
        else resolve(message.result);
      } catch { reject(new Error('Backup check failed.')); }
    });
    child.stdin.end(JSON.stringify(input));
    if (signal?.aborted) abort();
  });
}

async function performCheck(base, kind, { signal, password = '', input, timeoutMs = 600000 } = {}) {
  const key = path.resolve(base);
  if (active.has(key)) throw checkError('BACKUP_BUSY', 'Another backup check is running. Wait for it to finish or cancel it.', 409);
  if (typeof password !== 'string' || password.length > 4096) throw checkError('BACKUP_PASSWORD', 'The backup password is too long.');
  active.set(key, true);
  const callerSignal = signal, controller = new AbortController();
  const forwardAbort = () => controller.abort(callerSignal.reason);
  callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  if (callerSignal?.aborted) forwardAbort();
  const deadline = setTimeout(() => controller.abort(checkError('BACKUP_TIMEOUT', 'The backup check timed out. Use an offline backup for larger installations.', 408)), timeoutMs);
  signal = controller.signal;
  let workspace, keep = false;
  const previous = await getBackupStatus(base).catch(() => ({ lastSuccess: null }));
  const latest = { kind, state: 'running', startedAt: new Date().toISOString() };
  try {
    signal?.throwIfAborted();
    await saveStatus(base, { lastSuccess: previous.lastSuccess, latest });
    workspace = await fs.promises.mkdtemp(path.join(metadataRoot(base), 'check-'));
    if (input) {
      let size = 0;
      const cap = new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length;
        done(size > BACKUP_MAX_BYTES ? checkError('BACKUP_LIMIT', 'Archive exceeds the 500 MiB limit.', 413) : null, chunk);
      } });
      await pipeline(input, cap, fs.createWriteStream(path.join(workspace, 'input'), { flags: 'wx', mode: 0o600 }), { signal });
    }
    const result = await runCheck({ action: kind, base, workspace, password }, signal, timeoutMs);
    signal?.throwIfAborted();
    latest.finishedAt = new Date().toISOString();
    latest.state = result.canExport === false ? 'blocked' : 'succeeded';
    latest.message = latest.state === 'blocked' ? 'Preflight found saved files that need review before export.' : kind === 'preflight' ? 'Preflight completed.' : 'Disposable restore and file comparison completed.';
    await saveStatus(base, { lastSuccess: result.receipt || previous.lastSuccess, latest });
    if (kind === 'export') {
      // Child output is trusted code, but keep cleanup/streaming confined anyway.
      if (!result.archive?.startsWith(workspace + path.sep)) throw checkError('BACKUP_OUTPUT', 'The backup check returned an invalid result.', 500);
      keep = true;
      return { ...result, cleanup: () => fs.promises.rm(workspace, { recursive: true, force: true }) };
    }
    return result;
  } catch (error) {
    const safe = signal?.aborted ? signal.reason?.code === 'BACKUP_TIMEOUT' ? signal.reason : checkError('BACKUP_CANCELLED', 'Backup check cancelled.', 499) : publicError(error);
    latest.state = safe.code === 'BACKUP_CANCELLED' ? 'cancelled' : 'failed';
    latest.message = safe.message; latest.finishedAt = new Date().toISOString();
    await saveStatus(base, { lastSuccess: previous.lastSuccess, latest }).catch(() => {});
    throw safe;
  } finally {
    clearTimeout(deadline);
    callerSignal?.removeEventListener('abort', forwardAbort);
    try { if (workspace && !keep) await fs.promises.rm(workspace, { recursive: true, force: true }); }
    finally { active.delete(key); }
  }
}

export const preflightBackup = (base, options) => performCheck(base, 'preflight', options);
export const verifyBackupUpload = (base, input, options = {}) => performCheck(base, 'verify', { ...options, input });
export const createVerifiedBackup = (base, options) => performCheck(base, 'export', options);
