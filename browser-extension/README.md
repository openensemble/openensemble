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
3. While logged into OE in this browser, press **Detect & connect**. This legacy cookie handoff is temporary; browser-only device-code pairing replaces it in the next release slice.
4. **Browser name** — optional friendly label ("Living Room Browser").
5. **Save & connect**. Status pill should turn green within a couple of seconds.

## What it does

Command tiers (enforced by the broker in `background.js`):

- **Requires an active lease** — `list_tabs` (active leased tabs only), `read_page` (reduced text + links + JSON-LD, no raw HTML), `screenshot`, safe `type`/`keypress`, and tab navigation (`back`/`forward`/`reload`/`close_tab`/`focus_tab`/`focus_window`). Every action is bound to the exact tab and live page authorized by the broker.
- **Requires per-use confirmation** — `open_tab`, `click_xy`, `media_control`, `submit_form`, Enter, and Space. The confirmation UI is the next slice, so these actions currently fail closed.
- **Teach Mode** — the old server-enabled, all-tab mode is disabled. It returns only after the extension has a direct user-clicked, tab-and-origin-scoped Teach grant.

Lease semantics:

- A grant covers **one tab on one site** (the origin showing when you pressed Allow). Granting another tab replaces it; there is no silent multi-tab expansion. Cross-origin navigation suspends the grant — the amber banner turns grey with a **Resume** button.
- **Sensitive pages fail closed everywhere**: grants, resumes, and one-shot asks are refused on login/banking/payment/health/password-manager pages, private/local/intranet origins, browser-internal pages, and any domain on the `neverReadDomains` list.

There is **no ambient telemetry**: the server receives no tab list at connect time and no tab open/close/navigate events. Page content is treated as untrusted data — nothing a page says can grant a lease, resume one, or trigger a command, and one-shot snapshots are framed to the model as untrusted data.

## Security notes

- LAN-only by design — extension talks only to the OE server URL you set.
- No third-party services involved.
- Leases can only be created by a click in the extension's own UI, never by the server or page content. They live in `storage.session` (cleared on browser restart), use a deny tombstone if storage fails, and are revocable from the popup or banner.
- The browser-owned toolbar badge is the authoritative lease indicator (`ON` active, pause symbol suspended); page banners are a helpful secondary indicator that a hostile page could remove.
- Password, payment, and one-time-code fields always reject OE typing.
- The current general session token in `chrome.storage.local` is transitional and must not be used for a published build; browser-only pairing is the next required release gate.

## Uninstalling

`chrome://extensions` → click **Remove** on OpenEnsemble Bridge.

The token is wiped with the extension storage. The OE server forgets the connection within a few seconds.
