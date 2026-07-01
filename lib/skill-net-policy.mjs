// @ts-check
/**
 * Default-deny network policy for SANDBOXED custom skills.
 *
 * A jailed skill's process runs with `--unshare-net` (its own empty net namespace, so
 * no egress and no reach to the host's loopback services) UNLESS its manifest opts in:
 *
 *     "sandbox": { "network": true }
 *
 * This closes the last isolation gap. File/secret isolation already stop a rogue skill
 * from *reading* another user's data; without a network default-deny it could still
 * exfiltrate whatever it legitimately can read. Least-privilege: a skill only gets
 * egress when it declares it needs it, so an undeclared (or malicious) skill is mute.
 *
 * Leaf module (fs + paths only) on purpose: three seams set a net namespace for the
 * same skill — the tool executor (roles), the watcher tick (scheduler), and the
 * external-binary runtime broker (yt-dlp et al.) — and they must agree. Reading the
 * one manifest.json here keeps a single source of truth without an import cycle
 * (roles → skill-subprocess → skill-ctx-broker → skill-runtime-broker → …).
 */
import fs from 'fs';
import path from 'path';
import { userSkillsDir } from './paths.mjs';

/**
 * Whether a sandboxed custom skill is allowed outbound network. Default-deny: anything
 * other than an explicit `sandbox.network === true` (missing manifest, parse error,
 * bad shape) returns false.
 * @param {string} userId @param {string} skillId @returns {boolean}
 */
export function skillDeclaresNetwork(userId, skillId) {
  if (!userId || !skillId) return false;
  try {
    const p = path.join(userSkillsDir(userId), skillId, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    return m?.sandbox?.network === true;
  } catch {
    return false;
  }
}
