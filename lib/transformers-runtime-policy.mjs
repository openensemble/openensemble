/**
 * Security policy applied before loading Transformers.js.
 *
 * OpenEnsemble currently uses Transformers.js for text-only pipelines, but
 * Transformers.js also loads sharp's image helpers. Keep the vulnerable
 * libvips decoders unavailable even though those image paths are not used.
 */

export const BLOCKED_SHARP_LOADERS = Object.freeze([
  'VipsForeignLoadNsgif',
  'VipsForeignLoadTiff',
  'VipsForeignLoadVips',
]);

let sharpPolicyPromise = null;

function warningFor(error) {
  const detail = error instanceof Error ? error.message : String(error);
  return `[security] Could not apply the sharp decoder policy (${detail}); continuing with text-only Transformers.`;
}

/**
 * Apply sharp's official per-operation block policy.
 *
 * This helper is deliberately non-throwing. A missing native sharp build or
 * an older sharp API must not disable OpenEnsemble's text embedding path.
 */
export function applySharpDecoderPolicy(sharp, { warn = console.warn } = {}) {
  try {
    if (typeof sharp?.block !== 'function') {
      throw new Error('sharp.block is unavailable');
    }
    sharp.block({ operation: [...BLOCKED_SHARP_LOADERS] });
    return true;
  } catch (error) {
    warn(warningFor(error));
    return false;
  }
}

/** Apply the process-wide policy once, including across concurrent callers. */
export function ensureTransformersRuntimePolicy() {
  if (!sharpPolicyPromise) {
    sharpPolicyPromise = (async () => {
      try {
        const sharpModule = await import('sharp');
        return applySharpDecoderPolicy(sharpModule.default ?? sharpModule);
      } catch (error) {
        console.warn(warningFor(error));
        return false;
      }
    })();
  }
  return sharpPolicyPromise;
}

/** Load Transformers.js only after the sharp policy has settled. */
export async function loadTransformers() {
  await ensureTransformersRuntimePolicy();
  return import('@huggingface/transformers');
}
