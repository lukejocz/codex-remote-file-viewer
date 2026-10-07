import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { decompressPage } from 'hyparquet/src/datapage.js';
import { parquetPlan } from 'hyparquet/src/plan.js';
import { deserializeTCompactProtocol } from 'hyparquet/src/thrift.js';
import { decompressLz4Raw } from 'hyparquet-compressors/src/lz4.js';
import { MAX_BYTES, MAX_COLUMNS } from './registry.mjs';

const MAX_DECODED = 20 * 1024 * 1024;
const MAX_VALUES = 1_000_000;
function count(value, label, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if ((typeof value !== 'number' && typeof value !== 'bigint') || !Number.isSafeInteger(number) || number < 0 || number > max) throw new Error(`Invalid Parquet ${label} or preview limit exceeded.`);
  return number;
}
const lz4Compressors = Object.fromEntries(Object.entries({
  LZ4: (input, length) => decodeLz4(input, length, true),
  LZ4_RAW: decodeLz4,
}).map(([codec, decode]) => [codec, (input, length) => decode(input, count(length, 'decoded page size', MAX_DECODED))]));

function checkLz4(bytes, expected) {
  let offset = 0, produced = 0;
  const invalid = () => { throw new Error('Invalid Parquet LZ4 payload or decoded length exceeds its page size.'); };
  function byte() { if (offset >= bytes.length) invalid(); return bytes[offset++]; }
  function run(length) {
    if (length === 15) { let extra; do { extra = byte(); length += extra; if (length > expected - produced) invalid(); } while (extra === 255); }
    return length;
  }
  while (offset < bytes.length) {
    const token = byte(), literals = run(token >> 4);
    if (literals > bytes.length - offset || literals > expected - produced) invalid();
    offset += literals; produced += literals;
    if (literals && offset === bytes.length) break;
    const distance = byte() + byte() * 256;
    if (!distance || distance > produced) invalid();
    const match = run(token & 15) + 4;
    if (match > expected - produced) invalid();
    produced += match;
  }
  if (produced !== expected) invalid();
}

function decodeLz4(bytes, expected, hadoop = false) {
  if (hadoop) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0, produced = 0;
    try {
      while (offset < bytes.length) {
        if (offset + 8 > bytes.length) throw new Error('Invalid LZ4 framing.');
        const unpacked = view.getUint32(offset), packed = view.getUint32(offset + 4); offset += 8;
        if (!packed || !unpacked || packed > bytes.length - offset || unpacked > expected - produced) throw new Error('Invalid LZ4 framing.');
        const block = bytes.subarray(offset, offset + packed);
        checkLz4(block, unpacked);
        offset += packed; produced += unpacked;
      }
      if (produced !== expected) throw new Error('Invalid LZ4 framing.');
    } catch {
      return decodeLz4(bytes, expected);
    }
    const output = new Uint8Array(expected);
    offset = 0; produced = 0;
    while (offset < bytes.length) {
      const unpacked = view.getUint32(offset), packed = view.getUint32(offset + 4); offset += 8;
      output.set(decompressLz4Raw(bytes.subarray(offset, offset + packed), unpacked), produced);
      offset += packed; produced += unpacked;
    }
    return output;
  }
  checkLz4(bytes, expected);
  return decompressLz4Raw(bytes, expected);
}

function checkSnappy(bytes, expected) {
  let offset = 0, produced = 0, declared = 0;
  const invalid = () => { throw new Error('Invalid Parquet SNAPPY payload or decoded length exceeds its page size.'); };
  function byte() { if (offset >= bytes.length) invalid(); return bytes[offset++]; }
  for (let i = 0; ; i++) {
    const value = byte();
    if (i > 4 || i === 4 && value > 15) invalid();
    declared += (value & 127) * 2 ** (i * 7);
    if (!(value & 128)) break;
  }
  if (declared !== expected) invalid();
  while (offset < bytes.length) {
    const token = byte(), type = token & 3;
    let length = (token >> 2) + 1;
    if (!type) {
      if (length > 60) {
        const width = length - 60; length = 1;
        for (let i = 0; i < width; i++) length += byte() * 2 ** (8 * i);
      }
      if (length > expected - produced || length > bytes.length - offset) invalid();
      offset += length;
    } else {
      let distance = 0;
      if (type === 1) { length = ((token >> 2) & 7) + 4; distance = (token >> 5) * 256 + byte(); }
      else for (let i = 0; i < (type === 2 ? 2 : 4); i++) distance += byte() * 2 ** (8 * i);
      if (!distance || distance > produced || length > expected - produced) invalid();
    }
    produced += length;
  }
  if (produced !== expected) invalid();
}

