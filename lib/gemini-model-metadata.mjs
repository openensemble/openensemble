import { documentedModelMetadata } from './model-document-cache.mjs';
import { mergeModelMetadata, normalizeModelMetadata } from './model-metadata.mjs';

const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const FEATURE_NAMES = {
  'Audio generation': 'audio_generation', Caching: 'prompt_caching',
  'Code execution': 'hosted_code_execution', 'File search': 'file_search',
  'Function calling': 'function_calling', 'Grounding with Google Maps': 'maps_grounding',
  'Image generation': 'image_generation', 'Live API': 'realtime',
  'Search grounding': 'web_search', 'Structured outputs': 'structured_outputs',
  Thinking: 'thinking', 'URL context': 'url_context', 'Batch API': 'batch',
  'Flex inference': 'flex_inference', 'Priority inference': 'priority_inference',
};

export function parseGeminiModelCard(html, id, source) {
  const tables = html.match(/<table\b[^>]*class="[^"]*gemini-api-model-table[^"]*"[^>]*>[\s\S]*?<\/table>/gi) ?? [];
  const table = tables.find(value => [...value.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].some(row =>
    /Model code/.test(text(row[1])) && [...row[1].matchAll(/<code\b[^>]*>([^<]+)<\/code>/gi)].some(match => text(match[1]) === id)));
  if (!table) throw new Error('Model documentation did not identify the exact model');
  const capabilities = {};
  const raw = { capabilities, sources: [source], fetchedAt: Date.now() };
  for (const section of table.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gi)) {
    const parts = [...section[1].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(match => text(match[1]));
    if (parts.length !== 2) continue;
    const [label, value] = parts;
    if (label === 'Inputs' || label === 'Output' || label === 'Outputs') {
      raw[label === 'Inputs' ? 'input_modalities' : 'output_modalities'] = value.toLowerCase()
        .split(/,|\band\b/).map(item => item.trim()).filter(Boolean);
    } else if (label === 'Input token limit' || label === 'Output token limit') {
      const number = Number(value.replace(/,/g, ''));
      if (Number.isSafeInteger(number)) raw[label === 'Input token limit' ? 'max_input_tokens' : 'max_output_tokens'] = number;
    } else {
      const key = FEATURE_NAMES[label] ?? label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (value === 'Supported') capabilities[key] = { supported: true };
      else if (value === 'Not supported') capabilities[key] = { supported: false };
      else if (value.includes('AI Studio only')) capabilities[key] = { supported: false, availability: 'AI Studio only' };
      else if (/^Supported\b/.test(value)) capabilities[key] = { availability: value };
    }
  }
  if (!raw.input_modalities || !Object.keys(capabilities).length) throw new Error('Model documentation has no structured capabilities');
  return normalizeModelMetadata(raw);
}

export async function enrichGeminiModelMetadata(models, { refresh = false } = {}) {
  const enriched = [];
  for (let offset = 0; offset < models.length; offset += 12) {
    enriched.push(...await Promise.all(models.slice(offset, offset + 12).map(async model => {
      const id = String(model.id ?? model.name ?? '').replace(/^models\//, '');
      const source = `https://ai.google.dev/gemini-api/docs/models/${encodeURIComponent(id)}?hl=en`;
      const documented = /^gemini-[a-z0-9.-]{1,100}$/.test(id)
        ? await documentedModelMetadata('gemini', id, source, parseGeminiModelCard, { refresh }) : null;
      return { ...model, modelMetadata: mergeModelMetadata(documented, model) };
    })));
  }
  return enriched;
}
