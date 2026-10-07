import * as XLSX from 'xlsx';
import { ZipReader, Uint8ArrayReader } from '@zip.js/zip.js';
import { parseShp, parseDbf, combine } from 'shpjs';
import proj4 from 'proj4';
import { parse, stringify, isLosslessNumber } from 'lossless-json';
import { format, MAX_BYTES, MAX_ROWS, MAX_COLUMNS } from './registry.mjs';
import { parseCsv, checkTextSize } from './preview.mjs';
import { readParquet } from './parquet.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
export function cellText(value) {
  if (value == null) return '';
  if (isLosslessNumber(value) || typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') return stringify(value);
  return String(value);
}
export function table(records, headers) {
  if (records.length > MAX_ROWS) throw new Error('Table exceeds 50,000 rows.');
  if (!headers) headers = [...new Set(records.flatMap(record => record && typeof record === 'object' && !Array.isArray(record) && !isLosslessNumber(record) ? Object.keys(record) : ['Value']))];
  if (headers.length > MAX_COLUMNS) throw new Error('Table exceeds 256 columns.');
  if (records.length * headers.length > 500_000) throw new Error('Table exceeds 500,000 displayed cells.');
  let outputBytes = headers.reduce((sum, header) => sum + encoder.encode(header).length, 0);
  if (outputBytes > MAX_BYTES) throw new Error('Table formatted output exceeds 10 MiB.');
  const rows = records.map((record, index) => {
    const cells = headers.map(key => {
      const text = cellText(record && typeof record === 'object' && !Array.isArray(record) && !isLosslessNumber(record) ? record[key] : key === 'Value' ? record : undefined);
      outputBytes += encoder.encode(text).length;
      if (outputBytes > MAX_BYTES) throw new Error('Table formatted output exceeds 10 MiB.');
      return text;
    });
    return { cells, index, search: cells.join('\0').toLowerCase() };
  });
  return { kind: 'table', headers, rows };
}
function json(text, budget = { nodes: 0 }) {
  checkTextSize(text);
  let depth = 0, quoted = false, escaped = false, separators = 0;
  for (const char of text) {
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') { if (++depth > 64) throw new Error('JSON exceeds 64 levels.'); }
    else if (char === ']' || char === '}') depth--;
    if (!quoted && (char === ',' || char === ':') && ++separators > 500_000) throw new Error('JSON exceeds 500,000 values.');
  }
  const value = parse(text);
  function visit(item) {
    if (++budget.nodes > 500_000) throw new Error('JSON exceeds 500,000 values.');
    if (item && typeof item === 'object' && !isLosslessNumber(item)) Object.values(item).forEach(visit);
  }
  visit(value);
  return value;
}

export function geo(value, knownCrs = true, notice = '') {
  const collection = value?.type === 'FeatureCollection' ? value : { type: 'FeatureCollection', features: [value?.type === 'Feature' ? value : { type: 'Feature', geometry: value, properties: {} }] };
  if (!Array.isArray(collection.features) || collection.features.length > 10_000) throw new Error('Geometry preview supports at most 10,000 features.');
  if (value.crs && !['urn:ogc:def:crs:OGC:1.3:CRS84', 'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326'].includes(value.crs?.properties?.name)) { knownCrs = false; notice = 'Unknown coordinate system. Showing raw coordinates.'; }
  let coordinates = 0, antimeridian = false;
  function point(p) {
    if (!Array.isArray(p) || p.length < 2 || p.length > 4 || p.some(n => (typeof n !== 'number' && !isLosslessNumber(n)) || !Number.isFinite(Number(n)) || Math.abs(Number(n)) > 1e15)) throw new Error('Invalid geometry coordinate.');
    if (++coordinates > 250_000) throw new Error('Geometry exceeds 250,000 coordinates.');
    const out = p.map(Number);
    if (knownCrs && (Math.abs(out[0]) > 180 || Math.abs(out[1]) > 90)) throw new Error('Coordinates are outside WGS84 bounds.');
    return out;
  }
  function line(points, ring = false) {
    if (!Array.isArray(points) || points.length < (ring ? 4 : 2)) throw new Error('Invalid line or polygon ring.');
    const out = points.map(point);
    if (ring && (out[0][0] !== out.at(-1)[0] || out[0][1] !== out.at(-1)[1])) throw new Error('Polygon ring is not closed.');
    if (knownCrs && out.some((p, i) => i && Math.abs(p[0] - out[i - 1][0]) > 180)) antimeridian = true;
    return out;
  }
  function geometry(g, depth = 0) {
    if (g === null) return null;
    if (!g || depth > 32) throw new Error('Invalid geometry.');
    const c = g.coordinates;
    switch (g.type) {
      case 'Point': return { type: g.type, coordinates: point(c) };
      case 'MultiPoint': return { type: g.type, coordinates: c.map(point) };
      case 'LineString': return { type: g.type, coordinates: line(c) };
      case 'MultiLineString': return { type: g.type, coordinates: c.map(p => line(p)) };
      case 'Polygon': return { type: g.type, coordinates: c.map(p => line(p, true)) };
      case 'MultiPolygon': return { type: g.type, coordinates: c.map(poly => poly.map(p => line(p, true))) };
      case 'GeometryCollection': if (!Array.isArray(g.geometries)) throw new Error('Invalid geometry collection.'); return { type: g.type, geometries: g.geometries.map(x => geometry(x, depth + 1)) };
      default: throw new Error('Unsupported geometry type.');
    }
  }
  const features = collection.features.map(feature => {
    if (feature?.type !== 'Feature') throw new Error('Invalid GeoJSON feature.');
    return { ...feature, geometry: geometry(feature.geometry) };
  });
  if (antimeridian) notice += ' Geometry crosses the antimeridian; the flat coordinate view may span the world.';
  return { kind: 'geo', collection: { type: 'FeatureCollection', features }, table: table(features.map(f => ({ ...f.properties, ...(f.id === undefined ? {} : { id: f.id }) }))), crs: knownCrs ? 'EPSG:4326' : 'unknown', notice };
}

export async function zip(bytes, maxExpanded = 20 * 1024 * 1024) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, checkSignature: true, checkOverlappingEntry: true });
  const entries = [], names = new Set();
  let expanded = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      const name = entry.filename;
      if (entries.length >= 1000) throw new Error('ZIP exceeds 1,000 entries.');
      if (!name || name.includes('\\') || name.includes('//') || /[\x00-\x1f]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(p => p === '..' || p === '.')) throw new Error('Unsafe ZIP member path.');
      const normalized = name.replace(/\/+$/, '').normalize('NFC').toLowerCase();
      if (names.has(normalized)) throw new Error('Duplicate ZIP member name.');
      names.add(normalized);
      if (entry.encrypted || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Encrypted entries and symlinks are unsupported.');
      if (entry.uncompressedSize > MAX_BYTES) throw new Error('ZIP member exceeds 10 MiB.');
      entries.push(entry);
    }
    const cache = new Map();
    async function read(name) {
      if (cache.has(name)) return cache.get(name);
      const entry = entries.find(e => e.filename === name);
      if (!entry || entry.directory) throw new Error('Select a ZIP file entry.');
      const chunks = []; let size = 0, limitError;
      try { await entry.getData(new WritableStream({ write(chunk) {
        size += chunk.length; expanded += chunk.length;
        if (size > MAX_BYTES || expanded > maxExpanded) { limitError = new Error('ZIP expanded data exceeds the preview limit.'); throw limitError; }
        chunks.push(chunk);
      } }), { checkSignature: true, useWebWorkers: false }); } catch (error) { throw limitError || error; }
      const result = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      cache.set(name, result);
      return result;
    }
    for (const entry of entries) if (!entry.directory) await read(entry.filename);
    await reader.close();
    return { kind: 'archive', entries: entries.map(e => ({ name: e.filename, size: cache.get(e.filename)?.length || 0, directory: e.directory })), read, async open(name) {
      if (format(name)?.[0] === 'archive') throw new Error('Nested ZIP previews are unsupported.');
      const companions = {};
      if (format(name)?.[0] === 'shp') for (const extension of ['dbf', 'prj', 'cpg']) {
        const target = name.slice(0, -4).toLowerCase() + '.' + extension;
        const sibling = entries.find(e => e.filename.toLowerCase() === target);
        if (sibling) companions[extension] = await read(sibling.filename);
      }
      return decodeFile({ name, bytes: await read(name), companions });
    } };
  } catch (error) { await reader.close(); throw error; }
}

