/**
 * lib/node-update-signing.mjs — Ed25519 signing for node-agent self-updates.
 *
 * The node agent runs as root and self-updates by downloading new code over
 * plain HTTP, which a LAN on-path attacker could tamper with. To make the
 * update trustworthy independent of the transport, the server signs a
 * versioned manifest of the agent bytes with a private key that never leaves
 * this box; the agent verifies the signature against a public key pinned into
 * its config at install/pair time (remote/oe-node-agent.mjs). An attacker who
 * can MITM the download still cannot forge a valid signature.
 *
 * Key durability: the keypair is stored envelope-encrypted under the OE master
 * key (users/_system/, same as every other secret), so it survives restart and
 * rides along in the admin backup (which tars users/). If the key were ever
 * lost or regenerated, agents fail closed — they refuse updates but keep
 * running, recoverable by re-pairing. So, like the master key, it must never be
 * casually regenerated; getKeys() throws loudly rather than minting a new one
 * over an unreadable file.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { USERS_DIR } from './paths.mjs';
import { readEncryptedJsonFile, writeEncryptedJsonFile } from './encrypted-file.mjs';

// The agent version at which signed, gated updates were introduced. Any node
// reporting a version below this is a legacy agent with no pinned key: the
// server refuses to auto-update it (it must re-pair to pin the key). Keep in
// sync with AGENT_VERSION in remote/oe-node-agent.mjs.
export const SECURE_MIN_VERSION = '2.0.0';

const KEY_PATH = path.join(USERS_DIR, '_system', 'node-update-signing.json');

let _cached = null; // { privateKeyPem, publicKeyPem, createdAt }

/** Parse "x.y.z" (ignoring any -suffix/+build) into [x,y,z]; missing → 0. */
function parseVersion(v) {
  const core = String(v ?? '').trim().split('-')[0].split('+')[0];
  const p = core.split('.');
  return [parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0, parseInt(p[2], 10) || 0];
}

/** a >= b for dotted versions. 'unknown'/'' parses as 0.0.0 (→ legacy). */
export function versionGte(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] > B[i]) return true;
    if (A[i] < B[i]) return false;
  }
  return true;
}

/** True if a reported agent version supports signed/gated updates. */
export function supportsSecureUpdates(version) {
  return versionGte(version, SECURE_MIN_VERSION);
}

/** Load the keypair, generating + persisting one on first use. Cached. */
function getKeys() {
  if (_cached) return _cached;
  if (fs.existsSync(KEY_PATH)) {
    let obj;
    try { obj = readEncryptedJsonFile(KEY_PATH); }
    catch (e) {
      // Undecryptable (e.g. master key changed) — do NOT silently overwrite;
      // that would rotate the signing key and brick every pinned agent's
      // update path. Fail loud, matching the master-key never-regenerate rule.
      throw new Error(`node update signing key unreadable at ${KEY_PATH}: ${e.message}`);
    }
    if (obj?.privateKeyPem && obj?.publicKeyPem) { _cached = obj; return _cached; }
    // File exists but is malformed — same reasoning: don't clobber blindly.
    throw new Error(`node update signing key malformed at ${KEY_PATH}`);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  _cached = {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    createdAt: Date.now(),
  };
  try { fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true }); } catch { /* dir may exist */ }
  writeEncryptedJsonFile(KEY_PATH, _cached, { mode: 0o600 });
  return _cached;
}

/** The SPKI PEM public key agents pin at install time to verify updates. */
export function getUpdatePublicKeyPem() {
  return getKeys().publicKeyPem;
}

/**
 * Sign the exact manifest STRING (not an object) so the agent verifies the
 * identical bytes with no canonicalization ambiguity. Returns base64.
 */
export function signManifestString(manifestStr) {
  const priv = crypto.createPrivateKey(getKeys().privateKeyPem);
  return crypto.sign(null, Buffer.from(manifestStr, 'utf8'), priv).toString('base64');
}
