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

## Role permissions and the Coordinator

The **Allowed roles** list is the account's authorization boundary. For a
regular adult user with an explicit role allowlist, allowing the Coordinator
role **and assigning it to one of that user's agents** also allows the hidden
orchestration tools that make that role work: agent delegation, bounded
background workers, and background-task status. They are dependencies of the
Coordinator rather than separate checkboxes.

In an agent ensemble, the Coordinator can delegate to the user's own
specialists. In single-assistant mode, named-agent delegation is unavailable,
but the primary assistant can still use private background workers and inspect
their status. Child accounts never inherit these hidden permissions.

**Lock tool activation** prevents the user from changing their tool and role
setup; it does not revoke capabilities an administrator already granted.
Blocking the Coordinator role is the reliable way to revoke orchestration
access. For explicitly restricted users, removing its valid agent assignment
also removes the implied hidden-tool grant. An unrestricted legacy account
must first be given an explicit allowlist if these capabilities need to be
denied individually.

## Invites

If you want someone else to set their own password, use **Settings → Users → Generate Invite**. Pick a role, optionally an email; OpenEnsemble produces an invite link (and emails it if you provided an address). The link is single-use and expires.

## Access schedules

Every user can have an **access schedule** — a set of allowed time windows. Outside the window, login is rejected. Useful for child accounts ("only between 4pm and 8pm on weekdays") or for limiting an account to working hours.

Configure under **Settings → Users → {user} → Access**. Schedules are evaluated at login and on session refresh.

## Per-user feature visibility

Owner can hide entire drawers and tabs from a user — useful for child accounts or for limiting clutter. Toggleable per-user in **Settings → Users → {user} → Features**.

## Per-user display dashboards

Each profile owns an independent Display dashboard library, including its Home
dashboard, layouts, colors, and stable slugs. Two profiles can both use
`/dashboards/home`; the signed-in profile determines which one the browser
sees. Dashboard cards still follow that profile's skill permissions, feature
visibility, Home Assistant grant, and access schedule.

## Sessions

A logged-in user has one or more session tokens, listed in **Settings → Profile → Active Sessions**. Revoke any session to log that device out.

Browser sessions have a fixed seven-day maximum. `OE_SESSION_EXPIRY` or
**Settings → System → Session Expiry** sets an optional shorter idle timeout in
hours; `0` disables the idle timeout but not the seven-day hard limit. This also
applies to browsers left open as dashboard displays.

## Switching users

The user pill at the bottom of the sidebar opens the profile picker. Switching is just re-auth — no data crosses between users.

## Deleting users

Owner/admin can delete a user from **Settings → Users**. This nukes `users/{userId}/`. There is no undo, so back up first if you might want their work later.
