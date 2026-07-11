// @ts-check
/**
 * Immutable code identity for preference-enabled skills.
 *
 * Preference automation can outlive the request that approved it, so hashing
 * execute.mjs alone is not sufficient: a later edit to `./helpers.mjs` would
 * otherwise run under the old approval.  This module captures the complete
 * local ESM import graph, gives it one deterministic identity, and materializes
 * the captured bytes as a private directory that replaces the complete live
 * skill tree in the sandbox. Only the managed state/ subtree is rebound.
 *
 * The graph is intentionally conservative.  Local dependencies must remain
 * inside the owning skill directory; non-literal dynamic imports and external
 * packages are rejected.  Node builtins and data: modules are immutable inputs
 * supplied by the runtime and therefore need no local snapshot.
 */
import fs from 'fs';
import path from 'path';
import { builtinModules } from 'module';
import { createHash as sha256Hash, randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { initSync, parse } from 'es-module-lexer';

initSync();

const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 8_000_000;
const MAX_FILES = 128;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// .js may be CommonJS depending on an ambient package.json and can hide
// require() edges from an ESM lexer. Preference code therefore uses .mjs.
const JS_EXTENSIONS = new Set(['.mjs']);
const LEAF_EXTENSIONS = new Set(['.json']);
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(name => name.startsWith('node:') ? name.slice(5) : `node:${name}`),
]);
// Preference automation is deliberately conservative: these modules provide
// data/transport primitives, not alternate code loaders, subprocesses, workers,
// inspector access, or native-extension entry points.
const SAFE_RUNTIME_BUILTINS = new Set([
  'assert', 'assert/strict', 'buffer', 'crypto', 'dns', 'dns/promises',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'os',
  'path', 'path/posix', 'path/win32', 'perf_hooks', 'querystring',
  'stream', 'stream/consumers', 'stream/promises', 'stream/web',
  'string_decoder', 'timers', 'timers/promises', 'url', 'util',
  'util/types', 'zlib',
]);

function digestBytes(bytes) {
  return sha256Hash('sha256').update(bytes).digest('hex');
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function safeRelative(root, candidate) {
  if (!inside(root, candidate)) return null;
  const rel = path.relative(root, candidate).split(path.sep).join('/');
  if (!rel || rel.startsWith('/') || rel.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return rel;
}

function readRegularFile(root, filename) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(filename);
  const relativePath = safeRelative(resolvedRoot, resolved);
  if (!relativePath) throw new Error('skill dependency escapes its owning directory');
  const pathStat = fs.lstatSync(resolved);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size <= 0 || pathStat.size > MAX_FILE_BYTES) {
    throw new Error(`invalid skill dependency: ${relativePath}`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realFile = fs.realpathSync(resolved);
  if (!inside(realRoot, realFile) || realFile !== resolved) {
    throw new Error(`symlinked skill dependency is not eligible: ${relativePath}`);
  }
  let fd = null;
  let bytes;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino
      || before.size !== pathStat.size) throw new Error('file identity changed');
    bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('file changed during read');
    }
  } catch {
    throw new Error(`skill dependency changed while it was read: ${relativePath}`);
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
  if (bytes.length !== pathStat.size || bytes.length <= 0 || bytes.length > MAX_FILE_BYTES) {
    throw new Error(`skill dependency changed while it was read: ${relativePath}`);
  }
  return { absolutePath: resolved, relativePath, bytes, digest: digestBytes(bytes) };
}

function resolveLocalSpecifier(skillDir, importer, specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    let resolved;
    try {
      const url = new URL(specifier, pathToFileURL(importer));
      if (url.protocol !== 'file:') throw new Error('not a local file');
      resolved = fileURLToPath(url);
    } catch {
      throw new Error(`invalid local skill import: ${specifier}`);
    }
    if (!inside(skillDir, path.resolve(resolved))) {
      throw new Error(`skill import escapes its owning directory: ${specifier}`);
    }
    return path.resolve(resolved);
  }
  if (specifier.startsWith('data:')) {
    throw new Error('preference-enabled skills cannot use embedded data modules');
  }
  if (BUILTINS.has(specifier) || specifier.startsWith('node:')) {
    const canonical = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    if (SAFE_RUNTIME_BUILTINS.has(canonical)) return null;
    throw new Error(`preference-enabled skills cannot use runtime code loader or capability "${specifier}"`);
  }
  throw new Error(`preference-enabled skills cannot use unpinned import "${specifier}"`);
}

/**
 * Capture the exact bytes in the local ESM dependency closure rooted at
 * execute.mjs.  The returned buffers, rather than a later disk read, are used
 * to build the execution snapshot.
 */
