// @ts-check
/**
 * Opaque, exact preference grants for unreviewed custom skills.
 *
 * A manifest's self-authored keywords are discovery hints, not permission to
 * read the user's global profile. A grant is created only for the exact
 * preference/contract the user approved (or a reviewed safe activation
 * committed), contains no preference prose, and is revoked with that monitor.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR, SKILLS_DIR, userSkillsDir } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';
import {
  captureSkillIntegrity,
  materializeSkillCodeSnapshot,
} from './skill-code-integrity.mjs';

const USER_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SKILL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEMORY_RE = /^[A-Za-z0-9_-]{3,160}$/;
const WATCHER_RE = /^[A-Za-z0-9_-]{3,160}$/;
const FINGERPRINT_RE = /^[a-f0-9]{16,64}$/;
const MAX_GRANTS = 300;

function filePath(userId) {
  return path.join(USERS_DIR, userId, 'personalization', 'skill-preference-grants.json');
}

function requireInputs(userId, skillId = null, memoryId = null, fingerprint = null) {
  if (!USER_RE.test(String(userId || ''))) throw new Error('invalid preference grant user');
  if (skillId != null && !SKILL_RE.test(String(skillId))) throw new Error('invalid preference grant skill');
  if (memoryId != null && !MEMORY_RE.test(String(memoryId))) throw new Error('invalid preference grant memory');
  if (fingerprint != null && !FINGERPRINT_RE.test(String(fingerprint))) throw new Error('invalid preference grant contract');
}

export function currentSkillGrantIdentity(userId, manifest) {
  try {
    const dir = manifest?.userScope === userId
      ? path.join(userSkillsDir(userId), manifest.id)
      : path.join(SKILLS_DIR, manifest?.id || '');
    const identity = captureSkillIntegrity(dir, manifest);
    return {
      // Kept as executorDigest in the durable grant schema for compatibility;
      // this now identifies execute.mjs plus its complete local ESM closure.
      executorDigest: identity.executorDigest,
      manifestDigest: identity.manifestDigest,
    };
  } catch { return null; }
}

export function materializeGrantedSkillSnapshot(userId, manifest, expectedIdentity) {
  const dir = manifest?.userScope === userId
    ? path.join(userSkillsDir(userId), manifest.id)
    : path.join(SKILLS_DIR, manifest?.id || '');
  return materializeSkillCodeSnapshot(dir, manifest, expectedIdentity);
}

function readFile(userId) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath(userId), 'utf8'));
    if (!value || typeof value !== 'object' || !Number.isInteger(value.version)
      || !Array.isArray(value.grants) || value.grants.length > MAX_GRANTS) {
      throw new Error('invalid grant envelope');
    }
    const grants = value.grants.map(grant => {
      requireInputs(userId, grant?.skillId, grant?.preferenceMemoryId, grant?.contractFingerprint);
      if (typeof grant.executorDigest !== 'string' || !/^[a-f0-9]{64}$/.test(grant.executorDigest)) {
        throw new Error('invalid grant executor digest');
      }
      if (typeof grant.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(grant.manifestDigest)) {
        throw new Error('invalid grant manifest digest');
      }
      if (typeof grant.watcherId !== 'string' || !WATCHER_RE.test(grant.watcherId)) {
        throw new Error('invalid grant watcher id');
      }
      if (typeof grant.createdAt !== 'string' || !Number.isFinite(Date.parse(grant.createdAt))) {
        throw new Error('invalid grant timestamp');
      }
      return {
        skillId: grant.skillId,
        preferenceMemoryId: grant.preferenceMemoryId,
        contractFingerprint: grant.contractFingerprint,
        executorDigest: grant.executorDigest,
        manifestDigest: grant.manifestDigest,
        watcherId: grant.watcherId,
        createdAt: new Date(Date.parse(grant.createdAt)).toISOString(),
      };
    });
    return { version: value.version, grants };
  } catch (e) {
    if (e?.code === 'ENOENT') return { version: 0, grants: [] };
    throw new Error(`Preference grants are unreadable: ${e?.message || e}`);
  }
}

function writeFile(userId, value) {
  const dir = path.dirname(filePath(userId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  atomicWriteSync(filePath(userId), JSON.stringify({
    version: value.version + 1,
    updated_at: Date.now(),
    grants: value.grants.slice(-MAX_GRANTS),
  }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(filePath(userId), 0o600); } catch {}
}

export async function grantSkillPreference(userId, {
  skillId, preferenceMemoryId, contractFingerprint, executorDigest, manifestDigest, watcherId,
}) {
  requireInputs(userId, skillId, preferenceMemoryId, contractFingerprint);
  if (typeof executorDigest !== 'string' || !/^[a-f0-9]{64}$/.test(executorDigest)) {
    throw new Error('invalid preference grant executor digest');
  }
  if (typeof manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(manifestDigest)) {
    throw new Error('invalid preference grant manifest digest');
  }
  if (typeof watcherId !== 'string' || !WATCHER_RE.test(watcherId)) {
    throw new Error('invalid preference grant watcher id');
  }
  return withLock(filePath(userId), () => {
    const value = readFile(userId);
    const existing = value.grants.find(grant => grant.skillId === skillId
      && grant.preferenceMemoryId === preferenceMemoryId
      && grant.contractFingerprint === contractFingerprint
      && grant.executorDigest === executorDigest
      && grant.manifestDigest === manifestDigest
      && grant.watcherId === watcherId);
    if (existing) return { ok: true, created: false, ...existing };
    if (value.grants.length >= MAX_GRANTS) {
      throw new Error('preference grant store is full; no active grant was evicted');
    }
    const grant = {
      skillId, preferenceMemoryId, contractFingerprint, executorDigest, manifestDigest, watcherId,
      createdAt: new Date().toISOString(),
    };
    value.grants.push(grant);
    writeFile(userId, value);
    return { ok: true, created: true, ...grant };
  });
}

export async function revokeSkillPreferenceGrant(userId, {
  skillId, preferenceMemoryId = null, contractFingerprint,
}) {
  requireInputs(userId, skillId, preferenceMemoryId, contractFingerprint);
  return withLock(filePath(userId), () => {
    const value = readFile(userId);
    const before = value.grants.length;
    value.grants = value.grants.filter(grant => !(grant.skillId === skillId
      && grant.contractFingerprint === contractFingerprint
      && (preferenceMemoryId == null || grant.preferenceMemoryId === preferenceMemoryId)));
    if (value.grants.length !== before) writeFile(userId, value);
    return before - value.grants.length;
  });
}

export async function revokePreferenceGrants(userId, preferenceMemoryId) {
  requireInputs(userId, null, preferenceMemoryId, null);
  return withLock(filePath(userId), () => {
    const value = readFile(userId);
    const before = value.grants.length;
    value.grants = value.grants.filter(grant => grant.preferenceMemoryId !== preferenceMemoryId);
    if (value.grants.length !== before) writeFile(userId, value);
    return before - value.grants.length;
  });
}

export async function grantedPreferenceIdsForSkill(userId, skillId) {
  requireInputs(userId, skillId, null, null);
  const value = readFile(userId);
  return new Set(value.grants
    .filter(grant => grant.skillId === skillId)
    .map(grant => grant.preferenceMemoryId));
}

export async function grantedPreferenceGrantsForSkill(userId, skillId) {
  requireInputs(userId, skillId, null, null);
  return readFile(userId).grants
    .filter(grant => grant.skillId === skillId)
    .map(grant => ({ ...grant }));
}
