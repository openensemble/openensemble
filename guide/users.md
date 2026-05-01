# Users & access

OpenEnsemble is multi-user from the ground up. Every user has their own isolated workspace under `users/{userId}/` — agents, skills, sessions, history, uploads, and settings all separate.

## Roles

There are three account roles:

- **Owner** — exactly one. Created during first-run setup. Manages providers, system settings, the Cloudflare tunnel, software updates, backups. Can do anything any other role can.
- **Admin** — full user/feature management, can configure system settings the owner enables. Cannot manage other admins or the owner.
- **User** — default role for new accounts. Has a private workspace; can use whichever providers and features the owner has allowed.

## Adding users

**Settings → Users → Add User** (owner/admin only). Pick name, emoji, password, role. Optional: limit which features they can see, attach a child-mode prompt, restrict provider access.

The new user can sign in immediately at the same URL — they pick their profile from the user picker on login.

## Invites

If you want someone else to set their own password, use **Settings → Users → Generate Invite**. Pick a role, optionally an email; OpenEnsemble produces an invite link (and emails it if you provided an address). The link is single-use and expires.

## Access schedules

Every user can have an **access schedule** — a set of allowed time windows. Outside the window, login is rejected. Useful for child accounts ("only between 4pm and 8pm on weekdays") or for limiting an account to working hours.

Configure under **Settings → Users → {user} → Access**. Schedules are evaluated at login and on session refresh.

## Per-user feature visibility

Owner can hide entire drawers and tabs from a user — useful for child accounts or for limiting clutter. Toggleable per-user in **Settings → Users → {user} → Features**.

## Sessions

A logged-in user has one or more session tokens, listed in **Settings → Profile → Active Sessions**. Revoke any session to log that device out.

Default expiry is 30 days; tunable with `OE_SESSION_EXPIRY` (in seconds) or in **Settings → System → Session Expiry**.

## Switching users

The user pill at the bottom of the sidebar opens the profile picker. Switching is just re-auth — no data crosses between users.

## Deleting users

Owner/admin can delete a user from **Settings → Users**. This nukes `users/{userId}/`. There is no undo, so back up first if you might want their work later.
