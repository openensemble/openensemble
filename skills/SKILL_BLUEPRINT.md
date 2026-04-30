# OpenEnsemble Skill Authoring Guide

A skill is a directory in `~/.openensemble/skills/{skillId}/` containing two files:
- `manifest.json` — declares the skill and its tools
- `execute.mjs` — implements the tools

User-created skills are prefixed `usr_` automatically by `skill_create`.

---

## ⚠️ REQUIRED: Copy this execute.mjs signature EXACTLY

Every skill MUST use this signature. Do not change parameter names, do not destructure, do not use a different export style:

```js
export async function executeSkillTool(name, args, userId, agentId) {
  if (name === 'your_tool_name') {
    // args is a plain object: args.param1, args.param2, etc.
    return 'result as a string'; // MUST return a string or null
  }
  return null; // MUST return null for unrecognized tool names
}

export default executeSkillTool;
```

**5th `ctx` parameter (optional)** — only declare it if the skill needs to push images/videos inline to the chat (see "Showing images and videos" below). Skills that don't take 5 params still work normally:

```js
export async function executeSkillTool(name, args, userId, agentId, ctx) {
  // ctx.showImage({ base64, mimeType, filename, savedPath, prompt })
  // ctx.showVideo({ url, filename, savedPath })
  ...
}
```

The validator accepts either a 4-param or 5-param signature. Anything else is rejected.

**Common mistakes that will cause the skill to silently fail:**
- ❌ `executeSkillTool({ tool_name })` — wrong, do not destructure parameters
- ❌ `executeSkillTool(toolName, { param1, param2 })` — wrong parameter names
- ❌ `return { content: '...' }` — wrong, must return a plain string or null
- ❌ `return undefined` — wrong, always return a string or null
- ✅ `return 'some result string'` — correct
- ✅ `return null` — correct for unmatched tool names

**The validator will call your function with an unknown tool name and expect `null` back. It will also call it with valid args and expect a string. If either check fails, the skill is rejected.**

---

## manifest.json

```json
{
  "id": "usr_myskill",
  "name": "My Skill",
  "description": "One-sentence description of what this skill does",
  "icon": "🔧",
  "category": "utility",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "myskill_do_thing",
        "description": "What this tool does and when to use it",
        "parameters": {
          "type": "object",
          "properties": {
            "input": {
              "type": "string",
              "description": "Description of this parameter"
            }
          },
          "required": ["input"]
        }
      }
    }
  ]
}
```

**Key rules:**
- `id` must match the directory name
- Tool names must be **globally unique** — always prefix them with the skill id (e.g. `ha_turn_on`, not `turn_on`)
- `category` should be `"utility"` for user-created skills

---

## execute.mjs

### Simple (non-streaming) — recommended for most skills

```js
export async function executeSkillTool(name, args, userId, agentId) {
  if (name === 'myskill_do_thing') {
    // Do the work
    const result = `Processed: ${args.input}`;
    return result; // return a string
  }
  return null;
}

export default executeSkillTool;
```

### Streaming — for long-running operations

```js
export async function* executeSkillTool(name, args, userId, agentId) {
  if (name === 'myskill_stream') {
    yield { type: 'token', text: 'Starting...\n' };
    // ... do work ...
    yield { type: 'token', text: 'Done.\n' };
    yield { type: 'result', text: 'Completed successfully' };
    return;
  }
  yield { type: 'result', text: 'Unknown tool' };
}

export default executeSkillTool;
```

**Yield types:**
- `{ type: 'token', text }` — streamed chunk shown to user in real time
- `{ type: 'result', text }` — final result (always end with this when streaming)

---

## Available imports

**Node built-ins** (no install needed):
```js
import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
```

**Packages in `~/.openensemble/node_modules`:**
- `ws` — WebSocket client/server
- `nodemailer` — SMTP email
- `imapflow` — IMAP email
- `@lancedb/lancedb` — vector database

