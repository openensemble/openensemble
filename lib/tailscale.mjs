// @ts-check
/**
 * Tailscale status probe.
 *
 * Cheap read-only inspection used by the Settings UI to display
 * installed/running state + the current tailnet IP. Never mutates anything —
 * install/uninstall go through the oe-admin recipe runner instead so they get
 * the same audit + revert pipeline as any other install_integration call.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { loadConfig } from '../routes/_helpers.mjs';

const STATUS_TIMEOUT_MS = 3000;

function spawnCapture(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(cmd, args, { timeout: timeoutMs }); }
    catch { resolve({ code: -1, stdout: '', stderr: '' }); return; }
    let out = '', err = '';
    child.stdout?.on('data', d => { out += d.toString(); });
    child.stderr?.on('data', d => { err += d.toString(); });
    child.on('exit', code => resolve({ code: code ?? -1, stdout: out, stderr: err }));
    child.on('error', () => resolve({ code: -1, stdout: out, stderr: err }));
  });
}

/**
 * Returns:
 *   {
 *     binaryPresent: boolean,   // `tailscale` resolvable in PATH
 *     running:       boolean,   // tailscaled reachable AND backend state == 'Running'
 *     ip:            string|null,
 *     hostname:      string|null,
 *     tailnet:       string|null,
 *     state:         string|null,   // raw BackendState e.g. 'Running','NeedsLogin','Stopped'
 *     configFlag:    boolean,   // config.json:integrations.tailscale.installed
 *   }
 */
export async function getStatus() {
  const cfg = loadConfig();
  const configFlag = !!cfg?.integrations?.tailscale?.installed;

  // First: is the binary on PATH? `command -v` is portable and cheap.
  const which = await spawnCapture('sh', ['-c', 'command -v tailscale'], 1500);
  const binaryPresent = which.code === 0 && which.stdout.trim().length > 0;
  if (!binaryPresent) {
    return {
      binaryPresent: false, running: false, ip: null, hostname: null,
      tailnet: null, state: null, configFlag,
    };
  }

  // Status JSON includes Self.TailscaleIPs, Self.HostName, MagicDNSSuffix,
  // BackendState. Non-zero exit when daemon is down or not logged in — the
  // JSON usually still parses (older clients exit 0 with "NeedsLogin"), so
  // try parsing regardless of exit code.
  const status = await spawnCapture('tailscale', ['status', '--json'], STATUS_TIMEOUT_MS);
  let parsed = null;
  try { parsed = JSON.parse(status.stdout); } catch {}
  if (!parsed || typeof parsed !== 'object') {
    return {
      binaryPresent: true, running: false, ip: null, hostname: null,
      tailnet: null, state: null, configFlag,
    };
  }
  const state = typeof parsed.BackendState === 'string' ? parsed.BackendState : null;
  const self = parsed.Self ?? {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  // Prefer the IPv4 address (xxx.xxx.xxx.xxx) — friendlier to display + paste.
  const ip = ips.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? ips[0] ?? null;
  return {
    binaryPresent: true,
    running:       state === 'Running',
    ip:            ip || null,
    hostname:      typeof self.HostName === 'string' ? self.HostName : null,
    tailnet:       typeof parsed.MagicDNSSuffix === 'string' ? parsed.MagicDNSSuffix : null,
    state,
    configFlag,
  };
}
