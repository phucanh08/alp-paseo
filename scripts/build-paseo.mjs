import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';

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

await build({ entryPoints: ['plugins/paseo/server/index.ts'], outfile: 'plugins/paseo/server/dist/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@getpaseo/plugin/*', '@anthropic-ai/claude-agent-sdk'], plugins: [embeddedTemplates] });
