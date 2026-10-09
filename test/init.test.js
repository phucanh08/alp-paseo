import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initProject } from '../src/core/init.js';
import { resolveAgent, discoverAgents } from '../src/core/resolver.js';
import { seedLibrary } from '../src/core/library.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function entries(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    result.push(name + (entry.isDirectory() ? '/' : ''));
    if (entry.isDirectory()) result.push(...await entries(root, name + '/'));
  }
  return result.sort();
}

test('clean project contains exactly six starter agents with empty skill directories and valid JSON', async t => {
  const root = await fixture(t);
  const library = await fixture(t);
  await seedLibrary(library);
  assert.equal((await initProject(root)).created.length, 14);
  assert.deepEqual(await entries(root), [
    'ALP.md', '.alp/', '.alp/settings.json', '.alp/agents/',
    ...['main', 'lead', 'peer', 'oracle', 'reviewer', 'supervisor'].flatMap(name => ['', 'AGENT.md', '.mcp.json', 'skills/', 'hooks/'].map(file => `.alp/agents/${name}/${file}`)),
  ].sort());
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8')), { defaultAgent: 'main', workflow: { mode: 'pho', maxPeers: 2 } });
  assert.deepEqual(await discoverAgents(root), ['lead', 'main', 'oracle', 'peer', 'reviewer', 'supervisor']);
  for (const agent of ['main', 'lead', 'peer']) {
    const resolved = await resolveAgent(root, { agent, library });
    assert.equal(resolved.name, agent);
    assert.deepEqual(resolved.mcp, { mcpServers: {} });
    assert.ok(resolved.skills.some(skill => skill.name === 'xia'));
    assert.equal(resolved.skills.some(skill => skill.name === 'ask-alp'), false);
    assert.deepEqual(await readdir(path.join(root, `.alp/agents/${agent}/hooks`)), []);
  }
});

test('partial initialization and repeated runs preserve all user content', async t => {
  const root = await fixture(t);
  const custom = {
    'ALP.md': 'My project\r\n',
    '.alp/settings.json': '{"defaultAgent":"custom"}',
    '.alp/agents/main/AGENT.md': 'My main instructions',
    '.alp/agents/main/.mcp.json': '{"mcpServers":{"local":{"command":"demo"}}}',
    '.alp/agents/main/skills/custom/SKILL.md': 'My skill',
    '.alp/agents/custom/AGENT.md': 'Custom agent',
  };
  for (const [name, content] of Object.entries(custom)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  await rm(path.join(root, '.alp/agents/main/.mcp.json'));
  assert.deepEqual((await initProject(root)).created, ['.alp/agents/main/.mcp.json', '.alp/agents/lead/AGENT.md', '.alp/agents/lead/.mcp.json', '.alp/agents/peer/AGENT.md', '.alp/agents/peer/.mcp.json', '.alp/agents/oracle/AGENT.md', '.alp/agents/oracle/.mcp.json', '.alp/agents/reviewer/AGENT.md', '.alp/agents/reviewer/.mcp.json', '.alp/agents/supervisor/AGENT.md', '.alp/agents/supervisor/.mcp.json']);
  await writeFile(path.join(root, '.alp/agents/main/.mcp.json'), custom['.alp/agents/main/.mcp.json']);
  assert.deepEqual((await initProject(root)).created, []);
  for (const [name, content] of Object.entries(custom)) {
    assert.equal(await readFile(path.join(root, name), 'utf8'), content);
  }
  assert.deepEqual(await readdir(path.join(root, '.alp/agents/main/hooks')), []);
});

test('conflicting directory path fails without replacing the existing file', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '.alp'), 'keep');
  await assert.rejects(initProject(root), /Expected a directory/);
  assert.equal(await readFile(path.join(root, '.alp'), 'utf8'), 'keep');
});

test('directory at a scaffold file path fails safely', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'ALP.md'));
  await writeFile(path.join(root, 'ALP.md/keep'), 'keep');
  await assert.rejects(initProject(root), /Expected a regular file/);
  assert.equal(await readFile(path.join(root, 'ALP.md/keep'), 'utf8'), 'keep');
});

test('CLI supports cwd and explicit new directory, and rejects invalid usage', async t => {
  const root = await fixture(t);
  const home = await fixture(t);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
  assert.match(run('init').stdout, /Skill library .*: \d+ files added/);
  assert.ok(JSON.parse(await readFile(path.join(home, 'role-skills.json'), 'utf8')).main.includes('xia'));
  const again = run('init');
  assert.match(again.stdout, /0 files created, 14 existing files preserved/);
  assert.doesNotMatch(again.stdout, /Skill library/);
  assert.equal(run('init', 'nested project').status, 0);
  assert.equal(JSON.parse(await readFile(path.join(root, 'nested project/.alp/settings.json'), 'utf8')).defaultAgent, 'main');
  assert.equal(run('unknown').status, 1);
  assert.equal(run('init', 'a', 'b').status, 1);
  await writeFile(path.join(root, 'blocked'), 'keep');
  const failed = run('init', 'blocked');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /ALP initialization failed/);
});
