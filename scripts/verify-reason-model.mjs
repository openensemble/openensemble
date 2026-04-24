#!/usr/bin/env node
/**
 * Smoke-test an exported ONNX reason model by loading it through the same
 * @huggingface/transformers pipeline the runtime uses. Catches op-compatibility
 * regressions before publishing to Hugging Face.
 *
 * Usage:
 *   node scripts/verify-reason-model.mjs <path-to-onnx-dir>
 *
 * Exits non-zero if any of the five cortex tasks fail to produce output.
 */

import path from 'path';

const MODEL_PATH = process.argv[2];
if (!MODEL_PATH) {
  console.error('Usage: node scripts/verify-reason-model.mjs <path-to-onnx-dir>');
  process.exit(2);
}

const TESTS = [
  { caller: 'salience',      user: 'Rate: "I prefer dark mode and always use it."' },
  { caller: 'contradiction', user: 'A: "I prefer dark mode" B: "I like light mode" — contradict?' },
  { caller: 'signals',       user: 'User: "actually I prefer light mode now" Agent: "got it, switching"' },
  { caller: 'friction',      user: 'A: "trash spam" B: "delete the spam messages"' },
  { caller: 'summary',       user: 'user: let\'s schedule a call\nassistant: what time?\nuser: 3pm' },
];

async function main() {
  const { pipeline } = await import('@huggingface/transformers');
  console.log(`[verify] loading ${MODEL_PATH}…`);
  const pipe = await pipeline('text-generation', path.resolve(MODEL_PATH));

  let failures = 0;
  for (const t of TESTS) {
    process.stdout.write(`[verify] ${t.caller}… `);
    try {
      const out = await pipe(
        [{ role: 'system', content: 'You are a memory assistant.' }, { role: 'user', content: t.user }],
        { max_new_tokens: 64, do_sample: false }
      );
      const gen = Array.isArray(out) ? out[0]?.generated_text : out?.generated_text;
      const text = Array.isArray(gen) ? gen.at(-1)?.content : gen;
      if (!text || !text.trim()) {
        console.log('FAIL (empty)');
        failures++;
      } else {
        console.log('ok');
      }
    } catch (e) {
      console.log(`FAIL (${e.message})`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`[verify] ${failures}/${TESTS.length} tests failed.`);
    process.exit(1);
  }
  console.log('[verify] all tasks produced output — smoke test passed.');
}

main().catch(e => {
  console.error('[verify] fatal:', e);
  process.exit(1);
});