function gzipKey(bytes, expected) {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `${bytes.length}:${expected}:${hash >>> 0}`;
}

async function checkedDecompress(bytes, expected, codec, { compressors, gzipPages }) {
  if (codec === 'GZIP') {
    const output = new Uint8Array(count(expected, 'decoded page size', MAX_DECODED));
    let offset = 0;
    const reader = new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 1024, bytes.length);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }).pipeThrough(new DecompressionStream('gzip')).getReader();
    let produced = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length > expected - produced) throw new Error('Parquet GZIP decoded length exceeds its page size.');
        output.set(value, produced);
        produced += value.length;
      }
      if (produced !== expected) throw new Error('Parquet GZIP decoded length differs from its page size.');
    } finally { await reader.cancel(); }
    const key = gzipKey(bytes, expected), entries = gzipPages.get(key) || [];
    entries.push({ bytes, output });
    gzipPages.set(key, entries);
    return output;
  } else if (codec === 'SNAPPY') checkSnappy(bytes, expected);
  return decompressPage(bytes, expected, codec, compressors);
}

function checkedThrift(view, start = 0, budget = { nodes: 0 }) {
  let offset = start;
  function take(size) {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > view.byteLength) throw new Error('Truncated Parquet compact metadata.');
    const previous = offset; offset += size; return previous;
  }
  const byte = () => view.getUint8(take(1));
  function varint(bits = 32) {
    let value = 0;
    for (let i = 0; i < Math.ceil(bits / 7); i++) {
      const b = byte();
      if (i === Math.ceil(bits / 7) - 1 && b >= 2 ** (bits - i * 7)) throw new Error('Invalid Parquet metadata varint.');
      value += (b & 127) * 2 ** (i * 7);
      if (!(b & 128)) return value;
    }
    throw new Error('Invalid Parquet metadata varint.');
  }
  function element(type, depth, inList = false) {
    if (++budget.nodes > 100_000 || depth > 32) throw new Error('Parquet metadata exceeds 100,000 nodes or 32 levels.');
    switch (type) {
      case 1: case 2: if (inList && ![1, 2].includes(byte())) throw new Error('Invalid Parquet boolean.'); return;
      case 3: take(1); return;
      case 4: case 5: varint(); return;
      case 6: varint(64); return;
      case 7: take(8); return;
      case 8: take(varint()); return;
      case 9: {
        const tag = byte(), child = tag & 15;
        const size = tag >> 4 === 15 ? varint() : tag >> 4;
        if (size > 10_000 || size + budget.nodes > 100_000) throw new Error('Parquet metadata list exceeds preview limits.');
        for (let i = 0; i < size; i++) element(child, depth + 1, true);
        return;
      }
      case 12: {
        let field = 0;
        const fields = new Set();
        while (true) {
          const tag = byte();
          if (!tag) return;
          if (!(tag & 15)) throw new Error('Invalid Parquet metadata stop marker.');
          const id = tag >> 4 ? field + (tag >> 4) : (() => { const n = varint(); return (n >>> 1) ^ -(n & 1); })();
          if (id < 1 || id > 32767 || fields.has(id)) throw new Error('Invalid Parquet metadata field.');
          fields.add(id); field = id;
          element(tag & 15, depth + 1);
        }
      }
      default: throw new Error('Unsupported Parquet compact metadata type.');
    }
  }
  element(12, 0);
  const reader = { view: new DataView(view.buffer, view.byteOffset + start, offset - start), offset: 0 };
  const value = deserializeTCompactProtocol(reader);
  if (reader.offset !== offset - start) throw new Error('Invalid Parquet metadata boundary.');
  return { value, end: offset };
}

