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

**5th `ctx` parameter (optional)** — declare it when the skill needs runtime helpers such as inline media or a durable personalization follow-up. Skills that don't take 5 params still work normally:

```js
export async function executeSkillTool(name, args, userId, agentId, ctx) {
  // ctx.showImage({ base64, mimeType, filename, savedPath, prompt })
  // ctx.showVideo({ url, filename, savedPath })
  // ctx.registerLead({ query, toolName, args, skillId, cadenceHint })
  // ctx.personalization.confirmedPreferenceDetails()
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

### Optional: `execution_hint` (auto model / effort)

Portable — **not** a concrete model id. OE maps the tier to the user's enabled providers at runtime when this skill is routed (including single-mode workers):

```json
"execution_hint": { "tier": "fast", "effort": "low" }
```

| `tier` | When |
|--------|------|
| `fast` | Lookups, list/get, light CRUD |
| `standard` | Typical multi-step automation |
| `strong` | Coding, careful analysis, skill authoring |
| `reasoning` | Deep research / hard multi-hop reasoning |

`effort`: `off` | `low` | `medium` | `auto` | `high`.

`skill_create` infers a hint from tools/description when you omit it. Users can still **pin** a model in Settings → Skills → Execution (pins always win).

### Mark destructive tools

The skill-builder runs every declared tool through a smoke test after writing the code — with generated args and a stub `ctx`. Crashes, hangs (3s timeout), and wrong-typed returns block the create. This is free safety for read-only tools (weather lookups, listings, searches).

For tools that mutate external state, add `"destructive": true` on the per-tool manifest entry so the smoke runner skips it:

```json
{
  "type": "function",
  "destructive": true,
  "function": {
    "name": "myskill_send_email",
    "description": "Send an email to a recipient",
    "parameters": {...}
  }
}
```

**Set `destructive: true` for tools that:**
- Send email / SMS / push notifications
- POST/PUT/DELETE to a remote API that has side effects (booking, paying, posting)
- Delete files, rows, or records
- Trigger physical actions (smart-home device control, hardware)

**Don't mark these destructive** (let them get smoke-tested for free):
- Read-only API lookups (weather, search, list)
- Pure data transforms (parse, format, summarize)
- Cache reads, file reads

Skipped destructive tools surface as a warning in the success message so you remember what wasn't covered.

### intent_examples + coordinator_scope (tool-router)

The coordinator's per-turn tool list is trimmed by an embedding classifier — only skills whose `intent_examples` match the user's prompt get loaded as tools that turn. Without examples your skill's tools are reachable only after the LLM explicitly calls `request_tools`, which costs one extra round-trip.

- **`intent_examples`** — 6 to 15 short natural-language phrases the user might say when they want this skill. Write them the way real users phrase requests, varied in surface form. Don't include the skill's name in the phrase — match the user's GOAL ("are eggs on sale", not "use the kroger skill").
- **`coordinator_scope`**:
  - `"include"` (default) — always available to the coordinator (current behavior for skills authored before scoping existed)
  - `"auto"` — only loaded when intent matches (preferred for most user skills — keeps the coordinator's prompt small on unrelated turns)
  - `"exclude"` — never available to the coordinator. Use for heavyweight skills that belong on a specialist agent (GPU-pod managers, finance ingestion, batch ML training). The skill stays usable on other agents via direct chat or `ask_agent`.

### refreshCadence (optional — for skills whose results go stale predictably)

Personalization can open a **lead**: a stored tool+args re-run silently later when the answer to something wasn't available yet ("is this back in stock", "did the price drop"). If your skill's data has a natural refresh rhythm, declare it at the top level of `manifest.json`:

```jsonc
{
  "id": "usr_myskill",
  "refreshCadence": "weekly:thursday",
  ...
}
```

Accepted values:
- `"daily"` — re-check once a day.
- `"hourly"` — re-check once an hour.
- `"weekly:<day>"` — re-check once a week on the named day (e.g. `"weekly:thursday"` for a skill whose weekly ad refreshes on Thursdays).

When a lead is registered against a tool from your skill, this declared cadence wins over the model's own guess at how often to re-check. Declare it whenever your skill's underlying data updates on a known schedule; skills without one (arbitrary one-off lookups) can omit the field and fall back to the model's estimate.

### readOnly (optional — opts a tool into automatic personalization lead re-checks)

The 15-minute lead sweep re-invokes a stored tool+args completely unattended — no human in the loop, no confirmation. That's only safe for a tool that does nothing but look something up, so a tool is only eligible to be auto-re-checked if you say so explicitly, on the tool itself:

```json
{
  "type": "function",
  "readOnly": true,
  "function": {
    "name": "myskill_check_price",
    "description": "Check the current price for a saved item",
    "parameters": {...}
  }
}
```

Only set `readOnly: true` on a tool that is a pure data-fetch: no side effects, nothing sent, nothing changed, safe to call again and again with no one watching. Leave it off (the default) for everything else — including a tool you'd mark `destructive: false` above. "Not destructive" and "safe to auto-re-invoke unattended on a schedule" are different bars; most tools clear the first without clearing the second.

A tool without `readOnly: true` still works normally in live turns — the flag has no effect on ordinary use. It only means no follow-up lead can be registered against it: `ctx.registerLead` is rejected at registration and reports that honestly back to the calling skill (it never claims it'll check back and then silently drop the follow-up).

To make an empty lookup genuinely useful later, register a lead only after the
user explicitly asks for a follow-up. Return the helper's `announce` line so the
user knows whether tracking was actually stored:

```js
if (args.follow_up === true && result === 'No results found.') {
  const followUp = await ctx.registerLead({
    query: `Find an available result for ${args.query}`,
    toolName: 'usr_myskill_search',
    args: { query: args.query }, // omit follow_up: re-checks must not recurse
    skillId: 'usr_myskill',
    cadenceHint: 'daily'
  });
  return `${result}\n\n${followUp.announce}`;
}
```

The stored tool must be declared `readOnly: true`. Never register a lead from
an ordinary empty result, and never store the follow-up flag in the re-check
arguments; both rules prevent surprise monitoring and recursive duplicate
registrations.

### preferenceOpportunities (optional — preference-aware monitoring with graduated autonomy)

A skill that already knows how to monitor its domain can offer that capability
when a **confirmed** user preference becomes relevant. The bridge is generic:
Personalization enumerates every enabled custom skill's validated recipes; it
does not contain a store-, product-, or skill-specific matcher. Each skill owns
its narrow domain vocabulary, activation tool, watcher, and result filtering.

This contract is ask-first by default. Casual queries (for example, "are apples
on sale?"), tool calls, and unconfirmed inferences never become preferences or
start monitoring. A separately confirmed statement such as "I love Honeycrisp
apples" can match any enabled skill that explicitly declares the relevant
domain terms.

```jsonc
"preferenceOpportunities": [{
  "id": "preference-deal-watch",              // lowercase kebab slug
  "preferenceKeywords": ["apple", "fruit"],  // skill-owned domain match terms
  "activationTool": "myskill_watch_preferences",
  "activationArgs": { "deliver": "notify" }, // static, secret-free defaults
  "watcherKind": "myskill_preference_check",
  "dedupKey": "myskill-preferences-default",  // same key stored by proposeMonitor
  "autonomy": "informational",                // optional; omit to stay ask-first
  "title": "Watch for deals on things you like?",
  "body": "This skill can compare new deals with your confirmed preferences. It asks first unless you enabled Safe initiative; proactive activity explains why it appeared and includes feedback and control actions."
}]
```

Optional `interestSignals` mappings let an ordinary successful lookup count as
weak topical evidence without pretending the question was a preference:

```jsonc
"interestSignals": [
  { "tool": "myskill_search", "arg": "query" }
]
```

Each mapping must name this manifest's non-destructive tool and one declared,
non-sensitive string argument. Only interactive successful calls whose value
matches the recipe's `preferenceKeywords` are retained, at low confidence. One
lookup never confirms a preference or starts a monitor; repeated observations
may later support an inferred suggestion that still requires the normal user
confirmation path. Automation ticks, failed calls, undeclared args, results,
credentials, and arbitrary tool arguments do not become interest evidence.

The activation tool must belong to the same manifest and have
`"destructive": true`, because it creates durable watcher state. It should
call `ctx.proposeMonitor` with the declared `watcherKind`, `skillId`, and
`dedupKey`; the watcher itself owns fetching, domain matching, state, cadence,
and delivery. Activation args are size-bounded and rejected if they contain
credential-like fields or values. Keep credentials in `ctx.getCredential`,
never in this manifest block.

Because approval can outlive the current turn, preference-enabled execution is
bound to an immutable code snapshot. Keep that executor self-contained: Node
builtins plus literal relative `.mjs`/`.json` imports inside the same skill are
supported and the complete local import closure is pinned. Non-literal dynamic
imports, CommonJS/`.js`, package imports, symlinks, imports from mutable
`state/`, and relative imports that escape the skill directory fail closed for
preference activation. Use `ctx`/`helpers` capabilities for platform services
instead of importing app internals from a preference-enabled executor.

The declaration is also the skill's least-privilege profile-read scope.
`preferenceKeywords` must be narrow domain terms, never copied user values or a
catch-all vocabulary. A valid recipe gives only that skill access to matching,
active, positive, confirmed preferences in global or same-skill scope. It does
not grant access to general memory, evidence, provenance, other skills' scoped
preferences, negative rows, or inferred rows. The helpers return `[]` when
Personalization is off, incomplete, unavailable, or the recipe is invalid.

Use the legacy string projection for simple text matching:

```js
const statements = await ctx.personalization.confirmedPreferences();
// In a watcher: await helpers.personalization.confirmedPreferences()
```

Use the structured projection when the skill can honor bounded conditions:

```js
const details = await ctx.personalization.confirmedPreferenceDetails();
// [{
//   statement, subject, sentiment: 'positive',
//   merchant?, context?,
//   priceCeiling?: { value, currency?, unit? },
//   temporary?: { hint?, expiresAt? }
// }]
```

Both projections return at most 20 matches. Strings and nested fields are
clamped, expired temporary preferences are omitted, and no memory id, evidence,
or provenance is exposed. Prefer `subject` over parsing `statement`; apply
`merchant`, `context`, `priceCeiling`, and `temporary` only when they matter to
the skill's domain. Do not fuzzy-search Cortex or build a second preference
store inside the skill.

`"autonomy": "informational"` is the only unattended first-activation
contract. Use it only when the tool does nothing except start an informational,
private, exactly stoppable watcher, and set `activationArgs.deliver` explicitly
to `"notify"`. Agent delivery starts an executable LLM turn and therefore does
not qualify. It remains ask-first unless the user separately
enables **Safe initiative**. When enabled, the runtime reserves a durable
receipt before execution, revalidates the live contract, requires exactly one
new matching watcher, and exposes feedback plus **Stop/Undo**. A mismatch is
torn down.
The declaration is not self-authorizing: unattended execution also requires a
server-reviewed implementation digest. New or modified skill code therefore
cannot cold-start automatically. A new, unreviewed contract may first be
evaluated silently in shadow mode (nothing is shown or run) before it becomes
eligible for an ordinary **Turn it on** card. Shadow observations are neutral,
not evidence that the user liked the suggestion.

Never use informational autonomy for agent turns, purchases, messages, posts,
calendar changes, email/Telegram delivery, destructive operations, or any behavior
without an exact undo identity. Those must omit `autonomy` and remain
ask-first. A skill's label is a safety promise, not a way to bypass consent.

The runtime revalidates the live manifest, confirmed preference match, master
Personalization switch, skill availability, exact tool/args, and absence of an
active matching watcher at activation time. Quiet proactivity emits no new
activation cards or safe-auto starts. Ask-first cards do not graduate to
unattended watcher activation; the separate Safe initiative setting and
`informational` contract are the only first-activation path.

The platform, not the skill, learns utility for the exact versioned activation
contract and a bounded categorical context. **Useful** and acted-on outcomes
increase confidence; **Not useful**, **Stop**, and **Undo** downgrade future
behavior; a dismissal is a decaying "not now" signal; ignored and shadowed
candidates are neutral. **Snooze** pauses the exact watcher temporarily, and
**Edit preference** changes the user-owned source rather than teaching a hidden
skill profile. A current "why this appeared" explanation points back to that
confirmed preference. Skills must not persist these outcomes or infer approval
from a notification being shown. Learned utility can make the runtime more
cautious, but can never override consent, review, delivery, action-risk, quiet
hours, skill availability, or exact-undo gates.

---

### localIntents — handle simple requests locally (no cloud LLM)

`intent_examples` decides whether your tools get *loaded* for the cloud coordinator. **`localIntents` goes one step further: it fulfils a request entirely on-device, with no cloud-LLM call at all.** When a user's message matches a local intent, OpenEnsemble runs your tool directly and streams the result back — faster, cheaper, private. This is the local cognition tier; lean on it for any **deterministic** operation (a lookup, a list/search, a delete-by-sender, a toggle).

How a turn resolves a local intent:
1. **embeddings — the primary path.** Your `utterances` are matched semantically (nomic, on-device) to pick the intent. This is what *classifies* the request, and it **self-improves**: phrasings the tier misses get learned over time. Write good utterances and most intents need nothing else.
2. **regex `patterns` — slot extraction only.** If a pattern matches AND captures a slot, the tier short-circuits even before embeddings (free, deterministic). Use patterns ONLY to pull a **structured token** out of the utterance — an email, an id, a ZIP, a date, an order number. A pattern that captures no slot is ignored for routing (embeddings handle classification); a `.+` free-text slot is a poor fit — leave it to step 3.
3. **extract model** — a small on-device model fills the messy, free-text slots the regex didn't (an item name, a search query). Extracted values are validated against the user's text (must appear verbatim) so it can't hallucinate.

If none match confidently, the turn falls through to the normal coordinator — so a local intent is a pure optimization, never a risk.

```jsonc
"localIntents": [
  {
    "id": "search_item",
    "tool": "kroger_search",                 // a tool THIS skill declares
    // Classification rides entirely on utterances — write varied, real phrasings.
    "utterances": ["any deals on greek yogurt", "is coffee on sale", "what's bogo on snacks", "search publix for pizza"],
    "patterns": [],                           // query is free text → no regex; the extract model fills it
    "slots": ["query"],                       // tool params the intent fills
    "confirm": false
  },
  {
    "id": "purge_sender",
    "tool": "email_purge_sender",
    "utterances": ["delete all email from someone", "purge messages from an address"],
    // sender is a STRUCTURED token (an email) → a tight regex captures it for free.
    "patterns": ["(?:delete|purge)\\b.*\\bfrom\\s+(?<sender>\\S+@\\S+)"],
    "slots": ["sender"],
    "confirm": true                            // destructive → defers to the approval flow, never auto-runs
  }
]
```

Rules of thumb:
- **Lead with `utterances`.** They are the classifier — 3–8 varied, real phrasings (same spirit as `intent_examples`). The tier learns new phrasings on its own, so you don't have to enumerate every wording.
- **Use `patterns` only to capture a structured-token slot** (email, id, ZIP, date, SKU) via a `(?<slot>...)` named group. Do NOT write patterns as classifiers (`^(?:check|show|list)\\b.*\\binbox\\b`) — embeddings do that better and self-improve. Do NOT write `.+` free-text slots — the extract model handles those. A pattern that captures no slot is ignored for routing.
- **`tool`** must be one of this skill's own tools. **`slots`** name that tool's parameters; only the named ones are filled by the local tier, the rest use the tool's defaults.
- Set **`confirm: true`** for anything destructive or otherwise requiring confirmation. This is mandatory when the target tool has `destructive: true`; the manifest validator rejects a local intent that tries to downgrade such a tool. Confirmed intents never auto-run locally—they hand off to the normal "APPROVE" flow.
- You can add `localIntents` at create time (`skill_create`) or to an existing skill (`skill_update_manifest`). Adding them is free latency/cost savings — do it for any skill with simple, unambiguous operations.

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

### Signaling failure

When a tool can't complete its job, the runtime needs to **know** it failed — otherwise the
per-turn trace (`read_turns`) records it as `ok`, flaky-tool proposals never fire, and the
recipe learner may bank the broken call as a "successful" recipe.

Two correct ways:

```js
// 1. Let it throw — the dispatcher catches, records the failure, and reports it.
const data = await fetchThing();          // throws on network error → handled for you

