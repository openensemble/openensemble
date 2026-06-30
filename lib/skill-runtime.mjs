// @ts-check
/**
 * Skill runtime provisioning — download an external binary INTO the skill's own
 * directory (<skillDir>/bin/<name>) so the skill owns it and nothing outside can
 * brick it. Pure download/verify/chmod; the CONSENT gate + the bwrap sandbox at
 * run time live in roles.mjs (ctx.ensureRuntime / ctx.runSandboxed) and
 * lib/skill-sandbox.mjs respectively.
 *
 * No allowlist by design: a user can want any tool. Safety is consent (the user
 * approves the exact URL) + containment (the binary runs sandboxed). See
 * project_trace_honesty_tool_errors / project_skill_multitenant_isolation_todo.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/** Resolve a skill-owned binary path (under <skillDir>/bin), or null if absent. */
export function resolveSkillBinary(skillDir, name) {
  if (!skillDir || !name) return null;
  const p = path.join(skillDir, 'bin', name);
  try { return fs.existsSync(p) ? p : null; } catch { return null; }
}

async function sha256File(p) {
  return crypto.createHash('sha256').update(await fsp.readFile(p)).digest('hex');
}

/**
 * Download `url` -> <skillDir>/bin/<name>, verify optional sha256, chmod +x.
 * Idempotent: if present (and matching sha256 when given) it's a no-op. The
 * caller is responsible for obtaining user consent BEFORE calling this.
 * @param {{ skillDir: string, name: string, url: string, sha256?: string }} opts
 * @returns {Promise<string>} absolute binary path
 */
export async function provisionBinary({ skillDir, name, url, sha256 } = /** @type {any} */ ({})) {
  if (!skillDir) throw new Error('provisionBinary: skillDir required');
  if (!name || /[\/\\]/.test(name) || name.startsWith('.')) throw new Error('provisionBinary: invalid binary name');
  if (!/^https:\/\//i.test(String(url || ''))) throw new Error('provisionBinary: url must be https://');

  const binDir = path.join(skillDir, 'bin');
  const binPath = path.join(binDir, name);

  if (fs.existsSync(binPath)) {
    if (!sha256) return binPath;                       // already provisioned
    if ((await sha256File(binPath)).toLowerCase() === String(sha256).toLowerCase()) return binPath;
    // checksum drifted → fall through and re-download
  }

  await fsp.mkdir(binDir, { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('download failed: empty body');
  if (sha256) {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got.toLowerCase() !== String(sha256).toLowerCase()) {
      throw new Error(`checksum mismatch for ${name}: expected ${sha256}, got ${got}`);
    }
  }
  const tmp = `${binPath}.download`;
  await fsp.writeFile(tmp, buf, { mode: 0o755 });
  await fsp.rename(tmp, binPath);
  await fsp.chmod(binPath, 0o755);
  return binPath;
}