function checkRle(bytes, width, expected, maximum, equalValue) {
  if (!Number.isInteger(width) || width < 0 || width > 32) throw new Error('Invalid Parquet RLE bit width.');
  let offset = 0, seen = 0, equal = 0;
  function take(size) {
    if (offset + size > bytes.length) throw new Error('Truncated Parquet RLE stream.');
    const start = offset; offset += size; return start;
  }
  while (seen < expected) {
    let header = 0, shift = 0, byte;
    do {
      byte = bytes[take(1)];
      if (shift === 28 && byte > 15 || shift > 28) throw new Error('Invalid Parquet RLE run header.');
      header += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    const packed = header % 2, run = Math.floor(header / 2) * (packed ? 8 : 1);
    if (!run || run > expected - seen + (packed ? 7 : 0)) throw new Error('Parquet RLE run exceeds the page value count.');
    if (packed) {
      const start = take(run * width / 8);
      for (let i = 0; i < Math.min(run, expected - seen); i++) {
        let value = 0;
        for (let bit = 0; bit < width; bit++) value += ((bytes[start + Math.floor((i * width + bit) / 8)] >> ((i * width + bit) % 8)) & 1) * 2 ** bit;
        if (value > maximum) throw new Error('Invalid Parquet RLE value.');
        if (value === equalValue) equal++;
      }
    } else {
      const start = take(Math.ceil(width / 8));
      let value = 0;
      for (let i = 0; i < Math.ceil(width / 8); i++) value += bytes[start + i] * 2 ** (8 * i);
      if (value > maximum) throw new Error('Invalid Parquet RLE value.');
      if (value === equalValue) equal += run;
    }
    seen += run;
  }
  if (offset !== bytes.length) throw new Error('Invalid Parquet RLE stream boundary.');
  return equal;
}

function checkPlain(bytes, n, field) {
  const widths = { INT32: 4, INT64: 8, INT96: 12, FLOAT: 4, DOUBLE: 8, FIXED_LEN_BYTE_ARRAY: field.type_length };
  let length = field.type === 'BOOLEAN' ? Math.ceil(n / 8) : n * widths[field.type];
  if (field.type === 'BYTE_ARRAY') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    length = 0;
    for (let i = 0; i < n; i++) {
      if (length + 4 > bytes.length) throw new Error('Truncated Parquet plain value.');
      length += 4 + view.getUint32(length, true);
      if (length > bytes.length) throw new Error('Truncated Parquet plain value.');
    }
  }
  if (length !== bytes.length) throw new Error('Invalid Parquet plain value boundary.');
}

async function checkPayload(bytes, header, meta, leaf, dictionaryValues, decoder) {
  const v2 = header.field_1 === 3, dict = header.field_1 === 2;
  const page = dict ? header.field_7 : v2 ? header.field_8 : header.field_5;
  const encoding = v2 ? page.field_4 : page.field_2;
  if (!(dict ? [0] : leaf.field.type === 'BOOLEAN' ? [0, 3] : [0, 2, 8]).includes(encoding)) throw new Error(`Parquet encoding ${encoding} is unsupported by the bounded preview.`);
  if (!dict && !v2 && (leaf.maxDef && page.field_3 !== 3 || leaf.maxRep && page.field_4 !== 3)) throw new Error('Only RLE Parquet definition and repetition levels are supported.');
  let offset = 0, n = page.field_1, nonNull = n;
  let payload = v2 ? bytes : await checkedDecompress(bytes, header.field_2, meta.codec, decoder);
  function levels(maximum, length, definition) {
    if (!maximum) { if (length) throw new Error('Unexpected Parquet level stream.'); return; }
    if (length === undefined) {
      if (offset + 4 > payload.length) throw new Error('Truncated Parquet level length.');
      length = new DataView(payload.buffer, payload.byteOffset + offset, 4).getUint32(0, true); offset += 4;
    }
    if (offset + length > payload.length) throw new Error('Truncated Parquet levels.');
    const equal = checkRle(payload.subarray(offset, offset + length), 32 - Math.clz32(maximum), n, maximum, maximum);
    if (definition) nonNull = equal;
    offset += length;
  }
  if (!dict) {
    levels(leaf.maxRep, v2 ? page.field_6 : undefined, false);
    levels(leaf.maxDef, v2 ? page.field_5 : undefined, true);
  }
  if (v2 && n - nonNull !== page.field_2) throw new Error('Parquet null count differs from its definition levels.');
  payload = payload.subarray(offset);
  if (v2 && page.field_7 !== false) payload = await checkedDecompress(payload, header.field_2 - offset, meta.codec, decoder);
  if (encoding === 0) checkPlain(payload, nonNull, leaf.field);
  else if (encoding === 3) {
    if (payload.length < 4 || new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true) !== payload.length - 4) throw new Error('Invalid Parquet boolean RLE length.');
    checkRle(payload.subarray(4), 1, nonNull, 1);
  } else {
    if (dictionaryValues === undefined || (nonNull && !dictionaryValues)) throw new Error('Parquet dictionary is missing or empty.');
    if (!nonNull && !payload.length) return;
    if (!payload.length) throw new Error('Missing Parquet dictionary bit width.');
    const width = payload[0];
    if (!width && !v2) { if (payload.length !== 1) throw new Error('Invalid zero-width Parquet dictionary.'); }
    else checkRle(payload.subarray(1), width, nonNull, dictionaryValues - 1);
  }
}