// 2. Caught an error but want a clean message? Use ctx.toolError (5th arg):
export async function executeSkillTool(name, args, userId, agentId, ctx) {
  if (name === 'myskill_do_thing') {
    try {
      return await doWork(args);
    } catch (err) {
      return ctx.toolError(`Couldn't process that: ${err.message}`);
    }
  }
  return null;
}
```

❌ **Do not** `return \`Error: ${err.message}\`` as a plain string. That is indistinguishable
from success to the runtime — it's the one footgun this guidance exists to prevent. `throw` or
`ctx.toolError(...)` instead. (`return null` is still only for *unrecognized tool names*, never
for failures.)

---

## Skills that need an external runtime

If your skill shells out to an external binary (`yt-dlp`, `ffmpeg`, …), **the skill
must own that runtime under its own directory and run it sandboxed** — never
hardcode an absolute path to somewhere else on disk (a sibling project or a user's
`~/.local/bin` can be deleted out from under you, surfacing only as a raw `spawn …
ENOENT`), and never spawn an unsandboxed downloaded binary.

Two `ctx` helpers do this for you:

```js
export async function executeSkillTool(name, args, userId, agentId, ctx) {
  if (name === 'myskill_do_thing') {
    // 1. Provision the binary INTO the skill (consent-gated download, self-heals,
    //    idempotent). Returns the absolute path under <skill>/bin/.
    const bin = await ctx.ensureRuntime({
      name: 'yt-dlp',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
      // sha256: '…',  // optional but recommended — verified before use
    });

    // 2. Run it SANDBOXED via bubblewrap. System is read-only; the skill dir is
    //    auto-bound read-only; only writableDirs are writable.
    const outDir = ctx.userFilesDir?.('videos') || '/tmp';
    const { code, stdout, stderr } = await ctx.runSandboxed(bin, ['-o', `${outDir}/%(title)s.%(ext)s`, args.url], {
      writableDirs: [outDir],
      net: true,                 // yt-dlp needs network — also declare "sandbox":{"network":true} in your manifest
      timeoutMs: 10 * 60 * 1000,
    });
    if (code !== 0) return ctx.toolError(`yt-dlp failed: ${stderr.slice(-400)}`);
    return `Downloaded to ${outDir}`;
  }
  return null;
}
```

