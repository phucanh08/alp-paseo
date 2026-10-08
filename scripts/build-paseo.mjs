import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const templateFiles = await readdir('templates', { recursive: true, withFileTypes: true });
const templates = {};
for (const entry of templateFiles) {
  if (!entry.isFile()) continue;
  const relative = `${entry.parentPath}/${entry.name}`.replace(/^templates[\\/]/, '').replaceAll('\\', '/');
  templates[relative] = await readFile(`templates/${relative}`, 'utf8');
}
const embeddedTemplates = {
  name: 'embedded-alp-templates',
  setup(build) {
    build.onResolve({ filter: /^alp:templates$/ }, () => ({ path: 'templates', namespace: 'alp' }));
    build.onLoad({ filter: /.*/, namespace: 'alp' }, () => ({ contents: `export default ${JSON.stringify(templates)}`, loader: 'js' }));
  },
};

// Paseo re-bundles plugin code, so the plugin also learns where its alpd was built.
await build({ entryPoints: ['plugins/paseo/server/index.ts'], outfile: 'plugins/paseo/server/dist/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@getpaseo/plugin/*', '@anthropic-ai/claude-agent-sdk'], plugins: [embeddedTemplates], define: { __ALP_DAEMON_ENTRY__: JSON.stringify(path.resolve('plugins/paseo/server/dist/alpd.js')) } });
// The viewer-neutral runtime and the daemon server on their own, for tests.
for (const [entry, outfile] of [['src/runtime/index.ts', 'dist/runtime/index.js'], ['src/daemon/server.ts', 'dist/daemon/server.js']]) {
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@anthropic-ai/claude-agent-sdk'] });
}

// alpd: for the CLI, and next to the plugin bundle so an installed plugin can start it.
const { version } = JSON.parse(await readFile('plugins/paseo/package.json', 'utf8'));
for (const outfile of ['dist/alpd.js', 'plugins/paseo/server/dist/alpd.js']) {
  await build({ entryPoints: ['src/daemon/main.ts'], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@anthropic-ai/claude-agent-sdk'], plugins: [embeddedTemplates], define: { __ALP_VERSION__: JSON.stringify(version) } });
}
