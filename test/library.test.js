import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initProject } from '../src/core/init.js';
import { upgradeProject } from '../src/core/upgrade.js';
import { agentSources, libraryEntries, resolveAgent } from '../src/core/resolver.js';
import { legacyProject } from './support/legacy.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function files(root, entries) {
  for (const [name, content] of Object.entries(entries)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
}
const template = name => readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');

test('an agent comes from the built-ins, then the library, then the project, and the later one wins whole', async t => {
  const [root, library] = [await fixture(t), await fixture(t)];
  await initProject(root);
  assert.equal((await resolveAgent(root, { library })).instructions.agent, await template('agents/main/AGENT.md'));
  await files(library, { 'agents/main/AGENT.md': 'Library main', 'agents/main/agent.json': { description: 'My main', model: 'library-model' }, 'agents/scout/AGENT.md': 'Scout', 'agents/draft/notes.txt': 'no instructions' });
  let main = await resolveAgent(root, { library });
  assert.deepEqual([main.source, main.instructions.agent, main.description, main.runtime.model], ['library', 'Library main', 'My main', 'library-model']);
  // A library directory without AGENT.md is not an agent.
  assert.deepEqual([...(await agentSources(root, { library })).keys()].sort(), ['lead', 'main', 'oracle', 'peer', 'reviewer', 'scout', 'supervisor']);
  await files(root, { '.alp/agents/main/AGENT.md': 'Project main' });
  main = await resolveAgent(root, { library });
  // The project's main replaces the library's whole: its agent.json does not carry over.
  assert.deepEqual([main.source, main.instructions.agent, main.description, main.runtime.model], ['project', 'Project main', undefined, undefined]);
  assert.deepEqual((await libraryEntries('agents', root, { library })).filter(row => row.source !== 'builtin'), [
    { name: 'main', source: 'project', path: path.join(root, '.alp/agents/main'), overrides: 'library' },
    { name: 'scout', source: 'library', path: path.join(library, 'agents/scout') },
  ]);
  assert.equal((await libraryEntries('agents', root, { library })).find(row => row.name === 'lead').source, 'builtin');
});

test('agent.json picks the runtime and mode and names skills, MCP servers and hooks; the project entry wins', async t => {
  const [root, library] = [await fixture(t), await fixture(t)];
  await initProject(root);
  await files(library, {
    'skills/style/SKILL.md': 'Library style',
    'skills/review/SKILL.md': 'Library review',
    'mcp/docs.json': { url: 'https://example.test/mcp' },
    'hooks/notify.json': { event: 'turn.end', command: 'say done' },
    'agents/writer/AGENT.md': 'Write',
    'agents/writer/agent.json': { provider: 'claude', model: 'claude-sonnet-5-5', thinking: 'medium', mode: 'workspace-write', skills: ['style', 'review'], mcp: ['docs', 'local'], hooks: ['notify', 'tests'] },
  });
  await files(root, {
    '.alp/skills/review/SKILL.md': 'Project review',
    '.alp/mcp/local.json': { command: 'node', args: ['server.js'] },
    '.alp/hooks/tests.json': { event: 'handoff', command: 'npm test', blocking: true, timeoutSec: 600 },
  });
  const writer = await resolveAgent(root, { agent: 'writer', library });
  assert.deepEqual([writer.runtime.provider, writer.runtime.model, writer.runtime.reasoning, writer.mode], ['claude', 'claude-sonnet-5-5', 'medium', 'workspace-write']);
  assert.deepEqual(writer.skills.map(skill => [skill.name, skill.path]), [['review', path.join(root, '.alp/skills/review/SKILL.md')], ['style', path.join(library, 'skills/style/SKILL.md')]]);
  assert.deepEqual(Object.keys(writer.mcp.mcpServers), ['docs', 'local']);
  assert.equal(writer.mcp.mcpServers.local.command, 'node');
  assert.deepEqual(writer.hooks.map(hook => [hook.name, hook.path]), [['notify', path.join(library, 'hooks/notify.json')], ['tests', path.join(root, '.alp/hooks/tests.json')]]);
  const skills = await libraryEntries('skills', root, { library });
  assert.deepEqual(skills.map(row => [row.name, row.source, row.overrides, row.usedBy]), [['review', 'project', 'library', ['writer']], ['style', 'library', undefined, ['writer']]]);
  assert.deepEqual((await libraryEntries('hooks', root, { library })).map(row => [row.name, row.source]), [['notify', 'library'], ['tests', 'project']]);
});