What this gives you, automatically:
- **`ctx.ensureRuntime({ name, url, sha256? })`** — on first use (or if the binary was
  later deleted) it asks the user to approve the **exact URL** before downloading
  into `<skill>/bin/<name>`, verifies the checksum if you give one, and `chmod +x`. No
  allowlist — a user can request any tool; safety is consent + the sandbox below.
- **`ctx.runSandboxed(bin, args, { writableDirs, net, timeoutMs })`** — runs the binary
  under bubblewrap: system read-only, the skill dir read-only, only your declared
  `writableDirs` writable, isolated namespaces. A downloaded binary can't read
  credentials, the OE config, or other users' files. `net: true` is capped by your
  manifest's `sandbox.network` — a skill that didn't declare network gets none here
  either, no matter what you pass.
- A `node` interpreter is always available at `process.execPath` (and inside the
  sandbox); don't pin a specific nvm path.

Only reach for a manual `resolveBinary`/`spawn` if you're intentionally using a
system tool the user already trusts — and even then, prefer the helpers above.

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

## Custom skills run sandboxed (security)

If your skill is a **per-user / custom skill** (it lives in `users/{userId}/skills/`), its `execute.mjs` runs inside an isolated jail — it can touch only its owner's data, never another user's data, the OE config, or any secret. Author within these limits or the tool will fail at runtime:

