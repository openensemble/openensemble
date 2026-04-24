/**
 * One-time migration: move all per-user files from their old scattered locations
 * into users/{userId}/ subdirectories.
 *
 * Safe to run multiple times — skips files that are already in the new location.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const USERS_DIR = path.join(BASE_DIR, 'users');

function move(src, dest) {
  if (!fs.existsSync(src)) return false;
  if (fs.existsSync(dest)) { try { fs.rmSync(src, { recursive: true, force: true }); } catch {} return false; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return true;
}

export function migrateUserDirs() {
  if (!fs.existsSync(USERS_DIR)) return;

  // Collect user IDs from both old flat files and existing subdirs
  const userIds = new Set();
  try {
    for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        userIds.add(entry.name);
      } else if (entry.name.endsWith('.json') && entry.name.startsWith('user_')) {
        // Old flat format: users/user_abc123.json → migrate to users/user_abc123/profile.json
        const userId = entry.name.slice(0, -5);
        userIds.add(userId);
        move(path.join(USERS_DIR, entry.name), path.join(USERS_DIR, userId, 'profile.json'));
      }
    }
  } catch (e) { console.warn('[migrate] Failed to read users dir:', e.message); return; }

  let moved = 0;

  for (const userId of userIds) {
    const userDir = path.join(USERS_DIR, userId);
    fs.mkdirSync(userDir, { recursive: true });

    // agents/user_ID.json → users/user_ID/agents.json
    if (move(path.join(BASE_DIR, 'agents', `${userId}.json`), path.join(userDir, 'agents.json'))) moved++;

    // sessions/user_ID_*.jsonl → users/user_ID/sessions/*.jsonl
    const oldSessDir = path.join(BASE_DIR, 'sessions');
    if (fs.existsSync(oldSessDir)) {
      try {
        for (const f of fs.readdirSync(oldSessDir)) {
          if (!f.startsWith(userId + '_')) continue;
          const localName = f.slice(userId.length + 1); // strip "userId_" prefix
          const dest = path.join(userDir, 'sessions', localName);
          if (move(path.join(oldSessDir, f), dest)) moved++;
        }
      } catch {}
    }

    // cortex-user_ID/ → users/user_ID/cortex/
    if (move(path.join(BASE_DIR, `cortex-${userId}`), path.join(userDir, 'cortex'))) moved++;

    // activity/user_ID.json → users/user_ID/activity.json
    if (move(path.join(BASE_DIR, 'activity', `${userId}.json`), path.join(userDir, 'activity.json'))) moved++;

    // tasks/user_ID.json → users/user_ID/tasks.json
    if (move(path.join(BASE_DIR, 'tasks', `${userId}.json`), path.join(userDir, 'tasks.json'))) moved++;

    // email-accounts-user_ID.json → users/user_ID/email-accounts.json
    if (move(path.join(BASE_DIR, `email-accounts-${userId}.json`), path.join(userDir, 'email-accounts.json'))) moved++;

    // gmail-autolabel-user_ID.json → users/user_ID/gmail-autolabel.json
    if (move(path.join(BASE_DIR, `gmail-autolabel-${userId}.json`), path.join(userDir, 'gmail-autolabel.json'))) moved++;

    // gcal-token-user_ID.json → users/user_ID/gcal-token.json
    if (move(path.join(BASE_DIR, `gcal-token-${userId}.json`), path.join(userDir, 'gcal-token.json'))) moved++;

    // gmail-token-user_ID.json → users/user_ID/gmail-token.json (legacy single account)
    if (move(path.join(BASE_DIR, `gmail-token-${userId}.json`), path.join(userDir, 'gmail-token.json'))) moved++;

    // gmail-token-user_ID-{accountId}.json → users/user_ID/gmail-token-{accountId}.json
    try {
      for (const f of fs.readdirSync(BASE_DIR)) {
        if (!f.startsWith(`gmail-token-${userId}-`) || !f.endsWith('.json')) continue;
        const accountPart = f.slice(`gmail-token-${userId}-`.length); // "acct_xxx.json"
        if (move(path.join(BASE_DIR, f), path.join(userDir, `gmail-token-${accountPart}`))) moved++;
      }
    } catch {}

    // ms-token-user_ID-{accountId}.json → users/user_ID/ms-token-{accountId}.json
    try {
      for (const f of fs.readdirSync(BASE_DIR)) {
        if (!f.startsWith(`ms-token-${userId}-`) || !f.endsWith('.json')) continue;
        const accountPart = f.slice(`ms-token-${userId}-`.length);
        if (move(path.join(BASE_DIR, f), path.join(userDir, `ms-token-${accountPart}`))) moved++;
      }
    } catch {}

    // shared-notes-user_ID.json → users/user_ID/shared-notes.json
    if (move(path.join(BASE_DIR, `shared-notes-${userId}.json`), path.join(userDir, 'shared-notes.json'))) moved++;

    // images/user_ID/ → users/user_ID/images/
    if (move(path.join(BASE_DIR, 'images', userId), path.join(userDir, 'images'))) moved++;

    // research/user_ID/ → users/user_ID/research/
    if (move(path.join(BASE_DIR, 'research', userId), path.join(userDir, 'research'))) moved++;

    // videos/user_ID/ → users/user_ID/videos/
    if (move(path.join(BASE_DIR, 'videos', userId), path.join(userDir, 'videos'))) moved++;

    // avatars/user_ID.{ext} → users/user_ID/avatar.{ext}
    const avatarsDir = path.join(BASE_DIR, 'avatars');
    if (fs.existsSync(avatarsDir)) {
      try {
        for (const f of fs.readdirSync(avatarsDir)) {
          if (!f.startsWith(userId + '.')) continue;
          const ext = path.extname(f);
          if (move(path.join(avatarsDir, f), path.join(userDir, `avatar${ext}`))) moved++;
        }
      } catch {}
    }
  }

  if (moved > 0) console.log(`[migrate] Moved ${moved} item(s) to per-user directories`);

  // ── Migrate global shared-docs/ into per-user documents/ directories ──────
  const sharedDocsDir = path.join(BASE_DIR, 'shared-docs');
  const sharedIndexPath = path.join(sharedDocsDir, 'index.json');
  if (fs.existsSync(sharedIndexPath)) {
    try {
      const docs = JSON.parse(fs.readFileSync(sharedIndexPath, 'utf8'));
      const sharingEntries = [];
      let migrated = 0;

      for (const doc of docs) {
        const ownerId = doc.uploadedBy;
        if (!ownerId) continue;
        const userDocsDir = path.join(USERS_DIR, ownerId, 'documents');
        fs.mkdirSync(userDocsDir, { recursive: true });

        // Move the file
        const srcFile = path.join(sharedDocsDir, doc.id + doc.ext);
        const destFile = path.join(userDocsDir, doc.id + doc.ext);
        if (fs.existsSync(srcFile) && !fs.existsSync(destFile)) {
          fs.renameSync(srcFile, destFile);
          migrated++;
        }

        // Write to per-user docs-index.json
        const userIndexPath = path.join(userDocsDir, 'docs-index.json');
        let userIndex = [];
        try { userIndex = JSON.parse(fs.readFileSync(userIndexPath, 'utf8')); } catch {}
        if (!userIndex.find(d => d.id === doc.id)) {
          userIndex.push(doc);
          fs.writeFileSync(userIndexPath, JSON.stringify(userIndex, null, 2));
        }

        // Build sharing.json entries from sharedWith arrays
        const sharedWith = (doc.sharedWith ?? []).filter(u => u !== '*' && u !== ownerId);
        if (sharedWith.length > 0) {
          sharingEntries.push({
            id: 'share_' + doc.id.replace('doc_', ''),
            ownerId,
            fileType: 'document',
            fileId: doc.id,
            filePath: `documents/${doc.id}${doc.ext}`,
            filename: doc.filename,
            sharedWith,
            sharedAt: doc.createdAt ?? new Date().toISOString(),
          });
        }
      }

      // Write sharing.json
      const sharingPath = path.join(BASE_DIR, 'sharing.json');
      if (sharingEntries.length > 0 && !fs.existsSync(sharingPath)) {
        fs.writeFileSync(sharingPath, JSON.stringify(sharingEntries, null, 2));
      }

      // Mark migration as done
      fs.renameSync(sharedIndexPath, sharedIndexPath + '.migrated');
      if (migrated > 0) console.log(`[migrate] Moved ${migrated} shared doc(s) to per-user documents/ directories`);
    } catch (e) {
      console.warn('[migrate] shared-docs migration failed:', e.message);
    }
  }
}
