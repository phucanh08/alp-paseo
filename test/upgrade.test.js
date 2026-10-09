import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { upgradeProject } from '../src/core/upgrade.js';

async function fixture(t, main = '# Main agent\n\nHelp with tasks in this project.\n') {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.alp/agents/main'), { recursive: true });
  await writeFile(path.join(root, '.alp/agents/main/AGENT.md'), main);
  await writeFile(path.join(root, 'ALP.md'), '# Project instructions\n\nAdd project-wide instructions here.\n');
  await writeFile(path.join(root, '.alp/settings.json'), '{"defaultAgent":"main","runtime":{"model":"my-model"}}');
  return root;
}
test('upgrade backs up original scaffold, enables routing, and preserves runtime settings', async t => {
  const root = await fixture(t);
  const result = await upgradeProject(root);
  assert.deepEqual(result.updated, ['ALP.md', '.alp/agents/main/AGENT.md', '.alp/settings.json']);
  assert.match(await readFile(path.join(root, '.alp/agents/main/AGENT.md'), 'utf8'), /active supervisor/);
  assert.equal(await readFile(path.join(result.backup, '.alp/settings.json'), 'utf8'), '{"defaultAgent":"main","runtime":{"model":"my-model"}}');
  const settings = JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8'));
  assert.equal(settings.runtime.model, 'my-model');
  assert.deepEqual(settings.workflow, { mode: 'pho', maxPeers: 2 });
  assert.deepEqual((await upgradeProject(root)).updated, []);
});
test('upgrade preserves customized instructions and routing', async t => {
  const root = await fixture(t, 'My custom main');
  await writeFile(path.join(root, '.alp/settings.json'), '{"defaultAgent":"custom","delegation":{}}');
  const result = await upgradeProject(root);
  assert.deepEqual(result.customInstructions, ['.alp/agents/main/AGENT.md']);
  assert.equal(await readFile(path.join(root, '.alp/agents/main/AGENT.md'), 'utf8'), 'My custom main');
  assert.equal(await readFile(path.join(root, '.alp/settings.json'), 'utf8'), '{"defaultAgent":"custom","delegation":{}}');
});
test('malformed settings are rejected before migrating instructions', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '.alp/settings.json'), '{');
  await assert.rejects(upgradeProject(root));
  assert.equal(await readFile(path.join(root, '.alp/agents/main/AGENT.md'), 'utf8'), '# Main agent\n\nHelp with tasks in this project.\n');
});
