export const FORMATS = {
  '.csv': ['csv', 'text'], '.tsv': ['tsv', 'text'], '.html': ['html', 'text'], '.htm': ['html', 'text'],
  '.json': ['json', 'text'], '.jsonl': ['jsonl', 'text'], '.ndjson': ['jsonl', 'text'],
  '.geojson': ['geo', 'text'], '.xlsx': ['workbook', 'blob'], '.parquet': ['parquet', 'blob'],
  '.shp': ['shp', 'blob'], '.zip': ['archive', 'blob'],
};
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 256;
export const PAGE_SIZE = 100;
export function format(name) { return FORMATS[name.slice(name.lastIndexOf('.')).toLowerCase()]; }
