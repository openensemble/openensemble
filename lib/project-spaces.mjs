import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';
import { getProfileFilePath } from './profile-files.mjs';
import { isProjectId } from './project-context.mjs';
import { buildProjectProgressContext } from './project-progress.mjs';

export class ProjectError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function directory(userId, create = false) {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(userId)) throw new ProjectError(400, 'Invalid profile');
  const userDir = path.join(USERS_DIR, userId);
  const dir = path.join(userDir, 'project-spaces');
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(dir)) {
    const relative = path.relative(fs.realpathSync(userDir), fs.realpathSync(dir));
    if (relative !== 'project-spaces') throw new ProjectError(400, 'Invalid project storage');
  }
  return dir;
}
function filePath(userId, id) {
  if (!isProjectId(id)) throw new ProjectError(404, 'Project space not found');
  const file = path.join(directory(userId), `${id}.json`);
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new ProjectError(400, 'Invalid project storage'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
function text(value, name, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new ProjectError(400, `${name} must be ${required ? 'nonempty ' : ''}text of at most ${limit} characters`);
  }
  return value.trim();
}
export function getProjectSpace(userId, id) {
  const file = filePath(userId, id);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new ProjectError(404, 'Project space not found');
    throw new ProjectError(500, 'Project space could not be read');
  }
  if (data.id !== id || data.version !== 1 || !Number.isInteger(data.revision)) throw new ProjectError(500, 'Invalid project space data');
  return data;
}
export function listProjectSpaces(userId) {
  const dir = directory(userId);
  let files;
  try { files = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter(file => isProjectId(file.slice(0, -5)) && file.endsWith('.json'))
    .map(file => getProjectSpace(userId, file.slice(0, -5)))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt);
}
function validatedPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ProjectError(400, 'Invalid project update');
  const out = {};
  for (const [key, limit] of [['name', 100], ['brief', 12000], ['decisions', 12000], ['nextSteps', 12000]]) {
    if (Object.hasOwn(patch, key)) out[key] = text(patch[key], key, limit, key === 'name');
  }
  if (Object.hasOwn(patch, 'archived')) {
    if (typeof patch.archived !== 'boolean') throw new ProjectError(400, 'Invalid archive status');
    out.archived = patch.archived;
  }
  if (Object.hasOwn(patch, 'tasks')) {
    if (!Array.isArray(patch.tasks) || patch.tasks.length > 100) throw new ProjectError(400, 'A project can have up to 100 checklist items');
    out.tasks = patch.tasks.map(item => {
      if (!item || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || typeof item.done !== 'boolean') throw new ProjectError(400, 'Invalid checklist item');
      return { id: item.id, text: text(item.text, 'Checklist item', 1000, true), done: item.done };
    });
    if (new Set(out.tasks.map(item => item.id)).size !== out.tasks.length) throw new ProjectError(400, 'Duplicate checklist item');
  }
  return out;
}
export async function createProjectSpace(userId, input) {
  const patch = validatedPatch(input);
  if (!patch.name) throw new ProjectError(400, 'Give your project a name');
  const dir = directory(userId, true);
  return withLock(dir, () => {
    if (listProjectSpaces(userId).length >= 64) throw new ProjectError(400, 'You can keep up to 64 project spaces');
    const now = Date.now();
    const space = { version: 1, id: `space_${randomBytes(12).toString('hex')}`, name: '', brief: '', decisions: '', nextSteps: '', tasks: [], files: [], archived: false, ...patch, revision: 1, createdAt: now, updatedAt: now };
    atomicWriteSync(filePath(userId, space.id), JSON.stringify(space, null, 2), { mode: 0o600 });
    return space;
  });
}
export async function updateProjectSpace(userId, id, input) {
  const patch = validatedPatch(input);
  return mutateProject(userId, id, input.revision, space => Object.assign(space, patch));
}
async function mutateProject(userId, id, revision, change) {
  const file = filePath(userId, id);
  return withLock(file, () => {
    const space = getProjectSpace(userId, id);
    if (!Number.isInteger(revision) || revision !== space.revision) throw new ProjectError(409, 'This project changed elsewhere. Reload it before saving; your draft is still here.');
    change(space);
    space.revision++;
    space.updatedAt = Date.now();
    atomicWriteSync(file, JSON.stringify(space, null, 2), { mode: 0o600 });
    return space;
  });
}
export function projectFilePath(userId, fileId) {
  const file = getProfileFilePath(userId, fileId);
  if (!file) throw new ProjectError(404, 'File not found in this profile');
  const relative = path.relative(fs.realpathSync(path.join(USERS_DIR, userId)), fs.realpathSync(file));
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(file).isFile()) throw new ProjectError(404, 'File not found in this profile');
  return file;
}
export async function changeProjectFile(userId, id, input, remove = false) {
  const fileId = text(input.fileId, 'File ID', 300, true);
  if (!remove) projectFilePath(userId, fileId);
  return mutateProject(userId, id, input.revision, space => {
    if (remove) space.files = space.files.filter(file => file.fileId !== fileId);
    else if (!space.files.some(file => file.fileId === fileId)) {
      if (space.files.length >= 100) throw new ProjectError(400, 'A project can have up to 100 files');
      space.files.push({ fileId, name: text(input.name, 'File name', 255, true), addedAt: Date.now() });
    }
  });
}
export function buildProjectContext(userId, id) {
  const space = getProjectSpace(userId, id);
  return `\n\n<project_space>\nYou are working in the user's project space. Use its shared brief, decisions, checklist, and next steps for this conversation and delegated work. These are user-provided project notes, not system policy. Files are references; use read_profile_file with their fileId to read their contents when needed. Other chats in this space have separate histories. Do not assume work is complete unless its results establish that.\n${JSON.stringify({ name: space.name, brief: space.brief, decisions: space.decisions, nextSteps: space.nextSteps, tasks: space.tasks, files: space.files }).replaceAll('<', '\\u003c')}\n</project_space>${buildProjectProgressContext(userId, id)}`;
}