**Consent at create time — ASK THE USER.** New skills are created sandboxed by default (`skill_create` sets `sandbox:{isolate:true}`). Before creating, tell the user the skill will run isolated, and:
- **Network:** if the skill uses `fetch`/HTTP or downloads a binary, `skill_create` **refuses** until you pass `allow_network` explicitly — network egress lets a skill send data out, so ask the user first, then pass `allow_network:true` (grant) or `false` (offline).
- **Credentials:** if it stores secrets via `ctx.credentials`, mention that they live in an encrypted per-skill store.
- **Opting out:** `sandbox:false` runs the skill in-process with full access — only for a trusted admin skill (e.g. one that inspects the OE install), and only with the user's clear OK.

On `skill_update_code`, the tool re-scans and flags if the skill isn't sandboxed or if new code needs network; grant later via `skill_update_manifest({id, sandbox:true})` / `({id, allow_network:true})`.

**File I/O — owner's output folders only.** You may read/write the owner's `documents`, `images`, `videos`, `audio`, and `research` folders (via `getUserFilesDir`) plus your own per-skill state dir (below). The `code` folder is NOT mounted for custom skills, and anything outside these — other users' dirs, `config.json`, OAuth/token files, the master key — does not exist inside the sandbox, so reads fail with `ENOENT`.

