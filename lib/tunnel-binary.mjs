/**
 * cloudflared binary discovery + on-demand fetch.
 *
 * We avoid bundling the binary in the repo (~30 MB) and avoid shelling out to
 * a package manager (the install footprint should be the same on every host).
 * Instead we look in three places, in order:
 *   1. ./bin/cloudflared  (this install's local copy — preferred)
 *   2. $PATH              (system install via apt/brew/etc.)
 *   3. fetch from GitHub releases into ./bin/cloudflared
 *
 * Mirrors lib/model-fetch.mjs's .part-temp + atomic-rename pattern so a
 * killed download never leaves a half-written executable that exec'd into
 * the wrong file would crash the supervisor.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { BASE_DIR } from './paths.mjs';

const BIN_DIR = path.join(BASE_DIR, 'bin');
const LOCAL_BIN = path.join(BIN_DIR, 'cloudflared');

// Map node's platform/arch to cloudflared release asset names.
// Source: https://github.com/cloudflare/cloudflared/releases — asset naming
// has been stable for years (cloudflared-<os>-<arch>[.<ext>]).
function assetName() {
  const platform = os.platform(); // 'linux' | 'darwin' | 'win32'
  const arch = os.arch();         // 'x64' | 'arm64' | 'arm'
  if (platform === 'linux') {
    if (arch === 'x64')   return 'cloudflared-linux-amd64';
    if (arch === 'arm64') return 'cloudflared-linux-arm64';
    if (arch === 'arm')   return 'cloudflared-linux-arm';
  }
  if (platform === 'darwin') {
    // CF ships a tarball for darwin; supporting that adds extraction logic.
    // For now, prefer the user installing via `brew install cloudflared`.
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'cloudflared-windows-amd64.exe';
  }
  return null;
}

export function findCloudflared() {
  // 1. Local install copy.
  if (fs.existsSync(LOCAL_BIN)) {
    try { fs.accessSync(LOCAL_BIN, fs.constants.X_OK); return LOCAL_BIN; }
    catch { /* fall through and try PATH */ }
  }
  // 2. System PATH.
  try {
    const which = execFileSync('which', ['cloudflared'], { encoding: 'utf8' }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch { /* not on PATH */ }
  return null;
}

export async function ensureCloudflared({ logger } = {}) {
  const log = logger ?? (() => {});
  const existing = findCloudflared();
  if (existing) return existing;

  const asset = assetName();
  if (!asset) {
    throw new Error(
      `No cloudflared download available for ${os.platform()}/${os.arch()}. ` +
      `Install it manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`
    );
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  const tmp = `${LOCAL_BIN}.part`;
  log(`[tunnel] fetching cloudflared from ${url}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching cloudflared`);

  const total = Number(res.headers.get('content-length')) || 0;
  let seen = 0;
  let lastPct = -1;
  const out = fs.createWriteStream(tmp);
  try {
    for await (const chunk of res.body) {
      out.write(chunk);
      seen += chunk.length;
      if (total) {
        const pct = Math.floor((seen / total) * 100);
        if (pct !== lastPct && pct % 25 === 0) {
          log(`[tunnel]   ${pct}% (${(seen / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)`);
          lastPct = pct;
        }
      }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, LOCAL_BIN);
  } catch (e) {
    try { out.destroy(); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }

  log(`[tunnel] cloudflared ready at ${LOCAL_BIN}`);
  return LOCAL_BIN;
}
