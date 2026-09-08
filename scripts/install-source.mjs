#!/usr/bin/env node
/** Copy application files without copying or deleting untracked runtime state. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function gitFiles(root, extra = []) {
  const result = spawnSync('git', ['-c', 'core.excludesFile=/dev/null', ...extra,
    '-C', root, 'ls-files', '-z', ...(extra.length ? ['--others', '--exclude-standard'] : [])],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Cannot list installation files');
  return result.stdout.split('\0').filter(Boolean);
}

export function copyInstallSource(source, destination) {
  source = fs.realpathSync(source);
  fs.mkdirSync(destination, { recursive: true });
  destination = fs.realpathSync(destination);
  if (source === destination) return;
  if (destination.startsWith(source + path.sep) || source.startsWith(destination + path.sep)) {
    throw new Error('Source and installation directories must not contain one another.');
  }
  let temporaryIndex;
  try {
    const sourceGit = path.join(source, '.git');
    const hasGit = fs.existsSync(sourceGit);
    if (hasGit && !fs.statSync(sourceGit).isDirectory()) {
      throw new Error('Install from a standalone git clone, not a linked worktree.');
    }
    let files;
    if (hasGit) files = gitFiles(source);
    else {
      // Release archives have no index. A temporary bare repository lets Git
      // interpret the shipped .gitignore, including anchored rules/negations.
      temporaryIndex = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-install-index-'));
      const init = spawnSync('git', ['init', '--bare', temporaryIndex], { encoding: 'utf8' });
      if (init.status !== 0) throw new Error(init.stderr || 'Cannot create temporary installation index');
      files = gitFiles(source, ['--git-dir=' + temporaryIndex, '--work-tree=' + source]);
    }
    for (const rel of files) {
      if (path.isAbsolute(rel) || rel.split('/').includes('..') || rel === '.git' || rel.startsWith('.git/')) {
        throw new Error('Unsafe application path: ' + rel);
      }
      const input = path.join(source, rel);
      const output = path.join(destination, rel);
      if (!fs.existsSync(input)) continue; // locally removed tracked source
      // Never follow a destination link into runtime or external storage.
      let parent = path.dirname(output);
      while (parent !== destination) {
        if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) {
          throw new Error('Application destination contains a symlink: ' + rel);
        }
        parent = path.dirname(parent);
      }
      fs.mkdirSync(path.dirname(output), { recursive: true });
      if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) fs.unlinkSync(output);
      fs.cpSync(input, output, { dereference: false, verbatimSymlinks: true });
    }
    // Preserve clone metadata for the normal update flow. Runtime files are
    // outside .git, and no broad --delete or plugin cleanup runs here.
    if (hasGit) {
      const targetGit = path.join(destination, '.git');
      if (fs.existsSync(targetGit) && !fs.lstatSync(targetGit).isDirectory()) {
        throw new Error('Installation destination is a linked worktree.');
      }
      fs.cpSync(sourceGit, targetGit, { recursive: true });
    }
  } finally {
    if (temporaryIndex) fs.rmSync(temporaryIndex, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: install-source.mjs <source> <destination>');
    copyInstallSource(process.argv[2], process.argv[3]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