export function captureSkillCodeClosure(skillDir) {
  const root = path.resolve(skillDir);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw new Error('skill directory must be a real directory');
  }

  const queue = [path.join(root, 'execute.mjs')];
  const seen = new Set();
  const files = [];
  let totalBytes = 0;

  while (queue.length) {
    const filename = /** @type {string} */ (queue.shift());
    if (seen.has(filename)) continue;
    if (seen.size >= MAX_FILES) throw new Error('skill dependency graph is too large');
    const file = readRegularFile(root, filename);
    if (file.relativePath === 'state' || file.relativePath.startsWith('state/')) {
      throw new Error('mutable skill state cannot be imported as executable code');
    }
    seen.add(filename);
    files.push(file);
    totalBytes += file.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('skill dependency graph exceeds the size limit');

    const ext = path.extname(filename).toLowerCase();
    if (LEAF_EXTENSIONS.has(ext)) continue;
    if (!JS_EXTENSIONS.has(ext)) throw new Error(`unsupported local skill module: ${file.relativePath}`);

    let imports;
    try { [imports] = parse(file.bytes.toString('utf8')); }
    catch { throw new Error(`invalid ESM syntax in skill dependency: ${file.relativePath}`); }
    for (const item of imports) {
      // import.meta is not an import edge. A dynamic import without a literal
      // name could choose mutable code after approval, so reject it.
      if (item.d === -2) continue;
      if (typeof item.n !== 'string' || !item.n) {
        throw new Error(`non-literal dynamic import is not eligible: ${file.relativePath}`);
      }
      const dependency = resolveLocalSpecifier(root, filename, item.n);
      if (dependency && !seen.has(dependency)) queue.push(dependency);
    }
  }

  files.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const entry = files.find(file => file.relativePath === 'execute.mjs');
  if (!entry) throw new Error('skill execute.mjs is missing from its code closure');
  // Preserve the historical single-file identity so already-reviewed skills
  // with no local imports do not need a meaningless re-review. Modular skills
  // use a versioned Merkle-style identity over every relative path and digest.
  const digest = files.length === 1
    ? entry.digest
    : (() => {
      const hash = sha256Hash('sha256').update('openensemble-skill-code-closure-v1\0');
      for (const file of files) hash.update(file.relativePath).update('\0').update(file.digest).update('\0');
      return hash.digest('hex');
    })();
  return { digest, entryDigest: entry.digest, files, totalBytes };
}

