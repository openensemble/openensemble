#!/usr/bin/env node

/**
 * Local recovery/display command for the first-run setup credential.
 * Refuses to reveal or recreate a credential after any profile exists.
 */

import fs from 'fs';
import path from 'path';
import {
  ensureFirstRunCredential,
  FirstRunBootstrapError,
  removeFirstRunCredential,
} from '../routes/_helpers/first-run-bootstrap.mjs';
import { USERS_DIR } from '../routes/_helpers/paths.mjs';

function profilesExist() {
  try {
    return fs.readdirSync(USERS_DIR, { withFileTypes: true }).some(entry =>
      entry.isDirectory()
      && !entry.name.startsWith('_')
      && fs.existsSync(path.join(USERS_DIR, entry.name, 'profile.json')),
    );
  } catch (e) {
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
}

if (profilesExist()) {
  removeFirstRunCredential();
  console.error('First-run setup is already complete; no bootstrap credential is available.');
  process.exitCode = 1;
} else {
  let state;
  try {
    state = ensureFirstRunCredential();
  } catch (e) {
    // This command is the deliberate local recovery surface. A malformed
    // credential cannot authorize anything, so replace it only while the
    // install still has no profiles.
    if (!(e instanceof FirstRunBootstrapError) || e.code !== 'unavailable') throw e;
    removeFirstRunCredential();
    state = ensureFirstRunCredential();
  }
  const { credential } = state;
  process.stdout.write(credential + '\n');
}
