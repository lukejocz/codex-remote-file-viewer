import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import * as XLSX from 'xlsx';
import { ByteWriter, parquetWriteBuffer } from 'hyparquet-writer';
import { serializeTCompactProtocol } from 'hyparquet-writer/src/thrift.js';
import { deserializeTCompactProtocol } from 'hyparquet/src/thrift.js';
import { decodeFile, table } from '../src/formats.mjs';
import { readParquet } from '../src/parquet.mjs';

const xlsx = sheets => new Uint8Array(XLSX.write({ SheetNames: Object.keys(sheets), Sheets: sheets }, { type: 'array', bookType: 'xlsx', bookSST: true, compression: true }));
const sparse = range => ({ A1: { t: 's', v: 'header' }, [range.split(':')[1]]: { t: 's', v: 'last' }, '!ref': range });
await assert.rejects(decodeFile({ name: 'sparse.xlsx', bytes: xlsx({ Data: sparse('A1:IV2001') }) }), /500,000 displayed cells/);
await assert.rejects(decodeFile({ name: 'sparse.xlsx', bytes: xlsx({ First: sparse('A1:IV1000'), Second: sparse('A1:IV1000') }) }), /500,000 displayed cells/);
await assert.rejects(decodeFile({ name: 'repeated.xlsx', bytes: xlsx({ Data: XLSX.utils.aoa_to_sheet([['header'], Array(200).fill('x'.repeat(32000)), Array(200).fill('x'.repeat(32000))]) }) }), /formatted output exceeds 10 MiB/);
assert.throws(() => table(Array.from({ length: 2000 }, (_, i) => ({ ['column' + i % 256]: i }))), /500,000 displayed cells/);
assert.throws(() => table(Array.from({ length: 400 }, () => ({ value: 'x'.repeat(32000) }))), /formatted output exceeds 10 MiB/);

