import { open, realpath, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { getResourcePath } from '@openai/mcp-extensions/server';
import { MAX_BYTES } from './registry.mjs';
import { readParquet } from './parquet.mjs';

async function openedPath(meta, extension) {
  const path = getResourcePath(meta);
  if (!path || !isAbsolute(path) || extname(path).toLowerCase() !== extension) throw new Error(`The host must supply the opened ${extension} path. For shapefiles, a ZIP bundle also works.`);
  return realpath(path);
}
export async function readCompanions(meta) {
  const path = await openedPath(meta, '.shp');
  const directory = dirname(path), stem = basename(path, extname(path)).toLowerCase();
  const names = await readdir(directory), companions = {};
  let total = 0;
  for (const extension of ['dbf', 'prj', 'cpg']) {
    const matches = names.filter(name => name.toLowerCase() === `${stem}.${extension}`);
    if (matches.length > 1) throw new Error(`Ambiguous .${extension} companion.`);
    if (!matches.length) continue;
    const sibling = await realpath(join(directory, matches[0]));
    if (dirname(sibling) !== directory) throw new Error('Companion symlink escapes the opened directory.');
    const handle = await open(sibling, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES || total + stat.size > MAX_BYTES) throw new Error('Shapefile companions exceed 10 MiB.');
      const bytes = Buffer.alloc(stat.size);
      const result = await handle.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead !== bytes.length || (await handle.stat()).mtimeMs !== stat.mtimeMs) throw new Error('Companion changed while reading. Refresh the file.');
      total += bytes.length;
      companions[extension] = bytes.toString('base64');
    } finally { await handle.close(); }
  }
  return { companions };
}
export async function parquetPage(meta, rowStart, pageSize) {
  const path = await openedPath(meta, '.parquet');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size)) throw new Error('Opened Parquet is not a regular file.');
    let transferred = 0;
    const file = { byteLength: before.size, async slice(start, end = before.size) {
      if (start < 0) start += before.size;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > before.size || end - start > 20 * 1024 * 1024) throw new Error('Parquet byte range exceeds the preview limit.');
      transferred += end - start;
      if (transferred > 40 * 1024 * 1024) throw new Error('Parquet page exceeds the 40 MiB read budget.');
      const bytes = Buffer.alloc(end - start);
      const result = await handle.read(bytes, 0, bytes.length, start);
      if (result.bytesRead !== bytes.length) throw new Error('Parquet changed while reading. Refresh the file.');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } };
    const result = await readParquet(file, rowStart, pageSize);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Parquet changed while reading. Refresh the file.');
    return result;
  } finally { await handle.close(); }
}
