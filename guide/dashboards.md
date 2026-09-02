# Display dashboards

Display dashboards are per-profile browser displays for wall tablets, room
screens, and quick at-a-glance views. They are managed inside OpenEnsemble but
open at their own stable addresses, such as `/dashboards/kitchen`.

They are separate from **Workspace**. Workspace is the document and widget grid
inside the main OE app; Display dashboards are the dedicated, full-browser
views described here.

## Open the dashboard studio

Open **Dashboard** from either the main Chat/Dashboard/Workspace switcher or
the left menu, then choose **Display dashboards**. Both Dashboard entries open
the same drawer and studio.

The library shows every dashboard owned by the signed-in profile. From each
entry you can:

- **Configure** it in OE.
- **Open display** in a new browser tab.
- **Copy address** for a tablet or bookmark.
- **Duplicate** it as the starting point for another display.
- **Delete** it, except for the required Home dashboard.

A profile can have up to 32 dashboards. **Home** is created automatically and
always remains the default dashboard.

## Create a dashboard

Choose **New dashboard**, then set:

- **Name** and optional **Description**.
- **Stable address**: a lowercase slug made from letters, numbers, and hyphens.
  The slug is fixed after creation, so renaming the dashboard does not break
  its address.
- **Base theme**: Midnight or Warm daylight.
- **Starting layout**:
  - **Blank** creates one empty section.
  - **Starter home** builds a balanced layout from Home Assistant entities the
    profile can read. If those entities are unavailable, choose Blank.
  - **Copy existing** copies another dashboard's complete layout. The new copy
    is independent after creation.

## Configure the layout

Choose **Configure** in the library. The editor opens inside OE at a useful
working size; this is the supported editing surface. Adding `?oe_editor=1` to
a dashboard opened directly does not turn that top-level display into an
editor.

Use **Customize** to edit the canvas. You can:

- Add, rename, reorder, restyle, collapse, or remove sections.
- Add Home Assistant entities as separate cards or combine two or more in a
  group card.
- Rename, resize, recolor, move, change the presentation of, or remove cards.
- Organize the Rooms and Devices focus views and choose Overview, Rooms, or
  Devices as the dashboard's default focus.
- Remove every section for a completely blank canvas. Configure mode keeps a
  **New section** action available.

Layout changes such as cards, sections, and room/device organization autosave.
Changes in **Dashboard settings**—including the name, theme, default focus,
page elements, colors, and tagline—are applied with **Save dashboard**. If a
second editor has changed the same layout, OE stops instead of overwriting it
and asks you to reload the current version.

## Add cards and widgets

Choose **Add card**, then select **Devices** or **Widgets**.

| Source | What it shows | What it needs |
|---|---|---|
| Home Assistant | Live entities, cameras, weather, grouped devices, and supported controls | Home Assistant configured in OE and Home Assistant access enabled for the profile |
| Calendar | A read-only agenda beginning today | The `gcal` skill enabled and Google Calendar connected; choose Today or the next 3, 7, or 14 days |
| Email | A read-only recent-inbox view | The `email` skill and Inbox feature enabled, plus a connected Gmail, Microsoft, or IMAP account; choose the account, item count, and whether to show snippets |
| Custom skill | A summary, metrics, or list rendered by OE | An enabled, user-scoped custom skill with a valid `dashboardWidgets` declaration |

Each widget refreshes independently. If one source is unavailable, its card
shows the problem without blanking the rest of the dashboard. If a refresh
fails after a successful result, the card may continue showing that last result
as stale until it can refresh.

Custom-skill widgets are deliberately declarative: the skill returns bounded
text, metrics, and list data, while OE owns the markup. A widget must bind to an
exact same-skill tool marked `readOnly:true` and non-destructive. Its unattended
refresh runs with the skill/user filesystem read-only and native network access
disabled, so a common pattern is for an ordinary approved tool or watcher to
update local state and for the widget to read that snapshot. A skill cannot
inject dashboard HTML or JavaScript, read plaintext credentials from the
widget request, or turn the widget into an arbitrary network client.

To add a widget to a new or existing custom skill, ask an agent with Skill
Builder to create or update that skill's dashboard widget. See **Building
custom skills** in the Guide for the authoring details.

## Choose exactly what the page shows

Open **Customize → Dashboard settings**. Every dashboard can independently
show or hide:

- the sidebar and top toolbar;
- OpenEnsemble branding;
- Overview/Rooms/Devices focus navigation and section shortcuts;
- sidebar connection status and the live source status above the greeting;
- an automatic greeting, exact custom greeting, or no greeting;
- the tagline, clock and date, Home Assistant summary, and section headings.

