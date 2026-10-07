import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions/app';
import { isLosslessNumber } from 'lossless-json';
import { htmlDocument, selectedRows } from './preview.mjs';
import { format, MAX_BYTES, PAGE_SIZE } from './registry.mjs';
import { decodeFile, cellText } from './formats.mjs';

const app = new App({ name: 'Remote File Viewer', version: '0.2.0' }, {}, { autoResize: false });
const extensions = new OpenAIExtensions(app);
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
let currentFile, connected = false, request = 0, csv = { headers: [], rows: [] }, page = 0, sortColumn = null, direction = 1, htmlUrl, archive, workbook, selectedFeature;
const panels = ['csv', 'html', 'json', 'geo', 'schema'];
function clearHtml() { ui.document.removeAttribute('src'); if (htmlUrl) URL.revokeObjectURL(htmlUrl); htmlUrl = undefined; }
function applyContext(context) { if (context?.theme) applyDocumentTheme(context.theme); if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables); }
function status(message, error = false) { ui.status.textContent = message; ui.status.classList.toggle('error', error); }
function clearContent() { panels.forEach(id => ui[id].hidden = true); ui['sheet-label'].hidden = true; clearHtml(); ui.json.replaceChildren(); ui.map.replaceChildren(); selectedFeature = undefined; }
function options(select, values) { select.replaceChildren(...values.map(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; return option; })); }
function renderRows() {
  const rows = selectedRows(csv.rows, ui.search.value, sortColumn, direction);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); page = Math.min(page, pages - 1);
  ui.count.textContent = `${rows.length.toLocaleString()} of ${csv.rows.length.toLocaleString()} loaded rows`;
  ui.page.textContent = `Page ${page + 1} of ${pages}`; ui.previous.disabled = page === 0; ui.next.disabled = page + 1 === pages;
  ui.body.replaceChildren(...rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row => {
    const tr = document.createElement('tr'); tr.dataset.index = row.index; tr.classList.toggle('selected', row.index === selectedFeature);
    csv.headers.forEach((_, index) => { const td = document.createElement('td'); td.textContent = row.cells[index] ?? ''; tr.append(td); }); return tr;
  }));
  [...ui.head.querySelectorAll('th')].forEach((th, index) => { th.setAttribute('aria-sort', index === sortColumn ? direction === 1 ? 'ascending' : 'descending' : 'none'); th.firstChild.textContent = csv.headers[index] + (index === sortColumn ? direction === 1 ? ' ↑' : ' ↓' : ''); });
}
function renderTable(data) {
  csv = data; page = 0; sortColumn = null; direction = 1; ui.search.value = '';
  const tr = document.createElement('tr');
  csv.headers.forEach((header, index) => { const th = document.createElement('th'); th.scope = 'col'; const button = document.createElement('button'); button.type = 'button'; button.textContent = header; button.onclick = () => { direction = sortColumn === index ? -direction : 1; sortColumn = index; page = 0; renderRows(); }; th.append(button); tr.append(th); });
  ui.head.replaceChildren(tr); renderRows(); ui.csv.hidden = false;
  if (data.schema) { ui.schema.hidden = false; ui['schema-text'].textContent = data.schema.map(f => `${f.name}: ${f.type ?? 'group'}${f.convertedType ? ` / ${f.convertedType}` : ''}`).join('\n'); }
}
function renderJson(value) {
  let nodes = 0;
  function node(key, item) {
    if (++nodes > 5000) { const note = document.createElement('span'); note.textContent = 'Tree display limit reached. Use the table for remaining rows.'; return note; }
    if (!item || typeof item !== 'object' || isLosslessNumber(item)) { const leaf = document.createElement('pre'); leaf.textContent = `${key}: ${item === null ? 'null' : cellText(item)}`; return leaf; }
    const details = document.createElement('details'), summary = document.createElement('summary');
    const keys = Object.keys(item); summary.textContent = `${key} ${Array.isArray(item) ? 'Array' : 'Object'} · ${keys.length}`; details.append(summary);
    let loaded = false;
    details.addEventListener('toggle', () => { if (!details.open || loaded) return; loaded = true; let index = 0;
      const more = document.createElement('button'); more.textContent = 'Show more'; more.type = 'button';
      function append() { const end = Math.min(index + 100, keys.length); for (; index < end && nodes < 5000; index++) details.insertBefore(node(keys[index], item[keys[index]]), more); more.hidden = index === keys.length || nodes >= 5000; }
      more.onclick = append; details.append(more); append();
    }); return details;
  }
  ui.json.replaceChildren(node('root', value)); ui.json.hidden = false;
}
function renderMap(data) {
  const ns = 'http://www.w3.org/2000/svg'; const points = [], elements = [];
  function shape(g, index) {
    if (!g) return;
    if (g.type === 'GeometryCollection') { g.geometries.forEach(x => shape(x, index)); return; }
    const point = p => { points.push(p); return `${p[0]},${-p[1]}`; };
    let element;
    if (g.type === 'Point') { element = document.createElementNS(ns, 'circle'); point(g.coordinates); element.setAttribute('cx', g.coordinates[0]); element.setAttribute('cy', -g.coordinates[1]); }
    else if (g.type === 'MultiPoint') { g.coordinates.forEach(p => shape({ type: 'Point', coordinates: p }, index)); return; }
    else { element = document.createElementNS(ns, 'path'); const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates.flat() : g.coordinates;
      element.setAttribute('d', lines.map(line => 'M' + line.map(point).join('L') + (g.type.includes('Polygon') ? 'Z' : '')).join(' ')); if (!g.type.includes('Polygon')) element.style.fill = 'none'; element.setAttribute('fill-rule', 'evenodd'); }
    element.classList.add('feature'); element.dataset.index = index; element.setAttribute('tabindex', '0'); element.setAttribute('aria-label', `Feature ${index + 1}`);
    const select = () => { selectedFeature = index; ui.search.value = ''; sortColumn = null; page = Math.floor(index / PAGE_SIZE); renderRows(); elements.forEach(e => e.classList.toggle('selected', Number(e.dataset.index) === index)); ui['map-selection'].textContent = `Feature ${index + 1}: ${data.table.rows[index]?.cells.join(' · ') || 'No attributes'}`; };
    element.onclick = select; element.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } }; elements.push(element); ui.map.append(element);
  }
  data.collection.features.forEach((f, i) => shape(f.geometry, i));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  points.forEach(p => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, -p[1]); maxY = Math.max(maxY, -p[1]); });
  const width = points.length ? Math.max(maxX - minX, .001) : 1, height = points.length ? Math.max(maxY - minY, .001) : 1;
  const original = points.length ? [minX - width * .05, minY - height * .05, width * 1.1, height * 1.1] : [0, 0, 1, 1]; let view = [...original], drag;
  function update() { ui.map.setAttribute('viewBox', view.join(' ')); for (const element of elements) if (element.tagName === 'circle') element.setAttribute('r', Math.max(view[2], view[3]) / 100); }
  function zoom(factor) { view = [view[0] + view[2] * (1 - factor) / 2, view[1] + view[3] * (1 - factor) / 2, view[2] * factor, view[3] * factor]; update(); }
  ui['zoom-in'].onclick = () => zoom(.8); ui['zoom-out'].onclick = () => zoom(1.25); ui['reset-map'].onclick = () => { view = [...original]; update(); };
  ui.map.onwheel = e => { e.preventDefault(); zoom(e.deltaY < 0 ? .8 : 1.25); };
  ui.map.onpointerdown = e => { if (e.target === ui.map) { drag = { x: e.clientX, y: e.clientY, view: [...view] }; ui.map.setPointerCapture(e.pointerId); } };
  ui.map.onpointermove = e => { if (!drag) return; const rect = ui.map.getBoundingClientRect(); const scale = Math.max(view[2] / rect.width, view[3] / rect.height); view[0] = drag.view[0] - (e.clientX - drag.x) * scale; view[1] = drag.view[1] - (e.clientY - drag.y) * scale; update(); };
  ui.map.onpointerup = ui.map.onpointercancel = () => { drag = undefined; };
  ui['map-selection'].textContent = data.crs === 'unknown' ? 'Raw coordinates · unknown coordinate system' : 'WGS84 · select a feature for attributes';
  update(); ui.geo.hidden = false;
}
function render(data) {
  clearContent();
  status(data.notice || 'Read-only preview. Click a column heading to sort.');
  switch (data.kind) {
    case 'table': renderTable(data); break;
    case 'workbook': workbook = data; ui.selectors.hidden = false; ui['sheet-label'].hidden = false; options(ui.sheet, data.sheets.map((s, i) => [String(i), s.name])); if (data.sheets.length) renderTable(data.sheets[0]); break;
    case 'json': renderJson(data.value); if (data.table) renderTable(data.table); break;
    case 'geo': renderTable(data.table); renderMap(data); break;
    case 'archive': archive = data; ui.selectors.hidden = false; ui['archive-label'].hidden = false; options(ui['archive-entry'], [['', 'Select an entry'], ...data.entries.filter(e => !e.directory).map(e => [e.name, `${e.name} · ${e.size.toLocaleString()} bytes`])]); ui['archive-list'].textContent = data.entries.map(e => `${e.name}  ${e.size.toLocaleString()} bytes`).join('\n'); ui['archive-list'].hidden = false; status(`${data.entries.length} ZIP entries. Select a supported file to preview.`); break;
    case 'html': htmlUrl = URL.createObjectURL(new Blob([htmlDocument(data.text)], { type: 'text/html' })); ui.document.src = htmlUrl; ui.html.hidden = false; status('HTML preview'); break;
  }
}
function fromBase64(blob) {
  if (typeof blob !== 'string' || blob.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('This file exceeds the 10 MiB preview limit.');
  const raw = atob(blob); if (raw.length > MAX_BYTES) throw new Error('This file exceeds the 10 MiB preview limit.');
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
async function tool(name, args) { const result = await app.callServerTool({ name, arguments: args }); if (result.isError || !result.structuredContent) throw new Error(result.content?.find(c => c.text)?.text || 'The host could not read this file.'); return result.structuredContent; }
async function load() {
  const id = ++request; if (!currentFile || !connected) return;
  ui.refresh.disabled = true; clearContent(); archive = undefined; workbook = undefined;
  for (const panel of ['selectors', 'archive-label', 'archive-list', 'parquet-controls']) ui[panel].hidden = true;
  status('Loading file…');
  try {
    const info = format(currentFile.name); if (!info) throw new Error('This file type has no preview.');
    let data;
    if (info[0] === 'parquet') { data = await tool('preview.parquet-page', { rowStart: 0, pageSize: 1000 }); if (id !== request) return; ui['parquet-controls'].hidden = false; ui['row-start'].value = 1; }
    else {
      if (!extensions.resources) throw new Error('This Codex host does not provide file-resource reads.');
      const resource = await extensions.resources.read({ uri: currentFile.resourceUri, representation: info[1] }); if (id !== request) return;
      const content = resource.contents.find(item => typeof item[info[1]] === 'string'); if (!content) throw new Error('The host did not return the requested file content.');
      const input = { name: currentFile.name, ...(info[1] === 'text' ? { text: content.text } : { bytes: fromBase64(content.blob) }) };
      if (info[0] === 'shp') { const result = await tool('preview.companions', {}); if (id !== request) return; input.companions = Object.fromEntries(Object.entries(result.companions).map(([key, blob]) => [key, fromBase64(blob)])); }
      data = await decodeFile(input);
    }
    if (id === request) render(data);
  } catch (error) { if (id === request) status(error.message || 'Unable to read this file.', true); }
  finally { if (id === request) ui.refresh.disabled = false; }
}
ui['archive-entry'].onchange = async () => { const name = ui['archive-entry'].value; if (!name || !archive) return; const id = ++request; clearContent(); ui['archive-list'].hidden = true; status('Opening ZIP entry…'); try { const data = await archive.open(name); if (id === request) render(data); } catch (error) { if (id === request) status(error.message, true); } };
ui.sheet.onchange = () => { if (workbook) renderTable(workbook.sheets[Number(ui.sheet.value)]); };
ui['load-range'].onclick = async () => { const id = ++request; clearContent(); status('Loading Parquet rows…'); try { const data = await tool('preview.parquet-page', { rowStart: Number(ui['row-start'].value) - 1, pageSize: 1000 }); if (id === request) render(data); } catch (error) { if (id === request) status(error.message, true); } };
app.addEventListener('hostcontextchanged', applyContext);
app.addEventListener('toolinput', ({ arguments: args }) => {
  const input = OpenAIFileEntrypointInputSchema.safeParse(args);
  if (!input.success) { ++request; currentFile = undefined; clearContent(); ['selectors', 'archive-list', 'parquet-controls'].forEach(id => ui[id].hidden = true); ui.filename.textContent = 'Remote File Viewer'; ui.filename.removeAttribute('title'); ui.refresh.disabled = true; status('The host did not provide a valid file input.', true); return; }
  currentFile = input.data.file; ui.filename.textContent = currentFile.name; ui.filename.title = currentFile.name; void load();
});
ui.refresh.onclick = load;
ui.search.oninput = () => { page = 0; renderRows(); };
ui.previous.onclick = () => { --page; renderRows(); ui['table-scroll'].scrollTop = 0; };
ui.next.onclick = () => { ++page; renderRows(); ui['table-scroll'].scrollTop = 0; };
window.addEventListener('pagehide', clearHtml);
app.connect().then(() => { connected = true; applyContext(app.getHostContext()); if (currentFile) void load(); }).catch(error => status(`Unable to connect to Codex: ${error.message}`, true));
