/**
 * Cortex embeddings + salience scoring + contradiction detection.
 */

import { createHash } from 'crypto';
import {
  VECTOR_DIM, getCortexConfig, getProviderSpec, generateCombined, safeParseJSON,
} from './shared.mjs';
import { builtinEmbed } from './builtin-embed.mjs';

// ── Embedding LRU cache ──────────────────────────────────────────────────────
// Recall, forget, and session-buffer code paths can all embed the same query
// text within one request (e.g. recall → forgetByText → contradiction check).
// A small LRU keyed by sha1(text)+model avoids the redundant HTTP calls to
// Ollama/LM Studio's embed endpoint (~5-20ms each).
const _embedCache = new Map(); // key → Float32Array / number[]
const EMBED_CACHE_MAX = 256;

function _embedKey(text, model) {
  return createHash('sha1').update(`${model}\0${text}`).digest('hex');
}

export async function embed(text) {
  const { embedUrl, embedModel, embedProvider } = getCortexConfig();
  const key = _embedKey(text ?? '', embedModel);
  const cached = _embedCache.get(key);
  if (cached) {
    _embedCache.delete(key);
    _embedCache.set(key, cached);
    return cached;
  }

  const zero = () => new Array(VECTOR_DIM).fill(0);

  if (embedProvider === 'builtin') {
    try {
      const vec = await builtinEmbed(text ?? '');
      if (vec.length && !vec.every(v => v === 0)) {
        _embedCache.set(key, vec);
        if (_embedCache.size > EMBED_CACHE_MAX) {
          const firstKey = _embedCache.keys().next().value;
          _embedCache.delete(firstKey);
        }
      }
      return vec;
    } catch (e) {
      console.warn('[cortex] Built-in embedding failed:', e.message);
      return zero();
    }
  }

  const spec = getProviderSpec(embedProvider);
  if (!spec || !spec.supportsEmbed) {
    console.warn('[cortex] Embed provider', embedProvider, 'not supported / has no embeddings endpoint.');
    return zero();
  }

  try {
    let url, body;
    if (spec.apiStyle === 'ollama') {
      url  = embedUrl || `${spec.baseUrl}/api/embeddings`;
      body = JSON.stringify({ model: embedModel, prompt: text });
    } else {
      // openai-compat (lmstudio, openai, deepseek, mistral, together, gemini, fireworks)
      url  = embedUrl || `${spec.baseUrl}/embeddings`;
      body = JSON.stringify({ model: embedModel, input: text });
    }
    const res = await fetch(url, {
      method: 'POST', headers: spec.headers, body,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    // Ollama: data.embedding  |  OpenAI-compat: data.data[0].embedding
    const vec = data.embedding ?? data.data?.[0]?.embedding ?? zero();
    const isZero = vec.length && vec.every(v => v === 0);
    if (!isZero) {
      _embedCache.set(key, vec);
      if (_embedCache.size > EMBED_CACHE_MAX) {
        const firstKey = _embedCache.keys().next().value;
        _embedCache.delete(firstKey);
      }
    } else if (data.error) {
      console.warn('[cortex] Embed API error:', data.error?.message ?? JSON.stringify(data.error));
    }
    return vec;
  } catch (e) {
    console.warn('[cortex] Embedding failed:', e.message);
    return new Array(VECTOR_DIM).fill(0);
  }
}

// ── Salience scoring ─────────────────────────────────────────────────────────
// Bare `Rate: "<text>"` matches training/train.py format_record('salience').
// Earlier we passed a verbose instruction including an Example tuple — the
// 135M cortex copied that tuple verbatim for every input regardless of
// content. Removing the instruction restored the head's actual learned
// discrimination.

export async function scoreSalience(text, meta = {}) {
  const safeText = text.slice(0, 300).replace(/"/g, "'");
  const raw = await generateCombined('', `Rate: "${safeText}"`, { caller: 'salience', ...meta });
  const s = safeParseJSON(raw);
  if (!s || typeof s.emotional_weight !== 'number') {
    return { emotional_weight: 0.5, decision_weight: 0.5, uniqueness: 0.5, composite: 0.5 };
  }
  return {
    emotional_weight: s.emotional_weight,
    decision_weight:  s.decision_weight,
    uniqueness:       s.uniqueness,
    composite: +(s.emotional_weight * 0.35 + s.decision_weight * 0.45 + s.uniqueness * 0.20).toFixed(3),
  };
}

// ── Contradiction detection ──────────────────────────────────────────────────
export async function checkContradiction(newText, existingMemories, meta = {}) {
  if (!existingMemories.length) return { contradicts: false };
  const safeNew = newText.slice(0, 300).replace(/"/g, "'");
  for (const existing of existingMemories.slice(0, 3)) {
    const safeEx = existing.text.slice(0, 300).replace(/"/g, "'");
    // Bare `A: "..." B: "..."` matches training/train.py format_record('contradiction').
    const raw = await generateCombined('', `A: "${safeNew}" B: "${safeEx}"`, { caller: 'contradiction', ...meta });
    const result = safeParseJSON(raw);
    if (result?.contradicts === true) {
      return { contradicts: true, conflicting_id: existing.id };
    }
  }
  return { contradicts: false };
}
