// @ts-check
/**
 * Dependency-free ZIP packaging for the bundled OE Bridge extension.
 *
 * The archive is written directly rather than through an npm dependency or a
 * host `zip` binary. Entries are deflated with node's built-in zlib: the
 * bundled filter lists are several megabytes of highly repetitive JSON and CSS,
 * and storing them uncompressed would make the download roughly eight times
 * larger than it needs to be.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

export const BROWSER_EXTENSION_PACKAGE_FILENAME = 'openensemble-bridge.zip';
export const BROWSER_EXTENSION_PACKAGE_ROOT = 'openensemble-bridge/';

const SOURCE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'browser-extension',
);

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY_UNIX = (3 << 8) | ZIP_VERSION;
const ZIP_UTF8_FLAG = 1 << 11;
/** Top-level entries under browser-extension/ that are build inputs or scratch
 * space rather than part of the shipped extension. */
const EXCLUDED_TOP_LEVEL = new Set(['.filter-cache', '_metadata', 'tools']);
const ZIP_STORE_METHOD = 0;
const ZIP_DEFLATE_METHOD = 8;
/** Below this size deflate usually costs more bytes in overhead than it saves. */
const ZIP_DEFLATE_MIN_BYTES = 256;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC32_TABLE[i] = value >>> 0;
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(value) {
  const input = value instanceof Date && Number.isFinite(value.getTime())
    ? value
    : new Date(1980, 0, 1);
  const year = Math.min(2107, Math.max(1980, input.getFullYear()));
  const month = year === 1980 && input.getFullYear() < 1980 ? 1 : input.getMonth() + 1;
  const day = year === 1980 && input.getFullYear() < 1980 ? 1 : input.getDate();
  const hours = year === 1980 && input.getFullYear() < 1980 ? 0 : input.getHours();
  const minutes = year === 1980 && input.getFullYear() < 1980 ? 0 : input.getMinutes();
  const seconds = year === 1980 && input.getFullYear() < 1980 ? 0 : input.getSeconds();
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | Math.floor(seconds / 2),
  };
}

function archiveName(parts, isDirectory) {
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('\\') || part.includes('/')) {
      throw new Error(`Browser extension contains an unsafe package path segment: ${part || '(empty)'}`);
    }
  }
  const suffix = parts.length ? parts.join('/') : '';
  return `${BROWSER_EXTENSION_PACKAGE_ROOT}${suffix}${isDirectory && suffix ? '/' : ''}`;
}

function collectEntries() {
  const rootStat = fs.lstatSync(SOURCE_DIR);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Bundled browser-extension source is not a regular directory');
  }

  const entries = [{
    name: BROWSER_EXTENSION_PACKAGE_ROOT,
    data: Buffer.alloc(0),
    isDirectory: true,
    mode: rootStat.mode,
    mtime: rootStat.mtime,
  }];

  function visit(directory, parts) {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      // The raw upstream filter lists are a build input, not part of the
      // extension; shipping them would multiply the download for no benefit.
      if (!parts.length && EXCLUDED_TOP_LEVEL.has(child.name)) continue;
      const childParts = [...parts, child.name];
      const absolutePath = path.join(directory, child.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Browser extension package refuses symbolic link: ${childParts.join('/')}`);
      }
      if (stat.isDirectory()) {
        entries.push({
          name: archiveName(childParts, true),
          data: Buffer.alloc(0),
          isDirectory: true,
          mode: stat.mode,
          mtime: stat.mtime,
        });
        visit(absolutePath, childParts);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Browser extension package refuses non-file entry: ${childParts.join('/')}`);
      }
      entries.push({
        name: archiveName(childParts, false),
        data: fs.readFileSync(absolutePath),
        isDirectory: false,
        mode: stat.mode,
        mtime: stat.mtime,
      });
    }
  }

  visit(SOURCE_DIR, []);
  return entries;
}

function assertZipBounds(value, max, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`Browser extension ZIP ${label} exceeds the classic ZIP limit`);
  }
}

/**
 * Build a fresh in-memory ZIP containing the complete bundled extension.
 *
 * Every entry is nested below `openensemble-bridge/`, so extracting the
 * download never scatters extension files into the user's current directory.
 *
 * @returns {Buffer}
 */
export function buildBrowserExtensionPackage() {
  const entries = collectEntries();
  assertZipBounds(entries.length, UINT16_MAX, 'entry count');

  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    assertZipBounds(name.length, UINT16_MAX, `entry name length for ${entry.name}`);
    assertZipBounds(entry.data.length, UINT32_MAX, `entry size for ${entry.name}`);
    assertZipBounds(localOffset, UINT32_MAX, `local-header offset for ${entry.name}`);

    const checksum = entry.isDirectory ? 0 : crc32(entry.data);
    // The CRC and uncompressed length always describe the original bytes; only
    // the stored payload and the method field change when deflate wins.
    let method = ZIP_STORE_METHOD;
    let payload = entry.data;
    if (!entry.isDirectory && entry.data.length >= ZIP_DEFLATE_MIN_BYTES) {
      const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
      if (deflated.length < entry.data.length) {
        method = ZIP_DEFLATE_METHOD;
        payload = deflated;
      }
    }
    assertZipBounds(payload.length, UINT32_MAX, `compressed size for ${entry.name}`);
    const modified = dosDateTime(entry.mtime);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(modified.time, 10);
    localHeader.writeUInt16LE(modified.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localChunks.push(localHeader, name, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
    centralHeader.writeUInt16LE(ZIP_VERSION_MADE_BY_UNIX, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(modified.time, 12);
    centralHeader.writeUInt16LE(modified.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    const unixMode = entry.mode & 0xffff;
    const externalAttributes = ((unixMode << 16) >>> 0) | (entry.isDirectory ? 0x10 : 0);
    centralHeader.writeUInt32LE(externalAttributes >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralChunks.push(centralHeader, name);

    localOffset += localHeader.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  assertZipBounds(localOffset, UINT32_MAX, 'central-directory offset');
  assertZipBounds(centralDirectory.length, UINT32_MAX, 'central-directory size');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirectory, end]);
}
