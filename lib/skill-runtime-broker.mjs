// @ts-check
/**
 * Clamped external-binary runtime for SANDBOXED custom skills. The in-process
 * ctx.ensureRuntime/runSandboxed (roles.buildCtx) trust the skill; a jailed skill
 * is untrusted, so a naive broker would let it run ANY binary and write ANYWHERE
 * the parent can. This wraps the same provision/run primitives but enforces:
 *   - the binary must live under the skill's own <skillDir>/bin (i.e. something it
 *     provisioned via ensureRuntime — the jail mounts skillDir read-only, so it
 *     can't plant one), never an arbitrary host path;
 *   - writableDirs must be within the skill's OWN media/doc folders + state dir;
 *   - roDirs are clamped to the skill dir + those same folders.
 * The binary itself still runs in bwrap (skill-sandbox.runSandboxed) on top.
 *
 * allowPrompt=false (watcher tick — no human) makes ensureRuntime resolve-or-throw
 * instead of showing a download-consent prompt, matching the in-process behaviour.
 */
import path from 'path';
import { getUserFilesDir, userSkillsDir } from './paths.mjs';

// Kept in sync with skill-subprocess.CUSTOM_SKILL_WRITABLE_KINDS (duplicated here
// to avoid an import cycle: skill-subprocess → skill-ctx-broker → this).
const WRITABLE_KINDS = ['documents', 'images', 'videos', 'audio', 'research'];

function withinAny(target, roots) {
  const t = path.resolve(String(target || ''));
  return roots.some((r) => { const rr = path.resolve(r); return t === rr || t.startsWith(rr + path.sep); });
}

/** @param {string} userId @param {string} skillId @param {{allowPrompt?: boolean}} [opts] */
export function buildRuntimeBroker(userId, skillId, { allowPrompt = true } = {}) {
  const skillDir = path.join(userSkillsDir(userId), skillId);
  const binRoot = path.join(skillDir, 'bin');
  const stateDir = path.join(skillDir, 'state');
  const allowedWritable = [...WRITABLE_KINDS.map((k) => getUserFilesDir(userId, k)), stateDir];

  return {
    ensureRuntime: async (spec = {}) => {
      const { name, url, sha256 = null, label = null, confirmTtlMs = 5 * 60 * 1000 } = /** @type {any} */ (spec);
      if (!name || !url) throw new Error('ensureRuntime: { name, url } required');
      const rt = await import('./skill-runtime.mjs');
      const existing = rt.resolveSkillBinary(skillDir, name);
      if (existing) return existing;
      if (!allowPrompt) {
        throw new Error(`ensureRuntime: "${name}" is not provisioned and can't prompt here — run this skill once from chat first.`);
      }
      const m = await import('./credentials.mjs');
      try {
        await m.requestCredential({
          userId, kind: 'confirm', ttlMs: confirmTtlMs,
          label: label || `Download ${name}?`,
          description: `The "${skillId}" skill needs to download an external program:\n\n  ${name}\n  from ${url}\n\nIt runs sandboxed — its filesystem access is limited to the skill's own folder plus its output folders. Type "${name}" to approve, or Cancel to decline.`,
        });
      } catch {
        throw new Error(`Download of ${name} was declined or timed out — cannot continue without it.`);
      }
      return rt.provisionBinary({ skillDir, name, url, sha256 });
    },

    runSandboxed: async (bin, binArgs = [], opts = {}) => {
      const binResolved = path.resolve(String(bin || ''));
      if (!withinAny(binResolved, [binRoot])) {
        throw new Error("runSandboxed: refusing to run a binary outside the skill's own bin/ dir");
      }
      const writableDirs = Array.isArray(opts.writableDirs) ? opts.writableDirs : [];
      for (const d of writableDirs) {
        if (!withinAny(d, allowedWritable)) throw new Error(`runSandboxed: writableDir "${d}" is outside the skill's allowed folders`);
      }
      const roDirs = (Array.isArray(opts.roDirs) ? opts.roDirs : []).filter((d) => withinAny(d, [skillDir, ...allowedWritable]));
      const sb = await import('./skill-sandbox.mjs');
      return sb.runSandboxed(binResolved, binArgs, {
        ...opts,
        writableDirs,
        roDirs: [skillDir, ...roDirs],
        net: opts.net !== false,
        timeoutMs: opts.timeoutMs,
      });
    },
  };
}
