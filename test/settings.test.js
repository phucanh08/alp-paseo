import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, daemonPaths, ensureDaemon, readLock } from '../src/client/index.js';
import { initProject } from '../src/core/init.js';
import { resolveAgent } from '../src/core/resolver.js';
import { settingsKeys, settingsWarnings, validateSettings, validateUserSettings } from '../src/core/validation.js';

test('a mistyped setting fails with the key it was probably meant to be', () => {
  assert.throws(() => validateSettings({ verfy: { test: 'npm test' } }, '.alp/settings.json'), /\.alp\/settings\.json: unknown setting 'verfy'; did you mean 'verify'\?/);
  assert.throws(() => validateSettings({ colour: 'blue' }, 's'), /unknown setting 'colour'; known settings are defaultAgent, workflow, runtime, permissions, verify, delegation/);
  assert.deepEqual(validateSettings({ $schema: 'x', defaultAgent: 'main', delegation: { main: ['lead'] } }, 's'), {});
  assert.throws(() => validateUserSettings({ limit: { autoResume: true } }, 'home'), /unknown setting 'limit'; did you mean 'limits'\?/);
  assert.throws(() => validateUserSettings({ recovery: { autoResume: 'no' } }, 'home'), /recovery\.autoResume must be true or false/);
  assert.throws(() => validateUserSettings({ limits: { resume: true } }, 'home'), /unsupported limits field 'resume'; use autoResume/);
  assert.deepEqual(validateUserSettings({ limits: { autoResume: true }, recovery: { autoResume: false } }, 'home'), { limits: { autoResume: true }, recovery: { autoResume: false } });
  // Retired keys warn instead of failing.
  assert.deepEqual(settingsKeys({ mode: 'pho', verify: {} }, ['verify'], { mode: 'use workflow.mode' }), { unknown: [], retired: [{ key: 'mode', instead: 'use workflow.mode' }] });
  assert.deepEqual(settingsWarnings({ verify: {} }, 'project'), []);
});

test('a session in a project with a mistyped setting does not open, and says why', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ defaultAgent: 'main', workflw: { mode: 'pho' } }));
  await assert.rejects(resolveAgent(root), /unknown setting 'workflw'; did you mean 'workflow'\?/);
});

test('alpd starts with default settings when $ALP_HOME/settings.json is invalid, and logs why', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ recovry: { autoResume: false } }));
  const entry = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
  const client = await connect(await ensureDaemon({ home, entry }));
  assert.equal((await client.request('daemon.status')).sessions, 0);
  await client.request('daemon.shutdown');
  client.close();
  for (let i = 0; i < 400 && await readLock(home); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(await readFile(daemonPaths(home).log, 'utf8'), /ignoring .*settings\.json: .*unknown setting 'recovry'; did you mean 'recovery'\?/);
});