Configure mode keeps its management controls visible even when the standalone
display hides those page elements.

The same settings panel has exact six-digit hex colors for the background,
surfaces, cards, primary text, muted text, accent, greeting, and tagline. Leave
a color blank to inherit it from the base theme, or use **Reset all** to return
the whole palette to the theme. OE warns about likely low contrast but lets you
make the final choice. The embedded editor stays on a readable base theme and
shows custom colors in its preview; the standalone display applies the saved
palette to the page.

## Move between multiple dashboards

When the signed-in profile has more than one dashboard, the standalone display
can move through them without a hardcoded new address:

- Swipe left for the next dashboard.
- Swipe right for the previous dashboard.
- Navigation follows the dashboard library's saved order and wraps at both
  ends.
- The top toolbar also shows Previous and Next buttons with the current name
  and position. These buttons are hidden with the toolbar, but touch swiping
  still works.

Swiping is disabled while configuring a dashboard and is ignored when a gesture
starts on a control, slider, menu, dialog, or horizontally scrollable content.
Moving to another dashboard clears the old section/room/device focus so the
destination opens at its configured default focus. An explicit
`?fullscreen=1` query remains active.

Cycling does not replace individual addresses. `/dashboards/kitchen` still
opens Kitchen directly, while `/dashboards/home` still opens Home directly.

## Put a display on a tablet

Open or copy the dashboard's address from its library entry, then sign in as
the OE profile that owns it. Use the toolbar's **Fullscreen** button or press
`F`; appending `?fullscreen=1` requests the same display mode explicitly.
Standalone displays cannot edit layouts, although Home Assistant cards can use
the supported controls when that profile has access.

A dashboard address is not an anonymous link, public share, or restricted
kiosk credential. It contains no session token, and all layout and live-data
APIs require normal OE authentication. The same slug can exist in multiple
profiles; the active signed-in profile determines which dashboard and data the
browser receives.

The tablet holds a full browser session for that OE profile. Someone with an
unlocked tablet can navigate away from the display to other OE pages available
to the account. For a shared or unattended screen, use a dedicated
least-privilege OE profile, restrict its feature and provider access, honor an
appropriate access schedule, use private HTTPS, and apply the tablet/browser's
own screen or kiosk lock.

Browser sessions have a fixed seven-day maximum, so an unattended tablet will
eventually need to sign in again. An owner can also configure a shorter idle
timeout in hours. Sessions are listed and revocable under **Settings → Profile
→ Active Sessions**.

## Permissions and privacy

Dashboard storage and addresses are profile-scoped. Calendar, Email, custom
widgets, and Home Assistant data are checked against the signed-in profile's
relevant permissions and access schedule whenever OE refreshes them.

Owners and admins have Home Assistant runtime access automatically. A regular
profile needs the `role_home_assistant` skill enabled. That access covers the
normalized entity state, permitted camera views, and OE's fixed allowlist of
dashboard controls; the configured Home Assistant token can impose additional
upstream limits. Hiding an entity or removing a card changes presentation—it
does not revoke Home Assistant permission. There is currently no separate
per-dashboard or per-entity view-only access list.

If Calendar, Email, or custom-widget permission is revoked while a display is
already open, a previously rendered result can remain on screen marked stale
after its next failed refresh. Reload or close the display—or revoke that
browser session—for immediate removal. Home Assistant state is cleared when OE
detects that runtime access is unavailable.

## Delete or start over

Use **Delete** on a non-Home dashboard in the library or Configure header. OE
asks for confirmation, then permanently removes its saved layout. Duplicate it
first if you may want a copy.

Home cannot be deleted. To rebuild it, open **Configure → Customize → Dashboard
settings → Reset everything**. **Reset room & device organization** is the
narrower option when the cards are right but their focus organization is not.

## If something is missing

- No Home Assistant cards: confirm Home Assistant is configured and the
  profile has runtime access, then refresh the dashboard.
- Calendar or Email is unavailable: enable the matching skill and feature,
  connect an account, and reopen **Add card → Widgets**.
- A custom widget is unavailable: confirm the custom skill is still enabled,
  its bound tool is read-only and non-destructive, and the local read-only
  sandbox is available.
- A tablet returns to sign-in: browser sessions have reached the seven-day hard
  limit or the configured idle timeout; sign in again.
- A save conflict appears: reload the dashboard before making more changes so
  another editor's version is not overwritten.