test('a reference that does not resolve, or a malformed definition, fails with its file named', async t => {
  const [root, library] = [await fixture(t), await fixture(t)];
  await initProject(root);
  const agent = config => files(root, { '.alp/agents/writer/AGENT.md': 'Write', '.alp/agents/writer/agent.json': config });
  const resolve = () => resolveAgent(root, { agent: 'writer', library });
  for (const [config, code] of [[{ skills: ['absent'] }, 'SKILL_NOT_FOUND'], [{ mcp: ['absent'] }, 'MCP_NOT_FOUND'], [{ hooks: ['absent'] }, 'HOOK_NOT_FOUND']]) {
    await agent(config);
    await assert.rejects(resolve(), error => error.code === code && error.message.includes(path.join(root, '.alp/agents/writer/agent.json')));
  }
  await agent({ modle: 'x' });
  await assert.rejects(resolve(), /unknown setting 'modle'; did you mean 'mode'\?/);
  await agent({ mode: 'danger' });
  await assert.rejects(resolve(), { code: 'INVALID_AGENT_CONFIG' });
  await agent({ skills: ['../escape'] });
  await assert.rejects(resolve(), { code: 'INVALID_AGENT_CONFIG' });
  await writeFile(path.join(root, '.alp/agents/writer/agent.json'), '{');
  await assert.rejects(resolve(), { code: 'INVALID_AGENT_CONFIG' });
  // A hook ALP cannot run is refused before any session uses it.
  await agent({ hooks: ['notify'] });
  for (const [hook, pattern] of [[{ event: 'turn.end', command: 'x', blocking: true }, /only handoff, task.close, merge hooks can block/], [{ event: 'commit', command: 'x' }, /event must be one of/], [{ event: 'merge' }, /command must be/], [{ event: 'merge', command: 'x', timeoutSec: 0 }, /timeoutSec/], [{ event: 'merge', command: 'x', blockng: true }, /did you mean 'blocking'/]]) {
    await files(root, { '.alp/hooks/notify.json': hook });
    await assert.rejects(resolve(), error => error.code === 'INVALID_HOOK' && pattern.test(error.message) && error.message.includes('notify.json'));
  }
  // A server named in agent.json and again in the agent's .mcp.json is ambiguous.
  await files(root, { '.alp/mcp/docs.json': { url: 'https://example.test/mcp' }, '.alp/agents/writer/.mcp.json': { mcpServers: { docs: { command: 'node' } } } });
  await agent({ mcp: ['docs'] });
  await assert.rejects(resolve(), /MCP server 'docs' is also named/);
});

test('upgrade keeps a shipped copy the user added to, brings its instructions up to date, and puts the rest away', async t => {
  const root = await fixture(t);
  await legacyProject(root);
  const legacy = '# Main agent\n\nHelp with tasks in this project.\n';
  await writeFile(path.join(root, '.alp/agents/main/AGENT.md'), legacy);
  await writeFile(path.join(root, '.alp/agents/main/.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node' } } }));
  const result = await upgradeProject(root);
  assert.deepEqual(result.updated, ['.alp/agents/main/AGENT.md']);
  assert.deepEqual(result.removed, ['lead', 'peer', 'oracle', 'reviewer', 'supervisor'].map(name => `.alp/agents/${name}`));
  assert.equal(await readFile(path.join(root, '.alp/agents/main/AGENT.md'), 'utf8'), await template('agents/main/AGENT.md'));
  assert.equal(await readFile(path.join(result.backup, '.alp/agents/main/AGENT.md'), 'utf8'), legacy);
  assert.deepEqual(await readdir(path.join(root, '.alp/agents')), ['main']);
  assert.deepEqual(Object.keys((await resolveAgent(root)).mcp.mcpServers), ['local']);
  const again = await upgradeProject(root);
  assert.deepEqual([again.updated, again.removed], [[], []]);
});

test('alp agents, skills, mcp and hooks list each entry with its source', async t => {
  const [root, home] = [await fixture(t), await fixture(t)];
  await initProject(root);
  await files(home, { 'mcp/docs.json': { url: 'https://example.test/mcp' } });
  await files(root, { '.alp/mcp/docs.json': { command: 'node' }, '.alp/agents/main/AGENT.md': 'Mine', '.alp/agents/main/agent.json': { mcp: ['docs'] } });
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
  const agents = run('agents');
  assert.equal(agents.status, 0, agents.stderr);
  assert.match(agents.stdout, /^main\s+project\s+overrides the built-in one$/m);
  assert.match(agents.stdout, /^lead\s+built-in$/m);
  assert.deepEqual(JSON.parse(run('mcp', '--json').stdout), [{ name: 'docs', source: 'project', path: path.join(root, '.alp/mcp/docs.json'), overrides: 'library', usedBy: ['main'] }]);
  assert.match(run('hooks').stdout, /^No hooks in /);
  assert.equal(run('skills', 'extra').status, 1);
});
