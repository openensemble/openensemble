/**
 * User routes: /api/users CRUD, /api/users/:id/switch, /api/users/:id/avatar
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import {
  requireAuth, getAuthToken, getSessionUserId, getUser, getUserRole,
  isPrivileged, loadUsers, modifyUsers, modifyUser, hashPassword, validatePassword, verifyPassword, readBody,
  createSession, clearUserSessions, clearUserSessionsExcept, modifyExpGroups, isTimeBlocked, parseMultipart,
  safeId as safeIdFn, getUserDir, withLock, EXPENSES_DB,
} from './_helpers.mjs';
import { migrateSharedCortexToUser } from '../memory.mjs';

const BASE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHARING_PATH = path.join(BASE_DIR, 'sharing.json');

// ── Rate limiting for password change & user switch ────────────────────────
const _authAttempts = new Map();
const AUTH_RATE_WINDOW = 60_000;
const AUTH_RATE_MAX = 5;

function isAuthRateLimited(key) {
  const now = Date.now();
  const entry = _authAttempts.get(key);
  if (!entry || now - entry.firstAttempt > AUTH_RATE_WINDOW) {
    _authAttempts.set(key, { count: 1, firstAttempt: now });
    return false;
  }
  entry.count++;
  return entry.count > AUTH_RATE_MAX;
}

export async function handle(req, res) {
  if (req.url === '/api/users' && req.method === 'GET') {
    const authId = getSessionUserId(getAuthToken(req));
    const privileged = authId && isPrivileged(authId);
    const safe = loadUsers().map(u => {
      if (!authId) return { id: u.id, name: u.name, emoji: u.emoji, color: u.color, avatar: u.avatar ?? null };
      const { passwordHash: _ph, pinHash: _pin, ...rest } = u;
      const full = { ...rest, hasPin: !!u.pinHash };
      return privileged ? full : { id: u.id, name: u.name, emoji: u.emoji, color: u.color, role: u.role, avatar: u.avatar ?? null };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
    return true;
  }

  if (req.url === '/api/users' && req.method === 'POST') {
    try {
      const existing = loadUsers();
      if (existing.length > 0) {
        const authId = requireAuth(req, res); if (!authId) return true;
        if (!isPrivileged(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Only admins can create users' })); return true; }
      }
      const { name, emoji = '🧑', color, password, role: requestedRole, allowedFeatures: requestedFeatures, childSafetyPrompt: reqChildPrompt, allowedModels: reqAllowedModels } = JSON.parse(await readBody(req));
      if (!name?.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'name required' })); return true; }
      const pwError = validatePassword(password);
      if (pwError) { res.writeHead(400); res.end(JSON.stringify({ error: pwError })); return true; }
      const id = 'user_' + randomBytes(4).toString('hex');
      const COLORS = ['#6c63ff','#ff6584','#43b89c','#f5a623','#4fa3e0','#e05c5c','#5ce07a'];
      const passwordHash = await hashPassword(password);
      let user, isFirst;
      await modifyUsers(list => {
        let role = list.length === 0 ? 'owner' : 'user';
        if (list.length > 0 && requestedRole && ['admin', 'user', 'child'].includes(requestedRole)) {
          const authId2 = getSessionUserId(getAuthToken(req));
          const authRole2 = getUserRole(authId2);
          if (authRole2 === 'owner' || (authRole2 === 'admin' && ['user', 'child'].includes(requestedRole))) {
            role = requestedRole;
          }
        }
        // Safe-by-default child sandbox. Admin can override by PATCHing after
        // create. Intentionally narrow: only kid-friendly tools and drawers.
        const childDefaults = role === 'child' ? {
          skillsLocked: true,
          skills: ['web'],
          allowedSkills: ['deep_research', 'web', 'image_generator'],
          allowedFeatures: ['notes', 'news'],
        } : {};
        // Non-admin users start with no skills/features — admin explicitly grants access.
        // Agents are always "agents you own" — there is no sharing.
        const freshUserDefaults = (role !== 'owner' && role !== 'admin' && role !== 'child') ? { allowedSkills: [], allowedFeatures: [], skills: [] } : {};
        // Allow admin to override allowedFeatures at creation time (for non-owner/admin roles)
        const featureOverride = (role !== 'owner' && role !== 'admin' && Array.isArray(requestedFeatures)) ? { allowedFeatures: requestedFeatures } : {};
        // Parent-child linking: auto-set parentId to creating admin's ID for child/user accounts
        const authId2 = getSessionUserId(getAuthToken(req));
        const parentLink = (role === 'child' || role === 'user') && authId2 ? { parentId: authId2 } : {};
        // Per-child safety prompt and model allowlist
        const tierOverrides = {};
        if (role === 'child' && typeof reqChildPrompt === 'string' && reqChildPrompt.trim()) tierOverrides.childSafetyPrompt = reqChildPrompt.trim();
        if ((role === 'child' || role === 'user') && Array.isArray(reqAllowedModels)) tierOverrides.allowedModels = reqAllowedModels;
        user = { id, name: name.trim(), emoji, color: color ?? COLORS[list.length % COLORS.length], newsDefaultTopic: 0, emailProvider: 'none', role, ...freshUserDefaults, ...childDefaults, ...featureOverride, ...parentLink, ...tierOverrides, passwordHash, createdAt: new Date().toISOString() };
        isFirst = list.length === 0;
        list.push(user);
      });
      if (isFirst) {
        migrateSharedCortexToUser(user.id).then(r => {
          if (r.migrated) console.log(`[cortex] migrated shared data → user ${user.id}`);
        }).catch(e => console.warn('[cortex] Migration failed:', e.message));
      }
      const { passwordHash: _ph, ...safe } = user;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(safe));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  const userMatch = req.url.match(/^\/api\/users\/(user_[\w]+)$/);
  if (userMatch && req.method === 'GET') {
    const authId = getSessionUserId(getAuthToken(req));
    const u = loadUsers().find(u => u.id === userMatch[1]);
    if (!u) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    const { passwordHash: _ph, pinHash: _pin, ...rest } = u;
    const full = { ...rest, hasPin: !!u.pinHash };
    const safe = (isPrivileged(authId) || authId === userMatch[1]) ? full : { id: u.id, name: u.name, emoji: u.emoji, color: u.color };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(safe)); return true;
  }

  if (userMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const targetId = userMatch[1];
    const authRole = getUserRole(authId);
    const isPriv = authRole === 'owner' || authRole === 'admin';
    if (!isPriv && authId !== targetId) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    // Admin scope: admins can only manage users they created (parentId === adminId), owner exempt
    if (authRole === 'admin' && authId !== targetId) {
      const target = loadUsers().find(u => u.id === targetId);
      if (target && target.parentId !== authId) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'You can only manage your own child/user accounts' })); return true;
      }
    }
    try {
      const changes = JSON.parse(await readBody(req));
      // Strip fields that must only be set via their approved mutation paths.
      // Direct injection of passwordHash/pinHash would bypass the currentPassword
      // check and the validatePassword length minimum.
      delete changes.passwordHash;
      delete changes.pinHash;
      delete changes.id;
      delete changes.createdAt;
      // Pre-flight validation on a snapshot (async work like hashing must happen outside the lock)
      const snap = loadUsers();
      const snapIdx = snap.findIndex(u => u.id === targetId);
      if (snapIdx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
      if (changes.role !== undefined) {
        if (authRole !== 'owner') { res.writeHead(403); res.end(JSON.stringify({ error: 'Only the owner can change roles' })); return true; }
        if (snap[snapIdx].role === 'owner') { res.writeHead(403); res.end(JSON.stringify({ error: 'Cannot change the owner role' })); return true; }
        if (!['admin', 'user', 'child'].includes(changes.role)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid role' })); return true; }
      }
      if (changes.skillsLocked !== undefined && !isPriv) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Only admins can lock skills' })); return true;
      }
      if (changes.skills !== undefined && !isPriv) {
        if (authId !== targetId) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
        if (snap[snapIdx].skillsLocked) { res.writeHead(403); res.end(JSON.stringify({ error: 'Your tools are managed by an administrator' })); return true; }
      }
      if (changes.newPassword) {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
        if (isAuthRateLimited(`pw:${ip}:${targetId}`)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many attempts. Try again in a minute.' }));
          return true;
        }
        const pwErr = validatePassword(changes.newPassword);
        if (pwErr) { res.writeHead(400); res.end(JSON.stringify({ error: pwErr })); return true; }
        if (authId === targetId) {
          if (!changes.currentPassword) { res.writeHead(400); res.end(JSON.stringify({ error: 'currentPassword required' })); return true; }
          const ok = await verifyPassword(changes.currentPassword, snap[snapIdx].passwordHash);
          if (!ok) { res.writeHead(401); res.end(JSON.stringify({ error: 'Current password incorrect' })); return true; }
        } else if (!isPriv) {
          res.writeHead(403); res.end(JSON.stringify({ error: 'Only admins can reset passwords' })); return true;
        }
        changes.passwordHash = await hashPassword(changes.newPassword);
        delete changes.currentPassword; delete changes.newPassword;
      }
      if ('pin' in changes) {
        if (changes.pin === null) {
          changes._clearPin = true;
          delete changes.pin;
        } else {
          changes.pinHash = await hashPassword(changes.pin);
          delete changes.pin;
        }
      }
      if (changes.locked !== undefined) {
        if (!isPriv) { delete changes.locked; }
        else if (snap[snapIdx].role === 'owner') { res.writeHead(403); res.end(JSON.stringify({ error: 'Cannot lock the owner account' })); return true; }
        else if (authId === targetId) { res.writeHead(403); res.end(JSON.stringify({ error: 'Cannot lock your own account' })); return true; }
      }
      if (changes.accessSchedule !== undefined) {
        if (!isPriv) { delete changes.accessSchedule; }
        else if (snap[snapIdx].role === 'owner') { res.writeHead(403); res.end(JSON.stringify({ error: 'Cannot set access schedule on the owner account' })); return true; }
        else if (changes.accessSchedule !== null) {
          const s = changes.accessSchedule;
          if (!s.blockedFrom?.match(/^\d{2}:\d{2}$/) || !s.blockedUntil?.match(/^\d{2}:\d{2}$/)) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'accessSchedule requires blockedFrom and blockedUntil in HH:MM format' })); return true;
          }
        }
      }
      if (changes.telegramAllowed !== undefined && !isPriv) { delete changes.telegramAllowed; }
      // allowedAgents is no longer a concept (agent sharing was removed); strip any incoming value.
      if (changes.allowedAgents !== undefined) delete changes.allowedAgents;
      if (changes.allowedSkills !== undefined && !isPriv) { delete changes.allowedSkills; }
      if (changes.allowedFeatures !== undefined && !isPriv) { delete changes.allowedFeatures; }
      if (changes.exitPinUserId !== undefined && !isPriv) { delete changes.exitPinUserId; }
      // Tier fields — admin-only
      if (changes.childSafetyPrompt !== undefined && !isPriv) { delete changes.childSafetyPrompt; }
      if (changes.allowedModels !== undefined && !isPriv) { delete changes.allowedModels; }
      if (changes.allowedOAuthProviders !== undefined && !isPriv) { delete changes.allowedOAuthProviders; }
      if (changes.parentId !== undefined && !isPriv) { delete changes.parentId; }
      // workspace is no longer configurable — silently drop any incoming value
      // (old clients may still send it) and ensure a stale stored field gets cleared.
      if (changes.workspace !== undefined) delete changes.workspace;
      const safe = await modifyUser(targetId, user => {
        if (changes._clearPin) { delete user.pinHash; delete changes._clearPin; }
        if (user.workspace !== undefined) delete user.workspace;
        // Sync drawers with role skills whenever allowedSkills is saved
        if (Array.isArray(changes.allowedSkills) && changes.allowedFeatures === undefined) {
          const SKILL_TO_FEATURE = { expenses: 'expenses', email: 'inbox' };
          const existingFeatures = user.allowedFeatures;
          if (Array.isArray(existingFeatures)) {
            let updated = [...existingFeatures];
            for (const [skill, feature] of Object.entries(SKILL_TO_FEATURE)) {
              if (changes.allowedSkills.includes(skill) && !updated.includes(feature)) {
                updated.push(feature);
              } else if (!changes.allowedSkills.includes(skill) && updated.includes(feature)) {
                updated = updated.filter(f => f !== feature);
              }
            }
            if (updated.length !== existingFeatures.length || updated.some((f, i) => f !== existingFeatures[i])) {
              changes = { ...changes, allowedFeatures: updated };
            }
          }
        }
        // Prune active skills when allowedSkills tightens — a previously-enabled
        // skill that's no longer in the allowlist should not remain active.
        if (Array.isArray(changes.allowedSkills) && Array.isArray(user.skills)) {
          const pruned = user.skills.filter(s => changes.allowedSkills.includes(s));
          if (pruned.length !== user.skills.length) user.skills = pruned;
        }
        Object.assign(user, changes, { id: user.id });
      }).then(user => {
        if (!user) return null;
        const { passwordHash: _ph, pinHash: _pin, ...rest } = user;
        return { ...rest, hasPin: !!user.pinHash };
      });
      if (!safe) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
      if (changes.locked === true) clearUserSessions(targetId);

      // Security: invalidate sessions when credentials or role change.
      // - Password change: other devices should be logged out. Keep the acting
      //   session if the user changed their own password (so the UI doesn't
      //   immediately log them out mid-flow).
      // - Role change: admin may have been demoted — drop all sessions so the
      //   next request re-authenticates with the new role.
      if (changes.passwordHash) {
        if (authId === targetId) {
          const currentToken = getAuthToken(req);
          clearUserSessionsExcept(targetId, currentToken);
        } else {
          clearUserSessions(targetId);
        }
      }
      if (changes.role !== undefined) clearUserSessions(targetId);

      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(safe));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  if (userMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const targetId = userMatch[1];
    const authRole = getUserRole(authId);
    const isPriv = authRole === 'owner' || authRole === 'admin';
    if (!isPriv && authId !== targetId) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    const targetUser = loadUsers().find(u => u.id === targetId);
    if (!targetUser) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (targetUser.role === 'owner') { res.writeHead(403); res.end(JSON.stringify({ error: 'Cannot delete the owner account' })); return true; }
    if (authRole === 'admin' && targetUser.role === 'admin' && authId !== targetId) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'Admins cannot delete other admins' })); return true;
    }
    // Admin scope: admins can only delete users they created
    if (authRole === 'admin' && authId !== targetId && targetUser.parentId !== authId) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'You can only delete your own child/user accounts' })); return true;
    }
    await modifyUsers(list => { const i = list.findIndex(u => u.id === targetId); if (i !== -1) list.splice(i, 1); });

    // Clean up all data for the deleted user
    // Active session tokens
    clearUserSessions(targetId);

    // Remove the entire user directory (contains sessions, cortex, agents, tokens, etc.)
    const userDir = getUserDir(targetId);
    if (fs.existsSync(userDir)) {
      try { fs.rmSync(userDir, { recursive: true, force: true }); }
      catch (e) { console.warn('[users] Failed to delete user dir:', e.message); }
    }

    // Expense transactions — serialize with other writers via withLock so
    // concurrent edits don't clobber our filter.
    if (fs.existsSync(EXPENSES_DB)) {
      await withLock(EXPENSES_DB + '.lock', () => {
        try {
          const txns = JSON.parse(fs.readFileSync(EXPENSES_DB, 'utf8'));
          const filtered = txns.filter(t => t.userId !== targetId);
          if (filtered.length !== txns.length) fs.writeFileSync(EXPENSES_DB, JSON.stringify(filtered, null, 2));
        } catch (e) { console.warn('[users] Failed to purge expense transactions:', e.message); }
      });
    }

    // Expense groups — remove user from membership
    await modifyExpGroups(groups => {
      for (const g of groups) g.memberIds = g.memberIds.filter(id => id !== targetId);
    });

    // Sharing records — drop any share where the deleted user was owner or
    // grantee. Leaving orphans would leak file metadata and mislead the UI.
    if (fs.existsSync(SHARING_PATH)) {
      await withLock(SHARING_PATH + '.lock', () => {
        try {
          const shares = JSON.parse(fs.readFileSync(SHARING_PATH, 'utf8'));
          const filtered = shares
            .filter(s => s.ownerId !== targetId)
            .map(s => ({ ...s, sharedWith: (s.sharedWith ?? []).filter(id => id !== targetId) }))
            .filter(s => (s.sharedWith?.length ?? 0) > 0 || s.public === true);
          if (filtered.length !== shares.length || JSON.stringify(filtered) !== JSON.stringify(shares)) {
            fs.writeFileSync(SHARING_PATH, JSON.stringify(filtered, null, 2));
          }
        } catch (e) { console.warn('[users] Failed to purge sharing records:', e.message); }
      });
    }

    // Direct messages — strip the deleted user from `to` and `readBy`, and drop
    // any message they authored or that now has no remaining recipients.
    const MESSAGES_PATH = path.join(BASE_DIR, 'messages.json');
    if (fs.existsSync(MESSAGES_PATH)) {
      await withLock(MESSAGES_PATH, () => {
        try {
          const msgs = JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));
          const cleaned = msgs
            .filter(m => m.from !== targetId)
            .map(m => ({
              ...m,
              to: (m.to ?? []).filter(id => id !== targetId),
              readBy: (m.readBy ?? []).filter(id => id !== targetId),
            }))
            .filter(m => (m.to?.length ?? 0) > 0);
          if (cleaned.length !== msgs.length || JSON.stringify(cleaned) !== JSON.stringify(msgs)) {
            fs.writeFileSync(MESSAGES_PATH, JSON.stringify(cleaned, null, 2));
          }
        } catch (e) { console.warn('[users] Failed to purge messages:', e.message); }
      });
    }

    // Threads — strip the deleted user from participants and each message's
    // readBy, drop messages they authored, and drop the whole thread if no
    // participants remain.
    const THREADS_PATH = path.join(BASE_DIR, 'threads.json');
    if (fs.existsSync(THREADS_PATH)) {
      await withLock(THREADS_PATH, () => {
        try {
          const threads = JSON.parse(fs.readFileSync(THREADS_PATH, 'utf8'));
          const cleaned = threads
            .map(t => ({
              ...t,
              participants: (t.participants ?? []).filter(id => id !== targetId),
              messages: (t.messages ?? [])
                .filter(m => m.from !== targetId)
                .map(m => ({ ...m, readBy: (m.readBy ?? []).filter(id => id !== targetId) })),
            }))
            .filter(t => (t.participants?.length ?? 0) > 0);
          if (cleaned.length !== threads.length || JSON.stringify(cleaned) !== JSON.stringify(threads)) {
            fs.writeFileSync(THREADS_PATH, JSON.stringify(cleaned, null, 2));
          }
        } catch (e) { console.warn('[users] Failed to purge threads:', e.message); }
      });
    }

    // Per-user document indexes — each remaining user may have shared a doc
    // with the deleted user; strip them from every sharedWith array.
    for (const u of loadUsers()) {
      const idxPath = path.join(getUserDir(u.id), 'documents', 'docs-index.json');
      if (!fs.existsSync(idxPath)) continue;
      await withLock(idxPath + '.lock', () => {
        try {
          const docs = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
          let changed = false;
          for (const d of docs) {
            if (Array.isArray(d.sharedWith) && d.sharedWith.includes(targetId)) {
              d.sharedWith = d.sharedWith.filter(id => id !== targetId);
              changed = true;
            }
          }
          if (changed) fs.writeFileSync(idxPath, JSON.stringify(docs, null, 2));
        } catch (e) { console.warn('[users] Failed to purge docs-index for', u.id + ':', e.message); }
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return true;
  }

  // Profile switch — verify password and issue a new session token
  if (req.url.match(/^\/api\/users\/[^/]+\/switch$/) && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const targetId = req.url.split('/')[3];
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (isAuthRateLimited(`sw:${ip}:${targetId}`)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many attempts. Try again in a minute.' }));
      return true;
    }
    try {
      const targetUser = getUser(targetId);
      if (!targetUser) { res.writeHead(404); res.end(JSON.stringify({ error: 'User not found' })); return true; }
      const { password } = JSON.parse(await readBody(req));
      // If switching to a different user, require their password
      if (targetId !== authId) {
        if (!targetUser.passwordHash || !await verifyPassword(password ?? '', targetUser.passwordHash)) {
          res.writeHead(403); res.end(JSON.stringify({ error: 'Incorrect password' })); return true;
        }
      }
      if (targetUser.locked) { res.writeHead(403); res.end(JSON.stringify({ error: 'Account is locked' })); return true; }
      if (isTimeBlocked(targetUser.accessSchedule)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Access is restricted at this time' })); return true; }
      const token = createSession(targetId);
      const { passwordHash: _ph, pinHash: _pin, ...safe } = targetUser;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, user: safe }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }


  // ── POST /api/users/:id/avatar ── upload avatar image
  const avatarUpMatch = req.url.match(/^\/api\/users\/([^/]+)\/avatar$/);
  if (avatarUpMatch && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const targetId = avatarUpMatch[1];
    if (authId !== targetId && !isPrivileged(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({ error: 'File too large (max 2MB)' })); return true; }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const boundary = (req.headers['content-type'] ?? '').match(/boundary=([^\s;]+)/)?.[1];
    if (!boundary) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing multipart boundary' })); return true; }

    const parsed = parseMultipart(raw, boundary);
    if (!parsed) { res.writeHead(400); res.end(JSON.stringify({ error: 'No file in upload' })); return true; }
    const { fileData, mimeType } = parsed;

    const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
    const ext = ALLOWED[mimeType];
    if (!ext) { res.writeHead(400); res.end(JSON.stringify({ error: 'Unsupported image type' })); return true; }

    const userDir = getUserDir(targetId);
    fs.mkdirSync(userDir, { recursive: true });
    // Remove old avatar files from user dir
    try { for (const f of fs.readdirSync(userDir)) { if (f.startsWith('avatar.')) fs.unlinkSync(path.join(userDir, f)); } } catch {}
    const avatarFile = `avatar${ext}`;
    fs.writeFileSync(path.join(userDir, avatarFile), fileData);

    await modifyUser(targetId, u => { u.avatar = `/api/avatars/${targetId}/${avatarFile}`; });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ avatar: `/api/avatars/${targetId}/${avatarFile}` }));
    return true;
  }

  // ── DELETE /api/users/:id/avatar ── remove custom avatar
  if (avatarUpMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const targetId = avatarUpMatch[1];
    if (authId !== targetId && !isPrivileged(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }

    const userDir = getUserDir(targetId);
    try { for (const f of fs.readdirSync(userDir)) { if (f.startsWith('avatar.')) fs.unlinkSync(path.join(userDir, f)); } } catch {}
    await modifyUser(targetId, u => { delete u.avatar; });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ avatar: null }));
    return true;
  }

  // ── GET /api/avatars/:userId/:file ── serve avatar images
  const avatarServe = req.url.match(/^\/api\/avatars\/([^/?]+)\/([^?]+)/);
  if (avatarServe && req.method === 'GET') {
    const userId = safeIdFn(decodeURIComponent(avatarServe[1]));
    const file = path.basename(decodeURIComponent(avatarServe[2]));
    const filePath = path.join(getUserDir(userId), file);
    // Prevent path traversal — resolved path must stay within the users directory
    const USERS_DIR = path.join(BASE_DIR, 'users');
    if (!path.resolve(filePath).startsWith(USERS_DIR)) { res.writeHead(400); res.end(); return true; }
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return true; }
    const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    const ext = path.extname(file).toLowerCase();
    const stat = fs.statSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return false;
}
