# OpenEnsemble Bridge — browser extension

Phase 1 (LAN-only, read-only) Chrome / Edge extension that lets your local OE server see your open tabs, open new ones, and read the sanitized text of any page you're on.

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
4. **Browser name** — optional friendly label ("Shawn's MacBook Chrome").
5. **Save & connect**. Status pill should turn green within a couple of seconds.

## What it does

- Reports your open tabs to OE in real time.
- Accepts three commands from the OE server:
  - `open_tab` — opens a URL in a new tab.
  - `read_page` — returns sanitized text + links + JSON-LD of one tab. No raw HTML.
  - `list_tabs` — just returns the current snapshot.
- **It cannot fill forms, click buttons, or submit anything.** Tier 1 (write) primitives are deferred until a permission UI lands.

## Security notes

- LAN-only by design — extension talks only to the OE server URL you set.
- No third-party services involved.
- Passwords and credit cards are blocked at the extension layer (Phase 2 enforcement; Phase 1 is read-only so the question doesn't arise).
- Token in `chrome.storage.local` — same protection level as the rest of your Chrome data.

## Uninstalling

`chrome://extensions` → click **Remove** on OpenEnsemble Bridge.

The token is wiped with the extension storage. The OE server forgets the connection within a few seconds.
