# Building custom skills

OpenEnsemble's `skill-builder` lets your coder/coordinator write new skills at runtime. Anything you can call from Node — REST APIs, local hardware integrations, shell commands, your own services — is fair game.

## The fastest path

Talk to a coder or coordinator agent and ask for what you want, e.g.:

> "Build me a skill that turns on the lights in my living room via Home Assistant. The HA URL is `http://homeassistant.local:8123` and my long-lived token is in `~/.config/ha-token`."

The agent will:

1. Read the **SKILL_BLUEPRINT.md** that ships under `skills/`.
2. Scaffold a folder under `users/{your-id}/skills/{slug}/`.
3. Write a `manifest.json` (name, description, the tool calls).
4. Write `execute.mjs` (the actual code).
5. Add it to a role's tool list so an agent can use it.

Restart-free: the skill is picked up the next time an agent reasons.

## The blueprint

`skills/SKILL_BLUEPRINT.md` is the canonical reference. It's loaded into the skill-builder's context whenever it's writing a skill — your agent reads the same doc.

## Manifest gotchas

Three fields plus one alias must all be set or the tool silently won't show up to your agents:

- `manifest.tools` — defines the tool functions
- `manifest.defaultToolIds` — which of those tools roles get by default
- `manifest.systemPromptAddition` — instructions injected into the agent prompt when the skill is enabled
- `TOOL_ALIASES` (in code) — maps tool ids to their handler

If you ask the skill-builder to add a new tool to an existing skill, double-check those four. (This is a common cause of "I added it but the agent acts like it doesn't exist".)

## Custom drawers

A skill can ship its own UI panel that opens as a drawer in the sidebar. Add a `drawer` block to the manifest with `html`, optional `css`, and an `initJs` function. The drawer auto-loads alongside built-in drawers — see existing drawers under `drawers/` for examples.

## Dashboard widgets

When you ask for an “at-a-glance,” dashboard, card, or tablet view, Skill
Builder can add a declarative `dashboardWidgets` entry to a new or existing
custom skill. Each widget is tied to one exact same-skill tool marked
`readOnly:true`. OE renders a bounded summary, metrics, and list—custom skills
cannot inject HTML or JavaScript into dashboards.

Because these cards refresh unattended, OE runs their data tools with the
skill/user filesystem mounted read-only and native network disabled. A custom
widget reads local state; an ordinary user-triggered tool or approved watcher
can refresh that state separately. Calendar and Email use OE's trusted built-in
adapters instead.

For an existing skill, ask the agent to update its widget. It can patch the
data handler, add or mark the tool read-only with `skill_update_tool_def`, and
add or replace the widget through `skill_update_manifest`; the skill does not
need to be recreated. See **Display dashboards** in the Guide for adding the
resulting card, configuring it, and understanding display-session privacy.

## User-scoped vs. system skills

- `skills/{slug}/` — system-wide, available to all users (pre-bundled with OE).
- `users/{userId}/skills/{slug}/` — visible only to that user, not shared.

If you want to share a custom skill across users, the skill-builder can promote it to a system skill (owner/admin only).

## Editing existing skills

Same agent, just say "edit the {skill} skill to also do X". The agent will read the current manifest + `execute.mjs`, propose changes, and apply them.

## Removing a skill

Delete the skill folder, or ask the agent to remove it. Owners can also disable a system skill globally in **Settings → Skills**.
