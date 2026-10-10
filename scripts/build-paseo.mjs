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

// The plugin's client side as the ALP web app runs it (ALPD §62 step 7): compiled as Paseo's daemon
// compiles a plugin's client bundle, and embedded in alpd, which serves it at /alp-plugins.js.
const PLUGIN_SDK = ['@getpaseo/plugin', '@getpaseo/plugin/*', 'react', 'react/jsx-runtime', 'react-native', '@tanstack/react-query', 'zod'];
const pluginClientBuild = await build({ entryPoints: ['plugins/paseo/index.client.tsx'], bundle: true, write: false, format: 'cjs', jsx: 'automatic', platform: 'neutral', target: 'es2020', mainFields: ['module', 'main'], supported: { 'async-await': false }, external: PLUGIN_SDK, legalComments: 'none' });
const pluginManifest = JSON.parse(await readFile('plugins/paseo/paseo-plugin.json', 'utf8'));
// Paseo makes re-exports eager for Hermes and wraps the module in a function of `require`.
const pluginCode = pluginClientBuild.outputFiles[0].text.replaceAll('get: () => from[key]', 'value: from[key]');
const pluginClient = { id: pluginManifest.id, requirements: pluginManifest.requirements, factory: `(function(require){const module={exports:{}};const exports=module.exports;${pluginCode}\nreturn module.exports;})` };
const embeddedPluginClient = {
  name: 'embedded-alp-plugin-client',
  setup(build) {
    build.onResolve({ filter: /^alp:plugin-client$/ }, () => ({ path: 'plugin-client', namespace: 'alp-plugin-client' }));
    build.onLoad({ filter: /.*/, namespace: 'alp-plugin-client' }, () => ({ contents: `export default ${JSON.stringify(pluginClient)}`, loader: 'js' }));
  },
};

// Paseo re-bundles plugin code, so the plugin also learns where its alpd was built.
await build({ entryPoints: ['plugins/paseo/server/index.ts'], outfile: 'plugins/paseo/server/dist/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@getpaseo/plugin', '@getpaseo/plugin/*', '@anthropic-ai/claude-agent-sdk'], plugins: [embeddedTemplates], define: { __ALP_DAEMON_ENTRY__: JSON.stringify(path.resolve('plugins/paseo/server/dist/alpd.js')) } });
// ws is CommonJS: bundles that carry it get a require of their own.
const requireShim = { js: "import { createRequire as __alpRequire } from 'node:module'; const require = __alpRequire(import.meta.url);" };

// The viewer-neutral runtime and the daemon server on their own, for tests.
for (const [entry, outfile] of [['src/runtime/index.ts', 'dist/runtime/index.js'], ['src/daemon/index.ts', 'dist/daemon/index.js']]) {
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@anthropic-ai/claude-agent-sdk'], ...(entry.includes('daemon') ? { banner: requireShim, plugins: [embeddedTemplates, embeddedPluginClient] } : {}) });
}

// alp acp: the ACP agent the CLI loads (ALPD §60).
await build({ entryPoints: ['src/acp/main.ts'], outfile: 'dist/acp.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', define: { __ALP_VERSION__: JSON.stringify(JSON.parse(await readFile('package.json', 'utf8')).version) } });
// The ACP agent on its own, for tests.
await build({ entryPoints: ['src/acp/agent.ts'], outfile: 'dist/acp/agent.js', bundle: true, format: 'esm', platform: 'node', target: 'node20' });

// The web app alpd serves (ALPD §61), embedded in alpd so it needs no files beside it.
const web = await build({ entryPoints: { app: 'web/src/app.tsx' }, outdir: 'dist/web', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'none' });
const webAssets = { '/index.html': { type: 'text/html; charset=utf-8', body: await readFile('web/index.html', 'utf8') } };
for (const file of web.outputFiles) {
  const name = `/${path.basename(file.path)}`;
  webAssets[name] = { type: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', body: file.text };
}
const embeddedWeb = {
  name: 'embedded-alp-web',
  setup(build) {
    build.onResolve({ filter: /^alp:web$/ }, () => ({ path: 'web', namespace: 'alp-web' }));
    build.onLoad({ filter: /.*/, namespace: 'alp-web' }, () => ({ contents: `export default ${JSON.stringify(webAssets)}`, loader: 'js' }));
  },
};

// alpd: for the CLI, and next to the plugin bundle so an installed plugin can start it.
const { version } = JSON.parse(await readFile('plugins/paseo/package.json', 'utf8'));
for (const outfile of ['dist/alpd.js', 'plugins/paseo/server/dist/alpd.js']) {
  await build({ entryPoints: ['src/daemon/main.ts'], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@anthropic-ai/claude-agent-sdk'], plugins: [embeddedTemplates, embeddedWeb, embeddedPluginClient], define: { __ALP_VERSION__: JSON.stringify(version) }, banner: requireShim });
}
