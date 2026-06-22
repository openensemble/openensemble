# REVERT — skill-agnostic local cognition tier (`local-tier` branch)

Single source of truth for everything this feature touches and how to undo it.
Plan: `~/.claude/plans/playful-wandering-hartmanis.md`. All work lives on the
`local-tier` git branch (off `main` @ `cca4eb5`), one commit per phase.

## Kill switch (first response to any regression)

Runtime flag **`localTier.enabled`** in `config.json` (default **absent = off**).
- Off → the dispatch interceptor and `classify()` no-op; chat behaves exactly as before.
- Enable for testing: set `"localTier": { "enabled": true }` in `~/.openensemble/config.json`, restart.
- Disable: remove the key (or set `false`), restart. No code change, no data touched.

## Full revert (whole feature)

```
git checkout main          # leaves local-tier branch intact for later
# or, if merged to main:
git revert <phase-3> <phase-2> <phase-1>   # newest-first
```
Then drop per-user data (Phase 3 only — see below) and unset the flag.

## Per-phase file manifest

### Phase 1 — labeling engine + dispatch face (regex + nomic)
New:
- `lib/local-label.mjs` — the engine (collectLocalIntents, dispatch, localTierEnabled).
- `chat-dispatch/local-intent-fastpath.mjs` — the pre-LLM interceptor.
- `REVERT-local-tier.md` — this file.
Modified:
- `chat-dispatch.mjs` — import + one entry in the `INTERCEPTORS` array (after `tryTriviaFastpath`).
- `lib/manifest-validator.mjs` — validate optional `localIntents`/`localClassifiers`.
- `users/<id>/skills/publix-bogos/manifest.json` — add `localIntents` (additive).
- `skills/email/manifest.json` — add `localIntents` (additive).
Revert: delete the 2 new files, revert the chat-dispatch import+array line, drop the
manifest `localIntents` blocks (additive — removal restores prior behavior), revert validator.

### Phase 2 — `<extract>` plan-model task  (DONE 2026-06-08, live)
Modified:
- `scheduler/builtin-plan.mjs` — `<extract>` task token + TASKS entry + runtime-schema grammar
  (`_getGrammarForSchema`) + `extractSlots`/`formatExtractInput` + **force-bundled-for-extract**
  (extract bypasses Ollama/LM Studio so the local tier is self-contained).
  NOTE: `extractSlots` deliberately uses NO grammar — node-llama-cpp's JsonSchemaGrammar collapses
  nullable-string unions to null; the trained model emits valid JSON unaided.
- `lib/local-label.mjs` — Tier-3 `extractEnabled()` gate + extract dispatch (Phase-1 commit).
- `lib/model-fetch.mjs` — new `extract` tier in `BUNDLED_PLAN_MODELS` (default still `accurate`).
- `training/plan/train.py` — `<extract>` token + `--workers` / `--no-grad-ckpt` flags.
- `training/plan/thunder-train.mjs` — stage `extract.jsonl` + persist pod id to `.thunder-pod-*.json`.
- `training/plan/smoke-extract.mjs` — `""`==absent fix.
New:
- `training/plan/generate-extract-v1.mjs` → `training/plan/data/extract.jsonl` (6000 rows, gitignored data dir).
- `training/plan/smoke-extract.mjs` (Phase-1 commit) — extract eval, dual gate w/ smoke-scheduler.
- `models/openensemble-plan-360m-extract-v1.q8_0.gguf` (NEW file, 368 MB; old GGUFs untouched).
- `~/plan-export-venv` (CPU torch/transformers/peft/gguf — for re-exporting; outside repo).
Runtime config (config.json, gitignored):
- `scheduler.builtinPlanModel = openensemble-plan-360m-extract-v1.q8_0.gguf` (was `...360m-v1...`).
- `localTier.enabled = true`, `localTier.extract = true`. **`scheduler.planProvider` left = `ollama`** (scheduler unchanged).
Gate results: extract 31/34 (91.2%) PASS; planning new==v2 baseline (no regression).
Revert: kill switch `localTier.enabled=false` (instant); to fully back out, `git checkout` the files,
delete the new GGUF + `extract` tier entry, restore `builtinPlanModel`/`localTier` in config, `rm -rf ~/plan-export-venv`.

### Phase 3 — dispatch learning loop  (BUILT, staged OFF — flip `localTier.learning` + restart to activate)
Learns the phrasings the local tier missed: when a turn falls through the local fastpath and the LLM then
calls a tool that IS a user's localIntent tool, that utterance is captured; after 2 distinct misses for an
intent a `learned_intent` proposal is offered; accepting merges the phrasing into Tier-2 so it dispatches
locally next time (no cloud). Reuses the existing proposal + Learn-drawer + 24h-undo machinery.

