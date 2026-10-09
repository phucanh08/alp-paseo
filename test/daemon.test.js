import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath as realpathOf } from 'node:fs/promises';
import { initProject } from '../src/core/init.js';
import { connect, daemonPaths, ensureDaemon, findDaemonEntry, readLock, PROTOCOL_VERSION } from '../src/client/index.js';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer, createStore } from '../dist/daemon/index.js';

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
        if (method === 'turn/start') { await this.hold; return { turn: { id: this.turnId } }; }
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
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Investigate' });
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
  assert.equal(JSON.parse(await readFile(daemonPaths(home).install, 'utf8')).entry, entry, 'alpd records where it is installed');
  await client.request('daemon.shutdown');
  client.close();
  await until(async () => !(await readLock(home)));
  await assert.rejects(access(socket));

  // A client that cannot locate alpd (the Paseo plugin) starts it from the recorded location.
  const restarted = await ensureDaemon({ home, env: { ...process.env, PATH: '' } });
  const again = await connect(restarted);
  await again.request('daemon.shutdown');
  again.close();
  await until(async () => !(await readLock(home)));
});

test('alpd tells a clean stop from a crash by the marker it keeps while running', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
  const marker = path.join(home, 'state', 'alpd.running');
  const status = async () => {
    const client = await connect(await ensureDaemon({ home, entry }));
    try { return await client.request('daemon.status'); } finally { client.close(); }
  };
  assert.deepEqual((await status()).previousExit, { kind: 'clean' });
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).pid, (await readLock(home)).pid);
  const client = await connect((await readLock(home)).socket);
  await client.request('daemon.shutdown');
  client.close();
  await until(async () => !(await readLock(home)));
  await assert.rejects(access(marker), 'a clean stop removes the marker last');

  assert.deepEqual((await status()).previousExit, { kind: 'clean' });
  // The alpd of this test's own home, killed as a crash would.
  const { pid } = await readLock(home);
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).pid, pid);
  process.kill(pid, 'SIGKILL');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  const after = await status();
  assert.equal(after.previousExit.kind, 'crash');
  assert.ok(Date.parse(after.previousExit.at) > 0);
  const last = await connect((await readLock(home)).socket);
  await last.request('daemon.shutdown');
  last.close();
  await until(async () => !(await readLock(home)));
});

test('finds alpd through the ALP CLI on PATH', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'lib', 'alp');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'dist'));
  await mkdir(path.join(directory, 'bin'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@anhlp/alp' }));
  await writeFile(path.join(root, 'src', 'cli.js'), '');
  await writeFile(path.join(root, 'dist', 'alpd.js'), '');
  await symlink(path.join(root, 'src', 'cli.js'), path.join(directory, 'bin', 'alp'));
  const home = path.join(directory, 'home');
  assert.equal(await findDaemonEntry({ home, env: { PATH: path.join(directory, 'bin') } }), await realpathOf(path.join(root, 'dist', 'alpd.js')));
  assert.equal(await findDaemonEntry({ home, env: { PATH: path.join(directory, 'bin') }, candidates: [undefined, path.join(root, 'src', 'cli.js')] }), path.join(root, 'src', 'cli.js'));
});

/** A daemon over a durable store; `stop(false)` abandons it without a clean shutdown, like a crash. */
async function durable(t, directory, project, runtimes) {
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(directory, 'runs') });
  const store = createStore(path.join(directory, 'state'));
  const socketPath = path.join(directory, `d${runtimes.length}.sock`);
  const server = createDaemonServer({ runtime, socketPath, version: 'test', store, runLogDir: path.join(directory, 'runs') });
  await server.listen();
  const client = await connect(socketPath);
  const events = [];
  client.onEvent(envelope => events.push(envelope));
  let stopped = false;
  const stop = async (clean = true) => {
    if (stopped) return;
    stopped = true;
    client.close();
    if (clean) { await server.close(); await runtime.shutdown(); } else { await store.flush(); await server.close(); }
  };
  cleanupsOf(t).push(async () => { await stop(); await runtime.shutdown(); await store.flush(); });
  return { client, events, store, stop };
}

