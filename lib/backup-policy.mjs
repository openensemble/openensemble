import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_MAX_BYTES = 500 * 1024 * 1024;
export const BACKUP_MAX_UNCOMPRESSED = 5 * 1024 * 1024 * 1024;
export const BACKUP_ENCRYPTION_OVERHEAD = 48;
export const BACKUP_MAX_ENTRIES = 100000;
// Bump when restore validation or inventory-comparison semantics change.
export const BACKUP_VERIFIER_VERSION = 1;
export const BACKUP_SNAPSHOT_FORMAT = 2;
export const BACKUP_DATA_FILES = ['config.json', 'config/user-providers.json', 'shared-notes.json',
  'invites.json', 'expenses/transactions.json', 'expenses/groups.json', 'expenses/books.json', 'nodes.json',
  'sharing.json', 'messages.json', 'threads.json'];
export const BACKUP_DATA_DIRS = ['users', 'shared-docs', 'tasks'];
export const BACKUP_PLUGIN_RE = /^usr_[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
export const BACKUP_CATEGORY_LABELS = {
  configuration: 'Configuration and account registries', accounts: 'User profiles, keys and files',
  shared: 'Shared documents, notes and messages', tasks: 'Tasks', expenses: 'Expenses and books',
  plugins: 'Custom drawers', training: 'Training source files',
};
export function backupCategory(relative) {
  if (relative === 'users' || relative.startsWith('users/')) return 'accounts';
  if (relative.startsWith('expenses/')) return 'expenses';
  if (relative === 'tasks' || relative.startsWith('tasks/')) return 'tasks';
  if (relative.startsWith('plugins/')) return 'plugins';
  if (relative.startsWith('training-data/')) return 'training';
  if (/^(shared-docs|shared-notes.json|sharing.json|messages.json|threads.json)(\/|$)/.test(relative)) return 'shared';
  return 'configuration';
}
const children = dir => fs.existsSync(dir) ? fs.readdirSync(dir) : [];
export function backupTrainingFiles(dir) {
  return children(dir).filter(name => /\.(jsonl|py|json)$/.test(name) || name.startsWith('Modelfile'));
}
export function backupRoots(base) {
  return [...BACKUP_DATA_FILES, ...BACKUP_DATA_DIRS,
    ...children(path.join(base, 'plugins')).filter(name => BACKUP_PLUGIN_RE.test(name)).map(name => 'plugins/' + name),
    ...backupTrainingFiles(path.join(base, 'training-data')).map(name => 'training-data/' + name)];
}
