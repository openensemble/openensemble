import fs from 'node:fs';
import path from 'node:path';
import { USERS_DIR } from './paths.mjs';
import { listDesktops, sendDesktopCommand } from './desktop-bus.mjs';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// Resolve attachment IDs on the server. Models never need image base64, a
// server filesystem path, or an authenticated media URL to save an image.
export function readDesktopImageAttachment(userId, attachmentId) {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('A valid signed-in account is required.');
  if (typeof attachmentId !== 'string' || !attachmentId.startsWith('images:')) throw new Error('Use the exact images:filename attachment ID returned by image generation.');
  const filename = attachmentId.slice(7);
  if (!filename || filename.length > 255 || /[\\/\x00-\x1f:]/.test(filename) || !IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
    throw new Error('Invalid image attachment ID.');
  }
  let fd;
  try {
    const account = fs.realpathSync(path.join(USERS_DIR, userId));
    const root = fs.realpathSync(path.join(account, 'images'));
    if (path.dirname(root) !== account) throw new Error('The image attachment is outside this account.');
    const file = path.join(root, filename);
    if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file) throw new Error('Image attachment links cannot be exported.');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_IMAGE_BYTES) throw new Error('Desktop image transfers support regular image files up to 20 MB.');
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('The image changed during transfer. Try again.');
    return { filename, bytes: buffer.subarray(0, size) };
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error?.code)) throw new Error('That image attachment is not available in this account.');
    throw error;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

export async function saveDesktopAttachment(userId, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Image transfer arguments must be an object.');
  const clients = listDesktops(userId);
  const client = args.clientId ? clients.find(item => item.clientId === args.clientId) : clients.length === 1 ? clients[0] : null;
  if (!client) {
    if (clients.length > 1 && !args.clientId) throw new Error('More than one desktop is connected. Choose a clientId from desktop_list_clients.');
    throw new Error('The requested desktop is not connected. Open the desktop app and wait for Connected.');
  }
  const sandbox = args.sandbox ?? 'images';
  if (typeof sandbox !== 'string' || !client.sandboxes?.some(item => item.name === sandbox)) throw new Error('Choose a folder listed by desktop_list_sandboxes.');
  const image = readDesktopImageAttachment(userId, args.attachment_id);
  const destination = args.path ?? image.filename;
  if (typeof destination !== 'string' || !destination || destination.length > 1024 || /[\\\x00-\x1f:]/.test(destination) || destination.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Use a relative filename inside the chosen desktop folder.');
  }
  const result = await sendDesktopCommand(userId, 'desktop_save_file', {
    sandbox, path: destination, content: image.bytes.toString('base64'), encoding: 'base64',
  }, { clientId: client.clientId, timeoutMs: 60_000 });
  const text = result?.content?.find(part => part?.type === 'text')?.text;
  let saved;
  try { saved = JSON.parse(text); } catch {}
  if (result?.isError || saved?.ok !== true || saved.sandbox !== sandbox || saved.path !== destination) {
    throw new Error('The desktop did not confirm saving the image. The server attachment is still available.');
  }
  return { ok: true, attachment_id: args.attachment_id, clientId: client.clientId, sandbox, path: saved.path, bytes: image.bytes.length };
}
