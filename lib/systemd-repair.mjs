/**
 * One-shot self-repair for OE's systemd unit file.
 *
 * Existing installs that ran the pre-2026-05 install.sh shipped with
 *   Restart=on-failure
 * which doesn't fire when the server self-SIGTERMs to restart (the
 * /api/admin/restart and /api/admin/update flows). End result: the server
 * shut down but never came back. Combined with KillMode=control-group,
 * the previous detached-child respawn pattern was also unreliable.
 *
 * The fix is `Restart=always` — restarts on any exit, including the clean
 * SIGTERM-induced one. `systemctl stop` is still honored explicitly by
 * systemd.
 *
 * This module patches the unit file in place at server boot if it still
 * has the old value, then daemon-reloads systemd so the change takes
 * effect on the next restart. Does NOT trigger a restart — the user's
 * current session keeps running; the next restart they trigger uses the
 * fixed policy.
 *
 * Idempotent: no-op if the unit already has Restart=always (or any value
 * other than on-failure, in case the user customized).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from '../logger.mjs';

const UNIT_PATH = path.join(os.homedir(), '.config/systemd/user/openensemble.service');

function runQuiet(cmd, args) {
  return new Promise((resolve) => {
    let stderr = '';
    let proc;
    try { proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, stderr: e.message }); }
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ code, stderr: stderr.trim() }));
    proc.on('error', e => resolve({ code: -1, stderr: e.message }));
  });
}

export async function repairSystemdUnit() {
  // Only meaningful when running under systemd. Standalone installs don't
  // have a unit to patch.
  if (!process.env.INVOCATION_ID && !process.env.SYSTEMD_EXEC_PID) return;
  if (!fs.existsSync(UNIT_PATH)) return;

  let content;
  try { content = fs.readFileSync(UNIT_PATH, 'utf8'); }
  catch (e) { log.warn('systemd-repair', 'cannot read unit', { error: e.message }); return; }

  // Match only the old broken value. Don't touch units the user has
  // customized to anything else (e.g., `Restart=on-success` if they're
  // experimenting with different policies).
  if (!/^Restart=on-failure\s*$/m.test(content)) return;

  const patched = content.replace(/^Restart=on-failure\s*$/m, 'Restart=always');
  try { fs.writeFileSync(UNIT_PATH, patched); }
  catch (e) { log.warn('systemd-repair', 'cannot write unit', { error: e.message }); return; }

  // daemon-reload so the change takes effect on the next restart. We do
  // NOT trigger a restart — the user's current session keeps running.
  const r = await runQuiet('systemctl', ['--user', 'daemon-reload']);
  if (r.code === 0) {
    log.info('systemd-repair', `patched ${UNIT_PATH}: Restart=on-failure → Restart=always (takes effect on next restart)`);
  } else {
    log.warn('systemd-repair', 'unit patched on disk but daemon-reload failed', { stderr: r.stderr });
  }
}