export async function readParquet(file, rowStart = 0, pageSize = 100) {
  if (!Number.isSafeInteger(rowStart) || rowStart < 0 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('Invalid Parquet row interval.');
  if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 12) throw new Error('Invalid Parquet file.');
  const gzipPages = new Map();
  const compressors = { ...lz4Compressors, GZIP(input, length) {
    const key = gzipKey(input, count(length, 'decoded page size', MAX_DECODED));
    const entry = gzipPages.get(key)?.find(entry => entry.bytes.every((byte, index) => byte === input[index]));
    if (!entry) throw new Error('Parquet GZIP payload was not validated.');
    return entry.output;
  } };
  const decoder = { compressors, gzipPages };
  let transferred = 0;
  async function read(start, end) {
    count(start, 'byte offset', file.byteLength); count(end, 'byte offset', file.byteLength);
    if (end < start || end - start > MAX_DECODED || (transferred += end - start) > 40 * 1024 * 1024) throw new Error('Parquet page exceeds the 40 MiB read budget or 20 MiB range limit.');
    const buffer = await file.slice(start, end);
    if (buffer.byteLength !== end - start) throw new Error('Truncated Parquet byte range.');
    return buffer;
  }
  const footer = new DataView(await read(file.byteLength - 8, file.byteLength));
  const metadataLength = footer.getUint32(0, true);
  if (!metadataLength || metadataLength > 4 * 1024 * 1024) throw new Error('Parquet metadata exceeds 4 MiB or is empty.');
  const metadataStart = file.byteLength - 8 - metadataLength;
  if (metadataStart < 4 || footer.getUint32(4, true) !== 0x31524150 || new DataView(await read(0, 4)).getUint32(0, true) !== 0x31524150) throw new Error('Invalid Parquet file signature or footer range.');
  const footerBuffer = await read(metadataStart, file.byteLength);
  const checked = checkedThrift(new DataView(footerBuffer, 0, metadataLength));
  if (checked.end !== metadataLength) throw new Error('Invalid Parquet footer boundary.');
  const metadata = parquetMetadata(footerBuffer, { geoparquet: false });
  const totalRows = count(metadata.num_rows, 'row count');
  if (!metadata.schema.length || metadata.schema.length > MAX_COLUMNS + 1) throw new Error('Parquet exceeds 256 schema fields.');
  let schemaIndex = 0;
  const leaves = [];
  function schemaNode(depth, path, maxDef = 0, maxRep = 0) {
    const field = metadata.schema[schemaIndex++];
    if (!field || depth > 32 || typeof field.name !== 'string') throw new Error('Invalid Parquet schema or nesting exceeds 32 levels.');
    if (field.type_length !== undefined) count(field.type_length, 'fixed field width', MAX_DECODED);
    if (field.type === 'FIXED_LEN_BYTE_ARRAY' && !field.type_length) throw new Error('Invalid Parquet fixed field width.');
    if (depth && !['REQUIRED', 'OPTIONAL', 'REPEATED'].includes(field.repetition_type)) throw new Error('Invalid Parquet repetition type.');
    if (depth && field.repetition_type !== 'REQUIRED') maxDef++;
    if (depth && field.repetition_type === 'REPEATED') maxRep++;
    const children = field.num_children === undefined ? 0 : count(field.num_children, 'schema child count', MAX_COLUMNS);
    if (children && field.type || !children && !field.type && depth > 0) throw new Error('Invalid Parquet schema field.');
    const nextPath = depth ? [...path, field.name] : path;
    if (field.type) leaves.push({ field, path: nextPath, maxDef, maxRep });
    for (let i = 0; i < children; i++) schemaNode(depth + 1, nextPath, maxDef, maxRep);
  }
  schemaNode(0, []);
  if (schemaIndex !== metadata.schema.length) throw new Error('Invalid Parquet schema child count.');
  if (rowStart > totalRows) throw new Error('Parquet row start exceeds the row count.');
  let start = 0, expanded = 0, values = 0;
  const rowEnd = Math.min(totalRows, rowStart + pageSize), selected = [];
  for (const group of metadata.row_groups) {
    const groupRows = count(group.num_rows, 'row group count');
    const end = count(start + groupRows, 'aggregate row count', totalRows);
    count(group.total_byte_size, 'row group byte size');
    if (group.columns.length !== leaves.length) throw new Error('Invalid Parquet column count.');
    const needed = end > rowStart && start < rowEnd;
    for (const [index, column] of group.columns.entries()) {
      const meta = column.meta_data;
      if (!meta || column.file_path || column.crypto_metadata || column.encrypted_column_metadata) throw new Error('External or encrypted Parquet columns are unsupported.');
      const dataOffset = count(meta.data_page_offset, 'data page offset', metadataStart);
      const chunkStart = meta.dictionary_page_offset === undefined ? dataOffset : count(meta.dictionary_page_offset, 'dictionary page offset', dataOffset);
      const compressed = count(meta.total_compressed_size, 'column compressed size', metadataStart);
      const decoded = count(meta.total_uncompressed_size, 'column decoded size');
      const columnValues = count(meta.num_values, 'column value count');
      if (chunkStart < 4 || chunkStart + compressed > metadataStart || (compressed && dataOffset >= chunkStart + compressed)) throw new Error('Invalid Parquet column byte range.');
      if (meta.type !== leaves[index].field.type || JSON.stringify(meta.path_in_schema) !== JSON.stringify(leaves[index].path)) throw new Error('Parquet column differs from its schema.');
      if (needed) {
        if (!['UNCOMPRESSED', 'SNAPPY', ...Object.keys(compressors)].includes(meta.codec)) throw new Error(`Parquet compression codec ${meta.codec || 'unknown'} is unsupported by the bounded preview.`);
        expanded += decoded; values += columnValues;
        if (expanded > MAX_DECODED || values > MAX_VALUES) throw new Error('Selected Parquet row group exceeds the decoded preview limit.');
        selected.push({ meta, chunkStart, compressed, decoded, columnValues, groupRows, leaf: leaves[index] });
      }
    }
    start = end;
  }
  if (start !== totalRows) throw new Error('Parquet row groups do not match the footer row count.');
  const options = { metadata, rowStart, rowEnd, compressors, useOffsetIndex: false, usePageIndex: false, useBloomFilters: false };
  const cache = [];
  if (rowEnd > rowStart) for (const range of parquetPlan(options).fetches) cache.push({ ...range, buffer: await read(range.startByte, range.endByte) });
  const cachedFile = { byteLength: file.byteLength, slice(start, end) {
    const range = cache.find(range => start >= range.startByte && end <= range.endByte);
    if (!range) throw new Error('Parquet requested a byte range outside the validated columns.');
    return range.buffer.slice(start - range.startByte, end - range.startByte);
  } };
  let pageBytes = 0, pageValues = 0;
  const headerBudget = { nodes: 0 };
  for (const { meta, chunkStart, compressed, columnValues, groupRows, leaf } of selected) {
    const view = new DataView(cachedFile.slice(chunkStart, chunkStart + compressed));
    let offset = 0, chunkValues = 0, dictionaryValues, dictionary = false, data = false;
    while (offset < view.byteLength) {
      const headerStart = offset;
      const result = checkedThrift(new DataView(view.buffer, offset, Math.min(view.byteLength - offset, 64 * 1024)), 0, headerBudget);
      const header = result.value;
      offset += result.end;
      const unpacked = count(header.field_2, 'page decoded size', MAX_DECODED);
      const packed = count(header.field_3, 'page compressed size', view.byteLength - offset);
      pageBytes += unpacked;
      if (pageBytes > MAX_DECODED) throw new Error('Parquet page sizes exceed the decoded preview limit.');
      const page = header.field_1 === 0 ? header.field_5 : header.field_1 === 2 ? header.field_7 : header.field_1 === 3 ? header.field_8 : undefined;
      if (!page) throw new Error('Unsupported or invalid Parquet page type.');
      const n = count(page.field_1, 'page value count', MAX_VALUES);
      pageValues += n;
      if (pageValues > MAX_VALUES) throw new Error('Parquet pages exceed one million decoded values.');
      if (leaf.field.type === 'FIXED_LEN_BYTE_ARRAY' && n * leaf.field.type_length > MAX_DECODED) throw new Error('Parquet fixed-width values exceed the decoded preview limit.');
      if (header.field_1 === 2) {
        if (dictionary || data || chunkStart + headerStart !== Number(meta.dictionary_page_offset)) throw new Error('Invalid Parquet dictionary page order.');
        dictionary = true;
      } else {
        if (!data && chunkStart + headerStart !== Number(meta.data_page_offset)) throw new Error('Invalid Parquet data page offset.');
        data = true; chunkValues += n;
        if (chunkValues > columnValues) throw new Error('Parquet page values exceed the column value count.');
      }
      if (header.field_1 === 3) {
        const nulls = count(page.field_2, 'page null count', n);
        count(page.field_3, 'page row count', Math.min(groupRows, n));
        const levels = count(page.field_5, 'definition level bytes', packed) + count(page.field_6, 'repetition level bytes', packed);
        if (levels > packed || levels > unpacked || nulls > n) throw new Error('Invalid Parquet page level sizes.');
      }
      if ((meta.codec === 'UNCOMPRESSED' || header.field_1 === 3 && page.field_7 === false) && packed !== unpacked) throw new Error('Parquet uncompressed page sizes differ.');
      await checkPayload(new Uint8Array(view.buffer, offset, packed), header, meta, leaf, dictionaryValues, decoder);
      if (header.field_1 === 2) dictionaryValues = n;
      offset += packed;
    }
    if (chunkValues !== columnValues) throw new Error('Parquet page totals differ from column metadata.');
  }
  const records = rowEnd > rowStart ? await parquetReadObjects({ ...options, file: cachedFile }) : [];
  if (records.length !== rowEnd - rowStart) throw new Error('Parquet returned an incomplete page.');
  const headers = [...new Set(records.flatMap(Object.keys))];
  if (headers.length > MAX_COLUMNS) throw new Error('Parquet exceeds 256 columns.');
  let bytes = 0;
  const rows = records.map((record, index) => {
    const cells = headers.map(key => {
      const value = record[key];
      let stringUnits = 0;
      const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value, (_, item) => {
        if (typeof item === 'bigint') item = String(item);
        if (typeof item === 'string') stringUnits += item.length;
        if (stringUnits > MAX_BYTES) throw new Error('Parquet output exceeds 10 MiB.');
        return item;
      }) : String(value);
      bytes += new TextEncoder().encode(text).length;
      if (bytes > MAX_BYTES) throw new Error('Parquet output exceeds 10 MiB.');
      return text;
    });
    return { cells, index: index + rowStart, search: cells.join('\0').toLowerCase() };
  });
  return { kind: 'table', headers, rows, totalRows, rowStart, rowEnd, schema: metadata.schema.map(s => ({ name: s.name, type: s.type, convertedType: s.converted_type })), notice: `Rows ${rowStart + (rows.length ? 1 : 0)}–${rowEnd} of ${totalRows}. Search and sort cover these loaded rows.` };
}
