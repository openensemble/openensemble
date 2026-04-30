# Migration: per-user encryption keys

**Status:** in progress (started 2026-04-30)
**Goal:** move IMAP password encryption (and future skill-config secret encryption) from a single global key in `config.json:imapEncryptionKey` to per-user keys at `users/{userId}/.master-key`.
**Why:** consistent per-user isolation across all encrypted-at-rest data; sets up the same primitive for the upcoming skill-config `secret` field encryption; cleaner backup model (key travels with user dir).

## Threat model + non-goals

- **Defends against:** accidental leakage of a single user's config files (backup leak, log dump, git commit, file-exfil); cross-user routing bugs in OE that expose another user's encrypted data.
- **Does NOT defend against:** same-OS-account compromise (server has all per-user keys), runtime memory inspection, password-derived stronger isolation (deliberately not pursued — would break OE's background-task execution model).
- The UI must say "Encrypted at rest. Anyone with access to your OS account on this machine can still read it."

## Touched surface

| File | Change |
|---|---|
| `lib/crypto.mjs` (NEW) | AES-256-GCM primitive + `getUserKey(userId)` reading/generating `users/{userId}/.master-key` (mode 0600). |
| `lib/email-crypto.mjs` | Refactored to take `userId`. Per-user key first, global `imapEncryptionKey` as fallback for un-migrated records. Logs a warning when fallback fires. |
| `lib/imap-client.mjs` | All exported functions gain `userId` as first param; threaded into `decryptCreds(userId, account)`. |
| `lib/smtp-client.mjs` | Same: exported function gains `userId`. |
| `routes/email-accounts.mjs` | Pass `userId` to `encrypt(userId, password)` at account-create time. |
| `skills/email/execute.mjs` | `execImap(name, args, account, userId)` already had `userId` — thread it into the imap-client/smtp-client calls. |
| `scripts/migrate-email-crypto-to-per-user.mjs` (NEW) | One-shot migration: walks every `users/*/email-accounts.json`, decrypts with global key, re-encrypts with per-user key. Idempotent (skips already-migrated records). Run manually. |

## Phased plan

- **Phase 1:** add `lib/crypto.mjs` + `getUserKey(userId)`. No call-site changes yet. **Strictly additive — zero blast radius.**
- **Phase 2:** refactor `lib/email-crypto.mjs` to take userId with dual-key fallback. Old global path still works.
- **Phase 3:** thread `userId` through `imap-client.mjs`, `smtp-client.mjs`, `routes/email-accounts.mjs`, `skills/email/execute.mjs`. Server starts using per-user keys for *new* writes immediately. Old reads still work via global fallback.
- **Phase 4:** write migration script (don't run yet). Operator runs it on demand to re-key existing records.
- **Phase 5 (later release, NOT this PR):** delete `imapEncryptionKey` from `config.json` and the global-fallback code path in `email-crypto.mjs`. Only after verifying every install migrated.

## Rollback instructions

If anything goes wrong before Phase 5 (the global-key removal), full rollback is possible because `imapEncryptionKey` in `config.json` is preserved during the entire migration:

1. **Code revert:** `git stash` or `git checkout` the modified files. List of files to revert:
   - `lib/crypto.mjs` — DELETE
   - `lib/email-crypto.mjs` — restore from git
   - `lib/imap-client.mjs` — restore from git
   - `lib/smtp-client.mjs` — restore from git
   - `routes/email-accounts.mjs` — restore from git
   - `skills/email/execute.mjs` — restore from git
   - `scripts/migrate-email-crypto-to-per-user.mjs` — DELETE
2. **Data state:** if the migration script was run, accounts are now encrypted with per-user keys but the original global key still decrypts the SAME records *if the per-user re-encryption was skipped on that record* (idempotent script means already-migrated records cannot be decrypted with the global key). **CRITICAL:** to fully revert post-migration, you'd need to re-encrypt every record with the global key — there's no automated reversal script. Instead, the safer rollback is "stay on the new code, fix the bug forward."
3. **Per-user keyfiles** at `users/*/.master-key` can be left in place — they're harmless if unused. Or `rm` them if doing a clean revert.
4. **Verification commands:**
   ```bash
   # Confirm global key still present
   node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).imapEncryptionKey ? 'present' : 'MISSING')"
   # List per-user keyfiles
   ls -la users/*/.master-key 2>/dev/null
   # Check email-accounts state per user
   for f in users/*/email-accounts.json; do echo "=== $f ==="; node -e "const a=JSON.parse(require('fs').readFileSync('$f','utf8'));console.log(a.length,'accounts')"; done
   ```

## Migration script behavior contract

- Runs against every `users/*/email-accounts.json`.
- For each account with an `encryptedPassword`:
  - Try decrypt with **per-user key first**. If success, the record is already migrated — skip.
  - Else try decrypt with **global key**. If success, re-encrypt with per-user key and write the record back atomically. Log `migrated user_X account acct_Y`.
  - Else log a hard error `cannot decrypt user_X account acct_Y with either key — manual intervention needed` and continue. Do NOT crash, do NOT delete, do NOT modify the record.
- After run: prints summary `migrated N records, skipped M already-migrated, failed K`.
- Atomic writes (temp file + rename) — never leave a partial JSON on disk.
- Read-only first pass: `--dry-run` flag prints what would change without writing. Run dry-run before real run.

## Pre-flight checks before running the migration

- [ ] Code changes (Phases 1–4) merged and server has been restarted at least once successfully.
- [ ] `lib/email-crypto.mjs` `decrypt()` confirmed working for both per-user and global-key paths via a smoke test.
- [ ] Backup taken of `users/` and `config.json` (in case of unforeseen).
- [ ] Run with `--dry-run` first; visually inspect output.
- [ ] After real run, verify: log into each affected user's account in the UI, send a test fetch on each IMAP account, confirm no auth failures.

## Phase tracking

- [x] Phase 1: lib/crypto.mjs + getUserKey (2026-04-30)
- [x] Phase 2: email-crypto.mjs dual-key fallback (2026-04-30)
- [x] Phase 3: thread userId through call sites (2026-04-30)
- [x] Phase 4: migration script written (NOT YET RUN) (2026-04-30)
- [ ] Phase 5: global-key removal — DEFERRED to a later release

## Exact diff manifest (2026-04-30)

Files added:
- `lib/crypto.mjs` — AES-256-GCM primitive + `getUserKey(userId)` (lazy keyfile generation, mode 0600, atomic create with EEXIST race handling).
- `scripts/migrate-email-crypto-to-per-user.mjs` — one-shot migration. Run with `--dry-run` first. Idempotent.
- `MIGRATION_per-user-encryption.md` — this file.

Files modified:
- `lib/email-crypto.mjs` — replaced. New signatures: `encrypt(userId, plaintext)` / `decrypt(userId, ciphertext)`. Per-user key first, global `imapEncryptionKey` as decrypt-only fallback. Logs once per process when global fallback fires. Old export shape (`getImapKey`) removed.
- `lib/imap-client.mjs` — `decryptCreds(account)` → `decryptCreds(userId, account)`. All 5 exports now take `userId` as first arg: `fetchInboxPage`, `deleteImapMessages`, `markImapMessages`, `fetchImapReplyHeaders`, `fetchImapMessageBody`.
- `lib/smtp-client.mjs` — `sendSmtpEmail(account, …)` → `sendSmtpEmail(userId, account, …)`.
- `routes/email-accounts.mjs` — three call sites updated: `encrypt(userId, password)` at account-create, `fetchImapMessageBody(userId, account, msgId)` at GET /api/email/body, `fetchImapPage(userId, account, …)` at GET /api/inbox.
- `routes/admin.mjs` — `sendSmtpEmail(adminUserId, account, …)` in `sendInviteEmail`.
- `server.mjs` — `sendSmtpEmail(task.ownerId, sender, …)` in the reminder email-delivery path.
- `skills/email/execute.mjs` — `execImap` already received `userId`; threaded it into 8 call sites (all imap-client + smtp-client invocations).

Files NOT touched (intentionally):
- `config.json` — `imapEncryptionKey` preserved as the rollback safety net.
- Any pre-existing `users/*/email-accounts.json` — data unchanged until the migration script runs.

## Operator runbook (when you're ready to migrate real data)

```bash
# 1. Confirm code changes are deployed and the server has restarted at least once
node --check lib/crypto.mjs lib/email-crypto.mjs lib/imap-client.mjs lib/smtp-client.mjs

# 2. Backup
cp -a users/ users.backup-$(date +%Y%m%d-%H%M%S)
cp config.json config.json.backup-$(date +%Y%m%d-%H%M%S)

# 3. Dry run — visually inspect output
node scripts/migrate-email-crypto-to-per-user.mjs --dry-run

# 4. If the dry run looks clean, real run
node scripts/migrate-email-crypto-to-per-user.mjs

# 5. Smoke test in the UI: open inbox for each affected IMAP account, send a test email
```

If anything fails: see "Rollback instructions" above. The global key in `config.json` is preserved through the migration, so the dual-key fallback path in `lib/email-crypto.mjs:decrypt` keeps un-migrated records working even after partial failure.

## Known risks

- **Wrong userId at a call site** = silent decrypt failure when reading another user's account. The fallback to global key would mask this in the migration window. Mitigation: log when global fallback is used; the log line should include caller userId + account id so we can grep for cross-user contamination during testing.
- **Race condition on first-use keyfile generation** if two requests for the same user fire in parallel. Mitigation: use atomic write (`writeFileSync` with `flag: 'wx'`) and re-read on EEXIST.
- **mode 0600 may not be honored on Windows / NTFS / SMB-mounted homes.** Mitigation: best-effort chmod, log warning if mode after write isn't 0600.
- **Backup foot-gun is partly resolved** — keyfile is inside `users/{userId}/`, so `tar users/` includes it. But anyone restoring a single user's dir to a different install needs to bring the keyfile, otherwise that user's email accounts are unreadable on the new box.
