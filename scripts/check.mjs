import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FORMATS } from '../src/registry.mjs';
import { decodeFile, zip } from '../src/formats.mjs';
import { readCompanions, parquetPage } from '../src/host-files.mjs';
import { createFixtures } from './fixtures.mjs';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseCsv, selectedRows, HTML_CSP, HTML_SANDBOX, checkTextSize, MAX_BYTES } from '../src/preview.mjs';

await import('./check-limits.mjs');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parsed = parseCsv(await readFile(join(root, 'fixtures/test.csv'), 'utf8'));
assert.equal(parsed.rows.length, 3);
assert.equal(parsed.rows[0].cells[0], '01001');
assert.equal(parsed.rows[0].cells[3], 'comma, inside');
assert.equal(parsed.rows[1].cells[3], 'He said "hello"');
assert.equal(parsed.rows[2].cells[3], 'first line\nsecond line');
assert.deepEqual(selectedRows(parsed.rows, '', 2, 1).map(row => row.cells[2]), ['0', '2', '10']);
assert.equal(selectedRows(parsed.rows, 'BALDWIN', null, 1).length, 1);
const ragged = parseCsv('\uFEFFname,name\r\na,b,c\r\nd\r\n');
assert.deepEqual(ragged.headers, ['name', 'name', 'Column 3']);
assert.equal(ragged.rows[1].cells[0], 'd');
assert.equal(parseCsv('a\n\n').rows.length, 1);
assert.deepEqual(parseCsv('').rows, []);
assert.throws(() => parseCsv('a,b\n"unterminated'), /CSV record.*Quoted field unterminated/);
assert.throws(() => checkTextSize('x'.repeat(MAX_BYTES + 1)), /10 MiB/);
assert.equal(HTML_SANDBOX, 'allow-scripts');
for (const restriction of ["connect-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert(HTML_CSP.includes(restriction));

await createFixtures(join(root, 'fixtures'));
const fixture = async name => decodeFile({ name, bytes: new Uint8Array(await readFile(join(root, 'fixtures', name))) });
assert.equal((await fixture('test.tsv')).rows[0].cells[1], 'tab\tinside');
assert.equal((await fixture('test.json')).value.identifier.toString(), '9007199254740993');
assert.equal((await fixture('test.jsonl')).table.rows[0].cells[0], '9007199254740993');
await assert.rejects(decodeFile({ name: 'bad.jsonl', text: '{}\nwrong' }), /line 2/);
await assert.rejects(decodeFile({ name: 'bad.json', text: '['.repeat(65) }), /64 levels/);
const book = await fixture('test.xlsx');
assert.equal(book.sheets.length, 3);
assert.deepEqual(book.sheets[0].rows[0].cells, ['01001', '3']);
assert.equal(book.sheets[1].rows[0].cells[0], 'Second sheet');
assert.equal(book.sheets[2].rows.length, 0);
assert.equal((await fixture('test.geojson')).collection.features[1].geometry.type, 'GeometryCollection');
await assert.rejects(decodeFile({ name: 'bad.geojson', text: '{"type":"Point","coordinates":[190,1]}' }), /WGS84/);
const parquet = await fixture('test.parquet');
assert.equal(parquet.totalRows, 1205);
assert.equal(parquet.rows.length, 1000);
assert.equal(parquet.rows[0].cells[0], '9007199254740993');
const meta = path => ({ 'openai/resource': { path } });
const later = await parquetPage(meta(join(root, 'fixtures/test.parquet')), 1100, 100);
assert.equal(later.rows.length, 100);
assert.equal(later.rows[0].cells[1], 'row 1101');
assert.equal(later.rowEnd, 1200);
assert.equal(later.totalRows, 1205);
const companions = Object.fromEntries(await Promise.all(['dbf', 'prj', 'cpg'].map(async ext => [ext, new Uint8Array(await readFile(join(root, 'fixtures/point.' + ext)))])));
const shp = new Uint8Array(await readFile(join(root, 'fixtures/point.shp')));
const projected = await decodeFile({ name: 'point.shp', bytes: shp, companions });
assert.equal(projected.crs, 'EPSG:4326');
assert(Math.abs(projected.collection.features[0].geometry.coordinates[0] - 1) < .00001);
assert(Math.abs(projected.collection.features[0].geometry.coordinates[1] - 1) < .00001);
assert.equal(projected.table.rows[0].cells[0], 'Łódź');
const numericDbf = new Uint8Array(191), numericHeader = new DataView(numericDbf.buffer);
numericDbf[0] = 3; numericHeader.setUint32(4, 1, true); numericHeader.setUint16(8, 129, true); numericHeader.setUint16(10, 61, true);
const numericValues = ['9007199254740993', '001.2300', '-1.2300E+20'];
for (let i = 0; i < 3; i++) {
  numericDbf.set(i ? new TextEncoder().encode('VALUE' + i) : new Uint8Array([0xa3, 73, 68]), 32 + i * 32);
  numericDbf[43 + i * 32] = 'NFO'.charCodeAt(i); numericDbf[48 + i * 32] = 20;
  numericDbf.fill(32, 130 + i * 20, 150 + i * 20);
  numericDbf.set(new TextEncoder().encode(numericValues[i]), 130 + i * 20);
}
numericDbf[128] = 13; numericDbf[129] = 32; numericDbf[190] = 26;
const numericCpg = new TextEncoder().encode('ANSI 1250');
const numericShape = await decodeFile({ name: 'point.shp', bytes: shp, companions: { ...companions, dbf: numericDbf, cpg: numericCpg } });
assert.deepEqual(numericShape.table.headers, ['ŁID', 'VALUE1', 'VALUE2']);
assert.deepEqual(numericShape.table.rows[0].cells, numericValues);
assert.equal(numericDbf[43], 'N'.charCodeAt(0));
const numericArchive = await zip(await archiveOf([['point.shp', shp], ['point.dbf', numericDbf], ['point.cpg', numericCpg]]));
assert.deepEqual((await numericArchive.open('point.shp')).table, numericShape.table);
numericDbf[129] = 42;
assert.deepEqual((await decodeFile({ name: 'point.shp', bytes: shp, companions: { dbf: numericDbf, cpg: numericCpg } })).table, numericShape.table);
numericDbf.fill(32, 170, 190);
assert.deepEqual((await decodeFile({ name: 'point.shp', bytes: shp, companions: { dbf: numericDbf, cpg: numericCpg } })).table.rows[0].cells, [...numericValues.slice(0, 2), '']);
const badProjection = await decodeFile({ name: 'point.shp', bytes: shp, companions: { ...companions, prj: new TextEncoder().encode('not a projection') } });
assert.equal(badProjection.crs, 'unknown');
assert.match(badProjection.notice, /Invalid projection/);
const bomb = shp.slice(); new DataView(bomb.buffer).setInt32(108, 8, true); new DataView(bomb.buffer).setInt32(32, 8, true);
await assert.rejects(decodeFile({ name: 'bad.shp', bytes: bomb }), /Invalid shapefile coordinate count/);
const badDbf = companions.dbf.slice(); new DataView(badDbf.buffer).setUint32(4, 0xffffffff, true);
await assert.rejects(decodeFile({ name: 'point.shp', bytes: shp, companions: { ...companions, dbf: badDbf } }), /record counts/);
const archive = await fixture('mixed.zip');
assert.equal(archive.entries.length, 11);
assert.equal((await archive.open('data/test.xlsx')).sheets.length, 3);
assert.equal((await archive.open('data/point.shp')).crs, 'EPSG:4326');
assert.equal((await archive.open('data/test.parquet')).totalRows, 1205);
for (const name of ['bad.xlsx', 'bad.zip', 'bad.parquet', 'bad.shp']) await assert.rejects(decodeFile({ name, bytes: new Uint8Array([1, 2, 3]) }));
async function archiveOf(items) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, data, opts] of items) await writer.add(name, new Uint8ArrayReader(data), opts);
  return writer.close();
}
const one = new Uint8Array([1]);
await assert.rejects(zip(await archiveOf([['../escape.csv', one]])), /Unsafe/);
await assert.rejects(zip(await archiveOf([['a.csv', one], ['A.csv', one]])), /Duplicate/);
await assert.rejects(zip(await archiveOf([['link.csv', one, { versionMadeBy: 0x314, externalFileAttributes: 0xa1ff0000 }]])), /symlink/);
const inflated = await archiveOf([['large.csv', new Uint8Array(MAX_BYTES + 1)]]);
await assert.rejects(zip(inflated), /10 MiB/);
const sizeLie = inflated.slice(), lieView = new DataView(sizeLie.buffer, sizeLie.byteOffset, sizeLie.byteLength);
for (let offset = 0; offset + 16 <= sizeLie.length; offset++) {
  const signature = lieView.getUint32(offset, true);
  if (signature === 0x02014b50) lieView.setUint32(offset + 24, 1, true);
  if (signature === 0x08074b50) lieView.setUint32(offset + 12, 1, true);
}
await assert.rejects(zip(sizeLie), /uncompressed size|expanded data/);
await assert.rejects(zip(await archiveOf([['a.csv', new Uint8Array(1000)], ['b.csv', new Uint8Array(1000)]]), 1500), /expanded data/);
const hostileXml = new TextEncoder().encode('<worksheet><dimension ref="A1:XFD1048576"/></worksheet>');
await assert.rejects(decodeFile({ name: 'bad.xlsx', bytes: await archiveOf([['xl/worksheets/sheet1.xml', hostileXml]]) }), /dimensions/);
await assert.rejects(decodeFile({ name: 'bad.xlsx', bytes: await archiveOf([['xl/worksheets/sheet1.xml', new TextEncoder().encode('<!DOCTYPE worksheet><worksheet/>')]]) }), /declarations/);
await assert.rejects(readCompanions({}), /host must supply/);
await assert.rejects(parquetPage(meta(join(root, 'fixtures/test.csv')), 0, 100), /host must supply/);
const scratch = await mkdtemp(join(tmpdir(), 'preview-check-'));
try {
  await writeFile(join(scratch, 'point.shp'), shp);
  await symlink(join(root, 'fixtures/point.dbf'), join(scratch, 'point.dbf'));
  await assert.rejects(readCompanions(meta(join(scratch, 'point.shp'))), /escapes/);
} finally { await rm(scratch, { recursive: true }); }
const foundCompanions = await readCompanions(meta(join(root, 'fixtures/point.shp')));
assert.deepEqual(Object.keys(foundCompanions.companions), ['dbf', 'prj', 'cpg']);