**Making HTTP requests** (use Node's built-in fetch, available in Node 18+):
```js
const res = await fetch('https://api.example.com/endpoint', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'value' }),
});
const data = await res.json();
```

---

## Showing images and videos

If your skill produces an image or video, return the file path *and* push an inline preview to the chat by accepting `ctx` as the 5th parameter:

```js
export async function executeSkillTool(name, args, userId, agentId, ctx) {
  if (name === 'myskill_make_image') {
    const base64 = await callSomeApiThatReturnsBase64Png(args.prompt);
    const filename = `myskill-${Date.now()}.png`;
    const savedPath = path.join(process.env.OPENENSEMBLE_ROOT, 'users', userId, 'images', filename);
    fs.mkdirSync(path.dirname(savedPath), { recursive: true });
    fs.writeFileSync(savedPath, Buffer.from(base64, 'base64'));

    // Push the inline preview bubble — same one Grok / Fireworks use.
    await ctx?.showImage?.({ base64, mimeType: 'image/png', filename, savedPath, prompt: args.prompt });

    return `Saved to ${savedPath}`;
  }
  return null;
}
```

`ctx` exposes:
- `ctx.showImage({ base64, mimeType, filename, savedPath, prompt? })` — chat renders an image bubble.
- `ctx.showVideo({ url, filename, savedPath })` — chat renders a video bubble.
- `ctx.userId`, `ctx.agentId` — for convenience (same values as the 3rd and 4th args).

Always check with optional chaining (`ctx?.showImage?.(...)`). If the skill is invoked outside an interactive chat (e.g. by a scheduled task), `ctx` may be undefined or its helpers may be no-ops, and your skill should still complete and return its string result.

---

## Importing app internals

If you need app internals (e.g. `roles.mjs`, `_helpers.mjs`), use **dynamic imports inside the function body** — never at the top level. This avoids circular initialization (roles.mjs loads your executor; if your executor imports roles.mjs at module load time, it creates a circular init).

```js
// ✅ Correct — dynamic import inside handler
export async function executeSkillTool(name, args, userId, agentId) {
  const { withLock } = await import('../../routes/_helpers.mjs');
  // ...
}

// ❌ Wrong — top-level import of app internals
import { withLock } from '../../routes/_helpers.mjs';
```

Relative paths from `~/.openensemble/skills/usr_myskill/execute.mjs`:
- `../../roles.mjs` → `~/.openensemble/roles.mjs`
- `../../routes/_helpers.mjs` → `~/.openensemble/routes/_helpers.mjs`

---

## Storing configuration / secrets

Use `userId` to scope data to the user. Store config under the user's dir:

```js
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

// Read the openensemble install root from the env var the server exports
// at startup. Do NOT compute BASE_DIR with `import.meta.url` + `../..` —
// user-created skills live at `users/{userId}/skills/{id}/execute.mjs`,
// which has a different parent depth than built-in skills at
// `skills/{id}/execute.mjs`, so the relative-path trick lands in the
// wrong directory. Do NOT hard-code an absolute path either — it won't
// survive a move to another machine or user account.
const BASE_DIR = process.env.OPENENSEMBLE_ROOT;

function getConfig(userId) {
  const p = path.join(BASE_DIR, 'users', userId, 'usr_myskill-config.json');
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

function saveConfig(userId, cfg) {
  const p = path.join(BASE_DIR, 'users', userId, 'usr_myskill-config.json');
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}
```

**Rule of thumb:** any skill or drawer `serverCode` that writes files should read `process.env.OPENENSEMBLE_ROOT` and build user paths off that. The server exports this env var at startup so the same code works on any install and at any nesting depth. Do **not** hard-code an absolute path, and do **not** compute the root from `import.meta.url` + `'../..'` — both patterns have broken in the past.

---

## Minimal working example

A skill that stores and retrieves a Home Assistant URL:

**manifest.json:**
```json
{
  "id": "usr_ha",
  "name": "Home Assistant",
  "description": "Control Home Assistant devices",
  "icon": "🏠",
  "category": "utility",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "ha_get_state",
        "description": "Get the current state of a Home Assistant entity",
        "parameters": {
          "type": "object",
          "properties": {
            "entity_id": { "type": "string", "description": "Entity ID, e.g. light.living_room" }
          },
          "required": ["entity_id"]
        }
      }
    }
  ]
}
```

**execute.mjs:**
```js
const HA_URL   = 'http://homeassistant.local:8123';
const HA_TOKEN = process.env.HA_TOKEN ?? '';

export async function executeSkillTool(name, args, userId, agentId) {
  if (name === 'ha_get_state') {
    const res = await fetch(`${HA_URL}/api/states/${args.entity_id}`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
    });
    if (!res.ok) return `Error: ${res.status} ${res.statusText}`;
    const data = await res.json();
    return `${data.entity_id}: ${data.state} (${JSON.stringify(data.attributes)})`;
  }
  return null;
}

export default executeSkillTool;
```

---

## Optional: drawer UI

A skill may optionally ship a **drawer** — a small panel that opens from the left sidebar when the user clicks its button. Drawers are completely optional. Most skills don't need one. Only add a drawer when the user explicitly asks for a visual panel, a dashboard, a form, or some other UI surface that goes beyond what the chat stream can show.

Pass a `drawer` object to `skill_create` alongside the usual `id`, `name`, `tools`, `code`:

```jsonc
{
  "drawer": {
    "name": "My Panel",          // shown in the drawer header + sidebar tooltip
    "lucideIcon": "receipt",     // PREFERRED — lucide icon name, matches built-in drawers
    "icon": "🔧",                 // fallback emoji if no lucide icon fits
    "html": "<div id='usr_myskill_root'>Loading…</div>",
    "initJs": "…",               // optional — runs on first open
    "serverCode": "…"            // optional — plugins/<id>/server.mjs for custom HTTP endpoints
  }
}
```

### Icons — prefer `lucideIcon` over emoji

The rest of the OpenEnsemble sidebar uses [Lucide](https://lucide.dev/icons) line icons (`receipt`, `home`, `bell`, `calendar`, `file-text`, `users`, `bookmark`, etc.). Set `lucideIcon` to a lucide icon name so the drawer's sidebar button and header match the built-in look instead of standing out as an emoji. Only fall back to `icon` (emoji) when no lucide icon fits the concept.

### HTML — use the `.cdraw-*` class set, not inline styles

The `html` string is injected straight into the drawer body. It lives in the main page DOM so CSS applies normally. **Do not write Bootstrap/Tailwind/inline-style UI from scratch** — use the built-in `.cdraw-*` class set so the drawer matches the rest of the app:

| Class | Use for |
|---|---|
| `.cdraw-toolbar`          | A header row above the list (e.g. a single Refresh button).    |
| `.cdraw-section-title`    | Small uppercase-letter section headers.                         |
| `.cdraw-row`              | One entry in a list. Contains `.cdraw-row-main` + `.cdraw-row-actions`. |
| `.cdraw-row-main`         | The text part of a row — wraps `.cdraw-row-title` and `.cdraw-row-sub`. |
| `.cdraw-row-title`        | Primary text of a row (bold, 13px).                             |
| `.cdraw-row-sub`          | Secondary text (muted, 11px).                                   |
| `.cdraw-row-actions`      | Container for per-row action buttons. Fades in on row hover.    |
| `.cdraw-btn`              | Standard button (bg3 + border, hovers accent).                  |
| `.cdraw-btn-primary`      | Accent-filled button for the main CTA.                          |
| `.cdraw-btn-full`         | Makes any `.cdraw-btn` width: 100%.                             |
| `.cdraw-icon-btn`         | Compact icon-only button for per-row actions. Variants: `.danger`, `.accent`. |
| `.cdraw-badge`            | Small status pill. Variants: `.accent`, `.green`, `.yellow`, `.red`. |
| `.cdraw-empty`            | "No items yet" placeholder.                                     |
| `.cdraw-loading`          | "Loading…" placeholder.                                         |
| `.cdraw-error`            | Red-colored error placeholder.                                  |

**You may use `data-lucide="name"` icons inside your HTML and initJs output.** The runtime calls `lucide.createIcons()` after injecting your drawer and after your `initJs` completes, so any `<i data-lucide="trash-2"></i>` placeholders get materialized automatically.

Color and spacing tokens available as CSS variables: `--bg`, `--bg2`, `--bg3`, `--border`, `--text`, `--muted`, `--accent`, `--green`, `--yellow`, `--red`, `--radius`. Prefer these over hard-coded hex codes so light/dark themes stay consistent.

Give any custom ids a unique prefix (e.g. `usr_myskill_root`, not `root`) to avoid DOM collisions with other drawers. The drawer header, close button, and outer frame are provided for you — you only fill the body.

#### Example: a clean list drawer

```html
<div class="cdraw-toolbar">
  <span class="cdraw-section-title" style="margin:0">Invoices</span>
  <button class="cdraw-btn" onclick="myskillReload()">
    <i data-lucide="refresh-cw"></i> Refresh
  </button>
</div>
<div id="usr_myskill_list"></div>
```

```js
// initJs — renders rows using .cdraw-row / .cdraw-icon-btn / lucide icons.
window.myskillReload = async function () {
  const el = document.getElementById('usr_myskill_list');
  el.innerHTML = '<div class="cdraw-loading">Loading…</div>';
  const token = localStorage.getItem('oe_token');
  const res = await fetch('/api/usr_myskill/list', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!data.length) { el.innerHTML = '<div class="cdraw-empty">Nothing here yet.</div>'; return; }
  el.innerHTML = data.map(it => `
    <div class="cdraw-row">
      <div class="cdraw-row-main">
        <div class="cdraw-row-title">${it.title}</div>
        <div class="cdraw-row-sub">${it.subtitle}</div>
      </div>
      <div class="cdraw-row-actions">
        <button class="cdraw-icon-btn accent" title="Mark read" onclick="myskillMark('${it.id}')"><i data-lucide="check"></i></button>
        <button class="cdraw-icon-btn accent" title="Send"      onclick="myskillSend('${it.id}')"><i data-lucide="send"></i></button>
        <button class="cdraw-icon-btn danger" title="Delete"    onclick="myskillDel('${it.id}')"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
};
myskillReload();
```

The runtime also re-scans for lucide icons after `initJs` resolves, but it's fine (and idempotent) to call `lucide.createIcons()` yourself when you re-render rows.

### initJs (optional)

Body of a function that runs the first time the drawer is opened (not on every open). Runs in the page's global scope — you can call `fetch()`, `document.getElementById()`, add event listeners, etc.

```js
"initJs": "const root = document.getElementById('usr_myskill_root'); const r = await fetch('/api/usr_myskill/items'); root.textContent = JSON.stringify(await r.json());"
```

(Top-level `await` is allowed because the body is wrapped in an async function by the runtime.)

### HTML is plain HTML — no frameworks

The drawer body is injected into the main page's DOM. **Do not use React, Vue, Svelte, JSX, or any framework.** There is no bundler and no component runtime. Write plain HTML with ids, and if you need interactivity, put event handlers in `initJs` using `document.getElementById()` or `addEventListener()`.

### serverCode (optional) — ESM only, no `require()`

Only needed if the drawer needs its own HTTP endpoints. This becomes `plugins/<pluginId>/server.mjs` — a Node **ES module**, so:

- Use `import` at the top — `require()` will throw `require is not defined in ES module scope`.
- The function MUST be named exactly `handleRequest` — do not rename it, do not wrap it.
- Use the Node built-in `fs`, `path`, `crypto`, etc. You may not install new packages.

Authenticating requests: OpenEnsemble uses `Authorization: Bearer <token>` headers (or `?token=…` query strings). The app helper `requireAuth(req, res)` resolves the user id and writes a 401 if no token — use it to scope data to the current user:

```js
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { requireAuth } from '../../routes/_helpers.mjs';

const BASE_USERS_DIR = path.join(process.env.OPENENSEMBLE_ROOT, 'users');

export async function handleRequest(req, res, cfg) {
  // All our routes start with /api/usr_myskill/
  if (!req.url.startsWith('/api/usr_myskill/')) return false;

  const userId = requireAuth(req, res);
  if (!userId) return true; // requireAuth already wrote the 401

  if (req.url === '/api/usr_myskill/items' && req.method === 'GET') {
    const dir = path.join(BASE_USERS_DIR, userId, 'myskill-data');
    const items = existsSync(dir) ? /* read items from dir */ [] : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(items));
    return true;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
  return true;
}
```

Note: `initJs` running in the browser needs to attach the token to its fetch calls. Read it from `localStorage.getItem('oe_token')` and pass it as `Authorization: Bearer <token>`:

```js
const token = localStorage.getItem('oe_token');
const res = await fetch('/api/usr_myskill/items', {
  headers: { Authorization: `Bearer ${token}` },
});
```

- The handler receives `(req, res, cfg)` where `cfg` is the parsed `config.json`.
- Return `true` when you've written the response; return `false` to pass the request to the next handler.
- Prefix your URL paths with `/api/usr_myskill/` so they don't collide with core routes.

### Lifecycle

- Drawers are visible **only to their creator** — other users don't see them.
- On `skill_delete`, the drawer plugin directory and its sidebar button are removed automatically.
- After `skill_create` returns, the user needs to **reload the page once** for the drawer to appear (the tools, however, are available immediately with no reload).
- If the drawer creation fails (missing `html`, invalid `serverCode`, etc.) the entire skill creation is rolled back.

### Rules of thumb

- Do **not** add a drawer unless the user asked for one.
- Prefer a single root element with a unique id (`usr_myskill_root`) that `initJs` fills in.
- Keep `initJs` small. For complex logic, define functions inside it and call them.
- If `serverCode` writes files, scope them to the user by loading/writing under `~/.openensemble/users/{userId}/`.

---

## Common pitfalls

1. **Tool name collisions** — always prefix tool names with the skill id. `turn_on` will collide; `ha_turn_on` won't.
2. **Top-level app imports** — causes circular init crash. Always use dynamic `await import()` inside handlers.
3. **Missing `export default`** — the executor won't load. Always include `export default executeSkillTool`.
4. **Returning non-string** — always return a string (or null). Objects will be coerced but may look wrong.
5. **Unhandled promise rejections** — wrap external API calls in try/catch and return the error message as a string so the agent can report it.
