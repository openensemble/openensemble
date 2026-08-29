# OE Bridge

OE Bridge is the Chrome and Edge extension included with OpenEnsemble. It lets
you ask about a page and use selected browser workflows without giving OE
ambient access to your tabs.

## Install

1. In OE, open **Settings → Browser** and choose **Download OE Bridge**.
2. Extract the downloaded ZIP.
3. Open `chrome://extensions` or `edge://extensions`.
4. Turn on **Developer mode**.
5. Choose **Load unpacked** and select the extracted
   `openensemble-bridge` folder.
6. Pin **OpenEnsemble Bridge** from the browser's extensions menu.

This works from any household member's computer; they do not need command-line
access or access to the OE server's filesystem.

## Pair this browser

Open the Bridge popup, enter your OE server address if it was not discovered,
and choose **Pair this browser**. Open the approval link and confirm the code in
OE. Each household member should pair from a separate browser profile so their
identity and permissions remain isolated.

The extension receives a browser-only credential, not your OE web-session
token. You can revoke a paired browser from OE at any time; revocation also
disconnects its live socket.

On a profile's first pairing, OE explicitly offers to enable **Agent browser
access** at the same time. It can also be changed later under
**Settings → Browser** or **Settings → Skills**. Pairing and activation are
separate: a paired extension can use its user-initiated chat features while
agent browser tools remain off. If an administrator manages the profile's
tools, only the administrator can allow or unlock this capability.

## Permission model

- **Ask about this page** sends one bounded snapshot for the question you
  initiated. It does not create an ongoing grant.
- Browser commands need a short-lived lease granted from the extension UI. A
  lease applies to one tab and the site showing when you granted it.
- Opening a URL still requires an **Allow once** confirmation in the extension.
- Navigating to another site suspends the lease until you explicitly resume it.
- Consequential actions such as opening tabs, ambiguous clicks, and media
  control require per-use confirmation.
- Login, payment, banking, health, password-manager, private-network, and
  browser-internal pages fail closed.

The toolbar badge is the authoritative lease indicator. `ON` means a lease is
active; the pause symbol means navigation suspended it. Closing the browser
clears session leases.

## Local ad and tracker blocking

The Bridge popup includes a local blocking switch. When it is on, bundled filter
lists block advertising and tracking requests, hide the leftover ad slots, and
neutralise scripts that detect ad blockers — all inside the browser. Request
details, matches, your tier choices, and your paused sites are never sent to OE,
and Bridge never downloads a filter list. It never blocks a top-level navigation
and does not depend on pairing or an agent tab lease.

Three tiers can be toggled independently:

- **Ads** (on) — banners, pop-ups, and sponsored placements.
- **Trackers** (on) — analytics and profiling scripts that follow you between
  sites. Google Analytics and Google's ad tag are replaced with harmless stubs
  rather than removed outright, so pages that call them keep working.
- **Cookie banners and nags** (off) — more intrusive, and a few sites misbehave
  with it on. Turn it on if you would rather dismiss fewer consent dialogs.

The popup shows how many requests were blocked on the page you are looking at.

If a site misbehaves, use **Pause on this site**. That turns off every layer for
that site — network rules, hidden elements, and scriptlets — and leaves the rest
of your browsing untouched. Press it again to resume.

For an ad the lists miss, right-click it and choose **Block this ad with OE**.
Bridge saves only a bounded, site-scoped element selector and applies it on later
visits to that site. The on-page confirmation offers **Undo**; the popup can also
undo the latest learned rule or clear all learned rules for the current site.
Turning blocking off keeps learned rules but stops applying them until it is
turned back on. Reload the page after changing any of these so already-started
network requests reflect the new setting.

### Blocking a specific domain

Some endpoints are pure telemetry and no public list covers them. To block one
by name, open the popup and type it under **Block a domain everywhere** — for
example `log.byteoversea.com` — then press **Block**. Pasting a full URL works
too; Bridge keeps just the hostname.

A blocked domain covers its subdomains, applies on every site, and overrides the
filter lists' own exceptions, because you asked for it by name. Two things still
win over it: pausing a site turns everything off there, and OE never blocks a
top-level navigation, so a blocked domain still opens if you type it into the
address bar. Remove an entry with **Remove** next to it.

Blocked domains are stored in your browser and are never sent to OE.

### Keeping the lists current

The lists ship with the extension and work offline, so they age between OE
releases. An OE admin can refresh them from **Settings → Browser**: OE fetches
and reconverts the upstream lists itself, so your browser still only ever talks
to OE. After a refresh, reload OE Bridge on the browser's extensions page —
Chrome only reads the bundled rules when the extension loads.

## Field watches

The Bridge side panel can watch a value you explicitly select. The confirmation
shows the exact page, selector, condition, and cadence. Routine checks return a
bounded value record rather than page HTML, cookies, screenshots, or a general
tab grant. You can list and revoke watches from the same panel.

## Current custom-skill limitation

Bridge is shipped for OE's built-in browser workflows. The public custom-skill
surfaces sometimes described as `ctx.browser`, `helpers.browser`, or
`browser_list` are not released yet. Custom skills should use RSS, public APIs,
JSON-LD, or bounded server-side fetching until that API is documented and
enforced by the same lease broker.

For implementation-level details and troubleshooting, see
`browser-extension/README.md` in the OE install.
