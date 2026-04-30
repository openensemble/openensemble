#!/usr/bin/env node
/**
 * One-shot migration: re-key existing IMAP encryptedPassword records from
 * the legacy global config.json:imapEncryptionKey to per-user keys at
 * users/{userId}/.master-key.
 *
 * Idempotent: records already encrypted with the per-user key are detected
 * (per-user decrypt succeeds) and skipped. Records that fail BOTH per-user
 * and global decryption are logged as hard errors but the script does not
 * crash, delete, or modify them — manual intervention required.
 *
 * Run from the repo root:
 *   node scripts/migrate-email-crypto-to-per-user.mjs --dry-run
 *   node scripts/migrate-email-crypto-to-per-user.mjs
 *
 * Always run --dry-run first. See MIGRATION_per-user-encryption.md for the
 * full migration plan and rollback instructions.
 */

import fs from 'fs';
import path from 'path';
import { Buffer } from 'buffer';
import { USERS_DIR } from '../routes/_helpers/paths.mjs';
import { loadConfig } from '../routes/_helpers.mjs';
import { aesGcmEncrypt, aesGcmDecrypt, getUserKey } from '../lib/crypto.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function getGlobalKey() {
  const cfg = loadConfig();
  if (!cfg.imapEncryptionKey) return null;
  return Buffer.from(cfg.imapEncryptionKey, 'hex');
}

function tryDecrypt(key, ciphertext) {
  try { return aesGcmDecrypt(key, ciphertext); } catch { return null; }
}

function atomicWrite(p, contents) {
  const tmp = p + '.migrate-tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, p);
}

function main() {
  if (!fs.existsSync(USERS_DIR)) {
    console.log(`No users dir at ${USERS_DIR} — nothing to migrate.`);
    return;
  }

  const globalKey = getGlobalKey();
  if (!globalKey) {
    console.log('No legacy imapEncryptionKey in config.json — nothing to migrate (or already removed).');
    return;
  }

  const counts = { migrated: 0, skipped: 0, failed: 0, usersScanned: 0, accountsScanned: 0 };
  const failures = [];

  for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const userId = entry.name;
    const accountsPath = path.join(USERS_DIR, userId, 'email-accounts.json');
    if (!fs.existsSync(accountsPath)) continue;
    counts.usersScanned++;

    let accounts;
    try { accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8')); }
    catch (e) {
      console.warn(`[migrate] ${userId}: cannot parse email-accounts.json (${e.message}) — skipping`);
      continue;
    }
    if (!Array.isArray(accounts)) {
      console.warn(`[migrate] ${userId}: email-accounts.json is not an array — skipping`);
      continue;
    }

    let dirty = false;
    const userKey = getUserKey(userId); // generates the keyfile if missing

    for (const acct of accounts) {
      if (!acct.encryptedPassword) continue;
      counts.accountsScanned++;

      // 1. If per-user decrypt succeeds, this record is already migrated.
      const perUser = tryDecrypt(userKey, acct.encryptedPassword);
      if (perUser !== null) {
        counts.skipped++;
        console.log(`[migrate] ${userId} ${acct.id}: already per-user, skipping`);
        continue;
      }

      // 2. Try global key. If success, re-encrypt with per-user.
      const plaintext = tryDecrypt(globalKey, acct.encryptedPassword);
      if (plaintext === null) {
        counts.failed++;
        failures.push(`${userId} ${acct.id}`);
        console.error(`[migrate] ${userId} ${acct.id}: HARD FAILURE — neither per-user nor global key decrypts. Manual intervention needed.`);
        continue;
      }

      acct.encryptedPassword = aesGcmEncrypt(userKey, plaintext);
      counts.migrated++;
      dirty = true;
      console.log(`[migrate] ${userId} ${acct.id}: migrated`);
    }

    if (dirty && !DRY_RUN) {
      atomicWrite(accountsPath, JSON.stringify(accounts, null, 2));
      console.log(`[migrate] ${userId}: wrote updated email-accounts.json`);
    } else if (dirty && DRY_RUN) {
      console.log(`[migrate] ${userId}: DRY RUN — would have written email-accounts.json`);
    }
  }

  console.log('');
  console.log(`=== migration ${DRY_RUN ? '(DRY RUN) ' : ''}summary ===`);
  console.log(`users scanned    : ${counts.usersScanned}`);
  console.log(`accounts scanned : ${counts.accountsScanned}`);
  console.log(`migrated         : ${counts.migrated}`);
  console.log(`already per-user : ${counts.skipped}`);
  console.log(`hard failures    : ${counts.failed}`);
  if (failures.length) {
    console.log('');
    console.log('Failed records (manual intervention required):');
    for (const f of failures) console.log(`  - ${f}`);
  }
}

main();