function mutateParquet(original, mutate, headerBytes) {
  const view = new DataView(original), reader = { view, offset: 4 };
  const header = deserializeTCompactProtocol(reader);
  let payload = new Uint8Array(original, reader.offset, header.field_3).slice();
  reader.offset = original.byteLength - 8 - view.getUint32(original.byteLength - 8, true);
  const footer = deserializeTCompactProtocol(reader), column = footer.field_4[0].field_1[0].field_3;
  const changed = mutate({ header, footer, column, payload });
  payload = changed?.payload || payload;
  header.field_3 = payload.length;
  const writer = new ByteWriter(); writer.appendBytes(new TextEncoder().encode('PAR1'));
  if (headerBytes) writer.appendBytes(headerBytes); else serializeTCompactProtocol(writer, header);
  writer.appendBytes(payload);
  column.field_7 = BigInt(writer.index - 4);
  const metadataStart = writer.index;
  serializeTCompactProtocol(writer, footer);
  writer.appendUint32(writer.index - metadataStart); writer.appendBytes(new TextEncoder().encode('PAR1'));
  return writer.getBuffer();
}
const base = codec => parquetWriteBuffer({ columnData: [{ name: 'id', type: 'INT32', data: [1] }], codec, compressors: { GZIP: gzipSync }, dictionarySize: 0, statistics: false });
for (const codec of ['UNCOMPRESSED', 'SNAPPY', 'GZIP']) assert.equal((await readParquet(base(codec))).rows[0].cells[0], '1');
const original = base('GZIP');
await assert.rejects(readParquet(mutateParquet(original, ({ header }) => { header.field_2 = 32 * 1024 * 1024; })), /page decoded size/);
await assert.rejects(readParquet(mutateParquet(original, ({ header }) => { header.field_8.field_1 = 1_000_001; })), /page value count/);
await assert.rejects(readParquet(mutateParquet(original, ({ header }) => { header.field_8.field_3 = -1; })), /page row count/);
await assert.rejects(readParquet(mutateParquet(original, ({ footer }) => { footer.field_3 = -1n; })), /row count/);
await assert.rejects(readParquet(mutateParquet(original, ({ column }) => { column.field_9 = -1n; })), /data page offset/);
await assert.rejects(readParquet(mutateParquet(original, ({ column }) => { column.field_4 = 4; })), /BROTLI.*unsupported/);
await assert.rejects(readParquet(mutateParquet(original, ({ header }) => { header.field_8.field_4 = 5; })), /encoding 5.*unsupported/);
await assert.rejects(readParquet(mutateParquet(original, () => {}, new Uint8Array([0x19, 0xf5, 0xff, 0xff, 0xff, 0xff, 7]))), /metadata list/);
await assert.rejects(readParquet(mutateParquet(original, () => {}, new Uint8Array([0x15, ...Array(11).fill(0x80)]))), /metadata varint/);
await assert.rejects(readParquet(mutateParquet(original, ({ footer }) => { let nested = {}; for (let i = 0; i < 33; i++) nested = { field_1: nested }; footer.field_20 = nested; })), /32 levels/);
const plain = base('UNCOMPRESSED');
function codecPage(codec, values) {
  return mutateParquet(plain, ({ header, column, payload }) => {
    const levels = header.field_8.field_5 + header.field_8.field_6;
    column.field_4 = codec;
    header.field_8.field_7 = true;
    return { payload: new Uint8Array([...payload.subarray(0, levels), ...values]) };
  });
}
const literal = new Uint8Array([0x40, 1, 0, 0, 0]);
const framed = bytes => new Uint8Array([0, 0, 0, 4, 0, 0, 0, bytes.length, ...bytes]);
for (const codec of [5, 7]) {
  assert.equal((await readParquet(codecPage(codec, literal))).rows[0].cells[0], '1');
  for (const invalid of [[0x13, 1, 1, 0], [0x40, 1], [0x10, 1, 1], [0x10, 1, 2, 0], [0xf0], [0x30, 1, 0, 0]]) {
    await assert.rejects(readParquet(codecPage(codec, invalid)), /LZ4 payload.*decoded length/);
  }
}
assert.equal((await readParquet(codecPage(5, framed(literal)))).rows[0].cells[0], '1');
await assert.rejects(readParquet(codecPage(5, framed([0x13, 1, 1, 0]))), /LZ4 payload.*decoded length/);
await assert.rejects(readParquet(codecPage(2, gzipSync(new Uint8Array(8)))), /GZIP decoded length exceeds/);
await assert.rejects(readParquet(codecPage(2, gzipSync(new Uint8Array(3)))), /GZIP decoded length differs/);
const gzip = gzipSync(new Uint8Array([1, 0, 0, 0]));
const gzipExtra = new Uint8Array([...gzip.subarray(0, 10), 4, 0, 65, 66, 0, 0, ...gzip.subarray(10)]);
gzipExtra[3] = 4;
assert.equal((await readParquet(codecPage(2, gzipExtra))).rows[0].cells[0], '1');
const misleadingExtra = new Uint8Array([...gzip.subarray(0, 10), 10, 0, 1, 4, 0, 251, 255, 2, 0, 0, 0, 0, ...gzip.subarray(10)]);
misleadingExtra[3] = 4;
assert.equal((await readParquet(codecPage(2, misleadingExtra))).rows[0].cells[0], '1');
const concatenatedGzip = new Uint8Array([...gzipSync(new Uint8Array()), ...misleadingExtra]);
let nativeConcatenated;
try {
  nativeConcatenated = new Uint8Array(await new Response(new Blob([concatenatedGzip]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
} catch (error) {
  assert.equal(error.code, 'ERR_TRAILING_JUNK_AFTER_STREAM_END');
}
if (nativeConcatenated) {
  assert.deepEqual([...nativeConcatenated], [1, 0, 0, 0]);
  assert.equal((await readParquet(codecPage(2, concatenatedGzip))).rows[0].cells[0], '1');
} else {
  await assert.rejects(readParquet(codecPage(2, concatenatedGzip)), { code: 'ERR_TRAILING_JUNK_AFTER_STREAM_END' });
}
await assert.rejects(readParquet(codecPage(1, [4, 0, 1, 0x1a, 1, 0])), /SNAPPY payload.*decoded length/);
await assert.rejects(readParquet(codecPage(1, [8, 28, 1, 0, 0, 0, 0, 0, 0, 0])), /SNAPPY payload.*decoded length/);
await assert.rejects(readParquet(codecPage(6, [0x28, 0xb5, 0x2f, 0xfd, 0x20, 8, 0x43, 0, 0, 0])), /ZSTD.*unsupported/);
await assert.rejects(readParquet(mutateParquet(plain, ({ payload }) => { payload[0] = 126; })), /RLE run exceeds/);
await assert.rejects(readParquet(mutateParquet(plain, ({ header, payload }) => { header.field_8.field_5 = payload.length + 1; })), /definition level bytes/);
const dictionary = parquetWriteBuffer({ columnData: [{ name: 'label', type: 'STRING', data: Array(100).fill('same value') }], codec: 'SNAPPY', statistics: false });
assert.equal((await readParquet(dictionary)).rows[0].cells[0], 'same value');
await assert.rejects(readParquet(mutateParquet(dictionary, ({ header }) => { assert.equal(header.field_1, 2); header.field_7.field_1 = 1_000_001; })), /page value count/);
const reads = [];
const source = { byteLength: original.byteLength, slice(start, end) { reads.push([start, end]); return original.slice(start, end); } };
assert.equal((await readParquet(source)).rows[0].cells[0], '1');
assert(reads.reduce((sum, [start, end]) => sum + end - start, 0) < original.byteLength * 2);
console.log('PASS: sparse and repeated XLSX, dense table budgets, Parquet footer/page bounds, codec overflow, malformed LZ4 blocks, ZSTD exclusion, RLE runs, encoding exclusions, and bounded reads.');
