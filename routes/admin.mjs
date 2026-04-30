/**
 * Admin routes: /api/admin/activity, /api/admin/sessions/*,
 *               /api/admin/invite*, /api/invite/:token, /api/activity/me,
 *               /api/admin/backup
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import {
  requireAuth, requirePrivileged, getAuthToken, getSessionUserId,
  loadUsers, loadActivity, loadInvites, loadConfig, modifyConfig,
  modifyUsers, modifyInvites,
  hashPassword, validatePassword, createSession, clearUserSessions, readBody,
  getDefaultChildSafetyPrompt, safeId, getUserDir, safeError,
  CFG_PATH, USERS_PATH, ACTIVITY_DIR, NOTES_PATH, EXPENSES_DB, EXPENSE_GROUPS_PATH,
} from './_helpers.mjs';
import { getDefaultRoles } from '../roles.mjs';
import { listLogFiles, readLog } from '../logger.mjs';
import { getLanAddress } from '../discovery.mjs';
import {
  getCachedState as getUpdateState, checkForUpdate, isCleanForUpdate,
  applyUpdate, restartProcess,
} from '../lib/update.mjs';
import { broadcastToUsers } from '../ws-handler.mjs';

const BASE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Throttle for /api/admin/update/check — protects origin from refresh-spamming.
let _lastForcedCheckAt = 0;

// Shared file list for backup and restore — keeps them in sync automatically
const BACKUP_DATA_FILES = [
  'shared-notes.json',
  'invites.json',
  'expenses/transactions.json', 'expenses/groups.json',
];
const BACKUP_MEDIA_DIRS = ['memory-db', 'shared-docs'];

// Safe, secrets-free subset of config.json to carry through backup/restore.
// Owner/admin role→agent assignments live in config.skillAssignments; without
// this sidecar, restoring on a fresh box loses them and every role shows
// "unassigned" in Settings → Skills.
const OWNER_STATE_FILE = '.backup-meta/owner-state.json';
const OWNER_STATE_KEYS = ['skillAssignments'];

function writeOwnerStateSidecar() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'config.json'), 'utf8')); } catch { return false; }
  const out = {};
  for (const k of OWNER_STATE_KEYS) if (cfg[k] !== undefined) out[k] = cfg[k];
  if (!Object.keys(out).length) return false;
  const dir = path.join(BASE_DIR, '.backup-meta');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(BASE_DIR, OWNER_STATE_FILE), JSON.stringify(out, null, 2));
  return true;
}

// Owner/admin identity fields that live on config.json. On a first-run restore
// we clear these before applying the sidecar so the backup's owner is the sole
// owner — otherwise a fresh-install box would carry whatever owner marker the
// template left behind.
const OWNER_CONFIG_FIELDS = ['owner', 'ownerId', 'ownerUserId', 'ownerEmail'];

async function performRestore(raw, { clearOwnerConfig = false } = {}) {
  const RESTORE_MAX_UNCOMPRESSED = 5 * 1024 * 1024 * 1024; // 5 GB
  if (raw.length < 10) throw new Error('Empty or invalid archive');

  // Pre-scan uncompressed size to guard against zip bombs.
  const scan = spawn('tar', ['tzvf', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let scanOut = '', scanErr = '';
  scan.stdout.on('data', d => { scanOut += d.toString(); });
  scan.stderr.on('data', d => { scanErr += d.toString(); });
  scan.stdin.write(raw);
  scan.stdin.end();
  await new Promise((resolve, reject) => {
    scan.on('close', code => code === 0 ? resolve() : reject(new Error(`tar scan failed: ${scanErr}`)));
    scan.on('error', reject);
  });
  let totalUncompressed = 0;
  for (const line of scanOut.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 6) {
      const sz = parseInt(parts[2], 10);
      if (Number.isFinite(sz)) totalUncompressed += sz;
    }
  }
  if (totalUncompressed > RESTORE_MAX_UNCOMPRESSED) {
    throw new Error(`Archive too large when decompressed (${Math.round(totalUncompressed/1024/1024)} MB > ${RESTORE_MAX_UNCOMPRESSED/1024/1024} MB). Possible zip bomb.`);
  }

  const tmpDir = path.join(BASE_DIR, `.restore-tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const tarProc = spawn('tar', ['xzf', '-', '-C', tmpDir, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    tarProc.stderr.on('data', d => { stderr += d.toString(); });
    tarProc.stdin.write(raw);
    tarProc.stdin.end();
    await new Promise((resolve, reject) => {
      tarProc.on('close', code => code === 0 ? resolve() : reject(new Error(`tar failed: ${stderr}`)));
      tarProc.on('error', reject);
    });

    const validateExtracted = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Symlink detected in archive: ${entry.name}`);
        const real = fs.realpathSync(full);
        if (!real.startsWith(tmpDir)) throw new Error(`Path traversal detected in archive: ${entry.name}`);
        if (entry.isDirectory()) validateExtracted(full);
      }
    };
    validateExtracted(tmpDir);

    let restored = 0;
    for (const f of BACKUP_DATA_FILES) {
      const src = path.join(tmpDir, f);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(path.join(BASE_DIR, f)), { recursive: true });
        fs.copyFileSync(src, path.join(BASE_DIR, f));
        restored++;
      }
    }
    const usersBackup = path.join(tmpDir, 'users');
    if (fs.existsSync(usersBackup)) {
      fs.cpSync(usersBackup, path.join(BASE_DIR, 'users'), { recursive: true });
      restored++;
    }
    for (const dir of BACKUP_MEDIA_DIRS) {
      const src = path.join(tmpDir, dir);
      if (fs.existsSync(src)) {
        fs.cpSync(src, path.join(BASE_DIR, dir), { recursive: true });
        restored++;
      }
    }
    const ownerStateSrc = path.join(tmpDir, OWNER_STATE_FILE);
    if (fs.existsSync(ownerStateSrc) || clearOwnerConfig) {
      try {
        const cfgPath = path.join(BASE_DIR, 'config.json');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
        if (clearOwnerConfig) {
          for (const k of OWNER_CONFIG_FIELDS) delete cfg[k];
        }
        if (fs.existsSync(ownerStateSrc)) {
          const incoming = JSON.parse(fs.readFileSync(ownerStateSrc, 'utf8'));
          for (const k of OWNER_STATE_KEYS) if (incoming[k] !== undefined) cfg[k] = incoming[k];
          restored++;
        }
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      } catch (e) { console.error('[restore] owner-state merge failed:', e.message); }
    }

    const tmpTd = path.join(tmpDir, 'training-data');
    if (fs.existsSync(tmpTd)) {
      const tdDir = path.join(BASE_DIR, 'training-data');
      fs.mkdirSync(tdDir, { recursive: true });
      for (const f of fs.readdirSync(tmpTd)) {
        fs.copyFileSync(path.join(tmpTd, f), path.join(tdDir, f));
        restored++;
      }
    }

    return restored;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function readRestoreBody(req) {
  const RESTORE_MAX_COMPRESSED = 500 * 1024 * 1024;
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > RESTORE_MAX_COMPRESSED) {
      req.destroy();
      throw new Error(`Archive too large (>${RESTORE_MAX_COMPRESSED / 1024 / 1024} MB compressed)`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function collectBackupFiles() {
  const files = [];
  for (const f of BACKUP_DATA_FILES) {
    if (fs.existsSync(path.join(BASE_DIR, f))) files.push(f);
  }
  // users/ directory now contains everything per-user (profile, agents, sessions, cortex, tokens, etc.)
  if (fs.existsSync(path.join(BASE_DIR, 'users'))) files.push('users');
  for (const dir of BACKUP_MEDIA_DIRS) {
    if (fs.existsSync(path.join(BASE_DIR, dir))) files.push(dir);
  }
  if (writeOwnerStateSidecar()) files.push(OWNER_STATE_FILE);
  const tdDir = path.join(BASE_DIR, 'training-data');
  if (fs.existsSync(tdDir)) {
    for (const f of fs.readdirSync(tdDir).filter(f => /\.(jsonl|py|json)$/.test(f) || f.startsWith('Modelfile'))) {
      files.push(`training-data/${f}`);
    }
  }
  return files;
}

export async function handle(req, res) {
  // ── Logs (admin only) ──────────────────────────────────────────────────────
  // Lists available log files with size/mtime.
  if (req.url === '/api/admin/logs/files' && req.method === 'GET') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files: listLogFiles() }));
    return true;
  }

  // Read tail of a log file with optional filters.
  //   ?file=app|error   (default: app)
  //   ?tail=N           (1..5000; default 200)
  //   ?level=info|warn|error
  //   ?q=<text>         (case-insensitive substring match on tag/msg/meta)
  //   ?since=<ts ms or ISO string>
  if (req.url.startsWith('/api/admin/logs') && req.method === 'GET') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    const qs = new URL(req.url, 'http://x').searchParams;
    const opts = {
      file:  qs.get('file')  || 'app',
      tail:  qs.get('tail')  || 200,
      level: qs.get('level') || undefined,
      q:     qs.get('q')     || undefined,
      since: qs.get('since') || undefined,
    };
    const result = readLog(opts);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // Activity — supports ?offset=N&limit=N to bound response size.
  // Without pagination this endpoint dumps every user's full activity history,
  // which can blow up memory on deployments with many users / long history.
  if (req.url.startsWith('/api/admin/activity') && req.method === 'GET') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    const qs = new URL(req.url, 'http://x').searchParams;
    const offset = Math.max(0, parseInt(qs.get('offset') || '0', 10) || 0);
    const rawLimit = parseInt(qs.get('limit') || '100', 10);
    const limit = Math.min(Math.max(1, rawLimit || 100), 500); // server-side cap
    const data = loadActivity();
    const users = loadUsers();
    // Sort userIds by user name for stable pagination
    const sortedIds = Object.keys(data).sort((a, b) => {
      const na = users.find(u => u.id === a)?.name ?? a;
      const nb = users.find(u => u.id === b)?.name ?? b;
      return na.localeCompare(nb);
    });
    const total = sortedIds.length;
    const pageIds = sortedIds.slice(offset, offset + limit);
    const enriched = {};
    for (const uid of pageIds) {
      const u = users.find(u => u.id === uid);
      enriched[uid] = { name: u?.name ?? uid, data: data[uid] };
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Total-Count': String(total),
      'X-Offset': String(offset),
      'X-Limit':  String(limit),
    });
    res.end(JSON.stringify(enriched));
    return true;
  }

  if (req.url === '/api/activity/me' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const data = loadActivity(authId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data ?? {}));
    return true;
  }

  // Admin sessions
  if (req.url.match(/^\/api\/admin\/sessions\/[^/]+$/) && req.method === 'GET') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    const targetId = req.url.split('/').pop();
    const sessDir = path.join(getUserDir(targetId), 'sessions');
    const agent = new URL(req.url, 'http://x').searchParams.get('agent');
    const users = loadUsers();
    if (!users.find(u => u.id === targetId)) { res.writeHead(404); res.end(JSON.stringify({ error: 'User not found' })); return true; }
    try {
      const files = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')) : [];
      if (agent) {
        const safeAgent = safeId(agent);
        const fp = path.join(sessDir, `${safeAgent}.jsonl`);
        const messages = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ messages }));
      } else {
        const manifest = files.map(f => {
          const agentName = f.slice(0, -6);
          const lines = fs.readFileSync(path.join(sessDir, f), 'utf8').trim().split('\n').filter(Boolean);
          const msgs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const lastTs = msgs.length ? Math.max(...msgs.map(m => m.ts ?? 0)) : 0;
          return { agent: agentName, messageCount: msgs.length, lastTs };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(manifest));
      }
    } catch (e) { safeError(res, e); }
    return true;
  }

  if (req.url.match(/^\/api\/admin\/sessions\/[^/]+$/) && req.method === 'DELETE') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    const targetId = req.url.split('/').pop();
    const sessDir = path.join(getUserDir(targetId), 'sessions');
    const users = loadUsers();
    if (!users.find(u => u.id === targetId)) { res.writeHead(404); res.end(JSON.stringify({ error: 'User not found' })); return true; }
    try {
      const files = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')) : [];
      files.forEach(f => { try { fs.unlinkSync(path.join(sessDir, f)); } catch (e) { console.warn('[admin] Failed to delete session file', f + ':', e.message); } });
      clearUserSessions(targetId);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ cleared: files.length }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // Invite endpoints
  if (req.url === '/api/admin/invite' && req.method === 'POST') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    try {
      const { role = 'user', allowedSkills, emailTo } = JSON.parse(await readBody(req));
      const token = randomBytes(32).toString('hex');
      const invite = { token, role, allowedSkills: allowedSkills ?? [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(), createdBy: authId };
      await modifyInvites(invites => { invites.push(invite); });
      const port = req.socket.localPort ?? 3737;
      const url = `http://${getLanAddress()}:${port}/invite/${token}`;
      let emailStatus = null;
      if (emailTo) {
        try { await sendInviteEmail(authId, emailTo, url, role); emailStatus = { sent: true, to: emailTo }; }
        catch (e) { emailStatus = { sent: false, error: e.message }; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ token, url, email: emailStatus }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  if (req.url === '/api/admin/invites' && req.method === 'GET') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    const invites = loadInvites().filter(i => new Date(i.expiresAt) > new Date());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(invites.map(i => ({ ...i, fullToken: i.token, token: i.token.slice(0, 8) + '...' }))));
    return true;
  }

  if (req.url.match(/^\/api\/admin\/invites\/[a-f0-9]+$/) && req.method === 'DELETE') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    const token = req.url.split('/').pop();
    await modifyInvites(invites => { const i = invites.findIndex(x => x.token === token); if (i !== -1) invites.splice(i, 1); });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (req.url.match(/^\/api\/invite\/[a-f0-9]+$/) && req.method === 'GET') {
    const token = req.url.split('/').pop();
    const invite = loadInvites().find(i => i.token === token);
    if (!invite) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ valid: false, reason: 'not_found' })); return true; }
    if (new Date(invite.expiresAt) < new Date()) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ valid: false, reason: 'expired' })); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ valid: true, role: invite.role }));
    return true;
  }

  if (req.url.match(/^\/api\/invite\/[a-f0-9]+$/) && req.method === 'POST') {
    const token = req.url.split('/').pop();
    const invites = loadInvites();
    const invIdx = invites.findIndex(i => i.token === token);
    if (invIdx === -1) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid invite' })); return true; }
    const invite = invites[invIdx];
    if (new Date(invite.expiresAt) < new Date()) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invite expired' })); return true; }
    try {
      const { name, emoji = '🙂', password, pin } = JSON.parse(await readBody(req));
      if (!name?.trim()) throw new Error('Name required');
      const pwError = validatePassword(password);
      if (pwError) throw new Error(pwError);
      const id = 'user_' + randomBytes(8).toString('hex');
      const passwordHash = await hashPassword(password);
      const pinHash = pin ? await hashPassword(pin) : undefined;
      const newUser = { id, name: name.trim(), emoji, color: '#' + randomBytes(3).toString('hex'), role: invite.role, passwordHash, skills: getDefaultRoles(), skillsLocked: false, allowedSkills: invite.allowedSkills?.length ? invite.allowedSkills : undefined, agentOverrides: {}, createdAt: new Date().toISOString() };
      if (pinHash) newUser.pinHash = pinHash;
      await modifyUsers(list => { list.push(newUser); });
      await modifyInvites(invites => { const i = invites.findIndex(x => x.token === token); if (i !== -1) invites.splice(i, 1); });
      const agentsDir = path.join(BASE_DIR, 'agents');
      if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, `${id}.json`), '[]');
      const sessionToken = createSession(id);
      const { passwordHash: _ph, pinHash: _pin, ...safeUser } = newUser;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ token: sessionToken, user: { ...safeUser, hasPin: !!pinHash } }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // ── Restart endpoint ──────────────────────────────────────────────────────
  // Spawns a detached child that re-executes the current command after a short
  // delay (so the parent can release port 3737), then signals SIGTERM to self
  // to trigger the graceful shutdown handler in server.mjs.
  if (req.url === '/api/admin/restart' && req.method === 'POST') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ restarting: true }));
    // Shared with applyUpdate(); fires after the response is flushed.
    setImmediate(() => restartProcess());
    return true;
  }

  // ── Auto-update: status / check / apply / config ──────────────────────────
  if (req.url === '/api/admin/update/status' && req.method === 'GET') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const remote = cfg.updateRemote || 'origin';
    const cached = getUpdateState();
    const cleanCheck = await isCleanForUpdate(remote);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...cached,
      remote,
      enabled: cached.enabled && (cfg.updateCheckEnabled !== false),
      pollingEnabled: cfg.updateCheckEnabled !== false,
      intervalMs: cfg.updateCheckIntervalMs ?? 3_600_000,
      dirty:    cleanCheck.dirty,
      unpushed: cleanCheck.unpushed,
      blockReason: cleanCheck.reason,
    }));
    return true;
  }

  if (req.url === '/api/admin/update/check' && req.method === 'POST') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    if (_lastForcedCheckAt && Date.now() - _lastForcedCheckAt < 60_000) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limited — wait 60s between manual checks.' }));
      return true;
    }
    _lastForcedCheckAt = Date.now();
    const cfg = loadConfig();
    const remote = cfg.updateRemote || 'origin';
    try {
      const state = await checkForUpdate({ remote });
      const cleanCheck = await isCleanForUpdate(remote);
      // Force a transition broadcast on manual checks too, so admins see the
      // badge even if the periodic check hasn't run yet.
      if (state.available) {
        const adminIds = loadUsers()
          .filter(u => u.role === 'owner' || u.role === 'admin')
          .map(u => u.id);
        broadcastToUsers(adminIds, {
          type: 'update_available',
          currentSha: state.currentSha, remoteSha: state.remoteSha, ts: Date.now(),
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...state, remote,
        dirty: cleanCheck.dirty, unpushed: cleanCheck.unpushed, blockReason: cleanCheck.reason,
      }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  if (req.url === '/api/admin/update/apply' && req.method === 'POST') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const remote = cfg.updateRemote || 'origin';

    const adminIds = loadUsers()
      .filter(u => u.role === 'owner' || u.role === 'admin').map(u => u.id);
    const broadcastUpdate = (msg) => broadcastToUsers(adminIds, msg);

    // Acknowledge before doing the work — broadcast carries progress to all admins.
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ applying: true }));

    setImmediate(async () => {
      broadcastUpdate({ type: 'update_applying', stage: 'starting', ts: Date.now() });
      try {
        const result = await applyUpdate({ remote, broadcast: broadcastUpdate });
        if (!result.ok) {
          broadcastUpdate({
            type: 'update_failed',
            code: result.code, message: result.message, ts: Date.now(),
          });
        }
        // On success, applyUpdate() already triggered restart — no further broadcast.
      } catch (e) {
        broadcastUpdate({ type: 'update_failed', code: 'INTERNAL', message: e.message, ts: Date.now() });
      }
    });
    return true;
  }

  if (req.url === '/api/admin/update/config' && req.method === 'PATCH') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    let body;
    try { body = JSON.parse((await readBody(req)).toString() || '{}'); }
    catch { res.writeHead(400); res.end('Bad JSON'); return true; }

    await modifyConfig(cfg => {
      if (typeof body.updateCheckEnabled === 'boolean')   cfg.updateCheckEnabled   = body.updateCheckEnabled;
      if (Number.isFinite(body.updateCheckIntervalMs))    cfg.updateCheckIntervalMs = Math.max(60_000, body.updateCheckIntervalMs);
      if (typeof body.updateRemote === 'string' && body.updateRemote.trim())
        cfg.updateRemote = body.updateRemote.trim();
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, note: 'Settings saved. Polling interval/remote take effect on next server restart.' }));
    return true;
  }

  // ── Backup endpoint ───────────────────────────────────────────────────────
  if (req.url === '/api/admin/backup' && req.method === 'GET') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    try {
      const files = collectBackupFiles();

      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="openensemble-backup-${new Date().toISOString().slice(0,10)}.tar.gz"`,
      });

      const tar = spawn('tar', ['czf', '-', '--', ...files], { cwd: BASE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
      tar.stdout.pipe(res);
      tar.stderr.on('data', d => console.error('[backup]', d.toString()));
      tar.on('error', e => { if (!res.writableEnded) res.end(); });
    } catch (e) {
      if (!res.headersSent) safeError(res, e);
    }
    return true;
  }

  // ── Restore endpoint ──────────────────────────────────────────────────────
  if (req.url === '/api/admin/restore' && req.method === 'POST') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    try {
      const raw = await readRestoreBody(req);
      const restored = await performRestore(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, restored }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // ── First-run restore — no auth, only when no users exist yet. Lets a user
  // land on a fresh install and restore their backup *before* creating a dummy
  // profile that would then conflict with the archive's owner user.
  if (req.url === '/api/admin/restore-initial' && req.method === 'POST') {
    try {
      if (loadUsers().length > 0) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Restore-initial is only available before any profiles exist. Use /api/admin/restore as owner instead.' }));
        return true;
      }
      const raw = await readRestoreBody(req);
      const restored = await performRestore(raw, { clearOwnerConfig: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, restored }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // Child safety default prompt (for admin UI)
  if (req.url === '/api/admin/child-safety-default' && req.method === 'GET') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ prompt: getDefaultChildSafetyPrompt() }));
    return true;
  }

  // ── GET /api/users/:id/export — GDPR data export (self + admin) ────────────
  const exportMatch = req.url.match(/^\/api\/users\/(user_[\w]+)\/export$/);
  if (exportMatch && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const targetId = exportMatch[1];
    if (authId !== targetId && !requirePrivileged(req, res)) return true;
    const userDir = getUserDir(targetId);
    if (!fs.existsSync(userDir)) { res.writeHead(404); res.end(JSON.stringify({ error: 'User not found' })); return true; }

    try {
      // Collect all user files into a tar.gz stream
      const files = [];
      function walk(dir, prefix = '') {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
          else files.push(rel);
        }
      }
      walk(userDir);

      if (!files.length) { res.writeHead(404); res.end(JSON.stringify({ error: 'No data to export' })); return true; }

      const safeName = safeId(targetId);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="openensemble-export-${safeName}.tar.gz"`,
      });
      const tar = spawn('tar', ['czf', '-', '--', ...files], { cwd: userDir, stdio: ['ignore', 'pipe', 'pipe'] });
      tar.stdout.pipe(res);
      tar.stderr.on('data', d => console.error('[export]', d.toString()));
      tar.on('error', () => { if (!res.writableEnded) res.end(); });
    } catch (e) { safeError(res, e); }
    return true;
  }

  return false;
}

async function sendInviteEmail(adminUserId, to, inviteUrl, role) {
  const p = path.join(BASE_DIR, 'users', adminUserId, 'email-accounts.json');
  if (!fs.existsSync(p)) throw new Error('No email account configured for sender');
  const accounts = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!accounts.length) throw new Error('No email account configured for sender');
  const account = accounts[0];

  const subject = `You're invited to OpenEnsemble`;
  const body = `You've been invited to join OpenEnsemble as a ${role}.\n\nSet up your profile here (expires in 48 hours):\n${inviteUrl}\n`;
  const html = `<p>You've been invited to join OpenEnsemble as a <b>${role}</b>.</p><p>Set up your profile here (expires in 48 hours):</p><p><a href="${inviteUrl}">${inviteUrl}</a></p>`;

  if (account.provider === 'gmail') {
    const { getAccessToken } = await import('../lib/google-auth.mjs');
    const token = await getAccessToken('gmail', adminUserId, account.id);
    const boundary = `b_${Date.now().toString(36)}`;
    const raw = [
      `To: ${to}`, `Subject: ${subject}`, `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`, ``,
      `--${boundary}`, `Content-Type: text/plain; charset=utf-8`, ``, body, ``,
      `--${boundary}`, `Content-Type: text/html; charset=utf-8`, ``, html, ``,
      `--${boundary}--`,
    ].join('\r\n');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
    });
    if (!r.ok) throw new Error(`Gmail send failed: ${r.status} ${await r.text()}`);
    return;
  }

  if (account.provider === 'microsoft') {
    const { composeMsMessage } = await import('../lib/ms-graph.mjs');
    await composeMsMessage(adminUserId, account.id, { to, subject, body, html_body: html });
    return;
  }

  if (account.smtpHost) {
    const { sendSmtpEmail } = await import('../lib/smtp-client.mjs');
    await sendSmtpEmail(adminUserId, account, { to, subject, body, html });
    return;
  }

  throw new Error(`Account "${account.label}" has no send capability (no SMTP configured).`);
}
