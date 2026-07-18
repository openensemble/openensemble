# OE Bridge

OE Bridge is the Chrome and Edge extension included with OpenEnsemble. It lets
you ask about a page and use selected browser workflows without giving OE
ambient access to your tabs.

## Install

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `browser-extension` folder inside your OpenEnsemble install.
5. Pin **OpenEnsemble Bridge** from the browser's extensions menu.

## Pair this browser

Open the Bridge popup, enter your OE server address if it was not discovered,
and choose **Pair this browser**. Open the approval link and confirm the code in
OE. Each household member should pair from a separate browser profile so their
identity and permissions remain isolated.

The extension receives a browser-only credential, not your OE web-session
token. You can revoke a paired browser from OE at any time; revocation also
disconnects its live socket.

## Permission model

- **Ask about this page** sends one bounded snapshot for the question you
  initiated. It does not create an ongoing grant.
- Browser commands need a short-lived lease granted from the extension UI. A
  lease applies to one tab and the site showing when you granted it.
- Navigating to another site suspends the lease until you explicitly resume it.
- Consequential actions such as opening tabs, ambiguous clicks, and media
  control require per-use confirmation.
- Login, payment, banking, health, password-manager, private-network, and
  browser-internal pages fail closed.

The toolbar badge is the authoritative lease indicator. `ON` means a lease is
active; the pause symbol means navigation suspended it. Closing the browser
clears session leases.

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
