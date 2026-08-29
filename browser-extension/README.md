# OpenEnsemble Bridge — browser extension

Chrome / Edge extension connecting your local OE server to your browser. All server-initiated commands pass through a **default-deny capability broker**: without an active lease you grant from the extension UI, OE cannot see or touch your tabs at all. Leases are scoped to specific tabs, **bound to the site the tab showed when you granted them**, expire after 15 minutes, and put a persistent amber banner on every leased tab. If a leased tab navigates to a different site — whether you clicked a link or OE navigated — access pauses (grey banner) until you press **Resume**.

"**Ask about this page**" is separate from all of that: it sends a one-time snapshot of the current page with your question and grants nothing — asking is consent to read that page once, not to let OE act on the tab.

## Install

1. In OE, open **Settings → Browser** and download **OE Bridge**, then extract
   the ZIP. Developers may use the OE checkout's local `browser-extension/`
   folder or clone the [standalone extension repository](https://github.com/openensemble/browser-extension).
2. Open `chrome://extensions` (or `edge://extensions`).
3. Toggle **Developer mode** in the top right.
4. Click **Load unpacked** and select the extracted `openensemble-bridge` folder
   (or the root of a development checkout).

The puzzle-piece icon appears in your toolbar. Pin it.

After updating an already loaded checkout or replacing an extracted download,
press **Reload** on the extension card, then reload any open pages where you
want the new content script and context-menu action.

## Configure

1. Click the extension icon to open the popup.
2. Optionally enter the OE server URL, then give this browser a friendly name. Each household member must use a separate browser profile; shared profiles are refused because they cannot isolate identity.
3. Press **Pair this browser**. The extension discovers OE and creates a browser-only P-256 identity key.
4. Open the approval link, confirm the displayed code in OE, and choose whether
   to enable agent browser access. Then return to the popup. It polls
   automatically, or you can press **I've approved — check now**.

An unfinished request lives only for the browser session, so opening OE to approve it does not lose the code. OE never gives the extension a web-session token. Re-pairing stages the replacement key and keeps the current credential untouched until the new key completes its first signed connection.

Pairing and agent-tool activation are separate. You can change activation later
in **Settings → Browser** or **Settings → Skills**, and revoke the browser
credential from **Settings → Browser**. Re-pairing preserves an existing
disabled state unless you explicitly turn access back on.

## What it does

Local ad blocking is enabled by default and works independently of pairing or
an OE tab lease. Everything runs in the browser: requests, matches, learned
rules, tier choices, and the pause list are never sent to the OE server, and the
extension never downloads a filter list.

Blocking has four layers, all fed by the artifacts under `rules/` and `filters/`
that `tools/build-filters.mjs` generates:

1. **Network rules** — per-tier `declarativeNetRequest` rulesets. No rule ever
   blocks a top-level navigation.
2. **Element hiding** — a per-tier stylesheet applied to every site, plus
   per-site rules bucketed so a page only loads the rules that can match it.
   Both are registered at `document_start`, so hidden elements never paint.
3. **Scriptlets** — `content-scriptlets.js` runs in the MAIN world for the sites
   that need it, defusing anti-adblock walls and first-party ad insertion that
   network and cosmetic rules cannot reach.
4. **Element collapsing** — a blocked third-party image or frame is removed from
   the layout instead of leaving a hole where the ad was.

The popup carries a master switch, one toggle per tier (**Ads**, **Trackers**,
**Cookie banners and nags** — the last off by default because it is the most
likely to interfere with a site), a **Pause on this site** button, and a count of
what was blocked on the current page. Reload the page after changing a setting so
already-started requests reflect it.

Domains can also be blocked by name from the popup, for telemetry endpoints no
public list covers. Hand-added blocks are dynamic `declarativeNetRequest` rules
at priority 4500 — above every list rule including its exceptions, below a site
pause at 5000 — and like every other block they exclude `main_frame`, so a
blocked domain still opens if it is typed into the address bar. The blocked and
paused lists occupy separate dynamic rule-id ranges so neither sync clears the
other's rules.

Pausing a site is enforced on both halves: a dynamic `allowAllRequests` rule
exempts the network layer, and every registered filter script carries the paused
host in its `excludeMatches`, so nothing is hidden either.

When the lists miss a page element, right-click the ad and choose **Block this ad
with OE**. The extension hides it immediately and saves a bounded cosmetic
selector for that top-level site and frame host, so matching elements are hidden
on later visits. It does not save visible page text, images, or a page snapshot.
The confirmation toast can undo the new rule, and the popup can undo the latest
rule or clear every learned rule for the current site.

Filter provenance, licensing, and how to rebuild the lists are documented in
`rules/README.md`.

Command tiers (enforced by the broker in `background.js`):

- **Requires an active lease** — `list_tabs` (active leased tabs only), `read_page` (reduced text + links + JSON-LD, no raw HTML), `screenshot`, safe `type`/`keypress`, and tab navigation (`back`/`forward`/`reload`/`close_tab`/`focus_tab`/`focus_window`). Every action is bound to the exact tab and live page authorized by the broker.
- **Requires per-use confirmation** — opening tabs, ambiguous or consequential clicks, and media control. Confirmations bind to the exact inspected tab, origin, document, and target; form submission, Enter, and Space remain unavailable.
- **Adaptive learning runs** — after a one-time extension confirmation, OE can inspect the live semantic page state, reason about one accessibility-addressed action, execute it through the broker, inspect again, and save only explicitly verified successes as an origin-bound playbook. Playbooks are hints for future replanning, never blind macros; runtime form text, secrets, page instructions, selectors, coordinates, screenshots, and raw HTML are not learned.
- **Teach Mode** — starts only from a direct user click, observes one tab and origin, redacts sensitive identifiers and values, and can save semantic routines or bounded site notes. Routines persist accessibility targets—not selectors or coordinates—and revalidate every step during replay.

Lease semantics:

- A grant covers **one tab on one site** (the origin showing when you pressed Allow). Granting another tab replaces it; there is no silent multi-tab expansion. Cross-origin navigation suspends the grant — the amber banner turns grey with a **Resume** button.
- **Sensitive pages fail closed everywhere**: grants, resumes, and one-shot asks are refused on login/banking/payment/health/password-manager pages, private/local/intranet origins, browser-internal pages, and any domain on the `neverReadDomains` list.

There is **no ambient telemetry**: the server receives no tab list at connect time and no tab open/close/navigate events. Page content is treated as untrusted data — nothing a page says can grant a lease, resume one, or trigger a command, and one-shot snapshots are framed to the model as untrusted data.

Field watches are a separate standing permission, created from **Watch field** in the side panel. The user clicks one displayed value and confirms the full exact URL, selector, predicate, and cadence. OE first uses matching schema.org/JSON-LD product data when available; otherwise only the paired browser that created the watch may open that exact URL and read that exact selector. Routine checks send a bounded value record—never a screenshot, page HTML, surrounding text, cookies, clicks, or a general tab lease—and two matching changed readings are required before notification. Active watches and their permissions can be listed or revoked from the same panel.

Other explicit, no-lease actions include selection/page/image/screenshot/PDF questions, versioned Clip-to-project, comparison of locally selected tabs, TV/speaker handoff, and push-to-talk. Public PDFs are fetched cookie-free by OE with DNS pinning and extracted inside a resource-limited systemd sandbox. Project suggestions use coarse label-free matchers locally; project names are revealed only after the user opens a generic match, with Remember, Not relevant, and Forget controls.

## Security notes

- LAN-only by design — extension talks only to the OE server URL you set.
- Ad filtering and right-click learning stay inside the extension. The bundled
  rules are local, top-level navigation is never blocked, and no ad telemetry is
  sent to OE.
- The extension connects only to the paired OE server; any model/provider use follows that OE profile's normal provider configuration.
- Leases can only be created by a click in the extension's own UI, never by the server or page content. They live in `storage.session` (cleared on browser restart), use a deny tombstone if storage fails, and are revocable from the popup or banner.
- The browser-owned toolbar badge is the authoritative lease indicator (`ON` active, pause symbol suspended); page banners are a helpful secondary indicator that a hostile page could remove.
- Password, payment, and one-time-code fields always reject OE typing.
- Secure pairing stores a P-256 private JWK in extension-local storage and registers only its public JWK with OE. Pending claim secrets and unfinished keys use session storage and disappear on browser restart. Browser WebSockets accept signed browser credentials only; revocation disconnects the live socket immediately.

## Uninstalling

`chrome://extensions` → click **Remove** on OpenEnsemble Bridge.

The private browser key is wiped with extension storage. Revoke its paired-browser entry in OE to invalidate the server-side public credential and disconnect any live socket immediately.
