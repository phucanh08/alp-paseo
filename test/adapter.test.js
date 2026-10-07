import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAgent } from '../src/core/resolver.js';
import { compileAgent } from '../src/core/adapter.js';
import { FakeAdapter } from '../src/adapters/fake.js';

test('fake compiles main and filesystem custom agent without provider dependencies', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'ALP.md'), 'Project');
  for (const name of ['main', 'custom']) {
    const directory = path.join(root, '.alp', 'agents', name);
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'AGENT.md'), name);
    const agent = await resolveAgent(root, { agent: name });
    const before = JSON.stringify(agent);
    const result = await compileAgent(new FakeAdapter(), agent);
    assert.equal(result.agentName, name); assert.equal(result.material.instructions, `Project\n\n${name}`);
    assert.equal(JSON.stringify(agent), before);
    const unsupported = { ...agent, hooks: [{ name: 'start', path: path.join(root, 'start') }] };
    await assert.rejects(compileAgent(new FakeAdapter(), unsupported), { code: 'UNSUPPORTED_CAPABILITY' });
    await assert.rejects(compileAgent({ id: 'bad', capabilities: () => ({}), compile() {} }, agent), { code: 'INVALID_CAPABILITIES' });
    const invalid = new FakeAdapter(); invalid.compile = async () => ({});
    await assert.rejects(compileAgent(invalid, agent), { code: 'INVALID_COMPILED_AGENT' });
  }
});
test('core import graph contains only node builtins and core-relative modules', async () => {
  const directory = new URL('../src/core/', import.meta.url);
  for (const file of await readdir(directory)) {
    if (!/\.(js|ts)$/.test(file)) continue;
    const source = await readFile(new URL(file, directory), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('node:') || /^\.\/[^/]+$/.test(match[1]), `${file} imports ${match[1]}`);
    }
  }
});
