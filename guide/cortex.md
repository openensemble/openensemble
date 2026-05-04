# Cortex (local models)

> **Note:** these are small local models (135M–360M params) — fast and free, but not 100% accurate. Expect occasional misfires: a memory saved when it shouldn't have been, a paraphrase missed by the dedup head, a contradiction flagged on agreeing statements. You can correct any of them in chat ("forget that", "that wasn't a preference") and the heads keep improving as the models are retrained.

Cortex is the bundled set of local models OpenEnsemble runs in-process. They handle small, frequent reasoning tasks so the install works offline and doesn't burn cloud tokens for every internal decision.

## What it includes

- **`openensemble-reason-v3`** — a SmolLM2-based GGUF reasoning model used for tiny classifications, agent memory updates, content gating, and similar internal calls.
- **`nomic-embed-text-v1`** — the embedding model used for memory recall, search, and similarity.
- **Plan model** — a small bundled model that parses scheduling intent ("every Monday at 9am"). Two tiers ship: **fast** (`openensemble-plan-v5`, SmolLM2-135M, ~140 MB) and **accurate** (`openensemble-plan-360m-v2`, SmolLM2-360M, ~370 MB, default).

All three run via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) on CPU. No GPU required. They're loaded the first time they're needed and stay resident.

## What you don't need to do

- You don't need to download anything separately — the GGUFs ship with OpenEnsemble.
- You don't need to set up Ollama or LM Studio for these specific tasks. (You may still want them for *user-facing* chat models — see **LLM providers**.)

## Performance check

```
oe bench
```

Run that on the install to see tokens/sec and memory footprint for the reason and embed models. If it's slow on your hardware, see "Swapping providers" below.

## Swapping providers

In `config.json`:

```jsonc
"cortex": {
  "reasonProvider": "auto",      // built-in | ollama | lmstudio
  "lmstudioUrl": "http://127.0.0.1:1234"
}
```

- `auto` — use the bundled GGUF.
- `ollama` — call your local Ollama instead. Faster on a GPU; needs Ollama running.
- `lmstudio` — call LM Studio. Make sure JIT model loading is enabled in LM Studio, otherwise non-loaded models 404.

## When Cortex is slow

The bundled reason model is small but everything is CPU-bound. If you're on a constrained box, the most-felt slowness is:

- **Memory writes** after long chats (every chat persists summaries via Cortex)
- **Schedule parsing** when creating tasks
- **Agent classification** in the Coordinator

All of those are cacheable. The first one of each is slow; subsequent calls in the same session are fast.

## Privacy

Cortex calls never leave the box. Your memory, your routing decisions, your task descriptions — none of it is sent to a third-party model. (Whatever cloud model you pick for *user-facing chat* obviously sees those messages.)
