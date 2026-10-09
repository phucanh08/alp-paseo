import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initProject } from '../src/core/init.js';
import { runHook } from '../src/core/hook-run.js';
import { probeMcp } from '../src/client/mcp-probe.js';
import { saveEntry } from '../src/core/library-edit.js';
import contribute from '../plugins/paseo/server/dist/index.js';

const fakeMcp = fileURLToPath(new URL('./support/fake-mcp.js', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a hook gets the event on stdin and ALP variables, and is stopped at its timeout', async t => {
  const cwd = await fixture(t);
  const ran = await runHook({ command: 'cat > event.json; echo "$ALP_EVENT $ALP_AGENT $PWD"; echo warn >&2; exit 2' }, { event: 'handoff', n: 1 }, { cwd, env: { ALP_EVENT: 'handoff', ALP_AGENT: 'peer' } });
  assert.deepEqual([ran.exitCode, ran.timedOut, ran.stderr], [2, false, 'warn\n']);
  assert.match(ran.stdout, /^handoff peer .*alp-tools-/);
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd, 'event.json'), 'utf8')), { event: 'handoff', n: 1 });
  // The shell's children are stopped with it: a forked sleep would otherwise hold the output open.
  const slow = await runHook({ command: 'sleep 5; echo late' }, {}, { cwd, timeoutMs: 100 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.signal, 'SIGTERM');
  assert.ok(slow.durationMs < 3000, `took ${slow.durationMs} ms`);
  // A background process does not keep a finished hook waiting.
  const spawned = await runHook({ command: 'sleep 5 & echo started' }, {}, { cwd });
  assert.deepEqual([spawned.exitCode, spawned.stdout], [0, 'started\n']);
  assert.ok(spawned.durationMs < 3000, `took ${spawned.durationMs} ms`);
});