async function workbook(bytes) {
  const archive = await zip(bytes, MAX_BYTES);
  let sheets = 0, cells = 0;
  for (const entry of archive.entries) {
    if (!/\.xml$/i.test(entry.name)) continue;
    const xml = decoder.decode(await archive.read(entry.name));
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Workbook XML declarations are unsupported.');
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)) continue;
    if (++sheets > 32) throw new Error('Workbook exceeds 32 sheets.');
    const rowCount = [...xml.matchAll(/<(?:\w+:)?row\b/g)].length;
    cells += [...xml.matchAll(/<(?:\w+:)?c\b/g)].length;
    if (rowCount > MAX_ROWS + 1 || cells > 500_000) throw new Error('Workbook exceeds the row or 500,000 cell limit.');
    for (const match of xml.matchAll(/\s(?:ref|r)=["']([^"']*)["']/g)) {
      const reference = match[1].replace(/\$/g, '').toUpperCase();
      if (/^\d+$/.test(reference)) {
        if (Number(reference) < 1 || Number(reference) > MAX_ROWS + 1) throw new Error('Workbook row index exceeds preview limits.');
        continue;
      }
      if (!/^[A-Z]+\d+(?::[A-Z]+\d+)?$/.test(reference)) throw new Error('Invalid workbook cell reference.');
      const range = XLSX.utils.decode_range(reference);
      if (range.s.r < 0 || range.e.r > MAX_ROWS || range.e.c >= MAX_COLUMNS) throw new Error('Workbook dimensions exceed 50,001 rows or 256 columns.');
    }
  }
  const book = XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellText: true, sheetRows: MAX_ROWS + 1 });
  if (book.SheetNames.length > 32) throw new Error('Workbook exceeds 32 sheets.');
  let displayedCells = 0, outputBytes = 0;
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.e.r < range.s.r || range.e.c < range.s.c) throw new Error('Invalid workbook cell range.');
    displayedCells += (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    if (displayedCells > 500_000) throw new Error('Workbook exceeds 500,000 displayed cells.');
  }
  let uncached = false;
  const result = book.SheetNames.map(name => {
    const sheet = book.Sheets[name]; const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if (range.e.r > MAX_ROWS || range.e.c >= MAX_COLUMNS) throw new Error('Workbook dimensions exceed preview limits.');
    const records = [];
    if (sheet['!ref']) for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        const text = cell?.f && cell.v === undefined ? '=' + cell.f : cell ? cell.w ?? XLSX.utils.format_cell(cell) : '';
        if (cell?.f && cell.v === undefined) uncached = true;
        outputBytes += encoder.encode(text).length;
        if (outputBytes > MAX_BYTES) throw new Error('Workbook formatted output exceeds 10 MiB.');
        row.push(text);
      }
      records.push(row);
    }
    const headers = records.shift() || [];
    return { name, kind: 'table', headers: headers.map((h, i) => h || `Column ${i + 1}`), rows: records.map((cells, index) => ({ cells, index, search: cells.join('\0').toLowerCase() })) };
  });
  return { kind: 'workbook', sheets: result, notice: uncached ? 'Formulas without saved results display as formulas. Formulas are never evaluated.' : 'Values use saved cell formatting and saved formula results.' };
}

