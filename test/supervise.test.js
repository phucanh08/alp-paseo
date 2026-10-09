import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';
import { bootTime, connect, daemonPaths, lockAlive, readLock } from '../src/client/index.js';
import { daemonHeld, holdDaemon, startDaemon, superviseDaemon } from '../src/client/supervise.js';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer, createStore } from '../dist/daemon/index.js';
import { createProvider } from '../plugins/paseo/server/dist/index.js';

const ENTRY = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));

async function until(check, what = 'condition', ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`Expected ${what} did not arrive`);
}

/** Stops every alpd of `home`, including one still starting, until none has run for a second. */
async function shutdown(home) {
  for (let quiet = 0; quiet < 10;) {
    const lock = await readLock(home);
    if (!lockAlive(lock)) { quiet++; await new Promise(resolve => setTimeout(resolve, 100)); continue; }
    quiet = 0;
    await connect(lock.socket).then(client => client.request('daemon.shutdown').finally(() => client.close())).catch(() => {});
    await until(async () => !lockAlive(await readLock(home)), 'alpd to stop');
  }
}

test('the plugin keeps alpd up: started with Paseo, started again after a crash, left alone after alp daemon stop', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-keep-'));
  const logged = [];
  // Two misses must take longer than alpd takes to start, as with the real 5 s interval.
  const stop = superviseDaemon({ home, entry: ENTRY, intervalMs: 600, log: message => logged.push(message) });
  t.after(async () => { await stop(); await shutdown(home); await rm(home, { recursive: true, force: true }); });
  await stop.started;
  const first = await readLock(home);
  assert.ok(lockAlive(first) && first.ready);
  assert.deepEqual(logged, ['alpd started with Paseo']);

  // The alpd of this test's own home, killed as a crash would.
  process.kill(first.pid, 'SIGKILL');
  await until(async () => { const lock = await readLock(home); return lockAlive(lock) && lock.ready && lock.pid !== first.pid; }, 'a new alpd');
  await until(() => logged.length === 2, 'the restart to be logged');
  assert.equal(logged[1], 'alpd was down; started it again');

  // A deliberate stop holds it down.
  await holdDaemon(home);
  const { socket } = await readLock(home);
  await connect(socket).then(client => client.request('daemon.shutdown').finally(() => client.close()));
  await until(async () => !lockAlive(await readLock(home)), 'alpd to stop');
  await new Promise(resolve => setTimeout(resolve, 2_000));
  assert.equal(lockAlive(await readLock(home)), false);
  assert.equal(await daemonHeld(home), true);

  // Asking for it lifts the hold.
  await startDaemon({ home, entry: ENTRY });
  assert.equal(await daemonHeld(home), false);
  assert.ok(lockAlive(await readLock(home)));
});

function fakeRuntime(runtimes) {
  return () => {
    let notification;
    const runtime = {
      calls: [],
      initialize: async () => {},
      onNotification(fn) { notification = fn; }, onFailure() {}, onRequest() {},
      notify(method, params) { notification(method, params); },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: 'native-thread', turns: [] }, cwd: params.cwd, model: params.model, reasoningEffort: 'low' };
        if (method === 'turn/start') return { turn: { id: `turn-${runtimes.length}-${this.calls.length}` } };
        return {};
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

test('a Paseo connection survives alpd going away: it reconnects, and the next prompt reopens its session', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-relink-'));
  const home = path.join(directory, 'home');
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.alp', 'agents', 'main'), { recursive: true });
  await writeFile(path.join(root, '.alp', 'agents', 'main', 'AGENT.md'), 'Agent main');
  await mkdir(home, { recursive: true });
  const runtimes = [];
  const daemons = [];
  const { socket } = daemonPaths(home);
  // An alpd in this process over a durable store; its lock names this process.
  async function daemon() {
    const runtime = createAlpRuntime({ transport: fakeRuntime(runtimes) });
    const store = createStore(path.join(home, 'state'));
    const server = createDaemonServer({ runtime, socketPath: socket, version: 'test', store });
    await server.listen();
    await writeFile(daemonPaths(home).lock, JSON.stringify({ pid: process.pid, bootTime: bootTime(), uid: process.getuid?.() ?? -1, version: 'test', protocolVersion: 1, socket, ready: true, startedAt: new Date().toISOString() }));
    const handle = { runtime, store, server, async crash() { await store.flush(); await server.close(); } };
    daemons.push(handle);
    return handle;
  }
  t.after(async () => {
    for (const handle of daemons) { await handle.server.close().catch(() => {}); await handle.runtime.shutdown(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const first = await daemon();
  const conn = await createProvider({ home }).connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => conn.close());
  const events = [];
  conn.onEvent(event => events.push(event));
  const config = { cwd: root, env: {}, systemPrompt: '', mcpServers: {}, settings: {}, persist: true };
  const prompt = id => ({ type: 'session.prompt', sessionId: 's', prompt: { clientMessageId: id, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: id }] } } });
  const result = id => events.find(event => event.type === 'session.prompt_result' && event.clientMessageId === id)?.result;
  await conn.send({ type: 'session.open', requestId: 'open', sessionId: 's', config, history: 'skip' });
  await conn.send(prompt('m1'));
  runtimes[0].notify('turn/completed', { threadId: 'native-thread', turn: { id: result('m1').turnId, status: 'completed' } });

  // alpd dies; Paseo is told it is reconnecting, not that the session failed.
  await first.crash();
  await until(() => events.some(event => event.type === 'timeline.item' && /lost its connection to alpd/.test(event.item.message)), 'the lost notice');
  await daemon();
  await until(() => events.some(event => event.type === 'timeline.item' && event.item.message === 'ALP reconnected to alpd.'), 'the reconnect notice');
  assert.ok(!events.some(event => event.type === 'session.runtime_failed'));

  // The new alpd had not reopened the session: the next prompt does, from its thread.
  const before = runtimes.length;
  await conn.send(prompt('m2'));
  assert.equal(result('m2').type, 'turn');
  // Main's own process, beside its supervisor's.
  const resumed = runtimes.slice(before).find(runtime => runtime.calls[0]?.method === 'thread/resume');
  assert.deepEqual(resumed.calls.slice(0, 2).map(call => [call.method, call.params.threadId]), [['thread/resume', 'native-thread'], ['turn/start', 'native-thread']]);
  assert.equal(events.filter(event => event.type === 'session.opened' && event.sessionId === 's').length, 1, 'Paseo sees its session opened once');
  resumed.notify('turn/completed', { threadId: 'native-thread', turn: { id: result('m2').turnId, status: 'completed' } });

  // A prompt while alpd is away waits for it.
  await daemons.at(-1).crash();
  const sent = conn.send(prompt('m3'));
  await new Promise(resolve => setTimeout(resolve, 300));
  await daemon();
  await sent;
  assert.equal(result('m3').type, 'turn');
});
