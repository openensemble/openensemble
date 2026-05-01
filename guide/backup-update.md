# Backup, restore, auto-update

## Backups

OpenEnsemble is fully backed by files on disk — `users/`, `config.json`, `messages.json`, `tasks/`, `expenses/`, `roles/`, etc. The Backup tab packs all of them into a single `tar.gz`.

### Export

**Settings → Backup → Export Backup** → **Download**. The file includes:

- `config.json` (without your encryption secret, by default — see below)
- All user dirs under `users/`
- `messages.json`, `threads.json`, `tasks/`
- Expenses, autolabel rules, sharing manifest
- Custom skills, custom drawers, custom roles

It does **not** include the bundled GGUF models, your `node_modules/`, or anything in `.git`.

### Restore

Two paths:

- **Existing install** — Settings → Backup → Restore Backup → upload `.tar.gz`. Replaces current state.
- **Fresh install** — on the first-run screen, click "Already have an OpenEnsemble backup?" and upload. Skips the rest of first-run.

Restore is destructive: anything currently in the install is overwritten. Take an export first if you might want to roll back.

### Encryption keys

OpenEnsemble auto-generates a per-user encryption key the first time a user has any data that needs encrypting at rest (saved IMAP passwords today; more secrets in future skills). The key is a 32-byte file at `users/{userId}/.master-key` with permissions `0600`. There's nothing to copy, paste, or write down — you don't see it in the UI, and it isn't a password.

For backups specifically:

- **Default behaviour.** The backup tar packs the whole `users/` directory, so each user's `.master-key` is included automatically. Restore on a new host gets the keys with the rest of the data and encrypted records decrypt fine — no extra steps.
- **What to be careful about.** If you ever pull `.master-key` *out* of a backup manually (e.g. to share a backup without secrets), the encrypted fields in that backup become unrecoverable on the destination box. The key is not derivable from anything else.
- **File permissions.** OE chmods `.master-key` back to `0600` on every read, so it self-heals if a restore or rsync widens the permissions.

In short: as long as you don't surgically remove `.master-key` from a backup, restore "just works".

## Software auto-update

Owner/admin sees a green **Update** badge in the status bar when a new commit lands on the configured git remote. Clicking it opens **Settings → System → Software Update**.

### How it works

1. Server polls the remote (default `origin`) on `updateCheckIntervalMs` (default 1h, minimum 60s).
2. If new commits exist *and* the working tree is clean *and* there are no unpushed commits, the badge appears.
3. Click **Apply Update** — server fast-forwards, runs `npm install` if `package.json` changed, then restarts itself.
4. Browser reconnects automatically once the server is back.

### When it refuses to update

The flow refuses to update if:
- The working tree is dirty.
- There are unpushed local commits.
- The remote has been force-pushed (would require a merge).

It will never `git stash` or `git reset --hard`. Resolve those manually with `git status` from a terminal, then come back and click Update.

### Tunables in `config.json`

| Key | Default | Purpose |
|---|---|---|
| `updateCheckEnabled` | `true` | Master switch for periodic polling |
| `updateCheckIntervalMs` | `3600000` | Poll interval, ms (min 60000) |
| `updateRemote` | `origin` | Git remote to follow |

### Trust note

Auto-update means anyone with push access to your `updateRemote` can ship code that runs on your install. If you don't fully trust the upstream, fork the repo and set `updateRemote` to your fork.

## Manual restart

If you ever need to bounce the server without an update, **Settings → System → Restart Server**. It restarts in-place using the same detached-respawn flow as the update path. (Avoid using this mid-conversation — in-memory state like ongoing chat streams and pairing codes does not survive.)
