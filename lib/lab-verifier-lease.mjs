import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const MAX_LEASE_BYTES = 4_096;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const RUN_TAG_RE = /^real_router_\d{10,}_[a-f0-9]{8}$/;

function leasePath() {
  return process.env.OE_LAB_VERIFIER_LEASE_PATH
    || path.join(process.cwd(), 'config', 'lab-verifier-lease.json');
}

/**
 * Inspect the isolated verifier lease without returning any lease contents.
 * A single no-follow file descriptor binds validation to the inode we read,
 * avoiding the exists/stat/read replacement race at the authorization edge.
 *
 * @returns {'absent'|'invalid'|'mismatch'|'active'}
 */
export function inspectLabVerifierLease(candidateToken) {
  let fd;
  try {
    fd = fs.openSync(
      leasePath(),
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'invalid';
  }

  let lease;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()
      || stat.size < 1
      || stat.size > MAX_LEASE_BYTES
      || (stat.mode & 0o7777) !== 0o600) {
      return 'invalid';
    }
    lease = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    return 'invalid';
  } finally {
    try { fs.closeSync(fd); } catch {}
  }

  const valid = lease?.version === 1
    && typeof lease?.runTag === 'string'
    && RUN_TAG_RE.test(lease.runTag)
    && typeof lease?.token === 'string'
    && TOKEN_RE.test(lease.token)
    && Number.isSafeInteger(lease?.expiresAt)
    && lease.expiresAt > Date.now();
  if (!valid) return 'invalid';
  if (typeof candidateToken !== 'string' || !TOKEN_RE.test(candidateToken)) return 'mismatch';
  return timingSafeEqual(Buffer.from(candidateToken), Buffer.from(lease.token))
    ? 'active'
    : 'mismatch';
}

/** Dispatcher-edge exclusivity/authentication with stable public errors. */
export function assertLabVerifierLease(plan, source) {
  if (process.env.OPENENSEMBLE_LAB !== '1') return false;
  const requested = source === 'lab-verifier';
  const status = inspectLabVerifierLease(plan?.leaseToken);
  if (status === 'absent') {
    if (requested) throw new Error('lab-verifier turn refused without an active exclusive verifier lease');
    return false;
  }
  if (status === 'invalid') {
    throw new Error('the lab verifier lease is invalid or expired; recreate the isolated lab');
  }
  if (!requested || status !== 'active') {
    throw new Error('the isolated lab is exclusively leased by the real-model verifier');
  }
  return true;
}

/** Detached/provider-edge assertion that never exposes secret-bearing detail. */
export function assertActiveLabVerifierLeaseToken(leaseToken) {
  if (process.env.OPENENSEMBLE_LAB === '1'
    && inspectLabVerifierLease(leaseToken) === 'active') {
    return true;
  }
  throw Object.assign(
    new Error('verifier work refused without its active exclusive lease'),
    { code: 'LAB_VERIFIER_LEASE_INVALID' },
  );
}
