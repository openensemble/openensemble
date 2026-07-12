# OpenEnsemble Bridge — browser extension

Chrome / Edge extension connecting your local OE server to your browser. All server-initiated commands pass through a **default-deny capability broker**: without an active lease you grant from the extension UI, OE cannot see or touch your tabs at all. Leases are scoped to specific tabs, **bound to the site the tab showed when you granted them**, expire after 15 minutes, and put a persistent amber banner on every leased tab. If a leased tab navigates to a different site — whether you clicked a link or OE navigated — access pauses (grey banner) until you press **Resume**.

"**Ask about this page**" is separate from all of that: it sends a one-time snapshot of the current page with your question and grants nothing — asking is consent to read that page once, not to let OE act on the tab.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** in the top right.
3. Click **Load unpacked**.
4. Pick `~/.openensemble/browser-extension/`.

The puzzle-piece icon appears in your toolbar. Pin it.

## Configure

1. Click the extension icon to open the popup.
2. **OE server URL** — `http://localhost:3737` if OE is running on this machine, or `http://<lan-ip>:3737` if it's on another box on your LAN.
3. **Auth token** — the same token your browser uses to talk to OE. On the OE machine, while logged in, run:
   ```
   curl http://localhost:3737/api/browser/setup-token --cookie-jar /tmp/oe.cookies
   ```
   Or grab it from the Settings → Browser Bridge tab once that lands.
4. **Browser name** — optional friendly label ("Living Room Browser").
5. **Save & connect**. Status pill should turn green within a couple of seconds.

## What it does

Command tiers (enforced by the broker in `background.js`):

- **No lease needed** — `media_control` (play/pause/skip; touches no page content) and `set_watch_mode` (teach mode — its own consent surface with a persistent banner and explicit exit).
- **Requires an active lease** — `list_tabs` (active leased tabs only), `open_tab` (new tab joins the lease, bound to the opened URL's origin; sensitive URLs refused), `read_page` (sanitized text + links + JSON-LD, no raw HTML), `screenshot`, `click_xy`, `type`, `keypress`, tab navigation (`back`/`forward`/`reload`/`close_tab`/`focus_tab`/`focus_window`).
- **Always requires per-use confirmation** — `submit_form`. The confirmation UI doesn't exist yet, so form submission currently always fails closed: clicks on submit controls are refused, synthetic Enter never falls back to `requestSubmit()`, and a capture-phase guard blocks submits that fire right after an OE-injected action.

Lease semantics:

- A grant covers **one tab on one site** (the origin showing when you pressed Allow). Cross-origin navigation suspends the grant — the amber banner turns grey with a **Resume** button; nothing works on that tab until you press it (or re-Allow from the popup).
- **Sensitive pages fail closed everywhere**: grants, resumes, one-shot asks, and OE-opened tabs are all refused on login/banking/payment/health/password-manager pages, browser-internal pages, and any domain on the `neverReadDomains` list in extension storage. There is deliberately no override until a per-use confirmation UI exists.

There is **no ambient telemetry**: the server receives no tab list at connect time and no tab open/close/navigate events. Page content is treated as untrusted data — nothing a page says can grant a lease, resume one, or trigger a command, and one-shot snapshots are framed to the model as untrusted data.

## Security notes

- LAN-only by design — extension talks only to the OE server URL you set.
- No third-party services involved.
- Leases can only be created by a click in the extension's own UI, never by the server or page content. They live in `storage.session` (cleared on browser restart) and are revocable from the popup or the on-page banner.
- In teach/watch mode, password and credit-card field **values** are never captured — only the fact of interaction.
- Token in `chrome.storage.local` — same protection level as the rest of your Chrome data.

## Uninstalling

`chrome://extensions` → click **Remove** on OpenEnsemble Bridge.

The token is wiped with the extension storage. The OE server forgets the connection within a few seconds.
