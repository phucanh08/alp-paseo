#!/usr/bin/env node
// Builds the ALP web app: Paseo's web app at the pinned commit, with paseo-web/patches applied (D31, ALPD §62).
// The checkout lives in .cache/paseo-web (or $ALP_PASEO_SRC); the export lands in dist/web-app and beside
// the Paseo plugin's alpd, each file with .br and .gz copies for alpd to send.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const upstream = JSON.parse(await readFile(path.join(root, 'paseo-web/upstream.json'), 'utf8'));
const source = path.resolve(process.env.ALP_PASEO_SRC ?? path.join(root, '.cache/paseo-web'));
const patchDir = path.join(root, 'paseo-web/patches');
const targets = [path.join(root, 'dist/web-app'), path.join(root, 'plugins/paseo/server/dist/web-app')];

function run(command, args, cwd = source, env = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal})`);
}
const quiet = (command, args, cwd = source) => spawnSync(command, args, { cwd, encoding: 'utf8' }).stdout?.trim() ?? '';

// 1. The checkout at the pinned commit, clean of earlier patches; node_modules and builds are kept.
if (!existsSync(path.join(source, '.git'))) {
  await mkdir(path.dirname(source), { recursive: true });
  run('git', ['clone', '--filter=blob:none', '--no-checkout', upstream.repository, source], root);
}
if (quiet('git', ['cat-file', '-t', upstream.commit]) !== 'commit') run('git', ['fetch', '--filter=blob:none', 'origin', upstream.commit]);
run('git', ['checkout', '--quiet', '--force', '--detach', upstream.commit]);
run('git', ['clean', '--quiet', '-fd', '--', 'packages', 'scripts', 'patches']);

// 2. ALP's patches, in order.
const patches = (await readdir(patchDir)).filter(name => name.endsWith('.patch')).sort();
run('git', ['apply', '--whitespace=nowarn', ...patches.map(name => path.join(patchDir, name))]);

// 3. Dependencies, again only when the lockfile changed; then Paseo's own steps for its app.
const lockHash = createHash('sha256').update(await readFile(path.join(source, 'package-lock.json'))).digest('hex');
const marker = path.join(source, 'node_modules/.alp-lock-hash');
if (!existsSync(marker) || (await readFile(marker, 'utf8')) !== lockHash) {
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  await writeFile(marker, lockHash);
}
run('npm', ['run', 'postinstall']);
run('npm', ['run', 'build:app-deps']);
const app = path.join(source, 'packages/app');
await rm(path.join(app, 'dist'), { recursive: true, force: true });
run('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist'], app, { APP_VARIANT: 'production', NODE_ENV: 'production' });

// 4. Copy out with the licence, compressed copies beside each text file.
const exported = path.join(app, 'dist');
const files = [];
const walk = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else files.push(full); } };
await walk(exported);
for (const file of files.filter(file => /\.(html|js|css|json|svg|map|txt|ico|ttf|wasm)$/.test(file))) {
  const body = await readFile(file);
  if (body.length < 1024) continue;
  await writeFile(`${file}.br`, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }));
  await writeFile(`${file}.gz`, gzipSync(body, { level: 9 }));
}
await cp(path.join(root, 'paseo-web/LICENSE'), path.join(exported, 'LICENSE.paseo.txt'));
await cp(path.join(root, 'paseo-web/NOTICE'), path.join(exported, 'NOTICE.txt'));
await writeFile(path.join(exported, 'alp-web-app.json'), `${JSON.stringify({ paseoCommit: upstream.commit, paseoVersion: upstream.version, patches }, null, 2)}\n`);
for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  await cp(exported, target, { recursive: true });
}
const size = (await stat(path.join(targets[0], 'index.html'))).size;
console.log(`ALP web app built from Paseo ${upstream.version} (${upstream.commit.slice(0, 7)}) with ${patches.length} patches into ${targets.map(target => path.relative(root, target)).join(', ')} (index.html ${size} B)`);
