# Security model

OpenEnsemble assumes you trust the people who have accounts on your install — but it doesn't assume the network or the agents themselves are trustworthy.

## Authentication

- Login uses session tokens carried in the `Authorization: Bearer …` header. Never in URLs (URLs leak via Referer headers and access logs).
- Default session expiry is 30 days. Shorten it with `OE_SESSION_EXPIRY` (seconds) or in **Settings → System → Session Expiry**.
- All sessions for a user are listable and revocable in **Settings → Profile → Active Sessions**.

## Roles

`owner` > `admin` > `user`. Privileged endpoints check the requester's role; users can't escalate via skills or the API.

## Coder sandbox

The `coder` skill wraps every shell command in **bubblewrap** with:

- Read-only view of the host filesystem.
- A writable bind-mount of just the project directory the agent is working in.
- Network on (needed for `npm`, `pip`, `git`).
- No access to other users' workspaces.

So an agent that's told "delete every file on the system" will, at worst, delete files inside its own project dir.

## File-ownership enforcement

Every path passed to download / delete / shell is `realpath`-checked against the caller's user directory before use. Symlinks can't escape the workspace; the resolved path must still live under `users/{callerId}/`.

## Media tokens

Some assets (images in chat bubbles, video previews, PDFs in iframes) need to authenticate but can't carry a Bearer header. For those, the server mints **short-lived (10-minute) URL-embedded media tokens** on demand. Static long-lived URLs aren't issued.

## Per-user encryption at rest

OpenEnsemble encrypts certain sensitive per-user fields at rest using a per-user 32-byte AES-256 key. There is no toggle to enable or disable this — the encryption is automatic for the fields that use it (currently IMAP account passwords; more will move under it in future releases).

How it works:

- The first time a user has data that needs encrypting, OE generates a fresh key and writes it to `users/{userId}/.master-key` with file permissions `0600`.
- Encryption uses AES-256-GCM with a fresh IV per record.
- The key never leaves the install — it's not shown in the UI, not exported by any API, and not derivable from your password.
- The key file is owned by the OS user the OE process runs as. Anyone with shell access on the host can read it; the protection is against backup theft and remote compromise, not against a malicious local admin.

Backups include `users/{userId}/.master-key` by default (it lives under the user dir, which is packed in full), so a restore on another host decrypts cleanly. If you want a backup without secrets, you'd need to manually exclude every `.master-key` file from the tarball — and accept that encrypted fields in that copy become unrecoverable on the destination.

## Network surface

- **Inbound 3737** — the web UI and API. Required.
- **Outbound** — to whichever LLM provider APIs you've enabled, plus optional Cloudflare tunnel (cloudflared establishes its own tunnel; you don't have to open inbound ports if you use it).
- Telegram and OAuth callbacks come in over the Cloudflare tunnel if configured.

## What OpenEnsemble does *not* protect against

- A user with shell access to the host machine. They can read all the files. Don't share host accounts.
- A malicious provider — your prompts and the data you attach are sent to whichever cloud LLM you configured. Pick providers you trust.
- A malicious skill you install. Skills are arbitrary JS. Owner/admin should review user-authored skills before allowing them broadly.
- Your password being reused or trivial. Use a real password and consider using OS-level firewalling if your install is reachable from open networks.

## Reporting issues

If you find a security issue, file at the project repo's Issues — flag it as security so it's triaged quickly.
