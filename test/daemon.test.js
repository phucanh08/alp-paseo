import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/core/init.js';
import { connect, daemonPaths, ensureDaemon, readLock, PROTOCOL_VERSION } from '../src/client/index.js';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer } from '../dist/daemon/server.js';

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

function fakeTransport(runtimes) {
  return () => {
    const index = runtimes.length;
    const runtime = {
      calls: [], closed: false, threadId: `thread-${index}`, turnId: `turn-${index}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') return { turn: { id: this.turnId } };
        return {};
      },
      call(tool, args) {
        return this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}`, namespace: null, tool, arguments: args });
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes) });
  const socketPath = path.join(directory, 's.sock');
  const server = createDaemonServer({ runtime, socketPath, version: 'test' });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  const clients = [];
  const open = async () => {
    const client = await connect(socketPath, { name: 'test', version: '0' });
    const events = [];
    client.onEvent(envelope => events.push(envelope));
    clients.push(client);
    return { client, events };
  };
  t.after(() => clients.forEach(client => client.close()));
  return { project, runtimes, runtime, socketPath, open };
}

const types = (events, sessionId) => events.filter(e => !sessionId || e.sessionId === sessionId).map(e => e.event.type);
const text = body => [{ type: 'text', text: body }];

test('handshake is required and versioned', async t => {
  const { socketPath } = await setup(t);
  const { AlpClient } = await import('../src/client/index.js');
  const net = await import('node:net');
  const raw = new AlpClient(net.createConnection(socketPath));
  t.after(() => raw.close());
  await assert.rejects(raw.request('session.list'), { code: 1006 });
  await assert.rejects(raw.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION + 1 }), { code: 1006 });
  assert.equal((await raw.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION })).protocolVersion, PROTOCOL_VERSION);
  await assert.rejects(raw.request('session.nope'), { code: -32601 });
  await assert.rejects(raw.request('session.get', { sessionId: 'missing' }), { code: 1001 });
});

test('a client creates, prompts and receives the events of its whole tree over the socket', async t => {
  const { project, runtimes, open } = await setup(t);
  const { client, events } = await open();
  const { session } = await client.request('session.create', { spec: { cwd: project, persist: true } });
  assert.match(session.id, /^ses_[0-9a-f]{16}$/);
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Delegate') });
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', task: 'Investigate' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  runtimes[1].finish('lead proof');
  assert.equal(JSON.parse((await lead).contentItems[0].text).output, 'lead proof');
  await until(() => events.some(e => e.event.type === 'session.closed'));
  const child = events.find(e => e.event.type === 'session.opened' && e.event.session.parentId === session.id);
  assert.ok(child, 'child events reach the root client');
  assert.deepEqual(types(events, child.sessionId).slice(0, 3), ['session.opened', 'session.ready', 'item']);
  assert.deepEqual(types(events, session.id).slice(0, 5), ['session.opened', 'session.ready', 'item', 'prompt.accepted', 'turn.started']);
  const listed = await client.request('session.list');
  assert.deepEqual(listed.sessions.map(s => s.id), [session.id]);
});

test('a root keeps working after its client leaves and closes once idle', async t => {
  const { project, runtimes, runtime, open } = await setup(t);
  const first = await open();
  const { session } = await first.client.request('session.create', { sessionId: 'paseo-1', spec: { cwd: project } });
  await first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Work') });
  first.client.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(runtime.snapshot('paseo-1').busy, true);

  // A viewer reopening the same root attaches to the running work instead of starting over.
  const second = await open();
  const reopened = await second.client.request('session.create', { sessionId: 'paseo-1', spec: { cwd: project }, history: 'replay' });
  assert.equal(reopened.attached, true);
  assert.deepEqual(types(second.events), ['session.opened', 'item', 'session.ready', 'turn.started']);
  assert.equal(runtimes.length, 1);

  assert.deepEqual(await second.client.request('session.release', { sessionId: 'paseo-1' }), { closed: false });
  runtimes[0].finish();
  await until(() => runtimes[0].closed);
  assert.equal(runtime.snapshot('paseo-1'), undefined);
});

test('an idle released root closes at once; attach replays the retained tree', async t => {
  const { project, runtimes, open } = await setup(t);
  const { client } = await open();
  const watcher = await open();
  const { session } = await client.request('session.create', { spec: { cwd: project } });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hi') });
  runtimes[0].finish('hello');
  await watcher.client.request('session.attach', { sessionId: session.id });
  assert.deepEqual(types(watcher.events), ['session.opened', 'session.ready', 'item', 'prompt.accepted', 'turn.started', 'item', 'turn.ended']);
  await watcher.client.request('session.release', { sessionId: session.id });
  assert.deepEqual(await client.request('session.release', { sessionId: session.id }), { closed: true });
  assert.equal(runtimes[0].closed, true);
});

test('alpd starts detached, publishes its socket in the lock, and shuts down cleanly', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
  const socket = await ensureDaemon({ home, entry });
  const lock = await readLock(home);
  assert.equal(lock.ready, true);
  assert.equal(lock.socket, daemonPaths(home).socket);
  assert.equal(socket, lock.socket);
  assert.equal(await ensureDaemon({ home, entry }), socket, 'a second start reuses the running daemon');
  const client = await connect(socket);
  const status = await client.request('daemon.status');
  assert.equal(status.pid, lock.pid);
  assert.equal(status.sessions, 0);
  await client.request('daemon.shutdown');
  client.close();
  await until(async () => !(await readLock(home)));
  await assert.rejects(access(socket));
});
