// FUSE I/O runs in a disposable process. An unreachable server cannot consume
// the main server's filesystem thread pool or block unrelated OE requests.
import { listShareDirectory, readShareFile, copyShareFiles, deleteShareFiles } from './network-share-files.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { action, args } = JSON.parse(input);
  let result;
  if (action === 'list') result = await listShareDirectory(args.root, args.path, args);
  else if (action === 'read') result = await readShareFile(args.root, args.path, args);
  else if (action === 'copy') result = await copyShareFiles(args);
  else if (action === 'delete') result = await deleteShareFiles(args.root, args.paths);
  else throw new Error('Unknown share file operation.');
  process.stdout.write(JSON.stringify(result));
} catch (e) {
  const code = e.code || 'FILES';
  const error = ['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(code)
    ? 'Path is missing, inaccessible, or contains a symbolic link. Open a regular file or folder inside the share.'
    : e.code ? 'The share file operation failed.' : e.message;
  process.stdout.write(JSON.stringify({ error, code }));
}