test('an MCP server is started, asked for its tools over stdio or HTTP, and stopped', async t => {
  const cwd = await fixture(t);
  assert.deepEqual(await probeMcp({ command: process.execPath, args: [fakeMcp] }, { cwd }), { server: { name: 'fake-mcp', version: '1.2.3' }, tools: [{ name: 'search', description: 'Search the docs' }, { name: 'fetch' }] });
  await assert.rejects(probeMcp({ command: process.execPath, args: [fakeMcp], env: { FAKE_MCP_FAIL: '1' } }, { cwd }), /exited \(4\): fake-mcp: cannot start/);
  await assert.rejects(probeMcp({ command: 'alp-no-such-command' }, { cwd }), /ENOENT/);
  // Streamable HTTP: JSON for initialize, server-sent events for tools/list, one session id throughout.
  const seen = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push([request.method, request.headers['mcp-session-id'] ?? null, request.headers.authorization ?? null]);
    if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    if (message.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'abc' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'http-mcp' } } }));
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'remote' }] } })}\n\n`);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  assert.deepEqual(await probeMcp({ url, headers: { Authorization: 'Bearer t' } }), { server: { name: 'http-mcp', version: undefined }, tools: [{ name: 'remote' }] });
  assert.deepEqual(seen, [['POST', null, 'Bearer t'], ['POST', 'abc', 'Bearer t'], ['POST', 'abc', 'Bearer t'], ['DELETE', 'abc', 'Bearer t']]);
});

test('the settings screen edits the library and the project through alp.library RPC', async t => {
  const [directory, home] = [await fixture(t), await fixture(t)];
  const root = path.join(directory, 'project');
  await initProject(root);
  const previous = { home: process.env.ALP_HOME, supervise: process.env.ALP_SUPERVISE };
  process.env.ALP_HOME = home;
  process.env.ALP_SUPERVISE = '0';
  const handlers = new Map();
  const dispose = contribute({ registerProvider() {}, handle: (contract, handler) => handlers.set(contract.name, { contract, handler }) });
  t.after(async () => {
    await dispose();
    for (const [key, value] of [['ALP_HOME', previous.home], ['ALP_SUPERVISE', previous.supervise]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  // Like the SDK's callPluginRpc: input and output are checked against the shared contract.
  const call = async (name, input) => {
    const { contract, handler } = handlers.get(`alp.library.${name}`);
    return contract.output.parseAsync(await handler(await contract.input.parseAsync(input), {}));
  };
  const listed = await call('list', { directory: path.join(root, '.alp'), kind: 'agents' });
  assert.equal(listed.projectRoot, root);
  assert.equal(listed.library, home);
  assert.ok(listed.entries.some(row => row.name === 'main' && row.source === 'builtin'));
  const main = await call('get', { kind: 'agents', name: 'main' });
  assert.equal(main.source, 'builtin');
  await call('duplicate', { kind: 'agents', from: 'main', to: 'architect', scope: 'library' });
  const architect = await call('get', { kind: 'agents', name: 'architect', scope: 'library' });
  const saved = await call('save', { kind: 'agents', name: 'architect', scope: 'library', content: { ...architect.content, config: { description: 'Plans' } }, revision: architect.revision });
  await assert.rejects(call('save', { kind: 'agents', name: 'architect', scope: 'library', content: architect.content, revision: architect.revision }), { code: 'REVISION_CONFLICT' });
  // Overriding in the project, then using the library again.
  await call('save', { directory: root, kind: 'agents', name: 'architect', scope: 'project', content: { instructions: 'Project architect' }, revision: null });
  assert.deepEqual((await call('get', { directory: root, kind: 'agents', name: 'architect' })).overrides, 'library');
  assert.deepEqual(await call('delete', { directory: root, kind: 'agents', name: 'architect', scope: 'project' }), { removed: true, now: 'library' });
  await assert.rejects(call('save', { kind: 'agents', name: 'x', scope: 'project', content: { instructions: 'x' } }), { code: 'INVALID_SCOPE' });
  await call('rename', { kind: 'agents', from: 'architect', to: 'planner', scope: 'library' });
  assert.equal((await call('get', { kind: 'agents', name: 'planner' })).revision, saved.revision);
  // Testing a hook and an MCP server.
  await saveEntry('hooks', 'check', { hook: { event: 'handoff', command: 'echo "$ALP_EVENT"; exit 1', blocking: true } }, { library: home, scope: 'library' });
  const hook = await call('test', { directory: root, kind: 'hooks', name: 'check' });
  assert.deepEqual([hook.ok, hook.exitCode, hook.wouldBlock, hook.stdout], [false, 1, true, 'handoff\n']);
  await saveEntry('mcp', 'fake', { server: { command: process.execPath, args: [fakeMcp] } }, { library: home, scope: 'library' });
  const mcp = await call('test', { kind: 'mcp', name: 'fake' });
  assert.deepEqual([mcp.ok, mcp.tools.map(tool => tool.name)], [true, ['search', 'fetch']]);
});

test('alp agent, team, skill, mcp and hook create, change, copy, rename, test and remove entries', async t => {
  const [root, home] = [await fixture(t), await fixture(t)];
  await initProject(root);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
  const ok = (...args) => { const result = run(...args); assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`); return result.stdout; };
  assert.match(ok('agent', 'new', 'writer', '-d', 'Docs writer', '--model', 'claude:claude-sonnet-5-5'), /Created writer in your library/);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'agents/writer/agent.json'), 'utf8')), { description: 'Docs writer', model: 'claude:claude-sonnet-5-5' });
  await writeFile(path.join(root, 'rules.md'), 'Every page gets a review.\n');
  ok('skill', 'new', 'style', '--project');
  ok('agent', 'edit', 'writer', '--skills', 'style', '--project');
  // Editing a library agent in the project makes the project's override.
  assert.match(ok('agents'), /^writer\s+project\s+overrides the library one/m);
  ok('mcp', 'add', 'fake', '--command', process.execPath, '--arg', fakeMcp);
  assert.match(ok('mcp', 'test', 'fake'), /fake: fake-mcp 1\.2\.3 offers 2 tools:\n {2}search {2}Search the docs\n {2}fetch/);
  ok('hook', 'add', 'gate', '--event', 'handoff', '--command', 'exit 0', '--blocking', '--timeout', '30');
  assert.match(ok('hook', 'test', 'gate'), /gate: exit 0 in \d+ ms/);
  ok('team', 'new', 'docs', '--project', '--from', 'pho', '--label', 'Docs', '--main', 'writer', '--member', 'reviewer=reviewer', '--member-model', 'writer=claude:claude-opus-5-5', '--delegate', 'writer=reviewer', '--no-supervisor', '--rules', 'rules.md');
  const team = JSON.parse(ok('team', 'show', 'docs', '--json'));
  assert.deepEqual(team.content.team, { label: 'Docs', description: 'Main implements or delegates to peer; a supervisor reviews the process.', main: 'writer', members: { writer: { model: 'claude:claude-opus-5-5' }, reviewer: { role: 'reviewer' } }, delegation: { writer: ['reviewer'] }, maxPeers: 2, supervisor: false });
  assert.equal(team.content.houseRules, 'Every page gets a review.\n');
  // The library's writer is the last of its name below the project, and team docs uses it.
  const used = run('agent', 'rm', 'writer');
  assert.equal(used.status, 1);
  assert.match(used.stderr, /used by team docs/);
  ok('team', 'mv', 'docs', 'writing', '--project');
  ok('team', 'rm', 'writing', '--project');
  assert.match(ok('agent', 'rm', 'writer', '--project'), /the library one applies again/);
  ok('agent', 'cp', 'writer', 'editor');
  assert.match(ok('agents', '--json'), /"name":"editor","source":"library"/);
  const builtin = run('agent', 'rm', 'main');
  assert.match(builtin.stderr, /No agents entry 'main' in the library/);
  assert.equal(run('agent', 'frob', 'x').status, 1);
});
