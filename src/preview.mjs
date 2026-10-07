import Papa from 'papaparse';

import { format, MAX_BYTES, PAGE_SIZE } from './registry.mjs';
export { MAX_BYTES, PAGE_SIZE } from './registry.mjs';
export const HTML_SANDBOX = 'allow-scripts';
export const HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

export function fileKind(name) {
  return format(name)?.[0];
}

export function checkTextSize(text) {
  // ponytail: whole-file preview stops at 10 MiB; use server paging for larger reports.
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) {
    throw new Error('This file exceeds the 10 MiB preview limit.');
  }
}

export function parseCsv(text, delimiter = ',') {
  checkTextSize(text);
  const result = Papa.parse(text.replace(/^\uFEFF/, ''), {
    delimiter, dynamicTyping: false, skipEmptyLines: false,
  });
  if (result.errors.length) {
    const error = result.errors[0];
    throw new Error(`CSV record ${Number.isInteger(error.row) ? error.row + 1 : '?'}: ${error.message}`);
  }
  const records = result.data;
  if (/[\r\n]$/.test(text) && records.at(-1)?.length === 1 && records.at(-1)[0] === '') records.pop();
  if (!text.length || !records.length) return { kind: 'table', headers: [], rows: [] };
  const width = records.reduce((max, row) => Math.max(max, row.length), 0);
  if (records.length > 50_001 || width > 256) {
    throw new Error('CSV preview supports up to 50,000 data rows and 256 columns.');
  }
  const first = records.shift();
  const headers = Array.from({ length: width }, (_, index) => first[index] || `Column ${index + 1}`);
  const rows = records.map((cells, index) => ({ cells, index, search: cells.join('\u0000').toLowerCase() }));
  return { kind: 'table', headers, rows };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function selectedRows(rows, query, sortColumn, direction) {
  const needle = query.toLowerCase();
  const filtered = rows.filter(row => row.search.includes(needle));
  if (sortColumn !== null) {
    filtered.sort((a, b) => direction * collator.compare(a.cells[sortColumn] ?? '', b.cells[sortColumn] ?? '') || a.index - b.index);
  }
  return filtered;
}

export function htmlDocument(text) {
  checkTextSize(text);
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = HTML_CSP;
  doc.head.prepend(policy);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
