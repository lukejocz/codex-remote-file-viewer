import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const output = join(root, 'build', 'remote-file-viewer');
await mkdir(dist, { recursive: true });
await build({ entryPoints: [join(root, 'src/server.mjs')], outfile: join(dist, 'server.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs' });
const browser = await build({ entryPoints: [join(root, 'src/viewer.mjs')], bundle: true, write: false, platform: 'browser', target: 'es2022', format: 'iife', minify: true });
const template = await readFile(join(root, 'src/viewer.html'), 'utf8');
const script = browser.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile(join(dist, 'viewer.html'), template.replace('__VIEWER_SCRIPT__', () => script));
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
const compatibility = {
  name: manifest.name, version: manifest.version, description: manifest.description,
  author: manifest.author, interface: manifest.extensions['com.openai'].interface,
  mcpServers: './mcp.json',
};
await mkdir(join(root, '.codex-plugin'), { recursive: true });
await writeFile(join(root, '.codex-plugin/plugin.json'), JSON.stringify(compatibility, null, 2) + '\n');
await mkdir(join(output, 'dist'), { recursive: true });
await mkdir(join(output, '.codex-plugin'), { recursive: true });
await mkdir(join(output, 'fixtures'), { recursive: true });
for (const path of ['plugin.json', 'mcp.json', 'README.md', '.codex-plugin/plugin.json', 'dist/server.cjs', 'dist/viewer.html', 'fixtures/test.csv', 'fixtures/test.html']) {
  await copyFile(join(root, path), join(output, path));
}
console.log(`Built ${output}`);

await cp(join(root, 'fixtures'), join(output, 'fixtures'), { recursive: true });
