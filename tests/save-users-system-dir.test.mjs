/**
 * Regression test for the saveUsers() orphan-cleanup bug that wiped
 * users/_system/.master-key on every /claim, news-preference set,
 * agent rename, and admin user mutation — silently orphaning every
 * encrypted-at-rest secret in config.json.
 *
 * Root cause traced 2026-05-26. The orphan-cleanup loop in saveUsers()
 * iterated users/ and rm -rf'd any subdirectory not in the user list.
 * `_system/` has no profile.json so loadUsers() never returns it, so
 * the cleanup always considered it an orphan and deleted it.
 *
 * Fix: only delete subdirs that match the user-id pattern (`user_*`).
 * System-reserved dirs (anything starting with `_`, plus `default`) are
 * untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import { loadUsers, saveUsers, saveUser } from '../routes/_helpers.mjs';

const PROD_USER = 'user_savesys_test_real';
const PROD_USER_2 = 'user_savesys_test_real2';
const ORPHAN_USER = 'user_savesys_test_orphan';

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); }
function cleanup() {
  for (const d of [PROD_USER, PROD_USER_2, ORPHAN_USER]) {
    try { fs.rmSync(path.join(USERS_DIR, d), { recursive: true, force: true }); } catch {}
  }
}

beforeEach(() => {
  cleanup();
  ensure(USERS_DIR);
  // Pre-seed _system with a master-key sentinel.
  const sysDir = path.join(USERS_DIR, '_system');
  ensure(sysDir);
  fs.writeFileSync(path.join(sysDir, '.master-key'), 'SENTINEL_KEY_DO_NOT_DELETE');
});

afterEach(() => {
  cleanup();
  // Don't delete _system itself — it should still hold the sentinel after
  // every test, since saveUsers must not touch it.
});

describe('saveUsers preserves system-reserved dirs', () => {
  it('does NOT delete users/_system when called with a list missing _system', () => {
    // Simulate what /claim, news-pref, agent-rename do: load users (which
    // never includes _system), mutate one, save.
    const list = [{ id: PROD_USER, name: 'Test', skills: ['coder'] }];
    saveUsers(list);
    const sysPath = path.join(USERS_DIR, '_system', '.master-key');
    expect(fs.existsSync(sysPath)).toBe(true);
    expect(fs.readFileSync(sysPath, 'utf8')).toBe('SENTINEL_KEY_DO_NOT_DELETE');
  });

  it('does NOT delete arbitrary _-prefixed dirs (forward-compat for _admin, etc.)', () => {
    const adminDir = path.join(USERS_DIR, '_admin_future');
    ensure(adminDir);
    fs.writeFileSync(path.join(adminDir, 'sentinel'), 'keep');
    const list = [{ id: PROD_USER, name: 'Test', skills: [] }];
    saveUsers(list);
    expect(fs.existsSync(path.join(adminDir, 'sentinel'))).toBe(true);
    try { fs.rmSync(adminDir, { recursive: true, force: true }); } catch {}
  });

  it('does NOT delete the legacy `default` dir', () => {
    const defaultDir = path.join(USERS_DIR, 'default');
    ensure(defaultDir);
    fs.writeFileSync(path.join(defaultDir, 'runpod-config.json'), '{}');
    const list = [{ id: PROD_USER, name: 'Test', skills: [] }];
    saveUsers(list);
    expect(fs.existsSync(path.join(defaultDir, 'runpod-config.json'))).toBe(true);
    try { fs.rmSync(defaultDir, { recursive: true, force: true }); } catch {}
  });

  it('STILL deletes orphan user_* directories not in the list', () => {
    // The cleanup behavior we DO want: a user_* dir not in the saved list
    // gets removed. This is how routes/users.mjs deletes a user.
    const orphanDir = path.join(USERS_DIR, ORPHAN_USER);
    ensure(orphanDir);
    fs.writeFileSync(path.join(orphanDir, 'profile.json'), JSON.stringify({ id: ORPHAN_USER, name: 'orphan' }));
    const list = [{ id: PROD_USER, name: 'Test', skills: [] }];
    saveUsers(list);
    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it('writes every user in the list to disk', () => {
    const list = [
      { id: PROD_USER, name: 'A', skills: [] },
      { id: PROD_USER_2, name: 'B', skills: [] },
    ];
    saveUsers(list);
    const reloaded = loadUsers().filter(u => u.id === PROD_USER || u.id === PROD_USER_2);
    expect(reloaded.map(u => u.id).sort()).toEqual([PROD_USER, PROD_USER_2]);
  });
});
