// @ts-check
/**
 * One-time authorization for first-run owner creation and initial restore.
 *
 * The server intentionally listens on the LAN. An empty users directory is
 * therefore not proof that the caller is the machine owner. A fresh install
 * gets a high-entropy credential in a local, mode-0600 file; the installer or
 * `oe bootstrap` presents it to the operator, and the first successful setup
 * action consumes it.
 */

import fs from 'fs';
import path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { USERS_DIR } from './paths.mjs';
import { withLock } from './io-lock.mjs';

export const FIRST_RUN_CREDENTIAL_PATH = path.join(USERS_DIR, '_system', 'first-run-bootstrap');

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export class FirstRunBootstrapError extends Error {
  /** @param {'invalid'|'unavailable'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'FirstRunBootstrapError';
    this.code = code;
  }
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

function readCredential(credentialPath) {
  let credential;
  try {
    credential = fs.readFileSync(credentialPath, 'utf8').trim();
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new FirstRunBootstrapError('unavailable', 'The local first-run credential could not be read.');
  }
  if (!TOKEN_RE.test(credential)) {
    throw new FirstRunBootstrapError('unavailable', 'The local first-run credential is invalid. Run `oe bootstrap` locally to repair it.');
  }
  return credential;
}

/**
 * Ensure a credential exists. Creation uses O_EXCL so even two server
 * processes cannot overwrite one another's credential.
 *
 * @param {{ credentialPath?: string }} [opts]
 * @returns {{ credential: string, created: boolean, path: string }}
 */
export function ensureFirstRunCredential({ credentialPath = FIRST_RUN_CREDENTIAL_PATH } = {}) {
  const existing = readCredential(credentialPath);
  if (existing) return { credential: existing, created: false, path: credentialPath };

  fs.mkdirSync(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(credentialPath), 0o700); } catch {}
  const credential = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    fs.writeFileSync(credentialPath, credential + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return { credential, created: true, path: credentialPath };
  } catch (e) {
    if (e?.code !== 'EEXIST') {
      throw new FirstRunBootstrapError('unavailable', 'The local first-run credential could not be created.');
    }
    const raced = readCredential(credentialPath);
    if (!raced) throw new FirstRunBootstrapError('unavailable', 'The local first-run credential could not be created.');
    return { credential: raced, created: false, path: credentialPath };
  }
}

/**
 * Print a newly generated credential only as an explicit local bootstrap
 * presentation. Existing credentials are never repeated into routine logs.
 */
export function announceFirstRunCredential(result, log = console.warn) {
  if (!result?.created) return;
  log([
    '',
    '[first-run] No owner profile exists. A one-time setup credential was created:',
    '',
    `  ${result.credential}`,
    '',
    'Enter it on the owner-setup or initial-restore screen.',
    `It is also available locally with \`oe bootstrap\` or in ${result.path}.`,
    '',
  ].join('\n'));
}

/**
 * Verify and serialize a first-run mutation. The credential is removed only
 * after `action` succeeds. Concurrent owner-create/restore requests therefore
 * cannot both authorize with the same credential.
 *
 * The caller must call ensureFirstRunCredential() during its initial
 * no-users preflight, before reading an untrusted request body. Keeping
 * creation outside this function prevents an already-waiting loser from
 * minting a replacement after the winner consumes the credential.
 *
 * @template T
 * @param {unknown} provided
 * @param {() => Promise<T>|T} action
 * @param {{ credentialPath?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function withFirstRunCredential(provided, action, {
  credentialPath = FIRST_RUN_CREDENTIAL_PATH,
} = {}) {
  return withLock(credentialPath, async () => {
    const expected = readCredential(credentialPath);
    const supplied = typeof provided === 'string' ? provided.trim() : '';
    if (!expected || !supplied || !timingSafeEqual(digest(supplied), digest(expected))) {
      throw new FirstRunBootstrapError(
        'invalid',
        'A valid first-run credential is required. Run `oe bootstrap` on the OpenEnsemble host to view it.',
      );
    }

    const result = await action();
    try {
      fs.unlinkSync(credentialPath);
    } catch (e) {
      // Setup already succeeded, and the presence of a user closes both
      // first-run routes. Do not turn a cleanup failure into a false failure.
      if (e?.code !== 'ENOENT') console.error('[first-run] Failed to consume bootstrap credential:', e.message);
    }
    return result;
  });
}

/** Remove a stale credential after setup; safe to call repeatedly. */
export function removeFirstRunCredential({ credentialPath = FIRST_RUN_CREDENTIAL_PATH } = {}) {
  try { fs.unlinkSync(credentialPath); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
}
