// @ts-check
/**
 * Server-reviewed implementation gate for unattended informational monitors.
 * A manifest's `autonomy` field is self-attested and is therefore never enough
 * to authorize arbitrary network-enabled code. Reviews bind the exact skill id
 * to an immutable identity of its complete local ESM dependency graph; any
 * edit automatically downgrades to ask-first until the new implementation is
 * reviewed here. Single-file skills retain their historical execute.mjs hash.
 */
import path from 'path';
import { SKILLS_DIR, userSkillsDir } from '../paths.mjs';
import {
  captureSkillIntegrity,
  materializeSkillCodeSnapshot,
} from './skill-code-integrity.mjs';

const REVIEWED_EXECUTORS = Object.freeze({
  'publix-bogos': Object.freeze({
    executor: 'd4837c0480477dd0128691846f8c3d6d2017b52dec5290e05338655796c91a9d',
    manifest: 'aeb29ace7dea200dae8db15ef358620778feb61017efcdfed559e7e388848b3c',
  }),
  'pokemon-etb-preorders': Object.freeze({
    executor: '0a41c314152c1fdbda9f9066a15fbcdf1c23e2761984b3aed167f45481adc8f2',
    manifest: '415c57012bec3ae43e25b65e6295345e083fd1e838f20200eaf17a381c6ff6b9',
  }),
});

function reviewedExecutorLocation(userId, manifest) {
  const expected = REVIEWED_EXECUTORS[manifest?.id];
  if (!userId || !expected) return null;
  const dir = manifest?.userScope === userId
    ? path.join(userSkillsDir(userId), manifest.id)
    : path.join(SKILLS_DIR, manifest.id);
  return {
    expected,
    dir,
  };
}

export function reviewedInformationalSkillDigest(userId, manifest) {
  const location = reviewedExecutorLocation(userId, manifest);
  if (!location) return null;
  try {
    const identity = captureSkillIntegrity(location.dir, manifest);
    return identity.executorDigest === location.expected.executor
      && identity.manifestDigest === location.expected.manifest
      ? identity.executorDigest : null;
  } catch { return null; }
}

export function isReviewedInformationalSkill(userId, manifest) {
  return !!reviewedInformationalSkillDigest(userId, manifest);
}

/**
 * Materialize the exact reviewed code closure in a random private sibling
 * directory. The sandbox replaces the live skill tree with that snapshot,
 * preserving its canonical path and separately rebinding only mutable state.
 * Callers must cleanup after the child exits.
 */
export function materializeReviewedInformationalSnapshot(userId, manifest, expectedDigest) {
  const location = reviewedExecutorLocation(userId, manifest);
  if (!location || expectedDigest !== location.expected.executor) return null;
  return materializeSkillCodeSnapshot(location.dir, manifest, {
    executorDigest: expectedDigest,
    manifestDigest: location.expected.manifest,
  });
}
