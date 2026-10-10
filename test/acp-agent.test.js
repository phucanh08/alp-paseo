import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { initProject } from '../src/core/init.js';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer } from '../dist/daemon/index.js';
import { createAcpAgent, hostServers, promptText } from '../dist/acp/agent.js';
import { fakeTransport, until } from './support/fake-agent.js';

/** alpd in this process with scripted agents, and an editor that talks to `alp acp`. */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-acp-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  const agents = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(agents), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs') });
  const server = createDaemonServer({ runtime, socketPath: '', version: 'test' });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const editor = () => {
    const updates = [];
    // ndjson both ways, as on stdio.
    const up = new TransformStream();
    const down = new TransformStream();
    createAcpAgent({ version: 'test', connect: async () => server.local() }).connect(acp.ndJsonStream(down.writable, up.readable));
    const connection = acp.client({ name: 'editor' })
      .onNotification('session/update', ({ params }) => { updates.push(params); })
      .connect(acp.ndJsonStream(up.writable, down.readable));
    t.after(() => connection.close());
    const of = (sessionId, kind) => updates.filter(entry => entry.sessionId === sessionId && entry.update.sessionUpdate === kind).map(entry => entry.update);
    return { agent: connection.agent, updates, of };
  };
  return { root, runtime, agents, editor };
}

test('an editor starts an ALP session, chooses its team, and sees main answer and work', async t => {
  const { root, runtime, agents, editor } = await setup(t);
  const { agent, of } = editor();
  const init = await agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  assert.equal(init.agentInfo.name, 'alp');
  assert.equal(init.agentCapabilities.loadSession, true);

  const created = await agent.request('session/new', { cwd: root, mcpServers: [] });
  const team = created.configOptions.find(option => option.id === 'team');
  assert.equal(team.currentValue, 'pho');
  assert.deepEqual(team.options.map(option => option.value).slice(0, 2), ['pho', 'cafe']);
  // Nothing runs until the first prompt.
  assert.equal(agents.length, 0);

  const changed = await agent.request('session/set_config_option', { sessionId: created.sessionId, configId: 'team', value: 'cafe' });
  assert.equal(changed.configOptions.find(option => option.id === 'team').currentValue, 'cafe');
  await agent.request('session/set_config_option', { sessionId: created.sessionId, configId: 'mode', value: 'read-only' });

  const answered = agent.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Run the tests' }, { type: 'resource_link', uri: 'file:///x/a.ts', name: 'a.ts' }] });
  await until(() => agents[0]?.started.length === 1, 'the first turn');
  const main = agents[0];
  assert.equal(runtime.snapshot(created.sessionId).workflow.mode, 'cafe');
  assert.equal(runtime.snapshot(created.sessionId).mode, 'read-only');
  assert.match(main.started[0].params.input.map(part => part.text).join('\n'), /Run the tests @\/x\/a\.ts/);

  main.notification('item/agentMessage/delta', { threadId: main.threadId, itemId: 'a1', delta: 'Running ' });
  main.notification('item/agentMessage/delta', { threadId: main.threadId, itemId: 'a1', delta: 'them.' });
  main.notification('item/started', { threadId: main.threadId, item: { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: root, status: 'inProgress' } });
  main.notification('item/completed', { threadId: main.threadId, item: { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: root, status: 'completed', aggregatedOutput: '300 pass', exitCode: 0 } });
  main.finish('All pass.');
  assert.deepEqual(await answered, { stopReason: 'end_turn' });

  const id = created.sessionId;
  assert.deepEqual(of(id, 'agent_message_chunk').map(update => update.content.text), ['Running ', 'them.', 'All pass.']);
  // The user's own words are the editor's already.
  assert.equal(of(id, 'user_message_chunk').length, 0);
  const [started] = of(id, 'tool_call');
  assert.equal(started.title, 'npm test');
  assert.equal(started.kind, 'execute');
  assert.equal(of(id, 'tool_call_update').at(-1).status, 'completed');
  assert.equal(of(id, 'tool_call_update').at(-1).content[0].content.text, '300 pass');
  assert.equal(of(id, 'available_commands_update').length, 1);

  // Open now: the team is fixed.
  await assert.rejects(agent.request('session/set_config_option', { sessionId: id, configId: 'team', value: 'pho' }), /keeps its team/);
});

test('a question from the team reaches the editor and /answer replies to it', async t => {
  const { root, agents, editor } = await setup(t);
  const { agent, of } = editor();
  await agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await agent.request('session/new', { cwd: root, mcpServers: [] });
  const first = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Build it' }] });
  await until(() => agents[0]?.started.length === 1);
  const main = agents[0];
  const asked = main.call('alp_ask', { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'] });
  await until(() => of(sessionId, 'agent_message_chunk').some(update => /main asks you:\*\* Postgres or SQLite\?/.test(update.content.text)), 'the question');
  assert.deepEqual(await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/answer SQLite' }] }), { stopReason: 'end_turn' });
  assert.equal((await asked).answer, 'SQLite');
  main.finish();
  await first;
});

test('cancel stops the turn; another editor lists the session and loads its history', async t => {
  const { root, agents, editor } = await setup(t);
  const first = editor();
  await first.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await first.agent.request('session/new', { cwd: root, mcpServers: [] });
  const done = first.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Say hi' }] });
  await until(() => agents[0]?.started.length === 1);
  agents[0].finish('Hi there');
  await done;
  const stopped = first.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Now a long job' }] });
  await until(() => agents[0].started.length === 2);
  await first.agent.notify('session/cancel', { sessionId });
  assert.deepEqual(await stopped, { stopReason: 'cancelled' });

  const second = editor();
  await second.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessions } = await second.agent.request('session/list', { cwd: root });
  assert.deepEqual(sessions.map(session => [session.sessionId, session.title]), [[sessionId, 'Say hi']]);
  await second.agent.request('session/load', { sessionId, cwd: root, mcpServers: [] });
  assert.deepEqual(second.of(sessionId, 'user_message_chunk').map(update => update.content.text), ['Say hi', 'Now a long job']);
  assert.ok(second.of(sessionId, 'agent_message_chunk').some(update => update.content.text === 'Hi there'));
  await assert.rejects(second.agent.request('session/load', { sessionId, cwd: path.dirname(root), mcpServers: [] }), /another project/);
});

test('prompt content and MCP servers from the editor become ALP\'s', () => {
  assert.equal(promptText([{ type: 'text', text: 'Fix' }, { type: 'resource', resource: { uri: 'file:///p/a.ts', text: 'let a;' } }]), 'Fix\n<file path="/p/a.ts">\nlet a;\n</file>');
  assert.deepEqual(hostServers([
    { name: 'files', command: 'mcp-files', args: ['--root', '/p'], env: [{ name: 'TOKEN', value: 't' }] },
    { type: 'http', name: 'docs', url: 'https://docs.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
  ]), {
    files: { type: 'stdio', command: 'mcp-files', args: ['--root', '/p'], env: { TOKEN: 't' } },
    docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer x' } },
  });
});
