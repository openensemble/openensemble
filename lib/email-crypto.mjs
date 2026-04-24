/**
 * AES-256-GCM encrypt/decrypt for IMAP passwords.
 * Key is stored in config.json as `imapEncryptionKey` (64-char hex = 32 bytes).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { modifyConfig, loadConfig } from '../routes/_helpers.mjs';

export async function getImapKey() {
  const cfg = loadConfig();
  if (cfg.imapEncryptionKey) return Buffer.from(cfg.imapEncryptionKey, 'hex');
  const key = randomBytes(32).toString('hex');
  await modifyConfig(c => { c.imapEncryptionKey = key; });
  return Buffer.from(key, 'hex');
}

export async function encrypt(plaintext) {
  const key = await getImapKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), ciphertext: ciphertext.toString('hex') };
}

export async function decrypt({ iv, tag, ciphertext }) {
  const key = await getImapKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(Buffer.from(ciphertext, 'hex')) + decipher.final('utf8');
}
