// Tests for the whole-file JSON encryption-at-rest helper used for
// OAuth/Microsoft token files. Verifies:
//   - encrypted round-trip is transparent
//   - on-disk bytes never contain the plaintext value
//   - legacy plaintext JSON files keep working until first re-save
//   - migrate helper converts in place
//
// Reuses the system master key path (users/_system/.master-key) so the
// tests exercise the real key-handling guard rails.

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';

import { readEncryptedJsonFile, writeEncryptedJsonFile, migrateJsonFileToEncrypted, isEncryptedEnvelope } from '../lib/encrypted-file.mjs';
import { encryptProfileSecrets, decryptedProfileView, getProfileSecret, PROFILE_SECRET_PATHS, isEncryptedField } from '../lib/config-secrets.mjs';
import { USERS_DIR } from '../routes/_helpers/paths.mjs';

// Seed the _system master key once for the suite — getSystemKey() refuses to
// silently regen on a populated install, but a fresh test base has no
// encrypted secrets yet, so pre-creating the key here is the same shape
// as bootstrapEncryption() running first on a real boot.
beforeAll(() => {
  const sysDir = path.join(USERS_DIR, '_system');
  fs.mkdirSync(sysDir, { recursive: true });
  const keyPath = path.join(sysDir, '.master-key');
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
});

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-enc-file-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('encrypted-file: whole-JSON envelope', () => {
  it('round-trips a token-shaped object', () => {
    const file = path.join(tmpDir, 'gmail-token.json');
    const tokens = {
      access_token: 'ya29.abc123-very-secret',
      refresh_token: '1//rt-not-public',
      expiry_date: Date.now() + 60_000,
    };
    writeEncryptedJsonFile(file, tokens, { mode: 0o600 });
    const back = readEncryptedJsonFile(file);
    expect(back).toEqual(tokens);
  });

  it('writes a recognizable envelope and never leaks plaintext to disk', () => {
    const file = path.join(tmpDir, 'gmail-token.json');
    const secret = 'rt-secret-marker-XYZ123';
    writeEncryptedJsonFile(file, { refresh_token: secret });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('refresh_token'); // field names are also encrypted
    const parsed = JSON.parse(raw);
    expect(isEncryptedEnvelope(parsed)).toBe(true);
    expect(parsed.__enc).toBe('v1');
    expect(typeof parsed.iv).toBe('string');
    expect(typeof parsed.tag).toBe('string');
    expect(typeof parsed.ct).toBe('string');
  });

  it('reads legacy plaintext JSON without modification', () => {
    const file = path.join(tmpDir, 'gmail-token.json');
    const tokens = { access_token: 'plain', refresh_token: 'also-plain' };
    fs.writeFileSync(file, JSON.stringify(tokens, null, 2));
    const back = readEncryptedJsonFile(file);
    expect(back).toEqual(tokens);
    // File on disk should still be plaintext — read doesn't migrate.
    expect(fs.readFileSync(file, 'utf8')).toContain('access_token');
  });

  it('migrateJsonFileToEncrypted upgrades plaintext in place', () => {
    const file = path.join(tmpDir, 'gmail-token.json');
    const tokens = { refresh_token: 'migrate-marker-ABC' };
    fs.writeFileSync(file, JSON.stringify(tokens));
    const did = migrateJsonFileToEncrypted(file);
    expect(did).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('migrate-marker-ABC');
    expect(readEncryptedJsonFile(file)).toEqual(tokens);
  });

  it('migrateJsonFileToEncrypted is idempotent on already-encrypted files', () => {
    const file = path.join(tmpDir, 'gmail-token.json');
    writeEncryptedJsonFile(file, { access_token: 'x' });
    const beforeBytes = fs.readFileSync(file);
    const did = migrateJsonFileToEncrypted(file);
    expect(did).toBe(false);
    const afterBytes = fs.readFileSync(file);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });
});

describe('config-secrets: profile.json paths', () => {
  it('encrypts telegram.botToken in place, leaves other fields alone', () => {
    const profile = {
      id: 'user_test',
      name: 'Test',
      role: 'owner',
      telegram: { botToken: 'live-bot-token-XYZ', webhookSecret: 'live-secret-ABC', chatId: '123' },
      coderWorkspace: '/home/x',
    };
    const stats = encryptProfileSecrets(profile);
    expect(stats.encrypted).toBe(2);
    expect(isEncryptedField(profile.telegram.botToken)).toBe(true);
    expect(isEncryptedField(profile.telegram.webhookSecret)).toBe(true);
    // Non-secret fields untouched.
    expect(profile.telegram.chatId).toBe('123');
    expect(profile.coderWorkspace).toBe('/home/x');
    expect(profile.role).toBe('owner');
  });

  it('decryptedProfileView returns plaintext without mutating the source', () => {
    const profile = {
      id: 'user_test',
      telegram: { botToken: 'live-bot-token', webhookSecret: 'live-secret', chatId: '123' },
    };
    encryptProfileSecrets(profile);
    // After encrypt: source is enveloped.
    expect(isEncryptedField(profile.telegram.botToken)).toBe(true);
    const view = decryptedProfileView(profile);
    // View is plaintext.
    expect(view.telegram.botToken).toBe('live-bot-token');
    expect(view.telegram.webhookSecret).toBe('live-secret');
    // Source still enveloped — decryptedProfileView is non-mutating.
    expect(isEncryptedField(profile.telegram.botToken)).toBe(true);
  });

  it('decryptedProfileView passes through legacy plaintext profiles', () => {
    const profile = {
      id: 'user_test',
      telegram: { botToken: 'never-encrypted', chatId: '999' },
    };
    const view = decryptedProfileView(profile);
    expect(view.telegram.botToken).toBe('never-encrypted');
  });

  it('getProfileSecret handles encrypted, plaintext, and missing', () => {
    const enc = { telegram: { botToken: 'x' } };
    encryptProfileSecrets(enc);
    expect(getProfileSecret(enc, 'telegram.botToken')).toBe('x');

    const plain = { telegram: { botToken: 'y' } };
    expect(getProfileSecret(plain, 'telegram.botToken')).toBe('y');

    const missing = { telegram: {} };
    expect(getProfileSecret(missing, 'telegram.botToken')).toBe(null);
  });

  it('PROFILE_SECRET_PATHS includes the two telegram paths', () => {
    expect(PROFILE_SECRET_PATHS).toEqual(expect.arrayContaining([
      'telegram.botToken', 'telegram.webhookSecret',
    ]));
  });
});
