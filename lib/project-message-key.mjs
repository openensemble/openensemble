import { createHash } from 'node:crypto';

export const projectMessageKey = row => createHash('sha256').update(JSON.stringify([row.role, row.ts, row.turnId || null, row.content || '', row.documentArtifact || null, row.image?.filename || null])).digest('hex').slice(0, 32);

// Describe persisted replies at the client boundary without changing session
// storage. Clients pass this opaque key back to save-result; no text guessing.
export function projectMessagesForClient(rows, projectId) {
  if (!projectId) return rows;
  return rows.map(row => !row.hidden && row.role === 'assistant' && typeof row.content === 'string' && row.content.trim()
    ? { ...row, projectMessageKey: projectMessageKey(row) } : row);
}