/** Teardown in reverse order, so daemons stop before their directory is removed. */
const cleanups = new WeakMap();
const cleanupsOf = t => {
  if (!cleanups.has(t)) {
    cleanups.set(t, []);
    t.after(async () => { for (const cleanup of cleanups.get(t).reverse()) await cleanup(); });
  }
  return cleanups.get(t);
};

async function durableProject(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-'));
  cleanupsOf(t).push(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  return { directory, project };
}

test('sessions survive a daemon restart and resume with their history', async t => {
  const { directory, project } = await durableProject(t);
  const runtimes = [];
  const first = await durable(t, directory, project, runtimes);
  const { session } = await first.client.request('session.create', { spec: { cwd: project, persist: true } });
  await first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Remember ORCHID') });
  runtimes[0].finish('Noted');
  await until(() => first.events.some(e => e.event.type === 'turn.ended'));
  await first.stop();

  const second = await durable(t, directory, project, runtimes);
  const { sessions } = await second.client.request('session.list', { includeClosed: true });
  assert.deepEqual(sessions.map(s => [s.id, s.status, s.title]), [[session.id, 'closed', 'Remember ORCHID']]);
  const resumed = await second.client.request('session.create', { sessionId: session.id, spec: { cwd: project }, history: 'replay' });
  assert.equal(resumed.resumed, true);
  const resumeCall = runtimes[1].calls.find(c => c.method === 'thread/resume');
  assert.equal(resumeCall.params.threadId, 'thread-0');
  const replayed = second.events.filter(e => e.event.type === 'item').map(e => e.event.item.text);
  assert.deepEqual(replayed, ['Remember ORCHID', 'Noted']);
  assert.equal((await second.client.request('session.get', { sessionId: session.id })).session.status, 'idle');
});

test('after a crash the next daemon reopens a root that was working; an assignment it cannot continue fails', async t => {
  const { directory, project } = await durableProject(t);
  const runtimes = [];
  const first = await durable(t, directory, project, runtimes);
  const { session } = await first.client.request('session.create', { spec: { cwd: project, persist: true } });
  await first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Delegate') });
  void runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Work' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start') && first.events.some(e => e.event.type === 'session.opened' && e.event.session.parentId));
  const child = first.events.find(e => e.event.type === 'session.opened' && e.event.session.parentId).sessionId;
  await first.stop(false);

  // This runtime keeps running assignments in memory only, so the lead cannot continue.
  const before = runtimes.length;
  const second = await durable(t, directory, project, runtimes);
  await until(() => runtimes[before]?.calls.some(c => c.method === 'turn/start'));
  const reopened = runtimes[before];
  assert.equal(reopened.calls[0].method, 'thread/resume');
  assert.match(reopened.calls.find(c => c.method === 'turn/start').params.input.at(-1).text, /alpd restarted during your turn, and reopened this session\. Continue the user's request/);
  const { sessions } = await second.client.request('session.list', { includeClosed: true });
  assert.equal(sessions.find(s => s.id === session.id).status, 'running');
  assert.equal(sessions.find(s => s.id === child).status, 'closed');
  const runLog = (await readFile(path.join(directory, 'runs', `${session.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(runLog.some(entry => entry.event === 'assignment.finished' && entry.assignmentId === child && entry.status === 'failed' && entry.reconciled));
  const timeline = await second.store.timeline(session.id);
  assert.ok(timeline.some(e => e.sessionId === session.id && e.event.type === 'turn.ended' && e.event.state === 'failed'));
  // A client opening it attaches to the reopened root.
  assert.equal((await second.client.request('session.create', { sessionId: session.id, spec: { cwd: project } })).attached, true);
});

test('closed trees older than 30 days are pruned at startup', async t => {
  const { directory, project } = await durableProject(t);
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const store = createStore(path.join(directory, 'state'));
  await store.put({ version: 1, id: 'old-root', rootId: 'old-root', status: 'closed', createdAt: old, updatedAt: old });
  await store.put({ version: 1, id: 'recent', rootId: 'recent', status: 'closed', createdAt: old, updatedAt: new Date().toISOString() });
  await store.append('old-root', { sessionId: 'old-root', epoch: 'e', seq: 1, ts: old, event: { type: 'session.ready' } });
  await store.flush();
  const runtimes = [];
  const daemon = await durable(t, directory, project, runtimes);
  const { sessions } = await daemon.client.request('session.list', { includeClosed: true });
  assert.deepEqual(sessions.map(s => s.id), []);
  assert.deepEqual((await store.list()).map(r => r.id), ['recent']);
  assert.deepEqual(await store.timeline('old-root'), []);
});

test('resumed history replays a grandchild while its parent is open', async t => {
  const { directory, project } = await durableProject(t);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'], lead: ['peer'] } }));
  const runtimes = [];
  const first = await durable(t, directory, project, runtimes);
  const { session } = await first.client.request('session.create', { spec: { cwd: project, persist: true } });
  await first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Delegate') });
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Work' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const peer = runtimes[1].call('alp_delegate', { agent: 'peer', wait: true, task: 'Work' });
  await until(() => runtimes[2]?.calls.some(c => c.method === 'turn/start'));
  runtimes[2].finish('peer done');
  await peer;
  runtimes[1].finish('lead done');
  await lead;
  runtimes[0].finish('main done');
  await until(() => first.events.some(e => e.sessionId === session.id && e.event.type === 'turn.ended'));
  await first.stop();

  const second = await durable(t, directory, project, runtimes);
  await second.client.request('session.create', { sessionId: session.id, spec: { cwd: project }, history: 'replay' });
  const open = new Set([session.id]);
  for (const { sessionId, event } of second.events) {
    if (event.type === 'session.opened' && event.session.parentId) assert.ok(open.has(event.session.parentId), `${event.session.agent} opened after its parent closed`);
    if (event.type === 'session.opened') open.add(sessionId);
    if (event.type === 'session.closed') open.delete(sessionId);
  }
  assert.deepEqual(second.events.filter(e => e.event.type === 'session.opened').map(e => e.event.session.agent), ['main', 'lead', 'peer']);
});

test('a clientMessageId is delivered once; reuse with other content conflicts', async t => {
  const { directory, project } = await durableProject(t);
  const runtimes = [];
  const daemon = await durable(t, directory, project, runtimes);
  const { session } = await daemon.client.request('session.create', { spec: { cwd: project, persist: true } });
  const prompt = content => daemon.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content });
  const [first, again] = await Promise.all([prompt(text('Hello')), prompt(text('Hello'))]);
  assert.deepEqual([first, again], [{}, { duplicate: true }]);
  assert.equal(runtimes[0].calls.filter(c => c.method === 'turn/start').length, 1);
  await assert.rejects(prompt(text('Other')), error => error.code === 1004 && error.data?.reason === 'key_conflict');
});

test('a prompt cut off by a crash answers outcome unknown instead of sending twice', async t => {
  const { directory, project } = await durableProject(t);
  const runtimes = [];
  const first = await durable(t, directory, project, runtimes);
  const { session } = await first.client.request('session.create', { spec: { cwd: project, persist: true } });
  let release;
  runtimes[0].hold = new Promise(resolve => { release = resolve; });
  try {
    const cut = first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') }).catch(error => error);
    await until(() => runtimes[0].calls.some(c => c.method === 'turn/start'));
    await first.stop(false);
    await cut;

    const second = await durable(t, directory, project, runtimes);
    await second.client.request('session.create', { sessionId: session.id, spec: { cwd: project } });
    const resent = second.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') });
    await assert.rejects(resent, error => error.code === 1004 && error.data?.reason === 'outcome_unknown');
    assert.equal(runtimes.at(-1).calls.filter(c => c.method === 'turn/start').length, 0);
    await second.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('Hello') });
    assert.equal(runtimes.at(-1).calls.filter(c => c.method === 'turn/start').length, 1);
  } finally {
    release();
  }
});

