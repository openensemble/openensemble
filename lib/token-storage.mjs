/**
 * Resolve a profile's token_storage reference to the actual token value.
 *
 * Supported reference forms (matches what profiles declare):
 *   'config_field:<key>'  → users/<uid>/profile.json[<key>], else config.json[<key>]
 *   'env:<NAME>'          → process.env[NAME]
 *
 * Returns null when not found. Used by the profiles skill, the health-monitor
 * ctxResolver, and anywhere else profile-driven HTTP calls need auth.
 */

import fs from 'fs';
import path from 'path';
import { readConfig, USERS_DIR } from './paths.mjs';

export function resolveTokenStorage(userId, storageRef) {
  if (!storageRef) return null;
  const colon = String(storageRef).indexOf(':');
  if (colon < 0) return null;
  const scheme = storageRef.slice(0, colon);
  const rest = storageRef.slice(colon + 1);

  if (scheme === 'env') {
    return process.env[rest] || null;
  }
  if (scheme === 'config_field') {
    const userProfile = path.join(USERS_DIR, userId, 'profile.json');
    try {
      if (fs.existsSync(userProfile)) {
        const obj = JSON.parse(fs.readFileSync(userProfile, 'utf8'));
        if (obj && obj[rest] !== undefined) return obj[rest];
      }
    } catch {}
    const cfg = readConfig();
    return cfg[rest] ?? null;
  }
  return null;
}

/**
 * Build a (storageRef) → string resolver bound to a userId.
 * Useful as the `resolveAuth` callback in capability-dispatcher's ctx.
 */
export function makeAuthResolver(userId) {
  return (storageRef) => resolveTokenStorage(userId, storageRef);
}
