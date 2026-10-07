import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { parquetWriteBuffer } from 'hyparquet-writer';

export async function createFixtures(directory) {
  const write = (name, data) => writeFile(join(directory, name), typeof data === 'string' ? data : new Uint8Array(data));
  await write('test.tsv', 'code\tnote\n01001\t"tab\tinside"\n');
  await write('test.json', '{"identifier":9007199254740993,"nested":{"hello":"world"},"items":[1,true,null]}');
  await write('test.jsonl', '{"id":9007199254740993,"code":"01001"}\n{"id":9007199254740993,"code":"01003"}\n');
  await write('test.geojson', JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'Park', code: '01001' }, geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [2, 0], [2, 2], [0, 0]]]] } },
    { type: 'Feature', properties: { name: 'Collection' }, geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [3, 1] }, { type: 'LineString', coordinates: [[1, 1], [4, 4]] }] } },
  ] }));
  const book = XLSX.utils.book_new();
  const first = XLSX.utils.aoa_to_sheet([['code', 'cached total'], [1001, 3]]); first.A2.z = '00000'; first.B2.f = '1+2';
  XLSX.utils.book_append_sheet(book, first, 'Codes');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['name', 'value'], ['Second sheet', 42]]), 'Values');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), 'Empty');
  await write('test.xlsx', XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
  await write('test.parquet', parquetWriteBuffer({ codec: 'SNAPPY', rowGroupSize: 100, columnData: [
    { name: 'id', type: 'INT64', data: Array.from({ length: 1205 }, (_, i) => 9007199254740993n + BigInt(i)) },
    { name: 'name', type: 'STRING', data: Array.from({ length: 1205 }, (_, i) => `row ${i + 1}`) },
  ] }));
  const shp = new ArrayBuffer(128), v = new DataView(shp);
  v.setInt32(0, 9994); v.setInt32(24, 64); v.setInt32(28, 1000, true); v.setInt32(32, 1, true);
  v.setInt32(100, 1); v.setInt32(104, 10); v.setInt32(108, 1, true); v.setFloat64(112, 111319.49079327357, true); v.setFloat64(120, 111325.1428663851, true);
  await write('point.shp', shp);
  const dbf = new Uint8Array(77); const d = new DataView(dbf.buffer); dbf[0] = 3; d.setUint32(4, 1, true); d.setUint16(8, 65, true); d.setUint16(10, 11, true);
  dbf.set(new TextEncoder().encode('NAME'), 32); dbf[43] = 67; dbf[48] = 10; dbf[64] = 13; dbf[65] = 32; dbf.fill(32, 66, 76); dbf.set(new TextEncoder().encode('Łódź'), 66); dbf[76] = 26;
  await write('point.dbf', dbf); await write('point.cpg', 'UTF-8');
  await write('point.prj', 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs"]]');
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const name of ['test.csv', 'test.tsv', 'test.json', 'test.jsonl', 'test.geojson', 'test.xlsx', 'test.parquet', 'point.shp', 'point.dbf', 'point.prj', 'point.cpg']) await writer.add('data/' + name, new Uint8ArrayReader(new Uint8Array(await readFile(join(directory, name)))));
  await write('mixed.zip', await writer.close());
}
