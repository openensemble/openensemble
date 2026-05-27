/**
 * routes/integrations.mjs — Settings-UI control plane for oe-admin integrations
 * (Tailscale today; more recipes can be wired here as they ship).
 *
 * This is a non-LLM trigger for the same install/revert path the oe-admin skill
 * uses. The Settings panel collects credentials in its own form and posts them
 * inline; the recipe runner enforces the same audit + snapshot + revert
 * pipeline as if the coordinator had called install_integration itself.
 *
 * Admin/owner only on every mutation. Status read is open to any authed user
 * (it only exposes "is Tailscale up on this host"-shaped info — same risk
 * surface as `tailscale status` from a terminal).
 */

import { spawn } from 'child_process';
import {
  requireAuth, isPrivileged, readBody,
} from './_helpers.mjs';
import { getStatus as getTailscaleStatus } from '../lib/tailscale.mjs';
import { runRecipeWithCredentials } from '../skills/oe-admin/execute.mjs';
import { listAudit, revertEntry } from '../lib/oe-admin-audit.mjs';

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
  return true;
}

export async function handle(req, res) {
  // ── GET /api/integrations/tailscale/status ────────────────────────────────
  if (req.url === '/api/integrations/tailscale/status' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const s = await getTailscaleStatus();
    // Non-privileged users get the same shape; the data isn't sensitive.
    return json(res, s);
  }

  // Everything below mutates the host — admin/owner only.
  if (!req.url?.startsWith('/api/integrations/')) return false;

  if (req.method === 'POST' && req.url === '/api/integrations/tailscale/install') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!isPrivileged(userId)) return json(res, { error: 'Owner or admin only' }, 403);

    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch { return json(res, { error: 'Invalid JSON' }, 400); }

    const authkey      = typeof body.authkey === 'string' ? body.authkey.trim() : '';
    const sudoPassword = typeof body.sudoPassword === 'string' ? body.sudoPassword : '';
    if (!authkey) return json(res, { error: 'authkey is required' }, 400);

    try {
      const result = await runRecipeWithCredentials('tailscale', userId, {
        credValues: { tailscale_authkey: authkey },
        sudoPassword: sudoPassword || null,
      });
      return json(res, result, result.ok ? 200 : 400);
    } catch (e) {
      return json(res, { ok: false, status: 'error', message: e.message }, 500);
    }
  }

  if (req.method === 'POST' && req.url === '/api/integrations/tailscale/uninstall') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!isPrivileged(userId)) return json(res, { error: 'Owner or admin only' }, 403);

    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch { return json(res, { error: 'Invalid JSON' }, 400); }
    const sudoPassword = typeof body.sudoPassword === 'string' ? body.sudoPassword : '';

    // Find the most recent committed install_integration entry for tailscale.
    // We deliberately walk back through a wider window because old installs
    // followed by other audit churn (provider adds, config flips) can push the
    // install entry past the default limit.
    const entries = listAudit({ limit: 200 });
    const target = entries.find(e =>
      e.op === 'install_integration' &&
      e.args?.recipeName === 'tailscale' &&
      e.status === 'committed'
    );
    if (!target) return json(res, { error: 'No committed tailscale install audit entry to revert.' }, 404);

    const needsRoot = (target.inverse?.rollbackSteps ?? []).some(s => s.requiresRoot);
    if (needsRoot && process.getuid && process.getuid() !== 0 && !sudoPassword) {
      return json(res, { error: 'sudo password required for rollback steps.' }, 400);
    }

    async function commandRunner(step) {
      const child = step.requiresRoot && sudoPassword
        ? spawn('sudo', ['-S', '-p', '', ...step.cmd], { timeout: step.timeoutMs ?? 60_000 })
        : spawn(step.cmd[0], step.cmd.slice(1), { timeout: step.timeoutMs ?? 60_000 });
      if (step.requiresRoot && sudoPassword) {
        child.stdin.write(sudoPassword + '\n');
        child.stdin.end();
      }
      return new Promise(resolve => child.on('exit', code => resolve(code ?? -1)));
    }

    try {
      await revertEntry(target.id, { reason: 'settings_ui_uninstall', commandRunner });
      return json(res, { ok: true, entryId: target.id });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  return false;
}