const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/server.cjs')], stderr: 'pipe' });
const client = new Client({ name: 'remote-file-viewer-check', version: '0.1.0' }, {});
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const tool = tools.find(item => item.name === 'preview.open');
  assert(tool, 'file entrypoint must be discoverable');
  assert.equal(tool.title, 'Remote File Viewer');
  assert.deepEqual(tool._meta['openai/ui'].entrypoints[0].extensions, Object.keys(FORMATS));
  assert.deepEqual(tool._meta.ui.visibility, ['app']);
  const uri = tool._meta.ui.resourceUri;
  const resource = await client.readResource({ uri });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert(resource.contents[0].text.includes('sandbox="allow-scripts"'));
  assert(!resource.contents[0].text.includes('allow-same-origin'));
  assert(!resource.contents[0].text.includes('__VIEWER_SCRIPT__'));
  assert.deepEqual(resource.contents[0]._meta['openai/ui'].availableDisplayModes, ['fullscreen']);
  assert.deepEqual(resource.contents[0]._meta.ui.csp.frameDomains, ['blob:']);
  const result = await client.callTool({ name: 'preview.open', arguments: { file: { name: 'test.csv', resourceUri: 'host-resource://fixture' } } });
  assert.deepEqual(result.content, []);
  for (const name of ['preview.companions', 'preview.parquet-page']) {
    assert.deepEqual(tools.find(t => t.name === name)._meta.ui.visibility, ['app']);
    const forged = await client.callTool({ name, arguments: { path: join(root, 'fixtures/point.shp'), rowStart: 0, pageSize: 100 } });
    assert.equal(forged.isError, true);
  }
  const remotePage = await client.callTool({ name: 'preview.parquet-page', arguments: { rowStart: 1100, pageSize: 100 }, _meta: meta(join(root, 'fixtures/test.parquet')) });
  assert.equal(remotePage.structuredContent.rows[0].cells[1], 'row 1101');
  const malformed = await client.callTool({ name: 'preview.open', arguments: { file: { name: '', resourceUri: '' } } });
  assert.equal(malformed.isError, true);
} finally {
  await client.close();
}
assert.equal(stderr, '', `Server stderr must be empty: ${stderr}`);
console.log('PASS: CSV/TSV, lossless JSON/JSONL, XLSX sheets/formula cache, GeoJSON, Snappy Parquet late pages, projected SHP/DBF/CPG, ZIP entries, malformed inputs and limits, trusted host reads, HTML restrictions, and MCP discovery.');
