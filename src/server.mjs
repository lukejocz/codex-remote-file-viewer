import { z } from 'zod';
import { FORMATS } from './registry.mjs';
import { readCompanions, parquetPage } from './host-files.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions/server';

const URI = 'ui://remote-file-viewer/viewer.html';
const server = new McpServer({ name: 'remote-file-viewer', version: '0.2.0' });
new OpenAIExtensions(server);

registerAppResource(server, 'Remote File Viewer', URI, {}, async () => ({
  contents: [{
    uri: URI,
    mimeType: RESOURCE_MIME_TYPE,
    text: await readFile(join(__dirname, 'viewer.html'), 'utf8'),
    _meta: {
      ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: ['blob:'] } },
      'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] },
    },
  }],
}));

registerAppTool(server, 'preview.open', {
  title: 'Remote File Viewer',
  description: 'Read-only tables, workbooks, JSON, geometry, ZIP contents, and self-contained HTML.',
  inputSchema: OpenAIFileEntrypointInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: {
    ui: { resourceUri: URI, visibility: ['app'] },
    'openai/ui': { entrypoints: [{ type: 'file', extensions: Object.keys(FORMATS) }] },
  },
}, async () => ({ content: [] }));

for (const [name, schema, handler] of [
  ['preview.companions', z.strictObject({}), (_, extra) => readCompanions(extra._meta)],
  ['preview.parquet-page', z.strictObject({ rowStart: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), pageSize: z.number().int().min(1).max(1000) }), (args, extra) => parquetPage(extra._meta, args.rowStart, args.pageSize)],
]) registerAppTool(server, name, {
  title: name === 'preview.companions' ? 'Read shapefile companions' : 'Read Parquet rows',
  description: 'Read bounded data for the file opened by the host.',
  inputSchema: schema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: URI, visibility: ['app'] } },
}, async (args, extra) => {
  try { return { content: [], structuredContent: await handler(args, extra) }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});

server.connect(new StdioServerTransport()).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
