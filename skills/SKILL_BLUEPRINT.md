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
  "intent_examples": [
    "find snack deals at kroger",
    "what's on sale at kroger this week",
    "check kroger weekly ad",
    "are eggs on sale at kroger",
    "kroger digital coupons today"
  ],
  "coordinator_scope": "auto",
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

### intent_examples + coordinator_scope (tool-router)

The coordinator's per-turn tool list is trimmed by an embedding classifier — only skills whose `intent_examples` match the user's prompt get loaded as tools that turn. Without examples your skill's tools are reachable only after the LLM explicitly calls `request_tools`, which costs one extra round-trip.

- **`intent_examples`** — 6 to 15 short natural-language phrases the user might say when they want this skill. Write them the way real users phrase requests, varied in surface form. Don't include the skill's name in the phrase — match the user's GOAL ("are eggs on sale", not "use the kroger skill").
- **`coordinator_scope`**:
  - `"include"` (default) — always available to the coordinator (current behavior for skills authored before scoping existed)
  - `"auto"` — only loaded when intent matches (preferred for most user skills — keeps the coordinator's prompt small on unrelated turns)
  - `"exclude"` — never available to the coordinator. Use for heavyweight skills that belong on a specialist agent (GPU-pod managers, finance ingestion, batch ML training). The skill stays usable on other agents via direct chat or `ask_agent`.

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

## Saving file outputs

**Never write to `~/Downloads`, `os.homedir()`, or any path outside the OpenEnsemble install.** Skills that produce files on disk must save them under the user's profile so they show up in the Profile Files UI and can be shared, attached, or read by other tools.

Use the `getUserFilesDir(userId, kind)` helper. It returns `~/.openensemble/users/{userId}/{kind}/` and creates the directory:

```js
import { getUserFilesDir } from '../../lib/paths.mjs';

const dir = getUserFilesDir(userId, 'videos'); // or 'images', 'documents', 'research', 'code'
const savedPath = path.join(dir, `myskill-${Date.now()}.mp4`);
fs.writeFileSync(savedPath, buffer);
```

Pick the `kind` that matches what you're saving:
- `videos` — any video output (mp4, webm, …)
- `images` — any image output (png, jpg, gif, …)
- `documents` — pdfs, docx, csv, plain-text exports
- `research` — markdown notes, summaries, research artifacts
- `code` — generated/scaffolded source files

If your skill is a per-user one (in `users/{userId}/skills/`), the relative import is `../../../../lib/paths.mjs`. Top-level skills (in `skills/`) use `../../lib/paths.mjs`.

---

## Semantic search (optional — only when fuzzy lookup actually helps)

OpenEnsemble ships a bundled embedding model (nomic-embed, 768-dim, normalized vectors). It runs in-process — no HTTP, no API key, ~20ms per call. Skills can reuse it to add fuzzy/semantic lookup over their own stored data.

```js
import { embed } from '../../memory/embedding.mjs';   // top-level skill
// import { embed } from '../../../../memory/embedding.mjs'; // per-user skill

const qVec = await embed('snack deals at kroger');    // Float32Array, length 768
// rows[i] = { ...record, vec: [...] }  ← embedded at write time
const ranked = rows
  .map(r => ({ r, sim: dot(qVec, r.vec) }))           // dot = cosine sim (already normalized)
  .sort((a, b) => b.sim - a.sim);

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
```

**Reach for it when:**
- The skill stores >50 rows of text-y data the user will query with natural language.
- Keyword matching would miss obvious paraphrases ("snacks" ↔ "chips/crackers", "cheap dairy" ↔ "milk on sale").
- You want dedup ("is this new entry essentially the same as one we already saved?") — embed both, threshold the dot product.

**Skip it when:**
- The data is structured and the user filters by fields (store name, expires-after, price ≤ X) — plain `.filter()` is faster and clearer.
- The dataset has <50 rows — linear keyword `.includes()` is fine.
- Queries are exact-match by nature (IDs, dates, slugs).

Pattern: embed each row at write time, store the vector alongside it in the JSON record, then at query time embed the user's query once and rank by dot product. No external vector DB needed up to thousands of rows.

---

## Showing images and videos

If your skill produces an image or video, return the file path *and* push an inline preview to the chat by accepting `ctx` as the 5th parameter:

```js
import { getUserFilesDir } from '../../lib/paths.mjs';

export async function executeSkillTool(name, args, userId, agentId, ctx) {
  if (name === 'myskill_make_image') {
    const base64 = await callSomeApiThatReturnsBase64Png(args.prompt);
    const filename = `myskill-${Date.now()}.png`;
    const savedPath = path.join(getUserFilesDir(userId, 'images'), filename);
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

## Background work — watchers (polling)

For anything that takes more than a few seconds — video generation, training runs, price alerts, "tell me when X" conditions, long syncs, remote pod lifecycle — register a **watcher** with the per-user supervisor. The supervisor ticks your handler on a cadence, pushes status updates to chat as muted-italic 📡 bubbles, and surfaces the watcher in the user's tasks drawer where they can see ETA, extend the expiry, or cancel.

**Tasks vs watchers** — pick the right primitive:

| | Task | Watcher |
|---|---|---|
| Purpose | Fire scheduled action | Monitor evolving state |
| Cadence | Once / cron | Every N seconds |
| Output | Single result | Stream of status updates |
| Lifecycle | Runs to completion | Reaps on `done` / expiry / cancel |
| API | scheduler/tasks system | `ctx.watch / ctx.unwatch` |

### How to register a watcher

From any tool handler, call `ctx.watch({...})`. Returns a `watcherId` (string).

```js
const watcherId = await ctx?.watch?.({
  kind:        'mywatcher_kind',          // must match a key in watcherHandlers
  skillId:     'usr_myskill',             // your skill's id
  label:       'Friendly name for tasks drawer',
  cadenceSec:  30,                        // tick interval (min 5s)
  expiresAt:   Date.now() + 30 * 60_000,  // wall-clock ms; null = indefinite
  state:       { /* opaque, kind-specific */ },
});
```

**Always set `expiresAt` based on a realistic estimate of the work.** The framework falls back to 1h with a WARN if you omit it, but skills should compute their own ceiling. Examples:

- Video gen: `numSteps * estSecPerStep * numPrompts * 1.5 (safety) + 5min (post-encode buffer)`
- Training: `numEpochs * stepsPerEpoch * estSecPerStep + 15min (checkpoint save)`
- Pod startup: `15min` (provider queue ceiling)
- Indefinite (price alert, "PR turns green"): `expiresAt: null` — explicit opt-out, never auto-reaps; user dismisses via the tasks drawer (they'll see a colored dot indicating the indefinite state)

### How to define a handler

Add a `watcherHandlers` named export at the bottom of `execute.mjs`. The supervisor looks up the handler by `kind` when the watcher is due to tick:

```js
export const watcherHandlers = {
  // state: whatever was passed to ctx.watch({ state })
  // helpers: { userId, agentId, watcherId, postStatus(text), showImage(...), showVideo(...) }
  async mywatcher_kind(state, helpers) {
    // 1. Poll the underlying resource
    const data = await fetchLatestState(state);

    // 2. Terminal: error
    if (data.failed) {
      return { done: true, textUpdate: `❌ My job failed: ${data.errorMsg}` };
    }

    // 3. Terminal: success — do the final work, then signal done
    if (data.complete) {
      await helpers.showVideo({ url: '/api/desktop/videos/foo.mp4', filename: 'foo.mp4', savedPath: '/abs/path' });
      return { done: true, textUpdate: `✓ My job complete.` };
    }

    // 4. Active: report progress. The framework dedupes consecutive identical
    //    textUpdates so you can compute the same line every tick safely.
    return {
      textUpdate: `📡 My job: ${data.percent}% — ETA ${data.etaText}`,
      // Optional: extend the watcher's deadline if work is taking longer than
      // your initial estimate. The framework adds this to the existing expiresAt.
      extendExpiryBy: data.runningLong ? 5 * 60_000 : 0,
      // Optional: change cadence dynamically.
      nextCadenceSec: data.almostDone ? 5 : 30,
      // Optional: persist updated state for the next tick.
      newState: { ...state, lastSeenStep: data.step },
    };
  },
};
```

### Critical handler rules (avoid the common pitfalls)

- **Report ALL phases of work, not just the headline counter.** If your job has a "post-processing" tail (e.g. encoding, uploading, persisting), the headline counter plateaus while the work continues. Tell the user explicitly: `"diffusion done — encoding video…"`, not `"step 50/50"` repeated. Otherwise it looks stuck.
- **Be tolerant of transient failures.** SSH blip, API 503 — return a soft `textUpdate` describing the retry, *don't* return `done: true`. The supervisor cancels the watcher after 3 *consecutive* handler exceptions; one-off blips that you handle inside the handler don't count.
- **Be idempotent across server restarts.** Watchers are disk-persisted and resume on boot. Your handler runs against `state` — make sure the state alone is enough to recover the situation (e.g. a `jobId` to query, not a JS-object reference that died with the previous process).
- **Dedup natively.** The supervisor drops consecutive identical `textUpdate` strings, so you can return the same string when nothing has changed without spamming chat.
- **Handle "underlying resource is gone".** Pod terminated externally, file deleted, etc. Return `{ done: true, textUpdate: 'pod terminated externally' }` — the watcher gets reaped cleanly.
- **Do final work in the handler, not in a separate tool.** When the watcher reaches `done`, the handler should call `helpers.showImage` / `helpers.showVideo` itself rather than asking the agent to invoke another tool. The whole point is the user shouldn't have to nudge the agent.

### Declaring watchers in your manifest

Skills that register watchers should declare the kinds they support so the skill-builder and tooling can introspect:

```json
{
  "id": "usr_mygenerator",
  "name": "My Generator",
  "tools": [ ... ],
  "watchers": [
    {
      "kind": "mygenerator_progress",
      "description": "Polls the remote job, posts progress, downloads the result on completion."
    }
  ]
}
```

The `kind` strings must match the keys in your `watcherHandlers` export.

### Cancelling

- Programmatically: `await ctx.unwatch(watcherId)`.
- User: clicks the ✕ in the tasks drawer or clicks the indefinite-watcher dot.
- Auto: handler returns `done: true`, `expiresAt` passes, or 3 consecutive failures.

### Per-user cap

Soft cap of 10 active watchers per user. If a registration would exceed it, `ctx.watch` returns `null` and logs a warning — so always check the return.

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

## Iterating on a skill

Skills are not write-once. After `skill_create`, you can edit a skill's code live with these tools (all hot-reload, no server restart):

- `skill_read_code` — read the current `execute.mjs`. Always call this before patching so the `find` strings match exactly.
- `skill_patch_code` — apply one or more find/replace edits. Prefer this for small changes (adding a sender, fixing a category mapping, tweaking a regex). The `find` string must appear exactly once — include surrounding context. If the patched file fails validation, the original is restored automatically.
- `skill_update_code` — replace the entire `execute.mjs`. Use only for large or structural changes.

### Design for iteration

Skills that classify, match, or map real-world inputs (receipts, senders, merchants, categories, device aliases, URL patterns) almost always miss cases on day one and grow over time as the user reports them. Write them so a one-line patch is enough to extend coverage.

**Do:** put the things the user will want to extend in named constants at the top of `execute.mjs`.

```js
const RECEIPT_SENDERS = [
  'noreply@uber.com',
  'receipts@doordash.com',
  'auto-confirm@amazon.com',
];

const CATEGORY_MAP = {
  uber:      'Transportation',
  doordash:  'Food & Dining',
  instacart: 'Groceries',
};
```

**Don't:** bury those values inside regex literals or scattered `if` statements. Patching `if (from.includes('uber') || from.includes('lyft'))` to add a third sender is error-prone; patching a `RECEIPT_SENDERS` array is trivial.

### The correction loop

When the user reports a miss ("you skipped my Lyft receipt", "Ticketmaster should be Entertainment, not Shopping"):

1. `skill_read_code` — locate the relevant constant.
2. `skill_patch_code` — add the new entry. Include enough surrounding lines to make `find` unique.
3. Confirm in plain language what you changed ("Added `tickets@ticketmaster.com` to `RECEIPT_SENDERS` and mapped `ticketmaster` → `Entertainment`.").

This pattern compounds: over weeks the skill's lookup tables become a personalized record of how the user actually uses it, without ever rewriting the logic.

---

## Common pitfalls

1. **Tool name collisions** — always prefix tool names with the skill id. `turn_on` will collide; `ha_turn_on` won't.
2. **Top-level app imports** — causes circular init crash. Always use dynamic `await import()` inside handlers.
3. **Missing `export default`** — the executor won't load. Always include `export default executeSkillTool`.
4. **Returning non-string** — always return a string (or null). Objects will be coerced but may look wrong.
5. **Unhandled promise rejections** — wrap external API calls in try/catch and return the error message as a string so the agent can report it.