export async function decodeFile({ name, text, bytes, companions = {} }) {
  const kind = format(name)?.[0];
  if (!kind) throw new Error('This file type has no preview.');
  if (bytes?.byteLength > MAX_BYTES) throw new Error('This file exceeds the 10 MiB preview limit.');
  if (format(name)[1] === 'text') text ??= decoder.decode(bytes);
  if (text !== undefined) checkTextSize(text);
  switch (kind) {
    case 'csv': return parseCsv(text);
    case 'tsv': return parseCsv(text, '\t');
    case 'html': return { kind: 'html', text };
    case 'json': { const value = json(text); return { kind: 'json', value, table: Array.isArray(value) ? table(value) : undefined }; }
    case 'jsonl': { const values = [], budget = { nodes: 0 }; for (const [index, line] of text.split(/\r?\n/).entries()) { if (!line.trim()) continue; try { values.push(json(line, budget)); } catch (error) { throw new Error(`JSONL line ${index + 1}: ${error.message}`); } if (values.length > MAX_ROWS) throw new Error('JSONL exceeds 50,000 rows.'); } return { kind: 'json', value: values, table: table(values) }; }
    case 'geo': return geo(json(text));
    case 'archive': return zip(bytes);
    case 'workbook': return workbook(bytes);
    case 'parquet': return readParquet(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 0, 1000);
    case 'shp': {
      if (bytes.length < 100) throw new Error('Invalid shapefile header.');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getInt32(0) !== 9994 || view.getInt32(24) * 2 !== bytes.length) throw new Error('Invalid shapefile length.');
      const shapeType = view.getInt32(32, true);
      let offset = 100, count = 0, points = 0;
      while (offset < bytes.length) {
        if (offset + 12 > bytes.length || ++count > 10_000) throw new Error('Shapefile record limit or length is invalid.');
        const length = view.getInt32(offset + 4) * 2, type = view.getInt32(offset + 8, true);
        if (length < 4 || offset + 8 + length > bytes.length) throw new Error('Invalid shapefile record length.');
        if (![0, 1, 3, 5, 8, 11, 13, 15, 18, 21, 23, 25, 28].includes(type)) throw new Error('Unsupported shapefile geometry.');
        if (type && type !== shapeType) throw new Error('Shapefile record type differs from its header.');
        if ([1, 11, 21].includes(type)) { if (length < (type === 11 ? 28 : 20)) throw new Error('Invalid shapefile point length.'); points++; }
        else if (type) {
          const pointOffset = [8, 18, 28].includes(type) ? 36 : 40;
          if (length < pointOffset + 4) throw new Error('Invalid shapefile coordinate count.');
          const numPoints = view.getInt32(offset + 8 + pointOffset, true);
          const numParts = pointOffset === 40 ? view.getInt32(offset + 44, true) : 0;
          if (numPoints < 0 || numParts < 0 || numParts > numPoints || pointOffset + 4 + numParts * 4 + numPoints * 16 > length) throw new Error('Invalid shapefile coordinate count.');
          let previous = -1;
          for (let i = 0; i < numParts; i++) {
            const part = view.getInt32(offset + 52 + i * 4, true);
            if ((i === 0 && part !== 0) || part <= previous || part >= numPoints) throw new Error('Invalid shapefile part index.');
            previous = part;
          }
          if ([13, 15, 18].includes(type) && pointOffset + 4 + numParts * 4 + numPoints * 24 + 16 > length) throw new Error('Invalid shapefile Z coordinate count.');
          points += numPoints;
        }
        if (points > 250_000) throw new Error('Shapefile exceeds 250,000 coordinates.');
        offset += 8 + length;
      }
      const dbfBytes = companions.dbf && new Uint8Array(companions.dbf);
      if (companions.dbf) {
        if (companions.dbf.length < 32) throw new Error('Invalid DBF header.');
        const dbf = new DataView(companions.dbf.buffer, companions.dbf.byteOffset, companions.dbf.byteLength);
        const headerLength = dbf.getUint16(8, true), recordLength = dbf.getUint16(10, true);
        if (headerLength < 33 || (headerLength - 33) % 32 || (headerLength - 33) / 32 > MAX_COLUMNS || headerLength > companions.dbf.length || companions.dbf[headerLength - 1] !== 13) throw new Error('Invalid DBF field header.');
        let fieldLength = 1;
        for (let field = 32; field < headerLength - 1; field += 32) {
          fieldLength += companions.dbf[field + 16];
          // Decode textual numbers as strings to preserve digits and formatting.
          if ([78, 70, 79].includes(dbfBytes[field + 11])) dbfBytes[field + 11] = 67;
        }
        if (fieldLength !== recordLength) throw new Error('Invalid DBF record size.');
        if (dbf.getUint32(4, true) !== count || dbf.getUint16(8, true) + dbf.getUint32(4, true) * dbf.getUint16(10, true) > companions.dbf.length) throw new Error('Shapefile geometry and DBF record counts differ.');
      }
      let projection, notice = '', knownCrs = false;
      if (companions.prj) {
        projection = decoder.decode(companions.prj);
        try { const transform = proj4(projection); const point = transform.inverse([0, 0]); if (!point.every(Number.isFinite)) throw new Error(); knownCrs = true; }
        catch { projection = undefined; notice = 'Invalid projection. Showing raw coordinates with an unknown coordinate system.'; }
      } else notice = 'Missing projection. Showing raw coordinates with an unknown coordinate system.';
      const shapes = parseShp(bytes, projection);
      const records = dbfBytes ? parseDbf(dbfBytes, companions.cpg ? decoder.decode(companions.cpg).trim() : undefined) : shapes.map(() => ({}));
      if (records.length !== shapes.length) throw new Error('Shapefile geometry and DBF record counts differ.');
      if (!companions.dbf) notice += ' Attribute file .dbf is missing.';
      return geo(combine([shapes, records]), knownCrs, notice);
    }
  }
}