**Secrets / API keys — use `ctx.credentials`, never the filesystem.** Don't read token files and don't write a key into a data folder. Store and fetch your skill's own secrets through the brokered store:
```js
await ctx.credentials.set('apiKey', value);     // encrypted at rest, scoped to THIS skill
const key = await ctx.credentials.get('apiKey'); // null until set
```
These are namespaced per skill, so no other skill (or user) can read them, and the encryption key never enters the sandbox. This is how a skill like a RunPod client keeps its API key.

**Persistent non-secret state — your state dir.** For a small db / config / cache that must survive across runs, write under `users/{userId}/skills/{skillId}/state/` — the one writable spot inside your skill's own folder, isolated from every other skill.

**Network — default-deny, you must declare it.** A custom skill runs with *no* outbound network unless its manifest opts in:
```json
"sandbox": { "network": true }
```
Without that, `fetch` and any binary you run via `ctx.runSandboxed` have no egress — the jail has its own empty net namespace (it can't even reach the host's `127.0.0.1` services). Declare it only if you actually call out; an undeclared (or malicious) skill can't exfiltrate whatever it can read.

First-party skills shipped in `skills/` run in-process and are not subject to these limits — but anything authored per-user is, by design.

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

## Monitored-source pattern (`ctx.proposeMonitor`)

