# Remote File Viewer

Open data files inside Codex, including files on a Remote Control host. The viewer is read-only.

| Files | Preview |
|---|---|
| CSV, TSV | Search, column sorting, and pages of 100 rows. Values remain text. |
| XLSX | Sheet selector, saved cell formatting, and saved formula results. |
| JSON, JSONL, NDJSON | Expandable JSON tree and tables for arrays or line records. Large integers keep their exact digits. |
| Parquet | Schema, total row count, and selectable ranges of up to 1,000 rows. |
| GeoJSON | Offline geometry view, zoom, pan, reset, and feature attributes. |
| SHP | Geometry and same-basename DBF, PRJ, and CPG companions. |
| ZIP | Member listing and previews of supported entries, including shapefile bundles. |
| HTML, HTM | Self-contained HTML in an isolated frame. |

Search and sorting apply to loaded rows. Parquet shows the loaded row interval and the full row count. Set **First row** to load another range. Parquet inside a ZIP shows the first 1,000 rows.

A workbook uses the first row in each sheet's used range as column headings. Formulas never run. A formula without a saved result displays as formula text. The viewer does not execute workbook macros.

For shapefiles, keep `.shp`, `.dbf`, `.prj`, and `.cpg` together with the same basename. The projection file converts usable coordinates to WGS84. Missing or invalid projections produce a raw-coordinate view with an explicit notice. Missing DBF files produce geometry without attributes. DBF numeric fields N, F, and O retain their exact trimmed text, including leading zeros and decimal places. A ZIP bundle works when the host cannot provide trusted paths for loose shapefile companions. SHX is optional.

The geometry view uses no background tiles. A notice identifies geometry that crosses the antimeridian because the flat view may span the world.

## Build and check

Use Node 22 or later.

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

`npm run check` regenerates small synthetic fixtures and checks parsers, input limits, trusted file reads, and MCP discovery. Regressions cover sparse worksheet ranges, repeated shared strings, table expansion, oversized Parquet page headers, decompressor overflow, malformed compact metadata, RLE runs, and unsupported codecs and encodings. The fixtures include a workbook with three sheets, Snappy Parquet with 1,205 rows, a projected shapefile, and a mixed ZIP.

The installable directory is `build/remote-file-viewer`. The package includes both bundles and needs Node 22 at runtime. It needs no runtime package installation.

## Install in Codex

Run the build commands above on the execution host. For Remote Control, use the remote host that holds your files. For local files, use your local machine.

Register this repository as a local marketplace from its root directory, then install the plugin.

```sh
codex plugin marketplace add "$PWD" --json
codex plugin add remote-file-viewer@remote-file-viewer --json
```

The marketplace uses `build/remote-file-viewer`, so build before installing. To install without build tools on the execution host, copy `.agents/plugins/marketplace.json` and the complete `build/remote-file-viewer` directory there. Preserve their paths under one directory. Run the same commands from that directory.

In Codex's **File type handlers** settings, select **Remote File Viewer** for the desired extensions on the target host. Reopen the file link in the native file pane. Remote files use the existing Codex host connection.

This marketplace uses the plugin identity `remote-file-viewer@remote-file-viewer`. If you installed a copy from another marketplace, select this copy in the file handler settings.

## Limits

Opened files and ZIP members have a 10 MiB limit. Loose Parquet uses bounded host reads and can exceed that file limit. A Parquet request reads at most 40 MiB, accepts at most 4 MiB of metadata, and limits selected row groups to 20 MiB of decoded page data and one million page values, including dictionary entries. It checks actual page headers and payload lengths before value decoding. A page's displayed text cannot exceed 10 MiB. Large row groups can therefore prevent previewing an otherwise valid file. Compact metadata allows 32 nesting levels, 100,000 nodes, and 10,000 items per list. Page headers allow 64 KiB. Schema nesting allows 32 levels.

Parquet supports UNCOMPRESSED, SNAPPY, GZIP, LZ4, and LZ4_RAW. GZIP requires native streaming decompression. The preview checks its expanded length and uses those same decoded bytes to validate and display values. Optional GZIP headers are supported. Concatenated GZIP members depend on the native decoder. Some runtimes reject them with a trailing-junk error. SNAPPY and LZ4 checks validate token lengths and copy offsets before decoding. Supported value encodings are PLAIN, PLAIN_DICTIONARY, RLE_DICTIONARY, and RLE for booleans. Definition and repetition levels must use RLE. The preview rejects ZSTD, Brotli, and delta encodings with an explicit error. ZSTD remains unsupported until its decoder can enforce the expanded size limit.

ZIPs allow at most 1,000 entries and 20 MiB of actual expanded data. Workbooks allow 10 MiB of expanded data, 32 sheets, and 500,000 displayed cells across all sheets, including empty cells inside each used range. Workbooks and JSON or geometry tables also cap formatted cell text at 10 MiB. JSON and geometry tables allow 500,000 displayed cells. Tables allow 50,000 data rows and 256 columns. Geometry allows 10,000 features and 250,000 coordinates. JSON allows 64 nesting levels and 500,000 values. Its lazy tree displays at most 5,000 nodes.

ZIP checks reject unsafe paths, duplicate names without regard to case, symlinks, encrypted entries, and nested ZIP previews. Files remain in memory and are never extracted to disk. XML declarations and oversized worksheet dimensions are rejected before workbook parsing. Large bounded files can briefly pause the viewer while parsing.

HTML runs inline scripts inside an isolated iframe. The iframe cannot access the viewer's document or host APIs. Its content policy restricts fetch, sockets, and network-loaded resources. The viewer requests a host policy that permits only blob frames. Native host enforcement of external navigation remains unverified.

Use self-contained HTML with inline CSS, inline JavaScript, and embedded images. Relative files, external libraries, and backend endpoints need an additional asset reader or hosting workflow. Refresh restores the opened file.

The file handler uses the [OpenAI MCP Extensions resource API](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#file-extension-entrypoint). Small files use host text or binary reads. Loose Parquet and shapefile companions use app-only tools whose paths come from host metadata.

Protocol and browser checks do not establish native Remote Control UI support. Verify the remote file pane after installing the plugin.