New files:
- `lib/learned-intents.mjs` — per-user store (`users/<id>/learned-intents.json` + `.deleted.log`).
- `lib/intent-learner.mjs` — capture hook + threshold (candidates: `users/<id>/intent-miss-candidates.jsonl`).
- `lib/tool-exec-log.mjs` — in-memory recorder of provider-path tool executions (so capture sees DELEGATED
  specialist tool calls, which don't persist to the session jsonl). Hooked at `roles.mjs` executeToolStreaming.

Delegated-capture fix (2026-06-22): session-readback missed tools run by a delegated specialist (ask_agent →
ephemeral session). Now `roles.mjs` executeToolStreaming records every provider-path execution into
`tool-exec-log.mjs`; `intent-learner.captureFromTurn` consumes that instead of reading the session. The local
fastpath uses a different executor (executeRoleTool), so local successes aren't recorded — only genuine misses.
Threshold now fires on total misses (not distinct phrasings) so repeating one phrase still learns.

Modified files:
- `chat-dispatch.mjs` — one `captureFromTurn` line in the post-turn IIFE (next to alias-learner).
- `lib/alias-learner.mjs` — ADDED export `getLastTurnToolCalls` (purely additive; `observeTurnAndLearn` untouched).
- `lib/local-label.mjs` — `learningEnabled()` + merge learned utterances into `collectLocalIntents` (gated on the flag).
- `lib/proposals.mjs` — `learned_intent` kind: `proposeLearnedIntent` + `runLearnedIntent` accept + undo branch + `cooldownKey`.
- `lib/learnings.mjs` — `listLearnedIntents` + `revokeLearnedIntent` + `summarizeProposal` case + `readLearnings.learnedIntents`.
- `routes/misc.mjs` — `DELETE /api/learnings/learned-intents/:skillId/:intentId`.
- `public/learn.js` — "Learned phrasings" section + `learnRevokeLearnedIntent`.

Config: `localTier.learning = false` (staged off).
New per-user data: `learned-intents.json` (+ `.deleted.log`), `intent-miss-candidates.jsonl`.
Revert: kill switch `localTier.learning=false` (instant no-op — both capture and merge skip). Full back-out =
`git checkout` the 7 modified files, `rm lib/learned-intents.mjs lib/intent-learner.mjs`, and
`rm users/*/learned-intents.json users/*/learned-intents.deleted.log users/*/intent-miss-candidates.jsonl`.
Additive: removing the data restores manifest-utterance-only dispatch.

### Refinement — regex demoted to slot-extraction (not classification)  (2026-06-22)
Evidence (grep of all `localIntents`): 4 of 6 real intent patterns were pure classifiers (loose, qualifier-heavy,
now redundant with embeddings+learning); only 1 (`purge_sender` `\S+@\S+`) was regex at its best. So regex is
confined to structured-token slots; embeddings own classification.
- `lib/local-label.mjs` — Tier-1 guard: a pattern wins only if it fills a declared slot (`requiredSlots` satisfied
  AND `intent.slots.some(s => s in args)`). No-slot classifier patterns fall through to Tier-2.
- `lib/local-label.mjs` — Tier-3 extract now also fills OPTIONAL declared slots (was required-only), so a free-text
  query like "greek yogurt" gets extracted even though publix's `query` param is optional. Added `isDomainNoise`
  guard: drops an extracted value whose every token is a skill/intent/tool identifier word (e.g. "publix" from
  "what are the publix bogos") so framing words don't become bogus filters.
- `skills/email/manifest.json` — dropped classifier patterns from `list_email`/`inbox_stats`; kept `purge_sender`.
- `users/<id>/skills/publix-bogos/manifest.json` — dropped classifier+free-text patterns; broadened
  `search_bogos` utterances (fixes "any deals on greek yogurt"); query now filled by Tier-3 extract.
- `skills/SKILL_BLUEPRINT.md` + `skills/skill-builder/manifest.json` (param desc ×2 + SPA) — authoring guidance:
  lead with `utterances`; `patterns` only for structured tokens, never classifiers or `.+` free-text.
Revert: `git checkout` these 5 files. Guard validated deterministically; full routing needs a server restart.

## Status
- [x] Branch `local-tier` created off `main` @ cca4eb5
- [x] Phase 1 — built + verified live (regex+nomic dispatch, kill switch, 2 adopters). Flag left OFF (dark).
- [x] Phase 2 — extract task trained + shipped (360m-extract gguf); `localTier.extract` on.
- [~] Phase 3 — dispatch learning loop built + unit-smoked; staged OFF (flip `localTier.learning` + restart to verify live).