**Use this for any skill the user describes proactively** — "make a tracker for X", "ping me when new Y arrive", "monitor Z weekly". It's a thin wrapper around `ctx.watch` that handles cadence presets, sensible defaults, and dedup so skills stay short.

### Four-piece recipe

Every proactive skill has the same four pieces — design them in this order:

1. **Fetcher** — a tool (or a private helper) that retrieves the current state of the source. Prefer RSS > public JSON API > JSON-LD scrape > full HTML scrape.
2. **Cadence** — pass a preset string to `proposeMonitor`. Skill picks the right one based on how fast the source changes:
   - `minutely` — rare; only for build/queue polling
   - `fast` (5 min) — prices, stock alerts
   - `hourly` — feeds, channels, social
   - `daily` — release notes, blogs, store ads (when the day-of-week matters, see below)
   - `weekly` — slow-rotating sources
3. **Pref-aware filter** — read only the preferences the user explicitly confirmed before notifying, so the user hears about items they care about without treating guesses or incidental memory as policy. When the domain has structured conditions, prefer the detail helper in a watcher handler:
   ```js
   const prefs = await helpers.personalization.confirmedPreferenceDetails();
   ```
   Tool handlers use the matching `ctx` surface. Use `confirmedPreferences()` instead when a bounded `string[]` is sufficient. Shared-profile access requires this skill's valid, narrow `preferenceOpportunities` declaration and returns only matching positive confirmed rows; otherwise it returns `[]`. Use `subject` and any relevant merchant/context/price/temporary conditions to filter results. Do not fuzzy-search general memory, treat an ordinary lookup as a preference, or notify about everything when the helper is empty.
