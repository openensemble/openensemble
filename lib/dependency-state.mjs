import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const DEFAULT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEPENDENCY_INPUTS = ['package.json', 'package-lock.json'];

export function dependencyFingerprint(root = DEFAULT_ROOT) {
  const hash = createHash('sha256');
  hash.update('openensemble-dependencies-v1\0');
  for (const name of DEPENDENCY_INPUTS) {
    hash.update(name);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(path.join(root, name)));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function readDependencyStatus(root = DEFAULT_ROOT) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'dep-status.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function writeDependencyStatus(status, root = DEFAULT_ROOT) {
  fs.writeFileSync(
    path.join(root, 'dep-status.json'),
    `${JSON.stringify(status, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function recordInstalledDependencyState(extra = {}, root = DEFAULT_ROOT) {
  const now = new Date().toISOString();
  const status = {
    ...extra,
    ok: true,
    dependencyFingerprint: dependencyFingerprint(root),
    installedAt: extra.installedAt || now,
  };
  writeDependencyStatus(status, root);
  return status;
}

export function markDependencyStateUncertain(extra = {}, root = DEFAULT_ROOT) {
  const previous = readDependencyStatus(root) || {};
  const status = {
    ...previous,
    ...extra,
    ok: false,
    failedAt: extra.failedAt || new Date().toISOString(),
  };
  writeDependencyStatus(status, root);
  return status;
}