function canonicalJson(value, at = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item, i) => canonicalJson(item, `${at}[${i}]`)).join(',')}]`;
  if (typeof value !== 'object') throw new Error(`manifest contains a non-JSON value at ${at}`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`manifest contains a non-JSON object at ${at}`);
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], `${at}.${key}`)}`).join(',')}}`;
}

/** Compare the cached runtime manifest to the exact on-disk JSON semantics. */
export function captureSkillManifest(skillDir, runtimeManifest) {
  if (!runtimeManifest || typeof runtimeManifest !== 'object' || Array.isArray(runtimeManifest)) {
    throw new Error('runtime skill manifest is invalid');
  }
  const runtime = { ...runtimeManifest };
  delete runtime.userScope;
  const file = readRegularFile(path.resolve(skillDir), path.join(path.resolve(skillDir), 'manifest.json'));
  let disk;
  try { disk = JSON.parse(file.bytes.toString('utf8')); }
  catch { throw new Error('on-disk skill manifest is invalid JSON'); }
  if (canonicalJson(runtime) !== canonicalJson(disk)) {
    throw new Error('runtime skill manifest differs from the on-disk manifest');
  }
  return { digest: file.digest, bytes: file.bytes, value: disk };
}

/** Capture the code graph and manifest as one fail-closed skill identity. */
export function captureSkillIntegrity(skillDir, runtimeManifest) {
  const manifest = captureSkillManifest(skillDir, runtimeManifest);
  const code = captureSkillCodeClosure(skillDir);
  const importedManifest = code.files.find(file => file.relativePath === 'manifest.json');
  if (importedManifest && !importedManifest.bytes.equals(manifest.bytes)) {
    throw new Error('skill manifest changed while its dependency graph was captured');
  }
  return {
    executorDigest: code.digest,
    manifestDigest: manifest.digest,
    code,
    manifest,
  };
}

function removeSnapshot(root) {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        try { fs.chmodSync(target, 0o700); } catch {}
        removeSnapshot(target);
      } else {
        try { fs.unlinkSync(target); } catch {}
      }
    }
    try { fs.rmdirSync(root); } catch {}
  } catch {}
}

/**
 * Materialize a captured identity into a private sibling directory. The
 * sandbox mounts this complete tree at the canonical skill path while the
 * skill's independently managed state/ directory remains writable.
 */
export function materializeSkillCodeSnapshot(skillDir, runtimeManifest, expectedIdentity) {
  let captured;
  try { captured = captureSkillIntegrity(skillDir, runtimeManifest); }
  catch { return null; }
  if (captured.executorDigest !== expectedIdentity?.executorDigest
    || captured.manifestDigest !== expectedIdentity?.manifestDigest) return null;

  const root = path.resolve(skillDir);
  // Keep snapshots below a non-skill container. A concurrent role-registry
  // reload scans only direct children of the skills directory, so it can never
  // mistake an ephemeral tree (which also carries manifest.json when imported)
  // for another installed skill.
  const snapshotContainer = path.join(path.dirname(root), '.preference-safe-auto-snapshots');
  const snapshotRoot = path.join(snapshotContainer, `${path.basename(root)}-${randomUUID()}`);
  try {
    fs.mkdirSync(snapshotContainer, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(snapshotContainer, 0o700); } catch {}
    fs.mkdirSync(snapshotRoot, { mode: 0o700 });
    // bwrap overlays this complete directory at the canonical skill path, then
    // re-binds the real mutable state directory at this empty mount point.
    fs.mkdirSync(path.join(snapshotRoot, 'state'), { mode: 0o700 });
    const writes = new Map(captured.code.files.map(file => [file.relativePath, file.bytes]));
    writes.set('manifest.json', captured.manifest.bytes);
    for (const [relativePath, bytes] of writes) {
      const target = path.join(snapshotRoot, ...relativePath.split('/'));
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(target, 'wx', 0o400);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      if (!fs.readFileSync(target).equals(bytes)) throw new Error('skill snapshot verification failed');
    }
    const lockDirectories = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) lockDirectories(path.join(dir, entry.name));
      }
      try { fs.chmodSync(dir, 0o500); } catch {}
    };
    lockDirectories(snapshotRoot);
    const execPath = path.join(snapshotRoot, 'execute.mjs');
    const inspected = inspectSkillCodeSnapshotPath(root, execPath);
    if (!inspected || inspected.snapshotRoot !== snapshotRoot) throw new Error('skill snapshot path verification failed');
    return {
      digest: captured.executorDigest,
      execPath,
      snapshotRoot,
      cleanup: () => {
        try { fs.chmodSync(snapshotRoot, 0o700); } catch {}
        removeSnapshot(snapshotRoot);
        try { fs.rmdirSync(snapshotContainer); } catch {}
      },
    };
  } catch {
    try { fs.chmodSync(snapshotRoot, 0o700); } catch {}
    removeSnapshot(snapshotRoot);
    try { fs.rmdirSync(snapshotContainer); } catch {}
    return null;
  }
}

/** Pure path/shape validation used by the subprocess boundary. */
export function inspectSkillCodeSnapshotPath(skillDir, candidate) {
  if (!skillDir || !candidate) return null;
  const root = path.resolve(skillDir);
  const resolved = path.resolve(candidate);
  const snapshotRoot = path.dirname(resolved);
  const snapshotContainer = path.join(path.dirname(root), '.preference-safe-auto-snapshots');
  const expectedPrefix = `${path.basename(root)}-`;
  const snapshotName = path.basename(snapshotRoot);
  if (path.basename(resolved) !== 'execute.mjs'
    || path.dirname(snapshotRoot) !== snapshotContainer
    || !snapshotName.startsWith(expectedPrefix)
    || !UUID_RE.test(snapshotName.slice(expectedPrefix.length))) return null;
  try {
    const containerStat = fs.lstatSync(snapshotContainer);
    const rootStat = fs.lstatSync(snapshotRoot);
    const execStat = fs.lstatSync(resolved);
    if (!containerStat.isDirectory() || containerStat.isSymbolicLink()
      || fs.realpathSync(snapshotContainer) !== snapshotContainer
      || !rootStat.isDirectory() || rootStat.isSymbolicLink()
      || !execStat.isFile() || execStat.isSymbolicLink()
      || fs.realpathSync(snapshotRoot) !== snapshotRoot
      || fs.realpathSync(resolved) !== resolved) return null;
    let files = 0;
    let directories = 0;
    let totalBytes = 0;
    const roFileBinds = [];
    const inspectDirectory = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const target = path.join(dir, entry.name);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw new Error('snapshot symlink');
        if (stat.isDirectory()) {
          directories += 1;
          if (directories > MAX_FILES * 2) throw new Error('snapshot directories');
          inspectDirectory(target);
          continue;
        }
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) throw new Error('snapshot file');
        const relativePath = path.relative(snapshotRoot, target);
        const canonicalTarget = path.resolve(root, relativePath);
        if (!inside(root, canonicalTarget)) throw new Error('snapshot target');
        const targetStat = fs.lstatSync(canonicalTarget);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()
          || fs.realpathSync(canonicalTarget) !== canonicalTarget) throw new Error('mutable target');
        roFileBinds.push({ source: target, target: canonicalTarget });
        files += 1;
        totalBytes += stat.size;
        if (files > MAX_FILES + 1 || totalBytes > MAX_TOTAL_BYTES + MAX_FILE_BYTES) {
          throw new Error('snapshot bounds');
        }
      }
    };
    inspectDirectory(snapshotRoot);
    const manifestStat = fs.lstatSync(path.join(snapshotRoot, 'manifest.json'));
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return null;
    roFileBinds.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
    return { execPath: resolved, snapshotRoot, roFileBinds };
  } catch { return null; }
  return null;
}
