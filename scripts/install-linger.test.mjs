import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installerPath = join(repoRoot, 'install.sh');
const helperPath = join(repoRoot, 'scripts', 'ensure-user-linger.sh');
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture({ initialState = 'no', enableChangesState = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oe-linger-test-'));
  tempDirs.push(dir);
  const binDir = join(dir, 'bin');
  const stateFile = join(dir, 'linger-state');
  const logFile = join(dir, 'calls.log');
  mkdirSync(binDir);
  writeFileSync(stateFile, `${initialState}\n`);
  writeFileSync(logFile, '');

  writeFileSync(join(binDir, 'id'), `#!/bin/bash
if [[ "\${1:-}" == "-un" ]]; then echo test-user; else exec /usr/bin/id "$@"; fi
`);
  writeFileSync(join(binDir, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\\n' "$*" >> "$OE_TEST_LOG"
case "\${1:-}" in
  show-user) cat "$OE_TEST_STATE" ;;
  enable-linger)
    if [[ "$OE_TEST_ENABLE_CHANGES_STATE" == "true" ]]; then printf 'yes\\n' > "$OE_TEST_STATE"; fi
    ;;
  *) exit 2 ;;
esac
`);
  writeFileSync(join(binDir, 'sudo'), `#!/bin/bash
printf 'sudo %s\\n' "$*" >> "$OE_TEST_LOG"
exec "$@"
`);
  chmodSync(join(binDir, 'id'), 0o755);
  chmodSync(join(binDir, 'loginctl'), 0o755);
  chmodSync(join(binDir, 'sudo'), 0o755);

  return {
    stateFile,
    logFile,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      OE_TEST_STATE: stateFile,
      OE_TEST_LOG: logFile,
      OE_TEST_ENABLE_CHANGES_STATE: String(enableChangesState),
    },
  };
}

describe('systemd user lingering install', () => {
  it('checks lingering before treating a reachable user manager as ready', () => {
    const source = readFileSync(installerPath, 'utf8');
    const serviceBlock = source.slice(source.indexOf('# ─── Systemd Service'));
    const initialState = serviceBlock.indexOf('HAVE_SERVICE=false');
    const serviceBranch = serviceBlock.indexOf('if [[ "$INSTALL_SERVICE" == "true" ]]');
    const ensureLinger = serviceBlock.indexOf('bash "$INSTALL_DIR/scripts/ensure-user-linger.sh" "$INSTALL_USER"');
    const readinessBranch = serviceBlock.indexOf('if ! user_manager_ready; then');

    expect(initialState).toBeGreaterThan(-1);
    expect(serviceBranch).toBeGreaterThan(initialState);
    expect(ensureLinger).toBeGreaterThan(-1);
    expect(readinessBranch).toBeGreaterThan(ensureLinger);
  });

  it('enables disabled lingering and verifies the resulting state', () => {
    const fixture = makeFixture();
    const result = spawnSync('bash', [helperPath], { env: fixture.env, encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.stateFile, 'utf8').trim()).toBe('yes');
    const calls = readFileSync(fixture.logFile, 'utf8');
    expect(calls).toContain('enable-linger test-user');
    expect(calls.match(/show-user test-user/g)).toHaveLength(2);
  });

  it('accepts already-enabled lingering without trying to elevate', () => {
    const fixture = makeFixture({ initialState: 'yes' });
    const result = spawnSync('bash', [helperPath], { env: fixture.env, encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(fixture.logFile, 'utf8');
    expect(calls).not.toContain('enable-linger');
    expect(calls).not.toContain('sudo');
  });

  it('fails when enable-linger succeeds but Linger remains disabled', () => {
    const fixture = makeFixture({ enableChangesState: false });
    const result = spawnSync('bash', [helperPath], { env: fixture.env, encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Lingering is still disabled');
  });
});