4. **Delivery** — pick `deliver` based on the user's explicit ask:
   - `deliver: 'agent'` (default) — injects a `[WATCHER FIRED]` system note and runs an agent turn so the LLM summarizes naturally (good for voice + chat). Pair with `agentPrompt: '...'`.
   - `deliver: 'email'` — when the user says "email me when X" / "send it to my email" / "notify me by email". Sends FROM the user's primary connected account TO their profile email — **no agent turn, no `ask_agent` round-trip**. Pair with `emailSubject: '...'`. **Never route email delivery through `ask_agent` to an email agent**; this branch handles it directly via `lib/email-delivery.mjs`.
   - `deliver: 'telegram'` — when the user says "text me when X" / "send me a telegram" / "message me on telegram" / "ping me on telegram". Sends via the user's linked Telegram bot — **no agent turn, no `ask_agent` round-trip**. Optionally pair with `telegramPrefix: '...'` for a header line. **Never route Telegram delivery through `ask_agent`**; this branch handles it directly via `routes/telegram.mjs:sendTelegramToUser`. If the user hasn't linked Telegram yet, the send returns false and the watcher logs a warning; the watcher itself keeps running.
   - `deliver: 'notify'` — quiet status bubble. Reserve for "just a notification, don't read it to me" cases.

   In your handler, call `await helpers.fire(message)` instead of `helpers.fireAgent` — `fire` dispatches based on whatever `deliver` was chosen at registration. The same handler emails OR speaks depending on the mode. Write `message` as plain prose when `deliver: 'email'` (it becomes the email body) and as a TTS-friendly instruction when `deliver: 'agent'` (it becomes the LLM prompt).

   **Rich HTML email + per-fire subject.** For `deliver: 'email'`, use the object form to send a formatted card and a dynamic subject computed from what changed:

   ```js
   await helpers.fire({
     subject: `New video from ${ch.name}: ${video.title}`,  // overrides emailSubject for this fire
     html:    renderCardHtml(video),                          // full HTML body (multipart/alternative)
     message: `${ch.name} posted "${video.title}" — ${video.url}`, // plain-text alternative
   });
   ```

   `html` is delivered as a real `text/html` part (via `lib/email-delivery.mjs` → the email skill's `multipart/alternative`); `message` becomes the plain-text alternative and the status-bubble text. If you omit `message`, a plain-text version is auto-derived from the HTML. `html`/`subject` are ignored for non-email delivery modes, so a single handler stays delivery-agnostic. This is generic — any watcher in any skill can send HTML email this way; nothing skill-specific is required.

### Changing delivery mode for an existing watcher

If the user changes their mind ("actually, email me instead"), the kickoff tool must accept a `deliver` param and drop the existing watcher before re-registering — `proposeMonitor`'s `dedupKey` will otherwise no-op and silently keep the old delivery mode:

```js
// Drop the existing watcher for this dedup identity if delivery is changing
const existing = await listMonitorsForSkill(userId, SKILL_ID);
const stale = existing.find(w =>
  w.kind === KIND &&
  w?.state?.dedupKey === dedupKey &&
  w?.onFire?.type !== (newDeliver === 'email' ? 'email' : 'agent')
);
if (stale) await ctx.unwatchMatching((r) => r.id === stale.id);

await ctx.proposeMonitor({ /* …, deliver: newDeliver */ });
```

### `ctx.proposeMonitor` signature

```js
const { watcherId, deduped } = await ctx.proposeMonitor({
  kind:         'mysite_check',   // must match a key in your watcherHandlers
  state:        { url, lastSeenId: null /* arbitrary, passed to handler */ },
  cadence:      'weekly',         // preset or number-seconds or { sec: N }
  label:        'Watch mysite for new posts',
  expiresAt:    null,             // null = indefinite (typical for monitors)
  deliver:      'agent',          // 'agent' | 'email' | 'telegram' | 'notify'
  agentPrompt:  'Summarize new mysite posts in 1-2 spoken sentences.',
  // ── email-only fields ───────────────────────────────────────────────
  emailSubject: 'New posts on mysite',           // when deliver='email'
  emailTo:      undefined,                       // optional, defaults to profile email
  emailAccount: undefined,                       // optional, defaults to primary
  // ── telegram-only fields ────────────────────────────────────────────
  telegramPrefix: '🆕 mysite update',             // when deliver='telegram'; optional header line
  // ────────────────────────────────────────────────────────────────────
  skillId:      'mysite',         // your skill's id
  dedupKey:     'mysite-default', // skip if already-watching same identity
});
```

Returns `{ watcherId, deduped }`. When `deduped: true`, an existing watcher for the same `(skillId, kind, dedupKey)` was reused — no new registration.

> ⚠️ **`skillId` must equal your manifest `id` verbatim.** The legacy `usr_<id>` prefix is dropped by the migration; if you pass `'usr_my-skill'` when your manifest declares `"id": "my-skill"`, the supervisor will log `Handler not found` every tick and the watcher will fail out after 3 attempts. Declare a single `const SKILL_ID = '<exact-manifest-id>';` at the top of `execute.mjs` and reuse it.

### Day-of-week scheduling without a cron primitive

When the source has a known refresh day (e.g. Publix circulars rotate Wednesdays), pick a `daily` cadence and check `new Date().getDay()` at the top of your handler — return `{}` (no `textUpdate`) on non-matching days. That's cheaper than a real cron and reuses the existing supervisor.

```js
export const watcherHandlers = {
  publix_bogo_check: async (state) => {
    const day = new Date().getDay();          // 0=Sun, 3=Wed
    if (day !== 3) return {};                  // silent no-op until Wednesday
    // ...fetch + filter + return { textUpdate, newState }
  },
};
```

### When to use `proposeMonitor` vs `ctx.watch`

- `ctx.proposeMonitor` — proactive "ping me when…" skills (this section).
- `ctx.watch` — internal job/poll loops where you already know the exact `cadenceSec`, `expiresAt`, and `onFire` shape (e.g. an image-generation skill polling a render job to completion).

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

Two distinct stores depending on what kind of value you're keeping:

| What you're storing | Use | Where it lives |
|---|---|---|
| API keys, passwords, OAuth tokens, webhook secrets | `lib/credentials.mjs` primitive | `users/<id>/credentials/<credId>.json`, encrypted with per-user key |
| Non-secret config (URLs, IDs, user preferences, last-fetched timestamps) | Plaintext JSON in user dir | `users/<id>/usr_<skillId>-config.json` |

**NEVER** write API keys / passwords / tokens to a plaintext config file. The credential primitive gives you AES-256-GCM at-rest encryption + a chat-prompt widget for getting the value from the user in the first place — no need to invent your own flow.

### Secrets: the credential primitive

The executor's `ctx` parameter (5th arg) exposes the credential primitive — **never import `lib/credentials.mjs` directly from a user skill**. Direct imports require a relative path whose depth differs between built-in skills (`skills/<id>/`, two up) and user skills (`users/<id>/skills/<id>/`, four up); LLMs miscount the dots, the module fails to resolve, and the tool errors out. `ctx.*` always works.

```js
export async function executeSkillTool(name, args, userId, agentId, ctx) {
  if (name === 'my_call') {
    // 1. Try the user's stored credential (decrypted on read).
    let apiKey = await ctx.getCredential('myskill_api_key');

    // 2. If missing, prompt via the chat widget. The plaintext value is sent
    //    over the WS in a protected frame — it NEVER enters the LLM message
    //    history, never gets logged, never echoes back. `persist: true`
    //    stores it encrypted; the next call hits the fast path above.
    if (!apiKey) {
      apiKey = await ctx.requestCredential({
        id:    'myskill_api_key',
        label: 'My Service API key',
        kind:  'api_key',
        persist: true,
      });
    }

    // 3. Use the value. Don't return it in the tool result — see below.
    const res = await fetch('https://api.myservice.com/...', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return await res.json();
  }
}
```

**If your tool result must reference the credential** (e.g. you're returning a command line that includes the key), mark it `{ isCredential: true, credentialId: 'myskill_api_key', ... }` so the per-provider substitution in `chat/providers/*.mjs` replaces it with a placeholder before the LLM sees it. The placeholder gets re-substituted at the next executor call. Without this flag, the plaintext key flows through the LLM history and shows up in chat logs.

`kind` options:
- `'api_key'` — persisted encrypted (default for long-lived creds)
- `'sudo'` / `'confirm'` — held in RAM only, expires after use (for one-shot sensitive actions)

### Non-secret config

For URLs, account IDs, user preferences, last-fetched timestamps — anything that wouldn't be a problem if it appeared in a backup tarball — use the plaintext per-user file pattern:

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
