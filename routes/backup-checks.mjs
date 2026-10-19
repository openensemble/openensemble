import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { requirePrivileged } from './_helpers.mjs';
import { BASE_DIR } from '../lib/paths.mjs';
import { BACKUP_MAX_BYTES } from '../lib/backup-policy.mjs';
import { preflightBackup, verifyBackupUpload, createVerifiedBackup, getBackupStatus } from '../lib/backup-checks.mjs';

const reply = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

export function createBackupCheckHandler({ base = BASE_DIR, authorize = requirePrivileged } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const mode = url.pathname === '/api/admin/backup' && ['GET', 'POST'].includes(req.method) ? 'export'
      : url.pathname === '/api/admin/backup/preflight' && req.method === 'GET' ? 'preflight'
      : url.pathname === '/api/admin/backup/status' && req.method === 'GET' ? 'status'
      : url.pathname === '/api/admin/backup/verify' && req.method === 'POST' ? 'verify' : null;
    if (!mode) return false;
    if (!authorize(req, res)) return true;
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    let bundle;
    try {
      const options = { signal: controller.signal };
      if (mode === 'status') {
        const sha256 = url.searchParams.get('sha256');
        if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) { reply(res, 400, { error: 'Invalid archive fingerprint.' }); return true; }
        reply(res, 200, await getBackupStatus(base, sha256));
      } else if (mode === 'preflight') {
        reply(res, 200, await preflightBackup(base, options));
      } else if (mode === 'verify') {
        if (Number(req.headers['content-length']) > BACKUP_MAX_BYTES) { reply(res, 413, { error: 'Archive exceeds the 500 MiB limit.' }); return true; }
        options.password = String(req.headers['x-restore-password'] || '');
        reply(res, 200, await verifyBackupUpload(base, req, options));
      } else {
        options.password = String(req.headers['x-backup-password'] || '');
        if (options.password && options.password.length < 6) { reply(res, 400, { error: 'Use at least 6 characters for a backup password.' }); return true; }
        bundle = await createVerifiedBackup(base, options);
        const receipt = bundle.receipt, date = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          'Content-Type': receipt.encrypted ? 'application/octet-stream' : 'application/gzip',
          'Content-Length': receipt.archiveBytes, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="openensemble-backup-${date}.${receipt.encrypted ? 'oeb' : 'tar.gz'}"`,
          'X-Content-Type-Options': 'nosniff', 'X-Backup-SHA256': receipt.sha256,
          'X-Backup-Verifier-Version': String(receipt.verifierVersion), 'X-Backup-Verified-At': receipt.verifiedAt,
          ...(receipt.encrypted ? { 'X-Backup-Encrypted': '1' } : {}),
        });
        await pipeline(fs.createReadStream(bundle.archive), res, { signal: controller.signal });
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) reply(res, error.status || 500, { error: String(error.code || '').startsWith('BACKUP_') ? error.message : 'Backup check failed. Try again.', code: error.code || 'BACKUP_FAILED' });
      else if (!res.writableEnded) res.destroy();
    } finally {
      res.off('close', cancel);
      await bundle?.cleanup();
    }
    return true;
  };
}

export const handle = createBackupCheckHandler();
